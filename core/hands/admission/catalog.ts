/**
 * THE HANDS CAPABILITY CATALOG — what this build routes, explicitly.
 *
 * Admission answers "may this action happen?" only after answering "does this
 * Core know this capability for this action at all?" — and the answer lives
 * here, as a closed table, not as a guess from the shape of a string.
 *
 * ## What is deliberately enforced
 *
 * - **Ids are opaque, kinds are not.** A `capabilityId` names an entry; the
 *   entry's `kind` must be one this build can honestly route. Declared-but-not-
 *   routable kinds (clipboard, media) are absent, so naming one fails with an
 *   honest `unsupported` rather than a quiet absence.
 * - **Actions are a closed vocabulary per capability.** A request naming an
 *   action the capability does not accept is refused rather than passed
 *   through, so free text can never become "whatever the executor does".
 * - **Possession is not here.** The catalog says what exists. Whether a caller
 *   may use it is Guard's question, asked after this one.
 *
 * ## What is deliberately absent
 *
 * No execution of any kind: nothing in this file reaches for a browser, a
 * desktop, a file or a process. The action names are vocabulary — the closed
 * words a capability accepts — and no executor in this build implements them.
 */

import type { HandsCapabilityId } from '../contract'
import { isHandsCapabilityKind, type HandsCapabilityKind } from '../types'

/** One routed capability: its kind and the closed action vocabulary it accepts. */
export interface HandsCapabilityDescriptor {
  readonly capabilityId: HandsCapabilityId
  readonly kind: HandsCapabilityKind
  /** Closed. An action outside this list is refused as unsupported. */
  readonly actions: readonly string[]
}

/** The explicit catalog: capability id → descriptor. */
export type HandsCapabilityCatalog = ReadonlyMap<HandsCapabilityId, HandsCapabilityDescriptor>

/**
 * What this build routes.
 *
 * Five kinds, each with the actions it accepts. Nothing else is admitted, and
 * none of these names implies that anything executes — they are the vocabulary
 * a future executor would have to implement, declared now so requests against
 * them fail honestly rather than silently.
 */
export const HANDS_CAPABILITY_CATALOG: HandsCapabilityCatalog = new Map<
  HandsCapabilityId,
  HandsCapabilityDescriptor
>([
  [
    'cap-browser',
    { capabilityId: 'cap-browser', kind: 'browser', actions: ['navigate', 'click', 'type', 'read'] },
  ],
  [
    'cap-desktop',
    { capabilityId: 'cap-desktop', kind: 'desktop', actions: ['launch', 'focus', 'snapshot'] },
  ],
  [
    'cap-file',
    { capabilityId: 'cap-file', kind: 'file', actions: ['read', 'write', 'list'] },
  ],
  [
    'cap-shell',
    { capabilityId: 'cap-shell', kind: 'shell', actions: ['exec'] },
  ],
  [
    'cap-network',
    { capabilityId: 'cap-network', kind: 'network', actions: ['get', 'post'] },
  ],
])

/** The result of resolving a capability reference against the catalog. */
export type HandsCapabilityResolution =
  | { readonly ok: true; readonly descriptor: HandsCapabilityDescriptor }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve a capability id and action against the catalog.
 *
 * Pure lookup over a closed table: unknown id, unroutable kind and unknown
 * action each produce their own honest reason, and none of them is repaired
 * into something that would pass.
 */
export function resolveCapability(
  catalog: HandsCapabilityCatalog,
  capabilityId: HandsCapabilityId,
  action: string,
): HandsCapabilityResolution {
  const descriptor = catalog.get(capabilityId)
  if (!descriptor) {
    return { ok: false, reason: 'this Core does not know that capability id' }
  }
  // A catalog entry that drifted outside the routable vocabulary is a build
  // error, and the honest answer at admission time is "not routed".
  if (!isHandsCapabilityKind(descriptor.kind)) {
    return { ok: false, reason: 'that capability kind is not routable in this build' }
  }
  if (!descriptor.actions.includes(action)) {
    return { ok: false, reason: 'that capability does not accept that action' }
  }
  return { ok: true, descriptor }
}
