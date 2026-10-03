# Phase 22 — Self & World Model II

A durable, typed, bounded representation of the people, things, relationships and
state Freya has **evidence** for — plus a strict self-model that keeps identity,
capabilities, skills, model identity and worker claims in separate compartments
so that no claim can ever become authority.

This is the backend that will eventually make **World**, **Mind** and **Home**
real instead of preview graphs. It is not a UI phase, and it deliberately does not
implement Phase 20 unified consciousness or Phase 21 autobiographical memory.

The governing rule is the one from [FREYA-CONSTITUTION.md](FREYA-CONSTITUTION.md):
**knowledge never implies permission**. This phase is the largest new surface for
facts Freya holds about the world, so it is also the phase where that rule is
easiest to break by accident. Everything below is arranged so that the honest
answer is the cheap one.

## What this is not

It is not a database explorer. There is no `query(sql)`, no filter language and
no "show me everything" call — the same reason the Brain has none
([`core/brain/store.ts`](../core/brain/store.ts)): over high-value private data, a
generic query surface reachable from a renderer makes "read the store" and "read
anything" the same capability.

It is also not a second copy of the domains it draws on. Missions, Work,
Workforce, Skills, Foundry, the Brain's identity and Guard's security state all
keep their own truth. Phase 22 **references** them and never re-states them.

## Core ownership

`core/world/` is Core's, and it is Electron-free and renderer-free.

| File | Owns |
| --- | --- |
| `types.ts` | The ontology — entity kinds, relation types, channels, limits, refusal codes. Types and closed tables only. |
| `identity.ts` | Deterministic identity: normalised names, entity ids, edge ids. Pure. |
| `evidence.ts` | Evidence admission — the trusted seam, the channel→source table, and the caps. Pure. |
| `relations.ts` | Relation typing, direction, freshness and conflict detection. Pure. |
| `self.ts` | The self-model: identity, role, capabilities, skills, model identity, worker claims, beliefs. Pure. |
| `fold.ts` | The deterministic fold from evidence records to entities and edges. Pure. |
| `state.ts` | Folded state, ordering, derivation of live domain references. Pure. |
| `projection.ts` | The only route from domain facts to a window. Pure. |
| `engine.ts` | The one impure piece: admission, persistence commits, projection assembly. |
| `persistence/` | The encrypted snapshot port, codec and stores. |

`engine.ts` holds no gateway, no provider, no authority object and no `Principal`.
It cannot spend a model call, mint a capability or clear STOP ALL, because none of
those exists on any type it holds. That is asserted structurally by a red-team
test.

## The ontology

### Reuse, not reinvention

Phase 22 **imports** the Brain's epistemic vocabulary rather than defining a
parallel one:

| Reused from | What it gives Phase 22 |
| --- | --- |
| `EpistemicStatus` ([`core/brain/types.ts`](../core/brain/types.ts)) | `unknown · observed · asserted · inferred · verified · contradicted · stale` |
| `Confidence` | `unknown · low · medium · high · verified` — categories, deliberately never a float |
| `SourceTrust` | `owner-assertion · system-observation · external-untrusted · model-inference · freya-inference · imported-document · experience-outcome` |
| `Sensitivity` | `normal · personal · sensitive · secret-reference` |
| `Provenance` | the shape every world record carries |

Two parallel vocabularies for "how sure are you" and "who said so" would be the
first place this design went wrong, because the second one would have no rules.

### Entity kinds

An entity is **not** a claim. That a name exists in the graph says only that
evidence mentioned it; what is true *about* it lives in edges, each with its own
provenance, epistemic status and freshness.

Two populations, kept strictly apart:

**Reference kinds** — a live pointer into a domain that already owns the truth.
Nothing is stored. The node's state is read fresh from the owning domain on every
projection, so a Mission that is cancelled is cancelled in the graph immediately,
and there is no second copy to fall out of date.

| Kind | Owned by | What the graph shows |
| --- | --- | --- |
| `mission` | Mission Core | id + `MissionStatus` |
| `run` | Work | id + `RunStatus` |
| `task` | Work | id + `TaskStatus` |
| `worker` | Workforce | id + Core's name + `WorkerStatus` |
| `team` | Workforce | id + Core's name + `TeamStatus` |
| `skill` | Skills | id + slug name + `SkillStatus` + version |
| `artifact` | Foundry | content hash + `kind` + Foundry status |

