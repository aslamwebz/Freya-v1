# Phase 34 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Core identity

- [ ] One Core identity spans multiple devices
- [ ] The Core identity is not duplicated or forked
- [ ] All devices present the same Core identity

---

## 2. Device identity

- [ ] Each device has a unique, cryptographically generated device ID
- [ ] Each device has its own key pair
- [ ] Device private keys never leave the device

---

## 3. Trust levels

- [ ] Devices are classified into trust tiers: owner, trusted, limited, untrusted
- [ ] Trust levels are enforced on all sync and command surfaces
- [ ] A paired device starts at limited trust level
- [ ] Trust promotion requires explicit owner approval
- [ ] Trust demotion is immediate

---

## 4. Enrollment

- [ ] New devices are enrolled via an explicit, owner-approved pairing flow
- [ ] The pairing flow uses challenge-response verification
- [ ] New devices are always enrolled at limited trust level
- [ ] Enrollment requires explicit owner approval

---

## 5. Sync

- [ ] All cross-device sync uses end-to-end encryption
- [ ] Sync rejects revoked devices
- [ ] Sync rejects untrusted devices
- [ ] Sync is authenticated and authorized

---

## 6. Conflict resolution

- [ ] Conflicts are resolved deterministically
- [ ] Conflict resolution uses vector clocks and LWW
- [ ] Conflict records are created for all conflicts
- [ ] Same state + same clock = same resolution

---

## 7. Offline continuity

- [ ] Devices can operate offline
- [ ] Queued changes are preserved offline
- [ ] Queued changes are reconciled on reconnect
- [ ] Reconnect reconciliation is deterministic and audited

---

## 8. Presence

- [ ] Presence leases expire deterministically
- [ ] Only devices with active leases can sync
- [ ] Only devices with active leases can issue/receive commands
- [ ] Lease expiration is journaled

---

## 9. Revocation

- [ ] Revocation has immediate effect
- [ ] Revoked devices cannot sync
- [ ] Revoked devices cannot issue/receive commands
- [ ] Revocation propagates to all other devices
- [ ] Revocation is journaled

---

## 10. Auditability

- [ ] All cross-device actions are journaled
- [ ] The audit log is tamper-evident
- [ ] The audit log can be verified
- [ ] The audit log is append-only

---

## 11. Remote commands

- [ ] Remote commands are capability-checked
- [ ] Remote commands are bounded
- [ ] Remote commands never bypass Guard, Governor, STOP ALL, approvals, or budgets
- [ ] STOP ALL requires owner approval
- [ ] All commands are audited

---

## 12. Authority preservation

- [ ] Guard is unchanged
- [ ] Governor is unchanged
- [ ] STOP ALL is unchanged
- [ ] Approvals are unchanged
- [ ] Budgets are unchanged
- [ ] No new authority is created

---

## 13. Scope

- [ ] No UI changes
- [ ] No Phase 35 scope creep (physical-world/IoT/robotics)
- [ ] No changes to PLAN.md
- [ ] No merge to main
