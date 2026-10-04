import type { DeviceTrustLevel, DeviceTrust, DeviceId } from './types.js';

const TRUST_LEVEL_ORDER: Record<DeviceTrustLevel, number> = {
  untrusted: 0,
  limited: 1,
  trusted: 2,
  owner: 3,
};

export function isTrustLevelAtLeast(actual: DeviceTrustLevel, required: DeviceTrustLevel): boolean {
  return TRUST_LEVEL_ORDER[actual] >= TRUST_LEVEL_ORDER[required];
}

export function canSyncRead(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'limited');
}

export function canSyncWrite(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'trusted');
}

export function canIssueCommands(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'trusted');
}

export function canReceiveCommands(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'trusted');
}

export function canEnrollDevices(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'owner');
}

export function canPromoteDemote(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'owner');
}

export function canRevokeDevices(level: DeviceTrustLevel): boolean {
  return isTrustLevelAtLeast(level, 'owner');
}

export function createDeviceTrust(
  level: DeviceTrustLevel,
  promotedBy: DeviceId,
  reason: string,
  promotedAt: number = Date.now()
): DeviceTrust {
  return { level, promotedAt, promotedBy, reason };
}

export function isOwnerLevel(level: DeviceTrustLevel): boolean {
  return level === 'owner';
}
