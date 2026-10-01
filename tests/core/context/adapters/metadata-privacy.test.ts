// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as adapters from '../../../../core/context/adapters'
import {
  CONTEXT_ADAPTER_REJECTION_CODES,
  CONTEXT_ADAPTER_REJECTION_REASONS,
  contextSourceAdapterSpec,
  describeContextAdmission,
  type ContextAdapterRejectionCode,
  type ContextAdapterResult,
} from '../../../../core/context/adapters/admission'
import { explicitSelectionAdmission } from '../../../../core/context/adapters/explicit-selection'
import {
  authorizedFileAdmission,
  authorizedProjectAdmission,
} from '../../../../core/context/adapters/project-file'
import {
  sharedMediaAdmission,
  sharedTabAdmission,
} from '../../../../core/context/adapters/tab-media'
import {
  CONTEXT_ADMISSION_CODES,
  CONTEXT_KIND_SOURCES,
  CONTEXT_SOURCES,
  type ContextKind,
  type ContextSource,
} from '../../../../core/context/types'
import { T0, conversation, sequencedStore } from '../fixture'
import {
  CANARY,
  CANARY_LABEL,
  CANARY_URI,
  expectAdmitted,
  expectRefusal,
  mistyped,
} from './fixture'

/**
 * Privacy, table honesty, and reach.
 *
 * Three properties, each asserted as broadly as a test can:
 *
 *  1. **Private content never rides along with metadata.** A candidate keeps
 *     its words; a refusal and a descriptor keep only closed labels, ids,
 *     instants and measurements — canaries prove the words are *absent*, not
 *     merely unprinted.
 *  2. **The adapters cannot drift from the foundation.** Every pairing the
 *     provenance table declares admits here *and* admits through the store;
 *     every pairing it does not is refused before it becomes a request.
 *  3. **Nothing is reached for.** No clock, no capture, no provider, no
 *     filesystem, no Electron — structurally, on the source itself.
 */

const doors: ReadonlyArray<{
  name: string
  kind: ContextKind
  run: (input: unknown) => ContextAdapterResult
}> = [
  { name: 'explicit selection', kind: 'explicit_selection', run: (i) => explicitSelectionAdmission(mistyped(i)) },
  { name: 'authorized project', kind: 'project', run: (i) => authorizedProjectAdmission(mistyped(i)) },
  { name: 'authorized file', kind: 'file', run: (i) => authorizedFileAdmission(mistyped(i)) },
  { name: 'shared tab', kind: 'shared_tab', run: (i) => sharedTabAdmission(mistyped(i)) },
  { name: 'shared media', kind: 'shared_media', run: (i) => sharedMediaAdmission(mistyped(i)) },
]

function sourcesFor(kind: ContextKind): readonly ContextSource[] {
  return CONTEXT_KIND_SOURCES[kind]
}

function secretInput(overrides: Record<string, unknown> = {}): unknown {
  return mistyped({
    scope: conversation('c1'),
    content: CANARY,
    label: CANARY_LABEL,
    uri: CANARY_URI,
    ...overrides,
  })
}

function leaksWords(carrier: unknown): boolean {
  const json = JSON.stringify(carrier)
  return (
    json.includes('settlement') ||
    json.includes('40k') ||
    json.includes('offer-letter') ||
    json.includes('file:///')
  )
}

