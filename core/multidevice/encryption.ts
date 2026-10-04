import { randomBytes, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt } from 'node:crypto';
import type { EncryptedPayload } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const WRAPPING_PADDING = 1;

export function generateSymmetricKey(): Buffer {
  return randomBytes(32);
}

export function wrapSymmetricKey(symmetricKey: Buffer, devicePublicKey: string): string {
  const wrapped = publicEncrypt(
    { key: devicePublicKey, padding: WRAPPING_PADDING },
    symmetricKey
  );
  return wrapped.toString('base64');
}

export function unwrapSymmetricKey(wrappedKey: string, devicePrivateKey: string): Buffer {
  const unwrapped = privateDecrypt(
    { key: devicePrivateKey, padding: WRAPPING_PADDING },
    Buffer.from(wrappedKey, 'base64')
  );
  return unwrapped;
}

export function encryptPayload(plaintext: string, symmetricKey: Buffer): Omit<EncryptedPayload, 'wrappedKey'> {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, symmetricKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptPayload(payload: Omit<EncryptedPayload, 'wrappedKey'>, symmetricKey: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, symmetricKey, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function encryptForDevice(plaintext: string, symmetricKey: Buffer, devicePublicKey: string): EncryptedPayload {
  const encrypted = encryptPayload(plaintext, symmetricKey);
  const wrappedKey = wrapSymmetricKey(symmetricKey, devicePublicKey);
  return { ...encrypted, wrappedKey };
}

export function decryptForDevice(payload: EncryptedPayload, devicePrivateKey: string): string {
  const symmetricKey = unwrapSymmetricKey(payload.wrappedKey, devicePrivateKey);
  return decryptPayload(payload, symmetricKey);
}
