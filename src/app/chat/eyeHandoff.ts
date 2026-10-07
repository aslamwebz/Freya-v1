import { sharedDockedBrowserStore, openUrlInDockedBrowser, type DockedBrowserStore, type DockedTabOrigin } from './BrowserWorkspace'
import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'
import type { WorkspaceResearchView } from './modes'

/**
 * Where an Eye result was retrieved from.
 *
 * Surfaced in the dock tab badge so the owner can tell at a glance which channel
 * delivered a URL — `find` for a single Eye finding, `citation` for a deep-
 * research source, `source` for a sourced website.
 */
export type EyeHandoffKind = 'find' | 'citation' | 'source' | 'video' | 'image' | 'pdf' | 'document' | 'audio' | 'web' | 'file'

export interface EyeHandoffRequest {
  readonly url: string
  readonly kind: EyeHandoffKind
  readonly ownerText: string
  readonly sessionId?: string
}

/**
 * Hand an Eye finding (or a deep-research citation) into the docked browser.
 *
 * The whole point of this seam: a citation in the chat, an Eye result card,
 * and a deep-research source all open in the **same** docked browser the chat
 * already keeps around, with a badge that names the channel. The store is
 * shared so a "show me the page" gesture from any caller lands on the existing
 * workspace rather than spawning a fresh window.
 *
 * The owner never has to know which tab opens what: tabs are kept side by
 * side, the most recent hand-off becomes the active one, and the badge names
 * why the tab exists.
 */
export function handEyeResultToDockedBrowser(
  request: EyeHandoffRequest,
  store: DockedBrowserStore = sharedDockedBrowserStore(),
): void {
  const origin: DockedTabOrigin = {
    kind: 'link',
    from: 'eye',
    ownerText: request.ownerText,
    ...(request.kind === 'pdf' || request.kind === 'document' ? { mediaKind: request.kind } : {}),
  }
  const sessionTag = request.sessionId ? ` · ${request.sessionId.slice(0, 6)}` : ''
  const label = `${request.kind}${sessionTag}`
  openUrlInDockedBrowser(store, request.url, { origin, title: label })
}

/**
 * Open every URL in an Eye session result. Used by the Eye workspace's
 * "Open all findings" affordance.
 *
 * Each tab keeps its own badge so the eye can pick a finding later from the
 * history list without having to remember which channel it came from.
 */
export function handAllEyeResultsToDockedBrowser(
  session: NonNullable<ResearchCommandOutcome['session']> | null,
  ownerText: string,
  store: DockedBrowserStore = sharedDockedBrowserStore(),
): number {
  if (!session) return 0
  let opened = 0
  for (const result of session.results) {
    if (!result.url) continue
    const kind = result.mediaType as EyeHandoffKind
    handEyeResultToDockedBrowser(
      { url: result.url, kind, ownerText, sessionId: session.sessionId },
      store,
    )
    opened += 1
  }
  return opened
}

/**
 * Adapter: take whatever the Chat's research card holds and return the same
 * shape callers want. Kept here so the docked browser never has to know about
 * the wire shape of research outcomes.
 */
export function researchOutcomeToHandoffs(
  outcome: ResearchCommandOutcome,
): readonly EyeHandoffRequest[] {
  if (outcome.operation === 'refused' || !outcome.session) return []
  return collectHandoffsFromSession(outcome.session)
}

function collectHandoffsFromSession(
  session: NonNullable<ResearchCommandOutcome['session']>,
): readonly EyeHandoffRequest[] {
  const requests: EyeHandoffRequest[] = []
  for (const result of session.results) {
    if (!result.url) continue
    requests.push({
      url: result.url,
      kind: result.mediaType as EyeHandoffKind,
      ownerText: session.ownerText ?? session.intent.subject,
      sessionId: session.sessionId,
    })
  }
  return requests
}

/**
 * Resolve the dock action the chat's Research card should take when the owner
 * clicks a citation. The card already calls back into `onOpenLink`; this helper
 * is what the card actually wants.
 */
export function openResearchCitationInDockedBrowser(
  view: WorkspaceResearchView,
  url: string,
  store: DockedBrowserStore = sharedDockedBrowserStore(),
): void {
  const ownerText = view.outcome.session?.ownerText ?? view.outcome.session?.intent.subject ?? view.ownerText ?? 'Research citation'
  const result = view.outcome.session?.results.find((row) => row.url === url)
  handEyeResultToDockedBrowser({ url, kind: result?.mediaType === 'document' ? 'document' : 'citation', ownerText }, store)
}