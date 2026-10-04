# Phase 34 — Auditability

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

All cross-device actions are journaled with tamper-evident audit records.
The audit log is append-only and can be verified for integrity.

---

## 2. Audit record

Each audit record includes:
- A unique ID.
- A timestamp.
- The device ID that performed the action.
- The action type.
- Action-specific details.
- A tamper-evident hash.
- The previous record's hash (for chain integrity).

---

## 3. Audit actions

The following actions are journaled:
- `device-enrolled`: A new device was enrolled.
- `device-revoked`: A device was revoked.
- `trust-promoted`: A device's trust level was promoted.
- `trust-demoted`: A device's trust level was demoted.
- `sync-started`: A sync operation started.
- `sync-completed`: A sync operation completed.
- `sync-conflict`: A sync conflict was detected and resolved.
- `command-issued`: A remote command was issued.
- `command-executed`: A remote command was executed.
- `command-denied`: A remote command was denied.
- `presence-acquired`: A presence lease was acquired.
- `presence-expired`: A presence lease expired.
- `presence-renewed`: A presence lease was renewed.

---

## 4. Tamper-evident hash chain

Each audit record includes a hash of its contents and the previous record's
hash. This creates a tamper-evident chain:

```
hash_n = H(record_n || hash_{n-1})
```

Where `H` is a cryptographic hash function (SHA-256).

---

## 5. Audit log verification

The audit log can be verified by:
1. Recomputing each record's hash.
2. Checking that each record's hash matches the stored hash.
3. Checking that each record's previous hash matches the previous record's hash.

If any check fails, the audit log has been tampered with.

---

## 6. Audit log storage

The audit log is stored in the Vault using the existing encryption
mechanisms. The audit log is append-only and cannot be modified or deleted.

---

## 7. Audit log access

The audit log is accessible only to the owner device. Other devices can
request audit log entries via the sync channel, but the owner device
controls access.
