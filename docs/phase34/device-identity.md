# Phase 34 — Device Identity and Trust Model

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Device identity

Each device has a unique, cryptographically generated identity consisting of:

- **DeviceId**: 32 random bytes, hex-encoded. Generated on first launch.
- **Key pair**: Ed25519 signing key pair. The private key never leaves the device.
- **Display name**: Human-readable name (e.g., "Em's MacBook Pro").
- **Platform**: `desktop`, `laptop`, `phone`, `server`, or `other`.

The device identity is stored in the device's local Vault. It is never
transmitted in plaintext — only the public key and device ID are shared.

---

## 2. Core identity

The Core identity (`FreyaIdentity` from `core/identity/`) is the single
identity that spans all devices. It is not duplicated or forked. All devices
present this identity to the Core.

The Core identity is used for authority and capability checks. The device
identity is used for authentication and encryption.

---

## 3. Trust levels

### 3.1 Owner

- The device that originally enrolled the Core identity.
- Has full owner authority.
- Can enroll new devices, promote/demote trust levels, and revoke devices.
- Can issue and receive remote commands.
- There is exactly one owner device at any time.

### 3.2 Trusted

- A device that has been explicitly promoted by the owner.
- Has standard worker authority.
- Can sync (read/write).
- Can issue and receive remote commands (bounded).
- Cannot enroll new devices or promote/demote trust levels.

### 3.3 Limited

- The default trust level for newly enrolled devices.
- Can sync (read-only).
- Cannot issue or receive remote commands.
- Cannot enroll new devices or promote/demote trust levels.

### 3.4 Untrusted

- A device that has been demoted or has not completed enrollment.
- Cannot sync.
- Cannot issue or receive remote commands.
- Cannot enroll new devices or promote/demote trust levels.

---

## 4. Trust promotion and demotion

### 4.1 Promotion

Promotion requires:
1. Explicit owner approval (signature).
2. A human-readable reason.
3. An audit journal entry.

Promotion is immediate. The new trust level takes effect on the next
sync or command.

### 4.2 Demotion

Demotion does not require approval. It is immediate and journaled.

### 4.3 Owner transfer

Owner transfer requires:
1. Explicit approval from the current owner.
2. Explicit approval from the new owner.
3. An audit journal entry.

Owner transfer is a two-phase commit:
1. The current owner initiates the transfer.
2. The new owner accepts the transfer.
3. The transfer is journaled and takes effect.

---

## 5. Trust level enforcement

Trust levels are enforced on all sync and command surfaces:

| Surface | Owner | Trusted | Limited | Untrusted |
|---------|-------|---------|---------|-----------|
| Sync (read) | Yes | Yes | Yes | No |
| Sync (write) | Yes | Yes | No | No |
| Issue commands | Yes | Yes | No | No |
| Receive commands | Yes | Yes | No | No |
| Enroll devices | Yes | No | No | No |
| Promote/demote | Yes | No | No | No |
| Revoke devices | Yes | No | No | No |

---

## 6. Device compromise

A compromised device can be revoked immediately by the owner. Revocation:
1. Invalidates the device's keys.
2. Removes the device from the sync and command surfaces.
3. Propagates to all other devices.
4. Is journaled in the audit log.

A revoked device cannot be re-enrolled without a new pairing flow.

---

## 7. Key rotation

Device keys can be rotated by the owner. Key rotation:
1. Generates a new key pair.
2. Updates the device's public key in the registry.
3. Is journaled in the audit log.
4. Does not change the device's trust level.
