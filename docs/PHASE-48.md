# Phase 48 — Skills / Forge Activation

**Status:** IMPLEMENTED — DECLARATIVE SANDBOX, FAIL-CLOSED BY CONSTRUCTION
**Branch:** `runtime/phase48-skills-forge`
**Baseline:** `main` @ `d347a9c`
**Required outcome:** activate Freya's Skills + Foundry/Forge systems so she can safely
discover, generate, validate, install, version, enable, disable and run bounded
modules — without modifying Core authority or silently self-modifying.

---

## 1. The decision everything else follows from

Phase 48 was asked to run generated and external skills in a constrained runtime.
**This architecture cannot provide one, and the phase says so rather than pretending.**

`node:vm` is documented by its own authors as not a security mechanism. A
`worker_thread` shares the process, its filesystem, its environment and its keyring
handle. A subprocess shares all of it too. There is no `eval`-free general-purpose
sandbox here to hand a generator, and shipping `new Function` behind a reassuring class
name would have been the single worst lie in the codebase.

So the executable surface of a Forge package is **not code**. A package's program is a
straight-line list of operations drawn from a closed table of fifteen pure operations,
interpreted by `core/forge/program.ts`. What that buys is a property of the *shape*
rather than a promise:

| requirement | how it is structural |
| --- | --- |
| no unrestricted shell | there is no operation that spawns anything |
| no arbitrary host filesystem | there is no path in the value model, so traversal is unrepresentable |
| no OS keyring / Vault | no operation reads a process, an OS or an environment |
| no environment secrets | the interpreter imports no `node:*` module at all — asserted by a test that reads its imports |
| no network unless declared and granted | no operation performs I/O; a package *plans* a network act for Research or Relay, which hold the capability |
| no `eval` / native module / escape | there is no path from a manifest to a JavaScript evaluator, so there is nothing to escape into |
| CPU bound | a program has no jumps, no recursion and no branch, so the worst case is its own step count |

**The cost is real and is projected on every read.** A Forge package can transform
data, parse and format text, describe a research or connector *plan*, render a
declarative UI artifact and emit a recipe. It cannot be an arbitrary plugin. That
sentence is `ForgeProjection.runtimeNotice`, shipped in the protocol, the projection,
and this document — because the most useful thing a person can know about a generated
skill is what it *cannot* do.

Two smaller honesty notes in the same spirit:

- **No regular expressions.** Catastrophic backtracking is a denial of service inside
  one synchronous call, which a per-step budget cannot interrupt. The operation is
  omitted rather than bounded badly.
- **The static scan is lexical, and says so.** A regex over text cannot prove safety.
  It exists to *explain* refusals (`protected-core-reference`, `secret-access`,
  `forbidden-host-api`, …) rather than to find every possible abuse. The proof of
  safety is that nothing it inspects is ever executed as text.

---

## 2. Architecture

```
core/forge/
  types.ts        closed vocabularies, limits, the package model, refusal codes
  manifest.ts     the door: refuse rather than repair, then canonicalise and hash
  program.ts      THE SANDBOX — static validation + bounded interpretation
  security.ts     the closed static rule table, run over the submitted bytes
  pipeline.ts     the seven validation stages, in order, always all of them
  versions.ts     immutable versions, explicit downgrades, tamper detection
  discovery.ts    local lexical search — no model call, no download
  state.ts        the fold: what exists, derived from `forge.*` events only
  projection.ts   the sanitised read model and the one owner-only detail read
  persistence/    AES-256-GCM snapshot store + ephemeral fallback + codec
  engine.ts       the impure seam: journal + store + two authority ports
core/forgePersistence.ts   Core-side store lifecycle and health reporting
core/protocol/forge.ts     the view a window may hold, and the closed outcome shape
```

Two impure edges exist and both are injected: the `EventFabric` and the body store.
The engine holds no gateway, no provider, no `node:fs`, and no authority object. Its
two authority ports answer exactly two questions:

- `isRegistered(capability)` — does any registered Work capability need this Guard
  capability? (the same question Skill admission asks)
- `holds(capability)` — does the owner hold it *right now*, read fresh per run?

