import { createHash, randomUUID } from 'node:crypto';
import type { AuditAction, AuditRecord, AuditAnchor, DeviceId } from './types.js';

const ANCHOR_DOMAIN = 'freya-audit-anchor-v1';

/**
 * Hash-chained audit journal.
 *
 * Integrity model — stated honestly:
 *
 *  - `verify()` checks the internal hash chain: every record's content hash
 *    and every previousHash link. It detects modified records and records
 *    inserted mid-chain. It CANNOT detect tail truncation on its own: a
 *    truncated prefix is still a valid chain. Anyone who can rewrite the array
 *    can also recompute a consistent chain.
 *  - Truncation detection requires an external anchor: `anchor()` is a
 *    point-in-time commitment (sequence + head hash + digest) that an
 *    out-of-band verifier holds. `verifyAgainstAnchor()` fails if records
 *    were removed or replaced after the anchor was taken.
 */
export class InMemoryAuditJournal {
  private records: AuditRecord[] = [];
  private lastHash = 'GENESIS';

  record(action: AuditAction, deviceId: DeviceId, details: Record<string, unknown>): AuditRecord {
    const timestamp = Date.now();
    const id = randomUUID();
    const sequence = this.records.length + 1;
    const hash = this.computeHash(id, timestamp, deviceId, action, details, this.lastHash);
    const record: AuditRecord = { id, sequence, timestamp, deviceId, action, details, hash, previousHash: this.lastHash };
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

  /**
   * Internal chain verification only. Returns true for a truncated log whose
   * remaining prefix is internally consistent — use `verifyAgainstAnchor` for
   * truncation detection.
   */
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

  /**
   * Commit to the current log tail so an external verifier can later prove
   * the log was not truncated or rewritten after this point.
   */
  anchor(): AuditAnchor {
    const sequence = this.records.length;
    const headHash = this.lastHash;
    return { sequence, headHash, digest: this.anchorDigest(sequence, headHash) };
  }

  /**
   * Verify the log against an external anchor. Fails when records were
   * truncated, or when the anchored tail was replaced with different content.
   */
  verifyAgainstAnchor(anchor: AuditAnchor): boolean {
    if (anchor.digest !== this.anchorDigest(anchor.sequence, anchor.headHash)) return false;
    if (this.records.length < anchor.sequence) return false;
    if (anchor.sequence === 0) return true;
    return this.records[anchor.sequence - 1]?.hash === anchor.headHash;
  }

  getTailHash(): string {
    return this.lastHash;
  }

  getRecordCount(): number {
    return this.records.length;
  }

  private anchorDigest(sequence: number, headHash: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ domain: ANCHOR_DOMAIN, sequence, headHash }))
      .digest('hex');
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
