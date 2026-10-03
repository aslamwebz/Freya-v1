# Phase 28 — Experience → Knowledge → Skill

Branch: `prep/phase27-30` · Status: implemented and tested (domain + engine + canonical Vault
persistence) · Owner: Aslam

PLAN.md §14 row 28: *"verified outcomes become structured experience, knowledge and
reusable procedures."*

This document is the phase's architecture, contracts, test plan and red-team plan. It is
written so the boundaries below are the ones the code is measured against.

---

## 0. What already existed, and what this phase does *not* re-declare

The survey that shaped this phase turned up three things a naive implementation would have
duplicated:

| Existing | Why Phase 28 does not touch it |
|---|---|
| `core/brain`'s `ExperienceRecord` (Phase 4) | That is the **episode**: what was attempted, with which models and tools, at what cost. It records `verification: 'unverified'` and has always. Phase 28 is not that. |
| `core/skills` (Phase 17) | Skills already have contracts, evaluation, promotion thresholds, trust classes, a content hash, an improvement lane and its own red-team suite. Re-implementing any of it would be worse than using it. |
| `core/foundry` (Phase 15) | Artifact building, verification and owner-gated activation already exist. A generated module is Foundry's business, not this phase's. |

What genuinely did **not** exist, and is this phase:

- no route from a **Work/Mission/Foundry verification** into anything durable. Only Mind
  conversation turns ever produced an `ExperienceRecord`.
- `SourceTrust` `'experience-outcome'` was **declared and never assigned by anything**. It
  is the reserved trust class for "a claim distilled from outcomes someone verified", and
  this phase finally assigns it.
- `CognitionOrigin 'learning'` and `CognitionCause 'learning_consolidation'` were declared
  and used by nothing.
- no `core/learning` domain, no knowledge record, no knowledge store, no knowledge protocol.

## 1. The pipeline, and the ladder that narrows as it climbs

```
  VerifiedOutcome  →  LearningExperience  →  KnowledgeRecord  →  ProcedureProposal
  a check passed     a lesson, with the      a claim, with      an inert sketch for
                     limits on where it      evidence and a     core/skills to admit
                     does not generalise      scope bound        or refuse
```

Each arrow generalises a little further, and therefore gets **less** certain, not more.
That is the whole design, and it is why the pipeline is safe to act on: the learning
*narrows* as it climbs.

```
stage              epistemic status   confidence ceiling
check passed       observed           medium
what it established observed          medium
what that suggests observed / inferred medium / low
a reusable procedure — no status of its own; a packet, not a claim
```

## 2. The hard boundary, stated as a contract

> **A knowledge record generalises, and a generalisation is an inference however solid its
> evidence. So no claim in this domain is ever `verified`, and no scope in it means "in
> general".**

Four mechanisms, none of them a prompt instruction.

### 2.1 The confidence ceiling has no row above `medium`

`LEARNING_CEILING` in `core/learning/types.ts` maps every `SourceTrust` to at most
`{ confidence: 'medium' }` and `LEARNING_MAX_CONFIDENCE` is `'medium'`. A test enumerates
every row and asserts none reaches `high` or `verified` — **including the owner's own**.
`capLearningConfidence` can only lower, so there is no call shape that raises one.

This is the load-bearing difference from Brain's table, and it is deliberate: Brain holds
facts, and a verified fact is possible. Learning holds conclusions drawn from facts, and a
conclusion is not a fact.

### 2.2 No scope means generality

```
LEARNING_SCOPES = ['one-instance', 'one-environment', 'repeated-observations']
```

Three rungs, and no member named `general`, `always` or `universal`. Widening what a claim
may reach requires **adding a scope by name** in a reviewable diff, which is a much harder
act than editing a threshold.

### 2.3 Every record must say where it stops

`scopeLimits` is **required and non-empty**, and `checkScopeLimits` adds two mechanical
rules on top:

- `no-future-guarantee` is mandatory on every record, so no lesson can be recorded without
  also recording that it does not predict;
- the scope's own limit must be present and must not be contradicted — a record scoped
  `repeated-observations` cannot also carry `observed-once`.

A claim that disagrees with its own limits is worse than no claim, so it is refused.

### 2.4 A claim cannot be a rule, and cannot be an instruction

