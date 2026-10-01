import type { ContextAuditRecord, ContextItem } from './types'
import { contextItemState } from './item'

/**
 * THE AUDIT SHAPE.
 *
 * The Event Fabric and the activity feed are the least protected places
 * anything in Core can go: they get read, copied, backed up and handed to
 * whoever is debugging. Context content — a selected paragraph, a shared tab's
 * URL, the title of a file somebody is anxious about — must never reach them.
 *
 * So this file is the *only* bridge from a `ContextItem` to audit surface, and
 * it is subtraction, not filtering at the call site: it builds a record out of
 * ids, closed labels, instants and measured lengths, with no field a sentence
 * could hide in. Copying a `ContextItem` into a journal payload would be a
 * schema change; taking one of these records by mistake puts a length where the
 * words would have been.
 *
 * There are no `context.*` journal events in this lane. This module produces
 * the record a future, metadata-only event *would* carry, and writes nothing
 * itself — the journal boundary stays where the event schema says it is.
 *
 * Note what is not here even though the store holds it: a revocation's
 * `revocationReason` is free text a person typed, so it stays on the in-memory
 * tombstone. The record keeps `revokedAt` — that a revocation happened, at
 * when — and none of the words, which is the same line the conversation and
 * Brain journals draw.
 */

/**
 * One item as audit metadata.
 *
 * `state` is derived at the supplied instant, so the same record reads `live`
 * before a TTL and `expired` after it without anything having been rewritten.
 * `revoked` stays `revoked` past its expiry, because a revocation is a human
 * act and does not become a clock tick by waiting.
 */
export function contextAuditRecord(item: ContextItem, now: Date): ContextAuditRecord {
  return {
    contextId: item.contextId,
    kind: item.kind,
    source: item.provenance.source,
    scopeKind: item.scope.scopeKind,
    scopeId: item.scope.scopeId,
    originId: item.provenance.originId,
    capturedAt: item.provenance.capturedAt,
    admittedAt: item.admittedAt,
    expiresAt: item.expiresAt,
    revokedAt: item.revokedAt,
    state: contextItemState(item, now),
    contentLength: item.contentLength,
    labelLength: item.labelLength,
  }
}

/** A set of items as audit metadata, in the order they were given. */
export function contextAuditRecords(
  items: Iterable<ContextItem>,
  now: Date,
): readonly ContextAuditRecord[] {
  return [...items].map((item) => contextAuditRecord(item, now))
}
