# Phase 34 — Dependency Map

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Existing dependencies

Phase 34 uses the following existing dependencies:

### 1.1 Core

- `core/identity/` — FreyaIdentity (shared Core identity)
- `core/security/guard.ts` — Guard (capability policy)
- `core/authority.ts` — OwnerAuthority / WorkerAuthority
- `core/vault/` — Vault (encrypted storage)
- `core/events/` — Event fabric (durable events)
- `core/state.ts` — CoreState (pure reducer)
- `core/index.ts` — FreyaCore class

### 1.2 Node.js built-in

- `node:crypto` — cryptographic operations (Ed25519, AES-256-GCM, SHA-256)

### 1.3 Test

- `vitest` — test framework
- `tests/red-team/harness.ts` — red-team test harness

---

## 2. New modules

Phase 34 adds the following new modules:

### 2.1 Device identity

- `core/multidevice/types.ts` — TypeScript interfaces
- `core/multidevice/device-identity.ts` — device ID and key pair generation
- `core/multidevice/trust.ts` — trust level management

### 2.2 Enrollment

- `core/multidevice/enrollment.ts` — pairing flow

### 2.3 Sync

- `core/multidevice/sync.ts` — sync engine
- `core/multidevice/vector-clock.ts` — vector clock operations
- `core/multidevice/encryption.ts` — sync encryption

### 2.4 Conflicts

- `core/multidevice/conflicts.ts` — conflict resolution

### 2.5 Presence

- `core/multidevice/presence.ts` — presence and leases

### 2.6 Revocation

- `core/multidevice/revocation.ts` — revocation

### 2.7 Audit

- `core/multidevice/audit.ts` — audit journal

### 2.8 Remote commands

- `core/multidevice/remote-commands.ts` — remote command engine

### 2.9 Registry

- `core/multidevice/registry.ts` — device registry

---

## 3. Integration points

### 3.1 Guard

Device trust levels are encoded as capabilities that the Guard evaluates.

### 3.2 Vault

Device keys and sync data are stored in the Vault using the existing
encryption mechanisms.

### 3.3 Event journal

All cross-device actions are journaled as durable events.

### 3.4 FreyaCore

The multi-device subsystem is integrated into FreyaCore via the existing
dependency injection pattern.

---

## 4. No new external dependencies

Phase 34 does not add any new external dependencies. All cryptographic
operations use Node.js built-in `node:crypto`.
