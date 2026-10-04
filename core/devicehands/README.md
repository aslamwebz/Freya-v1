# Device Hands (Phase 35)

**Not wired into Core.** There is no import of this folder from `core/index.ts`, no host
adapter for any of the four surfaces, no protocol projection and no renderer surface. The
runtime is implemented and proved; it is *not* switched on, and nothing in it can switch
itself on.

This file is the short version. The long version, with the security reasoning, is
`PHASE-35.md` at the repository root.

---

## What this is

Four surfaces, each with a closed action vocabulary:

| surface | actions |
| --- | --- |
| `browser` | `navigate`, `read-text`, `click`, `type-text` |
| `terminal` | `run` |
| `clipboard` | `read`, `write`, `clear` |
| `transfer` | `download`, `upload` |

Every action walks ten gates before a port is reached, is journalled before it is
believed, and can only be called complete by a verifier that observed the result.

## What is deliberately absent

Read this list before adding anything; most of it is the design rather than an omission.

- **No capture.** No screen, window, display, page image or frame. There is no port
  method that could take one and no field whose type could carry one.
- **No physical world.** No camera, microphone, sensor, location, robot or smart-home
  surface. PLAN.md keeps the physical world as a separate, owner-designed phase.
- **No Vault, keyring or credential access.** Not as a policy that could be relaxed —
  there is no port method that resolves a *name* to a secret, and the Vault and keyring
  roots are *required* by the policy builder.
- **No authority port.** Nothing here takes or returns a capability, grant, permission or
  budget. A port that could be *asked* whether something is allowed would create a second
  answer to a question Guard already answers.
- **No timer.** No `setTimeout`, no interval, no self-wake. A phase that can run a
  terminal and drive a browser and cannot set a timer only ever acts when asked.
- **No cognition port.** Nothing here calls a model, and nothing here accepts model
  output as an instruction.

## Layout

```
types.ts        closed vocabularies, frozen ceilings, the absolute deny list   (data)
digest.ts       canonical digests binding an approval to one action body        (pure)
paths.ts        path + URL policy, and the surface policy builder              (pure)
commands.ts     terminal policy: allowlist, metacharacters, environment        (pure)
clipboard.ts    size, charset and credential-shape policy                      (pure)
transfer.ts     media allowlist, name/type agreement, size and path gating    (pure)
approvals.ts    approval reading, coverage, the owner's-only rule              (pure)
verification.ts observed vs reported, and the verdict that closes an action    (pure)
gates.ts        the ten-gate action pipeline and the four-gate probe pipeline   (pure)
machine.ts      state machines and the transition audit                        (pure)
state.ts        the fold — every fact derived from the journal                 (pure)
recovery.ts     what a restart is willing to claim                              (pure)
projection.ts   the explainable view, with no next-action field                 (pure)
probe.ts        the rule that a measurement is not a permission                 (pure)
ports.ts        the entire outside world. The omissions are the design.
runtime.ts      the only file that touches a port. Schedules nothing.
assertions.ts   structural audits. Not used by production code.
```

Every module marked *pure* has no clock, no randomness, no network, no `node:fs`, no
`node:path` (so no `process.cwd()`), no `globalThis` and no port access. That is enforced
by reading the source in `./assertions`, not by anybody's diligence — a check that is only
a comment eventually stops being true.

## The four properties worth knowing

1. **Fail closed.** An empty allowlist is a refusal, not "everywhere". A policy with no
   denied root is refused. A refused id is consumed. A tamper in the journal produces a
   visible anomaly, never a plausible repair.
2. **Deny outranks permit.** A path inside an allowed root is still refused when it is
   inside a denied root or contains a credential-store segment — in any direction, in any
   case, under any glob.
3. **A report is not an observation.** Every port outcome says whether it `observed` the
   result or merely `reported` it. Only `observed` closes an action, and only `passed`
   moves the byte ledger.
4. **A probe is a measurement.** Its result type has no field that could be a permission,
   its pipeline contains no gate that could grant one, and its port can only report
   availability.

## Testing

- `tests/core/devicehands/` — the runtime, the four boundaries, the gate order, the fold
  and the structural audits.
- `tests/red-team/devicehands/` — path escape, command injection, clipboard
  exfiltration, browser-as-camera, transfer abuse, approval bypass, STOP ALL bypass,
  authority widening, replay and restart.

Both harnesses cannot reach a disk, a browser, a process, a clipboard or the network: every
effect port counts its calls and returns a scripted answer, so a refusal is proved by a
counter that did not move.

## If you are integrating this

Read §11 of `PHASE-35.md`. The short version: fill the ports with real adapters that
report `observed` truthfully, feed the Vault and keyring roots in as `deniedRoots`, journal
every grant as well as reading it, route approvals to the owner and only to the owner, make
`append` durable, and call `open()` at startup. Every one of those steps narrows what the
phase can do.