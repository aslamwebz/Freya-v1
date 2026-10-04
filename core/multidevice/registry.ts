import type {
  DeviceId, DeviceRecord, DeviceTrustLevel, DeviceStatus, DeviceRevocation,
  PairingRequest, EnrollmentRecord, OwnerApproval, DeviceIdentity,
} from './types.js';
import { createDeviceTrust } from './trust.js';
import { canSyncRead, canSyncWrite, canIssueCommands, canReceiveCommands } from './trust.js';

export class InMemoryDeviceRegistry {
  private devices = new Map<DeviceId, DeviceRecord>();

  enroll(request: PairingRequest, ownerApproval: OwnerApproval): EnrollmentRecord {
    const { deviceIdentity } = request;
    if (this.devices.has(deviceIdentity.id)) {
      throw new Error(`Device ${deviceIdentity.id} already enrolled`);
    }
    const now = Date.now();
    const record: DeviceRecord = {
      identity: deviceIdentity,
      trust: createDeviceTrust('limited', ownerApproval.approverDeviceId, 'Initial enrollment', now),
      enrolledAt: now,
      enrolledBy: ownerApproval.approverDeviceId,
      lastSeenAt: now,
      status: 'active',
      revocation: null,
    };
    this.devices.set(deviceIdentity.id, record);
    return {
      deviceId: deviceIdentity.id,
      enrolledAt: now,
      enrolledBy: ownerApproval.approverDeviceId,
      initialTrustLevel: 'limited',
      pairingRequestId: request.nonce,
    };
  }

  revoke(deviceId: DeviceId, revokedBy: DeviceId, reason: string): void {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    this.assertOwner(revokedBy);
    const revocation: DeviceRevocation = { revokedAt: Date.now(), revokedBy, reason };
    this.devices.set(deviceId, { ...device, status: 'revoked', revocation });
  }

  promote(deviceId: DeviceId, newLevel: DeviceTrustLevel, promotedBy: DeviceId, reason: string): void {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    this.assertOwner(promotedBy);
    const trust = createDeviceTrust(newLevel, promotedBy, reason);
    this.devices.set(deviceId, { ...device, trust });
  }

  demote(deviceId: DeviceId, newLevel: DeviceTrustLevel, demotedBy: DeviceId, reason: string): void {
    this.promote(deviceId, newLevel, demotedBy, reason);
  }

  private assertOwner(deviceId: DeviceId): void {
    const device = this.devices.get(deviceId);
    if (!device || device.trust.level !== 'owner') {
      throw new Error(`Device ${deviceId} is not the owner`);
    }
  }

  get(deviceId: DeviceId): DeviceRecord | null {
    return this.devices.get(deviceId) || null;
  }

  list(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }

  listByTrust(level: DeviceTrustLevel): DeviceRecord[] {
    return this.list().filter(d => d.trust.level === level);
  }

  isRevoked(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    return device?.status === 'revoked';
  }

  canSync(deviceId: DeviceId): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.status === 'revoked') return false;
    return canSyncRead(device.trust.level);
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
}
