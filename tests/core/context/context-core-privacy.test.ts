// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ContextIntegration } from '../../../core/context/coreIntegration'
import { CORE_EVENT_TYPES } from '../../../core/events/envelope'
import { CAPABILITIES } from '../../../core/protocol/core-protocol'
import type { CoreCommandName } from '../../../core/protocol/core-protocol'
import { CONTEXT_AUTHORITY_FIELDS } from '../../../core/protocol/context'
import { T0, conversation, sessionScope, surface } from './fixture'

/**
 * The Core integration layer: what it may reach, and what it may not publish.
 *
 * The foundation's privacy suite proved the *store* cannot leak. This one proves the
 * layer in front of it has not grown a way to, which is a different question and the
 * one this issue introduces: a facade is code that touches more of Core, so "it
 * imports nothing" is no longer available as an answer, and the properties have to be
 * restated as things that can be checked.
 *
 * Three, in order of how much they would cost if they were false:
 *
 *  1. **No idle inference.** No provider, gateway, Cognition or Mind is reachable from
 *     the integration, and every operation is synchronous. A module with no `async` and
 *     no `Promise` cannot spend anything while idle, and this asserts that structurally
 *     rather than waiting for a budget to notice.
 *  2. **No content in a generic surface.** The journal still has no `context.*` family,
 *     the activity feed has no slot, and no command in the Core vocabulary can return
 *     a selected sentence. Read those three together: a projection is fine, a command
 *     result is fine, and *both* would be wrong if the journal gained a `context.` prefix.
 *  3. **No authority.** Nothing this layer adds to an outcome could be read as a
 *     permission, and it holds no capability — because admitting a selection grants
 *     nothing and resolving "here" performs no action.
 */

const SECRET = 'the settlement offer is 40k and the deadline is Friday'
const SECRET_LABEL = 'offer-letter (final).docx'
const SECRET_URI = 'file:///home/owner/legal/offer-letter (final).docx'

const dir = fileURLToPath(new URL('../../../core/context', import.meta.url))

const integrationSource = (): string =>
  ['coreIntegration.ts', 'mission-adapter.ts'].map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')

/**
 * Comments and string literals, removed.
 *
 * These assertions are about what the code *does*, and several of them — "no
 * `async`", "appends nothing" — are words this repository's prose uses constantly
 * and correctly. Matching raw source would fail on a comment explaining the
 * property, or worse, pass because a comment happened to say the opposite.
 *
 * One left-to-right pass with the alternatives in a single pattern, so whichever
 * comes first wins — which is what makes a `//` inside a string literal safe.
 */
const PROSE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g

function code(source: string): string {
  return source.replace(PROSE, ' ')
}

function ready(): ContextIntegration {
  let next = 0
  const integration = new ContextIntegration({
    now: () => T0,
    newId: () => {
      next += 1
      return `x-${next}`
    },
  })
  integration.activateScope(conversation('c1'))
  return integration
}

function admitted(integration: ContextIntegration, overrides: Record<string, unknown> = {}): string {
  const outcome = integration.admit({
    kind: 'file',
    channel: 'owner_authorization',
    scope: conversation('c1'),
    content: SECRET,
    label: SECRET_LABEL,
    uri: SECRET_URI,
    ...overrides,
  })
  if (!outcome.ok) throw new Error(`expected an admission, refused: ${outcome.reason}`)
  return outcome.contextId ?? ''
}

