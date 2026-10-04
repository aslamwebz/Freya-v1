import { describe, it, expect } from 'vitest';
import {
  InMemoryDeviceRegistry,
  InMemorySyncEngine,
  InMemoryPresenceManager,
  InMemoryRemoteCommandEngine,
  InMemoryAuditJournal,
  isTrustLevelAtLeast,
  canSyncRead,
  canSyncWrite,
  canIssueCommands,
  canReceiveCommands,
  canEnrollDevices,
  canPromoteDemote,
  canRevokeDevices,
  isOwnerLevel,
  generateDeviceId,
  generateDeviceSigningKeyPair,
  generateDeviceEncryptionKeyPair,
  createDeviceIdentity,
  signWithDeviceKey,
  verifyWithDeviceKey,
  generateNonce,
  emptyVectorClock,
  incrementVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
  deriveSharedKey,
  generateEphemeralKeyPair,
  encryptPayload,
  decryptPayload,
  encryptForDevice,
  decryptForDevice,
  createDefaultConflictPolicy,
  resolveConflict,
  hasConflict,
  attestDeviceIdentity,
  createPairingChallenge,
  createPairingRequest,
  createOwnerApproval,
  createOwnerAuthorization,
} from '../../core/multidevice/index.js';
import type {
  DeviceIdentity,
  DeviceSecrets,
  SyncChange,
  ConflictPolicy,
  OwnerBootstrap,
  OwnerAuthorization,
  AuditRecord,
} from '../../core/multidevice/index.js';

function makeDevice(name: string, platform: DeviceIdentity['platform'] = 'desktop'): DeviceSecrets {
  return createDeviceIdentity(name, platform);
}

function ownerBootstrap(owner: DeviceSecrets): OwnerBootstrap {
  return {
    identity: owner,
    attestation: attestDeviceIdentity(owner, owner.privateKey),
  };
}

function enrollDevice(
  registry: InMemoryDeviceRegistry,
  owner: DeviceSecrets,
  device: DeviceSecrets
) {
  const challenge = createPairingChallenge(owner);
  const request = createPairingRequest(device, challenge);
  const approval = createOwnerApproval(owner, request, challenge);
  const record = registry.enroll(request, challenge, approval);
  return { challenge, request, approval, record };
}

function authorize(
  owner: DeviceSecrets,
  action: OwnerAuthorization['action'],
  subjectDeviceId: string,
  reason: string,
  level: OwnerAuthorization['level'] = null
): OwnerAuthorization {
  return createOwnerAuthorization(owner, action, subjectDeviceId, reason, level);
}

function internalRecords(journal: InMemoryAuditJournal): AuditRecord[] {
  return (journal as unknown as { records: AuditRecord[] }).records;
}

function replaceRecords(journal: InMemoryAuditJournal, records: AuditRecord[]): void {
  (journal as unknown as { records: AuditRecord[] }).records = records;
}

