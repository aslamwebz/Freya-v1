import { randomBytes, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { DeviceAttestation, DeviceId, DeviceIdentity, DevicePlatform } from './types.js';

export interface DeviceSigningKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface DeviceEncryptionKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface DeviceKeyMaterial {
  readonly signing: DeviceSigningKeyPair;
  readonly encryption: DeviceEncryptionKeyPair;
}

export function generateDeviceId(): DeviceId {
  return randomBytes(32).toString('hex');
}

export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Ed25519 signing key pair. Ed25519 is used only for signatures; it is not a
 * key-agreement primitive and must never be used to encrypt a key directly.
 */
export function generateDeviceSigningKeyPair(): DeviceSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/** X25519 key-agreement key pair. Used only to derive wrapping keys. */
export function generateDeviceEncryptionKeyPair(): DeviceEncryptionKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function generateDeviceKeyPair(): DeviceKeyMaterial {
  return {
    signing: generateDeviceSigningKeyPair(),
    encryption: generateDeviceEncryptionKeyPair(),
  };
}

export interface DeviceSecrets extends DeviceIdentity {
  /** Ed25519 private key (PEM). Never leaves the device. */
  readonly privateKey: string;
  /** X25519 private key (PEM). Never leaves the device. */
  readonly encryptionPrivateKey: string;
}

export function createDeviceIdentity(
  displayName: string,
  platform: DevicePlatform,
  id: DeviceId = generateDeviceId(),
  keys: DeviceKeyMaterial = generateDeviceKeyPair()
): DeviceSecrets {
  return {
    id,
    publicKey: keys.signing.publicKey,
    encryptionPublicKey: keys.encryption.publicKey,
    displayName,
    platform,
    createdAt: Date.now(),
    privateKey: keys.signing.privateKey,
    encryptionPrivateKey: keys.encryption.privateKey,
  };
}

/**
 * Ed25519 is a pure EdDSA scheme: it hashes internally, so the message must be
 * signed without an additional digest algorithm. Passing `'SHA256'` here — as
 * the untrusted first cut did — makes every signature fail.
 */
export function signWithDeviceKey(privateKey: string, data: string): string {
  return sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64');
}

export function verifyWithDeviceKey(publicKey: string, data: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(data, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function deviceAttestationPayload(identity: DeviceIdentity): string {
  return [
    'freya-device-attestation-v1',
    identity.id,
    identity.publicKey,
    identity.encryptionPublicKey,
    String(identity.createdAt),
  ].join('|');
}

export function attestDeviceIdentity(identity: DeviceIdentity, signingPrivateKey: string): DeviceAttestation {
  return {
    deviceId: identity.id,
    publicKey: identity.publicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    issuedAt: Date.now(),
    signature: signWithDeviceKey(signingPrivateKey, deviceAttestationPayload(identity)),
  };
}

export function verifyDeviceAttestation(identity: DeviceIdentity, attestation: DeviceAttestation): boolean {
  if (attestation.deviceId !== identity.id) return false;
  if (attestation.publicKey !== identity.publicKey) return false;
  if (attestation.encryptionPublicKey !== identity.encryptionPublicKey) return false;
  return verifyWithDeviceKey(identity.publicKey, deviceAttestationPayload(identity), attestation.signature);
}
