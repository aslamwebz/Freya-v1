# Freya Phase 8 ? Evaluation Evidence Handover

This handover consolidates evidence gathered on the separate `feat/freya-main-integration` checkout, running from commit `27b65ec`, with newer Freya Mind Phase 7 hardening.

**Origin:** `C:\Users\you\Desktop\AI\Freya-main\.kilo\eval-evidence`. Original evaluation by the OpenCode/MiniMax agent. It used a live Electron instance on localhost port 9235, an isolated test profile, and ad hoc CDP scripts. The source worktree was not changed by that evaluation.

**Evidence available on this computer (ignored; not committed):**
`C:\Users\you\Desktop\AI\Freya\.kilo\eval-evidence\freya-main-round1\`

The above directory contains the original unmodified `REPORT-round1.md`, 22 other text/markdown artifacts and 7 screenshots (30 files total), copied byte-for-byte from `Freya-main`. Encrypted profiles, keyrings, credentials and throwaway `kilo-*.mjs` scripts were **not** transferred.

## Priority production acceptance defects

1. **Malformed model output leaks into user-facing messages.** `t18-one-site.txt` contains repeated `<]minimax>` / `[ya ism]` artifacts; `t16-mission-self-eval.txt` reports storage `too-large`. Diagnose the provider, tool-loop parser and storage boundaries before implementing cautious sanitization.
2. **Long tool workflows exhaust per-turn budgets.** `t10-compare-three.txt` and `t14-scroll.txt` show partially completed browser tasks with `failed` final outcomes. The older implementation has `maxProviderCalls: 10` and `maxToolCalls: 10`. Focus on wasted repeated tool calls, useful continuation and governed budgets, not simply removing ceilings.
3. **Limited browser navigation on example domains.** Open `example.com` / `example.org` failures have been reported, but their precise network/TLS/URL-policy root cause was not demonstrated. Reproduce against real Electron `did-fail-load` errors; never weaken URL restrictions to force a pass.
4. **Provider timeout.** The older compatible provider enforces a fixed 30-second transport timeout and at least one long reasoning task failed. Preserve cancellation/spending limits.
5. **Missing real-world workflow capability.** Freya answered that direct named Mission creation/listing and arbitrary Markdown file writing were unavailable via the current chat tool surface. Decide whether Phase 8 should expose these with owner authorization.
6. **Persistence continuity and tool-toggle usability.** Evaluate through the normal UI, across *new conversations and real restarts*; a seven-turn chat inside one conversation is not persistent-memory evidence.

## Corrections to the MiniMax report

- The ten-Sri-Lankan-website Contact workflow was **not** completed. `srilanka-task-v2.txt` reports `outcome: denied` after opening eight tabs, including failed/unreadable pages. Do not mark it successful.
- The keyring/profile problem was separately mitigated by **archiving the unreadable isolated test profile** and creating a clean replacement. Freya started with durable persistence and zero faults after restart. The original encrypted history was not recovered; do not claim it automatically self-healed.
- MiniMax compared neither Claude nor ChatGPT/OpenHands in a matched live trial. Statements about superiority are unverified qualitative opinions.
- Many `kilo-*.mjs` probes bypass the normal composer via `window.freyaHost.coreSubmit` and sometimes catch test errors then exit code 0. They are diagnostic probes, **not** full UI acceptance or trustworthy pass/fail harnesses.

## Integration scope and boundaries

- Browser UI correction `18ae2b7` is cherry-picked into the AG hardening branch. It retains chat beside browser by default (38/62 split) and removes redundant browser heading/origin label; an explicit Expand control hides chat only when requested.
- Do **not** merge the old `Freya-main` application branch wholesale, or copy its isolated profiles, keyrings or credentials.
- This report is **an evidence handover**, not a claim Phase 8 has been implemented or that these bugs are fixed. Reproduce each issue on the current AG branch before making an architectural change.
- Prefer true UI/browser acceptance and independent observable results over tests that merely exercise mocked internals. Still run engineering regression checks after repairs.

## Phase 8 starting sequence

Review the local evidence; reproduce high-impact failures on the current hardening branch; repair one root cause at a time; verify the actual rendered chat/browser and authoritative outcomes; then address Mission, memory and autonomy integration. Preserve owner approval and spend controls. Do not push or merge into `main` without authorization.
