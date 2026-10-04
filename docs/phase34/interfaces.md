# Phase 34 — Interfaces

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Device identity

```typescript
type DeviceId = string; // cryptographically random, 32 bytes hex

type DevicePublicKey = string; // base64-encoded Ed25519 public key

type DevicePrivateKey = string; // base64-encoded Ed25519 private key (never leaves device)

interface DeviceIdentity {
  readonly id: DeviceId;
  readonly publicKey: DevicePublicKey;
  readonly displayName: string;
  readonly platform: DevicePlatform;
  readonly createdAt: number; // epoch ms
}

type DevicePlatform = 'desktop' | 'laptop' | 'phone' | 'server' | 'other';
```

---

## 2. Trust levels

```typescript
type DeviceTrustLevel = 'owner' | 'trusted' | 'limited' | 'untrusted';

interface DeviceTrust {
  readonly level: DeviceTrustLevel;
  readonly promotedAt: number; // epoch ms
  readonly promotedBy: DeviceId; // device that promoted this device
  readonly reason: string; // human-readable reason for trust level
}
```

---

## 3. Device record

```typescript
interface DeviceRecord {
  readonly identity: DeviceIdentity;
  readonly trust: DeviceTrust;
  readonly enrolledAt: number; // epoch ms
  readonly enrolledBy: DeviceId; // device that enrolled this device
  readonly lastSeenAt: number; // epoch ms
  readonly status: DeviceStatus;
  readonly revocation: DeviceRevocation | null;
}

type DeviceStatus = 'active' | 'offline' | 'revoked';

interface DeviceRevocation {
  readonly revokedAt: number; // epoch ms
  readonly revokedBy: DeviceId;
  readonly reason: string;
}
```

---

## 4. Enrollment

```typescript
interface PairingRequest {
  readonly deviceIdentity: DeviceIdentity;
  readonly timestamp: number;
  readonly nonce: string; // challenge nonce from owner device
  readonly response: string; // signed nonce
}

interface PairingResponse {
  readonly enrollmentToken: string; // one-time token
  readonly trustLevel: DeviceTrustLevel; // initial trust level (always 'limited')
  readonly expiresAt: number; // epoch ms
}

interface EnrollmentRecord {
  readonly deviceId: DeviceId;
  readonly enrolledAt: number;
  readonly enrolledBy: DeviceId;
  readonly initialTrustLevel: DeviceTrustLevel;
  readonly pairingRequestId: string;
}
```

---

## 5. Sync

```typescript
type VectorClock = Record<DeviceId, number>;

interface SyncMessage {
  readonly deviceId: DeviceId;
  readonly vectorClock: VectorClock;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: EncryptedPayload;
}

interface EncryptedPayload {
  readonly ciphertext: string; // base64
  readonly iv: string; // base64
  readonly authTag: string; // base64
  readonly wrappedKey: string; // base64, wrapped by target device public key
}

interface SyncDelta {
  readonly changes: SyncChange[];
  readonly vectorClock: VectorClock;
}

interface SyncChange {
  readonly path: string; // dot-separated path, e.g. "brain.memory.abc123"
  readonly operation: 'set' | 'delete';
  readonly value: unknown;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
}
```

---

## 6. Conflict resolution

```typescript
interface ConflictRecord {
  readonly path: string;
  readonly localChange: SyncChange;
  readonly remoteChange: SyncChange;
  readonly resolution: 'local' | 'remote' | 'merged';
  readonly resolvedAt: number;
  readonly resolvedBy: DeviceId;
}

type ConflictResolution = 'local-wins' | 'remote-wins' | 'merge';

interface ConflictPolicy {
  readonly defaultResolution: ConflictResolution;
  readonly pathPolicies: Record<string, ConflictResolution>;
}
```

---

## 7. Presence

```typescript
interface PresenceLease {
  readonly deviceId: DeviceId;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly renewedAt: number;
  readonly ttlMs: number;
}

interface PresenceRecord {
  readonly deviceId: DeviceId;
  readonly lease: PresenceLease | null;
  readonly status: DeviceStatus;
  readonly lastSeenAt: number;
}
```

---

## 8. Remote commands