**No second skill registry.** A package's identity is `forgePackageId(name)`, which is
`deriveSkillId(name)` — the Skill domain's own derivation. A Forge candidate and a Skill
record for one name are one entity. The Skill domain keeps owning the *procedural trust*
lifecycle (candidate → verified → promoted); Forge owns the *deployment* lifecycle
(candidate → generated → validated → verified → installed → enabled/disabled/quarantined).
Neither invents a second registry of what Freya can do.

---

## 3. The package model

Every field the brief asked for, and where it lives:

| field | where |
| --- | --- |
| stable id | `forgePackageId(name)` — derived from the name, so a retried generation is the same package |
| name / version | manifest; version assigned by Core, never read from a payload |
| source / provenance | `ForgeProvenance`: origin (`owner-authored`, `forge-generated`, `local-import`, `acquired-remote`), model, request hash, origin ref, instant |
| description | bounded to 400 characters, never journalled (only its length is) |
| declared capabilities | `capabilitiesRequired` — a **declaration**, checked against registered capabilities and re-checked at run time |
| inputs / outputs schema | closed field specs: `string`, `number`, `boolean`, `list`, `record` with a closed key set |
| runtime kind | `pure-transform`, `data-pipeline`, `research-helper`, `connector-wrapper`, `ui-artifact`, `automation-recipe` |
| permissions / access | `denied` or `declared` only, for network, filesystem, device, keyring, process |
| dependencies | exact versions, policy-checked, never resolved by Forge |
| integrity hash | SHA-256 (truncated) over `canonicalForgeManifest`, key-ordered |
| signature / trust state | `unsigned` / `unsupported` — an honest answer, not a placeholder |
| lifecycle status | the twelve states below |
| tests / verification result | `ForgeTestResult` with checks, failures and a failure hash (never the text) |
| installed / enabled instants | per version, in the fold |
| rollback version | `installedVersions`, contiguous |
| owner approval state | `not-required` / `pending` / `approved` / `refused`, per version |

Statuses: `candidate`, `generated`, `validating`, `verified`, `rejected`, `installed`,
`enabled`, `disabled`, `degraded`, `quarantined`, `superseded`, `removed` — with one
table of allowed transitions. Two properties are load-bearing: `candidate` has zero
authority, and there is no edge from `installed` to anything but `enabled` *or* no edge
at all — installation never enables.

---

## 4. Generation

`forge.generate` produces **candidate source only**. The candidate:

- is a `candidate` with zero authority — not installed, not enabled, not runnable;
- records its provenance (origin, model, request hash) and never its response body;
- is **not** auto-enabled, ever;
- installs no dependency — a missing dependency is a refusal, never a fetch;
- performs no network request — `unrestricted-network` and `hidden-dependency` are
  static-scan findings;
- cannot reach protected Core — there is no filesystem write anywhere in the domain,
  and a candidate that *names* Core source is refused with
  `protected-core-reference`.

`local-import` produces an identical candidate; the envelope's integrity hash is
recomputed from the manifest it carries and compared, so a lying envelope is refused
rather than repaired. Remote acquisition, if another phase adds it, must produce the
same untrusted candidate and go through the same pipeline.

---

## 5. The validation pipeline

```
candidate
  → manifest        static shape, schema and program validity
  → dependencies    explicit, exact-version, installed, not quarantined
  → integrity       the hash matches the bytes it claims to describe
  → security        the static scan
  → tests           isolated execution over code-owned fixtures
  → capabilities    declared ⊆ registered, and the right kind of authority
  → approval        the owner's decision, where one is required
→ install          writes metadata only
→ enable           a separate, explicit act
```

**A failed stage cannot be skipped by model output**, because no stage reads an
assertion. Every stage is a function of the candidate's own bytes plus Core's own
registrations. There is no `verified: true` in any payload, no field a generator can set
that a later stage trusts, and no path from a model response into a verdict. A caller
that wants `verified` runs the pipeline; a caller that says `verified` is talking to a
package that is still a `candidate`.

The report always contains **every** stage, in order, including the ones that did not
run — marked `not-applicable` — because a truncated pipeline is the shape that lets a
reader assume the rest was considered.