**Evidence-backed kinds** — entities that exist only because the owner or a Core
subsystem stated them, and that Phase 22 therefore does store.

| Kind | Justified by |
| --- | --- |
| `person` | the owner, and people the owner names |
| `project` | the owner's own projects; Context already models `project` as an owner-authorised kind |
| `organisation` | Brain's `KNOWN_WORLD_ENTITY_TYPES`; the natural counterparty of `person` |
| `place` | Brain's `KNOWN_WORLD_ENTITY_TYPES`; the natural anchor of `located_in` |
| `self` | **Freya herself**, a single Core-owned node (`ent_freya`) |
| `owner` | the owner, a single Core-owned node (`ent_owner`), kind `person` |

**Declared, not sourced.** These exist so a request for one fails with an honest
reason rather than a quiet absence — the same trick
`DEFERRED_CONTEXT_KINDS` plays:

```
account   file   device   service   product   system   asset   unknown   conversation
```

Each is refused with `entity_kind_deferred` and a sentence. Notably
`conversation`: the *existence* of a conversation is private to the owner, is not
evidence about the world, and listing conversation ids in a broad graph would
disclose that a conversation exists for no modelling benefit.

### Identity is derived, never minted

An evidence-backed entity's id is a digest of its normalised name:

```
entityId = "ent_" + sha256(WORLD_CRYPTO_DOMAIN | 0 | kind | 0 | normalisedName)[0..16]
```

Exactly like [`deriveSkillId`](../core/skills/identity.ts). Consequences, all
intended:

- **The same statement always produces the same entity**, which is what makes
  replay deterministic without replaying a clock or a counter.
- **Normalisation is exact, not fuzzy.** `Ana` and `Ana ` are one entity; `Ana`
  and `Anna` are two, reported as two, and *never* merged. Entity merging needs
  evidence of identity, and a heuristic merge is exactly how a poisoned entity
  gets adopted into a real person's node.
- A name that cannot be normalised is **refused**, never repaired. `../../etc`,
  empty, 2000 characters and a name with a control character all fail.

A relation's id is derived from `(subject, type, object, evidenceId)`, so the same
evidence always yields the same edge and two edges never collide by accident.

### Relation types

A closed table, with the endpoint kinds it accepts and whether it is directed.
An admission naming a pairing outside the table is refused (`relation_type_unknown`
/ `relation_endpoints_invalid`) — the provenance table of the Context domain does
the same thing for kinds and sources, and the argument is identical: a wrong
pairing has to be *expressible* so it can be *refused*.

| Relation | Subject kinds | Object kinds | Directed |
| --- | --- | --- | --- |
| `works_on` | person, owner, worker | project, mission, run, team | yes |
| `assigned_to` | worker, run | mission, run, task | yes |
| `member_of` | worker, team | team | yes |
| `owns` | person, owner | project, organisation | yes |
| `part_of` | project, team, run | organisation, project, task | yes |
| `depends_on` | project, run | project, artifact, skill | yes |
| `created` | person, owner, worker, run | artifact | yes |
| `uses` | person, owner, worker, run | skill | yes |
| `located_in` | person, owner, project | place | yes |
| `works_at` | person, owner | organisation | yes |
| `acquainted_with` | person, owner | person, owner | **no** |
| `related_to` | any | any | **no** |

Two of these deserve their reasons stated.

`acquainted_with` is undirected because "Ana knows Bo" and "Bo knows Ana" are not
the same claim, and pretending they are would let an owner statement launder a
one-sided relationship into a mutual one. It exists because a world model with no
person-to-person edge cannot draw a room.

`related_to` is the honest weak edge: "these two were mentioned together, and
nothing stronger is supported." It is undirected, and **a non-owner channel may not
admit it above `low` confidence**. Without that cap, `related_to` becomes the
universal escape hatch that every uncertain claim hides behind, and the graph
stops being a model of anything.

Exactly one of `objectEntityId` and `literalValue` is set — a relation either
points at another entity or states a value. It is impossible to write a relation
that points at nothing.

## Provenance rules

### The channel is the trust

The load-bearing mechanism. An admission **never names its own source**. It names
a *channel*, and a frozen table assigns the source:

