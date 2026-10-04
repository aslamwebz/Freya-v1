# Phase 35 — Device Hands

**Status:** RUNTIME IMPLEMENTED — FAIL-CLOSED / CORE ACTIVATION PENDING
**Branch:** `runtime/phase35-device-hands`
**Blocked on:** deliberate Core activation/integration only
**Required outcome:** owner-controlled browser control, terminal execution, clipboard
access and file transfer within explicit boundaries — with the Vault, the OS
keyring/credential stores, screen capture and the physical world **unreachable**, and
**no authority widening of any kind**

---

## 1. What this document is

This document accompanies the implemented Phase 35 Device Hands runtime. The four
surfaces are implemented: browser control, terminal execution, clipboard read/write and
download/upload. There is **no screenshot, no screen capture, no window or display
capture, no image capture, and no physical-world capability of any kind.**

Core does **not** activate the runtime. No `core/index.ts` path instantiates it, there
is no host adapter for any of the four surfaces, and nothing in it can switch itself on.
It is therefore fail-closed today: an implemented, fully tested runtime with no way to be
reached. This is an explicit activation boundary and it grants nothing.

### A note on the phase number

`PLAN.md` §Phase 35 currently reads "Physical World Interface — deferred/undefined; no
physical-world authority is added until the owner explicitly designs this phase". This
branch delivers **Device Hands**, and the physical world is *still* deferred — nothing
here touches a camera, a sensor, a robot or a smart-home device, and
`FORBIDDEN_DEVICE_HANDS_ACTIONS` refuses those actions by name. PLAN.md is **not
modified** by this branch. The naming divergence is recorded here rather than papered
over: whoever integrates this must either renumber the phase or amend PLAN.md
deliberately. This branch does not presume to make that decision.

---

## 2. The core invariant

> **Freya may drive a browser, a terminal, the clipboard and a file transfer — and can
> reach the Vault, the keyring, the screen, the camera or any other physical surface
> through none of them, by no sequence of requests, and without ever widening her own
> authority.**

The claim is worth nothing unless the code that *decides* those questions cannot perform
them. So the design is inverted relative to a "capability layer":

- the deny list is code-owned and **unremovable**;
- each surface has a **closed action vocabulary**, and the browser's contains no member
  capable of capture;
- the port surface has **no method and no field** that could carry an image, mint a
  capability, or read a credential;
- the pure policy modules have **no clock, no filesystem, no network and no port access**,
  and a structural audit fails the build if one grows any;
- there is **no timer anywhere**, so the phase cannot act when nobody is watching.

---

## 3. Scope — the four surfaces

| surface | actions | boundary |
| --- | --- | --- |
| `browser` | `navigate`, `read-text`, `click`, `type-text` | http/https only, host allowlist, no credentials in a URL, bounded selectors and typed text, **no capture of any kind** |
| `terminal` | `run` | command allowlist of bare program names, no shell ever, metacharacters refused anyway, bounded arguments, absolute paths in arguments judged by the path gate, environment **constructed** from an allowlist |
| `clipboard` | `read`, `write`, `clear` | explicit only (no watch, no poll), size-bounded, text-only, credential-shaped content neither returned nor recorded |
| `transfer` | `download`, `upload` | both ends path-gated, **both** endpoints URL-gated, name/type agreement, no images, no executables, per-action and per-session byte ceilings |

Two actions need no owner approval — `browser.navigate`, `browser.read-text` and
`transfer.download`. Everything else does, including every action whose consequence class
is `executes`. That list is derived and audited: **if an action that executes were ever
added to the exception list, the audit fails the build.**

---

## 4. What Phase 35 explicitly does NOT do

- Does **NOT** capture the screen, a window, a display, a page image or a frame
- Does **NOT** screenshot, render a PDF, or produce any image at all
- Does **NOT** touch the Vault, its backups, the keyring, the OS keychain, the secure
  store, or any browser profile, cookie store or credential file
- Does **NOT** read, write or inherit an environment variable the policy did not name,
  and refuses to *name* one that looks like a credential
