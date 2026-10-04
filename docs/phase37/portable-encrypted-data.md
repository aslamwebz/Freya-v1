# Phase 37 — Portable Encrypted Identity/Data Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Portable encrypted identity/data is the capability to export and import
encrypted identity and data across environments. It ensures that data remains
confidential and integral during transfer.

---

## 2. Export process

### 2.1 Steps

1. **Select** — select the data to export
2. **Encrypt** — encrypt the data
3. **Hash** — compute the data hash
4. **Package** — package the encrypted data
5. **Transfer** — transfer the package

### 2.2 Constraints

- Export never stores plaintext data
- Export never exceeds authority
- Export always respects STOP ALL
- Export never self-modifies trusted runtime code

---

## 3. Import process

### 3.1 Steps

1. **Receive** — receive the encrypted package
2. **Verify** — verify the data hash
3. **Decrypt** — decrypt the data
4. **Validate** — validate the decrypted data
5. **Store** — store the decrypted data

### 3.2 Constraints

- Import never fabricates data
- Import never exceeds authority
- Import always respects STOP ALL
- Import never self-modifies trusted runtime code

---

## 4. Encryption

### 4.1 Encryption properties

- All exported data is encrypted
- Encryption uses a canonical encryption scheme
- Encryption keys are derived from the Vault key
- Encryption never stores plaintext data

### 4.2 Encryption constraints

- Encryption is deterministic — same data + same key = same ciphertext
- Encryption is bounded — it completes within a deadline
- Encryption is journaled — every encryption operation is durable
- Encryption never calls a model

---

## 5. Data integrity

### 5.1 Integrity properties

- Every export includes a data hash
- Every import verifies the data hash
- Hash mismatches are refused
- Integrity is never fabricated

### 5.2 Integrity constraints

- Integrity checks are deterministic — same data + same hash = same result
- Integrity checks are bounded — they complete within a deadline
- Integrity checks are journaled — every check is durable
- Integrity checks never call a model

---

## 6. Portable encrypted data and authority

### 6.1 Portable encrypted data does not grant authority

Portable encrypted data does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 6.2 Portable encrypted data influences transfer only

Portable encrypted data determines how data is transferred. It does not change
what the subsystem is allowed to do.

---

## 7. Portable encrypted data persistence

### 7.1 Durable storage

Portable data records are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild portable data state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 8. Portable encrypted data invariants

These invariants must hold at all times:

1. **Portable data is encrypted** — All exported data is encrypted.
2. **Portable data is bounded** — Every export/import has a deadline.
3. **Portable data is deterministic** — Same data = same export/import.
4. **Portable data is journaled** — Every export/import is durable.
5. **Portable data does not grant authority** — Every action flows through existing authority.
6. **Portable data never stores plaintext** — All data is encrypted.
7. **Portable data never self-modifies** — Trusted runtime code is never self-modified.
8. **Portable data is verified** — Every import verifies data integrity.
