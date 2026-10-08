# Freya control plane

The Freya control plane is the local API that lets external tools — Kilo,
OpenCode, Codex, Claude Code, qwen-code, aider, ChatGPT, Claude, VS Code, and
shell scripts — see and control a running Freya instance without screen
scraping and without CDP.

It is **not** an HTTP server and **not** a public endpoint. The transport is a
Windows named pipe (or a Unix domain socket on POSIX), opened by the Freya
process itself, and every byte that crosses it is authenticated.

## Architecture

```text
                 ┌──────────────────┐
                 │ Freya Core       │
                 │ Electron Main    │
                 └────────┬─────────┘
                          │
                  Control Service
                          │
                 authenticated IPC
                          │
         ┌────────────────┴────────────────┐
         │                                 │
   Windows Named Pipe               Unix Socket
         │                                 │
         └────────────────┬────────────────┘
                          │
                       Freya CLI
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
     Kilo             OpenCode           Scripts
                          │
                  MCP adapter (stdio)
                          │
            ChatGPT / Claude / VS Code
```

The Control Service belongs in the Electron main / Core layer. The renderer
sees nothing of it, and there is no path for a page to invoke it.

## Authentication

When Freya starts, it writes two files into its user-data directory
(`%APPDATA%\freya\control.token` on Windows):

- `control.token` — a 32-byte random secret, hex-encoded. The file is created
  with `0600` permissions on POSIX; on Windows it inherits the per-user ACL on
  the user-data directory.
- `control.endpoint` — the address of the running channel
  (`\\.\pipe\freya-control-<pid>` or `unix:/tmp/freya-control/freya-<pid>.sock`),
  with the PID and start time. The endpoint file is rewritten on every start
  and removed on every stop.

Connection flow:

```text
client connects
  → writes:  AUTH <token> [<client-tag>]\n
  → server replies: OK\n   (or a JSON-RPC error)
  → from then on, line-delimited JSON-RPC 2.0
```

The token is the only authority. It is never logged, never sent to the
renderer, never embedded in any LLM prompt, never stored in Git. Comparing the
presented token to the expected one is constant-time.

A per-process rate limiter blocks abusive failed-auth attempts. Five failures
in a row close the gate for five seconds; a single success resets the count.

## Protocol

JSON-RPC 2.0, line-delimited. One request per line, one response per line,
newlines as the only framing. The maximum single-line payload is 256 KiB;
anything larger is refused with `PAYLOAD_TOO_LARGE`.

Protocol version is `1`. It is reported by `protocol.version`.

### Read methods

| Method                       | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `protocol.version`           | The protocol version and the full method list.  |
| `freya.status`               | Core status, browser status, STOP-ALL latch.    |
| `freya.health`               | Short health summary: ok / uptime / lifecycle.  |
| `freya.focus`                | Focus the Freya window. Returns `{ focused }`.  |
| `conversation.list`          | All conversations in the workspace.             |
| `conversation.get`           | One conversation by id (active transcript).     |
| `browser.status`             | Browser Service availability, tab count, etc.   |
| `browser.tabs`               | List of open browser tabs.                      |
| `mission.list`               | List of missions.                               |
| `mission.get`                | One mission by id.                              |
| `agent.list`                 | List of running agents (workforce projection).  |
| `system.stopStatus`          | Is STOP ALL latched? Always readable.           |

### Action methods

| Method                  | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `conversation.create`   | Create a new conversation. Title is optional.                |
| `conversation.send`     | Send a user turn to a conversation. Subject to STOP ALL.     |
| `browser.open`          | Open a new browser tab. Subject to STOP ALL + URL policy.    |
| `browser.activate`      | Focus an existing tab. Subject to STOP ALL.                  |
| `notification.send`     | Surface a notification in the shell. Subject to STOP ALL.    |

Action methods return `STOP_ALL_ACTIVE` (no other side effect) when STOP ALL
is latched. They use the **same Core / Browser authority** the renderer
would: a `browser.open` call lands in the same Browser Service, a
`conversation.send` call goes through Core's Mind, with the same Guard and
Governor evaluation, in the same journal, with the same conversation id.

### Event / wait methods

| Method                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `event.subscribe`     | Subscribe to a list of topics.                    |
| `event.unsubscribe`   | Remove a subscription.                            |
| `wait`                | Block until an event matches, or timeout.         |

Topics: `conversation.created`, `conversation.response`, and any future
publisher.

## CLI

```bash
freya status
freya health
freya focus
freya chats                            # list
freya chat new "title"                 # create
freya chat get <id>                    # one
freya send <conversationId> "text"     # turn
freya browser status
freya browser tabs
freya browser open https://example.com
freya browser activate <tabId>
freya missions
freya mission get <id>
freya agents
freya notify "build finished"
freya stop-status
```

Add `--json` for machine-readable output:

