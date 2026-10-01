import {
  buildContextAdmission,
  contextSourceAdapterSpec,
  type ContextAdapterInputBase,
  type ContextAdapterOptions,
  type ContextAdapterResult,
} from './admission'

/**
 * THE SHARED TAB / MEDIA ADAPTERS.
 *
 * Two kinds of one human act — the owner *sharing*: a browser tab, or a piece
 * of media (image, audio, video, document) handed into the conversation.
 *
 * - **shared_tab** and **shared_media** come from `owner_share` (the share
 *   itself) or `host_report` (the desktop host reporting a share that already
 *   happened, naming the share record as `originId`). They never come from a
 *   selection or an authorisation: those are different acts with different
 *   promises, and the foundation's table says so — this adapter refuses the
 *   mismatched pairings rather than guessing which one the caller meant.
 * - A `host_report` without an `originId` is refused `origin_required`: a
 *   reported share with no share record behind it is exactly the ambient
 *   capture this lane forbids, dressed up as a report.
 *
 * No capture lives here. There is no browser channel, no screen read, no
 * media device, no file watcher: the caller hands in the *transcript, caption
 * or description text* that stands as the item's content, the tab title or
 * file name as the label, and the URL or path as the uri-name it already
 * holds. A full-screen or always-on tab source would be a global privilege,
 * and "no omniscient global screen privilege" stays true: none was invented.
 *
 * Deferred hookup: the host bridge that reports shares (#20's wiring and the
 * later capture lane) and the transport that carries them (#24) are outside
 * this file; only the deterministic input contract is here.
 */
export interface SharedTabInput extends ContextAdapterInputBase {
  readonly kind?: 'shared_tab' | null
}

export interface SharedMediaInput extends ContextAdapterInputBase {
  readonly kind?: 'shared_media' | null
}

const TAB_SPEC = contextSourceAdapterSpec(
  'shared_tab',
  ['owner_share', 'host_report'],
  'owner_share',
)

const MEDIA_SPEC = contextSourceAdapterSpec(
  'shared_media',
  ['owner_share', 'host_report'],
  'owner_share',
)

/** Convert a shared tab into an admission candidate. */
export function sharedTabAdmission(
  input: SharedTabInput,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  return buildContextAdmission(input, TAB_SPEC, options)
}

/** Convert shared media (its handed-in description text) into a candidate. */
export function sharedMediaAdmission(
  input: SharedMediaInput,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  return buildContextAdmission(input, MEDIA_SPEC, options)
}
