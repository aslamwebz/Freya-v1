import { memo } from 'react'
import type { Centre, CentreStyle } from '../dressing/store'
import { Orbits } from './Orbits'
import { PresenceCentre } from './PresenceCentre'
import portrait from '../../ui-v2/assets/freya-portrait.webp'
import './centre.css'

/**
 * The shared middle.
 *
 * One composition used by every screen: the animated light rings, the presence
 * piece, and — when the chosen design is Freya — her portrait, all sharing one
 * centre. The dressing table's Centre/Style/Rings controls drive it.
 */

interface Props {
  centre: Centre
  style: CentreStyle
  rings: boolean
  state?: string
}

/**
 * Memoised on its four primitive props, so ordinary board state changes —
 * opening the sidebar, the model picker, typing in the composer — never touch
 * the centre's React tree and, crucially, never remount `PresenceStage`.
 */
export const FreyaCentre = memo(function FreyaCentre({ centre, style, rings, state }: Props) {
  return (
    <div className="freya-centre">
      <Orbits />
      <PresenceCentre centre={centre} style={style} rings={rings} state={state} />
      {centre === 'freya' && <img className="freya-centre-portrait" src={portrait} alt="" />}
    </div>
  )
})
