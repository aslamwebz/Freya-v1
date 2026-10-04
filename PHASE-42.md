# Phase 42 — Device Hands Activation

**Status:** HOST ACTIVATION IMPLEMENTED — FAIL-CLOSED BY DEFAULT
**Branch:** `runtime/phase42-device-hands-activation`
**Baseline:** `main` @ `6841e73` (Phase 35 runtime, provider security, App Mode/UI merge)
**Required outcome:** give Phase 35 Device Hands real host adapters and an explicit,
bounded activation while preserving every Phase 35 fail-closed guarantee.

---

## 1. What this document is

Phase 35 shipped a complete, proved, **inert** Device Hands runtime: ten gates, a fold
that derives every fact from a journal, four pure surface policies, and an explicit
"Core integration would still have to supply" list (`PHASE-35.md` §11). Nothing reached
it.

Phase 42 is that integration, done in the **Electron main process**. It adds the real
operating-system adapters, a durable hash-chained journal, an explicit
activate/deactivate lifecycle, and a narrow authority seam — without editing
`core/index.ts`, without a renderer surface, and without changing a single Phase 35
policy. The runtime is still the same code with the same gates; Phase 42 only fills its
ports.

The activation is **off unless the main process is deliberately opted in** with
`FREYA_DEVICE_HANDS=1`. A build that was not opted in has no Device Hands runtime at
all, so the Phase 35 fail-closed posture is the default and remains the safe reading of
every ordinary launch.

---

## 2. What became truly active

| surface | action | status | how it is bounded |
| --- | --- | --- | --- |
| `browser` | `navigate` | **active** | https + host allowlist; the sandboxed, script-free, non-persistent managed target |
| `browser` | `read-text` | **active** | same target; text only, no capture port exists |
| `browser` | `click` | **blocked** | needs a scriptable live page; refused `browser-action-unsupported` |
| `browser` | `type-text` | **blocked** | same reason; refused `browser-action-unsupported` |
| `terminal` | `run` | **active** | `spawn` with `shell: false`, bare allowlisted program, constructed env, path-gated arguments, deadline kill, output byte cap |
| `clipboard` | `read` | **active** | explicit only, text only, bounded, credential-shaped content refused at the boundary |
| `clipboard` | `write` | **active** | same refusal, read-back observation |
| `clipboard` | `clear` | **active** | read-back observation |
| `transfer` | `download` | **active** | pinned public-address GET, no redirects, media/name/size agreement, path-gated destination, file-size observation |
| `transfer` | `upload` | **active** | pinned public-address POST, no redirects, source size checked, 2xx receipt observed |

"Active" here means the adapter is real and the runtime will perform the action when —
and only when — the owner has switched the phase on **and** a live, policy-authorized
grant covers it. In the default build none of that holds, so every row is refused.

Two browser actions are **blocked truthfully**, not faked: a click or a keystroke needs
a live page that executes its own scripts, and handing a background runtime a scriptable
browsing context is authority Phase 35 deliberately does not grant. They are named in
`DEVICE_HANDS_BLOCKED_ACTIONS` with their exact reason, still gate-checked, and still
journalled as refusals when attempted.

---

## 3. The host adapters added

All under `electron/devicehands/`, all main-process only:

- `journal.ts` — `openDeviceHandsJournal`: durable, append-only, **hash-chained** JSONL.
  Every line carries the previous line's digest; an edited line stops the chain and the
  whole record reports untrustworthy, at which point the runtime refuses to open.
- `effects.ts` — the six bounded effects with **injected primitives**, so a refusal is
  proved by a counter that did not move and an effect by the same counter moving once.
  No capture, no credential port, no physical-world method, no authority method.
- `activation.ts` — `createDeviceHandsActivation`: builds the full `DeviceHandsPorts`,
  loads the policy, registers Core-authorized grants, and switches on. `deactivate()`
  flips the owner switch, which refuses the next action at the `enabled` gate before any
  port is reached. Also exports the honest blocked-action registry and `denyAllAuthority`.
- `electronEffects.ts` — the production primitives: Electron's clipboard, Node's
  `spawn` with `shell: false`, the Phase 5 sandboxed managed browser, and the pinned
  `SafeHttpTransport` (download) plus a pinned POST (upload). `resolveExecutableOnPath`
  resolves a bare program and never passes `PATH` to the child.

Wiring:

- `electron/coreHost.ts` — a new optional `deviceHands` seam on `CoreHostOptions`,
  built at `start()` and released at `stop()`/`reconfigure()`. **Core's own STOP ALL
  latch is composed on top of the supplied authority**, so the latch always wins.
- `electron/main.ts` — `buildDeviceHandsSeam()`, gated on `FREYA_DEVICE_HANDS=1`. It
  assembles the surface policy from the environment, reads owner-authored grants from
  `device-hands.grants.json`, journals to `device-hands.jsonl`, and denies every owner
  approval.