| Channel | `SourceTrust` assigned by Core | `EpistemicStatus` cap | `Confidence` cap |
| --- | --- | --- | --- |
| `owner_statement` | `owner-assertion` | `asserted` | `high` |
| `system_observation` | `system-observation` | `observed` | `medium` |
| `worker_claim` | `external-untrusted` | `asserted` | `low` |
| `model_hypothesis` | `model-inference` | `inferred` | `low` |
| `imported_content` | `imported-document` | `asserted` | `low` |

This is Phase 9's `CHANNEL_SOURCE` argument, applied to claims about the world. A
web page, an email, a worker's message or a model's answer can put the words
"the owner said so" in its own text and it will be recorded as exactly what it is:
untrusted content from a worker. **Content can never upgrade its own source
classification.**

### Facts versus claims

`verified` is **unreachable through any evidence channel**. There is no code path
in Phase 22 — public, Core-internal or otherwise — that admits an evidence-backed
claim as verified. The caps above make that structural rather than a matter of
discipline: an admission arriving with `epistemic: 'verified'` is *clamped*, and
if it asked for more than its channel allows the whole request is refused with
`confidence_above_channel` / `epistemic_above_channel`.

What *is* verified is Core's own record of an authoritative domain, and that is a
separate population: reference nodes and domain-derived edges carry
`epistemic: 'verified'`, `confidence: 'verified'` and a `sourceRef` naming the
Mission, Worker or Skill record they were read from. That is the honest meaning
of "fact" here — *something Core itself recorded* — and it is why the graph can
show both a fact and a rumour without the rumour being promoted to fill the gap.

### Freshness

Freshness is computed from the record's own instants against a supplied clock. It
is never stored as a mutable field, so it cannot drift from the evidence.

| Freshness | Meaning |
| --- | --- |
| `current` | observed within the freshness horizon, not withdrawn, no conflict |
| `aging` | observed, but older than the horizon's soft bound |
| `stale` | observed well beyond the horizon, or superseded by later evidence |
| `historical` | `validUntil` has passed — it was true, and is not now |
| `conflicted` | another evidence record disagrees; both are kept |
| `withdrawn` | the evidence was withdrawn; excluded from the graph, counted |

A stale fact is **never presented as current**, and a historical one is never
dropped silently — the counts say how many exist in each state, so a person can
see that something went somewhere rather than nowhere.

### Conflicts coexist

When two evidence records make incompatible claims about the same
`(subject, relationType, object)` — different literal values, or a different
`object` for a single-valued relation — **both are kept, both are marked
`conflicted`, and neither is chosen.**

There is no "most trusted wins" rule, because `SOURCE_TRUST_RANK` exists in the
Brain precisely to *bias admission*, and applying it to pick a winner would let a
single system observation silently overwrite the owner's own statement. The
summary reports each unresolved conflict with the ids on both sides, so a surface
can render the ambiguity instead of resolving it. `SUPERSEDING` is the one
exception and it is explicit: evidence that names an earlier record as superseded
retires that record as `stale`, and the superseding relationship is recorded on
both edges.

### Three refusals that are security, not tidiness

- **Reserved names.** `Freya` and `owner` are Core-owned singletons. An admission may
  *refer* to them and may never *create* them — the asymmetry is the point, because a
  rule that refused both would make the self node unreachable in every sentence that
  mentions it. `name_reserved`.
- **Capability names.** `security.stop` cannot become a thing in the world. If it could,
  a poisoned entity would render in a list beside real ones and read as a capability
  Freya holds. A capability is a name in a closed vocabulary, not a person, a project
  or a place. `name_is_capability`.
- **Source references must be ids.** A `sourceRef` is projected verbatim, so a
  permissive character class would let a payload carry a sentence into a provenance
  field and straight out to a surface. `[A-Za-z0-9._:-]`, bounded, and re-checked by
  the snapshot codec on the way out as well as on the way in.

### Withdrawal

`withdrawEvidence` retires a record; the derived entity and edge stop appearing in
the graph, `withdrawnCount` rises, and the projection says so. This is the
acceptance criterion "deleting source evidence cannot leave an unqualified live
fact behind", and it is checked by test: withdrawing the only evidence for an
entity removes it from the entity list and the graph, and the counts show it went
somewhere.

## The self-model

