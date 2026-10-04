import type { DeviceId, VectorClock, SyncDelta, SyncChange, SyncResult, ConflictPolicy, ConflictRecord } from './types.js';
import { mergeVectorClocks, compareVectorClocks, incrementVectorClock } from './vector-clock.js';
import { resolveConflict, hasConflict, createDefaultConflictPolicy } from './conflicts.js';

export class InMemorySyncEngine {
  private vectorClocks = new Map<DeviceId, VectorClock>();
  private changes = new Map<DeviceId, SyncChange[]>();

  sync(deviceId: DeviceId, vectorClock: VectorClock): SyncDelta {
    const deviceChanges = this.changes.get(deviceId) || [];
    const deltaChanges = deviceChanges.filter(c => {
      const vc = this.vectorClocks.get(c.deviceId) || {};
      return (vc[c.deviceId] || 0) < c.timestamp;
    });
    const currentVc = this.vectorClocks.get(deviceId) || {};
    return { changes: deltaChanges, vectorClock: currentVc };
  }

  apply(deviceId: DeviceId, delta: SyncDelta): SyncResult {
    const policy = createDefaultConflictPolicy();
    const applied: SyncChange[] = [];
    const conflicts: ConflictRecord[] = [];
    const localChanges = this.changes.get(deviceId) || [];

    for (const remoteChange of delta.changes) {
      const localConflict = localChanges.find(c => hasConflict(c, remoteChange));
      if (localConflict) {
        const record = resolveConflict(localConflict, remoteChange, policy, deviceId);
        conflicts.push(record);
        if (record.resolution === 'remote' || record.resolution === 'merged') {
          applied.push(remoteChange);
        }
      } else {
        applied.push(remoteChange);
      }
    }

    const currentVc = this.vectorClocks.get(deviceId) || {};
    const newVectorClock = mergeVectorClocks(currentVc, delta.vectorClock);
    this.vectorClocks.set(deviceId, newVectorClock);

    const allChanges = [...localChanges, ...applied];
    this.changes.set(deviceId, allChanges);

    return { applied, conflicts, newVectorClock };
  }

  getVectorClock(deviceId: DeviceId): VectorClock {
    return this.vectorClocks.get(deviceId) || {};
  }

  resolveConflicts(local: SyncChange, remote: SyncChange, policy: ConflictPolicy): ConflictRecord {
    return resolveConflict(local, remote, policy, 'system');
  }

  recordChange(deviceId: DeviceId, change: SyncChange): void {
    const currentVc = this.vectorClocks.get(deviceId) || {};
    const newVc = incrementVectorClock(currentVc, deviceId);
    this.vectorClocks.set(deviceId, newVc);
    const changes = this.changes.get(deviceId) || [];
    this.changes.set(deviceId, [...changes, change]);
  }
}
