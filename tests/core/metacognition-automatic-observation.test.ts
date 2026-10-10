// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { ModelRequest } from '../../core/model/provider'
import type { SearchResult } from '../../core/research/types'

describe('Milestone 3 — Automatic Performance Observation from Authoritative Mission Lifecycle', () => {
  let core: Core | undefined
  let server: Server
  let directory: string
  let origin: string
  let searches: string[]
  let reads: string[]
  let forceSearchUnavailable: boolean

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'freya-auto-obs-'))
    searches = []
    reads = []
    forceSearchUnavailable = false
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      if (url.pathname === '/search') {
        if (forceSearchUnavailable) {
          response.setHeader('content-type', 'application/json')
          response.end('[]')
          return
        }
        searches.push(url.searchParams.get('q')!)
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              title: 'Provider pricing',
              url: 'https://sources.example.org/pricing',
              snippet: 'Pricing evidence',
              sourceDomain: 'sources.example.org',
              rank: 1,
              publishedAt: null,
              retrievedAt: new Date().toISOString(),
            },
          ]),
        )
      } else {
        reads.push(url.pathname)
        response.statusCode = 200
        response.end(
          'Example model costs €15 monthly. It supports text analysis. Limited context window.',
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await core?.stop('teardown')
    core = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  const proposalEnvelope = () =>
    `FREYA_TOOL_CALL\n${JSON.stringify({
      tool: 'propose_mission',
      goal: 'Compare model pricing and limitations',
      scope: 'Public source retrieval and comparison',
      criteria: '["Retrieve pricing and limitations with attributed quotes"]',
    })}\nFREYA_TOOL_CALL_END`

  const plan = (queries = ['model pricing', 'model limitations']) =>
    JSON.stringify({
      steps: queries.map((query, index) => ({
        intent: `Investigate ${query}`,
        capability: 'research.search',
        input: { query, minSources: 1 },
        dependsOn: index ? [index - 1] : [],
      })),
    })

  async function startCore() {
    const provider = new FakeModelProvider()
    provider.complete = async (request: ModelRequest) => {
      const system = request.messages[0]?.content ?? ''
      const text = system.startsWith('Propose a bounded mission plan')
        ? plan()
        : system.startsWith('Return only JSON {"findings"')
          ? (() => {
              const data = JSON.parse(request.messages[1]!.content) as {
                sources: { sourceId: string }[]
              }
              return JSON.stringify({
                findings: [
                  {
                    sourceId: data.sources[0]!.sourceId,
                    category: 'pricing',
                    quote: 'Example model costs €15 monthly.',
                  },
                  {
                    sourceId: data.sources[0]!.sourceId,
                    category: 'limitations',
                    quote: 'Limited context window.',
                  },
                ],
              })
            })()
          : proposalEnvelope()
      return {
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        text,
        inputTokens: 100,
        outputTokens: 200,
      }
    }

    const options: CoreOptions = {
      dataPath: join(directory, 'events.jsonl'),
      missionKey: new Uint8Array(32).fill(9),
      conversationKey: new Uint8Array(32).fill(8),
      providers: [provider],
      research: {
        searchProvider: {
          id: 'local-http',
          status: () => ({ ready: true, reason: 'local fixture' }),
          search: async (query, opts) =>
            (await fetch(`${origin}/search?q=${encodeURIComponent(query)}`, {
              signal: opts.signal,
            })).json() as Promise<SearchResult[]>,
        },
        browserFactory: {
          async create() {
            let url = ''
            return {
              async navigate(target) {
                url = target
              },
              async read(signal) {
                const response = await fetch(`${origin}${new URL(url).pathname}`, { signal })
                if (!response.ok) throw new Error('unreachable local source')
                const text = await response.text()
                return {
                  id: 'fixture-document',
                  url,
                  canonicalUrl: null,
                  title: 'Provider pricing',
                  sourceDomain: new URL(url).hostname,
                  retrievedAt: new Date().toISOString(),
                  headings: [],
                  text,
                  links: [],
                  metadata: {},
                  contentLength: text.length,
                  truncated: false,
                }
              },
              async close() {},
            }
          },
        },
      },
    }

    core = createCore(options)
    await core.start()

    const created = await core.handleCommand({
      command: 'conversation.create',
      requestId: 'create-1',
    })
    if (created.conversation?.operation !== 'created') {
      throw new Error('conversation creation refused')
    }
    const conversationId = created.conversation.conversation.conversationId
    return { conversationId }
  }

  it('automatically observes real mission completion in Metacognition with zero direct calls', async () => {
    const { conversationId } = await startCore()

    // Submit user turn asking for research
    const turnResult = await core!.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 'turn-1',
      payload: {
        conversationId,
        text: 'Research models, compare pricing, verify sources and report.',
      },
    })
    if (turnResult.conversation?.operation !== 'turn') {
      throw new Error('expected turn operation')
    }
    const proposalMessageId = turnResult.conversation.turn.assistantMessage?.messageId
    expect(proposalMessageId).toBeDefined()

    // Decide to approve mission
    const decisionResult = await core!.handleCommand({
      command: 'conversation.mission.decide',
      requestId: 'decision-1',
      payload: { conversationId, proposalMessageId, decision: 'approve' },
    })
    expect(decisionResult).toMatchObject({ ok: true })

    // Wait for the mission to complete
    await vi.waitFor(
      () => {
        expect(core!.mission().missions[0]?.status).toBe('completed')
      },
      { timeout: 5000 },
    )

    const missionId = core!.mission().missions[0]!.missionId

    // Verify Metacognition automatically recorded telemetry without any manual call
    const metacognition = core!.metacognition()
    expect(metacognition).toBeDefined()

    await vi.waitFor(
      async () => {
        const telemetries = await metacognition!.getTelemetries()
        expect(telemetries).toHaveLength(1)
      },
      { timeout: 3000 },
    )

    const telemetries = await metacognition!.getTelemetries()
    const telemetry = telemetries[0]!

    // Verify properties adhere to zero-fabrication and accuracy standards
    expect(telemetry.missionId).toBe(missionId)
    expect(telemetry.taskType).toBe('research')
    expect(telemetry.outcome).toBe('success')
    expect(telemetry.verified).toBe(true)
    expect(telemetry.verificationReason).toMatch(/verifi/i)
    expect(telemetry.actionAttempts).toBeGreaterThanOrEqual(1)
    expect(telemetry.toolErrors).toBe(0)
    expect(telemetry.durationMs).toBeGreaterThanOrEqual(0)
    // Strictly zero fabrication: model tokens/calls null when not instrumented
    expect(telemetry.modelTokens).toBeNull()
    expect(telemetry.modelCalls).toBeNull()
    expect(telemetry.externalRequests).toBeNull()
    expect(telemetry.failureAttribution).toBeNull()

    // Summary must reflect the automatic telemetry
    const summary = await metacognition!.getSummary()
    expect(summary.totalMissions).toBe(1)
    expect(summary.successRate).toBe(1.0)
    expect(summary.verificationRate).toBe(1.0)

    // Deduplication check: repeated delivery of the same mission event does not duplicate telemetry
    const internal = core as unknown as {
      observeAuthoritativeMission(event: unknown): Promise<void>
    }
    await internal.observeAuthoritativeMission({
      type: 'mission.completed',
      sequence: 999,
      occurredAt: new Date().toISOString(),
      payload: { missionId },
    })

    const telemetriesAfterDuplicate = await metacognition!.getTelemetries()
    expect(telemetriesAfterDuplicate).toHaveLength(1)
  })

  it('does not create misleading telemetry from a forged failure event for an unknown mission', async () => {
    await startCore()
    const internal = core as unknown as {
      observeAuthoritativeMission(event: unknown): Promise<void>
    }
    await internal.observeAuthoritativeMission({
      type: 'mission.failed',
      sequence: 100,
      occurredAt: new Date().toISOString(),
      payload: { missionId: 'msn-nonexistent', reason: 'insufficient_sources' },
    })
    expect(await core!.metacognition()!.getTelemetries()).toHaveLength(0)
  })

  it('does not fabricate terminal failure telemetry for a legitimately blocked Mission', async () => {
    const { conversationId } = await startCore()
    forceSearchUnavailable = true
    const turn = await core!.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 'fail-turn-1',
      payload: {
        conversationId,
        text: 'Research models and verify the pricing evidence.',
      },
    })
    if (turn.conversation?.operation !== 'turn') throw new Error('Expected conversation turn')
    const proposalMessageId = turn.conversation.turn.assistantMessage?.messageId
    if (!proposalMessageId) throw new Error('Expected Mission proposal')
    const decision = await core!.handleCommand({
      command: 'conversation.mission.decide',
      requestId: 'fail-approve-1',
      payload: { conversationId, proposalMessageId, decision: 'approve' },
    })
    expect(decision.ok).toBe(true)

    await vi.waitFor(
      () => expect(core!.mission().missions[0]?.status).toBe('blocked'),
      { timeout: 7000 },
    )
    // Blocked awaiting a recovery or further authorization is not terminal.
    // The observer only records authoritative completion/failure, never guesses.
    expect(await core!.metacognition()!.getTelemetries()).toHaveLength(0)
  })
})