---

## 4. Grants, approval and budget semantics

Unchanged from Phase 35, because Phase 42 supplies ports and not policy:

- **Grant.** A grant must come from Core *and* be on the journal, and both must agree on
  id, principal, scope, revocation, expiry, surfaces and actions. A grant is a closed
  list of action keys with no wildcard, TTL ≤ 15 minutes, every key in the routable
  vocabulary. Phase 42 never mints one: the authority *reports* what Core policy
  authorized, and `main.ts` reads an owner-authored file rather than creating one.
- **Approval.** Bound to the canonical digest of the normalised action body; only an
  `owner` decision counts. The production authority **denies every approval**, because
  there is no Core-owned owner-approval channel in this architecture. That means only
  the three actions Phase 35 exempts from approval — `browser.navigate`,
  `browser.read-text`, `transfer.download` — can run; everything else is refused at the
  approval gate. This is the fail-closed reading, and it is the honest one.
- **STOP ALL.** Read at the gate, again immediately before the effect, and again when
  the outcome is judged. Core's latch is OR-ed with the host authority, so the host
  cannot report "not stopped" over a latched Core.
- **Budget.** All Phase 35 ceilings are enforced unchanged: 128 actions/session, 32
  transfers/session, 1 MiB/transfer, 5 MiB/session, 8 KiB clipboard, 8 args/command,
  512 bytes/arg, 512 bytes typed, 60 s/action, 15 min/grant.
- **Evidence.** A port that reports success without observing the result yields
  `unverified`, never complete. The adapters observe what they can: a process exit, a
  clipboard read-back, a written file's size, a server's 2xx.

---

## 5. What Phase 42 does not do

- No screen capture, screenshot, window image, camera, microphone, sensor or IoT.
- No Vault, keyring or credential-store access. The policy's denied roots include the
  Vault directory; the credential-store segment and pattern refusals are unchanged.
- No unrestricted shell: `shell: false`, no metacharacter reaches `spawn`, and the child
  environment is the constructed one.
- No arbitrary filesystem access: every path passes `checkPath` before a port is called.
- No automatic grant creation, no hidden permission widening, no background polling.
- No renderer surface, no protocol change, no UI redesign.
- No edit to `core/index.ts`, `core/devicehands/**`, `ui/alpha-vault`, P40 or P41.

---

## 6. Verification

All figures from the underlying tools invoked directly:

| check | result |
| --- | --- |
| `tsc -p tsconfig.json` / `tsconfig.electron.json` / `tsconfig.core.json` | clean |
| `eslint .` | clean |
| `vitest run tests/core/devicehands tests/red-team/devicehands tests/host/devicehands` | **400 passed** (239 core + 110 red-team + 51 host) |
| `vitest run` (full suite) | **347 files, 6967 tests passed** |
| `vitest run tests/red-team` | **67 files, 1199 tests passed** |
| `vite build` + `build-electron.mjs` | built |
| `release-check.mjs` | **passed** (budgets below) |
| desktop e2e | **216/216 checks passed** |

The `mainBytes` and `rendererTotalBytes` budgets in `scripts/release-policy.mjs` were
raised with a comment: the Device Hands runtime is now bundled into `main.cjs`
(~1.99 MB), and the App Mode/persistent-board merge had already pushed the renderer to
~3.57 MB at branch creation. The host stays unminified on purpose so its
security-critical source is auditable in the shipped artifact.

---

## 7. Unresolved seams, stated honestly

1. **No Core-owned Device Hands grant minter or owner-approval channel.** This is the
   one real gap. The runtime's grant gate is satisfied by an owner-authored file and
   its approval gate denies, so only the three approval-free actions can run. Wiring a
   real owner-approval channel is a renderer/IPC surface this phase did not build, and
   a Core grant minter would be a Core change this phase deliberately avoided.
2. **`browser.click` and `browser.type-text` are blocked**, because a safe host
   implementation needs a scriptable page that this architecture will not run.
3. **Production default is off.** `FREYA_DEVICE_HANDS` must be set, a policy supplied,
   and an owner-authored grant present before anything runs. That is the intended
   posture, not a defect.
4. **Deactivation halts, it does not preempt.** An effect already in flight settles;
   Phase 35's own `cancel` semantics are unchanged.

---

## 8. Safe-to-integrate verdict

**Safe to integrate, with the seams above stated rather than hidden.** The activation
adds real adapters behind the unchanged Phase 35 gates, composes Core's STOP ALL so it
always wins, keeps the default fail-closed, refuses the two browser actions it cannot
run safely, and proves all of it with 51 new host tests on top of the untouched 349
Phase 35 tests. No authority is widened, no grant is auto-created, no capture or
credential path exists, and nothing reaches a renderer.
