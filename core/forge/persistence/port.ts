import { canonicalForgeJson } from '../types'
import { parseForgeManifest } from '../manifest'
import type { ForgeManifest, ForgeOrigin } from '../types'
import type { ForgeStoredPackage } from '../engine'

/**
 * THE FORGE PERSISTENCE PORT.
 *
 * A snapshot of package bodies goes in, a snapshot comes out, and the port states
 * in words whether that snapshot will still be there tomorrow. Same discipline as
 * the Skill store, and for the same reason: **a Forge package body is a program
 * Freya can run.** Its description, its capability map, its literals and its
 * dependency list are all content, and none of them belongs in a synced folder or
 * a support bundle.
 *
 * ## The body is re-parsed on load, not trusted
 *
 * A stored entry holds the manifest *payload* as it was submitted plus its
 * provenance and its integrity hash. Reading it back goes through
 * `parseForgeManifest` — the same door a candidate comes through — and then
 * compares the recomputed hash with the recorded one. So a store that has been
 * edited, truncated or swapped either fails to parse or fails its hash, and the
 * package is not adopted. There is no "decrypt anyway" path, because accepting a
 * body that failed authentication would mean inventing the program it used to
 * hold.
 *
 * ## What the port cannot express
 *
 * No authority, no query language, no append and no delete. A snapshot in, a
 * snapshot out, so a caller cannot reach a body except by asking the engine — which
 * is the only component that checks status.
 */

export const FORGE_SNAPSHOT_VERSION = 1

/** The cap on one encrypted payload. Bigger than any catalog this phase retains. */
export const MAX_FORGE_SNAPSHOT_BYTES = 512 * 1024

export interface ForgeSnapshotEntry {
  readonly skillId: string
  readonly version: number
  readonly integrityHash: string
  readonly provenance: {
    readonly origin: ForgeOrigin
    readonly model: string | null
    readonly requestHash: string | null
    readonly originRef: string | null
    readonly createdAt: string
  }
  /** The manifest as it was submitted. Untrusted again on the way out. */
  readonly manifest: unknown
}

export interface ForgeSnapshot {
  readonly v: typeof FORGE_SNAPSHOT_VERSION
  readonly entries: readonly ForgeSnapshotEntry[]
}

export type ForgeSnapshotLoad =
  | { readonly ok: true; readonly packages: readonly ForgeStoredPackage[] }
  | { readonly ok: false; readonly code: ForgePersistenceCode; readonly reason: string }

export const FORGE_PERSISTENCE_CODES = [
  'unreadable',
  'malformed-snapshot',
  'unauthenticated',
  'integrity-mismatch',
  'oversize',
] as const
export type ForgePersistenceCode = (typeof FORGE_PERSISTENCE_CODES)[number]

export interface ForgePersistencePort {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly durabilityReason: string | null
  readonly faultReason: string | null
  load(): Promise<ForgeSnapshotLoad>
  commit(packages: readonly ForgeStoredPackage[]): Promise<void>
  close(): Promise<void>
}

/** Serialise the current body set. Canonical, so identical bodies give identical bytes. */
export function encodeForgeSnapshot(packages: readonly ForgeStoredPackage[]): string {
  const entries: ForgeSnapshotEntry[] = packages.map((stored) => ({
    skillId: stored.skillId,
    version: stored.version,
    integrityHash: stored.integrityHash,
    provenance: {
      origin: stored.manifest.provenance.origin,
      model: stored.manifest.provenance.model,
      requestHash: stored.manifest.provenance.requestHash,
      originRef: stored.manifest.provenance.originRef,
      createdAt: stored.manifest.provenance.createdAt,
    },
    manifest: manifestToPayload(stored.manifest),
  }))
  const snapshot: ForgeSnapshot = { v: FORGE_SNAPSHOT_VERSION, entries }
  const text = canonicalForgeJson(snapshot)
  if (text.length > MAX_FORGE_SNAPSHOT_BYTES) {
    throw new Error('forge snapshot is larger than the ceiling')
  }
  return text
}

/**
 * The manifest as a plain payload, so the store holds a description rather than
 * an object graph with a prototype on it.
 */
function manifestToPayload(manifest: ForgeManifest): unknown {
  return {
    name: manifest.name,
    runtime: manifest.runtime,
    description: manifest.description,
    inputs: { fields: manifest.inputs.fields },
    outputs: { fields: manifest.outputs.fields },
    capabilitiesRequired: [...manifest.capabilitiesRequired],
    access: manifest.access,
    dependencies: manifest.dependencies,
    tags: manifest.tags,
    program: { steps: manifest.program.steps },
  }
}

/**
 * Read a snapshot back into bodies, refusing anything that does not re-parse or
 * does not hash to what was recorded.
 *
 * Total on purpose: the caller keeps going with the packages that were believable
 * and is told why the rest were not, because "the file could not be believed" is a
 * state to survive, not an exception to crash on.
 */
export function decodeForgeSnapshot(raw: string): ForgeSnapshotLoad {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'malformed-snapshot', reason: 'the Forge store is not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'malformed-snapshot', reason: 'the Forge store is not an object' }
  }
  const snapshot = parsed as Record<string, unknown>
  if (snapshot.v !== FORGE_SNAPSHOT_VERSION || !Array.isArray(snapshot.entries)) {
    return { ok: false, code: 'malformed-snapshot', reason: 'the Forge store is not a snapshot this build understands' }
  }

  const out: ForgeStoredPackage[] = []
  for (const item of snapshot.entries) {
    const entry = readEntry(item)
    if (entry === null) {
      return { ok: false, code: 'malformed-snapshot', reason: 'a Forge store entry is malformed' }
    }
    const result = parseForgeManifest({
      payload: entry.manifest,
      version: entry.version,
      provenance: entry.provenance,
    })
    if (!result.ok) {
      return { ok: false, code: 'malformed-snapshot', reason: `a stored package no longer parses: ${result.code}` }
    }
    if (result.integrityHash !== entry.integrityHash) {
      return {
        ok: false,
        code: 'integrity-mismatch',
        reason: 'a stored package does not hash to the value recorded for it',
      }
    }
    out.push({
      skillId: entry.skillId,
      version: entry.version,
      manifest: result.manifest,
      integrityHash: entry.integrityHash,
      // The snapshot's own manifest field is the payload as it was submitted, so the
      // scan on the next start reads the same bytes this start did.
      payload: entry.manifest,
    })
  }

  return { ok: true, packages: out }
}

function readEntry(raw: unknown): ForgeSnapshotEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const provenance = entry.provenance
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) return null
  const record = provenance as Record<string, unknown>
  if (typeof entry.skillId !== 'string' || typeof entry.version !== 'number') return null
  if (typeof entry.integrityHash !== 'string' || typeof record.createdAt !== 'string') return null
  return {
    skillId: entry.skillId,
    version: entry.version,
    integrityHash: entry.integrityHash,
    provenance: {
      origin: record.origin as ForgeOrigin,
      model: typeof record.model === 'string' ? record.model : null,
      requestHash: typeof record.requestHash === 'string' ? record.requestHash : null,
      originRef: typeof record.originRef === 'string' ? record.originRef : null,
      createdAt: record.createdAt,
    },
    manifest: entry.manifest,
  }
}
