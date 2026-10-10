# Freya Mind Phase 7 ? Postreview Hardening Architecture

**Status:** Partial production hardening; still subject to owner-approval boundary and live acceptance work.
**Branch:** `feat/mind-phase7-postreview-hardening`.

## Governed strategy execution

- `core/research/evidence.ts` supplies the canonical `selectSourcesDetailed` routine.
- `core/work/research-inspection.ts` obtains an allowlisted active strategy through the Core-owned resolver and records the actual selected strategy ID/version alongside research evidence, including failed retrievals after selection.
- A baseline run keeps the standard host-balanced selection. An eligible, promoted source-ranking strategy can prioritize verified result metadata and limit repeated domains.
- `core/evolution/experiment.ts` now calls the production selector for baseline and candidate. Its current scenarios use **offline deterministic source fixtures**; this is not a live internet or model quality evaluation. Safety URL filtering applies to both.
- The test fixture domains were changed away from blocked reserved `.example` suffixes instead of weakening production URL safety.
- The experiment records measured local selector wall time, the number of selected source attempts and deterministic zero LLM tokens, rather than inventing token or latency values. Attempts are conservatively reserved under ceilings.

## Authoritative observation

- Core subscribes to genuine `mission.completed` and `mission.failed` events and resolves an existing mission before observation.
- Mission telemetry comes from the actual Mission and Work snapshots. Missing tokens and requests stay `null`; missing steps are never fabricated.
- The actual strategy ID and version are taken from persisted Mission research evidence, **not** inferred merely because a strategy was active at the same time. Mixed baseline/evolved research evidence is not misattributed.
- The observer deduplicates both concurrent event delivery and previously persisted mission IDs across Core restart. A blocked (nonterminal) Mission does not become a fabricated failure.
- Observation failures are logged instead of leaving a silent unhandled promise.

## Regression governance

- Each new observation can invoke regression monitoring over durable telemetry history.
- Only the same activated strategy ID+version and observations after the activation timestamp are eligible.
- Replay duplicates, unrelated Missions, stale versions and owner/Guard permission denials do not constitute a strategy regression.
- Two **distinct consecutive** mission failures classified as strategy defects under the active version invoke the existing governed rollback.
- The rollback and promotion records are persisted by the Evolution store when its SQLCipher Vault is available.

## Production Core exposure (follow-up hardening)

- The public `Core.evolution()` and `Core.evolutionStore()` no longer return the mutable lifecycle manager and Evolution store. Instead, callers receive frozen read-only facades with detached candidate, active-strategy and history records.
- Mutating the strategy lifecycle in a controlled test uses an explicit `core/testing.ts` integration seam, not the public `Core` interface.
- This is a defense-in-depth reduction in agent-visible capability. Genuine authenticated owner decisions for evolution promotion are **still not implemented** as a trusted IPC/owner UI gateway; approval strings supplied to lifecycle methods are not credentials.

## Important remaining constraints

1. **Owner authorization boundary:** The lifecycle currently accepts an asserted `decidedBy: 'owner'` / `callerPrincipal` from its method inputs. A string is not independently authenticated owner identity. Raw evolution lifecycle and store accessors on Core are not a verified, owner-gated production UI/API command path. This must be fixed before enabling owner promotions through an untrusted surface.
2. **Live experiment evidence:** Offline selector scenarios reuse production code but do not run real internet Missions, live models, or user-facing independent quality scoring. They must not be described as an empirical agent intelligence benchmark.
3. **Multi-session coverage:** Some older Phase 7 lifecycle tests simulate several stages inside one Core process and restart only at the end. They prove encrypted persistence at that boundary, not real restarts at every stage.
4. **Regression causality:** Observed failures are evidence of correlation, not a guarantee that source ranking caused the failure. The rollback policy intentionally requires version provenance and consecutive strategy-defect outcomes.
5. **Runtime visibility:** No production owner-facing command/approval UI and no full end-to-end Electron QA acceptance have been demonstrated by this change.

Continue in the same branch with a real authenticated owner approval gateway and live acceptance; keep `main` and active Kilo/OpenCode worktrees untouched.
