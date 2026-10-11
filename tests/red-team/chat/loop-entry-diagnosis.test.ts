// @vitest-environment node
/**
 * Regression coverage for the five defects that left Freya Chat answering from
 * memory instead of looking things up.
 *
 * Each block below pins a behaviour that used to be broken. They are written as
 * the *fixed* behaviour deliberately: a test that described the bug would have
 * to be deleted to fix it, and a test that describes the fix has to be updated to
 * break it. That asymmetry is the point.
 *
 * The defects, in the order they are covered:
 *
 *  1. Registering `propose_mission` suppressed the deterministic first tool
 *     request for every turn where no composer button was held.
 *  2. `routeChatIntent` answered `direct_answer` for any question it could not
 *     positively classify, so ordinary factual questions were never looked up.
 *  3. The tool instructions told the model that most turns need no tool.
 *  4. Continuations were budgeted at 384 tokens — below the measured cost of
 *     answering from evidence.
 *  5. A reply that promised an action instead of taking it ended the turn.
 */
import { describe, expect, it } from 'vitest'
import { MindTurnCognition } from '../../../core/mind/turn-cognition'
import { budgetFor } from '../../../core/mind/loop'
import { initialToolRequestForOwnerText } from '../../../core/mind/tool-intent'
import { needsExternalFacts } from '../../../core/research/chat-intent'
import { createMissionProposalTool } from '../../../core/mind/mission-proposal'
import { deferredActionCorrection, MAX_DEFERRED_CORRECTIONS } from '../../../core/mind/deferred-action'
import { MindToolRegistry, MIND_TOOL_LIMITS } from '../../../core/mind/tools'
import type { MindTool } from '../../../core/mind/tools'
import type { CognitionOutcome } from '../../../core/cognition/outcome'
import { CONVERSATION_LIMITS } from '../../../core/conversation/types'

const OWNER = { id: 'owner', capabilities: new Set<string>(), trusted: true }
const GUARD = { evaluate: () => ({ allowed: true as const }), holds: () => true }

function registryWith(tools: readonly MindTool[]): MindToolRegistry {
  return new MindToolRegistry({ tools, guard: GUARD, principal: OWNER, stopped: () => false })
}

/** A web_search body that records that it actually ran. */
function countingSearch(log: string[]): MindTool {
  return {
    name: 'web_search',
    capability: 'search.web',
    description: 'Search the web.',
    parameters: [{ name: 'query', description: 'the query', required: true }],
    async run(request) {
      log.push(String(request.arguments['query']))
      return { summary: 'looked it up', sources: [{ url: 'https://example.com', title: 'Example', snippet: 'x' }] }
    },
  }
}

/** A model that answers conversationally on its first call, as a chat model usually does. */
function answeringModel(calls: string[]): { request: () => Promise<CognitionOutcome> } {
  return {
    request: async () => {
      calls.push('call')
      return {
        status: 'allowed',
        requestId: 'r',
        text: 'Paris is the capital of France.',
        providerId: 'nanogpt',
        model: 'qwen',
        finishReason: 'stop',
        truncated: false,
      }
    },
  }
}

function cognitionWith(tools: MindToolRegistry, model: { request: () => Promise<CognitionOutcome> }) {
  return new MindTurnCognition({
    authority: { request: model.request as never },
    gateway: { cancelRequest: () => 0 },
    tools,
    selectedModel: () => 'qwen/qwen3.8-27b-uncensored',
    selectedProviderId: () => 'nanogpt',
    matrixSpaceIds: () => [],
  })
}

async function ask(
  tools: MindToolRegistry,
  model: { request: () => Promise<CognitionOutcome> },
  ownerText: string,
  intents: Record<string, boolean> = {},
) {
  return cognitionWith(tools, model).think({
    turnId: 't',
    conversationId: 'c1',
    grantId: 'g1',
    messages: [{ role: 'user', content: ownerText }],
    ownerText,
    intents,
    carriedSources: [],
    researchFollowUp: false,
    perTurnAllowance: CONVERSATION_LIMITS.maxOutputTokensPerTurn,
  })
}

