// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchSurface } from '../../src/ui/surfaces/ResearchSurface'
import { SearchSurface } from '../../src/ui/surfaces/SearchSurface'
import { resetResearchMirror } from '../../src/platform/researchClient'
import type { CoreCommandResult, ResearchCommandOutcome } from '../../core/protocol/core-protocol'

/**
 * The Research surface.
 *
 * Three properties, and they pull in different directions:
 *
 *   - Remote and model text must render as **text**. A page or an answer can contain
 *     anything at all, so this is the one place where a rendering mistake is remote
 *     code execution. There is no `dangerouslySetInnerHTML` and there must not be.
 *   - Progress must be truthful. A partial answer is shown *as* partial, with the
 *     sources that failed, rather than presented as though it were whole.
 *   - Nothing may happen on its own. No search, no read and no research on mount,
 *     because research spends model calls and reading pages spends network.
 */

let submit: ReturnType<typeof vi.fn>

function ok(brain: ResearchCommandOutcome): CoreCommandResult {
  return { requestId: 'r1', ok: true, research: brain }
}

const LIMITS = {
  iterations: 2,
  queries: 4,
  results: 24,
  pages: 6,
  evidenceChars: 48000,
  durationMs: 120000,
  modelTurns: 5,
  maxOutputTokens: 2048,
}

/** A research result with two cited sources and one conflict. */
const RESULT = {
  id: 'res-1',
  state: 'completed' as const,
  findings: [
    { text: 'Freya keeps long-term state in an encrypted store.', sourceIds: ['s1'] },
    { text: 'The store is hash-chained.', sourceIds: ['s2'] },
  ],
  conflicts: [{ text: 'Sources disagree on the retention period.', sourceIds: ['s1', 's2'] }],
  uncertainties: ['Neither source is independently verified.'],
  sources: [
    {
      sourceId: 's1',
      url: 'https://fixture.example.com/a',
      title: 'First source',
      domain: 'fixture.example.com',
      retrievedAt: '2026-10-01T00:00:00.000Z',
      excerpt: 'An excerpt from the first source.',
    },
    {
      sourceId: 's2',
      url: 'https://fixture.example.com/b',
      title: 'Second source',
      domain: 'fixture.example.com',
      retrievedAt: '2026-10-01T00:00:00.000Z',
      excerpt: 'An excerpt from the second source.',
    },
  ],
  failures: [],
  usage: { modelTurns: 3, queries: 2, pages: 2 },
}

beforeEach(() => {
  resetResearchMirror()
  submit = vi.fn(async (command: string) => {
    if (command === 'research.status.read') {
      return ok({ operation: 'status', limits: LIMITS, status: null })
    }
    return ok({ operation: 'refused', reason: 'not used by this test' })
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
    coreBrain: (async () => null) as never,
    onCoreBrain: (() => () => {}) as never,
  } as never
})

afterEach(() => {
  cleanup()
  delete window.freyaHost
})

/**
 * Replace what Core replies with.
 *
 * Assigning the local `submit` alone would not do it: the mirror reads
 * `coreSubmit` off the bridge at call time, so a swapped reply has to be swapped on
 * the bridge too or the test would pass against the previous stub.
 */
function replyWith(handler: (command: string) => Promise<CoreCommandResult>): void {
  submit = vi.fn(handler)
  window.freyaHost!.coreSubmit = submit as never
}

function renderSurface() {
  return render(<ResearchSurface />)
}

describe('nothing happens on its own', () => {
  it('calls no network or model command on mount', async () => {
    renderSurface()
    await waitFor(() => expect(screen.getByText(/what should Freya find out/i)).toBeInTheDocument())
    const commands = submit.mock.calls.map((call) => call[0])
    // Research starts only on an explicit request. A mount-time search would spend
    // network and could spend model calls.
    expect(commands).not.toContain('research.start')
    expect(commands).not.toContain('search.web')
    expect(commands).not.toContain('browser.read')
  })

  it('shows the code-owned limits before anything is asked for', () => {
    renderSurface()
    // A person starting a bounded operation is entitled to see the bound first.
    expect(screen.getByText(/5 model turns/i)).toBeInTheDocument()
    expect(screen.getByText(/6 pages/i)).toBeInTheDocument()
  })
})

describe('remote text is data, never markup', () => {
  const HOSTILE = 'UNTRUSTED <script>window.__pwned = true</script> <img src=x onerror="window.__pwned=true">'

  it('renders hostile page text literally and creates no script node', async () => {
    replyWith(async (command: string) =>
      command === 'browser.read'
        ? ok({
            operation: 'read',
            document: {
              title: 'A hostile page',
              url: 'https://fixture.example.com/a',
              sourceDomain: 'fixture.example.com',
              retrievedAt: '2026-10-01T00:00:00.000Z',
              headings: [],
              text: HOSTILE,
              links: [],
              truncated: false,
            },
          })
        : ok({ operation: 'refused', reason: '' }),
    )
    render(<SearchSurface />)
    fireEvent.change(screen.getByLabelText(/url to read/i), { target: { value: 'https://fixture.example.com/a' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /read source/i }))
    })

    // Present as characters on screen...
    expect(await screen.findByText(/UNTRUSTED/i)).toBeInTheDocument()
    // ...and not as elements. This is the assertion that matters: it fails if anyone
    // ever reaches for dangerouslySetInnerHTML.
    expect(document.querySelector('script')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined()
  })
})