describe('context maintenance costs no inference while idle', () => {
  it('reaches no provider, no gateway, no Cognition and no filesystem', () => {
    const source = integrationSource()
    // The foundation gets this for free by importing only its own directory. The
    // integration cannot, so it is asserted: there is no route from an admitted
    // selection to anything that costs money or touches a disk.
    for (const forbidden of [
      /from\s+'[^']*model\//,
      /from\s+'[^']*cognition\//,
      /from\s+'[^']*mind\//,
      /from\s+'[^']*brain\//,
      /from\s+'[^']*events\//,
      /from\s+'[^']*security\//,
      /from\s+'[^']*authority/,
      /\bfetch\s*\(/,
      /XMLHttpRequest|\bWebSocket\b/,
      /node:/,
      /setTimeout|setInterval/,
    ]) {
      expect(source, String(forbidden)).not.toMatch(forbidden)
    }
  })

  it('is synchronous everywhere, so no operation can be scheduled behind our back', () => {
    const source = code(integrationSource())
    // A module with no `async` and no `Promise` has no path to a provider: there is
    // no continuation to resume on a later tick with a request in hand.
    expect(source).not.toMatch(/\basync\b/)
    expect(source).not.toMatch(/\bPromise\b/)
  })

  it('reads no clock of its own, so idle is genuinely idle', () => {
    // Core owns the instant. A tick of its own would be a background loop keeping
    // context "fresh", which is a scheduler this lane has no reason to run.
    const source = code(integrationSource())
    expect(source).not.toMatch(/Date\.now\(\)/)
    expect(source).not.toMatch(/setInterval/)
    // One construction of a date, for the default clock, and it is documented as the
    // fallback for a Core that supplied none.
    expect(source.match(/new Date\(\)/g) ?? []).toHaveLength(1)
  })

  it('answers every operation without a thenable, including a full lifecycle', () => {
    const integration = ready()
    const contextId = admitted(integration)
    const outcomes: unknown[] = [
      integration.read(),
      integration.resolve({ term: 'this' }),
      integration.resolveMetadata({ term: 'this' }),
      integration.revoke(contextId, 'the owner took it back'),
      integration.revokeScope(conversation('c1'), 'the owner closed the conversation'),
      integration.agentContext(),
      integration.syncMissionContext({ missionId: 'm-1', status: 'active' }),
    ]
    for (const outcome of outcomes) {
      expect((outcome as { then?: unknown } | null | undefined)?.then).toBeUndefined()
    }
  })
})

describe('private context content reaches no generic surface', () => {
  it('has no journal event type that could carry it', () => {
    // Still true, and it is the assertion that would have to be argued with if a
    // `context.*` family were ever added. The Event Fabric is audit surface: it is
    // read, copied, exported into backups and forwarded to whoever is debugging.
    expect(CORE_EVENT_TYPES.filter((type) => type.startsWith('context.'))).toEqual([])
  })

  it('appends nothing to the journal, because this layer takes no fabric', () => {
    // Stronger than the list being empty: there is no parameter here that could be an
    // event sink, so no future edit can quietly start writing one. Word-anchored,
    // because `persistence` is a field of the projection and a bare `persist` would
    // match it.
    const source = code(readFileSync(join(dir, 'coreIntegration.ts'), 'utf8'))
    expect(source).not.toMatch(/\bappend\b|\bfabric\b|\bjournal\b|\bemit\b|\bwriteFile\b|\bpersisted?\b/)
  })

  it('has no Core command whose result could carry content', () => {
    // The projection is metadata and belongs on its own channel. `resolve` returns an
    // item's content and is deliberately not reachable from a command — the answer to
    // "here" is consumed by the code inside Core that was about to use it.
    const commands: readonly CoreCommandName[] = [
      'context.status.read',
      'context.scope.activate',
      'context.admit',
      'context.revoke',
      'context.revokeScope',
      'context.reference.read',
    ]
    expect(commands).toEqual([
      'context.status.read',
      'context.scope.activate',
      'context.admit',
      'context.revoke',
      'context.revokeScope',
      'context.reference.read',
    ])
    // And the names a caller would reach for to get content back do not exist.
    const all = [...CAPABILITIES, ...commands].join(' ')
    expect(all).not.toMatch(/context\.(resolve|item\.read|content\.read|projection)/)
  })

  it('puts nothing content-bearing in any outcome this layer returns', () => {
    const integration = ready()
    const contextId = admitted(integration)
    const outcomes = [
      integration.admit({ kind: 'file', channel: 'owner_authorization', scope: conversation('c1'), content: 'another secret' }),
      integration.resolveMetadata({ term: 'this' }),
      integration.read(),
      integration.revoke(contextId, 'the owner asked about their health'),
      integration.revokeScope(conversation('c1'), 'the owner closed the conversation'),
    ]
    const shared = JSON.stringify(outcomes)
    for (const secret of [SECRET, SECRET_LABEL, SECRET_URI, 'settlement', '40k', 'file:///', 'health', 'another secret']) {
      expect(shared, secret).not.toContain(secret)
    }
    // And it is not "no information": the measured lengths are still there.
    expect(integration.read().items[0]?.contentLength).toBe(SECRET.length)
  })

  it('exposes a revoke reason only where it cannot travel', () => {
    // The reason is somebody's words, so it lives on a memory-only tombstone. Nothing
    // this layer returns carries it, which is why the refusal text above is fixed
    // sentences rather than the caller's string.
    const integration = ready()
    const contextId = admitted(integration)
    const outcome = integration.revoke(contextId, 'the owner asked about their health')
    expect(JSON.stringify(outcome)).not.toContain('health')
    expect(integration.revoke(contextId, 'again, about their health').reason).toContain('already revoked')
  })

  it('keeps a session scope readable but reports it as metadata', () => {
    const integration = ready()
    integration.admitCoreRecord({
      kind: 'current_mission',
      scope: sessionScope(),
      content: 'The current Mission is m-1 and it is active.',
      originId: 'm-1',
    })
    const rows = integration.read().items
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
  })

  it('imports only Core\'s protocol vocabulary and this directory', () => {
    // The one import this layer has beyond its own files is the protocol's *view*
    // types, because a file that decides what a caller may claim has to know what a
    // claim looks like. Nothing else: no engine, no store, no journal, no facade.
    const source = integrationSource()
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier, specifier).toMatch(/^\.\/|^(\.\.\/protocol\/context|\.\.\/missions\/types)$/)
    }
  })
})