Seven compartments, and the whole point of the phase is that they do not mix.

| Compartment | Source | Freshness |
| --- | --- | --- |
| **identity** — stable self descriptors | the Brain's `IdentityRoot`, whose only constructor is module-private | durable |
| **role** — current role/state | `IdentityRoot.role`, plus a pointer saying security state is Guard's | durable descriptor, fresh pointer |
| **capabilities** — assigned by Core | `CAPABILITIES` and a live `Guard` evaluation | **read fresh every read, never stored** |
| **skills** — known by the Skills domain | the Skills projection | read fresh, never stored |
| **model identity** | the provider set Core was built with | read fresh, never stored |
| **worker claims** | Workforce's claim ledger | read fresh, never stored |
| **beliefs** — inferred associations | Phase 22 evidence with a non-owner source | durable |

The separations that matter, and why each one is structural rather than a
convention:

- **Capabilities are never stored here.** Guard evaluates capability on every
  command; a persisted copy would be a second, stale copy of the most
  security-relevant fact in the system, and Brain's `SelfDefinition` says exactly
  this in its own header. The self projection asks Guard on every read.
- **A capability name is not a capability.** `self.assignedCapabilities` reports
  what Guard answered *right now* for the owner principal, and it is derived from
  the closed `CAPABILITIES` vocabulary — so a claim in the world graph naming
  `security.stop` is a *belief*, and appears in `beliefs` with
  `confidence: 'low'`, never in `assignedCapabilities`.
- **Model identity is not authority.** `modelIdentity` reports provider id, kind
  and liveness. `cognition.allowed` names no provider precisely because
  authorisation happens before one is chosen, and nothing here reverses that.
- **Worker claims are claims.** Every entry in `workerClaims` carries the
  Workforce's own decision alongside it, and the projection states the rule in
  words: a claim is data. Workforce's decision table is `['refused']` today, so
  in practice every claim is reported refused — and the shape is built so that a
  future decision value cannot be misread as authority.
- **Nothing here mints or widens Guard authority.** `self.status.read` is a
  read. There is no command that writes a self-model field, `SelfStatus` is not an
  input to any authority type, and a red-team test asserts that evaluating Guard
  before and after a world write gives identical verdicts for every capability.

### The seven separations in one table

```
identity      durable    Brain IdentityRoot        cannot be written by evidence
role          durable    IdentityRoot.role         a descriptor, not an authorisation
capabilities  live       Guard + CAPABILITIES      never persisted, never inferred
skills        live       Skills projection         a procedure is not a permission
model         live       provider set              which provider answered is not who may ask
claims        live       Workforce claim ledger    data, always alongside its decision
beliefs       durable    world evidence            capped, never verified, never authority
```

## Persistence

**On the canonical encrypted Vault.** `PLAN.md` §4 makes one per-user SQLCipher
`freya.db` the canonical structured store, and §4.3 retires the bespoke per-domain
stores. This phase therefore has **no store of its own**: no encrypted world file,
no second database, no JSONL ledger, no plaintext fallback, no dual write, and no
model- or Freya-controlled migration.

What is durable is `world_evidence`, a versioned table added to the Vault by
migration 2, alongside `world_meta` for the non-secret high-water mark. One row per
admitted piece of evidence, in the same database and under the same key as Mission
content. The encryption is SQLCipher's page encryption under the one Vault key, so
the whole ledger is covered at once and there is no per-record authentication tag
to strip, forge or swap.

### Why this is a small change

The five-member `WorldPersistencePort` is the only thing in the phase that knows
how bytes are stored. The ontology, the identity rules, the admission rules, the
fold, the self model and the projection contract are written against the port, so
the storage decision moved underneath them and none of them had to change.

### The port

- `WorldPersistencePort` — five members: `mode`, `durable`, `durabilityReason`,
  `faultReason`, `load()`, `commit(snapshot)`, `close()`.
- `WorldSnapshot { v: 1, records, sequence }` — closed version constant. This is the
  *domain's* snapshot shape, not the schema version: the Vault's own schema version
  lives in SQLite's `user_version` and is code-owned and transactional.
- **One key, shared.** There is deliberately no `worldKey`. A second key for a second
  file is exactly what §4.3 retires. The consequence of one store is that world
  evidence is no longer one key-compromise away from Mission content; that is stated
  here rather than hidden.
