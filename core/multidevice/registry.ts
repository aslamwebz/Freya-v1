import type {
  DeviceId,
  DeviceRecord,
  DeviceTrustLevel,
  DeviceRevocation,
  PairingRequest,
  PairingChallenge,
  EnrollmentRecord,
  OwnerApproval,
  OwnerAuthorization,
  OwnerBootstrap,
} from './types.js';
import { createDeviceTrust, canSyncRead, canSyncWrite, canIssueCommands, canReceiveCommands } from './trust.js';
import { verifyDeviceAttestation } from './device-identity.js';
import { verifyChallenge, verifyPairingResponse, verifyOwnerApproval, verifyOwnerAuthorization } from './enrollment.js';
import type { InMemoryAuditJournal } from './audit.js';

type RevocationListener = (deviceId: DeviceId, reason: string) => void;

/**
 * The device registry — the only place trust is granted.
 *
 * Two properties carry the security of this module:
 *
 *  1. There is exactly one owner, established by a local bootstrap, and it can
 *     never be created by the network-facing `enroll` path. `enroll` always
 *     produces a `limited` device, no matter what the request claims.
 *  2. Every privileged mutation (revoke, promote, demote) carries an owner
 *     signature over the action, subject, level and nonce. The registry holds
 *     only the owner *public* key, so an attacker who controls the registry
 *     process still cannot mint authority without the owner's private key.
 */
export class InMemoryDeviceRegistry {
  private devices = new Map<DeviceId, DeviceRecord>();
  private ownerId: DeviceId | null = null;
  private usedChallengeNonces = new Set<string>();
  private usedRequestNonces = new Set<string>();
  private usedAuthorizationNonces = new Set<string>();
  private revocationListeners: RevocationListener[] = [];

  constructor(private readonly audit: InMemoryAuditJournal | null = null) {}

  getOwnerId(): DeviceId | null {
    return this.ownerId;
  }

  onRevoke(listener: RevocationListener): void {
    this.revocationListeners.push(listener);
  }

  /**
   * Establish the single owner device.
   *
   * This models a local, trusted-Core-only action: the human who installed
   * Freya on this machine is the owner. It is deliberately not reachable from
   * `enroll`, and it can happen at most once and only before any other device
   * exists. The self-attestation proves the caller holds the owner's private
   * key; it is not, on its own, a grant of trust — the local call is.
   */
  bootstrapOwner(bootstrap: OwnerBootstrap): DeviceRecord {
    if (this.ownerId !== null) throw new Error('owner is already bootstrapped');
    if (this.devices.size > 0) throw new Error('cannot bootstrap an owner after devices exist');

    const { identity, attestation } = bootstrap;
    if (!identity || typeof identity.id !== 'string' || identity.id.length === 0) {
      throw new Error('owner identity is missing an id');
    }
    if (!verifyDeviceAttestation(identity, attestation)) {
      throw new Error('owner attestation is not valid');
    }

    const now = Date.now();
    const record: DeviceRecord = {
      identity,
      trust: createDeviceTrust('owner', identity.id, 'Local owner bootstrap', now),
      enrolledAt: now,
      enrolledBy: identity.id,
      lastSeenAt: now,
      status: 'active',
      revocation: null,
    };
    this.devices.set(identity.id, record);
    this.ownerId = identity.id;
    this.audit?.record('owner-bootstrapped', identity.id, { publicKey: identity.publicKey });
    return record;
  }

  enroll(
    request: PairingRequest,
    challenge: PairingChallenge,
    ownerApproval: OwnerApproval
  ): EnrollmentRecord {
    const owner = this.requireOwner();

    // 1. The challenge must be the owner's, fresh, signed and unused.
    if (challenge.ownerDeviceId !== owner.identity.id) {
      throw new Error('challenge was not issued by the owner');
    }
    if (!verifyChallenge(owner.identity.publicKey, challenge)) {
      throw new Error('challenge is expired or not signed by the owner');
    }
    if (this.usedChallengeNonces.has(challenge.nonce)) {
      throw new Error('challenge nonce has already been used');
    }

    // 2. The request must answer *this* challenge and be signed by the device.
    const identity = request.deviceIdentity;
    if (!identity || identity.id === owner.identity.id) {
      throw new Error('cannot enroll the owner device through pairing');
    }
    if (request.challengeNonce !== challenge.nonce) {
      throw new Error('pairing request does not answer the supplied challenge');
    }
    if (!verifyPairingResponse(request)) {
      throw new Error('pairing response signature is invalid or stale');
    }
    if (this.usedRequestNonces.has(request.nonce)) {
      throw new Error('pairing request nonce has already been used');
    }
    if (this.devices.has(identity.id)) {
      throw new Error(`Device ${identity.id} already enrolled`);
    }

    // 3. Explicit owner approval, bound to the same transcript.
    if (!verifyOwnerApproval(owner.identity.publicKey, request, challenge, ownerApproval)) {
      throw new Error('owner approval is missing, invalid or not bound to this request');
    }

    const now = Date.now();
    const record: DeviceRecord = {
      identity,
      trust: createDeviceTrust('limited', owner.identity.id, 'Initial enrollment', now),
      enrolledAt: now,
      enrolledBy: owner.identity.id,
      lastSeenAt: now,
      status: 'active',
      revocation: null,
    };
    this.devices.set(identity.id, record);
    this.usedChallengeNonces.add(challenge.nonce);
    this.usedRequestNonces.add(request.nonce);
    this.audit?.record('device-enrolled', owner.identity.id, {
      deviceId: identity.id,
      trustLevel: 'limited',
    });
    return {
      deviceId: identity.id,
      enrolledAt: now,
      enrolledBy: owner.identity.id,
      initialTrustLevel: 'limited',
      pairingRequestId: request.nonce,
    };
  }

