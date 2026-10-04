import type { DeviceId, VectorClock, SyncDelta, SyncChange, SyncResult, ConflictPolicy, ConflictRecord } from './types.js';
import { mergeVectorClocks, incrementVectorClock } from './vector-clock.js';
import { resolveConflict, hasConflict, createDefaultConflictPolicy } from './conflicts.js';

/**
 * Idempotency key for a change. Engine-originated changes carry the origin
 * device's logical counter (`sequence`), which is unique per device; that is
 * the primary key. Changes without a sequence fall back to their content.
 */
function changeKey(change: SyncChange): string {
  if (typeof change.sequence === 'number') {
    return `${change.deviceId}:${change.sequence}`;
  }
  return `${change.deviceId}:${change.path}:${change.timestamp}`;
}

export class InMemorySyncEngine {
  private vectorClock: VectorClock = {};
  private changes: SyncChange[] = [];
  private processedNonces = new Set<string>();

  /**
   * Produce the delta a requester has not seen yet.
   *
   * Delta semantics: a change is included iff the requester's clock for the
   * change's origin device is below the change's origin sequence. The delta
   * carries the responder's full merged clock so the requester can merge it
   * locally and never be offered the same change twice.
   */
  sync(deviceId: DeviceId, requesterClock: VectorClock): SyncDelta {
    const deltaChanges = this.changes.filter(
      (c) => (c.sequence ?? 0) > (requesterClock[c.deviceId] || 0)
    );
    return { changes: deltaChanges, vectorClock: { ...this.vectorClock }, senderDeviceId: deviceId };
  }

  apply(deviceId: DeviceId, delta: SyncDelta): SyncResult {
    const policy = createDefaultConflictPolicy();
    const applied: SyncChange[] = [];
    const conflicts: ConflictRecord[] = [];

    for (const remoteChange of delta.changes) {
      const key = changeKey(remoteChange);
      // Idempotency: a change already applied (or already originated here) is
      // never applied twice, even if the same delta is offered again.
      if (this.processedNonces.has(key)) continue;
      this.processedNonces.add(key);

      const localConflict = this.changes.find(
        (c) => changeKey(c) !== key && hasConflict(c, remoteChange)
      );
      if (localConflict) {
        const record = resolveConflict(localConflict, remoteChange, policy, deviceId);
        conflicts.push(record);
        if (record.resolution === 'remote' || record.resolution === 'merged') {
          this.storeChange(remoteChange);
          applied.push(remoteChange);
        }
      } else {
        this.storeChange(remoteChange);
        applied.push(remoteChange);
      }
    }

    this.vectorClock = mergeVectorClocks(this.vectorClock, delta.vectorClock);

    return { applied, conflicts, newVectorClock: { ...this.vectorClock } };
  }

  getVectorClock(_deviceId: DeviceId): VectorClock {
    return { ...this.vectorClock };
  }

  resolveConflicts(local: SyncChange, remote: SyncChange, policy: ConflictPolicy): ConflictRecord {
    return resolveConflict(local, remote, policy, 'system');
  }

  /**
   * Record a locally-originated change. The engine assigns the origin
   * device's logical counter, which doubles as the change's idempotency key
   * and its position in delta semantics.
   */
  recordChange(deviceId: DeviceId, change: SyncChange): SyncChange {
    const newVectorClock = incrementVectorClock(this.vectorClock, deviceId);
    this.vectorClock = newVectorClock;
    const stamped: SyncChange = { ...change, sequence: newVectorClock[deviceId] };
    this.storeChange(stamped);
    return stamped;
  }

  private storeChange(change: SyncChange): void {
    if (this.changes.some((c) => changeKey(c) === changeKey(change))) return;
    this.changes.push(change);
  }
}