- **No plaintext fallback.** With no Vault, the store is `ephemeral` and says so in a
  sentence: `durable: false` with a reason is honest; `durable: true` on a store that
  loses everything is a bug a person can never detect. The ephemeral store touches no
  filesystem at all.
- A ledger that cannot be believed **degrades**: reading stops at the first row that
  fails — unreadable row, unparseable nested claim, or a record the codec will not
  believe — and the store then serves nothing and writes nothing. Serving what parsed
  would make the world a function of what an attacker chose to damage; writing from a
  partial read would drop every record after the break, permanently and invisibly.
- A wrong key fails **earlier and harder**, at `Vault.open`: the database refuses to
  open at all, so no world code runs against a database nobody could read.

### Why the table is relational rather than a blob

`PLAN.md` allows a bounded migration slice to use the generic `vault_kv` table, which
is what the Mission store does. The world ledger is not a bounded slice of that shape:
its durable structure *is* relational. Replay order is a column, a withdrawal is a row
naming an older row, and a revision names the record it replaces. All three are
properties the fold and the withdrawal path depend on, and none of them survive being
packed into one opaque body. Every scalar the codec needs is a real column, so
validating a row never requires parsing JSON to decide whether it is legal; only the
three genuinely nested claims — entity, relation, withdrawal — are stored as canonical
JSON, and they are re-validated on read exactly like everything else.

### Two consequences worth stating plainly

- **A commit rewrites the retained ledger inside one transaction.** The retained set
  is bounded (1024 records by default) and *replaced* by the port's own contract, so
  full replacement is what makes eviction, withdrawal and revision leave no orphan row
  behind. A crash mid-commit leaves the previous ledger exactly as it was.
- **There is no `authority`, `capability`, `permission`, `grant` or `trust` column.**
  The `source` column records evidential provenance — who asserted a claim and how far
  they can be believed — and is assigned by Core from the admission channel, never read
  from the content. Nothing in the schema can express permission, so no row written
  through it can widen what Freya may do.

### Deterministic replay

For identical durable evidence and an identical supplied instant, the projection
is byte-identical:

- entity and edge ids are **content-derived**, so nothing depends on a counter, a
  clock or insertion order;
- records replay in `sequence` order;
- every list has a **total order** with an id tie-break;
- freshness is computed from record instants against an injected `now`, never
  read from the wall clock inside the domain.

## Limits

Every limit is a code-owned ceiling that a caller may only **lower**, with a
clamp that keeps the result self-consistent:

| Limit | Value | Why |
| --- | --- | --- |
| `maxEvidenceRecords` | 1024 | durable evidence is bounded and evictable, oldest first |
| `maxEntities` | 256 | a graph a person can look at |
| `maxEdges` | 512 | two edges per entity is a graph; 512 edges is a poster |
| `maxEdgesPerEntity` | 32 | one hub must not become the whole model |
| `maxAliasesPerEntity` | 4 | |
| `maxAttributesPerEntity` | 8 | keys only — values are never projected |
| `maxNameChars` | 80 | a label, not a document |
| `maxLiteralValueChars` | 120 | |
| `maxSourceRefChars` | 128 | an id, never content |
| `maxProjectionEntities` | 64 | what a window actually draws |
| `maxProjectionEdges` | 192 | |
| `maxConflictsListed` | 32 | |
| `maxBeliefsListed` | 16 | |
| `maxGraphDepth` | 2 | one hop of expansion from a selected entity |
| `freshnessHorizonMs` | 14 days | past this, a claim is `aging` |
| `staleAfterMs` | 90 days | past this, a claim is `stale` |
| `maxEntityDetailEdges` | 48 | the inspector's own bound |

Truncation is **explicit and never silent**. Every projection carries a
`retained / total / hidden` triple per population — the same shape as Work's
`runsRetained / runsTotal / runsHidden` and Missions' equivalent — so a viewer
that quietly stopped listing things would read as "they never existed", which is
precisely the false impression a bounded viewer is most likely to create.

## Privacy and what a projection may contain

A world projection may contain: **ids, closed labels, instants, counts, measured
lengths, and bounded canonical names.**

It may **never** contain: raw prompts, credentials, connector payloads, journal
contents, Brain memory bodies, Skill bodies, Mission content, or attribute
*values*. Concretely:

