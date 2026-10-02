# Phase 9 — Context production assembly

Phase 9 Context implementation and final acceptance gates are complete. The
production assembly composes the merged foundation, facade, source adapters,
persistence, turn compiler, host observation and read-only transport.
[Issue #47](https://github.com/aslamwebz/Freya/issues/47) tracks its integration
into `phase-7-missions`. `main` is preserved separately.

## Core ownership and provenance

Core constructs `ContextIntegration` and keeps its store private. Owner-side
admission derives provenance from a closed channel table. The host door fixes
`host_report`, requires an origin, and refuses session scope. Core's own Mission
adapter uses `core_record`. Context never grants a capability, clears STOP ALL,
or authorizes an action.

Every item retains its source, scope, capture/admission instants, TTL and
revocation. The store is bounded, refuses ambiguous references, and destroys
content, labels and URIs on revocation or expiry. Audit rows contain metadata
only. No Context event family or private Context text enters generic activity,
security or the journal.

## Encrypted durability and restart

The desktop keyring generates an independent 32-byte `context` secret, wrapped
by OS secure storage. An upgrade preserves all existing readable keys and leaves
a keyring untouched if any existing secret cannot be unwrapped or the upgrade
cannot be written. No existing domain key is reused.

Core opens the existing encrypted persistence port at `<dataPath>.context.enc`.
`core/contextPersistence.ts` owns recovery, serialized snapshot commits, fault
health and shutdown draining. The synchronous domain store supplies independent
snapshots through an internal callback; it does not read files or keys.

Recovery authenticates and validates the whole snapshot, retires expired
content before readers start, and restores tombstones. It does not restore an
active scope or grant authority. Recovered live window observations become
revoked tombstones because the old observation session has ended. Mission
context is reconciled with the authoritative Mission board in session scope;
missing or changed Missions cannot remain stale live referents.

Context commands await queued writes. A missing key, unavailable secure store,
corrupt ciphertext or failed write leaves Core available and explicitly
process-only/degraded. Damaged ciphertext is left intact. There is no plaintext
fallback. Core reports actual persistence health, and the read-only host mirror
and Context surface display that health; passive write failures publish it too.

## Actual turn input

The real `MindService` receives the existing bounded turn-context compiler.
The reader uses the real turn's conversation id rather than whichever Context
scope another surface last activated. Its list and resolver are scope-bound;
foreign conversation records never reach the reader or packet.

Only an actual submitted turn compiles Context. Live facts are quoted as a
separate `user` message, with provenance and scope, rather than system authority.
The default budget is 2,400 UTF-8 bytes, six items and eight references.
Ambiguity remains explicitly unresolved; revoked and expired words are excluded.
Idle maintenance and observation make zero model calls.

## Opt-in desktop window observation

`FREYA_CONTEXT_WINDOW_OBSERVATION=own-app` explicitly enables the existing
read-only Electron provider for Freya's own focused window. The host supplies a
bounded polling timer and admits observations through a scope-bound Core host
lane. The production scope is the `desktop-window` surface; it does not silently
become ambient session or conversation context.

An unset or unrecognized setting starts no observation. `system` selects the
existing honest unsupported provider: this build has no native OS-wide sensor.
No screenshots, OCR, accessibility scraping, input hooks or computer actions
are introduced. Host shutdown cancels polling/subscriptions and revokes its
latest admitted observation. Restart requires a fresh opted-in observation.
The preload and renderer gain no observation or Context mutation door.

## Verification and remaining boundaries

On 2026-10-02, `npm run verify` passed: typecheck, lint, all 2,089 tests in 102
files, renderer/main/preload build, and all 187 offline Electron desktop checks.
An independent review also passed 94 focused tests and found no remaining
blocking findings. The desktop suite confirms encrypted Context storage reaches
the read-only surface through the production Core/host/preload boundary.
Production assembly regressions cover encrypted restart, degraded storage,
passive fault pushes, Mission/window reconciliation, actual Mind packets,
conversation isolation, ambiguity, revocation, expiry, privacy and observation
cadence/stop. Existing bridge and renderer acceptance tests remain in the suite.

`agent_work` remains a declared deferred kind. OS-wide window identity remains
unsupported. Phase 10 action execution is outside this phase. These limitations
are reported explicitly and are not simulated.
