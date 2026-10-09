# Freya Startup & Control Guide

This is the operational runbook for starting Freya and controlling the live app, chat, and browser from external tools.

## Project

Primary working copy:

    C:\Users\you\Desktop\AI\Freya

Use this copy for normal development and acceptance testing.

## Start Freya normally

PowerShell:

    cd C:\Users\you\Desktop\AI\Freya
    npm start

Desktop development launcher:

    npm run dev:desktop

## Start a visible isolated Freya instance

Use the dev/Kilo launcher when a second visible Freya instance is needed without touching the normal profile:

    cd C:\Users\you\Desktop\AI\Freya
    node scripts/dev-kilo.mjs --port=9234 --profile=.kilo/live-test

This builds Freya, launches a visible Electron window, binds Chrome DevTools Protocol to 127.0.0.1:9234, and gives the instance an isolated user-data directory.

To skip rebuilding:

    node scripts/dev-kilo.mjs --port=9234 --profile=.kilo/live-test --no-build

Use a different localhost CDP port for each simultaneous test instance. Ports 9233-9236 are convenient. Do not expose CDP outside localhost.

## Verify the visible Freya instance

    Invoke-RestMethod http://127.0.0.1:9234/json | ConvertTo-Json -Depth 5

A healthy instance normally exposes a Freya page and a Freya Presence page. The main page points at dist/index.html.

## Freya control plane

Freya exposes an authenticated local control plane from the Electron main process. It is not HTTP.

On Windows the endpoint is a named pipe such as:

    \\.\pipe\freya-control-<pid>

The running instance writes these files into its user-data directory:

    control.endpoint
    control.token

The token is the authentication authority. Never commit or publish control.token.

## Freya CLI

The CLI is bin\freya.mjs.

Examples:

    node bin\freya.mjs status
    node bin\freya.mjs health
    node bin\freya.mjs focus
    node bin\freya.mjs chats
    node bin\freya.mjs browser status
    node bin\freya.mjs browser tabs
    node bin\freya.mjs missions
    node bin\freya.mjs agents
    node bin\freya.mjs stop-status

For machine-readable output:

    node bin\freya.mjs --json status
    node bin\freya.mjs --json browser status
    node bin\freya.mjs --json browser tabs

## Control an isolated Freya profile

The CLI normally reads the standard Freya profile. For an isolated test instance, point the CLI at that instance with FREYA_USER_DATA:

    $env:FREYA_USER_DATA='C:\Users\you\Desktop\AI\Freya\.kilo\live-test'
    node bin\freya.mjs --json status
    node bin\freya.mjs --json browser status
    node bin\freya.mjs --json browser tabs

Important: the CLI reads FREYA_USER_DATA, not FREYA_DEV_USER_DATA.

## Control conversations

List conversations:

    node bin\freya.mjs --json chats

Create a conversation:

    node bin\freya.mjs chat new "Live browser test"

Read one conversation:

    node bin\freya.mjs --json chat get <conversationId>

Send a turn into an existing conversation:

    node bin\freya.mjs send <conversationId> "Your instruction here"

The control-plane send path goes through the same Core, Guard, Governor, journal, and conversation state used by the visible app.

## Control Freya's browser

Check browser availability:

    node bin\freya.mjs --json browser status

List real Browser Service tabs:

    node bin\freya.mjs --json browser tabs

Open a page:

    node bin\freya.mjs browser open https://example.com

Activate an existing tab:

    node bin\freya.mjs browser activate <tabId>

Snapshot a tab as numbered elements plus the revision they belong to:

    node bin\freya.mjs browser snapshot [tabId]

Give a tab's embedded view a real size before scrolling or capturing (a view that was never docked has no viewport, so `scroll` is refused with `surface-unavailable` and `screenshot` returns nothing):

    node bin\freya.mjs browser dock [tabId]
    node bin\freya.mjs browser undock

Scroll a tab to the top, the bottom, or a pixel offset:

    node bin\freya.mjs browser scroll <top|bottom|px> [tabId]

Click an element from a snapshot, quoting its ref and the snapshot revision:

    node bin\freya.mjs browser click <ref> <revision> [tabId]

These commands use Freya's Browser Service and the same browser authority as the app.

## Browser mode inside Chat

Freya Chat has two turn-level intent controls: Web Search and Browser Use.

Web Search is for discovery: websites, news, documents, images, videos, and other web lookup.

Browser Use is for operating Freya's browser. When the owner's text contains concrete URLs or domains, Freya should route them into browser_tabs instead of silently falling back to web search.

Examples:

    Open https://example.com in Browser mode.

    Open dailynews.lk, dailymirror.lk and island.lk in separate tabs.

For several explicit addresses, browser_tabs is the intended tool.

## browser_tabs

The Core browser-tabs tool is implemented in core\mind\browser-tabs-tool.ts.

It supports bounded operations including open, list, activate, close, read, click, type, select, scroll, wait, back, forward, and reload.

Important behavior:

