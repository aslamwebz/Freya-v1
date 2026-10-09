// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Mind } from '../../../src/app/screens/Mind'
import type { ScreenSlots } from '../../../src/app/screens/Home'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { NO_CORE_SNAPSHOT, liveMind, liveMindSnapshot } from './mindFixtures'

/**
 * The Mind workspace renders Core's projection, and says so when it cannot.
 *
 * ## Why this test exists
 *
 * The screen this replaced was pure fiction: `Curious 82%`, a three-goal roadmap
 * with month dates, and an `Uncertain about` card of invented open questions —
 * every one a module constant, rendered in exactly the visual language a live
 * number would be. A person reading it had no way to tell.
 *
 * These tests pin the honest version. The three properties that matter:
 *
 *   1. **It never renders a number Core did not report.** A count that was never
 *      taken is an em dash, not a zero.
 *   2. **It declares its own provenance.** `live`, `stale`, `preview`, `loading`
 *      and `unavailable` are five different words on the screen, and the strip's
 *      `data-state` says which one a test can read.
 *   3. **Absence is visible.** A domain that has not reported renders its own
 *      reason, not an empty list that would read as "nothing there".
 */

afterEach(cleanup)

function Mount({ slots }: { slots: ScreenSlots }) {
  return <>{slots.centre}{slots.left}{slots.right}{slots.bottom}</>
}

function text(container: HTMLElement): string {
  return container.textContent ?? ''
}

