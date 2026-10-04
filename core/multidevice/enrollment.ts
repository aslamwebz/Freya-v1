import { generateNonce, signWithDeviceKey, verifyWithDeviceKey, type DeviceSecrets } from './device-identity.js';
import type {
  DeviceIdentity,
  OwnerAction,
  OwnerApproval,
  OwnerAuthorization,
  PairingChallenge,
  PairingRequest,
  DeviceTrustLevel,
} from './types.js';

/** How long a pairing challenge stays valid. */
export const CHALLENGE_TTL_MS = 120_000;
/** Tolerated future clock skew on any timestamped request. */
export const MAX_CLOCK_SKEW_MS = 30_000;
/** How old a pairing/approval/authorization timestamp may be. */
export const MAX_REQUEST_AGE_MS = 300_000;

function withinFreshnessWindow(timestamp: number, now: number): boolean {
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp > now + MAX_CLOCK_SKEW_MS) return false;
  if (timestamp < now - MAX_REQUEST_AGE_MS) return false;
  return true;
}

export function challengeTranscript(challenge: Omit<PairingChallenge, 'signature'>): string {
  return [
    'freya-pairing-challenge-v1',
    challenge.ownerDeviceId,
    challenge.nonce,
    String(challenge.issuedAt),
    String(challenge.expiresAt),
  ].join('|');
}

export function createPairingChallenge(
  owner: DeviceSecrets,
  ttlMs: number = CHALLENGE_TTL_MS,
  nonce: string = generateNonce(),
  now: number = Date.now()
): PairingChallenge {
  const body = {
    ownerDeviceId: owner.id,
    nonce,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  return { ...body, signature: signWithDeviceKey(owner.privateKey, challengeTranscript(body)) };
}

export function verifyChallenge(
  ownerPublicKey: string,
  challenge: PairingChallenge,
  now: number = Date.now()
): boolean {
  if (!Number.isFinite(challenge.issuedAt) || !Number.isFinite(challenge.expiresAt)) return false;
  if (challenge.expiresAt <= challenge.issuedAt) return false;
  // Freshness: not expired, and not issued absurdly far in the future.
  if (now > challenge.expiresAt) return false;
  if (challenge.issuedAt > now + MAX_CLOCK_SKEW_MS) return false;
  return verifyWithDeviceKey(ownerPublicKey, challengeTranscript(challenge), challenge.signature);
}

export function responseTranscript(
  deviceId: string,
  challengeNonce: string,
  timestamp: number,
  requestNonce: string
): string {
  return ['freya-pairing-response-v1', deviceId, challengeNonce, String(timestamp), requestNonce].join('|');
}

export function createPairingRequest(
  device: DeviceSecrets,
  challenge: PairingChallenge,
  nonce: string = generateNonce(),
  now: number = Date.now()
): PairingRequest {
  const response = signWithDeviceKey(
    device.privateKey,
    responseTranscript(device.id, challenge.nonce, now, nonce)
  );
  return {
    deviceIdentity: {
      id: device.id,
      publicKey: device.publicKey,
      encryptionPublicKey: device.encryptionPublicKey,
      displayName: device.displayName,
      platform: device.platform,
      createdAt: device.createdAt,
    },
    challengeNonce: challenge.nonce,
    timestamp: now,
    nonce,
    response,
  };
}

export function verifyPairingResponse(request: PairingRequest, now: number = Date.now()): boolean {
  const identity = request.deviceIdentity;
  if (!identity || typeof identity.id !== 'string' || identity.id.length === 0) return false;
  if (typeof identity.publicKey !== 'string' || identity.publicKey.length === 0) return false;
  if (typeof identity.encryptionPublicKey !== 'string' || identity.encryptionPublicKey.length === 0) return false;
  if (!withinFreshnessWindow(request.timestamp, now)) return false;
  return verifyWithDeviceKey(
    identity.publicKey,
    responseTranscript(identity.id, request.challengeNonce, request.timestamp, request.nonce),
    request.response
  );
}

export function approvalTranscript(deviceId: string, challengeNonce: string, approvedAt: number): string {
  return ['freya-pairing-approval-v1', deviceId, challengeNonce, String(approvedAt)].join('|');
}

export function createOwnerApproval(
  owner: DeviceSecrets,
  request: PairingRequest,
  challenge: PairingChallenge,
  now: number = Date.now()
): OwnerApproval {
  return {
    approverDeviceId: owner.id,
    approvedAt: now,
    challengeNonce: challenge.nonce,
    deviceId: request.deviceIdentity.id,
    signature: signWithDeviceKey(owner.privateKey, approvalTranscript(request.deviceIdentity.id, challenge.nonce, now)),
  };
}

export function verifyOwnerApproval(
  ownerPublicKey: string,
  request: PairingRequest,
  challenge: PairingChallenge,
  approval: OwnerApproval,
  now: number = Date.now()
): boolean {
  if (approval.challengeNonce !== challenge.nonce) return false;
  if (approval.deviceId !== request.deviceIdentity.id) return false;
  if (approval.approverDeviceId !== challenge.ownerDeviceId) return false;
  if (!withinFreshnessWindow(approval.approvedAt, now)) return false;
  return verifyWithDeviceKey(
    ownerPublicKey,
    approvalTranscript(approval.deviceId, approval.challengeNonce, approval.approvedAt),
    approval.signature
  );
}

export function ownerAuthorizationTranscript(authorization: Omit<OwnerAuthorization, 'signature'>): string {
  return [
    'freya-owner-authorization-v1',
    authorization.ownerDeviceId,
    authorization.action,
    authorization.subjectDeviceId,
    authorization.level ?? '-',
    authorization.reason,
    String(authorization.issuedAt),
    authorization.nonce,
  ].join('|');
}

export function createOwnerAuthorization(
  owner: DeviceSecrets,
  action: OwnerAction,
  subjectDeviceId: string,
  reason: string,
  level: DeviceTrustLevel | null = null,
  nonce: string = generateNonce(),
  now: number = Date.now()
): OwnerAuthorization {
  const body = {
    ownerDeviceId: owner.id,
    action,
    subjectDeviceId,
    level,
    reason,
    issuedAt: now,
    nonce,
  };
  return { ...body, signature: signWithDeviceKey(owner.privateKey, ownerAuthorizationTranscript(body)) };
}

export function verifyOwnerAuthorization(
  ownerPublicKey: string,
  authorization: OwnerAuthorization,
  action: OwnerAction,
  subjectDeviceId: string,
  now: number = Date.now()
): boolean {
  if (authorization.action !== action) return false;
  if (authorization.subjectDeviceId !== subjectDeviceId) return false;
  if (!withinFreshnessWindow(authorization.issuedAt, now)) return false;
  return verifyWithDeviceKey(
    ownerPublicKey,
    ownerAuthorizationTranscript(authorization),
    authorization.signature
  );
}

export function sameIdentity(a: DeviceIdentity, b: DeviceIdentity): boolean {
  return (
    a.id === b.id &&
    a.publicKey === b.publicKey &&
    a.encryptionPublicKey === b.encryptionPublicKey
  );
}
