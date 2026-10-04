// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  InMemoryDeviceRegistry,
  InMemorySyncEngine,
  InMemoryPresenceManager,
  InMemoryRemoteCommandEngine,
  InMemoryAuditJournal,
  createDeviceTrust,
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

describe('red-team: forged device identity', () => {
  it('rejects enrollment with forged device ID', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const attacker = makeDevice('Attacker');
    const forgedIdentity: DeviceIdentity = {
      ...attacker,
      id: owner.id,
    };
    const request = { deviceIdentity: forgedIdentity, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    expect(() => registry.enroll(request, approval)).toThrow();
  });

  it('rejects signature verification with wrong public key', () => {
    const kp1 = generateDeviceKeyPair();
    const kp2 = generateDeviceKeyPair();
    const data = 'test-data';
    const sig = signWithDeviceKey(kp1.privateKey, data);
    expect(verifyWithDeviceKey(kp2.publicKey, data, sig)).toBe(false);
  });
});

describe('red-team: authority escalation', () => {
  it('rejects self-promotion to trusted', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(() => registry.promote(newDevice.id, 'trusted', newDevice.id, 'Self-promotion')).toThrow();
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('limited');
  });

  it('rejects self-promotion to owner', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.promote(newDevice.id, 'trusted', owner.id, 'Legitimate promotion');
    expect(() => registry.promote(newDevice.id, 'owner', newDevice.id, 'Self-promotion to owner')).toThrow();
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('trusted');
  });

  it('rejects revocation by non-owner', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(() => registry.revoke(newDevice.id, newDevice.id, 'Self-revocation')).toThrow();
    expect(registry.isRevoked(newDevice.id)).toBe(false);
  });

  it('prevents limited device from issuing commands', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
  });

  it('prevents untrusted device from syncing', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.demote(newDevice.id, 'untrusted', owner.id, 'Demoted');
    expect(registry.canSync(newDevice.id)).toBe(false);
  });
});

describe('red-team: sync tampering', () => {
  it('detects tampered ciphertext', () => {
    const key = generateSymmetricKey();
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, key);
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decryptPayload(tampered, key)).toThrow();
  });

  it('detects tampered auth tag', () => {
    const key = generateSymmetricKey();
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, key);
    const tampered = { ...encrypted, authTag: Buffer.from('tampered-tag').toString('base64') };
    expect(() => decryptPayload(tampered, key)).toThrow();
  });

  it('fails to decrypt with wrong symmetric key', () => {
    const key1 = generateSymmetricKey();
    const key2 = generateSymmetricKey();
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, key1);
    expect(() => decryptPayload(encrypted, key2)).toThrow();
  });
});

describe('red-team: command injection', () => {
  it('denies commands from limited devices', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
  });

  it('denies commands to limited devices', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
  });

  it('denies commands from revoked devices', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    registry.revoke(newDevice.id, owner.id, 'Compromised');
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
  });
});

describe('red-team: lease manipulation', () => {
  it('rejects lease renewal for non-existent lease', () => {
    const pm = new InMemoryPresenceManager();
    expect(() => pm.renewLease('non-existent')).toThrow();
  });

  it('rejects lease acquisition with expired timestamp', () => {
    const pm = new InMemoryPresenceManager();
    const lease = pm.acquireLease('device-a', 30_000);
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects lease renewal for revoked device', () => {
    const registry = new InMemoryDeviceRegistry();
    const pm = new InMemoryPresenceManager();
    const owner = makeDevice('Owner');
    const newDevice = makeDevice('New Device');
    const request = { deviceIdentity: newDevice, timestamp: Date.now(), nonce: 'nonce-1', response: 'resp-1' };
    const approval = makeOwnerApproval(owner.id);
    registry.enroll(request, approval);
    pm.acquireLease(newDevice.id, 30_000);
    registry.revoke(newDevice.id, owner.id, 'Compromised');
    expect(registry.isRevoked(newDevice.id)).toBe(true);
  });
});

describe('red-team: replay attacks', () => {
  it('generates unique nonces', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => generateNonce()));
    expect(nonces.size).toBe(1000);
  });

  it('generates unique device IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateDeviceId()));
    expect(ids.size).toBe(1000);
  });
});

describe('red-team: audit tampering', () => {
  it('detects modified audit records', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', { deviceId: 'device-b' });
    const records = journal.list();
    (journal as any).records[0] = { ...records[0], action: 'device-revoked' };
    expect(journal.verify()).toBe(false);
  });

  it('detects deleted audit records', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    journal.record('device-revoked', 'device-b', {});
    (journal as any).records = journal.list().slice(0, 1);
    expect(journal.verify()).toBe(false);
  });

  it('detects inserted audit records', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    const records = journal.list();
    const fakeRecord = { ...records[0], id: 'fake-id', hash: 'fake-hash' };
    (journal as any).records = [...records, fakeRecord];
    expect(journal.verify()).toBe(false);
  });
});
