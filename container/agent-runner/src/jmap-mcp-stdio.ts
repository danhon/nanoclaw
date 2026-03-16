/**
 * JMAP MCP Server for NanoClaw
 * Provides read-only access to Fastmail via the JMAP proxy running on the host.
 * The host proxy (src/jmap-proxy.ts) injects the Fastmail API token.
 * Connect via JMAP_PROXY_URL env var (e.g. http://host.docker.internal:3002).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Host-side JMAP proxy — no token needed here, proxy injects it
const JMAP_PROXY_BASE = (process.env.JMAP_PROXY_URL || '').replace(/\/$/, '');
const JMAP_SESSION_URL = JMAP_PROXY_BASE
  ? `${JMAP_PROXY_BASE}/session`
  : 'https://api.fastmail.com/.well-known/jmap';

// Fallback: if no proxy, use direct API token (local dev without containers)
const API_TOKEN = JMAP_PROXY_BASE ? '' : (process.env.FASTMAIL_API_TOKEN || '');

function log(msg: string): void {
  console.error(`[JMAP] ${msg}`);
}

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
  parentId: string | null;
}

interface Email {
  id: string;
  threadId: string;
  subject: string;
  from: Array<{ name?: string; email: string }>;
  to: Array<{ name?: string; email: string }>;
  receivedAt: string;
  preview: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
}

interface EmailBody {
  id: string;
  subject: string;
  from: Array<{ name?: string; email: string }>;
  to: Array<{ name?: string; email: string }>;
  cc: Array<{ name?: string; email: string }>;
  receivedAt: string;
  bodyValues: Record<string, { value: string; isEncodingProblem?: boolean; isTruncated?: boolean }>;
  textBody: Array<{ partId: string; type: string }>;
  htmlBody: Array<{ partId: string; type: string }>;
}

let cachedSession: JmapSession | null = null;

function makeAuthHeaders(): Record<string, string> {
  // When using proxy: no auth header needed (proxy injects it)
  // When using direct (local dev): inject Bearer token
  if (API_TOKEN) {
    return { Authorization: `Bearer ${API_TOKEN}` };
  }
  return {};
}

async function getSession(): Promise<JmapSession> {
  if (cachedSession) return cachedSession;

  if (!JMAP_PROXY_BASE && !API_TOKEN) {
    throw new Error('JMAP_PROXY_URL or FASTMAIL_API_TOKEN must be set');
  }

  const res = await fetch(JMAP_SESSION_URL, {
    headers: makeAuthHeaders(),
  });

  if (!res.ok) {
    throw new Error(`JMAP session error: ${res.status} ${res.statusText}`);
  }

  cachedSession = await res.json() as JmapSession;
  log(`Session loaded, apiUrl: ${cachedSession.apiUrl}`);
  return cachedSession;
}

async function jmapCall(methodCalls: Array<[string, Record<string, unknown>, string]>): Promise<Record<string, unknown>[]> {
  const session = await getSession();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];

  if (!accountId) {
    throw new Error('No mail account found in JMAP session');
  }

  // Inject accountId into all method calls
  const calls = methodCalls.map(([method, args, id]) => [
    method,
    { accountId, ...args },
    id,
  ]);

  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: {
      ...makeAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: calls,
    }),
  });

  if (!res.ok) {
    throw new Error(`JMAP API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { methodResponses: Array<[string, Record<string, unknown>, string]> };
  return data.methodResponses.map(([, result]) => result);
}

function formatAddress(addr: { name?: string; email: string }): string {
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

const server = new McpServer({
  name: 'jmap',
  version: '1.0.0',
});

server.tool(
  'jmap_list_mailboxes',
  'List all mailboxes (folders) in the Fastmail account, including unread and total email counts.',
  {},
  async () => {
    log('Listing mailboxes...');
    try {
      const [result] = await jmapCall([
        ['Mailbox/get', { ids: null }, 'mb'],
      ]);

      const mailboxes = (result.list as Mailbox[]) || [];
      if (mailboxes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No mailboxes found.' }] };
      }

      const lines = mailboxes
        .sort((a, b) => {
          // Sort: special roles first (inbox, sent, drafts, trash), then alphabetical
          const roleOrder = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'];
          const aIdx = a.role ? roleOrder.indexOf(a.role) : 999;
          const bIdx = b.role ? roleOrder.indexOf(b.role) : 999;
          if (aIdx !== bIdx) return aIdx - bIdx;
          return a.name.localeCompare(b.name);
        })
        .map(mb => {
          const unread = mb.unreadEmails > 0 ? ` (${mb.unreadEmails} unread)` : '';
          const role = mb.role ? ` [${mb.role}]` : '';
          return `- ${mb.name}${role}: ${mb.totalEmails} emails${unread} | id: ${mb.id}`;
        });

      log(`Found ${mailboxes.length} mailboxes`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'jmap_search_email',
  'Search emails in the Fastmail account. Returns a list of matching emails with subject, sender, date, and preview.',
  {
    query: z.string().optional().describe('Full-text search query (searches subject and body)'),
    from: z.string().optional().describe('Filter by sender email or name'),
    to: z.string().optional().describe('Filter by recipient email or name'),
    subject: z.string().optional().describe('Filter by subject (substring match)'),
    mailboxId: z.string().optional().describe('Limit to a specific mailbox ID (from jmap_list_mailboxes)'),
    after: z.string().optional().describe('Only emails received after this date (ISO 8601, e.g. "2026-01-01")'),
    before: z.string().optional().describe('Only emails received before this date (ISO 8601)'),
    unreadOnly: z.boolean().optional().describe('Only return unread emails'),
    limit: z.number().optional().describe('Maximum number of results (default 20, max 50)'),
  },
  async (args) => {
    log(`Searching emails: ${JSON.stringify(args)}`);
    try {
      const limit = Math.min(args.limit ?? 20, 50);

      // Build filter
      const conditions: Record<string, unknown>[] = [];

      if (args.query) conditions.push({ text: args.query });
      if (args.from) conditions.push({ from: args.from });
      if (args.to) conditions.push({ to: args.to });
      if (args.subject) conditions.push({ subject: args.subject });
      if (args.mailboxId) conditions.push({ inMailbox: args.mailboxId });
      if (args.after) conditions.push({ after: new Date(args.after).toISOString() });
      if (args.before) conditions.push({ before: new Date(args.before).toISOString() });
      if (args.unreadOnly) conditions.push({ hasKeyword: '$seen', negate: true });

      const filter = conditions.length === 0
        ? {}
        : conditions.length === 1
          ? conditions[0]
          : { operator: 'AND', conditions };

      const [queryResult, getResult] = await jmapCall([
        ['Email/query', {
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit,
        }, 'q'],
        ['Email/get', {
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['id', 'threadId', 'subject', 'from', 'to', 'receivedAt', 'preview', 'mailboxIds', 'keywords'],
        }, 'g'],
      ]);

      const emails = (getResult.list as Email[]) || [];
      const total = (queryResult.total as number) ?? emails.length;

      if (emails.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No emails found matching your search.' }] };
      }

      const lines = emails.map(email => {
        const from = email.from?.map(formatAddress).join(', ') || '(unknown)';
        const date = new Date(email.receivedAt).toLocaleString();
        const unread = !email.keywords?.['$seen'] ? ' [UNREAD]' : '';
        return `ID: ${email.id}\nFrom: ${from}\nDate: ${date}${unread}\nSubject: ${email.subject || '(no subject)'}\nPreview: ${email.preview || ''}\n`;
      });

      const header = `Found ${total} email(s), showing ${emails.length}:\n\n`;
      log(`Found ${emails.length} emails`);
      return { content: [{ type: 'text' as const, text: header + lines.join('\n---\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'jmap_get_email',
  'Fetch the full content of an email by its ID. Returns headers and body text.',
  {
    id: z.string().describe('The email ID (from jmap_search_email)'),
  },
  async (args) => {
    log(`Fetching email: ${args.id}`);
    try {
      const [result] = await jmapCall([
        ['Email/get', {
          ids: [args.id],
          properties: ['id', 'subject', 'from', 'to', 'cc', 'receivedAt', 'bodyValues', 'textBody', 'htmlBody'],
          fetchAllBodyValues: true,
          maxBodyValueBytes: 50000,
        }, 'g'],
      ]);

      const emails = (result.list as EmailBody[]) || [];
      if (emails.length === 0) {
        return { content: [{ type: 'text' as const, text: `Email not found: ${args.id}` }] };
      }

      const email = emails[0];
      const from = email.from?.map(formatAddress).join(', ') || '(unknown)';
      const to = email.to?.map(formatAddress).join(', ') || '';
      const cc = email.cc?.length ? email.cc.map(formatAddress).join(', ') : null;
      const date = new Date(email.receivedAt).toLocaleString();

      // Prefer text body, fall back to HTML
      let body = '(no body)';
      const textParts = email.textBody || [];
      const htmlParts = email.htmlBody || [];
      const bodyValues = email.bodyValues || {};

      for (const part of textParts) {
        if (bodyValues[part.partId]?.value) {
          body = bodyValues[part.partId].value;
          if (bodyValues[part.partId].isTruncated) body += '\n\n[... truncated ...]';
          break;
        }
      }

      if (body === '(no body)') {
        for (const part of htmlParts) {
          if (bodyValues[part.partId]?.value) {
            // Strip basic HTML tags
            body = bodyValues[part.partId].value
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/\s{3,}/g, '\n\n')
              .trim();
            if (bodyValues[part.partId].isTruncated) body += '\n\n[... truncated ...]';
            break;
          }
        }
      }

      const header = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        `Date: ${date}`,
        `Subject: ${email.subject || '(no subject)'}`,
        '',
      ].filter(Boolean).join('\n');

      log(`Fetched email: ${email.subject}`);
      return { content: [{ type: 'text' as const, text: header + body }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

if (!JMAP_PROXY_BASE && !API_TOKEN) {
  log('WARNING: JMAP_PROXY_URL is not set — JMAP tools will fail');
} else if (JMAP_PROXY_BASE) {
  log(`Using JMAP proxy at ${JMAP_PROXY_BASE}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
