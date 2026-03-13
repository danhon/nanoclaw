# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NanoClaw is a personal Claude assistant with multi-channel messaging support (WhatsApp, Telegram, Slack, Discord, Gmail). Single Node.js process with containerized agent execution for security. See [README.md](README.md) for philosophy and [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Architecture

**Core Pattern**: Single orchestrator process + containerized Claude Agent SDK execution

```
Channels → SQLite → Message Loop → Container (Claude Agent SDK) → Response
                    Task Scheduler ↗
```

- **Orchestrator** (`src/index.ts`): Manages state, message polling, container invocation
- **Channel System**: Self-registering channels via factory pattern (`src/channels/registry.ts`)
- **Container Isolation**: Each group runs in isolated Linux VMs (Docker Sandboxes, Apple Container, or Docker)
- **Per-group Context**: Isolated filesystem, memory (CLAUDE.md), and sessions
- **IPC**: Filesystem-based communication between container and host (`src/ipc.ts`)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state management, message loop, agent invocation |
| `src/channels/registry.ts` | Channel factory registry (self-registration pattern) |
| `src/channels/index.ts` | Barrel imports triggering channel self-registration |
| `src/container-runner.ts` | Spawns agent containers with volume mounts |
| `src/group-queue.ts` | Per-group queue with global concurrency control |
| `src/ipc.ts` | IPC watcher for container → host communication |
| `src/router.ts` | Message formatting and channel routing |
| `src/task-scheduler.ts` | Scheduled task execution loop |
| `src/db.ts` | SQLite operations (messages, sessions, tasks, groups) |
| `src/config.ts` | Configuration constants and paths |
| `container/agent-runner/` | Code running inside containers (query loop, session management) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated context) |
| `groups/CLAUDE.md` | Global memory (shared across all groups, main-only write) |

## Development Commands

```bash
# Development
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled code

# Testing
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode for tests

# Code Quality
npm run typecheck    # TypeScript type checking (no emit)
npm run format       # Format code with Prettier
npm run format:check # Check formatting without changes

# Container
./container/build.sh # Build agent container image
CONTAINER_RUNTIME=docker ./container/build.sh  # Specify runtime

# Setup (via Claude Code skills)
/setup               # First-time installation and service configuration
```