- Does **NOT** read a camera, microphone, sensor, location, robot or smart-home device
- Does **NOT** mint, widen, revoke or clear any authority; it can only consult one
- Does **NOT** bypass or reimplement Guard, the Governor, STOP ALL, approvals or budgets
- Does **NOT** self-approve: only the owner's answer counts, and a decision reporting any
  other source is recorded as a denial
- Does **NOT** accept a report as evidence: a port that says "done" without observing
  the result yields `unverified`, never `completed`
- Does **NOT** journal clipboard content, page text, terminal output, argument values,
  environment values or file bytes
- Does **NOT** schedule itself, poll, or retry on a timer
- Does **NOT** call a model
- Does **NOT** add UI, a renderer surface, or a composition-root change
- Does **NOT** change PLAN.md

---

## 5. Architecture

```
core/devicehands/
  types.ts        closed vocabularies, frozen ceilings, the absolute deny list   (data)
  digest.ts       canonical digests for binding an approval to one body          (pure)
  paths.ts        path + URL policy, the surface policy builder                  (pure)
  commands.ts     terminal policy: allowlist, metacharacters, environment        (pure)
  clipboard.ts    size, charset and credential-shape policy                      (pure)
  transfer.ts     media allowlist, name/type agreement, size and path gating    (pure)
  approvals.ts    approval request reading, coverage, the owner's-only rule     (pure)
  verification.ts observed vs reported, and the verdict that closes an action   (pure)
  gates.ts        the ten-gate pipeline and the four-gate probe pipeline          (pure)
  machine.ts      state machines + the transition audit                          (pure)
  state.ts        the fold: every fact derived from the journal                  (pure)
  recovery.ts     what a restart is willing to claim                             (pure)
  projection.ts   the explainable view, with no next-action field                (pure)
  probe.ts        the rule that a measurement is not a permission                (pure)
  ports.ts        the entire outside world. The omissions are the design.
  runtime.ts      the only file that touches a port. Schedules nothing.
  assertions.ts   structural audits. Not used by production code.
  index.ts        the barrel
```

### The gate order

`DEVICE_HANDS_GATES` is walked with a `for` loop, so "no gate is ever skipped" is a
property of the iteration rather than of how carefully ten `if`s were written down:

1. `journal-trustworthy` — an unreadable record is not a place to start acting
2. `stop-all` — nothing runs, including the checks that would have said otherwise
3. `enabled` — the switch
4. `replay` — an id already used is refused *before* it can consume a budget slot
5. `surface` — is this a routable action, and does an untrusted claim name something forbidden
6. `grant` — a live grant, matching both what Core reports **and** what the journal holds
7. `deadline` — absolute, past-checked and ceiling-checked; never silently shortened
8. `budget` — action, transfer and byte ceilings
9. `policy` — the surface's own rules
10. `approval` — **last**, because Freya must never interrupt a person to authorise work
    it was never going to be allowed to do

The decision reports `evaluated` and `remaining`, which makes the ordering testable: a
request that passes evaluates all ten; one that fails gate *k* evaluates exactly 1..*k*
and names *k*.

### The execution order

```
all ten gates → STOP ALL read again → journal the start → one port → verify → journal the verdict
```

No port is reached before every gate has held. No effect is called complete before a
verifier has passed it. The verdict is journalled **before** the entry it authorises, so
a reader going forward meets the evidence first.

---

## 6. Security boundaries, in the order they are checked

### 6.1 Paths — deny first, then malformed, then allowlist

- Absolute-only: no process working directory is ever consulted, so a security decision
  cannot depend on an ambient value.
- `..` is **refused, not resolved**. A path that asked to climb out has already said
  something.
- Denial outranks permission: a path inside an allowed root is still refused if it is
  inside a denied root or contains a credential-store segment.
- Denials match case-insensitively (Windows is case-insensitive); **permissions match
  exactly**, so escaping an allowlist by changing case is impossible.
