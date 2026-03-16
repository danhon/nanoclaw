/**
 * JMAP proxy for container isolation.
 * Containers connect here instead of directly to api.fastmail.com.
 * The proxy injects the real FASTMAIL_API_TOKEN so containers never see it.
 *
 * Routes:
 *   GET /session   → fetches JMAP session from Fastmail, rewrites apiUrl to proxy
 *   POST /api      → forwards body to the real Fastmail JMAP API URL
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const JMAP_SESSION_URL = 'https://api.fastmail.com/.well-known/jmap';

function fetchJson(
  url: string,
  method: string,
  token: string,
  body?: Buffer,
): Promise<{ status: number; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (body) headers['Content-Length'] = body.length;

    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode!, data: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export function startJmapProxy(
  port: number,
  host = '0.0.0.0',
): Promise<Server> {
  const secrets = readEnvFile(['FASTMAIL_API_TOKEN']);
  const token = secrets.FASTMAIL_API_TOKEN || '';

  if (!token) {
    logger.warn('JMAP proxy: FASTMAIL_API_TOKEN not set — JMAP tools will return errors');
  }

  // Cache the real Fastmail API URL from the session endpoint
  let cachedApiUrl: string | null = null;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          (req.url === '/session' || req.url === '/.well-known/jmap')
        ) {
          // Fetch JMAP session from Fastmail
          const result = await fetchJson(JMAP_SESSION_URL, 'GET', token);
          const session = JSON.parse(result.data.toString()) as {
            apiUrl: string;
            [key: string]: unknown;
          };

          // Cache real API URL and rewrite to proxy
          cachedApiUrl = session.apiUrl;
          const proxyHost = req.headers.host || `localhost:${port}`;
          session.apiUrl = `http://${proxyHost}/api`;

          const rewritten = Buffer.from(JSON.stringify(session));
          res.writeHead(result.status, {
            'Content-Type': 'application/json',
            'Content-Length': rewritten.length,
          });
          res.end(rewritten);
          logger.debug({ cachedApiUrl }, 'JMAP session fetched and rewritten');
        } else if (req.method === 'POST' && req.url === '/api') {
          // Forward JMAP API call to real Fastmail endpoint
          if (!cachedApiUrl) {
            // Session not yet fetched; fetch it now to get the real apiUrl
            const sessionResult = await fetchJson(
              JMAP_SESSION_URL,
              'GET',
              token,
            );
            const session = JSON.parse(sessionResult.data.toString()) as {
              apiUrl: string;
            };
            cachedApiUrl = session.apiUrl;
          }

          const chunks: Buffer[] = [];
          req.on('data', (c) => chunks.push(c));
          await new Promise<void>((r) => req.on('end', r));
          const body = Buffer.concat(chunks);

          const result = await fetchJson(cachedApiUrl, 'POST', token, body);
          res.writeHead(result.status, {
            'Content-Type': 'application/json',
            'Content-Length': result.data.length,
          });
          res.end(result.data);
          logger.debug({ status: result.status }, 'JMAP API call forwarded');
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      } catch (err) {
        logger.error({ err, url: req.url }, 'JMAP proxy error');
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(
            JSON.stringify({
              error: `JMAP proxy error: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'JMAP proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
