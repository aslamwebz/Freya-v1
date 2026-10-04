# Phase 34 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Deterministic tests

### 1.1 Device identity

- Device ID generation is cryptographically random.
- Device key pair generation is correct.
- Device identity serialization/deserialization is correct.

### 1.2 Trust levels

- New devices are enrolled at `limited` trust level.
- Trust promotion requires owner approval.
- Trust demotion is immediate.
- Trust level enforcement is correct on all surfaces.

### 1.3 Enrollment

- Pairing flow completes successfully.
- Pairing flow rejects invalid signatures.
- Pairing flow rejects expired challenges.
- Pairing flow requires explicit owner approval.

### 1.4 Sync

- Sync completes successfully between two devices.
- Sync is end-to-end encrypted.
- Sync rejects revoked devices.
- Sync rejects untrusted devices.

### 1.5 Conflict resolution

- Concurrent edits to the same field are resolved by LWW.
- Concurrent edits to different fields do not conflict.
- Merge policy merges compatible changes.
- Conflict records are created for all conflicts.

### 1.6 Presence

- Lease acquisition succeeds.
- Lease renewal extends the expiration.
- Lease release removes the lease.
- Lease expiration marks the device offline.

### 1.7 Revocation

- Revocation marks the device as revoked.
- Revocation removes the device's presence lease.
- Revocation propagates to all other devices.
- Revoked devices cannot sync or issue/receive commands.

### 1.8 Audit

- All actions are journaled.
- Audit log verification succeeds for untampered logs.
- Audit log verification fails for tampered logs.

### 1.9 Remote commands

- Commands are authorized by the Guard.
- Commands are denied for insufficient capabilities.
- Commands are denied for insufficient trust levels.
- STOP ALL requires owner approval.

---

## 2. Red-team tests

### 2.1 Forged device identity

- A device cannot forge another device's identity.
- A device cannot forge the owner device's identity.

### 2.2 Authority escalation

- A limited device cannot promote itself to trusted.
- A trusted device cannot promote itself to owner.
- A device cannot bypass the Guard.

### 2.3 Sync tampering

- A device cannot tamper with sync data.
- A device cannot replay sync messages.
- A device cannot decrypt another device's sync data.

### 2.4 Command injection

- A device cannot inject commands without capability checks.
- A device cannot inject commands without proper authorization.
- A device cannot replay commands.

### 2.5 Lease manipulation

- A device cannot extend another device's lease.
- A device cannot acquire a lease with an expired timestamp.
- A device cannot renew a revoked device's lease.

### 2.6 Replay attacks

- Sync messages cannot be replayed.
- Command requests cannot be replayed.
- Enrollment requests cannot be replayed.

---

## 3. Continuity tests

### 3.1 Offline operation

- A device can operate offline.
- Queued changes are preserved offline.
- Queued changes are reconciled on reconnect.

### 3.2 Reconnect reconciliation

- Reconnect reconciliation completes successfully.
- Reconnect reconciliation resolves conflicts deterministically.
- Reconnect reconciliation is audited.

### 3.3 Split-brain recovery

- Split-brain recovery completes successfully.
- Split-brain recovery resolves conflicts deterministically.
- Split-brain recovery is audited.