- Credential stores are refused *by segment name and by pattern*, wherever they appear:
  `.ssh`, `.gnupg`, `.aws`, `.kube`, `.npmrc`, `.netrc`, `.git-credentials`, `.env`,
  `Credentials`, `cookies.sqlite`, `Login Data`, `key4.db`, `freya.keyring.json`, and the
  patterns `*vault*`, `*keyring*`, `*credential*`, `*secret*`, `*.key`, `*.pem`, `*.p12`,
  `*.pfx`, `*.kdbx`, `*private*key*`, `.env.*`.
- The over-matching is deliberate and documented: `/vault-notes` is refused. The cost is
  one refused path; the benefit is that a vault export called `vault-export-2026.zip`
  cannot slip past a rule that matched only the exact name.
- UNC paths and `\\?\` device paths are refused: their targets are opaque.
- NUL and control characters are refused, so a path cannot be split into "the part this
  gate checked" and "the part the OS sees".

The Vault and keyring roots are **required** by the policy builder. A policy that arrives
without them is refused rather than treated as a policy with no protection.

### 6.2 URLs

`http:` and `https:` only. `file:`, `data:`, `javascript:`, `blob:`, `view-source:`,
`chrome:` and `devtools:` are all absent from the scheme table. A URL carrying a
username or password is refused **rather than stripped**, because stripping it would hide
that somebody sent one. The same gate is applied to both directions of a transfer.

### 6.3 Terminal

- The allowlist holds **bare program names**: no separator, no directory, no drive.
- **No shell, ever.** The port is typed to spawn a program with an argument vector.
- Metacharacters are refused anyway — harmless without a shell, so refusing them costs
  nothing, and if a port is ever changed to use `sh -c` this module already refuses every
  input that would have been exploitable.
- Argument-injection vectors are refused by name: `--upload-pack`, `--receive-pack`,
  `-up`, `--exec`, `-e`, `core.gitProxy`, `ProxyCommand`, `sshCommand`, `--config-env`,
  `--output`. These ask the *program* to run another program, which is not something a
  shell defence covers.
- **An absolute path in an argument is judged by the same `checkPath` as a download**, so
  an argument cannot reach a directory an explicit path request could not.
- The environment is **constructed, never inherited**: only names on the policy's
  allowlist may be set, and that list was checked against credential deny-words when the
  policy was read, so a policy cannot opt `AWS_SECRET_ACCESS_KEY` in.
- The working directory is required — the program is not allowed to choose one.

### 6.4 Clipboard

- Explicit only: no watch, no poll, no change listener, no mirror.
- Bounded at 8 KiB; binary refused (tab, newline and carriage return are text; anything
  else below 32 is not).
- Credential-shaped content is refused in **both** directions, and the refusal names the
  *shape* rather than the content: a PEM private key block, a JWT, an AWS key id, a
  GitHub token, an OpenAI-style secret, a URL with a password, a secret-shaped
  assignment, a card number, a long unlabelled run.
- When refused on a read, the journal records **only** the direction and the byte count.
  The content is dropped at the boundary and never becomes an observation.
- A read may not be supplied text: otherwise the audit would be about what the caller
  asked for rather than what was on the clipboard.

### 6.5 Transfer

- Both ends gated: a download's destination *and* an upload's source go through
  `checkPath`. Both endpoints gated by `checkUrl`.
- The media allowlist contains **no image type at all** — a stronger statement than "images
  are allowed but screenshots are not". With no image type, there is no media type a
  captured frame could declare.
- Executables refused by name *and* unreachable by type: `.exe`, `.dll`, `.sh`, `.bat`,
  `.ps1`, `.app`, `.js`, `.jar`, `.pem`, `.env`, `.db` and twenty more.
- Credential files refused **by whole name** as well as by extension, because the
  dangerous ones are dot-leading (`.env` has no extension at all to an extension rule).
- Name and type must agree, and `fileName` may not contain a separator or a traversal
  segment — the directory comes from the checked path, never from the name.
- Size bounded per action and cumulatively per session, **checked at the gate** rather
  than discovered halfway through a response.
- Reserved device names (`CON`, `LPT1`, …) refused.

### 6.6 Grants, approvals, STOP ALL

- A grant must come from Core **and** be in the journal, and both must agree on id,
  principal, scope, revocation, expiry, surfaces and actions. A disagreement is
  `grant-missing` — the safe direction, because the alternative is believing one of two
  records that contradict each other.
- A grant is a **list of action keys** with no wildcard and no "everything on this
  surface", every key checked against the routable vocabulary, every key's surface
  checked against the grant's own surface list, and its window refused if longer than
  fifteen minutes.
- An approval is bound to a digest of the **normalised action body**, computed by the
  same function the gate will use. `actionId` is inside the digest, so an approval cannot
  be replayed under a second id even for an identical body.
- A decision reporting anything but `owner` is recorded as a **denial**.
- An approval request carries no `reasoning` field: a person is being asked to authorise
  running a program or moving a file, and a generated justification in that position is
  the persuasion problem this phase exists to avoid.
- STOP ALL is read twice — at the gate and again immediately before the effect — and
  again when the outcome is judged. A check that happened "recently" is a check that can
  be wrong.

---

## 7. Probing: a measurement is not a permission

> A test may verify a candidate capability. A successful probe may not itself grant
> broader authority.

Enforced in four places, because a promise held in a comment is not a property:

1. **The result type has no field that could be a grant.** `DeviceHandsProbeOutcome` is
   `{probeId, surface, available, code, probedAt}`. There is no `granted`, no
   `capabilityId`, no `scope`, no `expiresAt`.
2. **The probe pipeline is a different, shorter list** — four gates, with no grant gate,
   no approval gate and no budget gate. Nothing in it *could* produce authority.
3. **The port can only report availability.** `probeSurface` returns `{available, code}`.
   There is no port method that issues a grant, so a probe cannot ask for one by accident.
4. **The recorded entry is an observation.** The fold has no case that could mutate a
   grant, and the journal audit fails if a probe entry carries an authority-shaped key.

A probe is *available to a caller holding no capability at all* — "does this machine have
a clipboard?" is exactly the question somebody asks before they have any authority. And
after a successful probe the caller still holds nothing, which the red-team suite proves
by probing and then being refused.

---

## 8. Replay, idempotence, restart

- **Replay.** An id already used is refused at the `replay` gate, *before* it can consume
  a budget slot. A **refused** id is consumed too — a refusal cannot be laundered into a
  second attempt under the same id. The fold refuses a second `action.started` for one id
  as a `duplicate-record` anomaly.
- **Restart truthfulness.** An action that was `running` when the process ended is
  **unknown**. It is never reported as completed (nothing on the record supports it) and
  never as failed (that is also a claim, and a claim that a half-finished download
  *failed* is how a duplicate gets created on retry). It is reconciled as `interrupted`,
  treated as **not done** everywhere downstream, and journalled so the fact survives the
  process rather than living in a comment.
- **Untrustworthy journal.** Refuses to open. "We fixed what we could on startup" is how a
  system ends up running on a record nobody has read.
- **Policy continuity.** The policy digest is on the record and is compared at every gate.
  A journal that recorded one policy and is handed another is `policy-mismatch`, and a
  policy may be **set once**. A restart cannot come back wider than the record.

---

## 9. Audit and the journal

Every consequential step is journalled before it is believed, and the fold is
deliberately untrusting of its own input. For every entry it checks the type, rejects any
key outside the published per-event table, rejects any key shaped like authority or like
a capture, enforces a text ceiling on every string value, checks every state change
against a table, and bounds every collection.

**What it never does is repair.** A tampered journal produces a *visible* wrong answer
with the wrongness named in `anomalies`, never a quietly plausible one — because the one
thing an action journal must not be is a source of confident fiction about what this
machine has already done.

Note the naming: the verifier's answer is journalled as `result`, and a payload key called
`verdict` is **refused by name**. A journal entry may not carry its own conclusion.

---

## 10. Verification

`npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e`,
plus `npm run test:redteam` and `npm run release:check`. Exact counts are in the
integration report for this branch.

> **Environment note, recorded honestly.** In the shell this branch was built in,
> `npm run <script>` returns exit code 1 even when the underlying tool exits 0 — verified
> against a clean stashed tree, where `npm run build`, `npm run typecheck`, `npm run lint`
> and `npm run test` *all* returned 1 while `npx tsc`, `npx eslint .`, `npx vite build` and
> `npx vitest run` returned 0. Every figure below therefore comes from the underlying tool
> invoked directly. The desktop e2e is also **pre-existing flaky**: one run in four drops a
> presence backing-store timing check or a Work-board verification race, on this branch and
> on the clean tree alike.

| suite | tests | what it is for |
| --- | --- | --- |
| `tests/core/devicehands/runtime.test.ts` | 26 | the runtime end to end, with effect counters on every verdict |
| `tests/core/devicehands/policy.test.ts` | 45 | the four boundaries on their own: paths, URLs, commands, clipboard, transfers, policy construction |
| `tests/core/devicehands/gates.test.ts` | 41 | every gate, driven one at a time, with `evaluated`/`remaining` proving the order |
| `tests/core/devicehands/journal.test.ts` | 28 | the fold, tamper cases, machines, recovery truthfulness |
| `tests/core/devicehands/structure.test.ts` | 99 | structural audits: no clock, no timer, no capture, no authority minter, no image field |
| **Phase 35 core total** | **239** | across 5 files |
| `tests/red-team/devicehands/paths-and-terminals.test.ts` | 69 | path escape, command injection, clipboard exfiltration, browser-as-camera, replay |
| `tests/red-team/devicehands/authority.test.ts` | 41 | transfer abuse, approval bypass, STOP ALL bypass, authority widening, budget abuse |
| **Phase 35 red-team total** | **110** | across 2 files |

Repository-wide on this branch: **320 test files, 6538 tests**, of which 349 are Phase 35.
Red-team suite as a whole: **64 files, 1069 tests**. Desktop e2e: **216/216 checks**.
`node scripts/release-check.mjs`: passed, all five artifact budgets inside their limits.

---

## 11. Activation: what Core integration would still have to supply

The runtime is deliberately inert. To reach it, Core would have to:

1. Fill `DeviceHandsPorts` with real host adapters — a browser adapter, a process runner,
   a clipboard adapter and a transfer adapter. Each is an *effect*, and each must honour
   `evidence: 'observed'` truthfully: an adapter that reports success without checking the
   result will produce `unverified`, which is the correct outcome and not a bug to work
   around.
2. Set `journalTrustworthy()` from the journal's own integrity story, and `enabled()` from
   an owner-controlled switch.
3. Feed the Vault and keyring roots into `loadPolicy` as `deniedRoots`. **This is not
   optional**: `normaliseSurfacePolicy` refuses a policy with no denied root.
4. Read grants from the Guard/Governor through `activeGrant` *and* journal them through
   `registerGrant`. Both must agree or every action is refused.
5. Route `requestOwnerApproval` to the owner, and only to the owner.
6. Persist `append` durably. A refused append must fail loudly.
7. Call `open()` at startup and let `recovery()` be shown to the owner.

None of these steps widens authority: each of them *narrows* what the phase can do, and
the phase cannot act at all until all of them are done.

---

## 12. Known limits, stated honestly

- **The ports are the trust boundary.** This phase refuses the Vault, the keyring and the
  credential stores by *policy*; a host adapter that ignored its inputs could do
  otherwise. The defence is depth — the adapters are Core's, the policy is journalled and
  digest-checked, and every path handed to a port has already passed `checkPath` — but the
  residual risk is real and belongs in this document rather than in a comment.
- **Cancellation is honoured at settle, not preempted.** The phase does not own the
  process it started and cannot interrupt it. A cancellation means "whatever comes back is
  recorded as cancelled, not as done". Claiming to interrupt the port would be the worst
  available lie: a person who pressed stop and was told it stopped.
- **`DENIED_PATH_SEGMENT_PATTERNS` over-matches on purpose.** `*vault*` refuses
  `/vault-notes`. Documented above, asserted in a test, and the direction is chosen.
- **The phase number conflicts with PLAN.md**, as noted in §1. Unresolved by design on
  this branch.
- **No UI, no renderer surface, no protocol projection.** The Hands protocol projection
  in `core/protocol/hands.ts` is unchanged; this phase does not extend it.