- `provenance.evidenceSummary` is stored but projected as `summaryLength` and
  `summaryPresent`. One sentence of owner prose is still the owner's prose.
- Attribute **keys** and `valueLength` are projected; values are not, in any view,
  ever. There is no "detail" view that unlocks them, because a view that unlocks
  them is a view a bug unlocks them from.
- Reference nodes carry **ids**, not titles. `MissionSummaryView` has no title and
  this phase does not go looking for one.
- `SENSITIVITY_RANK`-gated: evidence recorded at `sensitive` or
  `secret-reference` is **counted and never projected** — as an edge, as a node, and
  from the entity detail read, which answers as if the entity were not there. The fact
  that a credential exists is a legitimate thing to know; the credential is not, and the
  Brain says the same about `secret-reference`.
- **Untrusted literals are never rendered verbatim.** An owner-stated or
  system-observed value appears on the edge, because a typed edge cannot be drawn
  without it. A worker's, a model's or imported content's value appears as
  `literalValueLength` and `literalWithheld: true` — putting untrusted text in front of
  a person unchanged is how injected text becomes an instruction (C9).
- `stopAll`, grants, journal integrity and every other security state are **not**
  duplicated here. `self.status` carries a pointer saying who owns them.

STOP ALL, privacy and security boundaries are **stronger than** world-model
enrichment. Nothing in this phase can widen a Gate: there is no model call, no
provider and no authority object anywhere in `core/world/`, so there is nothing to
stop.

Concretely, and split deliberately:

- **Reads are never gated on STOP ALL.** Asking what Freya believes costs nothing and
  cannot act on the answer, and a stopped Core still owes the owner an honest answer.
- **Admission is gated on STOP ALL.** Nothing new may come to be believed while Freya
  cannot act on what she believes: a stopped Core that kept ingesting claims would
  accumulate a world it is not allowed to speak, and would then be one resume away
  from being confidently wrong about all of it. `stop_all_active`.

## Public projection contract

Five argument-free-or-narrowly-argumented reads, following the Skills/Workforce
convention: `health` first, `reason` when unhealthy, a frozen absent projection,
`sequence` so a window can prove it is current, and `retained/total/hidden`
wherever a listing is bounded.

| Command | Answers | Bounds |
| --- | --- | --- |
| `world.summary.read` | "what does she think she knows, and how sure is she?" | counts only |
| `world.entities.read` | the node list, filterable by kind | `maxProjectionEntities` |
| `world.entity.read` | the inspector for one entity: its edges, its conflicts, its provenance | `maxEntityDetailEdges`, `maxGraphDepth` |
| `world.relations.read` | nodes + typed edges for the graph view | `maxProjectionEntities`, `maxProjectionEdges` |
| `self.status.read` | the seven self compartments | `maxBeliefsListed` |

Capabilities: `world.status.read` for the five reads, `world.statement.submit`
for the two owner writes. Two, not one, and the split is the same one
`work.*`/`mission.*` and `skill.*` make. Neither appears in
`WORKER_CAPABILITIES`, so **no worker can read or write the world model at all** —
a worker principal is `trusted: false` and Guard refuses before it looks at
capabilities.

The only two write commands are `world.statement.submit` and
`world.statement.withdraw`, both owner-only through Guard, and both of which
route into Core's own admission. Everything else is read-only. The preload
command allowlist carries the five reads; the two writes are Core-internal and
`trusted Core only`, so a renderer cannot mint an entity, a relationship, an
identity, a capability, a trust level or a confidence even if it can reach IPC.

## Threat model

