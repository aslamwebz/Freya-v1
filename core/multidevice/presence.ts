import type { PresenceLease, PresenceRecord, DeviceId, DeviceStatus } from './types.js';

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 300_000;

export class InMemoryPresenceManager {
  private leases = new Map<DeviceId, PresenceLease>();
  private records = new Map<DeviceId, PresenceRecord>();

  acquireLease(deviceId: DeviceId, ttlMs: number = DEFAULT_TTL_MS): PresenceLease {
    const clampedTtl = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, ttlMs));
    const now = Date.now();
    const lease: PresenceLease = { deviceId, acquiredAt: now, expiresAt: now + clampedTtl, renewedAt: now, ttlMs: clampedTtl };
    this.leases.set(deviceId, lease);
    this.records.set(deviceId, { deviceId, lease, status: 'active', lastSeenAt: now });
    return lease;
  }

  renewLease(deviceId: DeviceId): PresenceLease {
    const existing = this.leases.get(deviceId);
    if (!existing) throw new Error(`No lease for device ${deviceId}`);
    const now = Date.now();
    const lease: PresenceLease = { ...existing, expiresAt: now + existing.ttlMs, renewedAt: now };
    this.leases.set(deviceId, lease);
    this.records.set(deviceId, { deviceId, lease, status: 'active', lastSeenAt: now });
    return lease;
  }

  releaseLease(deviceId: DeviceId): void {
    this.leases.delete(deviceId);
    const record = this.records.get(deviceId);
    if (record) this.records.set(deviceId, { ...record, lease: null, status: 'offline' });
  }

  getPresence(deviceId: DeviceId): PresenceRecord {
    const record = this.records.get(deviceId);
    if (!record) return { deviceId, lease: null, status: 'offline', lastSeenAt: 0 };
    return record;
  }

  listPresence(): PresenceRecord[] {
    return Array.from(this.records.values());
  }

  expireLeases(now: number = Date.now()): PresenceRecord[] {
    const expired: PresenceRecord[] = [];
    for (const [deviceId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(deviceId);
        const record = this.records.get(deviceId);
        if (record) {
          const updated = { ...record, lease: null, status: 'offline' as DeviceStatus };
          this.records.set(deviceId, updated);
          expired.push(updated);
        }
      }
    }
    return expired;
  }
}
