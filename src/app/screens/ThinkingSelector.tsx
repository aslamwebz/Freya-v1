import { useEffect, useState } from 'react'
import { readModelCatalog } from '../../platform/modelClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'

/**
 * Reasoning effort, shown only when the selected model actually has one.
 *
 * The previous version of this control was a permanent button reading "Provider"
 * that did nothing on click. It was honest about the contract in its tooltip and
 * dishonest in its affordance: a lit, labelled control implies a setting that
 * changes the request, and this build sends no effort value at all — there is no
 * reasoning field on `ModelView` and none on the command outcome.
 *
 * So the control now renders **nothing** unless Core reports an effort for the
 * model in use. That is the same rule the rest of this codebase follows: a control
 * that cannot change the request is worse than no control, because it teaches the
 * owner to believe something changed when the bytes sent were identical.
 *
 * The read is the same live catalogue the model picker uses. It is bounded, it is
 * Core's own answer, and a refused catalogue yields no control rather than a
 * fabricated one.
 */

interface EffortReading {
  readonly model: string
  readonly effort: string
}

/**
 * Core does not currently report reasoning effort for any model.
 *
 * When it does, this is the single place that learns how to read it: the
 * capability arrives with the catalogue read, and the chip appears. Until then the
 * lookup returns null and the composer renders one control fewer.
 */
function readEffort(outcome: Awaited<ReturnType<typeof readModelCatalog>>): EffortReading | null {
  if (outcome.operation !== 'catalog') return null
  const entry = outcome.models?.find((model) => model.id === outcome.selected)
  if (!entry) return null
  // `ModelView` is `{ id, ownedBy }` today. There is no effort to read, and a cast
  // here would let the chip render a level Core never sent.
  return null
}

export function ThinkingSelector() {
  const [reading, setReading] = useState<EffortReading | null>(null)

  useEffect(() => {
    let live = true
    void readModelCatalog().then(outcome => {
      if (live) setReading(readEffort(outcome))
    })
    return () => { live = false }
  }, [])

  if (reading === null) return null

  return (
    <span className="hd-tool hd-tool-think" role="status" aria-label={`Reasoning effort: ${reading.effort}`}>
      <Glyph name="mind" size={16} />
      <span>{reading.effort}</span>
    </span>
  )
}