describe('device identity', () => {
  it('generates unique device IDs', () => {
    const id1 = generateDeviceId();
    const id2 = generateDeviceId();
    expect(id1).not.toBe(id2);
    expect(id1).toHaveLength(64);
  });

  it('generates separate signing and encryption key pairs', () => {
    const signing = generateDeviceSigningKeyPair();
    const encryption = generateDeviceEncryptionKeyPair();
    expect(signing.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(signing.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(encryption.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(encryption.privateKey).toContain('BEGIN PRIVATE KEY');
    expect(signing.publicKey).not.toBe(encryption.publicKey);
  });

  it('signs and verifies data with Ed25519', () => {
    const kp = generateDeviceSigningKeyPair();
    const data = 'test-data';
    const sig = signWithDeviceKey(kp.privateKey, data);
    expect(verifyWithDeviceKey(kp.publicKey, data, sig)).toBe(true);
    expect(verifyWithDeviceKey(kp.publicKey, 'wrong-data', sig)).toBe(false);
  });

  it('generates unique nonces', () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    expect(n1).not.toBe(n2);
  });
});

describe('trust levels', () => {
  it('enforces trust level ordering', () => {
    expect(isTrustLevelAtLeast('owner', 'trusted')).toBe(true);
    expect(isTrustLevelAtLeast('trusted', 'owner')).toBe(false);
    expect(isTrustLevelAtLeast('limited', 'limited')).toBe(true);
    expect(isTrustLevelAtLeast('untrusted', 'limited')).toBe(false);
  });

  it('enforces sync read permissions', () => {
    expect(canSyncRead('owner')).toBe(true);
    expect(canSyncRead('trusted')).toBe(true);
    expect(canSyncRead('limited')).toBe(true);
    expect(canSyncRead('untrusted')).toBe(false);
  });

  it('enforces sync write permissions', () => {
    expect(canSyncWrite('owner')).toBe(true);
    expect(canSyncWrite('trusted')).toBe(true);
    expect(canSyncWrite('limited')).toBe(false);
    expect(canSyncWrite('untrusted')).toBe(false);
  });

  it('enforces command issuance permissions', () => {
    expect(canIssueCommands('owner')).toBe(true);
    expect(canIssueCommands('trusted')).toBe(true);
    expect(canIssueCommands('limited')).toBe(false);
    expect(canIssueCommands('untrusted')).toBe(false);
  });

  it('enforces command reception permissions', () => {
    expect(canReceiveCommands('owner')).toBe(true);
    expect(canReceiveCommands('trusted')).toBe(true);
    expect(canReceiveCommands('limited')).toBe(false);
    expect(canReceiveCommands('untrusted')).toBe(false);
  });

  it('enforces enrollment permissions', () => {
    expect(canEnrollDevices('owner')).toBe(true);
    expect(canEnrollDevices('trusted')).toBe(false);
    expect(canEnrollDevices('limited')).toBe(false);
  });

  it('enforces promotion/demotion permissions', () => {
    expect(canPromoteDemote('owner')).toBe(true);
    expect(canPromoteDemote('trusted')).toBe(false);
  });

  it('enforces revocation permissions', () => {
    expect(canRevokeDevices('owner')).toBe(true);
    expect(canRevokeDevices('trusted')).toBe(false);
  });

  it('identifies owner level', () => {
    expect(isOwnerLevel('owner')).toBe(true);
    expect(isOwnerLevel('trusted')).toBe(false);
  });
});

describe('device registry', () => {
  it('bootstraps owner device', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const record = registry.bootstrapOwner(ownerBootstrap(owner));
    expect(record.identity.id).toBe(owner.id);
    expect(record.trust.level).toBe('owner');
    expect(registry.getOwnerId()).toBe(owner.id);
  });

  it('rejects double owner bootstrap', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    expect(() => registry.bootstrapOwner(ownerBootstrap(makeDevice('Owner 2')))).toThrow();
  });

  it('creates pairing challenges with freshness', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const challenge = createPairingChallenge(owner);
    expect(challenge.ownerDeviceId).toBe(owner.id);
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects challenge creation by non-owner', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const nonOwner = makeDevice('Non-Owner');
    const forgedChallenge = createPairingChallenge(nonOwner);
    const request = createPairingRequest(makeDevice('New Device'), forgedChallenge);
    const approval = createOwnerApproval(owner, request, forgedChallenge);
    expect(() => registry.enroll(request, forgedChallenge, approval)).toThrow();
  });

  it('enrolls a new device at limited trust level with valid approval', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    const { record } = enrollDevice(registry, owner, newDevice);
    expect(record.deviceId).toBe(newDevice.id);
    expect(record.initialTrustLevel).toBe('limited');
    expect(record.enrolledBy).toBe(owner.id);
  });

  it('rejects enrollment with invalid owner signature', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    const challenge = createPairingChallenge(owner);
    const request = createPairingRequest(newDevice, challenge);
    const approval = { ...createOwnerApproval(owner, request, challenge), signature: 'invalid-signature' };
    expect(() => registry.enroll(request, challenge, approval)).toThrow();
  });

  it('rejects enrollment with expired challenge', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    const challenge = createPairingChallenge(owner, 120_000, generateNonce(), Date.now() - 200_000);
    const request = createPairingRequest(newDevice, challenge);
    const approval = createOwnerApproval(owner, request, challenge);
    expect(() => registry.enroll(request, challenge, approval)).toThrow();
  });

  it('rejects replayed enrollment nonce', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    const { request } = enrollDevice(registry, owner, newDevice);
    const challenge2 = createPairingChallenge(owner);
    const request2 = createPairingRequest(makeDevice('New Device 2'), challenge2, request.nonce);
    const approval2 = createOwnerApproval(owner, request2, challenge2);
    expect(() => registry.enroll(request2, challenge2, approval2)).toThrow();
  });

  it('rejects duplicate enrollment', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    const challenge2 = createPairingChallenge(owner);
    const request2 = createPairingRequest(newDevice, challenge2);
    const approval2 = createOwnerApproval(owner, request2, challenge2);
    expect(() => registry.enroll(request2, challenge2, approval2)).toThrow();
  });

  it('promotes a device trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Promotion reason', 'trusted'));
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('trusted');
  });

  it('demotes a device trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Promotion reason', 'trusted'));
    registry.demote(newDevice.id, 'limited', authorize(owner, 'demote', newDevice.id, 'Demotion reason', 'limited'));
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('limited');
  });

  it('revokes a device', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.revoke(newDevice.id, authorize(owner, 'revoke', newDevice.id, 'Compromised'));
    expect(registry.isRevoked(newDevice.id)).toBe(true);
    expect(registry.canSync(newDevice.id)).toBe(false);
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
  });

  it('lists devices by trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const dev1 = makeDevice('Device 1');
    const dev2 = makeDevice('Device 2');
    enrollDevice(registry, owner, dev1);
    enrollDevice(registry, owner, dev2);
    registry.promote(dev1.id, 'trusted', authorize(owner, 'promote', dev1.id, 'Reason', 'trusted'));
    const trusted = registry.listByTrust('trusted');
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.identity.id).toBe(dev1.id);
  });
});