| # | Attack | Defence | Test |
| --- | --- | --- | --- |
| 1 | **Entity poisoning** — untrusted content names a person and asserts facts | channel→source table assigns the source; caps clamp confidence and epistemic; names that do not normalise are refused | `entity poisoning` |
| 2 | **Relationship forgery** — a worker claims `works_on` a Mission | admitted as `external-untrusted`, `low`, `asserted`; cannot reach `verified`; renders as a claim | `relationship forgery` |
| 3 | **Identity spoofing** — content claims Freya's identity or role | identity comes only from the Brain's module-private constructor; no evidence record can reach it | `identity spoofing` |
| 4 | **Capability escalation** — content or a worker claims a capability | capabilities are read live from Guard, never stored; the claim appears only as a capped belief | `capability escalation` |
| 5 | **Conflict** — two sources disagree | both kept, both `conflicted`, no winner chosen | `conflict handling` |
| 6 | **Stale evidence** — an old claim presented as current | freshness from instants + horizon; `stale`/`historical`/`aging` are distinct states | `stale evidence` |
| 7 | **Source withdrawal** — evidence deleted, fact survives | withdrawal retires the record and everything derived from it | `source withdrawal` |
| 8 | **Privacy leakage** — private content in a broad projection | ids/labels/instants/counts/lengths only; summary lengths, no attribute values, sensitivity gate | `privacy leakage` |
| 9 | **Replay tampering** — an edited or swapped row, a wrong key | SQLCipher page authentication at open; the codec re-validates every row and refuses the whole ledger on any fault; a faulted store writes nothing | `replay and tampering`, `a ledger this build will not believe fails closed` |
| 10 | **Determinism drift** — projection differs after restart | content-derived ids, total orders, injected clock | `replay and restart` |
| 11 | **Unbounded growth** — a flood of evidence | every population bounded, evictable, with explicit truncation counts | `boundedness` |
| 12 | **Idle model spend** — a projection triggers a call | no provider is reachable from `core/world/`; asserted with a counting provider | `zero idle calls` |
| 13 | **Renderer write** — a command invents an entity | writes are owner-only + Guard + Core admission; not in the renderer allowlist | `renderer cannot write` |
| 14 | **Domain drift** — a stale copy of Mission state in the graph | reference nodes read live from the owning domain every projection | `domain state is not duplicated` |

## Acceptance criteria

1. A future UI can render a real graph of only evidenced entities and
   relationships: nodes with kind, label and live state; typed, directed edges
   with provenance, epistemic status, confidence and freshness; conflicts shown
   as conflicts.
2. Restart reproduces the same world and self projection for the same durable
   evidence.
3. A forged worker, model or renderer claim cannot create authority, identity or a
   trusted relationship.
4. Conflicting, stale and unknown facts are represented honestly, and no conflict
   is silently resolved.
5. Deleting or withdrawing source evidence cannot leave an unqualified live fact
   behind.
6. The self model never conflates model provider, worker claims, skills or
   capability names with actual authority.
7. Broad projections contain no private or raw content.
8. Tests cover entity poisoning, relationship forgery, identity spoofing,
   capability escalation, conflict handling, stale evidence, source withdrawal,
   privacy leakage, replay/restart, boundedness and zero-idle calls.
9. Full project verification stays green.
10. The evidence ledger lives in the one canonical per-user SQLCipher Vault, as
    versioned tables under one code-owned key. There is no bespoke world file, no
    second database, no JSONL ledger, no plaintext fallback, no dual write and no
    Freya- or model-controlled migration. A Vault that cannot be opened leaves the
    world **empty and explicitly ephemeral**, never durable-looking and empty.

## Known limitation carried by this adaptation

**Binding selection is still blocked.** The Vault opens only when the host injects a
SQLCipher-capable binding, and none is named in committed source because the
permissive (non-copyleft) Windows audit has not completed. The consequence for this
phase is that the encryption proofs — raw-sentinel absence, wrong-key refusal, restart
replay — are **binding-gated** and skipped until a binding is selected. Everything that
does not require a live cipher runs unconditionally: the ontology, admission, fold,
self model, projection contract, the codec's re-validation in both directions,
withdrawal and revision persistence, retention and eviction, restart determinism over
the port, and the structural refusal to hold a second store. This lane stays
binding-agnostic on purpose; selecting a binding is a separate, audited decision that
`PLAN.md` §4 reserves.

## Still deferred

- **World UI.** This phase is the backend. `src/ui/surfaces/` gains a World
  surface when the projection is proven.
- **Phase 20 unified consciousness** and **Phase 21 autobiographical memory**.
  Neither is implemented here, and nothing in `core/world/` depends on either.
- **Entity merging.** Two names for one thing stay two entities until evidence of
  identity arrives. A fuzzy merge is how a poisoned entity gets adopted.
- **Device, file, service and account kinds**, until a real observation source
  exists to justify them.
- **`verified` evidence.** No pathway admits one in this phase. Making a claim
  verified needs a verification concept, not a flag.