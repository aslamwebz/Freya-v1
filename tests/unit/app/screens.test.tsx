import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ScreenSlots } from '../../../src/app/screens/Home'
import { Mind } from '../../../src/app/screens/Mind'
import { SettingsOverlay } from '../../../src/app/screens/Settings'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'

/**
 * Every tab screen must mount and produce content.
 *
 * Retired sample routes have been removed. Mind reads a live projection, so it is mounted
 * against the state a window is actually in when no Core is attached — every
 * resource `unavailable` — which is the case most likely to throw, since it is
 * the branch that renders reasons instead of data. A screen that only ever
 * renders its happy path cannot be smoke-tested this way, and this is the path
 * a real desktop window spends most of its life on.
 *
 * Settings is not one of those either. It reads a live snapshot, so it is
 * mounted the same way.
 */

afterEach(cleanup)

function Slots({ slots }: { slots: ScreenSlots }) {
  return <>{slots.centre}{slots.left}{slots.right}{slots.bottom}</>
}

/** Every resource absent: the shape of a window with no Core behind it. */
const NO_CORE = {
  home: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  core: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  mission: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  workforce: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  activity: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  attention: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  mind: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  provider: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
} as unknown as UiSnapshot

describe('app tab screens', () => {
  it('mounts Mind with content when no Core is reachable', () => {
    const { container } = render(<Slots slots={Mind({ snapshot: NO_CORE })} />)
    const text = (container.textContent ?? '').trim()
    expect(text.length).toBeGreaterThan(0)
    // It says so rather than showing a healthy-looking zero.
    expect(container.querySelector('.m-provenance')?.getAttribute('data-state')).toBe('unavailable')
  })

  it('mounts Settings with content when no Core is reachable', () => {
    const preferences = new PreferencesStore()
    const { container } = render(
      <SettingsOverlay
        snapshot={NO_CORE}
        preferences={preferences}
        category="appearance"
        onCategory={() => {}}
        onDone={() => {}}
      />,
    )
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
  })
})
