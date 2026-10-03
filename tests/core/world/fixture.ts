// @vitest-environment node
import {
  WorldEngine,
  WORLD_SNAPSHOT_VERSION,
  worldLimits,
  decodeWorldSnapshot,
  encodeWorldSnapshot,
  type WorldAdmissionRequest,
  type WorldEvidenceRequest,
  type WorldLimits,
  type WorldReferenceRecord,
  type WorldSelfSource,
  type WorldSnapshot,
} from '../../../core/world'
import { EphemeralWorldStore } from '../../../core/world/persistence/ephemeral-store'
import type { WorldPersistencePort } from '../../../core/world/persistence/port'

/**
 * SHARED FIXTURES FOR THE SELF & WORLD MODEL.
 *
 * Two things are fixed here and nowhere else: the clock and the durable store. A
 * world-model test that used the wall clock could pass or fail depending on when it
 * ran, and freshness is exactly the part most worth testing.
 */

export const T0 = new Date('2026-06-01T09:00:00.000Z')
export const DAY_MS = 24 * 60 * 60_000

/** An in-process store, so a domain test needs no filesystem and no key. */
export function ephemeralStore(): WorldPersistencePort {
  return new EphemeralWorldStore()
}

/**
 * A durable *test double* for the persistence port: it keeps the snapshot in a holder
 * the test owns, so a restart can be simulated by closing one engine and opening
 * another over the same holder.
 *
 * This exists because the real durable implementation is the Vault, and the Vault
 * cannot be opened at all until a SQLCipher binding is selected — which is currently
 * blocked pending the permissive Windows audit. Everything here that is about *the
 * store* (encryption, page authentication, a wrong key, a damaged row) therefore
 * lives in the binding-gated suites; everything about *restart recovery, replay
 * determinism and the evidence counter surviving eviction* is a property of the
 * engine plus the port contract, and is testable here without weakening either claim.
 *
 * It is a double, not a second implementation: it validates through the same codec in
 * both directions, so it cannot accept a record the real store would refuse.
 */
export interface MemoryPortHolder {
  snapshot: WorldSnapshot
}

export function memoryStore(holder: MemoryPortHolder): WorldPersistencePort {
  return {
    mode: 'encrypted',
    durable: true,
    durabilityReason: null,
    faultReason: null,
    async load() {
      try {
        return { ok: true, snapshot: decodeWorldSnapshot(holder.snapshot) }
      } catch (error) {
        return {
          ok: false,
          code: 'degraded',
          reason: error instanceof Error ? error.message : 'the world snapshot could not be read',
        }
      }
    },
    async commit(snapshot: WorldSnapshot) {
      holder.snapshot = encodeWorldSnapshot(snapshot)
    },
    async close() {
      // Nothing to release: the holder outlives the engine on purpose.
    },
  }
}

/** A fresh, empty holder for `memoryStore`. */
export function emptyHolder(): MemoryPortHolder {
  return { snapshot: { v: WORLD_SNAPSHOT_VERSION, records: [], sequence: 0 } }
}

export interface WorldHarness {
  readonly engine: WorldEngine
  readonly store: WorldPersistencePort
  /** An owner statement: the strongest channel, and the only one a person uses. */
  owner(request: WorldEvidenceRequest): ReturnType<WorldEngine['admit']>
  /** A claim from a worker or another agent. */
  worker(request: WorldEvidenceRequest): ReturnType<WorldEngine['admit']>
  /** A model's hypothesis. */
  model(request: WorldEvidenceRequest): ReturnType<WorldEngine['admit']>
  /** Content brought in from outside: a document, a page, a pasted block. */
  imported(request: WorldEvidenceRequest): ReturnType<WorldEngine['admit']>
  /** A Core subsystem's own observation. */
  system(request: WorldEvidenceRequest): ReturnType<WorldEngine['admit']>
  /** Move the clock this harness reports. Deliberate, never ambient. */
  moveTo(instant: Date): void
  /** Move the clock forward by a number of days. */
  advanceDays(days: number): void
}

export interface HarnessOptions {
  readonly start?: Date
  readonly references?: () => readonly WorldReferenceRecord[]
  readonly self?: WorldSelfSource
  readonly limits?: Partial<WorldLimits>
  readonly store?: WorldPersistencePort
}

