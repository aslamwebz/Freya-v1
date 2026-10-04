export type {
  DeviceId, DevicePlatform, DeviceTrustLevel, DeviceStatus,
  DeviceIdentity, DeviceAttestation, DeviceTrust, DeviceRevocation, DeviceRecord,
  DeviceCapability, OwnerBootstrap, OwnerAction,
  PairingChallenge, PairingRequest, PairingResponse, EnrollmentRecord, OwnerApproval, OwnerAuthorization,
  VectorClock, SyncChange, SyncDelta, SyncResult, EncryptedPayload, SyncMessage,
  ConflictRecord, ConflictResolution, ConflictPolicy,
  PresenceLease, PresenceRecord,
  RemoteCommandKind, RemoteCommand, RemoteCommandResult,
  AuditAction, AuditRecord, AuditAnchor,
  DeviceRegistry, SyncEngine, PresenceManager, RemoteCommandEngine, AuditJournal,
} from './types.js';
export type { DeviceSecrets } from './device-identity.js';

export { InMemoryDeviceRegistry } from './registry.js';
export { InMemorySyncEngine } from './sync.js';
export { InMemoryPresenceManager } from './presence.js';
export { InMemoryRemoteCommandEngine } from './remote-commands.js';
export { InMemoryAuditJournal } from './audit.js';
export {
  createDeviceTrust, isTrustLevelAtLeast, canSyncRead, canSyncWrite, canIssueCommands,
  canReceiveCommands, canEnrollDevices, canPromoteDemote, canRevokeDevices, isOwnerLevel,
  isDeviceCapability, capabilityForCommandKind, capabilitiesForTrust,
} from './trust.js';
export {
  generateDeviceId, generateDeviceSigningKeyPair, generateDeviceEncryptionKeyPair, generateDeviceKeyPair,
  createDeviceIdentity, signWithDeviceKey, verifyWithDeviceKey, generateNonce,
  attestDeviceIdentity, verifyDeviceAttestation,
} from './device-identity.js';
export {
  CHALLENGE_TTL_MS, MAX_CLOCK_SKEW_MS, MAX_REQUEST_AGE_MS,
  createPairingChallenge, verifyChallenge, createPairingRequest, verifyPairingResponse,
  createOwnerApproval, verifyOwnerApproval, createOwnerAuthorization, verifyOwnerAuthorization,
  ownerAuthorizationTranscript, sameIdentity,
} from './enrollment.js';
export {
  emptyVectorClock, incrementVectorClock, mergeVectorClocks, compareVectorClocks,
  isVectorClockAtLeast, vectorClockToString, vectorClockFromString,
} from './vector-clock.js';
export {
  deriveSharedKey, generateSymmetricKey, generateEphemeralKeyPair,
  encryptPayload, decryptPayload, encryptForDevice, decryptForDevice,
} from './encryption.js';
export { createDefaultConflictPolicy, resolveConflict, hasConflict } from './conflicts.js';
