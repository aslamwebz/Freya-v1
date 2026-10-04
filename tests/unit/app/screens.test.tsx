import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ScreenSlots } from '../../../src/app/screens/Home'
import { Mind } from '../../../src/app/screens/Mind'
import { World } from '../../../src/app/screens/World'
import { Life } from '../../../src/app/screens/Life'
import { Workforce } from '../../../src/app/screens/Workforce'
import { Foundry } from '../../../src/app/screens/Foundry'
import { Relay } from '../../../src/app/screens/Relay'
import { Focus } from '../../../src/app/screens/Focus'
import { People } from '../../../src/app/screens/People'
import { Memory } from '../../../src/app/screens/Memory'
import { Settings } from '../../../src/app/screens/Settings'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'

/**
 * Every tab screen must mount and produce content.
 *
 * Most of these are still sample-data screens with no props, so a smoke test is the
 * honest floor for them: it catches a screen that throws on render without
 * pretending to verify its design.
 *
 * Settings is not one of those. It reads a live snapshot, so it is mounted against
 * the state a window is actually in when no Core is attached — every resource
 * `unavailable` — which is the case most likely to throw, since it is the branch
 * that renders reasons instead of data.
 */

afterEach(cleanup)

function Slots({ slots }: { slots: ScreenSlots }) {
  return <>{slots.centre}{slots.left}{slots.right}{slots.bottom}</>
}

const SCREENS: readonly (readonly [string, () => ScreenSlots])[] = [
  ['Mind', Mind],
  ['World', World],
  ['Life', Life],
  ['Workforce', Workforce],
  ['Foundry', Foundry],
  ['Relay', Relay],
  ['Focus', Focus],
  ['People', People],
  ['Memory', Memory],
]

/** Every resource absent: the shape of a window with no Core behind it. */
const NO_CORE = {
  home: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  core: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  mission: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  workforce: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  activity: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  attention: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
  provider: { status: 'unavailable', reason: 'No Freya Core is reachable from this window.' },
} as unknown as UiSnapshot

describe('app tab screens', () => {
  for (const [name, build] of SCREENS) {
    it(`mounts ${name} with content`, () => {
      const { container } = render(<Slots slots={build()} />)
      expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
    })
  }

  it('mounts Settings with content when no Core is reachable', () => {
    const preferences = new PreferencesStore()
    const { container } = render(
      <Slots slots={Settings({
        snapshot: NO_CORE,
        preferences,
        category: 'appearance',
        onCategory: () => {},
      })} />,
    )
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
  })
})
