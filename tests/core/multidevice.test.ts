import { describe, it, expect } from 'vitest';
import {
  InMemoryDeviceRegistry,
  InMemorySyncEngine,
  InMemoryPresenceManager,
  InMemoryRemoteCommandEngine,
  InMemoryAuditJournal,
  createDeviceTrust,
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
  generateDeviceKeyPair,
  createDeviceIdentity,
  signWithDeviceKey,
  verifyWithDeviceKey,
  generateNonce,
  emptyVectorClock,
  incrementVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
  generateSymmetricKey,
  wrapSymmetricKey,
  unwrapSymmetricKey,
  encryptPayload,
  decryptPayload,
  encryptForDevice,
  decryptForDevice,
  createDefaultConflictPolicy,
  resolveConflict,
  hasConflict,
} from '../../core/multidevice/index.js';
import type { DeviceIdentity, SyncChange, ConflictPolicy } from '../../core/multidevice/index.js';

function makeDevice(name: string, platform: DeviceIdentity['platform'] = 'desktop') {
  return createDeviceIdentity(name, platform);
}

function makeOwnerApproval(approverId: string) {
  return { approverDeviceId: approverId, approvedAt: Date.now(), signature: 'test-sig' };
}

describe('device identity', () => {
  it('generates unique device IDs', () => {
    const id1 = generateDeviceId();
    const id2 = generateDeviceId();
    expect(id1).not.toBe(id2);
    expect(id1).toHaveLength(64);
  });

  it('generates valid key pairs', () => {
    const kp = generateDeviceKeyPair();
    expect(kp.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(kp.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('signs and verifies data', () => {
    const kp = generateDeviceKeyPair();
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
  it('enrolls a new device at limited trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    const record = registry.enroll(request, approval);
    expect(record.deviceId).toBe(newDevice.id);
    expect(record.initialTrustLevel).toBe('limited');
    expect(record.enrolledBy).toBe(owner.id);
  });

  it('rejects duplicate enrollment', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(() => registry.enroll(request, approval)).toThrow();
  });

  it('promotes a device trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.promote(newDevice.id, 'trusted', owner.id, 'Promotion reason');
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('trusted');
  });

  it('demotes a device trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.promote(newDevice.id, 'trusted', owner.id, 'Promotion reason');
    registry.demote(newDevice.id, 'limited', owner.id, 'Demotion reason');
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('limited');
  });

  it('revokes a device', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.revoke(newDevice.id, owner.id, 'Compromised');
    expect(registry.isRevoked(newDevice.id)).toBe(true);
    expect(registry.canSync(newDevice.id)).toBe(false);
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
  });

  it('lists devices by trust level', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const dev1 = makeDevice('Device 1');
    const dev2 = makeDevice('Device 2');
    registry.enroll({ deviceIdentity: dev1, timestamp: Date.now(), nonce: 'n1', response: 'r1' }, makeOwnerApproval(owner.id));
    registry.enroll({ deviceIdentity: dev2, timestamp: Date.now(), nonce: 'n2', response: 'r2' }, makeOwnerApproval(owner.id));
    registry.promote(dev1.id, 'trusted', owner.id, 'Reason');
    const trusted = registry.listByTrust('trusted');
    expect(trusted).toHaveLength(1);
    expect(trusted[0].identity.id).toBe(dev1.id);
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
  it('generates symmetric keys', () => {
    const key = generateSymmetricKey();
    expect(key).toHaveLength(32);
  });

  it('wraps and unwraps symmetric keys', () => {
    const kp = generateDeviceKeyPair();
    const symmetricKey = generateSymmetricKey();
    const wrapped = wrapSymmetricKey(symmetricKey, kp.publicKey);
    const unwrapped = unwrapSymmetricKey(wrapped, kp.privateKey);
    expect(unwrapped.equals(symmetricKey)).toBe(true);
  });

  it('encrypts and decrypts payloads', () => {
    const key = generateSymmetricKey();
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, key);
    const decrypted = decryptPayload(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts for device', () => {
    const kp = generateDeviceKeyPair();
    const symmetricKey = generateSymmetricKey();
    const plaintext = 'Secret message';
    const encrypted = encryptForDevice(plaintext, symmetricKey, kp.publicKey);
    const decrypted = decryptForDevice(encrypted, kp.privateKey);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with wrong key', () => {
    const kp1 = generateDeviceKeyPair();
    const kp2 = generateDeviceKeyPair();
    const symmetricKey = generateSymmetricKey();
    const encrypted = encryptForDevice('Secret', symmetricKey, kp1.publicKey);
    expect(() => decryptForDevice(encrypted, kp2.privateKey)).toThrow();
  });
});

describe('conflict resolution', () => {
  it('detects conflicts', () => {
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a' };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 100, deviceId: 'b' };
    expect(hasConflict(c1, c2)).toBe(true);
  });

  it('does not detect conflicts for different paths', () => {
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a' };
    const c2: SyncChange = { path: 'user.email', operation: 'set', value: 'bob@example.com', timestamp: 100, deviceId: 'b' };
    expect(hasConflict(c1, c2)).toBe(false);
  });

  it('resolves conflicts with remote-wins policy', () => {
    const policy = createDefaultConflictPolicy();
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a' };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 200, deviceId: 'b' };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('remote');
  });

  it('resolves conflicts with local-wins policy', () => {
    const policy: ConflictPolicy = { defaultResolution: 'local-wins', pathPolicies: {} };
    const c1: SyncChange = { path: 'user.name', operation: 'set', value: 'Alice', timestamp: 100, deviceId: 'a' };
    const c2: SyncChange = { path: 'user.name', operation: 'set', value: 'Bob', timestamp: 200, deviceId: 'b' };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('local');
  });

  it('merges compatible object changes', () => {
    const policy: ConflictPolicy = { defaultResolution: 'merge', pathPolicies: {} };
    const c1: SyncChange = { path: 'user.prefs', operation: 'set', value: { theme: 'dark' }, timestamp: 100, deviceId: 'a' };
    const c2: SyncChange = { path: 'user.prefs', operation: 'set', value: { fontSize: 14 }, timestamp: 100, deviceId: 'b' };
    const record = resolveConflict(c1, c2, policy, 'system');
    expect(record.resolution).toBe('merged');
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
    const delta = { changes: [change], vectorClock: { 'device-a': 1 } };
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
    const delta = { changes: [c2], vectorClock: { 'device-b': 1 } };
    const result = engine.apply('device-a', delta);
    expect(result.conflicts).toHaveLength(1);
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
    pm.acquireLease('device-a', 100);
    const expired = pm.expireLeases(Date.now() + 200);
    expect(expired).toHaveLength(1);
    expect(expired[0].deviceId).toBe('device-a');
  });

  it('clamps TTL to bounds', () => {
    const pm = new InMemoryPresenceManager();
    const lease = pm.acquireLease('device-a', 1_000);
    expect(lease.ttlMs).toBe(5_000);
  });
});

describe('remote commands', () => {
  it('issues a command', () => {
    const engine = new InMemoryRemoteCommandEngine();
    const result = engine.issue({
      id: 'cmd-1',
      kind: 'ping',
      sourceDeviceId: 'device-a',
      targetDeviceId: 'device-b',
      payload: {},
      timestamp: Date.now(),
      nonce: 'nonce-1',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(true);
    expect(result.commandId).toBe('cmd-1');
  });

  it('retrieves a command result', () => {
    const engine = new InMemoryRemoteCommandEngine();
    engine.issue({
      id: 'cmd-1',
      kind: 'ping',
      sourceDeviceId: 'device-a',
      targetDeviceId: 'device-b',
      payload: {},
      timestamp: Date.now(),
      nonce: 'nonce-1',
      requiredCapabilities: [],
    });
    const result = engine.get('cmd-1');
    expect(result).not.toBeNull();
    expect(result?.commandId).toBe('cmd-1');
  });

  it('lists commands by device', () => {
    const engine = new InMemoryRemoteCommandEngine();
    engine.issue({ id: 'cmd-1', kind: 'ping', sourceDeviceId: 'device-a', targetDeviceId: 'device-b', payload: {}, timestamp: Date.now(), nonce: 'n1', requiredCapabilities: [] });
    engine.issue({ id: 'cmd-2', kind: 'ping', sourceDeviceId: 'device-a', targetDeviceId: 'device-c', payload: {}, timestamp: Date.now(), nonce: 'n2', requiredCapabilities: [] });
    engine.issue({ id: 'cmd-3', kind: 'ping', sourceDeviceId: 'device-b', targetDeviceId: 'device-a', payload: {}, timestamp: Date.now(), nonce: 'n3', requiredCapabilities: [] });
    const results = engine.list('device-a');
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
    const records = journal.list();
    (journal as any).records[0] = { ...records[0], action: 'device-revoked' };
    expect(journal.verify()).toBe(false);
  });
});