`LEARNING_OVERCLAIM_MARKERS` refuses a lesson or claim whose words promise more than its
scope permits ("always", "never", "in general", "under all circumstances", …). It is a
**secondary** gate — the primary gate is §2.2, where there is nothing to word-match — and
it exists because a *model* can be handed a sentence to write, and refusing that sentence
deterministically is better than hoping.

## 3. The evidence rule

There is no unsupported lesson in this store, and the rule is enforced against the **store**
rather than trusted to the caller:

| Stage | Refuses |
|---|---|
| outcome | a missing or content-bearing `verificationId` (`invalid-evidence-refs`) |
| experience | an outcome Core never recorded (`no-outcome`); an evidence set that omits the outcome id (`no-verification-evidence`); a **failed** check presented as a lesson about how to do the thing |
| claim | no cited experience is admitted (`no-supporting-experience`); no verification id behind the admitted ones (`no-verification-evidence`) |

Two consequences worth stating:

- a derived claim cannot be produced from a **model, a page or a document**
  (`distilled-source-forbidden`). They may still be *recorded* as an experience the owner
  can read and withdraw; they simply cannot become a claim.
- `deriveKnowledge` **computes** `verificationIds` from the store rather than accepting the
  caller's list, so the id on a claim is always one Core actually holds.

## 4. The support arithmetic

A procedure proposal is not "Freya learned something". It is:

> several **distinct** checks established something, none of them failed, and none of them
> is too old to rely on.

`LEARNING_PROPOSAL_THRESHOLDS`: `minDistinctVerifications: 2`,
`minDistinctExperiences: 2`, `maxFailedOutcomes: 0`, `maxEvidenceAgeDays: 180`.

Three properties fall straight out of the code, and each is a red-team target:

- **Repeats are not evidence.** Support counts distinct `verificationId`s. Two lessons
  distilled from the *same* check are one piece of evidence, so running one thing forty
  times does not clear the gate.
- **A failure poisons the group.** Tolerance is `0`, and the failure is checked *first*, so
  the reported reason is always the most fundamental problem.
- **Age matters.** An outcome older than 180 days is counted stale, and a proposal resting
  only on stale evidence is below threshold.

Below-threshold proposals are **returned**, not dropped, with `aboveThreshold: false` and a
reason — a surface that only ever saw the successful ones would be showing a flattering
account of what Freya knows.

`lowestConfidence` takes the **minimum** across a proposal's claims, never the maximum: a
proposal is not more certain than its least certain part.

## 5. Skills grant no authority

PLAN.md §2.3: knowledge is not permission. This phase's structural form of it:

- `LEARNING_FORBIDDEN_FIELDS` refuses, by name and before the exact-key check, anything
  reading as authority (`capability`, `grant`, `permission`, `bypassGuard`, `clearStopAll`,
  `budget`, …), as a promise (`always`, `never-fails`, `guaranteed`), as secrecy
  (`secret`, `token`, `credential`) or as a person (`feeling`, `attachment`, `missed`, …).
  Matching is normalised and affix-tolerant, so `requiredCapabilities`, `grantsAuthority`,
  `alwaysWorks` and `bypass_guard` are one family written four ways.
- A `ProcedureProposal` carries `grantsCapability: false`, `executable: false` and
  `authority: 'none'` **as fields**, so a surface can *render* the guarantee rather than
  merely not violate it. `assertProposalIsInert` checks those values and then scans the
  remaining field names.
- The single exit is `admitToSkills`, which produces a `SkillAdmissionPacket` with **no
  capability, scope, origin, activation or priority field** and, notably, **no `status`**:
  a proposal does not decide its own standing. `core/skills` admits it as a `candidate`
  and applies its own evidence and trust-class gates, independently, without asking this
  domain for permission — because this domain has no permission to give.
- `PROPOSAL_SOURCES` is narrower than the ceiling table: only `experience-outcome`,
  `owner-assertion` and `system-observation`. Nothing a model or a page touched may become
  a reusable procedure.
- A red-team test parses every **import statement** in `core/learning` and asserts none
  reaches `model/`, `authority`, `guard`, `skills` or the Vault — matching on the final path
  segment, so `./safeguards` is not a dependency and `core/authority` is.

## 6. Contracts

