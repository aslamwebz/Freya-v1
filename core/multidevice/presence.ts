import type { PresenceLease, PresenceRecord, DeviceId, DeviceStatus } from './types.js';
import { MAX_CLOCK_SKEW_MS, MAX_REQUEST_AGE_MS } from './enrollment.js';
import type { InMemoryDeviceRegistry } from './registry.js';
import type { InMemoryAuditJournal } from './audit.js';

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 300_000;

export class InMemoryPresenceManager {
  private leases = new Map<DeviceId, PresenceLease>();
  private records = new Map<DeviceId, PresenceRecord>();

  constructor(
    private readonly registry: InMemoryDeviceRegistry | null = null,
    private readonly audit: InMemoryAuditJournal | null = null
  ) {}

  acquireLease(deviceId: DeviceId, ttlMs: number = DEFAULT_TTL_MS, issuedAt: number = Date.now()): PresenceLease {
    const now = Date.now();
    if (this.registry) {
      const device = this.registry.get(deviceId);
      if (!device) throw new Error(`Device ${deviceId} is not enrolled`);
      if (this.registry.isRevoked(deviceId)) throw new Error(`Device ${deviceId} is revoked`);
    }
    if (!Number.isFinite(issuedAt)) throw new Error('lease timestamp is invalid');
    if (issuedAt > now + MAX_CLOCK_SKEW_MS) throw new Error('lease timestamp is in the future');
    if (issuedAt < now - MAX_REQUEST_AGE_MS) throw new Error('lease timestamp has expired');

    const clampedTtl = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, ttlMs));
    const lease: PresenceLease = {
      deviceId,
      acquiredAt: now,
      expiresAt: now + clampedTtl,
      renewedAt: now,
      ttlMs: clampedTtl,
    };
    this.leases.set(deviceId, lease);
    this.records.set(deviceId, { deviceId, lease, status: 'active', lastSeenAt: now });
    this.audit?.record('presence-acquired', deviceId, { expiresAt: lease.expiresAt, ttlMs: clampedTtl });
    return lease;
  }

  /**
   * Renew a lease. `actorDeviceId` defaults to the lease owner and must match:
   * a device cannot extend another device's lease.
   */
  renewLease(deviceId: DeviceId, actorDeviceId: DeviceId = deviceId): PresenceLease {
    if (actorDeviceId !== deviceId) {
      throw new Error('a device cannot renew another device\'s lease');
    }
    if (this.registry?.isRevoked(deviceId)) {
      throw new Error(`Device ${deviceId} is revoked`);
    }
    const existing = this.leases.get(deviceId);
    if (!existing) throw new Error(`No lease for device ${deviceId}`);
    const now = Date.now();
    if (existing.expiresAt <= now) {
      throw new Error(`Lease for device ${deviceId} has already expired`);
    }
    const lease: PresenceLease = { ...existing, expiresAt: now + existing.ttlMs, renewedAt: now };
    this.leases.set(deviceId, lease);
    this.records.set(deviceId, { deviceId, lease, status: 'active', lastSeenAt: now });
    this.audit?.record('presence-renewed', deviceId, { expiresAt: lease.expiresAt });
    return lease;
  }

  releaseLease(deviceId: DeviceId): void {
    this.leases.delete(deviceId);
    const record = this.records.get(deviceId);
    if (record) this.records.set(deviceId, { ...record, lease: null, status: 'offline' });
  }

  /** Called on revocation: drop the lease and mark the device revoked. */
  evict(deviceId: DeviceId, reason: string): void {
    const hadLease = this.leases.delete(deviceId);
    const record = this.records.get(deviceId);
    if (record) {
      this.records.set(deviceId, { ...record, lease: null, status: 'revoked' });
    }
    if (hadLease || record) {
      this.audit?.record('presence-expired', deviceId, { reason });
    }
  }

  getPresence(deviceId: DeviceId): PresenceRecord {
    const record = this.records.get(deviceId);
    if (!record) return { deviceId, lease: null, status: 'offline', lastSeenAt: 0 };
    return record;
  }

  listPresence(): PresenceRecord[] {
    return Array.from(this.records.values());
  }

  hasActiveLease(deviceId: DeviceId, now: number = Date.now()): boolean {
    const lease = this.leases.get(deviceId);
    return lease !== undefined && lease.expiresAt > now;
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
          this.audit?.record('presence-expired', deviceId, { expiresAt: lease.expiresAt });
        }
      }
    }
    return expired;
  }
}
