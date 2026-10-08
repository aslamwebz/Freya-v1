import { memo } from 'react'
import type { Centre, CentreStyle } from '../dressing/store'
import type { BrainState } from './state'
import { Orbits } from './Orbits'
import { LiveOrb } from './LiveOrb'
import portrait from '../../ui-v2/assets/freya-portrait.webp'
import './centre.css'

/**
 * The shared middle.
 *
 * One composition used by every screen: the animated light rings, the new
 * LiveOrb, and — when the chosen design is Freya — her portrait, all sharing one
 * centre. The old legacy PresenceStage is deliberately not used here.
 */

interface Props {
  centre: Centre
  style: CentreStyle
  rings: boolean
  state?: BrainState
}

/**
 * Memoised on its four primitive props, so ordinary board state changes —
 * opening the sidebar, the model picker, typing in the composer — never touch
 * the centre's React tree and never remount the WebGL orb.
 */
export const FreyaCentre = memo(function FreyaCentre({ centre, rings, state = 'calm' }: Props) {
  return (
    <div className="freya-centre">
      {rings ? <Orbits /> : null}
      <LiveOrb state={state} energy={state === 'calm' ? 0 : 0.45} />
      {centre === 'freya' && <img className="freya-centre-portrait" src={portrait} alt="" />}
    </div>
  )
})
