import { createHash, randomUUID } from 'node:crypto';
import type { AuditAction, AuditRecord, DeviceId } from './types.js';

export class InMemoryAuditJournal {
  private records: AuditRecord[] = [];
  private lastHash = 'GENESIS';

  record(action: AuditAction, deviceId: DeviceId, details: Record<string, unknown>): AuditRecord {
    const timestamp = Date.now();
    const id = randomUUID();
    const hash = this.computeHash(id, timestamp, deviceId, action, details, this.lastHash);
    const record: AuditRecord = { id, timestamp, deviceId, action, details, hash, previousHash: this.lastHash };
    this.records.push(record);
    this.lastHash = hash;
    return record;
  }

  list(deviceId?: DeviceId, action?: AuditAction): AuditRecord[] {
    return this.records.filter(r =>
      (!deviceId || r.deviceId === deviceId) &&
      (!action || r.action === action)
    );
  }

  verify(): boolean {
    let prevHash = 'GENESIS';
    for (const record of this.records) {
      if (record.previousHash !== prevHash) return false;
      const expectedHash = this.computeHash(
        record.id, record.timestamp, record.deviceId, record.action, record.details, record.previousHash
      );
      if (record.hash !== expectedHash) return false;
      prevHash = record.hash;
    }
    return true;
  }

  private computeHash(
    id: string, timestamp: number, deviceId: string, action: AuditAction,
    details: Record<string, unknown>, previousHash: string
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({ id, timestamp, deviceId, action, details, previousHash }))
      .digest('hex');
  }
}