/* ------------------------------------------------------------------ defect 1 & 2 */

describe('a factual question reaches a lookup without the button', () => {
  it('routes an ordinary factual question to a lookup', () => {
    expect(initialToolRequestForOwnerText('who won the match last night', {})?.name).toBe('web_search')
  })

  it('routes a question naming a specific thing to a lookup', () => {
    expect(initialToolRequestForOwnerText('who is the CEO of Stripe', {})?.name).toBe('web_search')
  })

  it('runs the lookup when propose_mission is registered and no button was held', async () => {
    // This is the defect that made the loop unreachable. Registering one tool must
    // not decide whether another is offered.
    const searched: string[] = []
    const calls: string[] = []
    const tools = registryWith([countingSearch(searched), createMissionProposalTool()])
    const question = 'who won the match last night'

    const outcome = await ask(tools, answeringModel(calls), question)

    expect(searched).toEqual([question])
    // The lookup *was* the deterministic first request, so it ran before the model
    // was asked anything — and the model then answered from its result in one call.
    expect(calls).toHaveLength(1)
    expect(outcome.kind === 'answer' ? outcome.steps.length : 0).toBe(1)
  })

  it('reaches the same lookup with the Web search button held', async () => {
    const searched: string[] = []
    const tools = registryWith([countingSearch(searched), createMissionProposalTool()])
    const question = 'who won the match last night'

    await ask(tools, answeringModel([]), question, { webSearch: true })

    expect(searched).toEqual([question])
  })
})

describe('a conversation that needs nothing is still one call', () => {
  // The counterpart to the block above. Widening the router is only correct if
  // ordinary talk still goes straight to an answer.
  it('answers an opinion question directly', () => {
    expect(needsExternalFacts('what do you think about Stripe?')).toBe(false)
  })

  it('answers an advice question directly', () => {
    expect(needsExternalFacts('should I move to Berlin?')).toBe(false)
  })

  it('answers creative work directly', () => {
    expect(needsExternalFacts('write me a poem about rain')).toBe(false)
  })

  it('answers an explanation of the owner’s own code directly', () => {
    expect(needsExternalFacts('Currently, how does the importer work?')).toBe(false)
    expect(needsExternalFacts('Is the current implementation thread-safe?')).toBe(false)
  })

  it('answers a greeting directly', () => {
    expect(needsExternalFacts('are you still there?')).toBe(false)
  })

  it('offers no tool at all for a question needing none', () => {
    expect(initialToolRequestForOwnerText('what do you think about Stripe?', {})).toBeNull()
  })

  it('makes exactly one provider call for a question needing no tool', async () => {
    const calls: string[] = []
    const searched: string[] = []
    const tools = registryWith([countingSearch(searched), createMissionProposalTool()])

    const outcome = await ask(tools, answeringModel(calls), 'what do you think about Stripe?')

    expect(outcome.kind).toBe('answer')
    expect(calls).toHaveLength(1)
    expect(searched).toEqual([])
  })
})

describe('the boundary the router draws', () => {
  it('looks up what is anchored in time', () => {
    expect(needsExternalFacts('what is the latest on the Mars sample return?')).toBe(true)
  })

  it('looks up a concrete mutable value', () => {
    expect(needsExternalFacts('how much does the Model 3 cost in 2026?')).toBe(true)
  })

  it('looks up a named thing the model may not know', () => {
    expect(needsExternalFacts('who is the CEO of Stripe')).toBe(true)
  })

  it('leaves the owner’s own repository alone', () => {
    expect(needsExternalFacts('Show me the code in src/app/chat/intent.ts')).toBe(false)
    expect(needsExternalFacts('list the open issues on the tracker')).toBe(false)
  })

  it('leaves general explanation alone', () => {
    expect(needsExternalFacts('What is a talk?')).toBe(false)
    expect(needsExternalFacts('Explain how to click the link yourself')).toBe(false)
    expect(needsExternalFacts('How do I talk to my manager about a raise?')).toBe(false)
  })
})

