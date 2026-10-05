# Phase 34 — Multi-Device Freya

**Status:** PREPARATION ONLY — NOT PRODUCTION  
**Branch:** `runtime/phase34-multidevice`  
**Base:** `6464b62` (canonical main)  
**Required outcome:** one Freya Core identity spanning trusted desktop/laptop/phone/server clients with secure enrollment, bounded sync, and no authority widening

---

## 1. What this document is

This is a **preparation specification** for Phase 34. It defines the architecture,
interfaces, device identity/trust model, enrollment/pairing, encrypted sync,
conflict handling, offline continuity, presence/leases, revocation, auditability,
and bounded remote commands for Multi-Device Freya. It does **not** implement
production runtime behavior.

**Phase 34 cannot start until the spec is reviewed and approved.** This branch
exists so that when the gate passes, implementation can begin immediately.

---

## 2. The core invariant

> **One Freya Core identity spans multiple trusted devices. A paired device
> never automatically inherits unrestricted owner authority. Every device
> operates within its own trust level, and all cross-device actions flow
> through the existing Guard, Governor, STOP ALL, approval, and budget paths.**

Multi-Device Freya extends the single-device canonical architecture to span
multiple devices. It does **not** widen the authority boundaries established
by Guard, Governor, STOP ALL, approvals and budgets. It decides *what to
sync, when to sync, and how to resolve conflicts*, but every consequential
action still flows through the existing authority paths.

---

## 3. Scope

Phase 34 delivers:

1. **One Core identity** — a single Freya Core identity (the `FreyaIdentity`
   from `core/identity/`) is shared across all trusted devices
2. **Device identity** — each device has a unique, cryptographically generated
   device ID and key pair
3. **Trust levels** — devices are classified into trust tiers: `owner`,
   `trusted`, `limited`, `untrusted`
4. **Secure enrollment/pairing** — new devices are enrolled via an explicit,
   owner-approved pairing flow with challenge-response verification
5. **Encrypted synchronization** — all cross-device sync uses end-to-end
   encryption with per-device keys
6. **Conflict handling** — deterministic conflict resolution using vector
   clocks and last-writer-wins with explicit conflict records
7. **Offline/reconnect continuity** — devices can operate offline and
   reconcile on reconnect without data loss
8. **Presence/leases** — devices maintain presence with bounded leases that
   expire deterministically
9. **Revocation** — devices can be revoked, with immediate effect on sync
   and command surfaces
10. **Auditability** — all cross-device actions are journaled with
    tamper-evident audit records
11. **Bounded remote commands** — devices can issue bounded, capability-
    checked remote commands that never bypass Guard/Governor/STOP ALL

---

## 4. What Phase 34 explicitly does NOT do

- Does NOT add physical-world/IoT/robotics control (Phase 35)
- Does NOT add autonomous browser/terminal permissions
- Does NOT add spending authority
- Does NOT add unrestricted loops
- Does NOT add hidden model calls
- Does NOT add durable stores outside Vault
- Does NOT add any new authority
- Does NOT bypass Guard, Governor, STOP ALL, approvals or budgets
- Does NOT change PLAN.md
- Does NOT merge to main
- Does NOT bypass the integration gate
- Does NOT add real-money/economic actions
- Does NOT add UI branch touches
- Does NOT add continuous background reasoning
- Does NOT add self-scheduling timers
- Does NOT allow a paired device to inherit owner authority
- Does NOT allow cross-device command execution without capability checks
- Does NOT add network-facing attack surfaces without explicit audit

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                    Freya Core Identity                   │
│              (one identity, shared across devices)        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Desktop  │  │  Laptop  │  │  Phone   │  │ Server │ │
│  │ (owner)  │  │(trusted) │  │(limited) │  │(trusted)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │              │              │      │
│       └──────────────┴──────────────┴──────────────┘      │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              │   Sync / Replication   │                    │
│              │  (E2E encrypted)      │                    │
│              └───────────┬───────────┘                    │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              │   Conflict Resolution  │                    │
│              │  (vector clocks, LWW)  │                    │
│              └───────────┬───────────┘                    │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              │   Presence / Leases    │                    │
│              └───────────┬───────────┘                    │
│                          │                                │
│              ┌───────────┴───────────┐                    │
│              │   Audit Journal        │                    │
│              └───────────────────────┘                    │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  Guard │ Governor │ STOP ALL │ Approvals │ Budgets       │
│  (unchanged — all authority flows through existing paths) │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Trust levels

| Level | Capabilities | Can sync | Can receive commands | Can issue commands |
|-------|-------------|----------|---------------------|-------------------|
| `owner` | Full owner authority | Yes | Yes | Yes (bounded) |
| `trusted` | Standard worker authority | Yes | Yes | Yes (bounded) |
| `limited` | Read-only sync, no command issuance | Yes (read-only) | No | No |
| `untrusted` | No sync, no commands | No | No | No |

**Critical rule:** A paired device starts at `limited` and must be explicitly
promoted by the owner device. Promotion requires owner approval and is
journaled. Demotion is immediate and does not require approval.

---

## 7. Authority preservation

The multi-device subsystem cannot:
- Create grants
- Widen budgets
- Bypass Guard
- Override Governor
- Clear STOP ALL
- Approve its own requests
- Add real-money/economic actions
- Promote a device to `owner` without explicit owner approval
- Execute remote commands without capability checks
- Sync data outside the encrypted channel

---

## 8. Test plan summary

1. **Deterministic tests** — device enrollment, trust promotion/demotion,
   sync, conflict resolution, presence expiry, revocation
2. **Red-team tests** — forged device identity, authority escalation,
   sync tampering, command injection, replay attacks, lease manipulation
3. **Continuity tests** — offline operation, reconnect reconciliation,
   split-brain recovery

---

## 9. Acceptance criteria summary

- [ ] One Core identity spans multiple devices
- [ ] Device enrollment requires explicit owner approval
- [ ] Trust levels are enforced on all sync and command surfaces
- [ ] A paired device never inherits unrestricted owner authority
- [ ] All sync is end-to-end encrypted
- [ ] Conflicts are resolved deterministically
- [ ] Offline operation and reconnect reconciliation work correctly
- [ ] Presence leases expire deterministically
- [ ] Revocation has immediate effect
- [ ] All cross-device actions are audited
- [ ] Remote commands are bounded and capability-checked
- [ ] Guard, Governor, STOP ALL, approvals, and budgets are unchanged
- [ ] No UI changes
- [ ] No Phase 35 scope creep

---

## 10. Document index

- `docs/phase34/architecture.md` — detailed architecture specification
- `docs/phase34/interfaces.md` — TypeScript interfaces and type definitions
- `docs/phase34/device-identity.md` — device identity and trust model
- `docs/phase34/enrollment.md` — enrollment and pairing protocol
- `docs/phase34/sync.md` — encrypted synchronization and replication
- `docs/phase34/conflicts.md` — conflict handling
- `docs/phase34/presence.md` — presence and leases
- `docs/phase34/revocation.md` — revocation
- `docs/phase34/audit.md` — auditability
- `docs/phase34/remote-commands.md` — bounded remote commands
- `docs/phase34/test-plan.md` — test plan
- `docs/phase34/red-team-cases.md` — red-team cases
- `docs/phase34/acceptance-criteria.md` — acceptance criteria
- `docs/phase34/dependency-map.md` — dependency map
