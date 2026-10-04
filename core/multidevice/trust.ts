import type { DeviceCapability, DeviceTrustLevel, DeviceTrust, DeviceId, RemoteCommandKind } from './types.js';

const TRUST_LEVEL_ORDER: Record<DeviceTrustLevel, number> = {
  untrusted: 0,
  limited: 1,
  trusted: 2,
  owner: 3,
};

const ALL_CAPABILITIES: readonly DeviceCapability[] = [
  'device.ping',
  'device.status.read',
  'device.presence.read',
  'sync.request',
  'system.stop-all',
  'device.custom',
];

const TRUSTED_CAPABILITIES: readonly DeviceCapability[] = ALL_CAPABILITIES.filter(
  (capability) => capability !== 'system.stop-all'
);

const CAPABILITY_BY_KIND: Record<RemoteCommandKind, DeviceCapability> = {
  ping: 'device.ping',
  'get-status': 'device.status.read',
  'get-presence': 'device.presence.read',
  'request-sync': 'sync.request',
  'stop-all': 'system.stop-all',
  custom: 'device.custom',
};

export function isDeviceCapability(value: unknown): value is DeviceCapability {
  return typeof value === 'string' && (ALL_CAPABILITIES as readonly string[]).includes(value);
}

export function capabilityForCommandKind(kind: RemoteCommandKind): DeviceCapability {
  return CAPABILITY_BY_KIND[kind];
}

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

/**
 * Capabilities implied by a trust level. Deny by default: anything not listed
 * here is not held, and `untrusted`/`limited` hold no command capabilities.
 */
export function capabilitiesForTrust(level: DeviceTrustLevel): ReadonlySet<DeviceCapability> {
  if (level === 'owner') return new Set(ALL_CAPABILITIES);
  if (level === 'trusted') return new Set(TRUSTED_CAPABILITIES);
  return new Set();
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