```
core/learning/
  types.ts       closed vocabularies, ceilings, thresholds, limits, shapes. No logic.
  outcome.ts     stage one: a verified outcome, and the trust class derived from its domain.
  experience.ts  stages two and three: construction, admission, lifecycle, scope rules.
  rebuild.ts     read-rebuild, never read-trust.
  fold.ts        validateRecord + applyRecord (one deterministic fold) + rowKey.
  derive.ts      counts, conflicts, strongest scope, proposal support arithmetic.
  safeguards.ts  inertness, proposal sources, the Skills packet, the grants-nothing data.
  store.ts       LearningStore interface + LearningStoreError.
  projection.ts  bounded projection, broad read, single-claim read, owner export.
  engine.ts      the pathways and the owner's acts.
  index.ts       barrel.
core/protocol/learning.ts                      the read-only view a renderer is typed against.
core/vault/repositories/learning-store.ts      Vault-backed store + memory/ephemeral store.
```

### 6.1 The pathways fix their own trust class

```
recordVerifiedOutcome()  the trust class is DERIVED from sourceDomain
distilExperience()       the trust class is DERIVED from the outcome's domain
deriveKnowledge()        'experience-outcome', or 'owner-assertion' for the owner's own claim
recordOwnerLesson()      a lesson the owner stated, still over a recorded outcome
```

No method accepts a `SourceTrust`, and no statement input has a source field. The one
derivation — an outcome's — reads a code-owned domain table, and an **unrecognised domain
resolves to `imported-document`**, the weakest class, rather than to a default that reads as
an observation.

An owner lesson is admitted as an *experience*, not a claim, and still needs support before
anything can be proposed from it. There is no "the owner told me so" path into learning,
because a claim with no check behind it is a rule and this domain does not hold rules.

### 6.2 Refuse, do not drop

`distilExperience` and `deriveKnowledge` spread the caller's statement into the constructor
rather than re-listing its fields, so an untyped payload carrying something extra is
**refused** by the forbidden-field and exact-key rules instead of being quietly discarded on
the way in. A field this engine silently dropped today is a field somebody will read next
month.

### 6.3 The owner's acts

`correct` writes the replacement first and supersedes the original second, so an interruption
between them leaves both live — which the derivation discloses as a conflict — rather than
leaving nothing. `withdraw` destroys the text and keeps the fact. `forget` removes the row
and **refuses a live record**, so total destruction is always a second, deliberate act.
`reject` keeps a candidate readable with its reason. `export` is the one text-carrying read
at breadth: bounded, owner-only, and honest about what the bound withheld.

### 6.4 Read-rebuild

`rebuildLearningExperience` and `rebuildKnowledgeRecord` reconstruct a row and re-apply
every construction rule, and they **re-derive the epistemic label** from the source class
rather than reading it from the row. A hand-edited record that gained a `capability` field,
raised its confidence, dropped its support, contradicted its own limits or kept its text
after retraction is refused whole, and the store **degrades** rather than skipping it.

## 7. Persistence

`VaultLearningStore` writes one row per record into the existing `vault_kv` table under
`domain = 'learning'`, keyed `outcome:<id>` / `experience:<id>` / `knowledge:<id>`. One
keyspace for the whole pipeline, so a cross-kind id collision cannot be mistaken for a
conflict. No bespoke table, no second file, no dual write, no plaintext fallback. Every row
is parsed, validated and folded by the same `validateRecord`/`applyRecord` the memory store
uses, so a state built on the Vault is indistinguishable from one built in memory.

`MemoryLearningStore` is the ephemeral/session mode and is **labelled**: `mode:
'ephemeral'` with a `faultReason`. It is never a silent substitute for the encrypted store.

## 8. Privacy

Broad reads carry `textLength`, never a lesson or a claim. The two reads that carry text —
`learning.claim.read` (single, owner-only, bounded) and the owner export — are Core-internal.

One detail worth naming: a proposal's step summaries **are** claims verbatim, so the
derivation and the projection carry `LearningProposalSummary` — the proposal without its
steps, plus a `stepCount`. The full proposal is produced only by `deriveProposals`, for the
Skills hand-off that genuinely needs the text. And a proposal's `name` is **code-owned**
(`procedure for <family>`), built from the claim family rather than copied from a claim,
because a proposal name crosses in the broad projection.

## 9. Test plan

