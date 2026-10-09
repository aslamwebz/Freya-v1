# Minimal desktop shell verification — 9 October 2026

Implemented in the existing Electron application and Vite frontend. No backend architecture, orb rendering, character animation, or 3D functionality was added. The final runtime verification explicitly used monitor 1.

## Behavior

- Startup opens the existing dashboard and registers a persistent Freya tray icon.
- Single tray click leaves Adult visibility unchanged. Double-click opens only a compact chat bar using the existing dashboard renderer and composer.
- Adult mode hides the dashboard and removes its taskbar entry. The Adult window uses `skipTaskbar: true`, so only its image and the persistent tray remain.
- Open Dashboard selects Dashboard mode, hides Adult, and restores the existing dashboard's size, fullscreen state, and taskbar entry. The full dashboard and Adult portrait are mutually exclusive. The mini chat bar can coexist with Adult.
- A second Freya launch and the existing `freya focus` command also select Dashboard mode, hiding Adult through the same transition.
- Tray menu: Show Adult Freya or Hide Adult Freya according to visibility, Open Dashboard, Quit Freya.
- Adult uses a fixed, transparent, frameless BrowserWindow, without a preload bridge, moving, resizing, animation, or control panels.
- Dashboard Home shows static Chibi in the rail footer. Other dashboard screens and chat controls retain their existing layout.
- Closing the dashboard hides it to the tray and shows Adult. Closing Adult or choosing Hide Adult Freya hides her; both windows can then be hidden while the tray stays alive.
- Mini chat shows a saved-session selector, New session, Close, and the existing text input/send button. It skips the taskbar, uses a fixed compact size at the bottom of the dashboard's monitor, and is not always on top. Selecting a session preserves each session's draft. New session uses the existing conversation-create action. Messages go to the selected session even when the full dashboard previously showed Home. Close or Escape dismisses it and shows Adult, unless the composer handles Escape to cancel recording or stop a response. Opening mini chat preserves an explicitly hidden Adult.
- Session changes and sends share pending state: the composer waits for a session change, and selector/New session wait for a submitted turn. Completion clears only the submitted session's draft. Refusals appear inline in the mini controls.
- Dashboard dialogs are hidden during mini chat and retained for dashboard restore. Windows fullscreen exit gets a brief settling delay before compact sizing; transition guards prevent stale actions overriding a newer mode selection.
- Dashboard restore retains the same renderer and navigation state; minimized windows restore before focus.
- A renderer completing its initial load respects the selected mode. Adult's initial load cannot reopen it over the full dashboard after switching back.
- Quit uses the existing workspace collection and Core shutdown. Repeated Quit requests start one shutdown collection and exit with code 0.
- The older animated presence companion no longer launches automatically. Its existing implementation remains available in the source tree.

## Files changed

Modified:

- `electron/main.ts` — native tray, Adult window, mini sizing, mode transitions, hide/restore and Quit lifecycle.
- `electron/preload.ts` and `src/platform/host.ts` — optional desktop-view notification/read in the existing bridge.
- `src/app/App.tsx` — optional selected-session target for mini chat sends; existing dashboard send behavior remains unchanged.
- `src/app/screens/HomeDashboard.tsx` — Chibi in the existing rail; mini-view handling and Escape dismissal.
- `src/app/screens/GlobalComposer.tsx` — mini controls integrated with composer pending state and draft identity.
- `src/app/screens/home-dashboard.css` — Chibi sizing and scoped mini-view rules.
- `vite.config.ts` — static Adult page in the existing build.

Added:

- `adult.html` — static Adult image page.
- `src/app/chat/MiniChatControls.tsx` — session selector, New session and Close using existing conversation/window APIs.
- `src/app/assets/chibi-placeholder.svg` — clearly labelled temporary Chibi illustration.
- `public/freya-tray.png` — 32 × 32 Freya F tray icon, copied to `dist/` by Vite.
- `scripts/desktop-shell-acceptance.mjs` — real Electron acceptance runner.
- `docs/superpowers/plans/2026-10-09-desktop-shell.md` — implementation checklist.
- `docs/desktop-shell-verification.md` — this report.

Adult reuses `src/ui-v2/assets/freya-portrait.webp` unchanged. It is the existing portrait asset, rather than a newly verified approved full-body concept. Vite emits it to `dist/assets/` for the static page. No approved Chibi concept was found in the accessible project or roadmap chat.

## Checks and results

