// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VaultSurface } from '../../src/ui/surfaces/VaultSurface'
import { resetBrainMirror } from '../../src/platform/brainClient'
import type { BrainProjection } from '../../core/brain/brain'
import type { BrainCommandOutcome, CoreCommandResult } from '../../core/protocol/core-protocol'

/**
 * The Vault surface.
 *
 * The window exists to answer three questions a person is entitled to ask, and the
 * tests are organised around them:
 *
 *   1. **Will she remember?** Durability has to be visible before anything is typed
 *      into the window. Somebody deciding whether to tell Freya something needs to
 *      know whether it survives a restart first.
 *   2. **What does she think she knows?** Every memory shows its source class, and a
 *      refusal has to read as a refusal rather than as a success.
 *   3. **Where does she disagree with herself?** Contradictions are shown, not
 *      hidden.
 *
 * And one absence: the surface must not offer an edit or a delete. Withdrawing
 * archives; deletion would make forgetting and tampering look alike.
 */

const DURABLE: BrainProjection = {
  health: 'healthy',
  reason: null,
  persistence: 'encrypted',
  durable: true,
  identity: {
    name: 'Freya',
    role: 'A local, private assistant.',
    purpose: 'To think with, remember what matters, and act within explicit authority.',
    claims: [{ claimId: 'identity.model-is-not-freya', statement: 'Freya is not the language model that answers her.' }],
  },
  self: {
    complete: true,
    capabilities: [
      { capability: 'remember', state: 'available', cannot: ['guarantee durability without an encryption key'] },
    ],
    limitations: [{ limitationId: 'limitation.brain-not-truth', statement: 'A stored memory is a record of a claim.' }],
  },
  counts: {
    entities: 2,
    relations: 3,
    observations: 1,
    memories: 2,
    admitted: 1,
    conflicted: 1,
    rejected: 4,
    experiences: 7,
  },
  recentAdmissions: [
    {
      memoryId: 'm1',
      kind: 'semantic',
      subject: 'the owner',
      source: 'owner-assertion',
      confidence: 'high',
      status: 'admitted',
      admittedAt: '2026-04-01T09:00:00.000Z',
    },
    {
      memoryId: 'm2',
      kind: 'relationship',
      subject: 'Project Alpha',
      source: 'external-untrusted',
      confidence: 'low',
      status: 'conflicted',
      admittedAt: '2026-04-01T10:00:00.000Z',
    },
  ],
  conflicts: [{ memoryId: 'm2', conflictsWith: ['m1'], detail: 'these two stored facts disagree' }],
  sequence: 42,
}

/**
 * Ephemeral, not degraded.
 *
 * A Brain with no key is working perfectly for this session — it is simply not
 * going to survive a restart. Collapsing the two states would make the surface
 * cry wolf on a machine where nothing is wrong.
 */
const EPHEMERAL: BrainProjection = {
  ...DURABLE,
  health: 'healthy',
  reason: 'no secure Brain key is available on this machine',
  persistence: 'ephemeral',
  durable: false,
  recentAdmissions: [],
  counts: { ...DURABLE.counts, memories: 0, admitted: 0, conflicted: 0 },
  conflicts: [],
}

let projection: BrainProjection
let submit: ReturnType<typeof vi.fn>

function result(brain: BrainCommandOutcome): CoreCommandResult {
  return { requestId: 'r1', ok: true, brain }
}

/**
 * A bridge whose push and read agree.
 *
 * The mirror attaches by subscribing and then reading, so a bridge that pushed one
 * value and returned another would leave the surface showing whichever the read
 * happened to be — and the durability banner is the first thing a person reads.
 */
function setBridge(next: BrainProjection): void {
  projection = next
  window.freyaHost!.coreBrain = (async () => projection) as never
  window.freyaHost!.onCoreBrain = ((handler: (p: BrainProjection) => void) => {
    handler(projection)
    return () => {}
  }) as never
}

beforeEach(() => {
  // A module singleton, so a test that swaps the bridge has to drop the old
  // subscription first.
  resetBrainMirror()
  projection = DURABLE
  // Core decides. The stub refuses credential-shaped content the way admission
  // does, so the surface's refusal path is exercised by the same input that would
  // really produce it rather than by a hard-coded flag.
  submit = vi.fn(async (command: string, payload?: { content?: string }) => {
    if (command !== 'brain.memory.write') {
      return result({ operation: 'memory-refused', reason: 'not used by this test' })
    }
    if (/sk-[A-Za-z0-9]{16,}/.test(payload?.content ?? '')) {
      return result({
        operation: 'memory-refused',
        reason: 'the content appears to contain an API key; the Brain records where a credential lives, never the credential',
      })
    }
    return result({
      operation: 'memory-written',
      reason: 'admitted as semantic memory referencing source turn-1',
      memory: {
        memoryId: 'm9',
        kind: 'semantic',
        subject: 'the owner',
        status: 'admitted',
        source: 'owner-assertion',
        confidence: 'high',
        admittedAt: '2026-04-01T09:00:00.000Z',
      },
    })
  })
  window.freyaHost = {
    isDesktop: true,
    getRuntimeInfo: vi.fn(),
    loadWorkspace: vi.fn(),
    saveWorkspace: vi.fn(),
    onCollect: vi.fn(),
    coreSubmit: submit as never,
    coreStatus: (async () => ({})) as never,
    onCoreStatus: (() => () => {}) as never,
    coreConversation: (async () => null) as never,
    onCoreConversation: (() => () => {}) as never,
    coreVoice: (async () => null) as never,
    coreBrain: (async () => projection) as never,
    onCoreBrain: ((handler: (p: BrainProjection) => void) => {
      handler(projection)
      return () => {}
    }) as never,
  } as never
  setBridge(DURABLE)
})

