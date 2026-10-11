import type { MindTool } from './tools'
import { CHAT_MISSION_POLICY, type ChatMissionProposal } from '../missions/chat-types'

/**
 * The text the owner reads before pressing Approve.
 *
 * ## Why the numbers are rendered from the policy rather than written out
 *
 * This string is the owner's only chance to see what they are agreeing to, and a budget
 * described in prose is a budget that goes stale the moment somebody edits the policy. Every
 * figure below is interpolated from `CHAT_MISSION_POLICY`, so the sentence and the bound
 * cannot disagree — a test asserts the rendered text names each real figure.
 *
 * ## What it deliberately does not promise
 *
 * It names **bounds, not outcomes**. "Up to 64 actions" is a true and checkable statement
 * about a ceiling; a promise that the Mission will "research thoroughly" would be a claim
 * about quality that no bound can support. It also states plainly what the work does *not*
 * establish, because the thing a reader most needs to know is that a retrieved page is a
 * third party's claim and not a verified fact.
 */
export function renderMissionProposal(proposal: ChatMissionProposal): string {
  const minutes = Math.round(CHAT_MISSION_POLICY.maxDurationMs / 60_000)
  return [
    `Mission proposal: ${proposal.goal}`,
    '',
    `Scope: ${proposal.scope}`,
    '',
    `Success criteria: ${proposal.successCriteria.join('; ')}`,
    '',
    'Owner approval required. If you approve, Freya may make up to',
    `${String(CHAT_MISSION_POLICY.maxModelCalls)} model calls (planning, one revision, and the report),`,
    `perform up to ${String(CHAT_MISSION_POLICY.maxActions)} read-only actions across at most ${String(CHAT_MISSION_POLICY.maxStepsPerPlan)} steps,`,
    `and make up to ${String(CHAT_MISSION_POLICY.maxExternalRequests)} external requests, within ${String(minutes)} minutes.`,
    'Freya plans the work herself, executes it one bounded step at a time, verifies each',
    "step independently, and asks you again if any step needs a permission she does not have.",
    'Freya may search public sources, open public pages in her own isolated browser, read them,',
    'and re-read them to verify what she found. She does not click, type, log in, submit a form,',
    'or send anything to anyone.',
    'Source retrieval does not establish factual accuracy, and a finding that cannot be verified',
    'is reported as unverified rather than dropped or overstated.',
  ].join('\n')
}

/** Produces review data only; has no access to Missions, grants or research. */
export function createMissionProposalTool(): MindTool {
  return {
    name: 'propose_mission', capability: 'mission.manage',
    description:
      'Propose durable multi-step public work when the owner requests investigation, comparison, multi-site collection, ' +
      'source verification and a report. Ordinary questions should be answered normally. This only asks for owner approval; it starts no work.',
    parameters: [
      { name: 'goal', description: 'The owner goal', required: true, maxChars: 1000 },
      { name: 'scope', description: 'Bounded public read-only scope', required: true, maxChars: 400 },
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