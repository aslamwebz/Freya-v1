# Phase 34 — Presence and Leases

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Device presence is maintained with bounded leases that expire deterministically.
A device that fails to renew its lease is marked offline.

---

## 2. Presence lease

### 2.1 Lease acquisition

A device acquires a presence lease by sending a lease request to the Core.
The lease includes:
- The device ID.
- The acquisition timestamp.
- The expiration timestamp.
- The time-to-live (TTL) in milliseconds.

### 2.2 Lease renewal

A device renews its presence lease by sending a lease renewal request before
the lease expires. The renewal extends the expiration timestamp by the TTL.

### 2.3 Lease release

A device releases its presence lease by sending a lease release request to
the Core. The lease is removed and the device is marked offline.

### 2.4 Lease expiration

If a device fails to renew its lease before the expiration timestamp, the
lease expires. The device is marked offline.

---

## 3. Lease TTL

The default lease TTL is 30 seconds. The TTL is configurable but must be
bounded (minimum 5 seconds, maximum 5 minutes).

---

## 4. Presence record

The presence record for a device includes:
- The device ID.
- The current lease (if any).
- The device status (`active`, `offline`, or `revoked`).
- The last seen timestamp.

---

## 5. Presence enforcement

### 5.1 Sync

Only devices with active presence leases can sync. A device whose lease
has expired cannot sync until it renews its lease.

### 5.2 Remote commands

Only devices with active presence leases can issue or receive remote
commands. A device whose lease has expired cannot issue or receive
commands until it renews its lease.

### 5.3 Revocation

A revoked device's presence lease is immediately removed. The device is
marked as revoked and cannot sync or issue/receive commands.

---

## 6. Lease expiration handling

When a lease expires:
1. The device is marked offline.
2. The expiration is journaled in the audit log.
3. The device's queued changes are preserved for reconciliation on
   reconnect.

---

## 7. Deterministic expiration

Lease expiration is deterministic:
- Same lease + same clock = same expiration.
- The expiration does not depend on the order in which lease requests
  are received.
