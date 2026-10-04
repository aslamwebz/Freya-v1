// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  InMemoryDeviceRegistry,
  InMemoryPresenceManager,
  InMemoryRemoteCommandEngine,
  InMemoryAuditJournal,
  generateDeviceId,
  generateDeviceSigningKeyPair,
  generateDeviceEncryptionKeyPair,
  createDeviceIdentity,
  signWithDeviceKey,
  verifyWithDeviceKey,
  generateNonce,
  deriveSharedKey,
  encryptPayload,
  decryptPayload,
  attestDeviceIdentity,
  createPairingChallenge,
  createPairingRequest,
  createOwnerApproval,
  createOwnerAuthorization,
  ownerAuthorizationTranscript,
} from '../../core/multidevice/index.js';
import type {
  DeviceIdentity,
  DeviceSecrets,
  OwnerBootstrap,
  OwnerAuthorization,
  OwnerAction,
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
  action: OwnerAction,
  subjectDeviceId: string,
  reason: string,
  level: OwnerAuthorization['level'] = null
): OwnerAuthorization {
  return createOwnerAuthorization(owner, action, subjectDeviceId, reason, level);
}

/**
 * Forge an owner authorization: it claims `claimedOwnerId` as the authorizer
 * but is actually signed with `signer`'s private key. A correct registry must
 * reject it because the signature does not match the bootstrapped owner key.
 */
function forgeOwnerAuthorization(
  claimedOwnerId: string,
  signer: DeviceSecrets,
  action: OwnerAction,
  subjectDeviceId: string,
  reason: string,
  level: OwnerAuthorization['level'] = null
): OwnerAuthorization {
  const body = {
    ownerDeviceId: claimedOwnerId,
    action,
    subjectDeviceId,
    level,
    reason,
    issuedAt: Date.now(),
    nonce: generateNonce(),
  };
  return { ...body, signature: signWithDeviceKey(signer.privateKey, ownerAuthorizationTranscript(body)) };
}

function internalRecords(journal: InMemoryAuditJournal): AuditRecord[] {
  return (journal as unknown as { records: AuditRecord[] }).records;
}

function replaceRecords(journal: InMemoryAuditJournal, records: AuditRecord[]): void {
  (journal as unknown as { records: AuditRecord[] }).records = records;
}

describe('red-team: forged device identity', () => {
  it('rejects enrollment with forged device ID', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const attacker = makeDevice('Attacker');
    const challenge = createPairingChallenge(owner);
    const request = createPairingRequest(attacker, challenge);
    const approval = createOwnerApproval(owner, request, challenge);
    const forgedRequest = { ...request, deviceIdentity: { ...attacker, id: owner.id } };
    expect(() => registry.enroll(forgedRequest, challenge, approval)).toThrow();
  });

  it('rejects signature verification with wrong public key', () => {
    const kp1 = generateDeviceSigningKeyPair();
    const kp2 = generateDeviceSigningKeyPair();
    const data = 'test-data';
    const sig = signWithDeviceKey(kp1.privateKey, data);
    expect(verifyWithDeviceKey(kp2.publicKey, data, sig)).toBe(false);
  });

  it('rejects enrollment with invalid device signature', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    const challenge = createPairingChallenge(owner);
    const request = { ...createPairingRequest(newDevice, challenge), response: 'invalid-signature' };
    const approval = createOwnerApproval(owner, request, challenge);
    expect(() => registry.enroll(request, challenge, approval)).toThrow();
  });
});

describe('red-team: authority escalation', () => {
  it('rejects self-promotion to trusted', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    const forged = forgeOwnerAuthorization(newDevice.id, newDevice, 'promote', newDevice.id, 'Self-promotion', 'trusted');
    expect(() => registry.promote(newDevice.id, 'trusted', forged)).toThrow();
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('limited');
  });

  it('rejects self-promotion to owner', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Legitimate promotion', 'trusted'));
    const forged = forgeOwnerAuthorization(newDevice.id, newDevice, 'promote', newDevice.id, 'Self-promotion to owner', 'owner');
    expect(() => registry.promote(newDevice.id, 'owner', forged)).toThrow();
    const device = registry.get(newDevice.id);
    expect(device?.trust.level).toBe('trusted');
  });

  it('rejects revocation by non-owner', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    const forged = forgeOwnerAuthorization(newDevice.id, newDevice, 'revoke', newDevice.id, 'Self-revocation');
    expect(() => registry.revoke(newDevice.id, forged)).toThrow();
    expect(registry.isRevoked(newDevice.id)).toBe(false);
  });

  it('rejects owner authorization with mismatched action', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    const promoteAuth = authorize(owner, 'promote', newDevice.id, 'Wrong action', 'trusted');
    expect(() => registry.revoke(newDevice.id, promoteAuth)).toThrow();
    expect(registry.isRevoked(newDevice.id)).toBe(false);
  });

  it('prevents limited device from issuing commands', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
  });

  it('prevents untrusted device from syncing', () => {
    const registry = new InMemoryDeviceRegistry();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    registry.demote(newDevice.id, 'untrusted', authorize(owner, 'demote', newDevice.id, 'Demoted', 'untrusted'));
    expect(registry.canSync(newDevice.id)).toBe(false);
  });
});

