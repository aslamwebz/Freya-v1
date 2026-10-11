import type { ModelProvider } from './provider'

export function e2eResearchFixtureProvider(env: { FREYA_E2E?: string; FREYA_E2E_RESEARCH?: string }): ModelProvider | null {
  if (!(env.FREYA_E2E === '1' && env.FREYA_E2E_RESEARCH === 'fixtures')) return null
  const plans = [
    JSON.stringify({ queries: ['encrypted storage'], evidence: ['durability'], done: false }),
    JSON.stringify({ queries: ['retention disagreement'], evidence: ['conflict'], done: false }),
  ]
  let turn = 0
  return {
    id: 'fixture-research',
    kind: 'fake',
    live: false,
    status: () => ({
      id: 'fixture-research',
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'fixture-research-1',
      detail:
        'Offline E2E fixture. Returns fixed structured JSON for research planning and synthesis. Not intelligence.',
      liveEnabled: false,
    }),
    complete: async (request) => {
      // Planning turns get a fixed plan; synthesis cites the ids the coordinator
      // actually supplied, read out of the evidence it was given.
      //
      // That is deliberate rather than a shortcut. Citing invented ids would be
      // rejected by `parseSynthesis` - which is the citation-integrity property
      // working - and would leave the E2E asserting nothing. Reading them from the
      // prompt is what a real model does, and it keeps the assertion meaningful.
      const stage = request.messages.some((m) => m.role === 'system' && m.content.includes('Stage: synthesizing'))
      const sourceIds = [...request.prompt.matchAll(/"sourceId":"([^"]+)"/g)]
        .map((match) => match[1] as string)
        .filter((id, index, all) => all.indexOf(id) === index)
      const text = stage
        ? JSON.stringify({
            findings: [
              { text: 'FINDING_MARKER a local assistant keeps durable state encrypted.', sourceIds: sourceIds.slice(0, 1) },
            ],
            conflicts: [
              { text: 'CONFLICT_MARKER the sources disagree about retention.', sourceIds: sourceIds.slice(0, 2) },
            ],
            uncertainties: ['UNCERTAINTY_MARKER neither fixture source is verified.'],
          })
        : (plans[Math.min(turn, plans.length - 1)] as string)
      turn += 1
      return {
        requestId: `fixture-${turn}`,
        providerId: 'fixture-research',
        model: 'fixture-research-1',
        text,
        inputTokens: 1,
        outputTokens: 1,
      }
    },
  }
}