describe('the Mind workspace', () => {
  it('says the window has no Core, rather than showing a healthy zero', () => {
    const { container } = render(<Mount slots={Mind({ snapshot: NO_CORE_SNAPSHOT })} />)
    const strip = container.querySelector('.m-provenance')
    expect(strip?.getAttribute('data-state')).toBe('unavailable')
    expect(text(container)).toContain('No Freya Core is reachable from this window.')
    // Unreachable is not waiting: the cards say so rather than implying a Core is on its way.
    expect(text(container)).toContain('Core is not reporting')
  })

  it('says it is waiting while Core has not reported', () => {
    const loading = { ...NO_CORE_SNAPSHOT, mind: { status: 'loading' } } as unknown as UiSnapshot
    const { container } = render(<Mount slots={Mind({ snapshot: loading })} />)
    expect(container.querySelector('.m-provenance')?.getAttribute('data-state')).toBe('loading')
    expect(text(container)).toContain('Waiting for Freya Core to report.')
  })

  it('says it is stale rather than drawing a stale projection as current', () => {
    const stale = {
      ...NO_CORE_SNAPSHOT,
      mind: { status: 'stale', source: 'live', reason: 'this is from before the last restart', data: liveMind() },
    } as unknown as UiSnapshot
    const { container } = render(<Mount slots={Mind({ snapshot: stale })} />)
    expect(container.querySelector('.m-provenance')?.getAttribute('data-state')).toBe('stale')
    expect(text(container)).toContain('Stale projection')
    // The data is still drawn — Core said it is old, not wrong — and the strip says so.
    expect(text(container)).toContain('Freya')
  })

  it('announces a design preview as a preview, in words', () => {
    const preview = createPreviewAdapter().getSnapshot()
    const { container } = render(<Mount slots={Mind({ snapshot: preview })} />)
    expect(text(container)).toContain('Design preview')
    expect(text(container)).toContain('nothing here is live')
    // A preview Mind shows the unavailable states, not invented ones.
    expect(text(container)).not.toMatch(/Curious|82%|Mar 2025/)
  })

  it('renders the live projection without inventing anything', () => {
    const { container } = render(<Mount slots={Mind({ snapshot: liveMindSnapshot() })} />)
    const words = text(container)
    expect(container.querySelector('.m-provenance')?.getAttribute('data-state')).toBe('ready')
    // Overview: Core's own posture words.
    expect(words).toContain('running')
    expect(words).toContain('nanogpt')
    // Threads: what is running now, with the process fact marked.
    expect(words).toContain('run-live-1')
    expect(words).toContain('live · running')
    // Self: Core's own statements, no trait meter.
    expect(words).toContain('Core is Freya; the model is not Freya.')
    expect(words).toContain('I cannot remember without an encrypted Brain.')
    // Goals: status and counts, no title and no date.
    expect(words).toContain('mission-real-1')
    expect(words).toContain('the plan has an unverified step')
    // Uncertainty: a closed code, not a sentence.
    expect(words).toContain('mission.needs-attention')
    // Provenance: which subsystem said what.
    expect(words).toContain('Every contributing subsystem could be read.')
    expect(words).toContain('work')
    expect(text(container)).not.toMatch(/\d\s*%/u)
  })

  it('puts STOP ALL above every other reading', () => {
    const stopped = liveMindSnapshot()
    if (stopped.mind.status !== 'ready') throw new Error('expected ready')
    const stoppedSnapshot: UiSnapshot = {
      ...stopped,
      mind: {
        status: 'ready',
        source: 'live',
        data: liveMind({
          overview: {
            ...liveMind().overview,
            stopped: true,
            mode: 'stopped',
            modeDetail: 'STOP ALL is latched. Core refuses new cognition until the owner resumes.',
          },
        }),
      },
    }
    render(<Mount slots={Mind({ snapshot: stoppedSnapshot })} />)
    expect(screen.getByText('STOP ALL is latched. Core refuses new cognition until the owner resumes.')).toBeInTheDocument()
    expect(screen.getByText('latched')).toBeInTheDocument()
  })

  it('shows an owner context that is not yet projected as such', () => {
    // The shared fixture now carries a reporting Personality and Context, so
    // this case projects the Core that has neither, which is the state the
    // sentence below exists for.
    const base = liveMind()
    const absent = liveMindSnapshot({
      owner: {
        ...base.owner,
        personalityHealth: 'unavailable',
        personalityReason: 'this Core has no Personality domain: no relationship record exists, and none is simulated',
        continuity: null, formality: null, temperament: [],
        relationshipItems: 0, admittedItems: 0, cuesAdmitted: 0, relationshipDurable: null,
        contextHealth: 'unavailable',
        contextReason: 'this Core has no Context domain: no context item exists, and none is simulated',
        contextItems: 0, contextCurrent: 0, contextScopes: [], contextUnresolvedReferences: 0, contextDurable: null,
      },
    })
    const { container } = render(<Mount slots={Mind({ snapshot: absent })} />)
    expect(text(container)).toContain('No Personality domain is reporting')
    expect(text(container)).toContain('No Context domain is reporting')
    expect(text(container)).toContain('No preference wording, habit, inside joke or relationship text crosses this boundary.')
  })

  it('shows a section Core says is not in this build as absent, not empty', () => {
    const { container } = render(<Mount slots={Mind({ snapshot: liveMindSnapshot() })} />)
    expect(container.textContent).toContain('life')
    expect(text(container)).toContain('"not built yet" and "nothing there" are different claims')
  })

  it('says the compartment read has not happened when Core never answered it', () => {
    const base = liveMind()
    const withoutSelf: UiSnapshot = liveMindSnapshot({ self: { ...base.self, worldSelf: null } })
    const { container } = render(<Mount slots={Mind({ snapshot: withoutSelf })} />)
    expect(text(container)).toContain('The compartment read has not happened')
  })

  it('renders an em dash for a token count Core never took', () => {
    const base = liveMind()
    const unknownUsage: UiSnapshot = liveMindSnapshot({
      overview: {
        ...base.overview,
        sessionInputTokens: null,
        sessionOutputTokens: null,
        sessionUnknownUsageCalls: 2,
      },
    })
    const { container } = render(<Mount slots={Mind({ snapshot: unknownUsage })} />)
    expect(text(container)).toContain('Token totals are a lower bound')
    // The dash is the rendered value, and it is not a zero.
    expect(container.textContent).toContain('—')
  })
})
