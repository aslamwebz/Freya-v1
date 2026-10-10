import type { MindTool } from './tools'
import type { ChatMissionProposal } from '../missions/chat-types'

export function renderMissionProposal(proposal: ChatMissionProposal): string {
  return `Mission proposal: ${proposal.goal}\n\nScope: ${proposal.scope}\n\nSuccess criteria: ${proposal.successCriteria.join('; ')}\n\nOwner approval required. Up to 3 model calls (plan, one revision, report), 3 read-only research actions and 32 external requests within 30 minutes. Permission to search public sources, read pages, verify retrieval and use a bounded research worker. Source retrieval does not establish factual accuracy.`
}

/** Produces review data only; has no access to Missions, grants or research. */
export function createMissionProposalTool(): MindTool {
  return {
    name: 'propose_mission', capability: 'mission.manage',
    description: 'Propose durable multi-step public research when the owner requests investigation, comparison, source verification and a report. Ordinary questions should be answered normally. This only asks for owner approval; it starts no work.',
    parameters: [
      { name: 'goal', description: 'The owner goal', required: true, maxChars: 1000 },
      { name: 'scope', description: 'Bounded public read-only research scope', required: true, maxChars: 400 },
      { name: 'criteria', description: 'JSON array of 1-4 short success criteria', required: true, maxChars: 500 },
    ],
    async run({ arguments: args }) {
      const criteria: unknown = JSON.parse(args.criteria ?? '')
      if (!args.goal?.trim() || args.goal.length > 1000 || !args.scope?.trim() || args.scope.length > 400 || !Array.isArray(criteria) || criteria.length < 1 || criteria.length > 4 || criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 120)) throw new Error('Mission proposal is invalid.')
      const proposal: ChatMissionProposal = { goal: args.goal.trim(), scope: args.scope.trim(), successCriteria: criteria }
      return { summary: renderMissionProposal(proposal), sources: [], missionProposal: proposal }
    },
  }
}
