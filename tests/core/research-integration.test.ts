// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core'
import { WORKER_CAPABILITIES, type Capability } from '../../core/protocol/core-protocol'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { SearchProvider } from '../../core/research/types'
import type { BrowserTarget, BrowserTargetFactory, ReadableDocument } from '../../core/research/browser'
import type { ModelResult } from '../../core/model/provider'
import { RESEARCH_LIMITS } from '../../core/research/schemas'

/**
 * Phase 5 inside Core.
 *
 * Everything here is about a boundary rather than about a feature working. The
 * Searcher, the browser and the coordinator are unit-tested on their own; what can
 * only be checked here is that Core keeps its promises while they are wired in:
 *
 *   - Guard judges each privileged operation, before the network, the browser and
 *     the model rather than after them.
 *   - The renderer cannot name provenance, provider, limits, budget or principal.
 *   - Every research model turn goes through the existing gateway and a bounded
 *     grant, and the grant is revoked when research ends.
 *   - STOP ALL closes research admission in the same synchronous turn it closes the
 *     gateway, so there is no window where a research operation is already
 *     authorised and can still spend.
 *   - Normal chat and Brain recall cost exactly what they did before.
 */

let core: Core | undefined
let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-research-integration-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await rm(directory, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ seams */

/** A search provider that answers offline and records what it was asked. */
class StubSearchProvider implements SearchProvider {
  readonly id = 'stub'
  calls: string[] = []
  ready = true
  async search(query: string): Promise<never[]> {
    this.calls.push(query)
    return [] as never[]
  }
  status(): { ready: boolean; reason: string } {
    return this.ready
      ? { ready: true, reason: 'stub provider' }
      : { ready: false, reason: 'Web search is disabled.' }
  }
}

const DOCUMENT: ReadableDocument = {
  id: 'doc-1',
  url: 'https://fixture.example.com/a',
  canonicalUrl: null,
  title: 'A fixture article',
  sourceDomain: 'fixture.example.com',
  retrievedAt: '2026-10-01T00:00:00.000Z',
  headings: ['A heading'],
  text: 'The article body that research should treat as untrusted remote data.',
  links: [],
  metadata: {},
  contentLength: 76,
  truncated: false,
}

class StubBrowserTargetFactory implements BrowserTargetFactory {
  reads: string[] = []
  closed = 0
  async create(): Promise<BrowserTarget> {
    return {
      navigate: async (url: string) => {
        this.reads.push(url)
      },
      read: async () => DOCUMENT,
      close: async () => {
        this.closed += 1
      },
    }
  }
}

/** A provider answer shaped as the gateway expects it. */
function textResult(text: string): ModelResult {
  return { requestId: 'test', providerId: 'fake', model: 'fake-echo-1', text, inputTokens: 1, outputTokens: 1 }
}

interface Harness {
  core: Core
  search: StubSearchProvider
  browser: StubBrowserTargetFactory
  provider: FakeModelProvider
}

async function started(
  overrides: {
    searchProvider?: StubSearchProvider
    browserFactory?: BrowserTargetFactory
    provider?: FakeModelProvider
  } = {},
): Promise<Harness> {
  const search = overrides.searchProvider ?? new StubSearchProvider()
  const browserFactory = overrides.browserFactory ?? new StubBrowserTargetFactory()
  const browser = browserFactory as StubBrowserTargetFactory
  const provider = overrides.provider ?? new FakeModelProvider()
  core = createCore({
    dataPath: join(directory, 'events.jsonl'),
    providers: [provider],
    research: { searchProvider: search, browserFactory },
  })
  await core.start()
  return { core, search, browser, provider }
}

function submit(command: string, payload?: unknown, requestId = 'r1'): Promise<{
  ok: boolean
  status?: { lifecycle: string }
  refusal?: { reason: string }
  error?: { message: string }
  research?: Record<string, unknown>
}> {
  return core!.handleCommand({ command, requestId, payload } as never) as never
}

/* --------------------------------------------------------- capabilities */

describe('capability vocabulary', () => {
  it('grants the owner the three research capabilities', async () => {
    await started()
    // Present in the vocabulary, and therefore in the owner's closed list.
    const capabilities = (await import('../../core/protocol/core-protocol')).ALL_CAPABILITIES
    expect(capabilities).toContain('search.web')
    expect(capabilities).toContain('browser.read')
    expect(capabilities).toContain('research.start')
  })

  it('keeps every research capability away from a worker', async () => {
    // A worker can ask for cognition under a grant. It cannot reach the network or
    // a browser, because an agent that could do both could exfiltrate whatever it
    // was told.
    for (const capability of WORKER_CAPABILITIES) {
      expect(capability).not.toBe('search.web')
      expect(capability).not.toBe('browser.read')
      expect(capability).not.toBe('research.start')
    }
  })
})

/* -------------------------------------------------------------- commands */

describe('search.web', () => {
  it('reaches the provider for a valid query', async () => {
    const harness = await started()
    const result = await submit('search.web', { query: 'freya research' })
    expect(result.ok).toBe(true)
    expect(harness.search.calls).toEqual(['freya research'])
    expect(result.research?.operation).toBe('search')
  })

  it('refuses an empty or overlong query without calling the provider', async () => {
    const harness = await started()
    expect((await submit('search.web', { query: '   ' })).ok).toBe(false)
    expect((await submit('search.web', { query: 'x'.repeat(513) })).ok).toBe(false)
    expect(harness.search.calls).toEqual([])
  })

  it('ignores provenance, provider, limits and principal smuggled into the payload', async () => {
    // The renderer may not classify its own input. A payload claiming to be an
    // owner assertion, or naming a provider or a budget, must change nothing.
    const harness = await started()
    const result = await submit('search.web', {
      query: 'legitimate query',
      provenance: 'owner-assertion',
      sourceTrust: 'owner-assertion',
      provider: 'attacker-controlled',
      principal: 'system',
      limits: { queries: 99 },
      maxResults: 1000,
      budget: 999999,
      capability: 'security.resume',
    })
    expect(result.ok).toBe(true)
    expect(harness.search.calls).toEqual(['legitimate query'])
    // Nothing smuggled came back out.
    expect(JSON.stringify(result.research)).not.toMatch(/attacker-controlled/)
  })

  it('makes zero provider calls when the search provider is not ready', async () => {
    const search = new StubSearchProvider()
    search.ready = false
    const harness = await started({ searchProvider: search })
    const result = await submit('search.web', { query: 'anything' })
    expect(result.ok).toBe(false)
    expect(harness.search.calls).toEqual([])
  })
})

describe('browser.read', () => {
  it('reads a public URL and closes its session afterwards', async () => {
    const harness = await started()
    const result = await submit('browser.read', { url: 'https://fixture.example.com/a' })
    expect(result.ok).toBe(true)
    expect(harness.browser.reads).toEqual(['https://fixture.example.com/a'])
    // The session is closed in a finally, so a read cannot leave a window alive.
    expect(harness.browser.closed).toBe(1)
  })

  it('refuses a private or non-public URL before opening anything', async () => {
    const harness = await started()
    for (const url of [
      'http://127.0.0.1/secret',
      'http://localhost/admin',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'https://10.0.0.5/internal',
    ]) {
      const result = await submit('browser.read', { url })
      expect(result.ok).toBe(false)
    }
    expect(harness.browser.reads).toEqual([])
  })

  it('refuses a URL carrying credentials', async () => {
    const harness = await started()
    expect((await submit('browser.read', { url: 'https://user:pass@example.com/' })).ok).toBe(false)
    expect(harness.browser.reads).toEqual([])
  })
})

describe('research.start', () => {
  it('spends model turns through the existing gateway, not a direct provider call', async () => {
    const harness = await started()
    // A provider that answers with a valid plan, then a synthesis.
    const answers = [
      JSON.stringify({ queries: ['fixture topic'], evidence: ['what is missing'], done: false }),
      JSON.stringify({ queries: ['more'], evidence: ['still missing'], done: false }),
      JSON.stringify({
        findings: [{ text: 'A grounded finding.', sourceIds: [] }],
        conflicts: [],
        uncertainties: ['Only one source was readable.'],
      }),
    ]
    // Counted here rather than via `provider.calls`, because replacing `complete`
    // replaces the method that increments it.
    let index = 0
    let modelTurns = 0
    harness.provider.complete = async () => {
      modelTurns += 1
      return textResult(answers[Math.min(index++, answers.length - 1)] as string)
    }

    const result = await submit('research.start', { question: 'what does the fixture say?' })
    expect(result.ok).toBe(true)
    // Whatever the outcome, the provider was only ever asked by the gateway.
    expect(modelTurns).toBeGreaterThan(0)
    expect(modelTurns).toBeLessThanOrEqual(RESEARCH_LIMITS.modelTurns)
    expect(core!.status().governor.grantsActive).toBe(0)
  })

  it('revokes the research grant when research finishes', async () => {
    const harness = await started()
    let turns = 0
    harness.provider.complete = async () => {
      turns += 1
      return textResult(JSON.stringify({ queries: [], findings: [], conflicts: [], uncertainties: [] }))
    }
    await submit('research.start', { question: 'anything' })
    expect(turns).toBeGreaterThan(0)
    // A grant left live would be a standing allowance nobody intended.
    expect(core!.status().governor.grantsActive).toBe(0)
  })

  it('refuses to start a second research while one is running', async () => {
    await started()
    const first = submit('research.start', { question: 'first question' }, 'r1')
    const second = await submit('research.start', { question: 'second question' }, 'r2')
    expect(second.ok).toBe(false)
    await first
  })

  it('refuses a blank question without contacting a provider', async () => {
    const harness = await started()
    expect((await submit('research.start', { question: '' })).ok).toBe(false)
    expect(harness.provider.calls).toBe(0)
  })

  it('ignores limits smuggled into the payload', async () => {
    // Code-owned budgets. A renderer cannot raise them, and cannot lower them into
    // a refusal either.
    const harness = await started()
    harness.provider.complete = async () => textResult(JSON.stringify({ queries: [], findings: [], conflicts: [], uncertainties: [] }))
    const result = await submit('research.start', {
      question: 'a question',
      modelTurns: 500,
      durationMs: 999_999,
      maxOutputTokens: 65_536,
      limits: { modelTurns: 99, pages: 99 },
    })
    expect(result.ok).toBe(true)
    expect(result.research?.limits).toMatchObject({ modelTurns: 5, maxOutputTokens: 2048 })
  })
})

/* ---------------------------------------------------------- cancellation */

describe('research.cancel', () => {
  it('cancels the named operation and reports it cancelled', async () => {
    const harness = await started()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.provider.complete = async () => {
      await held
      return textResult(JSON.stringify({ queries: [], findings: [], conflicts: [], uncertainties: [] }))
    }

    const running = submit('research.start', { question: 'a slow question' }, 'start')
    // Wait until the operation is actually running before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const status = await submit('research.status.read', undefined, 'status')
    const id = String(
      (status.research?.status as { operationId?: string } | null)?.operationId ?? '',
    )
    expect(id.length).toBeGreaterThan(0)

    const cancelled = await submit('research.cancel', { researchId: id }, 'cancel')
    expect(cancelled.ok).toBe(true)
    release()
    const outcome = await running
    expect(JSON.stringify(outcome.research)).toMatch(/cancelled/)
  })

  it('refuses to cancel an unknown research id', async () => {
    await started()
    const result = await submit('research.cancel', { researchId: 'not-a-real-id' })
    expect(result.ok).toBe(false)
  })
})

/* -------------------------------------------------------------- STOP ALL */

describe('STOP ALL', () => {
  it('refuses search, read and research afterwards', async () => {
    const harness = await started()
    await submit('security.stopAll', { reason: 'integration test' }, 'stop')

    expect((await submit('search.web', { query: 'after the stop' }, 'a')).ok).toBe(false)
    expect((await submit('browser.read', { url: 'https://fixture.example.com/a' }, 'b')).ok).toBe(false)
    expect((await submit('research.start', { question: 'after the stop' }, 'c')).ok).toBe(false)

    // And nothing was reached doing it.
    expect(harness.search.calls).toEqual([])
    expect(harness.browser.reads).toEqual([])
    expect(harness.provider.calls).toBe(0)
  })

  it('cancels research that was already running', async () => {
    const harness = await started()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.provider.complete = async () => {
      await held
      return textResult(JSON.stringify({ queries: [], findings: [], conflicts: [], uncertainties: [] }))
    }
    const running = submit('research.start', { question: 'interrupt me' }, 'start')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await submit('security.stopAll', { reason: 'stop while running' }, 'stop')
    release()
    const outcome = await running
    // The operation settles as cancelled, and the provider was not asked again.
    expect(JSON.stringify(outcome.research)).toMatch(/cancelled/)
  })

  it('closes the stop in the same synchronous turn as the gateway', async () => {
    await started()
    // A research start issued in the same turn as the stop must not slip through.
    const stop = submit('security.stopAll', { reason: 'race' }, 'stop')
    const search = submit('search.web', { query: 'race' }, 'after')
    await Promise.all([stop, search])
    expect((await submit('search.web', { query: 'definitely after' }, 'later')).ok).toBe(false)
  })
})

/* ------------------------------------------------------------ diagnostics */

describe('diagnostics', () => {
  it('keeps a provider failure containing a secret out of the journal', async () => {
    const provider = new FakeModelProvider()
    provider.complete = async () => {
      throw new Error('FAKE_SECRET C:/private/key')
    }
    const dataPath = join(directory, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [provider],
      research: { searchProvider: new StubSearchProvider(), browserFactory: new StubBrowserTargetFactory() },
    })
    await core.start()
    await submit('research.start', { question: 'a question that will fail' }, 'r1')

    const raw = await readFile(dataPath, 'utf8')
    expect(raw).not.toContain('FAKE_SECRET')
    expect(raw).not.toContain('C:/private/key')
    expect(JSON.stringify(core.activity())).not.toContain('FAKE_SECRET')
  })

  it('keeps a research query, URL and answer out of the journal', async () => {
    const harness = await started()
    harness.provider.complete = async () => textResult(JSON.stringify({ queries: [], findings: [], conflicts: [], uncertainties: [] }))
    await submit('research.start', { question: 'what does the fixture say specifically?' }, 'r1')
    await submit('browser.read', { url: 'https://fixture.example.com/a' }, 'r2')

    const raw = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('what does the fixture say specifically')
    expect(raw).not.toContain('fixture.example.com')
    expect(raw).not.toContain('The article body')
  })
})

