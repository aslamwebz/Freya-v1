import { randomBytes, generateKeyPairSync, createSign, createVerify } from 'node:crypto';
import type { DeviceId, DeviceIdentity, DevicePlatform } from './types.js';

export function generateDeviceId(): DeviceId {
  return randomBytes(32).toString('hex');
}

export function generateDeviceKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function createDeviceIdentity(
  displayName: string,
  platform: DevicePlatform,
  id: DeviceId = generateDeviceId(),
  keyPair: { publicKey: string; privateKey: string } = generateDeviceKeyPair()
): DeviceIdentity & { privateKey: string } {
  return {
    id,
    publicKey: keyPair.publicKey,
    displayName,
    platform,
    createdAt: Date.now(),
    privateKey: keyPair.privateKey,
  };
}

export function signWithDeviceKey(privateKey: string, data: string): string {
  const signer = createSign('SHA256');
  signer.update(data);
  return signer.sign(privateKey, 'base64');
}

export function verifyWithDeviceKey(publicKey: string, data: string, signature: string): boolean {
  const verifier = createVerify('SHA256');
  verifier.update(data);
  return verifier.verify(publicKey, signature, 'base64');
}

export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}