describe('vector clocks', () => {
  it('creates empty vector clock', () => {
    const vc = emptyVectorClock();
    expect(vc).toEqual({});
  });

  it('increments vector clock', () => {
    let vc = emptyVectorClock();
    vc = incrementVectorClock(vc, 'device-a');
    expect(vc['device-a']).toBe(1);
    vc = incrementVectorClock(vc, 'device-a');
    expect(vc['device-a']).toBe(2);
  });

  it('merges vector clocks', () => {
    const vc1 = { 'device-a': 2, 'device-b': 1 };
    const vc2 = { 'device-a': 1, 'device-b': 3, 'device-c': 1 };
    const merged = mergeVectorClocks(vc1, vc2);
    expect(merged).toEqual({ 'device-a': 2, 'device-b': 3, 'device-c': 1 });
  });

  it('compares vector clocks', () => {
    const vc1 = { 'device-a': 1 };
    const vc2 = { 'device-a': 2 };
    expect(compareVectorClocks(vc1, vc2)).toBe('less');
    expect(compareVectorClocks(vc2, vc1)).toBe('greater');
    expect(compareVectorClocks(vc1, vc1)).toBe('equal');
    const vc3 = { 'device-a': 1, 'device-b': 2 };
    const vc4 = { 'device-a': 2, 'device-b': 1 };
    expect(compareVectorClocks(vc3, vc4)).toBe('concurrent');
  });
});

describe('encryption', () => {
  it('derives shared keys via ECDH', () => {
    const kp1 = generateDeviceEncryptionKeyPair();
    const kp2 = generateDeviceEncryptionKeyPair();
    const shared1 = deriveSharedKey(kp1.privateKey, kp2.publicKey);
    const shared2 = deriveSharedKey(kp2.privateKey, kp1.publicKey);
    expect(shared1.equals(shared2)).toBe(true);
  });

  it('generates ephemeral key pairs', () => {
    const ephemeral = generateEphemeralKeyPair();
    expect(ephemeral.publicKey).toBeDefined();
    expect(ephemeral.privateKey).toBeDefined();
  });

  it('encrypts and decrypts payloads', () => {
    const kp1 = generateDeviceEncryptionKeyPair();
    const kp2 = generateDeviceEncryptionKeyPair();
    const sharedKey = deriveSharedKey(kp1.privateKey, kp2.publicKey);
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, sharedKey);
    const decrypted = decryptPayload(encrypted, sharedKey);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts for device', () => {
    const kp = generateDeviceEncryptionKeyPair();
    const sharedKey = deriveSharedKey(kp.privateKey, kp.publicKey);
    const plaintext = 'Secret message';
    const encrypted = encryptForDevice(plaintext, sharedKey, kp.publicKey);
    const decrypted = decryptForDevice(encrypted, kp.privateKey);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong key', () => {
    const kp1 = generateDeviceEncryptionKeyPair();
    const kp2 = generateDeviceEncryptionKeyPair();
    const sharedKey = deriveSharedKey(kp1.privateKey, kp1.publicKey);
    const encrypted = encryptForDevice('Secret', sharedKey, kp1.publicKey);
    expect(() => decryptForDevice(encrypted, kp2.privateKey)).toThrow();
  });
});