```bash
freya --json status
freya --json browser tabs
```

Exit codes:

- `0` — success
- `1` — unhandled exception
- `2` — bad invocation
- `3` — Freya is not running (no endpoint file)
- `4` — connection failed
- `5` — server returned an error (except STOP_ALL_ACTIVE which is exit 0)

## Attribution

Every request carries a caller identity, supplied by the client:

```text
AUTH <token> <client-tag>   # e.g. AUTH <token> kilo
```

The control service stamps every `coreHost.submit` call it makes on the
caller's behalf with an `attribution` field describing the source. Attribution
is audit metadata. It is not a security authority — Core assigns the actual
principal.

The `client-tag` is what shows up in the journal line that records who
initiated the action. `kilo`, `opencode`, `codex`, `claude-code` are
recommended names; anything else is taken verbatim up to 64 characters.

## STOP ALL

STOP ALL is checked fresh on every action call. While STOP ALL is latched:

- `freya status` and `system.stopStatus` are still readable.
- `conversation.send`, `browser.open`, `browser.activate`, and
  `notification.send` return `{ "error": { "code": "STOP_ALL_ACTIVE" } }`
  with exit 0 in the CLI.

A bypass through this surface is impossible: the only way STOP ALL is latched
is from inside Core, and the latch is composed with every action's authority
path, including the one the control service calls.

## MCP adapter

```bash
node bin/freya-mcp.mjs
```

is a stdio MCP server. It advertises the same vocabulary as the CLI:

- Tools: `freya_status`, `freya_health`, `freya_focus`, `conversation_list`,
  `conversation_get`, `conversation_create`, `conversation_send`,
  `browser_status`, `browser_tabs`, `browser_open`, `browser_activate`,
  `mission_list`, `mission_get`, `agent_list`, `notification_send`,
  `stop_status`.
- Resources: `freya://status`, `freya://health`, `freya://chats`,
  `freya://browser/tabs`, `freya://stop`.

A Claude / ChatGPT / VS Code / Codex-compatible MCP host configuration:

```json
{
  "mcpServers": {
    "freya": {
      "command": "node",
      "args": ["C:/path/to/Freya-ui/bin/freya-mcp.mjs"]
    }
  }
}
```

The MCP adapter is a thin client over the same authenticated channel the CLI
uses. There is no second business-logic layer; tool calls are one round-trip
to the control service, with the same STOP ALL gate.

## Lifecycle

- The control server starts after the Browser Service is mounted and the
  Freya window is open.
- It stops before Core stops, so a peer that races a quit and arrives while
  the journal is being torn down finds a closed pipe and fails closed.
- There is one owner. The server is never restarted, never restarted by a
  watcher, and never restarted by a peer. If it fails, the host's process is
  failing; the control plane does not paper over that.

## Single instance

The control plane is part of the same Freya process as the Browser Service
and the conversation store. A second Freya launch does not get its own
control plane — the second instance routes through the existing
single-instance guard, which focuses the existing window and quits.

The named pipe is named with the process pid. A second instance trying to
bind a different pipe in the same user-data directory would simply own a
different channel that no client knows how to find (the endpoint file is
rewritten on every start).

## Security model

- **No anonymous access.** Every connection must present the token. Five
  failed attempts in a row block new connections for five seconds.
- **No HTTP, no REST, no localhost.** The transport is a named pipe (Windows)
  or a Unix socket (POSIX). No port is bound. No external process can reach
  the control plane over the network.
- **Constant-time token comparison.** `crypto.timingSafeEqual` after an
  equal-length check.
- **Renderer / web pages cannot reach the control plane.** The renderer's
  preload bridge is unchanged. The control server listens on the Electron
  main process's IPC, which the renderer has no path to.
- **Action methods respect STOP ALL.** The same latch the user has set is
  the gate every action walks through. There is no priority override.
- **Actions route through the existing authority paths.** A
  `conversation.send` is a `coreHost.submit({ command: 'conversation.turn.submit' })`.
  A `browser.open` is a `browserService.run({ op: 'open' })`. Nothing is
  reconstructed on the control-plane side; the control plane is a thin
  projection of Core and the Browser Service.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Freya is not running` | Freya is not started, or its user-data directory differs | Start Freya. Verify `FREYA_USER_DATA` matches if you set it. |
| `could not connect to …` | Stale endpoint file from a crashed run | Restart Freya. |
| `TOKEN_MISMATCH` | Token file was rotated by a rebuild | Re-read `%APPDATA%\freya\control.token`. |
| `RATE_LIMITED` | Five failed auths in a row | Wait five seconds. |
| `STOP_ALL_ACTIVE` on a send | STOP ALL is latched in Freya | Lift it from the shell. |
| `PAYLOAD_TOO_LARGE` | Request > 256 KiB | Split it. |
