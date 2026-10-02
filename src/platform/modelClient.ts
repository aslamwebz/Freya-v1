import type { ModelCommandOutcome } from '../../core/protocol/core-protocol'
import { coreMirror } from './coreClient'

/**
 * The renderer's view of the model catalogue and the owner's selection.
 *
 * A *caller*, not a mirror — there is deliberately no standing feed of models:
 * a catalogue is a network read, and it happens when the person opens the
 * selector and asks, never while Freya sits idle. What each function returns is
 * exactly the outcome Core built for that one command; nothing here is cached
 * across calls, patched locally, or invented when Core says no.
 *
 * The renderer never sees a provider, a key, or an endpoint. It sees ids and
 * Core's own sentences. A refused selection arrives as a refusal, not as an
 * empty list that a UI could accidentally render as "there are no models".
 */

const NO_CORE = 'the Core bridge is not available in this window'

export async function readModelCatalog(): Promise<ModelCommandOutcome> {
  const result = await coreMirror().submit('model.catalog.read')
  if (result.model) return result.model
  return {
    operation: 'refused',
    reason: result.refusal?.reason ?? result.error?.message ?? 'Core returned no model result',
  }
}

/**
 * Name the model for subsequent turns, or `null` for the provider default.
 *
 * The answer is Core's: a selection is stored only after Core has re-checked
 * that a configured provider can actually serve it, and every later turn still
 * runs the whole Guard → Governor → grant → compiled-context path with that
 * model riding inside the request rather than replacing it.
 */
export async function selectModel(model: string | null): Promise<ModelCommandOutcome> {
  const result = await coreMirror().submit('model.select', model === null ? {} : { model })
  if (result.model) return result.model
  return {
    operation: 'refused',
    reason: result.refusal?.reason ?? result.error?.message ?? NO_CORE,
  }
}