/**
 * A started engine with the admission channels already bound to something.
 *
 * The channel is chosen by *which method is called*, never by a field on the request.
 * That is the property the whole phase leans on, so the fixture makes it impossible
 * for a domain test to accidentally supply one.
 */
export function harness(options: HarnessOptions = {}): WorldHarness {
  let clock = new Date(options.start ?? T0)
  const store = options.store ?? ephemeralStore()
  const engine = new WorldEngine({
    persistence: store,
    now: () => new Date(clock),
    limits: options.limits ?? {},
    references: options.references ?? ((): readonly WorldReferenceRecord[] => []),
    ...(options.self === undefined ? {} : { self: options.self }),
  })

  const admit = (
    channel: WorldAdmissionRequest['channel'],
    actor: string,
    request: WorldEvidenceRequest,
  ): ReturnType<WorldEngine['admit']> =>
    engine.admit({
      request,
      channel,
      actor: actor as WorldAdmissionRequest['actor'],
      sensitivity: 'personal',
    })

  return {
    engine,
    store,
    owner: (request) => admit('owner_statement', 'owner', request),
    worker: (request) => admit('worker_claim', 'agent:alpha', request),
    model: (request) => admit('model_hypothesis', 'system', request),
    imported: (request) => admit('imported_content', 'system', request),
    system: (request) => admit('system_observation', 'system', request),
    moveTo: (instant) => {
      clock = new Date(instant)
    },
    advanceDays: (days) => {
      clock = new Date(clock.getTime() + days * DAY_MS)
    },
  }
}

/** A live Mission record, as the Mission domain would report it. */
export function missionRef(id: string, status: string, settledAt: string | null = null): WorldReferenceRecord {
  return {
    kind: 'mission',
    id,
    // Deliberately no label: `MissionSummaryView` has no title, and this phase has no
    // business going looking for the Mission's private content.
    label: null,
    status,
    terminal: status === 'completed' || status === 'cancelled' || status === 'failed',
    observedAt: settledAt ?? T0.toISOString(),
  }
}

/** A live worker record, as the Workforce domain would report it. */
export function workerRef(id: string, status: string, extra: Partial<WorldReferenceRecord> = {}): WorldReferenceRecord {
  return {
    kind: 'worker',
    id,
    label: id,
    status,
    terminal: status === 'retired',
    observedAt: T0.toISOString(),
    ...extra,
  }
}

/** A live team record, as the Workforce domain would report it. */
export function teamRef(id: string, status: string, members: readonly string[] = []): WorldReferenceRecord {
  return {
    kind: 'team',
    id,
    label: id,
    status,
    terminal: status === 'disbanded',
    observedAt: T0.toISOString(),
    ...(members.length === 0 ? {} : { parentKind: 'worker', parentId: members[0] }),
  }
}

/** A live skill record, as the Skills domain would report it. */
export function skillRef(id: string, status: string): WorldReferenceRecord {
  return {
    kind: 'skill',
    id,
    label: 'summarise-a-file',
    status,
    terminal: status === 'retired' || status === 'blocked',
    observedAt: T0.toISOString(),
  }
}

/** Limits small enough to overflow on purpose. */
export function tinyLimits(): WorldLimits {
  return worldLimits({
    maxEvidenceRecords: 4,
    maxEntities: 4,
    maxEdges: 6,
    maxProjectionEntities: 3,
    maxProjectionEdges: 4,
    maxEntityDetailEdges: 3,
    maxConflictsListed: 2,
    maxBeliefsListed: 2,
    maxUncertaintiesListed: 2,
    maxEdgesPerEntity: 2,
  })
}

/** The happy-path claim most tests start from: a person who works on a project. */
export function anaWorksOnProject(): WorldEvidenceRequest[] {
  return [
    { kind: 'entity', entityType: 'person', name: 'Ana' },
    { kind: 'entity', entityType: 'project', name: 'Atlas' },
    {
      kind: 'relation',
      relationType: 'works_on',
      subject: { form: 'named', entityType: 'person', name: 'Ana' },
      object: { form: 'named', entityType: 'project', name: 'Atlas' },
    },
  ]
}

/** A self source that reports nothing: a Core with no Brain, Skills or Workforce. */
export function silentSelfSource(): WorldSelfSource {
  return {
    identity: () => null,
    limitations: () => [],
    capabilities: () => [],
    skills: () => [],
    models: () => [],
    workerClaims: () => [],
  }
}