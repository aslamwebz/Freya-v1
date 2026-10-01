// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORE_EVENT_TYPES } from '../../../core/events/envelope'
import type { ContextStore } from '../../../core/context/store'
import type { ContextAdmission } from '../../../core/context/types'
import { T0, admitOrThrow, at, conversation, sequencedStore, surface } from './fixture'

/**
 * Privacy and authority.
 *
 * Three properties, each asserted structurally rather than behaviourally so
 * they hold even when no test happens to exercise the path in question:
 *
 *  1. **Context implies no authority.** There is no field, on an item or on a
 *     verdict, that could be read as a permission. Guard never reads this
 *     module, and nothing here is shaped like something it would.
 *  2. **Private context content reaches no generic surface.** The journal has
 *     no `context.*` event to put it in, the audit shape has no field it could
 *     hide in, and the module itself imports nothing that writes anywhere.
 *  3. **Zero idle inference.** Every operation is synchronous and the source
 *     reaches outside its own directory for nothing: a module that cannot
 *     await, cannot import a provider and cannot schedule work spends nothing
 *     while idle.
 */

const SECRET = 'the settlement offer is 40k and the deadline is Friday'
const SECRET_LABEL = 'offer-letter (final).docx'
const SECRET_URI = 'file:///home/owner/legal/offer-letter (final).docx'

/** A private-looking item in a private-looking share. */
function secretSpec(overrides: Partial<ContextAdmission> = {}): ContextAdmission {
  return {
    kind: 'file',
    source: 'owner_selection',
    scope: conversation('c1'),
    content: SECRET,
    label: SECRET_LABEL,
    uri: SECRET_URI,
    ...overrides,
  }
}

function readyStore(): ContextStore {
  const store = sequencedStore()
  store.setActiveScope(conversation('c1'))
  return store
}

describe('context implies no authority', () => {
  it('gives an item no field that reads as a permission', () => {
    const store = readyStore()
    const item = admitOrThrow(store, secretSpec())
    const keys = [
      ...Object.keys(item),
      ...Object.keys(item.provenance),
      ...Object.keys(item.scope),
    ]
    for (const key of keys) {
      expect(key).not.toMatch(/permission|authorit|capabilit|grant|allow|trust|entitle/i)
    }
    // The reference is a name for a thing, not a permit to touch it.
    expect(item.uri).toBe(SECRET_URI)
  })

  it('gives a verdict no field that reads as a permission', () => {
    const store = readyStore()
    admitOrThrow(store, secretSpec())
    const resolved = store.resolve({ term: 'this' }, T0)
    if (!resolved.ok) throw new Error(`expected a resolution, refused: ${resolved.reason}`)
    expect(Object.keys(resolved).sort()).toEqual(['item', 'ok'])

    admitOrThrow(store, secretSpec({ content: 'second' }))
    const refused = store.resolve({ term: 'this' }, T0)
    if (refused.ok) throw new Error('expected a refusal')
    expect(Object.keys(refused).sort()).toEqual(['candidateIds', 'ok', 'reason'])
    expect(typeof refused.reason).toBe('string')
  })

  it('holds no method that grants, checks or widens anything', () => {
    const store = readyStore()
    const prototype = Object.getPrototypeOf(store) as object
    const methods = Object.getOwnPropertyNames(prototype).filter((name) => {
      // Read the descriptor rather than the property: a getter would be
      // *invoked* by a plain access, on the prototype, with no state behind it.
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      return name !== 'constructor' && typeof descriptor?.value === 'function'
    })
    // The surface is: hold, point at, list, take back, forget, audit, scope.
    // There is no authorise, no grant, no capability and no escalation.
    for (const name of methods) {
      expect(name).not.toMatch(/permission|authorit|capabilit|grant|allow|escalat/i)
    }
    expect(methods).toEqual(
      expect.arrayContaining(['admit', 'revoke', 'resolve', 'list', 'audit', 'purge']),
    )
  })
})