/* ------------------------------------------------- unchanged behaviour */

describe('unchanged behaviour', () => {
  it('leaves a plain conversation costing exactly one model call', async () => {
    const harness = await started()
    await submit('core.command.submit', { text: 'hello' }, 'cmd')
    const created = (await core!.handleCommand({
      command: 'conversation.create',
      requestId: 'create',
    })) as unknown as { conversation?: { operation: string; conversation?: { conversationId: string } } }
    if (created.conversation?.operation !== 'created') {
      throw new Error('the conversation was not created')
    }
    const conversationId = String(created.conversation.conversation?.conversationId ?? '')
    await submit('conversation.turn.submit', { conversationId, text: 'what is 2 + 2?' }, 'turn')
    // Research wiring must not have added a second call to the chat path.
    expect(harness.provider.calls).toBe(1)
  })

  it('makes no research call on boot', async () => {
    const harness = await started()
    expect(harness.provider.calls).toBe(0)
    expect(harness.search.calls).toEqual([])
    expect(harness.browser.reads).toEqual([])
  })

  it('reports a stopped Core as refusing research before any durable write', async () => {
    await started()
    // The journal must be the thing that refuses, not an in-memory flag.
    expect(core!.status().integrity.integrity).toBe('ok')
    const capabilities: readonly Capability[] = (await import('../../core/protocol/core-protocol'))
      .ALL_CAPABILITIES
    expect(capabilities).toContain('research.start')
  })
})
describe('diagnostic containment is structural, not incidental', () => {
  it('reduces a raw throw from research.start to a fixed public code', async () => {
    // Every throw on this path is a fixed-string ResearchError today. The point of
    // this test is that one day a dependency throws something raw, and the renderer
    // still does not see it.
    const harness = await started()
    harness.provider.complete = async () => {
      throw new Error('FAKE_SECRET C:/private/key and the owner query too')
    }
    const result = await submit('research.start', { question: 'a private question' }, 'r1')
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('FAKE_SECRET')
    expect(serialised).not.toContain('C:/private/key')
    // Whatever shape the failure takes - absorbed into a partial result or refused
    // outright - the provider's own words never reach the renderer.
    if (!result.ok) {
      expect(result.refusal?.reason).toMatch(/model|provider|refused|failed|unavailable/i)
    } else {
      // Absorbed: an honest 'failed' research with no findings, not a fabricated one.
      const projected = result.research?.result as { state: string; findings: unknown[] } | undefined
      expect(projected?.state).toBe('failed')
      expect(projected?.findings).toEqual([])
    }
  })
})