```typescript
type RemoteCommandKind =
  | 'ping'
  | 'get-status'
  | 'get-presence'
  | 'request-sync'
  | 'stop-all'
  | 'custom';

interface RemoteCommand {
  readonly id: string;
  readonly kind: RemoteCommandKind;
  readonly sourceDeviceId: DeviceId;
  readonly targetDeviceId: DeviceId;
  readonly payload: unknown;
  readonly timestamp: number;
  readonly nonce: string;
  readonly requiredCapabilities: string[];
}

interface RemoteCommandResult {
  readonly commandId: string;
  readonly success: boolean;
  readonly result: unknown;
  readonly error: string | null;
  readonly executedAt: number;
  readonly executedBy: DeviceId;
}
```

---

## 9. Audit

```typescript
interface AuditRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
  readonly action: AuditAction;
  readonly details: Record<string, unknown>;
  readonly hash: string; // tamper-evident hash chain
  readonly previousHash: string;
}

type AuditAction =
  | 'device-enrolled'
  | 'device-revoked'
  | 'trust-promoted'
  | 'trust-demoted'
  | 'sync-started'
  | 'sync-completed'
  | 'sync-conflict'
  | 'command-issued'
  | 'command-executed'
  | 'command-denied'
  | 'presence-acquired'
  | 'presence-expired'
  | 'presence-renewed';
```

---

## 10. Device registry

```typescript
interface DeviceRegistry {
  enroll(request: PairingRequest, ownerApproval: OwnerApproval): Promise<EnrollmentRecord>;
  revoke(deviceId: DeviceId, revokedBy: DeviceId, reason: string): Promise<void>;
  promote(deviceId: DeviceId, newLevel: DeviceTrustLevel, promotedBy: DeviceId, reason: string): Promise<void>;
  demote(deviceId: DeviceId, newLevel: DeviceTrustLevel, demotedBy: DeviceId, reason: string): Promise<void>;
  get(deviceId: DeviceId): Promise<DeviceRecord | null>;
  list(): Promise<DeviceRecord[]>;
  listByTrust(level: DeviceTrustLevel): Promise<DeviceRecord[]>;
  isRevoked(deviceId: DeviceId): Promise<boolean>;
  canSync(deviceId: DeviceId): Promise<boolean>;
  canIssueCommands(deviceId: DeviceId): Promise<boolean>;
  canReceiveCommands(deviceId: DeviceId): Promise<boolean>;
}

interface OwnerApproval {
  readonly approverDeviceId: DeviceId;
  readonly approvedAt: number;
  readonly signature: string;
}
```

---

## 11. Sync engine

```typescript
interface SyncEngine {
  sync(deviceId: DeviceId, vectorClock: VectorClock): Promise<SyncDelta>;
  apply(deviceId: DeviceId, delta: SyncDelta): Promise<SyncResult>;
  getVectorClock(deviceId: DeviceId): Promise<VectorClock>;
  resolveConflicts(local: SyncChange, remote: SyncChange, policy: ConflictPolicy): Promise<ConflictRecord>;
}

interface SyncResult {
  readonly applied: SyncChange[];
  readonly conflicts: ConflictRecord[];
  readonly newVectorClock: VectorClock;
}
```

---

## 12. Presence manager

```typescript
interface PresenceManager {
  acquireLease(deviceId: DeviceId, ttlMs: number): Promise<PresenceLease>;
  renewLease(deviceId: DeviceId): Promise<PresenceLease>;
  releaseLease(deviceId: DeviceId): Promise<void>;
  getPresence(deviceId: DeviceId): Promise<PresenceRecord>;
  listPresence(): Promise<PresenceRecord[]>;
  expireLeases(now: number): Promise<PresenceRecord[]>;
}
```

---

## 13. Remote command engine

```typescript
interface RemoteCommandEngine {
  issue(command: RemoteCommand): Promise<RemoteCommandResult>;
  execute(commandId: string): Promise<RemoteCommandResult>;
  get(commandId: string): Promise<RemoteCommandResult | null>;
  list(deviceId: DeviceId): Promise<RemoteCommandResult[]>;
}
```

---

## 14. Audit journal

```typescript
interface AuditJournal {
  record(action: AuditAction, deviceId: DeviceId, details: Record<string, unknown>): Promise<AuditRecord>;
  list(deviceId?: DeviceId, action?: AuditAction): Promise<AuditRecord[]>;
  verify(): Promise<boolean>;
}
```
