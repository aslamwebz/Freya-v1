import {
  buildContextAdmission,
  contextSourceAdapterSpec,
  type ContextAdapterInputBase,
  type ContextAdapterOptions,
  type ContextAdapterResult,
} from './admission'

/**
 * THE AUTHORISED PROJECT / FILE ADAPTERS.
 *
 * Two kinds of one human act — the owner pointing at something of theirs and
 * saying "you may use this":
 *
 * - **project** — comes from `owner_authorization` (the authorising act
 *   itself, summarised as bounded content) or `owner_selection` (the project
 *   selected from a list). It never arrives via `host_report`: the foundation
 *   forbids that pairing, so "the host says this project is authorised" is
 *   refused here with `source_not_permitted`, before it can become a request.
 *   Authorising a project is not *reading* it: the candidate is a photograph
 *   of what was said, scoped, TTL-bounded, and grants nothing (C3).
 * - **file** — the owner's authorisation or selection, plus `host_report` for
 *   the desktop host telling Core about a file *already* authorised elsewhere.
 *   That report must name the authorisation record (`originId`), or the
 *   adapter refuses `origin_required` — "the host said so" is never a bare
 *   assertion.
 *
 * Neither adapter discovers anything. No directory is walked, no recent-files
 * list is read, no path is resolved or opened: the caller hands in the bounded
 * description (a name, an excerpt) plus the `uri` *name* they already hold.
 * The `uri` is a name, not a permit — it says what the content is about, not
 * what may be done with it.
 *
 * Deferred hookup: #20 owns admitting these candidates into the store and
 * #24 owns the UI that captures the authorisation; this file owns the input
 * contract and the combination checks only.
 */
export interface AuthorizedProjectInput extends ContextAdapterInputBase {
  readonly kind?: 'project' | null
}

export interface AuthorizedFileInput extends ContextAdapterInputBase {
  readonly kind?: 'file' | null
}

const PROJECT_SPEC = contextSourceAdapterSpec(
  'project',
  ['owner_authorization', 'owner_selection'],
  'owner_authorization',
)

const FILE_SPEC = contextSourceAdapterSpec(
  'file',
  ['owner_authorization', 'owner_selection', 'host_report'],
  'owner_authorization',
)

/** Convert an authorised-project statement into an admission candidate. */
export function authorizedProjectAdmission(
  input: AuthorizedProjectInput,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  return buildContextAdmission(input, PROJECT_SPEC, options)
}

/** Convert an authorised/selected/reported file description into a candidate. */
export function authorizedFileAdmission(
  input: AuthorizedFileInput,
  options: ContextAdapterOptions = {},
): ContextAdapterResult {
  return buildContextAdmission(input, FILE_SPEC, options)
}