  revoke(deviceId: DeviceId, authorization: OwnerAuthorization): void {
    const owner = this.requireOwner();
    const device = this.requireDevice(deviceId);
    if (deviceId === owner.identity.id) {
      throw new Error('the owner device cannot be revoked through this path');
    }
    this.assertOwnerAuthorization(owner.identity.publicKey, authorization, 'revoke', deviceId);
    if (device.status === 'revoked') throw new Error(`Device ${deviceId} is already revoked`);

    const revocation: DeviceRevocation = {
      revokedAt: Date.now(),
      revokedBy: owner.identity.id,
      reason: authorization.reason,
    };
    this.devices.set(deviceId, { ...device, status: 'revoked', revocation });
    this.usedAuthorizationNonces.add(authorization.nonce);
    this.audit?.record('device-revoked', owner.identity.id, { deviceId, reason: authorization.reason });
    for (const listener of this.revocationListeners) listener(deviceId, authorization.reason);
  }

  promote(deviceId: DeviceId, newLevel: DeviceTrustLevel, authorization: OwnerAuthorization): void {
    const owner = this.requireOwner();
    const device = this.requireDevice(deviceId);
    if (deviceId === owner.identity.id) throw new Error('the owner device cannot be promoted or demoted');
    if (newLevel === 'owner') throw new Error('there can only be one owner device');
    this.assertOwnerAuthorization(owner.identity.publicKey, authorization, 'promote', deviceId);
    if (authorization.level !== newLevel) {
      throw new Error('authorization level does not match the requested level');
    }
    const trust = createDeviceTrust(newLevel, owner.identity.id, authorization.reason);
    this.devices.set(deviceId, { ...device, trust });
    this.usedAuthorizationNonces.add(authorization.nonce);
    this.audit?.record('trust-promoted', owner.identity.id, { deviceId, newLevel });
  }

  demote(deviceId: DeviceId, newLevel: DeviceTrustLevel, authorization: OwnerAuthorization): void {
    const owner = this.requireOwner();
    const device = this.requireDevice(deviceId);
    if (deviceId === owner.identity.id) throw new Error('the owner device cannot be promoted or demoted');
    if (newLevel === 'owner') throw new Error('there can only be one owner device');
    this.assertOwnerAuthorization(owner.identity.publicKey, authorization, 'demote', deviceId);
    if (authorization.level !== newLevel) {
      throw new Error('authorization level does not match the requested level');
    }
    const trust = createDeviceTrust(newLevel, owner.identity.id, authorization.reason);
    this.devices.set(deviceId, { ...device, trust });
    this.usedAuthorizationNonces.add(authorization.nonce);
    this.audit?.record('trust-demoted', owner.identity.id, { deviceId, newLevel });
  }

  get(deviceId: DeviceId): DeviceRecord | null {
    return this.devices.get(deviceId) ?? null;
  }

  list(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  listByTrust(level: DeviceTrustLevel): DeviceRecord[] {
    return this.list().filter((d) => d.trust.level === level);
  }

  isRevoked(deviceId: DeviceId): boolean {
    return this.devices.get(deviceId)?.status === 'revoked';
  }

  canSync(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.status === 'revoked') return false;
    return canSyncRead(device.trust.level);
  }

  canSyncWrite(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.status === 'revoked') return false;
    return canSyncWrite(device.trust.level);
  }

  canIssueCommands(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.status === 'revoked') return false;
    return canIssueCommands(device.trust.level);
  }

  canReceiveCommands(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.status === 'revoked') return false;
    return canReceiveCommands(device.trust.level);
  }

  private requireOwner(): DeviceRecord {
    if (this.ownerId === null) throw new Error('no owner has been bootstrapped');
    const owner = this.devices.get(this.ownerId);
    if (!owner || owner.trust.level !== 'owner') throw new Error('owner record is missing');
    return owner;
  }

  private requireDevice(deviceId: DeviceId): DeviceRecord {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    return device;
  }

  private assertOwnerAuthorization(
    ownerPublicKey: string,
    authorization: OwnerAuthorization,
    action: OwnerAuthorization['action'],
    subjectDeviceId: DeviceId
  ): void {
    if (authorization.ownerDeviceId !== this.ownerId) {
      throw new Error('authorization was not issued by the owner device');
    }
    if (!verifyOwnerAuthorization(ownerPublicKey, authorization, action, subjectDeviceId)) {
      throw new Error('owner authorization signature is invalid, stale, or for another action');
    }
    if (this.usedAuthorizationNonces.has(authorization.nonce)) {
      throw new Error('owner authorization nonce has already been used');
    }
  }
}