afterEach(() => {
  cleanup()
  delete window.freyaHost
})

describe('durability comes first', () => {
  it('says she will remember, before anything can be typed', () => {
    render(<VaultSurface />)
    expect(screen.getByText('REMEMBERS ACROSS RESTARTS')).toBeInTheDocument()
  })

  it('says she will forget on quit, with the reason, when she will', () => {
    setBridge(EPHEMERAL)
    render(<VaultSurface />)
    expect(screen.getByText('FORGETS ON QUIT')).toBeInTheDocument()
    expect(
      screen.getByText('no secure Brain key is available on this machine'),
    ).toBeInTheDocument()
  })

  it('does not cry wolf: an ephemeral Brain is healthy, just not durable', () => {
    setBridge(EPHEMERAL)
    render(<VaultSurface />)
    // Nothing is wrong with a session-only Brain. Only durability is missing.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('distinguishes "cannot remember" from "has learned nothing"', () => {
    // The two look identical on a panel that only shows counts, and they are very
    // different states for somebody deciding what to type.
    setBridge({ ...DURABLE, durable: false, persistence: 'ephemeral', reason: 'no key' })
    render(<VaultSurface />)
    expect(screen.getByText('FORGETS ON QUIT')).toBeInTheDocument()
  })

  it('says the Brain is degraded while Freya still answers', () => {
    setBridge({ ...DURABLE, health: 'degraded', reason: 'the Brain record chain is broken' })
    render(<VaultSurface />)
    expect(screen.getByText(/memory is degraded/i)).toBeInTheDocument()
    expect(screen.getByText(/still answering/i)).toBeInTheDocument()
  })

  it('waits rather than claiming she has nothing to say', () => {
    setBridge(EPHEMERAL)
    window.freyaHost!.coreBrain = (async () => null) as never
    window.freyaHost!.onCoreBrain = (() => () => {}) as never
    render(<VaultSurface />)
    expect(screen.getByText(/waiting for freya core/i)).toBeInTheDocument()
  })
})

describe('what she believes she knows', () => {
  it('shows every memory with its source class and confidence', () => {
    render(<VaultSurface />)
    expect(screen.getByText(/owner-assertion · high confidence/i)).toBeInTheDocument()
    // A note from a web page and a note from the owner are different claims, and a
    // list that flattened them would be lying by omission.
    expect(screen.getByText(/external-untrusted · low confidence/i)).toBeInTheDocument()
  })

  it('does not carry memory content into the listing', () => {
    // The projection has no content field at all; this asserts the surface does not
    // go looking for some other way to get it.
    expect(JSON.stringify(DURABLE.recentAdmissions)).not.toMatch(/shellfish/i)
    render(<VaultSurface />)
    expect(screen.queryByText(/shellfish/i)).not.toBeInTheDocument()
  })

  it('shows contradictions rather than hiding them', () => {
    render(<VaultSurface />)
    expect(screen.getByText(/these two stored facts disagree/i)).toBeInTheDocument()
  })

  it('counts refusals, which never become memories', () => {
    render(<VaultSurface />)
    expect(screen.getByText(/4 refused/i)).toBeInTheDocument()
  })

  it('shows what Freya cannot do, not only what she can', () => {
    render(<VaultSurface />)
    expect(screen.getByText(/guarantee durability without an encryption key/i)).toBeInTheDocument()
    expect(screen.getByText(/a stored memory is a record of a claim/i)).toBeInTheDocument()
  })

  it('says plainly when she has been told nothing', () => {
    setBridge({ ...DURABLE, recentAdmissions: [] })
    render(<VaultSurface />)
    expect(screen.getByText(/not been told anything yet/i)).toBeInTheDocument()
  })
})

