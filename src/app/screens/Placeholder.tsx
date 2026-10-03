import { Card, Empty } from '../cards/Card'
import type { ScreenSlots } from './Home'

/** A screen that has not been built yet, said plainly rather than faked. */
export function placeholder(label: string, symbol: string, description: string): ScreenSlots {
  return {
    left: <Card title={label} icon={symbol}><Empty title={`${label} is not built yet`} detail={description} /></Card>,
    right: null,
    bottom: null,
  }
}