- tabs belong to the Browser Service;
- actions go through Guard;
- STOP ALL takes priority;
- clicks use semantic references and revisions rather than arbitrary DOM execution;
- command and tab counts are bounded.

For multi-site tasks, open all required URLs first, then process the tabs one by one.

## External visual control with CDP

For live visual testing, an external Playwright controller can attach to the isolated Electron instance:

    import { chromium } from 'playwright-core'
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9234')
    const context = browser.contexts()[0]
    const page = context.pages().find(p => p.url().includes('/dist/index.html'))

Use CDP to observe the visible Freya UI, toggle real UI controls, type into the real composer, inspect rendered state, and take screenshots.

Do not use CDP as a substitute for Freya's Browser Service when the acceptance criterion is that Freya itself controlled the browser.

## How to prove Freya really used its browser

Never trust only the assistant's prose.

After a Browser-mode task, inspect Browser Service directly:

    $env:FREYA_USER_DATA='C:\Users\you\Desktop\AI\Freya\.kilo\live-test'
    node bin\freya.mjs --json browser status
    node bin\freya.mjs --json browser tabs

If a task should open ten tabs, a successful run must show ten real Browser Service tabs. If Freya says it opened tabs but browser tabs returns an empty list, the acceptance test failed.

## Sri Lankan 10-site acceptance test

Required flow:

1. Start Freya visibly on an isolated CDP port.
2. Open one Chat session.
3. Turn Web Search ON.
4. Ask Freya to find ten Sri Lankan websites.
5. Stay in the same conversation.
6. Turn Web Search OFF.
7. Turn Browser Use ON.
8. Tell Freya to open the exact ten discovered sites.
9. Require one real browser tab per site.
10. On every tab: load the site, scroll to the bottom, find Contact / Contact Us or the clear equivalent, click it, and verify the final URL and page heading/title.
11. Inspect Browser Service directly.
12. Confirm ten real tabs were created and navigated.
13. Only then mark the test successful.

A useful final report contains: domain | contact link clicked | final URL | verification result.

## MCP control

Freya also exposes an MCP adapter:

    node bin\freya-mcp.mjs

It exposes the same control-plane vocabulary, including freya_status, freya_health, freya_focus, conversation_list, conversation_get, conversation_create, conversation_send, browser_status, browser_tabs, browser_open, browser_activate, browser_snapshot, browser_click, browser_scroll, browser_dock, browser_undock, mission_list, mission_get, agent_list, notification_send, and stop_status.

The MCP adapter is a thin client over the same authenticated local channel. It does not create a second Freya runtime.

## STOP ALL

Check:

    node bin\freya.mjs stop-status

When STOP ALL is active, action commands such as conversation.send, browser.open, browser.activate, and notification.send must not execute. Read-only commands remain available.

## Useful checks before live browser testing

Core typecheck:

    .\node_modules\.bin\tsc.cmd -p tsconfig.core.json --noEmit

Focused tests:

    .\node_modules\.bin\vitest.cmd run tests\core\mind\tool-intent.test.ts tests\core\mind\tool-intent-contamination.test.ts tests\core\mind-intent-hints.test.ts tests\unit\mind\browser-tabs-tool.test.ts tests\unit\control tests\host\owner-browser-authority.test.ts tests\unit\app\dockedBrowser.test.tsx

Browser Service acceptance:

    npm run test:browser-service

## Key implementation files

- scripts\dev-kilo.mjs
- bin\freya.mjs
- bin\freya-mcp.mjs
- electron\control\server.ts
- electron\control\service.ts
- core\mind\tool-intent.ts
- core\mind\browser-tabs-tool.ts
- core\mind\loop.ts
- core\browser\service\service.ts
- docs\control-plane.md

## Operational rule

Freya's answer is not the source of truth. Core state, Browser Service state, the conversation journal, and the actual visible UI are the source of truth.

A live acceptance task succeeds only when the state confirms the claimed action happened.

## Reuse a running Electron instance for fast live checks

Use the existing isolated Freya Electron instance on localhost CDP 9234. Do not
rebuild or relaunch Electron for each browser check. From Freya-main:

    node scripts/live-browser-reuse.mjs
    node scripts/live-browser-reuse.mjs --local

The default checks CDP connectivity, the actual Freya renderer, the isolated
control profile, Browser Service status/tabs, and external DNS readiness.
`--local` starts an ephemeral localhost HTML fixture (no external DNS), then
asks the real Browser Service to open, dock, scroll, snapshot, and click its
Contact Us link. Playwright CDP is used only to attach to the existing Freya
renderer; it does not fake service actions or start a new Electron process.

The runner deliberately marks Contact navigation as failed if Browser Service
never reports the final /contact URL, even when click reports ok. It also
reports DNS lookup failures independently, so a local integration pass is not
mistaken for the ten-Sri-Lankan-site acceptance. A new fixture tab is created
on each --local invocation and remains in the current Browser Service; running
this check repeatedly is not a substitute for a clean acceptance profile.