## Service Management

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
```

## Skills (Claude Code Commands)

| Skill | Purpose |
|-------|---------|
| `/setup` | First-time installation, authentication, service setup |
| `/customize` | Add channels, integrations, modify behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Merge upstream updates into customized fork |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues |
| `/get-qodo-rules` | Load org/repo coding rules from Qodo before code tasks |

## Channel System Architecture

Channels are **not** built into core. Each channel (WhatsApp, Telegram, etc.) is added via a skill that:

1. Creates `src/channels/{name}.ts` implementing the `Channel` interface
2. Calls `registerChannel(name, factory)` at module load time
3. Returns `null` from factory if credentials are missing
4. Adds import to `src/channels/index.ts` (barrel import triggers registration)

At startup, the orchestrator loops through registered channels, instantiates those with credentials, and calls `connect()`.

**Channel Interface** (`src/types.ts`):
```typescript
interface Channel {
  name: string
  connect(): Promise<void>
  sendMessage(jid: string, text: string): Promise<void>
  isConnected(): boolean
  ownsJid(jid: string): boolean
  disconnect(): Promise<void>
  setTyping?(jid: string, isTyping: boolean): Promise<void>
  syncGroups?(force: boolean): Promise<void>
}
```

## Container System

**Key Points**:
- Agents run in isolated Linux containers (not host)
- Container user is `node` (uid 1000), not root
- Working directory: `/workspace/group` (mounted from `groups/{name}/`)
- Session data mounted to `/home/node/.claude/` (matches container user's HOME)
- Global memory at `/workspace/global/` (non-main groups only)
- Additional mounts via `containerConfig` at `/workspace/extra/{containerPath}`

**Environment Variables**: Only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are extracted from `.env` and mounted into containers at `/workspace/env-dir/env`. This prevents exposing other host env vars.

**Credential Proxy**: Containers route API calls through a host proxy (`src/credential-proxy.ts`) on port 3124 to avoid mounting credentials directly.

## Message Flow

1. Channel receives message → stores in SQLite via `onMessage` callback
2. Message loop polls SQLite every 2 seconds (`POLL_INTERVAL`)
3. For registered groups with trigger pattern (`@{ASSISTANT_NAME}`):
   - Fetch all messages since `lastAgentTimestamp[chatJid]`
   - Format with timestamps and sender names
   - Enqueue for group processing
4. GroupQueue manages concurrency (`MAX_CONCURRENT_CONTAINERS`)
5. Container spawned with group's mounts and session ID
6. Agent streams results back via callback
7. Router finds owning channel and sends response
8. Update `lastAgentTimestamp` and save session ID

**Trigger Pattern**: Messages must start with `@{ASSISTANT_NAME}` (case-insensitive). Main channel doesn't require trigger; other groups do (unless `requiresTrigger: false`).

**Conversation Catch-Up**: When triggered, agent receives ALL messages since last interaction, providing full conversation context.

## Memory System

Hierarchical CLAUDE.md system:

| Level | Path | Read By | Written By |
|-------|------|---------|------------|
| Global | `groups/CLAUDE.md` | All groups | Main only |
| Group | `groups/{name}/CLAUDE.md` | That group | That group |
| Files | `groups/{name}/*.md` | That group | That group |

Agent runs with `cwd=groups/{name}/`, so Claude Agent SDK (`settingSources: ['project']`) automatically loads:
- `../CLAUDE.md` (global)
- `./CLAUDE.md` (group)

## Session Management

- Each group has a session ID in SQLite (`sessions` table, key: `group_folder`)
- Passed to Claude Agent SDK's `resume` option for continuity
- Transcripts stored as JSONL in `data/sessions/{group}/.claude/`
- Mounted to `/home/node/.claude/` in container (matches container user's HOME)

## Testing

Tests use Vitest. Configuration in `vitest.config.ts` includes both `src/**/*.test.ts` and `setup/**/*.test.ts`.

Run individual test file:
```bash
npm test -- src/group-queue.test.ts
```

## Container Build Cache

**Important**: The container buildkit caches aggressively. `--no-cache` does NOT invalidate COPY steps. For truly clean rebuild:

```bash
docker builder prune -f  # Clear builder cache
./container/build.sh
```

## Common Patterns

**Adding a New Channel**:
1. Create skill in `.claude/skills/add-{name}/`
2. Add `src/channels/{name}.ts` implementing `Channel` interface
3. Register via `registerChannel(name, factory)` at module load
4. Return `null` if credentials missing
5. Add import to `src/channels/index.ts`

**IPC from Container to Host**:
- Write JSON file to `data/ipc/messages/{uuid}.json` or `data/ipc/tasks/{uuid}.json`
- Host's IPC watcher (`src/ipc.ts`) picks it up
- Types: `register_group`, `send_message`, `sync_groups`, etc.

**Scheduled Tasks**:
- Created via `mcp__nanoclaw__schedule_task` tool (available in containers)
- Run as full agents in group context
- Can send messages via `send_message` tool or complete silently
- Types: `cron` (expression), `interval` (ms), `once` (ISO timestamp)

## Troubleshooting

**WhatsApp not connecting after upgrade**: WhatsApp is now a separate channel skill. Run `/add-whatsapp` to install.

**Container fails to start**: Check container runtime is running. NanoClaw auto-starts but may fail. Use `/debug` skill.

**Session not continuing**: Verify mount path is `/home/node/.claude/` (not `/root/.claude/`). Container runs as `node` user.

**"No channels connected" error**: At least one channel must have valid credentials in `.env` or `store/auth/`.

**Logs**:
- Host: `logs/nanoclaw.log`, `logs/nanoclaw.error.log`
- Per-container: `groups/{folder}/logs/container-*.log`

## Development Notes

Run commands directly—don't tell the user to run them.

When modifying channels, remember the self-registration pattern requires both the channel file AND the barrel import.

Paths in `src/config.ts` must be absolute for container mounts to work correctly.

The orchestrator (`src/index.ts`) is the entry point. It:
1. Ensures container runtime is running
2. Initializes SQLite database
3. Loads state (groups, sessions, router state)
4. Connects channels (loops through registry)
5. Starts scheduler, IPC watcher, message loop, queue processor