describe('conflict resolution', () => {
  it('detects conflicts', () => {
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 100, deviceId: 'b', sequence: 1 };
    expect(hasConflict(c1, c2)).toBe(true);
  });

  it('does not detect conflicts for different paths', () => {
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.email', operation: 'set', value: 'bob@example.com', timestamp: 100, deviceId: 'b', sequence: 1 };
    expect(hasConflict(c1, c2)).toBe(false);
  });

  it('resolves conflicts with remote-wins policy', () => {
    const policy = createDefaultConflictPolicy();
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 200, deviceId: 'b', sequence: 1 };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('remote');
  });

  it('resolves conflicts with local-wins policy', () => {
    const policy: ConflictPolicy = { defaultResolution: 'local-wins', pathPolicies: {} };
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 200, deviceId: 'b', sequence: 1 };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('local');
  });

  it('merges compatible object changes', () => {
    const policy: ConflictPolicy = { defaultResolution: 'merge', pathPolicies: {} };
    const c1: SyncChange = { path: 'user.prefs', operation: 'set', value: { theme: 'dark' }, timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.prefs', operation: 'set', value: { fontSize: 14 }, timestamp: 100, deviceId: 'b', sequence: 1 };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('merged');
    expect(record.mergedValue).toEqual({ theme: 'dark', fontSize: 14 });
  });

  it('falls back to LWW when merge fails', () => {
    const policy: ConflictPolicy = { defaultResolution: 'merge', pathPolicies: {} };
    const c1: SyncChange = { path: 'user.prefs', operation: 'set', value: { theme: 'dark' }, timestamp: 100, deviceId: 'a', sequence: 1 };
    const c2: SyncChange = { path: 'user.prefs', operation: 'set', value: { theme: 'light' }, timestamp: 200, deviceId: 'b', sequence: 1 };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('remote');
  });
});

describe('sync engine', () => {
  it('records changes and returns vector clock', () => {
    const engine = new InMemorySyncEngine();
    const change: SyncChange = { path: 'test.path', operation: 'set', value: 'test-value', timestamp: Date.now(), deviceId: 'device-a' };
    engine.recordChange('device-a', change);
    const vc = engine.getVectorClock('device-a');
    expect(vc['device-a']).toBe(1);
  });

  it('applies delta and returns result', () => {
    const engine = new InMemorySyncEngine();
    const change: SyncChange = { path: 'test.path', operation: 'set', value: 'test-value', timestamp: Date.now(), deviceId: 'device-a' };
    engine.recordChange('device-a', change);
    const delta = { changes: [change], vectorClock: { 'device-a': 1 }, senderDeviceId: 'device-a' };
    const result = engine.apply('device-b', delta);
    expect(result.applied).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it('detects conflicts during sync', () => {
    const engine = new InMemorySyncEngine();
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'device-a' };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 100, deviceId: 'device-b' };
    engine.recordChange('device-a', c1);
    engine.recordChange('device-b', c2);
    const delta = { changes: [c2], vectorClock: { 'device-b': 1 }, senderDeviceId: 'device-b' };
    const result = engine.apply('device-a', delta);
    expect(result.conflicts).toHaveLength(1);
  });

  it('rejects replayed changes', () => {
    const engine = new InMemorySyncEngine();
    const change: SyncChange = { path: 'test.path', operation: 'set', value: 'test-value', timestamp: 100, deviceId: 'device-a' };
    engine.recordChange('device-a', change);
    const delta = { changes: [change], vectorClock: { 'device-a': 1 }, senderDeviceId: 'device-a' };
    const result1 = engine.apply('device-b', delta);
    expect(result1.applied).toHaveLength(1);
    const result2 = engine.apply('device-b', delta);
    expect(result2.applied).toHaveLength(0);
  });

  it('sends only changes the requester has not seen', () => {
    const engine = new InMemorySyncEngine();
    const c1: SyncChange = { path: 'a', operation: 'set', value: 1, timestamp: 1, deviceId: 'device-a' };
    const c2: SyncChange = { path: 'b', operation: 'set', value: 2, timestamp: 2, deviceId: 'device-a' };
    engine.recordChange('device-a', c1);
    engine.recordChange('device-a', c2);
    const fresh = engine.sync('device-b', {});
    expect(fresh.changes).toHaveLength(2);
    expect(fresh.senderDeviceId).toBe('device-b');
    const caughtUp = engine.sync('device-b', fresh.vectorClock);
    expect(caughtUp.changes).toHaveLength(0);
  });
});