describe('metadata never carries the private part', () => {
  it('describes a candidate with closed labels, ids, instants and measurements only', () => {
    const admission = expectAdmitted(
      explicitSelectionAdmission(
        mistyped(secretInput({ originId: 'share-9', capturedAt: '2026-06-01T08:59:00.000Z', ttlMs: 60_000 })),
      ),
    )
    const meta = describeContextAdmission(admission)
    expect(Object.keys(meta).sort()).toEqual([
      'capturedAt',
      'contentLength',
      'kind',
      'labelLength',
      'originId',
      'scopeId',
      'scopeKind',
      'source',
      'ttlMs',
    ])
    // No field a sentence could hide in — and none carries this one.
    expect(leaksWords(meta)).toBe(false)
    // The measurement survives even though the words do not ride along.
    expect(meta.contentLength).toBe(CANARY.length)
    expect(meta.labelLength).toBe(CANARY_LABEL.length)
    // What metadata *is* for: exact echoes of the closed shape.
    expect(meta.originId).toBe('share-9')
    expect(meta.scopeId).toBe('c1')
    expect(meta.capturedAt).toBe('2026-06-01T08:59:00.000Z')
    expect(meta.ttlMs).toBe(60_000)
  })

  it('refusals phrase themselves from the fixed table and never quote the input', () => {
    const battery: ReadonlyArray<readonly [ContextAdapterRejectionCode, unknown]> = [
      ['input_invalid', mistyped({ scope: conversation('c1'), content: CANARY, limits: {} })],
      ['authority_not_admissible', secretInput({ grant: CANARY })],
      ['kind_mismatch', secretInput({ kind: 'file' })],
      ['kind_deferred', secretInput({ kind: 'active_window' })],
      ['kind_unknown', secretInput({ kind: 'clipboard' })],
      ['source_not_permitted', secretInput({ source: 'owner_share' })],
      ['scope_confusion', mistyped({ content: CANARY, scopeId: CANARY_LABEL })],
      ['scope_confusion', secretInput({ scope: { scopeKind: 'session', scopeId: CANARY } })],
      ['invalid_scope', mistyped({ content: CANARY })],
      ['content_empty', mistyped({ scope: conversation('c1'), content: ' ', label: CANARY })],
      ['content_too_large', secretInput({ content: CANARY.repeat(100) })],
      ['label_too_large', secretInput({ label: CANARY_LABEL.repeat(10) })],
      ['uri_too_large', secretInput({ uri: CANARY_URI.repeat(60) })],
      ['invalid_origin', secretInput({ originId: CANARY.repeat(3) })],
      ['invalid_ttl', secretInput({ ttlMs: -CANARY.length })],
      ['invalid_instant', secretInput({ capturedAt: CANARY })],
    ]
    for (const [code, input] of battery) {
      const result = explicitSelectionAdmission(mistyped(input))
      expectRefusal(result, code)
      expect(leaksWords(result), `refusal '${code}' leaked its input`).toBe(false)
    }
    // `origin_required` can only be provoked at the file door; it too says
    // nothing about the private words that rode in with it.
    const missingOrigin = authorizedFileAdmission(mistyped(secretInput({ source: 'host_report' })))
    expectRefusal(missingOrigin, 'origin_required')
    expect(leaksWords(missingOrigin)).toBe(false)
  })

  it('keeps the rejection vocabulary inside the foundation\'s language', () => {
    const asStrings = CONTEXT_ADAPTER_REJECTION_CODES as readonly string[]
    for (const code of CONTEXT_ADMISSION_CODES) {
      expect(asStrings).toContain(code)
    }
    const extras = CONTEXT_ADAPTER_REJECTION_CODES.filter(
      (code) => !(CONTEXT_ADMISSION_CODES as readonly string[]).includes(code),
    )
    expect([...extras].sort()).toEqual([
      'authority_not_admissible',
      'input_invalid',
      'kind_mismatch',
      'scope_confusion',
    ])
    for (const code of CONTEXT_ADAPTER_REJECTION_CODES) {
      const reason = CONTEXT_ADAPTER_REJECTION_REASONS[code]
      expect(typeof reason).toBe('string')
      expect(reason.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('the adapters cannot drift from the provenance table', () => {
  it('every declared kind/source pairing yields a candidate the store admits', () => {
    for (const door of doors) {
      const permitted = sourcesFor(door.kind)
      expect(permitted.length).toBeGreaterThan(0)
      for (const source of permitted) {
        const admission = expectAdmitted(
          door.run({
            scope: conversation('c1'),
            content: `bounded ${door.name} content`,
            label: `a ${door.name} label`,
            uri: null,
            source,
            originId: source === 'host_report' ? 'rec-1' : null,
          }),
        )
        expect(admission.kind).toBe(door.kind)
        expect(admission.source).toBe(source)

        const store = sequencedStore()
        store.setActiveScope(conversation('c1'))
        const result = store.admit(admission, T0)
        if (!result.ok) {
          throw new Error(`store refused what ${door.name} produced: ${result.code}`)
        }
        expect(result.item.kind).toBe(door.kind)
        expect(result.item.provenance.source).toBe(source)
        expect(leaksWords(result.item.provenance)).toBe(false)
      }
    }
  })

  it('every undeclared source is refused before it can become a request', () => {
    for (const door of doors) {
      const permitted: readonly string[] = sourcesFor(door.kind)
      for (const source of CONTEXT_SOURCES) {
        if (permitted.includes(source)) continue
        expectRefusal(
          door.run({
            scope: conversation('c1'),
            content: `bounded ${door.name} content`,
            source,
            originId: 'rec-1',
          }),
          'source_not_permitted',
        )
      }
    }
  })

  it('a spec that disagrees with the table is a programmer error caught at load', () => {
    expect(() => contextSourceAdapterSpec('file', ['owner_selection'], 'owner_selection')).toThrow()
    expect(() =>
      contextSourceAdapterSpec('shared_tab', ['owner_share', 'host_report'], 'core_record'),
    ).toThrow()
    expect(() =>
      contextSourceAdapterSpec('shared_tab', ['owner_share', 'host_report'], 'owner_share'),
    ).not.toThrow()
  })

  it('exposes exactly the five doors and the engine — and no sixth way in', () => {
    expect(Object.keys(adapters).sort()).toEqual([
      'CONTEXT_ADAPTER_REJECTION_CODES',
      'CONTEXT_ADAPTER_REJECTION_REASONS',
      'authorizedFileAdmission',
      'authorizedProjectAdmission',
      'buildContextAdmission',
      'contextSourceAdapterSpec',
      'describeContextAdmission',
      'explicitSelectionAdmission',
      'sharedMediaAdmission',
      'sharedTabAdmission',
    ])
    // `current_mission` (Core's own record) deliberately has no door here, and
    // an incomplete input never quietly succeeds: it is refused by name.
    expect(explicitSelectionAdmission(mistyped({ scope: conversation('c1') })).ok).toBe(false)
  })
})

describe('the adapters reach nothing', () => {
  const dir = fileURLToPath(new URL('../../../../core/context/adapters', import.meta.url))

  it('is five files importing only the closed context vocabulary', () => {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .sort()
    expect(files).toEqual([
      'admission.ts',
      'explicit-selection.ts',
      'index.ts',
      'project-file.ts',
      'tab-media.ts',
    ])
    const source = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      // Relative, and only ever *within* the context domain: no journal, no
      // model layer, no Guard, no facade, no filesystem, no Electron.
      expect(specifier, specifier).toMatch(/^(\.|\.\.)\//)
      expect(specifier, specifier).not.toMatch(
        /events|model|cognition|guard|authority|security|electron|node:|index/,
      )
    }
  })

  it('contains no clock reads, no capture, and nothing that can wait', () => {
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    const source = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
    // The instant of admission always comes from the caller (#20's job);
    // adapters only preserve what they were handed.
    expect(source).not.toMatch(/Date\.now\(\)/)
    expect(source).not.toMatch(/new Date\(\)/)
    expect(source).not.toMatch(/\basync\b/)
    expect(source).not.toMatch(/\bPromise\b/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/setTimeout|setInterval/)
    expect(source).not.toMatch(/readFile|readdir|createReadStream|desktopCapturer|screen\.|BrowserWindow/)
  })
})
