export type DeviceId = string;

export type DevicePlatform = 'desktop' | 'laptop' | 'phone' | 'server' | 'other';

export type DeviceTrustLevel = 'owner' | 'trusted' | 'limited' | 'untrusted';

export type DeviceStatus = 'active' | 'offline' | 'revoked';

export interface DeviceIdentity {
  readonly id: DeviceId;
  readonly publicKey: string;
  readonly displayName: string;
  readonly platform: DevicePlatform;
  readonly createdAt: number;
}

export interface DeviceTrust {
  readonly level: DeviceTrustLevel;
  readonly promotedAt: number;
  readonly promotedBy: DeviceId;
  readonly reason: string;
}

export interface DeviceRevocation {
  readonly revokedAt: number;
  readonly revokedBy: DeviceId;
  readonly reason: string;
}

export interface DeviceRecord {
  readonly identity: DeviceIdentity;
  readonly trust: DeviceTrust;
  readonly enrolledAt: number;
  readonly enrolledBy: DeviceId;
  readonly lastSeenAt: number;
  readonly status: DeviceStatus;
  readonly revocation: DeviceRevocation | null;
}

export interface PairingRequest {
  readonly deviceIdentity: DeviceIdentity;
  readonly timestamp: number;
  readonly nonce: string;
  readonly response: string;
}

export interface PairingResponse {
  readonly enrollmentToken: string;
  readonly trustLevel: DeviceTrustLevel;
  readonly expiresAt: number;
}

export interface EnrollmentRecord {
  readonly deviceId: DeviceId;
  readonly enrolledAt: number;
  readonly enrolledBy: DeviceId;
  readonly initialTrustLevel: DeviceTrustLevel;
  readonly pairingRequestId: string;
}

export interface OwnerApproval {
  readonly approverDeviceId: DeviceId;
  readonly approvedAt: number;
  readonly signature: string;
}

export type VectorClock = Record<DeviceId, number>;

export interface SyncChange {
  readonly path: string;
  readonly operation: 'set' | 'delete';
  readonly value: unknown;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
}

export interface SyncDelta {
  readonly changes: SyncChange[];
  readonly vectorClock: VectorClock;
}

export interface SyncResult {
  readonly applied: SyncChange[];
  readonly conflicts: ConflictRecord[];
  readonly newVectorClock: VectorClock;
}

export interface EncryptedPayload {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly wrappedKey: string;
}

export interface SyncMessage {
  readonly deviceId: DeviceId;
  readonly vectorClock: VectorClock;
  readonly timestamp: number;
  readonly nonce: string;
  readonly payload: EncryptedPayload;
}

export interface ConflictRecord {
  readonly path: string;
  readonly localChange: SyncChange;
  readonly remoteChange: SyncChange;
  readonly resolution: 'local' | 'remote' | 'merged';
  readonly resolvedAt: number;
  readonly resolvedBy: DeviceId;
}

export type ConflictResolution = 'local-wins' | 'remote-wins' | 'merge';

export interface ConflictPolicy {
  readonly defaultResolution: ConflictResolution;
  readonly pathPolicies: Record<string, ConflictResolution>;
}

export interface PresenceLease {
  readonly deviceId: DeviceId;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly renewedAt: number;
  readonly ttlMs: number;
}

export interface PresenceRecord {
  readonly deviceId: DeviceId;
  readonly lease: PresenceLease | null;
  readonly status: DeviceStatus;
  readonly lastSeenAt: number;
}

export type RemoteCommandKind =
  | 'ping'
  | 'get-status'
  | 'get-presence'
  | 'request-sync'
  | 'stop-all'
  | 'custom';

export interface RemoteCommand {
  readonly id: string;
  readonly kind: RemoteCommandKind;
  readonly sourceDeviceId: DeviceId;
  readonly targetDeviceId: DeviceId;
  readonly payload: unknown;
  readonly timestamp: number;
  readonly nonce: string;
  readonly requiredCapabilities: string[];
}

export interface RemoteCommandResult {
  readonly commandId: string;
  readonly success: boolean;
  readonly result: unknown;
  readonly error: string | null;
  readonly executedAt: number;
  readonly executedBy: DeviceId;
}

export type AuditAction =
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

export interface AuditRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
  readonly action: AuditAction;
  readonly details: Record<string, unknown>;
  readonly hash: string;
  readonly previousHash: string;
}

export interface DeviceRegistry {
  enroll(request: PairingRequest, ownerApproval: OwnerApproval): EnrollmentRecord;
  revoke(deviceId: DeviceId, revokedBy: DeviceId, reason: string): void;
  promote(deviceId: DeviceId, newLevel: DeviceTrustLevel, promotedBy: DeviceId, reason: string): void;
  demote(deviceId: DeviceId, newLevel: DeviceTrustLevel, demotedBy: DeviceId, reason: string): void;
  get(deviceId: DeviceId): DeviceRecord | null;
  list(): DeviceRecord[];
  listByTrust(level: DeviceTrustLevel): DeviceRecord[];
  isRevoked(deviceId: DeviceId): boolean;
  canSync(deviceId: DeviceId): boolean;
  canIssueCommands(deviceId: DeviceId): boolean;
  canReceiveCommands(deviceId: DeviceId): boolean;
}

export interface SyncEngine {
  sync(deviceId: DeviceId, vectorClock: VectorClock): SyncDelta;
  apply(deviceId: DeviceId, delta: SyncDelta): SyncResult;
  getVectorClock(deviceId: DeviceId): VectorClock;
  resolveConflicts(local: SyncChange, remote: SyncChange, policy: ConflictPolicy): ConflictRecord;
}

export interface PresenceManager {
  acquireLease(deviceId: DeviceId, ttlMs: number): PresenceLease;
  renewLease(deviceId: DeviceId): PresenceLease;
  releaseLease(deviceId: DeviceId): void;
  getPresence(deviceId: DeviceId): PresenceRecord;
  listPresence(): PresenceRecord[];
  expireLeases(now: number): PresenceRecord[];
}

export interface RemoteCommandEngine {
  issue(command: RemoteCommand): RemoteCommandResult;
  execute(commandId: string): RemoteCommandResult;
  get(commandId: string): RemoteCommandResult | null;
  list(deviceId: DeviceId): RemoteCommandResult[];
}

export interface AuditJournal {
  record(action: AuditAction, deviceId: DeviceId, details: Record<string, unknown>): AuditRecord;
  list(deviceId?: DeviceId, action?: AuditAction): AuditRecord[];
  verify(): boolean;
}