describe('context implies no authority', () => {
  it('adds no field to an outcome that could be read as a permission', () => {
    const integration = ready()
    const contextId = admitted(integration)
    const outcomes = [
      integration.admit({ kind: 'file', channel: 'owner_authorization', scope: conversation('c1'), content: 'more' }),
      integration.resolveMetadata({ term: 'this' }),
      integration.revoke(contextId, 'the owner took it back'),
      integration.revokeScope(conversation('c1'), 'the owner closed the conversation'),
      integration.activateScope(surface('s1')),
      integration.forgetScope(surface('s1'), 'the owner closed the surface'),
      integration.syncMissionContext({ missionId: 'm-1', status: 'active' }),
    ]
    const keys = new Set<string>()
    for (const outcome of outcomes) {
      for (const key of Object.keys(outcome)) keys.add(key)
      for (const key of Object.keys(integration.read())) keys.add(key)
    }
    for (const key of keys) {
      expect(key).not.toMatch(/permission|authorit|capabilit|grant|allow|trust|entitle|escalat/i)
    }
    // `refusal` is the honest counter-example to check by hand: it is a *refusal*,
    // never a permission, and it is a closed vocabulary rather than a capability.
    expect(integration.admit({ channel: 'core_record' }).refusal).toBe('channel_not_requestable')
    expect(CONTEXT_AUTHORITY_FIELDS.length).toBeGreaterThan(0)
  })

  it('holds no method that grants, checks or widens anything', () => {
    const prototype = Object.getPrototypeOf(ready()) as object
    const methods = Object.getOwnPropertyNames(prototype).filter((name) => {
      // The descriptor rather than the property: a getter would be *invoked* by a
      // plain access, on the prototype, with no state behind it.
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      return name !== 'constructor' && typeof descriptor?.value === 'function'
    })
    // The surface is: hold, point at, take back, forget, read, and scope. There is no
    // authorise, no grant, no capability and no escalation.
    for (const name of methods) {
      expect(name).not.toMatch(/permission|authorit|capabilit|grant|allow|escalat/i)
    }
    expect(methods).toEqual(
      expect.arrayContaining(['admit', 'revoke', 'revokeScope', 'resolve', 'read']),
    )
    // And nothing that reads context either — tombstones carry the free-text reason
    // that the projection deliberately does not.
    expect(methods).not.toContain('tombstones')
    expect(methods).not.toContain('purge')
  })

  it('adds no capability to the closed vocabulary', () => {
    // Admitting a selection grants nothing and resolving "here" performs no action, so
    // these five commands are deliberately ungated by Guard. That is only defensible
    // while context stays ungated, which is only true while it confers nothing.
    expect(CAPABILITIES.filter((capability) => capability.startsWith('context.'))).toEqual([])
  })
})