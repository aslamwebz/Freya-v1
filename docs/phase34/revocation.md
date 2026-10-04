# Phase 34 — Revocation

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Device revocation has immediate effect on sync and command surfaces.
Revoked devices cannot sync, receive commands, or issue commands.

---

## 2. Revocation flow

### 2.1 Revocation request

The owner device initiates a revocation by sending a revocation request
containing:
- The device ID to revoke.
- The reason for revocation.
- The owner device's signature.

### 2.2 Revocation execution

The Core:
1. Verifies the owner device's signature.
2. Marks the device as revoked.
3. Invalidates the device's keys.
4. Removes the device's presence lease.
5. Propagates the revocation to all other devices.
6. Journals the revocation in the audit log.

### 2.3 Revocation propagation

The revocation is propagated to all other devices via the sync channel.
Each device:
1. Receives the revocation.
2. Removes the revoked device from its sync and command surfaces.
3. Journals the revocation in its local audit log.

---

## 3. Revocation effects

### 3.1 Sync

A revoked device cannot sync. Its sync requests are rejected.

### 3.2 Remote commands

A revoked device cannot issue or receive remote commands. Its command
requests are rejected.

### 3.3 Presence

A revoked device's presence lease is immediately removed. The device is
marked as revoked.

### 3.4 Data

A revoked device's data is preserved in the Vault for audit purposes.
The data is not deleted.

---

## 4. Revocation reasons

Revocation reasons include:
- `owner-requested`: The owner requested the revocation.
- `compromised`: The device is suspected to be compromised.
- `stale`: The device has been inactive for an extended period.
- `manual`: The device was manually revoked.

---

## 5. Revocation reversal

Revocation is not reversible. A revoked device can be re-enrolled via a
new pairing flow, but the old device record is retained in the audit log.

---

## 6. Revocation security

### 6.1 Authentication

Revocation requests are authenticated with the owner device's key. Only
the owner device can revoke other devices.

### 6.2 Authorization

Revocation requests are authorized by the Guard. The Guard evaluates the
owner device's capabilities before allowing the revocation.

### 6.3 Auditability

All revocations are journaled in the audit log. The audit log is
tamper-evident and can be verified.
