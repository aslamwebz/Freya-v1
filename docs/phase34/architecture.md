# Phase 34 — Architecture Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Multi-Device Freya enables one Freya Core identity to span multiple trusted
devices (desktop, laptop, phone, server). Each device has its own cryptographic
identity and trust level. All cross-device communication is end-to-end
encrypted. Conflicts are resolved deterministically. Devices can operate
offline and reconcile on reconnect.

The core invariant:

> **One Freya Core identity spans multiple trusted devices. A paired device
> never automatically inherits unrestricted owner authority. Every device
> operates within its own trust level, and all cross-device actions flow
> through the existing Guard, Governor, STOP ALL, approval, and budget paths.**

---

## 2. Design principles

### 2.1 One identity, many devices

The `FreyaIdentity` from `core/identity/` is the single Core identity. All
devices present this identity to the Core. The identity is not duplicated or
forked — it is shared.

### 2.2 Device identity is separate from Core identity

Each device has its own `DeviceId` (cryptographically random) and key pair.
The device identity is used for authentication and encryption. The Core
identity is used for authority and capability checks.

### 2.3 Trust levels are explicit and enforced

Devices are classified into trust tiers: `owner`, `trusted`, `limited`,
`untrusted`. Trust levels determine what a device can do on the sync and
command surfaces. Trust levels are enforced by the Guard.

### 2.4 Enrollment is explicit and owner-approved

New devices are enrolled via a pairing flow that requires explicit owner
approval. The pairing flow uses challenge-response verification to prevent
eavesdropping and replay.

### 2.5 Sync is end-to-end encrypted

All cross-device sync uses per-device symmetric keys wrapped by the device's
public key. The Core never sees plaintext sync data from other devices.

### 2.6 Conflicts are deterministic

Conflict resolution uses vector clocks and last-writer-wins (LWW) with
explicit conflict records. Same state + same clock = same resolution.

### 2.7 Offline-first

Devices can operate offline. Changes are queued locally and reconciled on
reconnect. The reconciliation is deterministic and audited.

### 2.8 Presence is bounded

Device presence is maintained with bounded leases that expire deterministically.
A device that fails to renew its lease is marked offline.

### 2.9 Revocation is immediate

Device revocation has immediate effect on sync and command surfaces. Revoked
devices cannot sync, receive commands, or issue commands.

### 2.10 All actions are audited

All cross-device actions are journaled with tamper-evident audit records.

### 2.11 Remote commands are bounded

Remote commands are capability-checked and bounded. They never bypass
Guard, Governor, STOP ALL, approvals, or budgets.

### 2.12 Authority-preserving

The multi-device subsystem cannot create grants, widen budgets, bypass Guard,
override Governor, clear STOP ALL, approve its own requests, or add real-money/
economic actions.

---

## 3. Component architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Freya Core                              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Core Identity (shared)                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Device     │  │    Sync     │  │   Remote Commands   │ │
│  │  Registry    │  │   Engine    │  │      Engine         │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                     │             │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────────┴──────────┐ │
│  │  Enrollment  │  │  Conflict   │  │   Capability        │ │
│  │   Engine     │  │  Resolver   │  │   Checker           │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘ │
│         │                │                     │             │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────────┴──────────┐ │
│  │   Trust      │  │  Presence   │  │   Audit             │ │
│  │   Manager    │  │  Manager    │  │   Journal           │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Guard │ Governor │ STOP ALL │ Approvals │ Budgets          │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Data flow

### 4.1 Enrollment

```
New Device                          Owner Device
    │                                    │
    │  1. Pairing request (device info)  │
    │ ─────────────────────────────────> │
    │                                    │
    │  2. Challenge (nonce)              │
    │ <───────────────────────────────── │
    │                                    │
    │  3. Response (signed nonce)        │
    │ ─────────────────────────────────> │
    │                                    │
    │  4. Owner approval (explicit)      │
    │     [owner approves via UI]        │
    │                                    │
    │  5. Enrollment token + trust level │
    │ <───────────────────────────────── │
    │                                    │
    │  6. Device registered              │
    │     [audit journal updated]        │
```

### 4.2 Sync

```
Device A                            Device B
    │                                    │
    │  1. Sync request (vector clock)    │
    │ ─────────────────────────────────> │
    │                                    │
    │  2. Encrypted delta                │
    │ <───────────────────────────────── │
    │                                    │
    │  3. Conflict resolution            │
    │     [deterministic, LWW]           │
    │                                    │
    │  4. Ack (updated vector clock)     │
    │ ─────────────────────────────────> │
    │                                    │
    │  5. Audit journal updated          │
```

### 4.3 Remote command

```
Device A                            Device B
    │                                    │
    │  1. Command request (bounded)      │
    │ ─────────────────────────────────> │
    │                                    │
    │  2. Capability check               │
    │     [Guard evaluates]              │
    │                                    │
    │  3. Command execution (if allowed)  │
    │     [bounded, audited]             │
    │                                    │
    │  4. Result                         │
    │ <───────────────────────────────── │
    │                                    │
    │  5. Audit journal updated          │
```

---

## 5. Security boundaries

### 5.1 Device authentication

Each device authenticates with its device ID and private key. The Core
verifies the device's signature on every request.

### 5.2 Sync encryption

Sync data is encrypted with a per-device symmetric key. The symmetric key
is wrapped by the device's public key. The Core never sees plaintext sync
data from other devices.

### 5.3 Command authorization

Remote commands are authorized by the Guard. The Guard evaluates the
commanding device's capabilities against the command's required capabilities.
Commands that require capabilities the device does not hold are denied.

### 5.4 Trust level enforcement

Trust levels are enforced on all sync and command surfaces. A `limited`
device cannot issue commands. An `untrusted` device cannot sync or receive
commands.

### 5.5 Revocation

Revocation is immediate. A revoked device's keys are invalidated, and the
device is removed from the sync and command surfaces. The revocation is
journaled and propagated to all other devices.

---

## 6. Failure modes

### 6.1 Device offline

A device that goes offline stops receiving sync updates. Its queued changes
are reconciled on reconnect. Its presence lease expires after a bounded
timeout.

### 6.2 Network partition

During a network partition, devices on each side continue to operate
independently. On reconnect, conflicts are resolved deterministically.

### 6.3 Device compromise

A compromised device can be revoked immediately. The revocation propagates
to all other devices. The compromised device's keys are invalidated.

### 6.4 Clock skew

Vector clocks are used to track causality. Clock skew is handled by the
conflict resolver, which uses LWW as a tiebreaker.

### 6.5 Replay attacks

All sync and command messages include a nonce and timestamp. Replayed
messages are detected and rejected.

---

## 7. Integration with existing systems

### 7.1 Guard

The Guard is unchanged. Device trust levels are encoded as capabilities
that the Guard evaluates.

### 7.2 Governor

The Governor is unchanged. Remote commands flow through the Governor's
existing approval paths.

### 7.3 STOP ALL

STOP ALL is unchanged. STOP ALL stops all device operations, including
sync and remote commands.

### 7.4 Approvals

Approvals are unchanged. Device enrollment and trust promotion require
explicit owner approval.

### 7.5 Budgets

Budgets are unchanged. Remote commands are subject to the same budget
constraints as local commands.

### 7.6 Vault

The Vault is unchanged. Device keys and sync data are stored in the Vault
using the existing encryption mechanisms.

### 7.7 Event journal

The event journal is unchanged. All cross-device actions are journaled
as durable events.
