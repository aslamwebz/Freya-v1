import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';
import { generateDeviceEncryptionKeyPair, type DeviceEncryptionKeyPair } from './device-identity.js';
import type { EncryptedPayload } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const CIPHER_OPTIONS = { authTagLength: AUTH_TAG_LENGTH } as const;
const WRAP_INFO = 'freya-multidevice-key-wrap-v1';
const WRAP_VERSION = 1;

interface WrappedKeyBlob {
  readonly v: number;
  /** Ephemeral X25519 public key (PEM) used for this one wrapping. */
  readonly epk: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export function generateSymmetricKey(): Buffer {
  return randomBytes(32);
}

/**
 * A fresh X25519 key pair for a single key-wrapping operation. Every wrapped
 * payload gets its own ephemeral pair, so wrap keys are never reused.
 */
export function generateEphemeralKeyPair(): DeviceEncryptionKeyPair {
  return generateDeviceEncryptionKeyPair();
}

/**
 * X25519 ECDH followed by HKDF-SHA256.
 *
 * The previous implementation called RSA `publicEncrypt` with an Ed25519 key,
 * which throws: Ed25519 is a signature scheme and cannot encrypt. Signing and
 * key agreement are now separate keys with separate algorithms.
 */
export function deriveSharedKey(
  privateKeyPem: string,
  peerPublicKeyPem: string,
  info: string = WRAP_INFO
): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: createPublicKey(peerPublicKeyPem),
  });
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

/**
 * Wrap a symmetric key for a recipient using an ephemeral X25519 key (ECIES).
 * The recipient's static private key is the only thing that can unwrap it.
 */
export function wrapSymmetricKey(symmetricKey: Buffer, recipientEncryptionPublicKey: string): string {
  const ephemeral = generateDeviceEncryptionKeyPair();
  const wrapKey = deriveSharedKey(ephemeral.privateKey, recipientEncryptionPublicKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, wrapKey, iv, CIPHER_OPTIONS);
  const ciphertext = Buffer.concat([cipher.update(symmetricKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob: WrappedKeyBlob = {
    v: WRAP_VERSION,
    epk: ephemeral.publicKey,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
  };
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64');
}

export function unwrapSymmetricKey(wrappedKey: string, recipientEncryptionPrivateKey: string): Buffer {
  let blob: WrappedKeyBlob;
  try {
    blob = JSON.parse(Buffer.from(wrappedKey, 'base64').toString('utf8')) as WrappedKeyBlob;
  } catch {
    throw new Error('wrapped key is not a valid envelope');
  }
  if (blob.v !== WRAP_VERSION) throw new Error('unsupported wrapped key version');
  const wrapKey = deriveSharedKey(recipientEncryptionPrivateKey, blob.epk);
  const decipher = createDecipheriv(ALGORITHM, wrapKey, Buffer.from(blob.iv, 'base64'), CIPHER_OPTIONS);
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

export function encryptPayload(plaintext: string, symmetricKey: Buffer): Omit<EncryptedPayload, 'wrappedKey'> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, symmetricKey, iv, CIPHER_OPTIONS);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptPayload(payload: Omit<EncryptedPayload, 'wrappedKey'>, symmetricKey: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, symmetricKey, Buffer.from(payload.iv, 'base64'), CIPHER_OPTIONS);
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function encryptForDevice(
  plaintext: string,
  symmetricKey: Buffer,
  recipientEncryptionPublicKey: string
): EncryptedPayload {
  const encrypted = encryptPayload(plaintext, symmetricKey);
  const wrappedKey = wrapSymmetricKey(symmetricKey, recipientEncryptionPublicKey);
  return { ...encrypted, wrappedKey };
}

export function decryptForDevice(payload: EncryptedPayload, recipientEncryptionPrivateKey: string): string {
  const symmetricKey = unwrapSymmetricKey(payload.wrappedKey, recipientEncryptionPrivateKey);
  return decryptPayload(payload, symmetricKey);
}
