# Phase 36 — Backup Restore Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Backup restore is the bounded, auditable backup and restore process. It extends
the existing Vault architecture to handle encrypted backup creation,
verification, and restore with explicit validation.

---

## 2. Backup process

### 2.1 Steps

1. **Create** — create encrypted backup
2. **Verify** — verify backup integrity
3. **Store** — store backup in encrypted storage
4. **Report** — report backup status

### 2.2 Constraints

- Backup never stores plaintext data
- Backup never exceeds authority
- Backup always respects STOP ALL
- Backup never self-modifies trusted runtime code

---

## 3. Backup creation

### 3.1 Creation process

To create a backup:
1. The Vault is locked (no concurrent writes)
2. The Vault is copied to a backup file
3. The backup file is encrypted
4. The backup checksum is computed
5. The backup is journaled

### 3.2 Creation properties

- Creation is deterministic — same Vault + same clock = same backup
- Creation is bounded — it completes within a deadline
- Creation is journaled — every backup is durable
- Creation never calls a model
- Creation never stores plaintext data

---

## 4. Backup verification

### 4.1 Verification process

To verify a backup:
1. The backup file is read
2. The backup checksum is verified
3. The backup encryption is verified
4. The verification is journaled

### 4.2 Verification properties

- Verification is deterministic — same backup + same checksum = same result
- Verification is bounded — it completes within a deadline
- Verification is journaled — every verification is durable
- Verification never calls a model
- Verification never fabricates results

---

## 5. Restore process

### 5.1 Steps

1. **Select** — select the backup to restore
2. **Verify** — verify the backup integrity
3. **Restore** — restore from the encrypted backup
4. **Validate** — validate the restored state
5. **Report** — report restore status

### 5.2 Constraints

- Restore never fabricates state
- Restore never exceeds authority
- Restore always respects STOP ALL
- Restore never self-modifies trusted runtime code

---

## 6. Restore validation

### 6.1 Validation process

After a restore:
1. The restored state is validated against the journal
2. The restored Vault is verified
3. The validation is journaled
4. The owner is notified

### 6.2 Validation properties

- Validation is deterministic — same restored state + same journal = same result
- Validation is bounded — it completes within a deadline
- Validation is journaled — every validation is durable
- Validation never calls a model
- Validation never fabricates results

---

## 7. Backup restore and authority

### 7.1 Backup restore does not grant authority

Backup restore does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Self-modify trusted runtime code

### 7.2 Backup restore influences continuation only

Backup restore determines whether the subsystem can continue. It does not
change what the subsystem is allowed to do.

---

## 8. Backup restore persistence

### 8.1 Durable storage

Backups are stored in encrypted storage. They survive restarts. They are
event-sourced — all changes are journaled.

### 8.2 Recovery

On restart:
1. Replay the journal
2. Rebuild backup restore state
3. Reconcile interrupted operations
4. Resume or terminate explicitly

---

## 9. Backup restore invariants

These invariants must hold at all times:

1. **Backup restore is bounded** — Every backup/restore has a deadline.
2. **Backup restore is deterministic** — Same state = same backup/restore.
3. **Backup restore is journaled** — Every backup/restore is durable.
4. **Backup restore does not grant authority** — Every action flows through existing authority.
5. **Backup restore never stores plaintext data** — All backups are encrypted.
6. **Backup restore never fabricates state** — All state is derived from the backup.
7. **Backup restore never self-modifies** — Trusted runtime code is never self-modified.
8. **Backup restore is verified** — Every backup is verified before use.