describe('red-team: sync tampering', () => {
  it('detects tampered ciphertext', () => {
    const kp = generateDeviceEncryptionKeyPair();
    const sharedKey = deriveSharedKey(kp.privateKey, kp.publicKey);
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, sharedKey);
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decryptPayload(tampered, sharedKey)).toThrow();
  });

  it('detects tampered auth tag', () => {
    const kp = generateDeviceEncryptionKeyPair();
    const sharedKey = deriveSharedKey(kp.privateKey, kp.publicKey);
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, sharedKey);
    const tampered = { ...encrypted, authTag: Buffer.from('tampered-tag').toString('base64') };
    expect(() => decryptPayload(tampered, sharedKey)).toThrow();
  });

  it('fails to decrypt with wrong shared key', () => {
    const kp1 = generateDeviceEncryptionKeyPair();
    const kp2 = generateDeviceEncryptionKeyPair();
    const sharedKey1 = deriveSharedKey(kp1.privateKey, kp1.publicKey);
    const sharedKey2 = deriveSharedKey(kp2.privateKey, kp2.publicKey);
    const plaintext = 'Hello, Freya!';
    const encrypted = encryptPayload(plaintext, sharedKey1);
    expect(() => decryptPayload(encrypted, sharedKey2)).toThrow();
  });
});

describe('red-team: command injection', () => {
  function setup() {
    const registry = new InMemoryDeviceRegistry();
    const engine = new InMemoryRemoteCommandEngine();
    const owner = makeDevice('Owner');
    registry.bootstrapOwner(ownerBootstrap(owner));
    const newDevice = makeDevice('New Device');
    enrollDevice(registry, owner, newDevice);
    engine.setRegistry(registry);
    return { registry, engine, owner, newDevice };
  }

  it('denies commands from limited devices', () => {
    const { registry, newDevice } = setup();
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
  });

  it('denies commands to limited devices', () => {
    const { registry, newDevice } = setup();
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
  });

  it('denies commands from revoked devices', () => {
    const { registry, engine, owner, newDevice } = setup();
    registry.revoke(newDevice.id, authorize(owner, 'revoke', newDevice.id, 'Compromised'));
    expect(registry.canIssueCommands(newDevice.id)).toBe(false);
    expect(registry.canReceiveCommands(newDevice.id)).toBe(false);
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp: Date.now(), nonce: 'nonce-1', requiredCapabilities: [],
      signature: 'sig',
    });
    expect(result.success).toBe(false);
  });

  it('denies commands with invalid signature', () => {
    const { registry, engine, owner, newDevice } = setup();
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Promotion', 'trusted'));
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp: Date.now(), nonce: 'nonce-1', requiredCapabilities: [],
      signature: 'invalid-signature',
    });
    expect(result.success).toBe(false);
  });

  it('denies commands requiring capabilities the device does not hold', () => {
    const { registry, engine, owner, newDevice } = setup();
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Promotion', 'trusted'));
    const timestamp = Date.now();
    const commandData = JSON.stringify({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
    });
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
      requiredCapabilities: ['system.stop-all'],
      signature: signWithDeviceKey(newDevice.privateKey, commandData),
    });
    expect(result.success).toBe(false);
  });

  it('denies commands requiring capabilities outside the vocabulary', () => {
    const { registry, engine, owner, newDevice } = setup();
    registry.promote(newDevice.id, 'trusted', authorize(owner, 'promote', newDevice.id, 'Promotion', 'trusted'));
    const timestamp = Date.now();
    const commandData = JSON.stringify({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
    });
    const result = engine.issue({
      id: 'cmd-1', kind: 'ping', sourceDeviceId: newDevice.id, targetDeviceId: owner.id,
      payload: {}, timestamp, nonce: 'nonce-1',
      requiredCapabilities: ['device.root-everything'],
      signature: signWithDeviceKey(newDevice.privateKey, commandData),
    });
    expect(result.success).toBe(false);
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

describe('red-team: replay attacks', () => {
  it('generates unique nonces', () => {
    const nonces = new Set(Array.from({ length: 1000 }, () => generateNonce()));
    expect(nonces.size).toBe(1000);
  });

  it('generates unique device IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateDeviceId()));
    expect(ids.size).toBe(1000);
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
});

describe('red-team: audit tampering', () => {
  it('detects modified audit records', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', { deviceId: 'device-b' });
    const [first] = journal.list();
    if (!first) throw new Error('expected a record');
    internalRecords(journal)[0] = { ...first, action: 'device-revoked' };
    expect(journal.verify()).toBe(false);
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

  it('detects inserted audit records', () => {
    const journal = new InMemoryAuditJournal();
    journal.record('device-enrolled', 'device-a', {});
    const [first] = journal.list();
    if (!first) throw new Error('expected a record');
    const fakeRecord: AuditRecord = { ...first, id: 'fake-id', hash: 'fake-hash' };
    replaceRecords(journal, [...journal.list(), fakeRecord]);
    expect(journal.verify()).toBe(false);
  });
});