The isolated tests are deterministic by construction: fixtures are synthesised from the
declared schema by code, and a candidate cannot choose them. Two batteries run — all
fields present, and every optional field absent — because a package that only works
when an optional field happens to be there has a contract its own schema denies.

---

## 6. Capability admission

- **Installing or enabling grants nothing.** Neither method takes a capability field,
  the engine has no `grant`, and the projection reports the declared list as a *count*.
- Declared capabilities must be in the closed vocabulary (`unknown-capability`),
  must not be a decision capability (`forbidden-capability`: `security.*`,
  `cognition.grant.manage`, `work.approval.decide`, `mission.manage`, `work.run.manage`,
  `skill.manage`, `foundry.*`, `forge.*`, `improvement.merge.approve`,
  `improvement.rollback`, `acquisition.activation.manage`, `relay.approval.decide`),
  and must be one this Core has registered (`capability-not-registered`).
- A **purely local runtime may declare no capability at all**. `pure-transform`,
  `data-pipeline`, `ui-artifact` and `automation-recipe` compute locally and have no
  operation that could use one; a declaration there is refused rather than downgraded.
- `research-helper` must declare a research capability; `connector-wrapper` must
  declare a relay capability. The declaration is a *plan* — the act happens in the
  subsystem that holds the capability, under its own approval and audit.
- **Execution re-checks.** Every run asks `holds()` for each declared capability, and
  refuses with `capability-not-held` when the acting principal does not hold it.
  Installation never cashed the declaration; a run does.

---

## 7. Versioning

- Versions are **immutable**. A version number that exists with different content is
  `version-conflict` — whether it was installed or is still a candidate.
- Installed versions are **contiguous**: the next installed version is exactly one past
  the highest installed.
- A version whose bytes hash identically and which is already installed is
  `identical-version`; a version that changes nothing is not a new version.
- A **downgrade is explicit**: `allowDowngrade` on the install command, or a rollback.
- `forge.rollback` returns to `installed`, never to `enabled`.
- **Tamper is quarantined, never repaired.** A body that no longer hashes to what the
  journal recorded is quarantined at recovery, at validation, at install, at run and
  at rollback, with `integrity-mismatch` as the reason.

---

## 8. Execution

Typed input and output (both validated against the schema, extra fields refused),
bounded payload, explicit error states, and a deterministic result envelope carrying
`opsUsed`, `inputChars`, `outputChars` and `durationMs`.

- `idempotencyKey` makes a retried run a **replay of the recorded outcome** rather than
  a second execution, which is what stops a timeout-retry from doubling whatever the
  package did.
- **No fabricated success.** A failed run is recorded as `failed` with a closed failure
  code; the projection reports it. A journal line claiming `succeeded` with no
  `finishedAt` is rejected by the payload validator, so "it worked" cannot be written
  by leaving one field out.
- A run that dies inside the program on data it should have handled **degrades** the
  version. A bad payload, a cancellation and a deadline do **not** — they say nothing
  about whether the package works, and degrading on them would let anyone who can type
  the wrong shape switch a working package off.
- **STOP ALL has precedence** over generation, validation, install, enable, disable,
  rollback, remove and run. A stop is a latch, not a rewrite of the catalog: the
  package stays marked enabled, because the owner's decision is still theirs.

---

## 9. The self-improvement boundary

Freya may create a candidate skill to improve her own workflow. She may **not**:

- rewrite protected Core, Guard, the Governor, approvals, the Vault or security code,
  provider-secret handling, or runtime authority — there is no path from a manifest to
  a filesystem write, and a candidate that names Core source is refused;
- grant itself a capability, approve its own approval, or enable anything without the
  owner's explicit act;
- become trusted Core code merely because she generated it.

Any Core change remains normal developer work in the repository. A red-team test
asserts that `core/security/guard.ts` is byte-identical after a full generate →
validate → install → enable → run cycle.

---

## 10. User control

Twelve commands, every mutating one Guard-evaluated on `skill.manage` and audited, every
refusal carrying a closed code:

`forge.status.read` · `forge.generate` · `forge.validate` · `forge.install` ·
`forge.enable` · `forge.disable` · `forge.run` · `forge.rollback` · `forge.remove` ·
`forge.approve` · `forge.search` · `forge.export` · `forge.detail.read`

