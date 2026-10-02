import {
  buildContextAdmission,
  contextSourceAdapterSpec,
  type ContextAdapterInputBase,
  type ContextAdapterOptions,
  type ContextAdapterResult,
} from './admission'

/**
 * THE EXPLICIT SELECTION ADAPTER.
 *
 * The smallest honest source: a person selected some text and handed it over,
 * into one named conversation or surface. That act is `owner_selection` — the
 * owner's own hand — and the foundation's provenance table says
 * `explicit_selection` comes from *nothing else*, so this adapter permits
 * exactly one source and defaults to it.
 *
 * What this is not:
 *
 * - **Not a clipboard reader.** No selection is *found* here; content arrives
 *   as an argument or there is nothing to adapt. Active app/window discovery
 *   belongs to the host observation lane (`sources/window`, issue #30), not
 *   to a selection adapter — this file cannot see, and does not pretend to.
 * - **Not an authority.** A selection shared into one conversation is a
 *   photograph of that selection with that scope and TTL; it grants no access
 *   to anything it mentions.
 *
 * Deferred hookup: the Core facade (#20) owns calling
 * `ContextStore.admit(explicitSelectionAdmission(input).admission, now)`, and
 * the transport/UI (#24) owns delivering the selection. This file owns only
 * the input contract.
 */
export interface ExplicitSelectionInput extends ContextAdapterInputBase {
  readonly kind?: 'explicit_selection' | null
}

const SPEC = contextSourceAdapterSpec('explicit_selection', ['owner_selection'], 'owner_selection')

/** Convert a handed-in explicit selection into an admission candidate. */
export function explicitSelectionAdmission(
  input: ExplicitSelectionInput,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  return buildContextAdmission(input, SPEC, options)
}
