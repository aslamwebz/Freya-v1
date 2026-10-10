# Phase 7 Postreview ? Independent Verification

This supersedes claims of complete production validation in older Phase 7 documentation.
**Examined 2026-10-10.** No production push or main merge was made.

## Changes from AG stopping point

- Preserved the committed owner approval record, production source selector, mission-event observer, and durable promotion/rollback history produced before AG exhausted its quota.
- Repaired its half-finished `ControlledExperimentRunner` conversion: incorrect selector signature, missing strategy provenance, untrusted fixture domain policy, synthetic latency/token accounting and strict-ceiling errors.
- Extended Mission research evidence to include the strategy actually selected in Work execution.
- Replaced broad, ineffective one-item rollback monitoring with durable evidence filtering by exact strategy/version/activation, distinct missions, and two consecutive classified strategy failures.
- Suppressed spoofed unknown Mission events and prevented blocked states from being mislabeled as terminal failure.
- Added regression tests that refuse unrelated missions, stale versions, pre-activation failures, duplicate mission IDs and owner denial as promotion regressions.
- Retained Antigravity's original staged changes wherever correct instead of discarding the work.

## Verified commands and outcomes

- `npm run typecheck`: **PASS** (all three TS configurations).
- `npm run build`: **PASS** (Vite renderer and Electron bundles).
- Focused lint over touched Phase 7/Core research/mission files: **PASS**.
- 5 focused Phase 7 suites: **24/24 tests PASS**.
- New rollback scope plus acceptance suites: **7/7 tests PASS**.
- Extended integration regression: **20 files / 185 tests PASS**.

These Vitest results use controlled fixtures where their test harness defines them. **No paid model calls or real browser agent sessions were run** for this review. The entire application test suite and historical repo-wide lint baseline were not certified.

Additional baseline investigation: 5 separate historical chat/personality/privacy suites returned **106 passed, 5 failed**; the failures include chat packet ordering (tool guidance after the last user message). The same five failures were seen before this postreview on Phase 7, so no regression attribution is claimed. They still require independent repair. Repository-wide lint was already failing on a broad unrelated baseline and is not marked as passing.

## Additional hardening ? Core public evolution surface and chat-context ordering

- `core/mind/mind.ts` now places the bounded system tool guidance after the identity message and **before** the latest owner question. Stored research evidence stays before the question, and the owner text is last. No change to the Guard, tool call ceilings or raw user message persistence.
- The previously failing 5 chat/personality/privacy suites now pass **111/111**; the tool-loop + overlapping suites pass **167/167**. Two old expectations were corrected to reflect the existing tool-capable grant ceiling (while asserting a single actual model request) and metadata-only activity correlation IDs.
- `Core.evolution()` and `Core.evolutionStore()` now expose frozen read-only facades, with cloned nested records rather than the mutable lifecycle or store. Existing integration tests use the internal `core/testing.ts` seam to exercise lifecycle mutation, not production Core access.
- `tests/core/evolution-core-surface.test.ts` verifies the public methods cannot request/decide promotion or write candidates, and returned nested candidate edits do not change the internal store. Its focused checks passed.
- **Remaining security distinction:** This closes the public **Core reference** mutator leak. It does not authenticate owner identity within `StrategyLifecycleManager.decidePromotionApproval` itself; that method still accepts an asserted owner string in trusted-internal callers. Do not expose it directly over IPC, an agent tool, plugin, or renderer. A future owner-approved gateway needs an authority minted by Core and verified on every decision.

## Status and blockers

- **Completed here:** compilation repair, production-algorithm selector reuse in experiments, Mission provenance capture, idempotent event observation, scoped automatic regression monitoring, evidence-backed rollback boundaries, focused acceptance tests, build.
- **Preexisting work available:** persisted approval requests, candidate binding digests, lifecycle history, encrypted Vault persistence, production research strategy selection.
- **Not done/verified:** truly authenticated owner identity for promotion through a public UI/IPC/command gateway; a live Mission-versus-baseline A/B trial using real tool behavior and external independent verification; a complete multi-restart lifecycle scenario; whole-repo regression/lint qualification; Kilo's real desktop evaluation.
- The original Phase 7 test titled `evolution-multisession` tests many stages in a single Core instance; only the final restart is genuine. Do not interpret it as production multi-session intelligence validation.
- Stored approval records and checks of a caller-supplied `owner` string do **not** independently establish identity. Do not expose promotion verbs directly to untrusted inputs.

**Release assessment:** This is a verified hardening increment, **not** a finished production-secure autonomous evolution system.
