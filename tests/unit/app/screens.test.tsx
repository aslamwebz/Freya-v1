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

/**
 * Every tab screen must mount and produce content. These are sample-data
 * screens with no props, so a smoke test is the honest floor: it catches a
 * screen that throws on render without pretending to verify its design.
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
  ['Settings', Settings],
]

describe('app tab screens', () => {
  for (const [name, build] of SCREENS) {
    it(`mounts ${name} with content`, () => {
      const { container } = render(<Slots slots={build()} />)
      expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
    })
  }
})