describe('asking her to remember', () => {
  it('sends the content and nothing about its provenance', async () => {
    render(<VaultSurface />)
    fireEvent.change(screen.getByPlaceholderText(/something you want her to know/i), {
      target: { value: 'the owner drinks tea' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remember this/i }))
    })
    await waitFor(() => expect(submit).toHaveBeenCalled())

    const [command, payload] = submit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('brain.memory.write')
    expect(payload).toEqual({ content: 'the owner drinks tea' })
    // No source class, no confidence, no verification status. A window that could
    // name its own provenance could launder a web page's contents in as something
    // the owner asserted.
    expect(Object.keys(payload as object).sort()).toEqual(['content'])
  })

  it('shows a refusal as a refusal, with Core\'s own reason', async () => {
    render(<VaultSurface />)
    fireEvent.change(screen.getByPlaceholderText(/something you want her to know/i), {
      target: { value: 'sk-abcdefghijklmnopqrstuvwx' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remember this/i }))
    })
    // A declined memory has to be legible as declined. Skimming a green "stored" for
    // a refused secret is the failure this prevents.
    const reply = await screen.findByText(/appears to contain an api key/i)
    expect(reply).toBeInTheDocument()
    expect(reply.closest('[data-tone]')).toHaveAttribute('data-tone', 'refused')
  })

  it('keeps the draft when a memory was refused', async () => {
    render(<VaultSurface />)
    const box = screen.getByPlaceholderText(/something you want her to know/i)
    fireEvent.change(box, { target: { value: 'sk-abcdefghijklmnopqrstuvwx' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remember this/i }))
    })
    // Losing what someone typed because a policy declined it is its own small
    // cruelty, and it would hide the refusal's context.
    await waitFor(() => expect(box).toHaveValue('sk-abcdefghijklmnopqrstuvwx'))
  })

  it('clears the draft after a successful admission', async () => {
    render(<VaultSurface />)
    const box = screen.getByPlaceholderText(/something you want her to know/i)
    fireEvent.change(box, { target: { value: 'the owner drinks tea' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remember this/i }))
    })
    await waitFor(() => expect(box).toHaveValue(''))
  })

  it('will not send an empty memory', () => {
    render(<VaultSurface />)
    expect(screen.getByRole('button', { name: /remember this/i })).toBeDisabled()
  })
})

describe('recall on demand', () => {
  /**
 * Replace what Core replies with.
 *
 * Assigning the local `submit` alone would not do it: the mirror reads
 * `coreSubmit` off the bridge at call time, so a swapped reply has to be swapped on
 * the bridge too or the test would pass against the wrong stub.
 */
function replyWith(operation: BrainCommandOutcome): void {
  submit = vi.fn(async (command: string) =>
    command === 'brain.recall'
      ? result(operation)
      : result({ operation: 'memory-refused', reason: 'not used by this test' }),
  )
  window.freyaHost!.coreSubmit = submit as never
}

  it('shows what was recalled, with its own accounting', async () => {
    replyWith({
      operation: 'recall',
      recall: {
        query: 'tea',
        items: [
          {
            memoryId: 'm1',
            subject: 'the owner',
            content: 'the owner drinks tea in the morning',
            source: 'owner-assertion',
            confidence: 'high',
            status: 'admitted',
            score: 42,
          },
        ],
        conflicts: [],
        candidatesConsidered: 9,
        omittedCount: 3,
        estimatedTokens: 30,
        empty: false,
      },
    })
    render(<VaultSurface />)
    fireEvent.change(screen.getByPlaceholderText(/what should she bring to mind/i), { target: { value: 'tea' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^recall$/i }))
    })
    expect(await screen.findByText(/drinks tea in the morning/i)).toBeInTheDocument()
    // Considered, included and omitted are all reported. A pack that silently
    // dropped three memories looks identical to one that found one.
    expect(screen.getByText(/1 recalled from 9 considered, 3 left out for space/i)).toBeInTheDocument()
  })

  it('says so when a search found nothing', async () => {
    replyWith({
      operation: 'recall',
      recall: {
        query: 'nothing at all',
        items: [],
        conflicts: [],
        candidatesConsidered: 40,
        omittedCount: 0,
        estimatedTokens: 0,
        empty: true,
      },
    })
    render(<VaultSurface />)
    fireEvent.change(screen.getByPlaceholderText(/what should she bring to mind/i), {
      target: { value: 'nothing at all' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^recall$/i }))
    })
    expect(await screen.findByText(/searched 40 memories and recalled none/i)).toBeInTheDocument()
  })
})

describe('withdrawing', () => {
  it('offers withdraw and never edit or delete', () => {
    render(<VaultSurface />)
    expect(screen.getAllByRole('button', { name: /withdraw/i })).toHaveLength(2)
    // No other way to change a memory. Deletion would make forgetting and tampering
    // look alike, which is the one distinction the hash chain exists to keep.
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
  })

  it('asks Core to archive rather than remove', async () => {
    render(<VaultSurface />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /withdraw/i })[0] as HTMLElement)
    })
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]?.[0]).toBe('brain.memory.archive')
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ memoryId: 'm1' })
  })
})