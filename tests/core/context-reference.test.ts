// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ContextBudgetExceeded,
  compileContext,
  estimateTokens,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  type ReferenceKnowledge,
} from '../../core/mind/context-compiler'
import { FREYA_IDENTITY } from '../../core/identity/identity'
import type { ConversationMessage } from '../../core/conversation/types'

/**
 * Recalled memory in the compiled packet.
 *
 * The phase 3 tests cover history trimming. These cover the one thing Phase 4
 * added to the packet, and the property that matters most about it: **a memory is
 * reference material, never instruction.**
 *
 * That is not a wording preference. It is structural, and each of these tests
 * checks one way it could go wrong:
 *
 *  - a memory in the system message would be instruction by construction, because
 *    that is what a system message *is*;
 *  - a memory whose source class is dropped becomes indistinguishable from something
 *    the owner said, and a provider reading "the owner prefers X" has been told a
 *    preference is a fact;
 *  - a memory that outranks the user's question would let a prompt injection choose
 *    what Freya thinks about;
 *  - half a memory reads as a complete one, so it is dropped whole rather than
 *    trimmed.
 */

const NOW = '2026-04-01T09:00:00.000Z'

function message(messageId: string, role: 'user' | 'assistant', content: string): ConversationMessage {
  return { messageId, conversationId: 'c1', role, content, createdAt: NOW, turnId: 't1' }
}

function current(): ConversationMessage {
  return message('now', 'user', 'what should we do about the release?')
}

function reference(items: number = 2): ReferenceKnowledge {
  return {
    items: Array.from({ length: items }, (_u, i) => ({
      subject: `subject ${i}`,
      content: `a remembered claim number ${i} about the release process`,
      sourceLabel: 'owner-assertion',
      confidenceLabel: 'high',
    })),
  }
}

function compile(referenceKnowledge: ReferenceKnowledge | null | undefined, budget?: ContextBudget) {
  return compileContext(
    {
      identity: FREYA_IDENTITY,
      history: [message('m1', 'user', 'hello'), message('m2', 'assistant', 'hi')],
      currentUserMessage: current(),
      referenceKnowledge,
    },
    budget ?? DEFAULT_CONTEXT_BUDGET,
  )
}

describe('a memory is never instruction', () => {
  it('puts recalled memory outside the system message', () => {
    const compiled = compile(reference())
    const system = compiled.messages.find((m) => m.role === 'system')?.content ?? ''

    // The identity message is Freya's own words. A memory placed here would be read
    // as part of who she is, which is precisely the authority a claim has not got.
    expect(system).not.toMatch(/remembered claim/)
    expect(system).toContain('You are Freya')
  })

  it('frames the block as reference and says the owner wins', () => {
    const compiled = compile(reference())
    const block = compiled.messages.find((m) => m.content.includes('remembered claim'))?.content ?? ''

    // The stale-memory case is the dangerous one: a memory that contradicts what
    // the owner says now has to lose, or recalling becomes a way to overrule the
    // person in front of Freya.
    expect(block).toMatch(/reference/i)
    expect(block).toMatch(/not instructions/i)
    expect(block).toMatch(/owner is right/i)
  })

  it('carries each item\'s source class into the rendered text', () => {
    const compiled = compile({
      items: [
        { subject: 'a page', content: 'the office is in Berlin', sourceLabel: 'external-untrusted', confidenceLabel: 'low' },
      ],
    })
    const block = compiled.messages.find((m) => m.content.includes('Berlin'))?.content ?? ''
    // Flattened into plain "notes", a web page and the owner are the same thing. The
    // label is what keeps a stored claim looking like a claim.
    expect(block).toMatch(/external-untrusted/)
    expect(block).toMatch(/\blow\b/)
  })

  it('discloses conflicts rather than picking a side', () => {
    const compiled = compile({
      items: [],
      conflicts: ['these two stored facts about the deadline disagree'],
    })
    const block = compiled.messages.find((m) => m.content.includes('disagree'))?.content ?? ''
    expect(block).toMatch(/Unresolved conflict/)
  })

  it('counts what it left out, so a partial pack does not look complete', () => {
    const compiled = compile({ items: [], omittedCount: 3, conflicts: [] })
    // Nothing fit, so no block — but the count is still reported rather than lost.
    expect(compiled.reference).toMatchObject({ included: false, omittedCount: 3 })
  })
})