describe('private context content reaches no generic surface', () => {
  it('has no journal event type that could carry it', () => {
    // Structural: the Event Fabric is audit surface, so context content has no
    // home there. If a `context.*` family is ever added it must be metadata
    // only, and this assertion is where that gets argued.
    expect(CORE_EVENT_TYPES.filter((type) => type.startsWith('context.'))).toEqual([])
  })

  it('builds audit records with no field a sentence could hide in', () => {
    const store = readyStore()
    admitOrThrow(store, secretSpec())

    const rows = store.audit(T0)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'admittedAt',
      'capturedAt',
      'contentLength',
      'contextId',
      'expiresAt',
      'kind',
      'labelLength',
      'originId',
      'revokedAt',
      'scopeId',
      'scopeKind',
      'source',
      'state',
    ])
    expect(JSON.stringify(rows)).not.toContain('settlement')
    expect(JSON.stringify(rows)).not.toContain('40k')
    expect(JSON.stringify(rows)).not.toContain('offer-letter')
    expect(JSON.stringify(rows)).not.toContain('file:///')
    // And it is not "no information": the measurement is still there.
    expect(rows[0]?.contentLength).toBe(SECRET.length)
  })

  it('keeps another conversation\'s content out of every surface, metadata included', () => {
    const store = sequencedStore()
    admitOrThrow(store, secretSpec({ scope: conversation('other'), content: SECRET }))
    store.setActiveScope(conversation('c1'))

    const everything = JSON.stringify({
      list: store.list(T0),
      audit: store.audit(T0),
      resolution: store.resolve({ term: 'this' }, T0),
      scope: store.activeScope,
    })
    expect(everything).not.toContain('settlement')
    expect(everything).not.toContain('offer-letter')
    expect(store.list(T0)).toEqual([])
  })

  it('keeps revoked content out of everything reachable', () => {
    const store = readyStore()
    const item = admitOrThrow(store, secretSpec())
    store.revoke(item.contextId, 'the owner took it back', T0)

    const shared = JSON.stringify({
      list: store.list(at(1)),
      audit: store.audit(at(1)),
      resolution: store.resolve({ term: 'this' }, at(1)),
    })
    expect(shared).not.toContain('settlement')
    expect(shared).not.toContain('offer-letter')
    // The fact of the revocation is audit metadata; the free-text reason is
    // not, and stays off every shared surface.
    expect(shared).toContain('"state":"revoked"')
    expect(shared).not.toContain('the owner took it back')

    // The tombstone is memory-only: it carries the stated why, and still none
    // of the content that was destroyed.
    const tombs = JSON.stringify(store.tombstones(at(1)))
    expect(tombs).toContain('the owner took it back')
    expect(tombs).not.toContain('settlement')
    expect(tombs).not.toContain('offer-letter')
    expect(tombs).not.toContain('file:///')
  })
})

describe('the context foundation reaches nothing', () => {
  const dir = fileURLToPath(new URL('../../../core/context', import.meta.url))

  /**
   * The five files the foundation is made of.
   *
   * Named rather than globbed, because the directory now also holds the Core
   * integration (`coreIntegration.ts`, `mission-adapter.ts`) and that is a
   * *deliberate* seam: it imports Core's protocol vocabulary, because a file that
   * decides what a caller may claim has to know what a claim looks like. Asserting
   * the whole directory is import-hermetic would fail on exactly the code that is
   * supposed to be the boundary, and quietly "fixing" that by loosening the glob
   * would have removed the property this suite exists to hold.
   *
   * The integration gets its own, different assertions in
   * `context-core-integration.test.ts`: no model, no journal, no network, no clock
   * of its own.
   */
  const FOUNDATION = ['audit.ts', 'item.ts', 'reference.ts', 'store.ts', 'types.ts']

  const foundationSource = (): string =>
    FOUNDATION.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')

  it('imports nothing outside its own directory', () => {
    const source = foundationSource()
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])

    expect(specifiers.length).toBeGreaterThan(0)
    // One directory, and no imports from the journal, the model layer, Core's
    // facade, cognition or the filesystem. Nothing here can write, call or
    // reach.
    for (const specifier of specifiers) {
      expect(specifier, specifier).toMatch(/^\.\//)
    }
    expect(source).not.toMatch(/node:/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/XMLHttpRequest|\bWebSocket\b/)
    expect(source).not.toMatch(/setTimeout|setInterval/)
  })

  it('is the whole of what the directory holds', () => {
    // So that adding another foundation file is a deliberate act and not a
    // silent escape from the two assertions above.
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .sort()
    expect(files).toEqual(
      [...FOUNDATION, 'coreIntegration.ts', 'mission-adapter.ts', 'workforce-adapter.ts'].sort(),
    )
  })

  it('contains no clock reads, no timers and nothing that can wait', () => {
    const source = foundationSource()

    // The instant always comes from the caller: same state, same instant, same
    // verdict — and no background tick keeping context "fresh".
    expect(source).not.toMatch(/Date\.now\(\)/)
    expect(source).not.toMatch(/new Date\(\)/)
    // Synchronous by construction: a module with no `async` and no `Promise`
    // has no path to a provider, so idle maintenance spends zero inference.
    expect(source).not.toMatch(/\basync\b/)
    expect(source).not.toMatch(/\bPromise\b/)
  })

  it('answers every operation without a thenable in sight', () => {
    const store = readyStore()
    const item = admitOrThrow(store, secretSpec())
    const outcomes: unknown[] = [
      store.admit(secretSpec({ content: 'another' }), T0),
      store.resolve({ term: 'this' }, T0),
      store.list(T0),
      store.audit(T0),
      store.tombstones(T0),
      store.purge(T0),
      store.revoke(item.contextId, 'test', T0),
      store.setActiveScope(surface('s1')),
    ]
    for (const outcome of outcomes) {
      expect((outcome as { then?: unknown } | null | undefined)?.then).toBeUndefined()
    }
  })
})