describe('research findings', () => {
  it('shows findings with the sources they cite', async () => {
    replyWith(async (command: string) =>
      command === 'research.start'
        ? ok({ operation: 'research', operationId: 'res-1', limits: LIMITS, result: RESULT })
        : ok({ operation: 'status', limits: LIMITS, status: null }),
    )
    renderSurface()
    fireEvent.change(screen.getByLabelText(/research question/i), { target: { value: 'how does Freya store memory?' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start research/i }))
    })

    expect(await screen.findByText(/encrypted store/i)).toBeInTheDocument()
    expect(screen.getByText(/hash-chained/i)).toBeInTheDocument()
    // A citation a person can follow, and a source list they can check.
    expect(screen.getByText('https://fixture.example.com/a')).toBeInTheDocument()
    expect(screen.getByText(/disagree on the retention period/i)).toBeInTheDocument()
  })

  it('never labels a model answer verified', async () => {
    replyWith(async (command: string) =>
      command === 'research.start'
        ? ok({ operation: 'research', operationId: 'res-1', limits: LIMITS, result: RESULT })
        : ok({ operation: 'status', limits: LIMITS, status: null }),
    )
    renderSurface()
    fireEvent.change(screen.getByLabelText(/research question/i), { target: { value: 'a question' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start research/i }))
    })
    await screen.findByText(/encrypted store/i)
    // Nothing may *label* an answer verified. Research is retrieval, not
    // verification, and Phase 4 established that a stored claim is not proof.
    //
    // Checked as a badge rather than as a word, because this window does say "an
    // answer is not verified" and "neither source is independently verified".
    // Asserting the absence of the word would forbid the disclaimers that make the
    // point, which is the opposite of the property.
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument()
    for (const item of screen.getAllByText(/verified/i)) {
      expect(item.textContent ?? '').toMatch(/not|never|none|neither/i)
    }
  })

  it('shows a partial answer as partial, with the sources that failed', async () => {
    const partial = {
      ...RESULT,
      state: 'partial' as const,
      failures: [{ stage: 'reading', code: 'unsupported_document' }],
    }
    replyWith(async (command: string) =>
      command === 'research.start'
        ? ok({ operation: 'research', operationId: 'res-1', limits: LIMITS, result: partial })
        : ok({ operation: 'status', limits: LIMITS, status: null }),
    )
    renderSurface()
    fireEvent.change(screen.getByLabelText(/research question/i), { target: { value: 'a question' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start research/i }))
    })
    expect(await screen.findByText(/findings \(partial\)/i)).toBeInTheDocument()
    expect(screen.getByText(/this research is/i)).toBeInTheDocument()
    // The failure is a closed code, never a provider's own words.
    expect(screen.getByText(/unsupported_document/)).toBeInTheDocument()
  })

  it('says when research is unavailable rather than showing an empty result', async () => {
    replyWith(async () => ok({ operation: 'refused', reason: 'web search and research are not configured in this build' }))
    renderSurface()
    fireEvent.change(screen.getByLabelText(/research question/i), { target: { value: 'a question' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start research/i }))
    })
    expect(await screen.findAllByText(/not configured in this build/i)).not.toHaveLength(0)
    // No findings panel, so an unavailable provider cannot be mistaken for an
    // answer that found nothing.
    expect(screen.queryByText(/^sources$/i)).not.toBeInTheDocument()
  })
})

describe('cancellation', () => {
  it('offers cancel while research is running and sends the operation id', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    replyWith(async (command: string) => {
      if (command === 'research.start') {
        await held
        return ok({ operation: 'research', operationId: 'res-1', limits: LIMITS, result: RESULT })
      }
      if (command === 'research.status.read') {
        return ok({ operation: 'status', limits: LIMITS, status: { operationId: 'res-1', stage: 'searching' } })
      }
      return ok({ operation: 'cancelled', operationId: 'res-1' })
    })

    renderSurface()
    fireEvent.change(screen.getByLabelText(/research question/i), { target: { value: 'a slow question' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start research/i }))
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    })
    expect(submit.mock.calls.some((call) => call[0] === 'research.cancel')).toBe(true)
    release()
  })
})