/* ------------------------------------------------------------------ defect 4 */

describe('the per-continuation output budget', () => {
  const allowance = CONVERSATION_LIMITS.maxOutputTokensPerTurn

  it('gives the first call a whole answer', () => {
    expect(budgetFor(0, allowance)).toBe(CONVERSATION_LIMITS.maxOutputTokensPerAnswer)
  })

  it('gives every answer-bearing call enough to actually finish one', () => {
    // Against MiniMax-M3 a grounded answer returns `length` at every budget below
    // 2048. The old 384 and then 512 were both under that line.
    for (let i = 0; i < MIND_TOOL_LIMITS.answerCalls; i++) {
      expect(budgetFor(i, allowance)).toBeGreaterThanOrEqual(2048)
    }
  })

  it('gives envelope calls room for a model that thinks inline', () => {
    // MiniMax-M3 emits its reasoning in the same content field as the envelope, so
    // a cap that cuts it off mid-thought means no envelope arrives at all — which
    // is how a turn once spent all ten calls and produced nothing.
    for (let i = MIND_TOOL_LIMITS.answerCalls; i < MIND_TOOL_LIMITS.maxProviderCalls; i++) {
      expect(budgetFor(i, allowance)).toBeGreaterThanOrEqual(1024)
    }
  })

  it('spends exactly the Governor’s allowance and never more', () => {
    const total = Array.from({ length: MIND_TOOL_LIMITS.maxProviderCalls }, (_u, i) => budgetFor(i, allowance))
      .reduce((sum, value) => sum + value, 0)
    expect(total).toBe(allowance)
    expect(total).toBeLessThanOrEqual(allowance)
  })

  it('still fits a turn that cannot afford a full first answer', () => {
    const small = 1_000
    const total = Array.from({ length: MIND_TOOL_LIMITS.maxProviderCalls }, (_u, i) => budgetFor(i, small))
      .reduce((sum, value) => sum + value, 0)
    expect(total).toBeLessThanOrEqual(small)
  })
})

/* ------------------------------------------------------------------ defect 5 */

describe('a promise to act is not an answer', () => {
  it('catches a promise to look something up', () => {
    expect(deferredActionCorrection('Let me check that for you.', 0)).not.toBeNull()
    expect(deferredActionCorrection("I'll search for that now.", 0)).not.toBeNull()
    expect(deferredActionCorrection("I'll open that in my browser.", 0)).not.toBeNull()
  })

  it('leaves a real answer alone', () => {
    expect(deferredActionCorrection('Paris is the capital of France.', 0)).toBeNull()
    expect(deferredActionCorrection('I will always let you check the page first.', 0)).toBeNull()
  })

  it('leaves a long answer alone even when it contains the phrase', () => {
    const long = `I'll check that in a moment. ${'x'.repeat(700)}`
    expect(deferredActionCorrection(long, 0)).toBeNull()
  })

  it('leaves an answered, cited reply alone', () => {
    expect(deferredActionCorrection('I checked that for you: it shipped last week [1].', 0)).toBeNull()
  })

  it('gives up correcting after a bounded number of attempts', () => {
    expect(deferredActionCorrection('Let me check that for you.', MAX_DEFERRED_CORRECTIONS)).toBeNull()
  })

  it('spends another call making the model act, then ends truthfully', async () => {
    const searched: string[] = []
    const tools = registryWith([countingSearch(searched)])
    const replies = ['Let me look that up for you.', 'here is what I found']
    const calls: string[] = []
    const model = {
      request: async () => {
        calls.push('call')
        return {
          status: 'allowed',
          requestId: 'r',
          text: replies[Math.min(calls.length - 1, replies.length - 1)],
          providerId: 'nanogpt',
          model: 'qwen',
          finishReason: 'stop',
          truncated: false,
        } as CognitionOutcome
      },
    }

    const outcome = await ask(tools, model, 'who won the match last night')

    // The promise did not end the turn.
    expect(calls.length).toBe(2)
    expect(outcome.kind).toBe('answer')
  })
})