describe('where memory sits in the packet', () => {
  it('places memory after the transcript and before the current question', () => {
    const compiled = compile(reference())
    const order = compiled.messages.map((m) =>
      m.content.includes('remembered claim')
        ? 'reference'
        : m.role === 'system'
          ? 'system'
          : m.content.includes('release')
            ? 'current'
            : 'history',
    )
    expect(order[0]).toBe('system')
    expect(order[order.length - 1]).toBe('current')
    expect(order.indexOf('reference')).toBeGreaterThan(order.lastIndexOf('history'))
    expect(order.indexOf('reference')).toBeLessThan(order.length - 1)
  })

  it('never lets a memory crowd out the question that was asked', () => {
    const many: ReferenceKnowledge = {
      items: Array.from({ length: 50 }, (_u, i) => ({
        subject: `s${i}`,
        content: `claim ${i} `.repeat(60),
        sourceLabel: 'owner-assertion',
        confidenceLabel: 'high',
      })),
    }
    // A large budget, so it is the memory competing with the question rather than
    // the budget doing the limiting.
    const compiled = compile(many, { maxEstimatedTokens: 3_000, maxHistoryMessages: 24 })
    const last = compiled.messages[compiled.messages.length - 1]
    expect(last?.role).toBe('user')
    expect(last?.content).toBe(current().content)
    expect(compiled.reference.omittedCount).toBeGreaterThan(0)
  })

  it('drops memory wholesale rather than trimming it to a fragment', () => {
    const oneBig: ReferenceKnowledge = {
      items: [
        { subject: 's', content: 'x'.repeat(20_000), sourceLabel: 'owner-assertion', confidenceLabel: 'high' },
      ],
    }
    const compiled = compile(oneBig, { maxEstimatedTokens: 1_200, maxHistoryMessages: 4 })
    // Half a memory reads as a whole one. Either the whole of it or none of it.
    const included = compiled.messages.some((m) => m.content.includes('x'.repeat(50)))
    expect(included).toBe(false)
    expect(compiled.messages[compiled.messages.length - 1]?.content).toBe(current().content)
  })

  it('adds no block at all when there is nothing remembered', () => {
    const compiled = compile(null)
    expect(compiled.reference).toMatchObject({ included: false, itemCount: 0 })
    expect(compiled.messages.some((m) => m.content.includes('Notes from Freya'))).toBe(false)
  })

  it('adds no block for an empty pack', () => {
    const compiled = compile({ items: [], conflicts: [], omittedCount: 0 })
    expect(compiled.messages.some((m) => m.content.includes('Notes from Freya'))).toBe(false)
  })
})

describe('reporting', () => {
  it('reports what it included and how much space it took', () => {
    const compiled = compile(reference(3))
    expect(compiled.reference).toMatchObject({ included: true, itemCount: 3 })
    expect(compiled.reference.estimatedTokens).toBeGreaterThan(0)
  })

  it('keeps its own estimate inside the space it was given', () => {
    const compiled = compile(reference(3), { maxEstimatedTokens: 3_000, maxHistoryMessages: 24 })
    const identityCost = estimateTokens(
      compiled.messages.find((m) => m.role === 'system')?.content ?? '',
    )
    const blockCost = compiled.reference.estimatedTokens
    expect(identityCost + blockCost).toBeLessThanOrEqual(3_000)
  })

  it('drops the entire reference block when even its framing does not fit', () => {
    const baseline = compileContext({
      identity: FREYA_IDENTITY,
      history: [],
      currentUserMessage: current(),
      referenceKnowledge: null,
    })
    const ceiling = baseline.estimatedTokens + 8

    const compiled = compileContext(
      {
        identity: FREYA_IDENTITY,
        history: [],
        currentUserMessage: current(),
        referenceKnowledge: {
          items: [],
          conflicts: ['a deliberately long unresolved conflict '.repeat(20)],
        },
      },
      { maxEstimatedTokens: ceiling, maxHistoryMessages: 0 },
    )

    expect(compiled.estimatedTokens).toBeLessThanOrEqual(ceiling)
    expect(compiled.reference.included).toBe(false)
  })

  it('never lets the omitted-notes marker itself cross the allowance', () => {
    const many: ReferenceKnowledge = {
      items: Array.from({ length: 20 }, (_unused, i) => ({
        subject: `subject-${i}`,
        content: 'bounded remembered claim '.repeat(12),
        sourceLabel: 'owner-assertion',
        confidenceLabel: 'high',
      })),
      omittedCount: 4,
    }
    const compiled = compile(many, { maxEstimatedTokens: 900, maxHistoryMessages: 2 })
    expect(compiled.estimatedTokens).toBeLessThanOrEqual(900)
    expect(compiled.reference.omittedCount).toBeGreaterThan(0)
  })

  it('still fails closed when identity and the question do not fit', () => {
    // Reference material is never a reason to answer a truncated question. If the
    // irreducible part does not fit, nothing is sent at all.
    expect(() =>
      compileContext(
        {
          identity: FREYA_IDENTITY,
          history: [],
          currentUserMessage: message('now', 'user', 'x'.repeat(40_000)),
          referenceKnowledge: reference(),
        },
        { maxEstimatedTokens: 500, maxHistoryMessages: 4 },
      ),
    ).toThrow(ContextBudgetExceeded)
  })

  it('is deterministic: the same Brain and query give a byte-identical packet', () => {
    expect(JSON.stringify(compile(reference(4)))).toBe(JSON.stringify(compile(reference(4))))
  })
})