export type {
  DeviceId, DevicePlatform, DeviceTrustLevel, DeviceStatus,
  DeviceIdentity, DeviceTrust, DeviceRevocation, DeviceRecord,
  PairingRequest, PairingResponse, EnrollmentRecord, OwnerApproval,
  VectorClock, SyncChange, SyncDelta, SyncResult, EncryptedPayload, SyncMessage,
  ConflictRecord, ConflictResolution, ConflictPolicy,
  PresenceLease, PresenceRecord,
  RemoteCommandKind, RemoteCommand, RemoteCommandResult,
  AuditAction, AuditRecord,
  DeviceRegistry, SyncEngine, PresenceManager, RemoteCommandEngine, AuditJournal,
} from './types.js';

export { InMemoryDeviceRegistry } from './registry.js';
export { InMemorySyncEngine } from './sync.js';
export { InMemoryPresenceManager } from './presence.js';
export { InMemoryRemoteCommandEngine } from './remote-commands.js';
export { InMemoryAuditJournal } from './audit.js';
export { createDeviceTrust, isTrustLevelAtLeast, canSyncRead, canSyncWrite, canIssueCommands, canReceiveCommands, canEnrollDevices, canPromoteDemote, canRevokeDevices, isOwnerLevel } from './trust.js';
export { generateDeviceId, generateDeviceKeyPair, createDeviceIdentity, signWithDeviceKey, verifyWithDeviceKey, generateNonce } from './device-identity.js';
export { emptyVectorClock, incrementVectorClock, mergeVectorClocks, compareVectorClocks, vectorClockToString, vectorClockFromString } from './vector-clock.js';
export { generateSymmetricKey, wrapSymmetricKey, unwrapSymmetricKey, encryptPayload, decryptPayload, encryptForDevice, decryptForDevice } from './encryption.js';
export { createDefaultConflictPolicy, resolveConflict, hasConflict } from './conflicts.js';