Pointedly absent: `forge.installAndEnable`, `forge.setStatus`, `forge.setVerified`,
`forge.setEnabled`, `forge.grant`, and anything that writes a package into Core.

The bridge is push-only: one projection channel, one read, and every mutation through
`freya:core:submit`. There is no `freya:core:forge:write` channel and no preload method
that accepts a manifest, so the renderer cannot become a second admission door.

---

## 11. Projection and journal

The projection carries installed packages, enabled state, verification and trust state,
declared-capability **counts**, last run and result, update availability, quarantine
reason, counts, limits, persistence health and `runtimeNotice`. It does **not** carry a
program, a description, a run's input or output, a capability list, or a host path —
the package body crosses only through `forge.detail.read`, for one package, to the
owner. (The capability *list* is on the detail read for the same reason Skills keeps it
off its projection: the list is the capability map and belongs to Core.)

`forge.*` events are metadata only — ids, slugs, closed labels, versions, hashes,
counts, measured lengths, instants and closed codes — and every one has an exact-key
payload rule in `core/events/validate.ts`, so an extra field cannot ride along. The
journal names candidates, validations, installs, enables, disables, rollbacks,
quarantines, degrades, removals, approvals, runs, refusals and limit breaches.

---

## 12. Recovery

- Catalog, versions, hashes and **enabled state** survive a restart: the journal is the
  authority, the encrypted store holds the bodies.
- A body is adopted only when the fold vouches for that exact version *and* the bytes
  still hash to the recorded value; a mismatch quarantines with a reason rather than
  being dropped silently.
- **An in-flight run becomes `interrupted`.** A run whose result was not durably
  recorded did not provably happen, and it is not retried.
- **Nothing is auto-run on restart.** There is no resume, replay or "run whatever was
  in flight" branch anywhere in the engine.
- A damaged store reports `durable: false` with a reason. It is never silently replaced
  by an ephemeral one, because that would report "nothing is remembered" when the truth
  is "the file is damaged and Freya stopped trusting it".

---

## 13. Tests

`tests/core/forge-domain.test.ts` (38), `tests/core/forge-sandbox.test.ts` (21),
`tests/core/forge-lifecycle.test.ts` (25), `tests/red-team/forge/forge-redteam.test.ts`
(26). Full suite: **364 files, 7396 tests passing**; red-team suite 1225 tests; E2E
216/216; build, release check and three TS configs clean.

Covered: candidate has no authority · invalid manifest · unknown capability ·
dependency refusal · malicious package and path traversal · secret / keyring / Vault
denied · unrestricted shell denied · network denied unless declared · timeout, output
and input bounds · STOP ALL · install does not auto-enable · enable requires approval
where required · version integrity · rollback · quarantine on tampered body · damaged
store · generated skill cannot edit protected Core · malicious source cannot alter grant
metadata · restart · interrupted run · export/import integrity · no fabricated run
success · no model calls on any path · no `node:*` import in the executable path.

---

## 14. Known limitations, stated rather than hidden

1. **No general-purpose sandbox exists in this architecture.** The supported runtime is
   a declarative subset; a Forge package cannot be an arbitrary plugin. This is the
   single most important limitation of the phase.
2. **No signatures.** `signatureState` is `unsigned`/`unsupported`. Integrity hashes
   detect change, not authorship.
3. **The static scan is lexical.** It explains refusals; it does not prove safety, and
   the interpreter's closed op table is what makes the package safe.
4. **No model-facing generation path yet.** `forge.generate` records `origin:
  'owner-authored'` and refuses a payload that tries to state its own provenance. A
   future generation seam inside Core would pass `forge-generated` with the model and
   request hash it recorded; nothing about the pipeline changes.
5. **No UI.** The Foundry/Skills surfaces can be wired to the projection and the command
   vocabulary later; this phase adds only the projection and host seams.
6. **Release budget.** Phase 48 grew `main.cjs` to ~2.15MB, past the Phase 42 ceiling.
   `scripts/release-policy.mjs` records the measurement and raises the bound to
   2.25MB / 126KB, following the convention Phase 42 set.