| Check | Result |
| --- | --- |
| `npm run build` | Passed, renderer and Electron main |
| `npm run typecheck` | Passed, all three existing TypeScript projects |
| ESLint on changed TS/TSX/MJS files | Passed |
| `npm run lint` | Failed on unrelated existing files, including local `.kilo`/artifact scripts and `electron/control/server.ts`; left outside this change's scope |
| `npm run test:chat` | 41 files, 391 tests passed |
| Startup/shutdown scenario plus dashboard screen/workspace tests | 3 files, 20 tests passed (the dashboard tests also occur in the chat suite) |
| `node scripts/desktop-shell-acceptance.mjs` | Passed against the real built Electron application, including mini chat sending and repeated Quit |
| `git diff --check` | Passed |
| Read-only code review | Final re-review found no remaining actionable issues; activation routing, handled Escape, retained dialogs, stale transitions, and repeated Quit were covered |

Final mini-chat correction: build, full typechecking, changed-file lint, and real Electron acceptance passed. Earlier startup/dashboard and single-instance regressions passed. The native runner also verifies compact bounds, monitor 1 placement, taskbar API flags, draft retention, message submission through the existing Core into the existing conversation, a reply from the existing local developer echo provider, handled Escape, dismissal, retained dashboard dialog visibility, and rapid mini/dashboard/mini switching. No new backend functionality was added.

Session-controls follow-up: real Electron verification passed native `isAlwaysOnTop() === false`, empty-history behavior, New session creating distinct IDs, switching saved sessions with independent drafts, sending into the selected session from the Home-origin mini bar, retaining that selection after reopen, Close hiding the bar while keeping the tray alive, and the existing lifecycle checks. For the session/send race, the runner temporarily pauses actual native IPC delivery and then forwards requests to the unchanged production handler/Core; it synthesizes no backend responses. Pending read blocks forced form submission, and pending turn submission disables selector/New session before Core's projection arrives. The updated mini screenshot was inspected for selector/button visibility and input layout. Build, changed-file lint and 391 chat regressions passed again.

Electron's executable was initially missing. The declared Electron 44.5.0 runtime was installed, then the actual app was launched with isolated test profiles. Initial sandbox test execution had worker temporary-file errors; the successful test and desktop runs used approved execution outside the sandbox.

## Runtime evidence and exact limits

The acceptance runner observes actual native Tray/Menu/BrowserWindow objects and loads the production main process. It creates no mock windows or mock backend. It dispatches native Tray click/double-click events and invokes installed MenuItem handlers programmatically. Forwarding observers record actual `skipTaskbar` constructor options and native `setSkipTaskbar` calls without replacing their behavior. Chat sending uses the project's existing explicitly selected local echo provider, with live credentials and live model/web access disabled in the isolated test profile.

Verified: Windows allocated nonzero tray bounds; tray remains alive with both windows hidden; Adult and Chibi images load; dashboard navigation works; only the dashboard and Adult windows exist; Adult stays on monitor 1 and cannot be moved/resized; image/window restores and focus work; dashboard state survives close/restore; repeated Quit collects the workspace once and exits cleanly. Follow-up real Electron verification also passed exclusive mode visibility, repeated switches, native taskbar API settings, switching back to Dashboard before a new Adult renderer finishes loading, second-instance activation, and the actual CLI focus command against the isolated profile.

The Home presence region bounds matched a real pre-change screenshot baseline exactly. Orb source and rendering styles were not modified. A native desktop capture also showed the Adult portrait with a transparent background.

Not verified: physical mouse clicking/right-clicking the Windows notification-area icon, visual notification-area/taskbar appearance, macOS/Linux tray behavior, or the entire older broad desktop E2E suite. The available desktop controls did not expose the Windows notification area/taskbar as targetable surfaces. Therefore full manual tray/taskbar acceptance remains outstanding.

Local screenshots and machine-readable results are in the gitignored `artifacts/live-visible/desktop-shell/` directory: `dashboard-before.png`, `dashboard-after.png`, `adult.png`, `mini-chat.png`, `baseline.json`, and `results.json`. The real Electron mini-chat screenshot shows the session selector, New session, Close, input and send button.

To rerun the acceptance test, build first, then run `node scripts/desktop-shell-acceptance.mjs`. It uses monitor 1 and a temporary profile. Optional `--baseline` records the current Home presence bounds; an existing same-machine baseline is compared when present.
