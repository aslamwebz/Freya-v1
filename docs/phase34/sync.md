# Phase 34 — Encrypted Synchronization and Replication

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

All cross-device sync uses end-to-end encryption with per-device keys.
The Core never sees plaintext sync data from other devices.

---

## 2. Sync protocol

### 2.1 Sync request

A device initiates sync by sending:
- Its device ID.
- Its current vector clock.
- A nonce.

### 2.2 Sync response

The target device responds with:
- An encrypted delta (changes since the requester's vector clock).
- The target device's updated vector clock.
- A nonce.

### 2.3 Sync application

The requester:
1. Decrypts the delta.
2. Applies the changes.
3. Resolves any conflicts.
4. Updates its vector clock.
5. Sends an ack.

---

## 3. Encryption

### 3.1 Per-device keys

Each device has a symmetric key for sync encryption. The symmetric key
is generated on first launch and stored in the device's local Vault.

### 3.2 Key wrapping

The symmetric key is wrapped by the target device's public key. Only
the target device can unwrap the symmetric key.

### 3.3 Encryption algorithm

Sync data is encrypted using AES-256-GCM:
- **Ciphertext**: The encrypted sync data.
- **IV**: Random 12-byte initialization vector.
- **Auth tag**: 16-byte authentication tag.
- **Wrapped key**: The symmetric key wrapped by the target device's public key.

---

## 4. Vector clocks

### 4.1 Definition

A vector clock is a map from device IDs to logical timestamps:

```typescript
type VectorClock = Record<DeviceId, number>;
```

### 4.2 Increment

When a device makes a change, it increments its own entry in the vector clock:

```typescript
vectorClock[deviceId] = (vectorClock[deviceId] || 0) + 1;
```

### 4.3 Comparison

Vector clocks are compared to determine causality:
- `vc1 < vc2` if all entries in `vc1` are less than or equal to `vc2` and at least one is strictly less.
- `vc1 > vc2` if all entries in `vc1` are greater than or equal to `vc2` and at least one is strictly greater.
- `vc1 || vc2` (concurrent) if neither `vc1 < vc2` nor `vc1 > vc2`.

### 4.4 Merge

Vector clocks are merged by taking the maximum of each entry:

```typescript
function mergeVectorClocks(vc1: VectorClock, vc2: VectorClock): VectorClock {
  const result: VectorClock = { ...vc1 };
  for (const [deviceId, timestamp] of Object.entries(vc2)) {
    result[deviceId] = Math.max(result[deviceId] || 0, timestamp);
  }
  return result;
}
```

---

## 5. Offline operation

### 5.1 Queuing

When a device is offline, it queues changes locally. Each queued change
includes:
- The change path.
- The change operation.
- The change value.
- The device's vector clock at the time of the change.

### 5.2 Reconciliation

On reconnect, the device:
1. Sends its vector clock to the other devices.
2. Receives deltas from the other devices.
3. Applies the deltas.
4. Resolves any conflicts.
5. Sends its queued changes to the other devices.

### 5.3 Split-brain recovery

During a network partition, devices on each side continue to operate
independently. On reconnect, conflicts are resolved deterministically
using the conflict resolution policy.

---

## 6. Sync integrity

### 6.1 Tamper detection

Each sync message includes a nonce and timestamp. Replayed messages are
detected and rejected.

### 6.2 Authentication

Each sync message is authenticated with the sender's device key. The
receiver verifies the signature before processing the message.

### 6.3 Authorization

Each sync message is authorized by the Guard. The Guard evaluates the
sender's trust level and capabilities before allowing the sync.
