export type DeviceId = string;

export type DevicePlatform = 'desktop' | 'laptop' | 'phone' | 'server' | 'other';

export type DeviceTrustLevel = 'owner' | 'trusted' | 'limited' | 'untrusted';

export type DeviceStatus = 'active' | 'offline' | 'revoked';

/**
 * The capability vocabulary the multi-device subsystem understands.
 *
 * This is deliberately a closed set. A command that names a capability outside
 * it is denied rather than treated as an unknown-but-permitted string, because
 * "the vocabulary did not recognise this" and "the device may do this" must not
 * be the same answer.
 */
export type DeviceCapability =
  | 'device.ping'
  | 'device.status.read'
  | 'device.presence.read'
  | 'sync.request'
  | 'system.stop-all'
  | 'device.custom';

export interface DeviceIdentity {
  readonly id: DeviceId;
  /** Ed25519 SPKI public key (PEM). Used only for signatures. */
  readonly publicKey: string;
  /** X25519 SPKI public key (PEM). Used only for key agreement. */
  readonly encryptionPublicKey: string;
  readonly displayName: string;
  readonly platform: DevicePlatform;
  readonly createdAt: number;
}

/**
 * Self-signed binding of a device identity to its two public keys.
 *
 * A self-signature proves the presenter holds the private key for the identity
 * it is claiming; it is not, by itself, evidence of trust. Trust for the first
 * device comes from the bootstrap being a local, trusted-Core-only call, and
 * for later devices from an owner signature over the pairing transcript.
 */
export interface DeviceAttestation {
  readonly deviceId: DeviceId;
  readonly publicKey: string;
  readonly encryptionPublicKey: string;
  readonly issuedAt: number;
  readonly signature: string;
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

/** The single, locally-bootstrapped owner device. */
export interface OwnerBootstrap {
  readonly identity: DeviceIdentity;
  readonly attestation: DeviceAttestation;
}

/** A single-use challenge issued by the owner for one pairing attempt. */
export interface PairingChallenge {
  readonly ownerDeviceId: DeviceId;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Owner signature over the challenge transcript. */
  readonly signature: string;
}

export interface PairingRequest {
  readonly deviceIdentity: DeviceIdentity;
  /** The owner challenge this request answers. */
  readonly challengeNonce: string;
  readonly timestamp: number;
  /** Request nonce, tracked for replay rejection. */
  readonly nonce: string;
  /** Device signature over the response transcript. */
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

/** Explicit owner approval of a pairing request, bound to the transcript. */
export interface OwnerApproval {
  readonly approverDeviceId: DeviceId;
  readonly approvedAt: number;
  readonly challengeNonce: string;
  readonly deviceId: DeviceId;
  readonly signature: string;
}

export type OwnerAction = 'revoke' | 'promote' | 'demote';

/**
 * A signed, single-use owner authorization for a privileged registry action.
 *
 * The owner's private key never enters the registry. The registry verifies the
 * signature against the owner public key it bootstrapped, checks the action and
 * subject match what was requested, checks freshness, and consumes the nonce.
 */
export interface OwnerAuthorization {
  readonly ownerDeviceId: DeviceId;
  readonly action: OwnerAction;
  readonly subjectDeviceId: DeviceId;
  readonly level: DeviceTrustLevel | null;
  readonly reason: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly signature: string;
}

export type VectorClock = Record<DeviceId, number>;

export interface SyncChange {
  readonly path: string;
  readonly operation: 'set' | 'delete';
  readonly value: unknown;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
  /** Origin device's logical counter for this change. Assigned by the engine. */
  readonly sequence?: number;
}

export interface SyncDelta {
  readonly changes: SyncChange[];
  /** The responder's merged vector clock at the time the delta was produced. */
  readonly vectorClock: VectorClock;
  /** The device that produced this delta. */
  readonly senderDeviceId: DeviceId;
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
  /** The change that actually resulted. For `merged`, this carries the value. */
  readonly resolvedChange: SyncChange;
  /** The winning (or merged) value, for callers that only need the outcome. */
  readonly mergedValue: unknown;
  readonly resolvedAt: number;
  readonly resolvedBy: DeviceId;
}

export type ConflictResolution = 'local-wins' | 'remote-wins' | 'lww' | 'merge';

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
  /** Source device signature over the command transcript. */
  readonly signature: string;
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
  | 'owner-bootstrapped'
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
  readonly sequence: number;
  readonly timestamp: number;
  readonly deviceId: DeviceId;
  readonly action: AuditAction;
  readonly details: Record<string, unknown>;
  readonly hash: string;
  readonly previousHash: string;
}

/** A point-in-time commitment to the audit log, for external anchoring. */
export interface AuditAnchor {
  readonly sequence: number;
  readonly headHash: string;
  readonly digest: string;
}

export interface DeviceRegistry {
  bootstrapOwner(bootstrap: OwnerBootstrap): DeviceRecord;
  getOwnerId(): DeviceId | null;
  enroll(request: PairingRequest, challenge: PairingChallenge, ownerApproval: OwnerApproval): EnrollmentRecord;
  revoke(deviceId: DeviceId, authorization: OwnerAuthorization): void;
  promote(deviceId: DeviceId, newLevel: DeviceTrustLevel, authorization: OwnerAuthorization): void;
  demote(deviceId: DeviceId, newLevel: DeviceTrustLevel, authorization: OwnerAuthorization): void;
  get(deviceId: DeviceId): DeviceRecord | null;
  list(): DeviceRecord[];
  listByTrust(level: DeviceTrustLevel): DeviceRecord[];
  isRevoked(deviceId: DeviceId): boolean;
  canSync(deviceId: DeviceId): boolean;
  canSyncWrite(deviceId: DeviceId): boolean;
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
  acquireLease(deviceId: DeviceId, ttlMs?: number, issuedAt?: number): PresenceLease;
  renewLease(deviceId: DeviceId, actorDeviceId?: DeviceId): PresenceLease;
  releaseLease(deviceId: DeviceId): void;
  getPresence(deviceId: DeviceId): PresenceRecord;
  listPresence(): PresenceRecord[];
  expireLeases(now?: number): PresenceRecord[];
}

export interface RemoteCommandEngine {
  issue(command: RemoteCommand, stopAllApproval?: OwnerApproval): RemoteCommandResult;
  execute(commandId: string): RemoteCommandResult;
  get(commandId: string): RemoteCommandResult | null;
  list(deviceId: DeviceId): RemoteCommandResult[];
}

export interface AuditJournal {
  record(action: AuditAction, deviceId: DeviceId, details: Record<string, unknown>): AuditRecord;
  list(deviceId?: DeviceId, action?: AuditAction): AuditRecord[];
  verify(): boolean;
  anchor(): AuditAnchor;
  verifyAgainstAnchor(anchor: AuditAnchor): boolean;
}