| File | What it pins |
|---|---|
| `tests/core/learning-domain.test.ts` | stage shapes, the ceiling and its absence of `verified`, the evidence rule, scope and scope-limit agreement, forbidden fields, lifecycle, read-rebuild |
| `tests/core/learning-derivation.test.ts` | support arithmetic, repeats-are-not-evidence, failure tolerance, staleness, conflicts disclosed, determinism, derivation keys |
| `tests/core/learning-engine.test.ts` | no stage skipping, correction-without-erasure, withdrawal, forget-after-withdrawal, the Skills packet, privacy boundaries, retention bound |
| `tests/core/vault/vault-learning-core.test.ts` | round trip, restart, namespaced row keys, withdrawal surviving a restart, forget deleting the row, degradation, wrong key, no plaintext sentinel |
| `tests/red-team/learning/authority-laundering.test.ts` | capability fields refused, proposal inertness, the packet's shape, source restrictions, no activation methods, no privileged imports |
| `tests/red-team/learning/overgeneralisation.test.ts` | no scope means generality, limits required and self-consistent, overclaim refusal, one check is never enough, repeats are not evidence, staleness |
| `tests/red-team/learning/untrusted-distillation.test.ts` | model/page/document cannot become learning, fabricated evidence refused, verification ids derived not accepted, pathway-assigned provenance |
| `tests/red-team/learning/privacy-and-forgery.test.ts` | no text in any broad sink, code-owned proposal name, withdrawal and forgetting destroy, no renderer write path, degraded reported |

Every test is deterministic: injected `now` and `newId`, no clock reads, no randomness, no
network, no model provider.

## 10. Red-team plan

Attacker model: an untrusted page, a document, a connector payload, a renderer, a model
that has been asked to be helpful, or an operator who has run the same thing many times and
would like Freya to notice a pattern.

| # | Attack | Expected refusal |
|---|---|---|
| 1 | Page supplies a lesson with `requiredCapabilities: ['work.run.manage']` | `forbidden-field-refused` |
| 2 | A claim tries to assert `confidence: 'verified'` | `confidence-ceiling`; the ceiling has no such row for any source |
| 3 | A model reports a lesson from a page it read | admitted only as an `experience-outcome`; `distilled-source-forbidden` on any claim |
| 4 | A page says "this always works" | `too-generic` |
| 5 | One check, repeated forty times | `too-few-verifications` — support counts distinct verifications |
| 6 | Two successes and one failure | `failed-outcomes-present` |
| 7 | Evidence from 400 days ago | `evidence-stale` |
| 8 | Caller claims verification ids Core never recorded | `deriveKnowledge` computes them; unsupported claims refused |
| 9 | Hand-edited row gains `capability`, or claims `verified` | refused on read; store degrades |
| 10 | Renderer asks the Core to record a lesson | no `learning.*` command exists; the protocol carries no write verb |
| 11 | Untyped payload carries an extra field | spread into the constructor, so refused rather than dropped |
| 12 | A proposal is edited to `grantsCapability: true` | `proposal-not-inert`; refused rather than sanitised |

## 11. Explicit non-goals for Phase 28

- **No generation.** Nothing here builds a tool, writes code or produces an artifact.
  That is Phase 29 (capability acquisition) and Foundry (artifacts), and this phase does
  not import either.
- **No self-modification of trusted runtime.** PLAN.md §10 reserves that for Phase 30's
  staging-branch loop, and `core/skills`'s `PROTECTED_DOMAINS` already names the boundary.
- **No skill admission.** This phase produces a packet; `core/skills` decides. Adding an
  admission call here would put two gates on one path and make the weaker one look like the
  stronger.
- **No journal events.** The Vault is the source of truth and the projection is derived, so
  a journal entry would be a second copy of claim metadata in the least-protected file in
  the system. Phase 30 announces where the audit trail actually matters.
- **No cross-domain writes.** Outcomes are *described* by the caller; this domain never
  reads Work's store and never writes to it.

## 12. Dependencies

Present on this branch and used here: `core/brain/types` (`Confidence`, `Provenance`,
`SourceTrust`, `CONFIDENCE_RANK`), `core/brain/admission` (`findSecretShape`),
`core/hands/validation` (`hasExactKeys`), `core/vault` (canonical SQLCipher store).