describe('presence manager', () => {
  it('acquires a lease', () => {
    const pm = new InMemoryPresenceManager();
    const lease = pm.acquireLease('device-a', 30_000);
    expect(lease.deviceId).toBe('device-a');
    expect(lease.ttlMs).toBe(30_000);
  });

  it('renews a lease', () => {
    const pm = new InMemoryPresenceManager();
    pm.acquireLease('device-a', 30_000);
    const renewed = pm.renewLease('device-a');
    expect(renewed.deviceId).toBe('device-a');
  });

  it('releases a lease', () => {
    const pm = new InMemoryPresenceManager();
    pm.acquireLease('device-a', 30_000);
    pm.releaseLease('device-a');
    const presence = pm.getPresence('device-a');
    expect(presence.lease).toBeNull();
    expect(presence.status).toBe('offline');
  });

  it('expires leases', () => {
    const pm = new InMemoryPresenceManager();
    pm.acquireLease('device-a', 30_000);
    const expired = pm.expireLeases(Date.now() + 30_001);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.deviceId).toBe('device-a');
  });

  it('clamps TTL to bounds', () => {
    const pm = new InMemoryPresenceManager();
    const lease = pm.acquireLease('device-a', 1_000);
    expect(lease.ttlMs).toBe(5_000);
  });

  it('rejects lease acquisition for revoked device', () => {
    const registry = new InMemoryDeviceRegistry();
    const pm = new InMemoryPresenceManager(registry);
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.revoke(newDevice.id, authorize(owner, 'revoke', newDevice.id, 'Compromised'));
    expect(() => pm.acquireLease(newDevice.id, 30_000)).toThrow();
  });

  it('rejects lease renewal for revoked device', () => {
    const registry = new InMemoryDeviceRegistry();
    const pm = new InMemoryPresenceManager(registry);
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    pm.acquireLease(newDevice.id, 30_000);
    registry.revoke(newDevice.id, authorize(owner, 'revoke', newDevice.id, 'Compromised'));
    expect(() => pm.renewLease(newDevice.id)).toThrow();
  });
});

