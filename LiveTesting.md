# Freya — Live Testing Procedure

> **Archival notice (2026-10-10).** This document was written for a specific
> run on a different path (`C:\Users\you\Desktop\AI\Freya-main`) and a
> specific branch (`experiment/deepseek-v41-freya-20261009`) that no
> longer exists in the current tree. The procedure is preserved here
> because it records what was decided at the time, and the owner has
> asked that historical docs be marked archival rather than rewritten.
>
> The current live-testing surface is described in
> `docs/ARCHITECTURE.md`, `docs/CORE-EVENTS.md` and the phase docs
> referenced from there. The original `C:\Users\you\Desktop\AI\Freya`
> worktree is at `34bd80f` on `feat/mind-missions-integration`; this
> worktree is at `4453563` on `freya-cleanup`. The session guidance in
> the original "Scope and safety" section — "no new branches, merges,
> pushes, resets, stashes" — is still binding for any work on this
> worktree.

## Scope and safety

Work in `C:\Users\you\Desktop\AI\Freya-main` on existing branch `experiment/deepseek-v41-freya-20261009`. No new branches, merges, pushes, resets, stashes, or additional agents. Preserve the owner's running OpenCode and normal Freya profile.

**Live acceptance means real Electron UI and Browser Service evidence, not just unit tests or agent claims.**

## Persistent, visible test instance

1. Check `http://127.0.0.1:9234/json`. Attach Playwright CDP to the **already-running** isolated Freya Electron instance on port 9234. Do not repeatedly launch, kill or rebuild Electron.
2. The isolated profile is `.kilo/live-test`, resolved relative to Freya-main. For CLI checks, set `FREYA_USER_DATA` to its absolute path; the dev launcher sets `FREYA_DEV_USER_DATA` internally.
3. Test **visibly** on the owner's Display 1: restore/show the actual Freya window, open its browser dock, and activate each tab before testing. The owner should see the browser pages and navigation in the Freya window—not merely terminal output in OpenCode. Do not take focus away from their other work unnecessarily.
4. Capture screenshots or visual evidence for each major action, but never treat screenshots alone as proof that Freya performed an action. Verify with Browser Service status/tabs and final page state.
5. Always clean up in a `finally` block: undock the browser, release temporary test resources, and restore the previously visible interface. Do not leave the user looking at a white screen or at a localhost fixture whose server has stopped.

## Mandatory user-level Chat UI test (run first)

The real acceptance path is **Freya Chat on Display 1**. Never substitute direct CLI `browser open`, `browser dock`, `browser scroll`, `browser click`, or independent Playwright browser tabs for Freya carrying out the user's instruction. Those direct-control operations are only separate Browser Service infrastructure diagnostics, not user acceptance tests.

Use the already-running app, through CDP, to click the *visible user interface*. The repeatable basic-chat smoke script is:

```powershell
cd C:\Users\you\Desktop\AI\Freya-main
node scripts/live-chat-user-flow.mjs
```

This clicks Open Chats when necessary, fills the real `Ask Freya...` textarea, clicks Send, and reads the rendered assistant reply. **Running it sends an actual test message to Freya.** Its first verified run produced `Hi there.` in response to a greeting.

The tool toggles are **ARIA switches, not ARIA buttons**. Locate them with `page.getByRole('switch', { name: 'Web search' })` and `page.getByRole('switch', { name: 'Browser' })`. Verify `aria-checked` after each click. Wrong button-role selectors silently wait and make a functioning interface look broken. Keep Playwright locator timeouts short and inspect the current UI state before clicking. Leave the original toggle state unchanged after a test. Avoid arbitrary long waits or restarting Electron to fix missing selectors.

For end-to-end browsing, submit instructions through the same chat composer; Freya Mind must decide and execute browser actions herself. It is okay to query Browser Service read-only afterward to verify actual tab URLs and revisions. Keep the Chat and actual browser view visible on Display 1. If the Browser dock hides chat or shows white, record that UX defect; don't bypass Chat with direct-control commands to claim success.
## Optional Browser Service infrastructure diagnostics (NOT user acceptance)

Run:

```powershell
cd C:\Users\you\Desktop\AI\Freya-main
node scripts/live-browser-reuse.mjs
node scripts/live-browser-reuse.mjs --local
```

The infrastructure runner should reuse the existing Electron instance, not rebuild or restart it. It is NOT a replacement for a real-user Chat test. The local fixture is a real localhost HTML page, independent of DNS. Test through the actual Browser Service: **open → dock/activate visibly → scroll to bottom → snapshot → find Contact Us ref and revision → click → verify the final /contact URL and page heading/title.**

**Known blocker:** Browser Service previously returned `clicked: true` while the tab's final URL remained at the fixture root. Investigate and fix this behavior; do not weaken the assertion or mark it passing. Add a focused regression test. A click acknowledgment alone is insufficient.

## Mind-driven acceptance (different from CLI smoke tests)

The local control-plane fixture proves Browser Service wiring, not that Freya Mind can perform the task. For a genuine Mind-driven test, CDP may operate **Freya's visible UI controls and composer only**, and may observe results; Freya's own `browser_tabs` tool must actually perform browser navigation, scrolling and clicking. Do not use CDP to secretly do the assigned browser work.

## Sri Lankan ten-site acceptance

Use **one real Freya Chat conversation**, in this exact order:

1. Turn Web Search ON.
2. Ask Freya to discover ten Sri Lankan websites and collect their real URLs.
3. Remain in the same chat and turn Web Search OFF.
4. Turn Browser Use ON.
5. Tell Freya to open those exact ten sites in ten real Browser Service tabs.
6. Visibly activate each tab, scroll to bottom, locate Contact/Contact Us (or clear equivalent), click it and verify resulting URL and page heading/title.
7. Independently inspect `browser status`, `browser tabs`, and snapshots to prove Freya's actual actions.
8. Report per site: source URL, tab ID, click target, final URL, title/heading, success/failure. Report verified successes out of ten. Do not fill in forms.

If DNS fails with `ENOTFOUND`, stop external attempts promptly and report the environment limitation. Never fabricate success.

## Efficient verification and reporting

- Run focused tests and relevant TypeScript checks for changed files; avoid repeating known unrelated repository-wide lint/test failures.
- Build only when the changed Electron code genuinely requires it. If a rebuild is essential, perform one controlled rebuild/relaunch, then reuse the same instance.
- Report precise failures, evidence, any fixes, and commit on the **current experiment branch only**. Keep `main` untouched.
- In each live testing session, make it clear to the owner which Freya window to watch and which site/action is currently being exercised.

## Critical distinction

`http://127.0.0.1:4097` is the **OpenCode agent console**. It is not a live video feed of the Freya Electron application. The CDP service at port 9234 is a debugging interface, not a normal web page showing Freya. To watch real tests, use the visible Freya Electron window (on Display 1) with the Browser dock open while testing.
