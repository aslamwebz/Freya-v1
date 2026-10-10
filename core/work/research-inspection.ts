import type { WorkRegistry } from './capability'
import type { ResearchIntegration } from '../research/coreIntegration'
import { buildSource, selectSources } from '../research/evidence'
import type { SearchResult } from '../research/types'
import type { MissionResearchEvidence } from '../missions/chat-types'

export interface MissionResearchPorts {
  readonly research: ResearchIntegration
  /** Resolves the actual attached Work parent and charges before each external read. */
  admit(runId: string, stepKey: string, signal?: AbortSignal): Promise<void>
  save(runId: string, stepKey: string, evidence: MissionResearchEvidence): Promise<void>
  read(runId: string, stepKey: string): Promise<MissionResearchEvidence | null>
}

export function registerResearchInspection(registry: WorkRegistry, ports: MissionResearchPorts): void {
  registry.register({ name: 'research.search', capability: 'research.start', risk: 'routine', verifier: 'research.sources.verified',
    describe: () => 'searches public sources and reads bounded evidence without modifying external systems',
    async execute(request, context) {
      const { query, minSources } = request.input
      if (Object.keys(request.input).some(key => key !== 'query' && key !== 'minSources') || typeof query !== 'string' || !query.trim() || query.length > 512 || !Number.isInteger(minSources) || Number(minSources) < 1 || Number(minSources) > 5) throw new Error('Research input is invalid.')
      const sources: NonNullable<MissionResearchEvidence>['sources'][number][] = []
      try {
        await ports.admit(request.runId, request.stepKey, context.signal)
        const results = await ports.research.searchWeb(query, context.signal) as SearchResult[]
        for (const row of selectSources(results, 5)) {
          await ports.admit(request.runId, request.stepKey, context.signal)
          try {
            const document = await ports.research.readWebPage(row.url, context.signal)
            const source = buildSource(document, query, 3000)
            if (source) sources.push(source)
          } catch { context.signal.throwIfAborted() }
        }
        if (sources.length < Number(minSources)) throw new Error('insufficient_sources')
        await ports.save(request.runId, request.stepKey, { sources, verified: false, failure: null })
        return { observation: { kind: 'result', summary: 'Retrieved public source excerpts; factual accuracy is unverified.', data: { sourceCount: sources.length } } }
      } catch {
        await ports.save(request.runId, request.stepKey, { sources, verified: false, failure: 'retrieval_not_established' })
        throw new Error('Research retrieval could not establish enough authorized sources.')
      }
    },
  })
  registry.registerVerifier({ name: 'research.sources.verified', async verify(request) {
    try {
      const evidence = await ports.read(request.runId, request.stepKey)
      if (!evidence || evidence.failure || evidence.sources.length < Number(request.input.minSources)) throw new Error('missing evidence')
      for (const source of evidence.sources) {
        await ports.admit(request.runId, request.stepKey)
        const document = await ports.research.readWebPage(source.url)
        if (document.url !== source.url || !document.text.trim().includes(source.excerpt)) throw new Error('source changed')
      }
      await ports.save(request.runId, request.stepKey, { ...evidence, verified: true })
      return { verdict: 'passed', reason: 'Independent source rereads matched the retained excerpts. Factual accuracy remains unverified.' }
    } catch {
      const evidence = await ports.read(request.runId, request.stepKey)
      if (evidence) await ports.save(request.runId, request.stepKey, { ...evidence, verified: false, failure: 'source_verification_failed' })
      return { verdict: 'failed', reason: 'Independent source retrieval was not established.' }
    }
  } })
}