describe('remote commands', () => {
  function setup() {
    const registry = new InMemoryDeviceRegistry();
    const engine = new InMemoryRemoteCommandEngine();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const target = makeDevice('Target');
    enrollDevice(registry, owner, target);
    registry.promote(target.id, 'trusted', authorize(owner, 'promote', target.id, 'Promotion', 'trusted'));
    engine.setRegistry(registry);
    return { registry, engine, owner, target };
  }

  it('issues a command with valid signature', () => {
    const { engine, owner, target } = setup();
    const timestamp = Date.now();
    const commandData = JSON.stringify({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
    });
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1', requiredCapabilities: [],
      signature: signWithDeviceKey(target.privateKey, commandData),
    });
    expect(result.success).toBe(true);
    expect(result.commandId).toBe('cmd-1');
  });

  it('denies commands from revoked devices', () => {
    const { registry, engine, owner, target } = setup();
    registry.revoke(target.id, authorize(owner, 'revoke', target.id, 'Compromised'));
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp: Date.now(), nonce: 'nonce-1', requiredCapabilities: [],
      signature: 'sig',
    });
    expect(result.success).toBe(false);
  });

  it('denies STOP ALL from non-owner', () => {
    const { engine, owner, target } = setup();
    const result = engine.issue({
      id: 'cmd-1', kind: 'stop-all', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp: Date.now(), nonce: 'nonce-1', requiredCapabilities: [],
      signature: 'sig',
    });
    expect(result.success).toBe(false);
  });

  it('rejects replayed command nonces', () => {
    const { engine, owner, target } = setup();
    const nonce = 'replay-nonce';
    const timestamp = Date.now();
    const commandData = JSON.stringify({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce,
    });
    const sig = signWithDeviceKey(target.privateKey, commandData);
    const cmd = {
      id: 'cmd-1', kind: 'ping' as const, sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce, requiredCapabilities: [], signature: sig,
    };
    const result1 = engine.issue(cmd);
    expect(result1.success).toBe(true);
    const result2 = engine.issue(cmd);
    expect(result2.success).toBe(false);
  });

  it('retrieves a command result', () => {
    const { engine, owner, target } = setup();
    const timestamp = Date.now();
    const commandData = JSON.stringify({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
    });
    engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1', requiredCapabilities: [],
      signature: signWithDeviceKey(target.privateKey, commandData),
    });
    const result = engine.get('cmd-1');
    expect(result).not.toBeNull();
    expect(result?.commandId).toBe('cmd-1');
  });

  it('lists commands by device', () => {
    const { engine, owner, target } = setup();
    const timestamp = Date.now();
    const cmd1Data = JSON.stringify({ id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id, payload: {}, timestamp, nonce: 'n1' });
    const cmd2Data = JSON.stringify({ id: 'cmd-2', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id, payload: {}, timestamp, nonce: 'n2' });
    engine.issue({ id: 'cmd-1', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id, payload: {}, timestamp, nonce: 'n1', requiredCapabilities: [], signature: signWithDeviceKey(target.privateKey, cmd1Data) });
    engine.issue({ id: 'cmd-2', kind: 'ping', sourceDeviceId: target.id, targetDeviceId: owner.id, payload: {}, timestamp, nonce: 'n2', requiredCapabilities: [], signature: signWithDeviceKey(target.privateKey, cmd2Data) });
    const results = engine.list(owner.id);
    expect(results).toHaveLength(2);
  });
});

describe('audit journal', () => {
  it('records actions', () => {
    const journal = new InMemoryAuditJournal();
    const record = journal.record('device-enrolled', 'device-a', { deviceId: 'device-b' });
    expect(record.action).toBe('device-enrolled');
    expect(record.deviceId).toBe('device-a');
  });

  it('lists records by device', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    const records = journal.list('device-a');
    expect(records).toHaveLength(1);
  });

  it('lists records by action', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    const records = journal.list(undefined, 'device-enrolled');
    expect(records).toHaveLength(1);
  });

  it('verifies untampered log', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    expect(journal.verify()).toBe(true);
  });

  it('detects tampering', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    const [first] = journal.list();
    if (!first) throw new Error('expected a record');
    internalRecords(journal)[0] = { ...first, action: 'device-revoked' };
    expect(journal.verify()).toBe(false);
  });

  it('exposes tail hash and record count', () => {
    const journal = new InMemoryAuditJournal();
    expect(journal.getTailHash()).toBe('GENESIS');
    expect(journal.getRecordCount()).toBe(0);
    journal.record('device-enrolled', 'device-a', {});
    expect(journal.getRecordCount()).toBe(1);
    expect(journal.getTailHash()).not.toBe('GENESIS');
  });

  it('detects deleted audit records against an anchor', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    const anchor = journal.anchor();
    replaceRecords(journal, journal.list().slice(0, 1));
    expect(journal.verifyAgainstAnchor(anchor)).toBe(false);
  });

  it('cannot detect deleted records without an anchor', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    replaceRecords(journal, journal.list().slice(0, 1));
    expect(journal.verify()).toBe(true);
  });
});
