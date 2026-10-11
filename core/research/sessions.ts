import { extractSiteConstraint } from './chat-intent'
import { videoDurationConstraint, matchesVideoDuration } from './video-duration'
import { randomUUID } from 'node:crypto'
import { ResearchError, safeResearchError } from './errors'
import type { Searcher } from './searcher'
import type { SearchResult, SearchVertical } from './types'

export const SEARCH_SESSION_LIMITS = Object.freeze({
  targetResults: 100,
  pages: 10,
  concurrent: 2,
})

export type SearchMediaType = 'auto' | 'web' | 'image' | 'video' | 'audio' | 'document' | 'file'
export type SearchSessionState = 'active' | 'paused' | 'completed' | 'partial' | 'cancelled' | 'failed'
export type SearchResultConfidence = 'exact' | 'probable' | 'weak'
export type SearchCollectionName = 'Videos Found' | 'Images Found' | 'Audio Found' | 'Files Found' | 'Sources'

export interface SearchIntent {
  subject: string
  targetCount: number
  mediaType: SearchMediaType
  constraints: string[]
  exclusions: string[]
  site: string | null
}

export interface SearchIntentPatch {
  subject?: string
  targetCount?: number
  mediaType?: SearchMediaType
  addConstraints?: string[]
  addExclusions?: string[]
  site?: string | null
}

export interface SearchSessionResult extends SearchResult {
  resultId: string
  mediaType: Exclude<SearchMediaType, 'auto'>
  confidence: SearchResultConfidence
  collection: SearchCollectionName
  intentVersion: number
}

export interface SearchSession {
  sessionId: string
  ownerText?: string
  intent: SearchIntent
  intentVersion: number
  state: SearchSessionState
  page: number
  results: SearchSessionResult[]
  createdAt: string
  updatedAt: string
  lastError: string | null
}

export interface SearchSessionStore {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly reason: string | null
  put(session: SearchSession): Promise<void>
  read(sessionId: string): Promise<SearchSession | null>
  list(): Promise<SearchSession[]>
  remove(sessionId: string): Promise<boolean>
}

export class MemorySearchSessionStore implements SearchSessionStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly reason: string
  private readonly sessions = new Map<string, SearchSession>()

  constructor(reason = 'Search sessions are held in memory only and will not survive restart.') {
    this.reason = reason
  }

  async put(session: SearchSession): Promise<void> {
    this.sessions.set(session.sessionId, cloneSession(validateSearchSession(session)))
  }
  async read(sessionId: string): Promise<SearchSession | null> {
    const value = this.sessions.get(sessionId)
    return value ? cloneSession(value) : null
  }
  async list(): Promise<SearchSession[]> {
    return [...this.sessions.values()].map(cloneSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async remove(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId)
  }
}

export interface ParsedSearchRequest {
  intent: SearchIntent
  exclusionsDetected: string[]
}

export function parseSearchRequest(text: string): ParsedSearchRequest {
  if (typeof text !== 'string' || text.length > 16384) throw new ResearchError('invalid_query')
  const raw = normalizeText(text, 4096)
  let working = raw.replace(/^(?:please\s+)?(?:(?:start|begin)\s+(?:a\s+)?)?new\s+(?:search|eye)(?:\s*[:,-]\s*|\s+for\s+|\s+)/i, '')
  const duration = videoDurationConstraint(working)
  if (duration) working = working.replace(duration.text, ' ')
  const countMatch = working.match(/\b(\d{1,3})\b/)
  const targetCount = clampTarget(countMatch ? Number(countMatch[1]) : 10)
  if (countMatch) working = working.replace(countMatch[1]!, ' ')

  const media = detectRequestedMedia(working)
  if (media.token) working = working.replace(media.token, ' ')

  const exclusions: string[] = []
  working = working.replace(/\b(?:no|not)\s+([^,.;]+)/gi, (_match, value: string) => {
    const exclusion = cleanConstraint(value)
    if (exclusion) exclusions.push(exclusion)
    return ' '
  })

  let site: string | null = extractSiteConstraint(raw)
  const siteMatch = working.match(/\bon\s+(youtube|vimeo|tiktok|reddit)\b/i)
  if (siteMatch) {
    site = siteDomain(siteMatch[1]!)
    working = working.replace(siteMatch[0], ' ')
  }

  const subject = working
    .replace(/^\s*(?:please\s+)?(?:find|search(?:\s+for)?|get|show)\s+(?:me\s+)?/i, '')
    .replace(/\b(?:some|results?|items?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[,.;\s]+|[,.;\s]+$/g, '')
    .trim()

  if (!subject) throw new ResearchError('invalid_query')
  return {
    intent: {
      subject: subject.slice(0, 512),
      targetCount,
      mediaType: media.mediaType,
      constraints: duration ? [duration.text] : [],
      exclusions: uniqueStrings(exclusions),
      site,
    },
    exclusionsDetected: uniqueStrings(exclusions),
  }
}

export interface FollowUpPatchResult {
  patch: SearchIntentPatch | null
  ambiguous: boolean
}

export function patchFromFollowUp(text: string, current: SearchIntent): FollowUpPatchResult {
  const raw = normalizeText(text, 1024)
  const lower = raw.toLowerCase()
  const duration = videoDurationConstraint(raw)
  if (duration) return { patch: { addConstraints: [duration.text] }, ambiguous: false }

  const count = lower.match(/^(?:make\s+it|change(?:\s+it)?\s+to|only)\s+(\d{1,3})(?:\s+results?)?$/)
  if (count) return { patch: { targetCount: clampTarget(Number(count[1])) }, ambiguous: false }

  const site = lower.match(/^only\s+((?:[a-z0-9-]+\.)+[a-z]{2,}|youtube|vimeo|tiktok|reddit)$/)
  if (site) return { patch: { site: siteDomain(site[1]!) }, ambiguous: false }

  const media = lower.match(/^only\s+(videos?|images?|photos?|audio|podcasts?|pdfs?|documents?|files?|websites?|sites?)$/)
  if (media) return { patch: { mediaType: detectRequestedMedia(media[1]!).mediaType }, ambiguous: false }

  const exclusion = raw.match(/^(?:not|without|exclude|no)\s+(.+)$/i)
  if (exclusion) {
    const value = cleanConstraint(exclusion[1]!)
    return value ? { patch: { addExclusions: [value] }, ambiguous: false } : { patch: null, ambiguous: true }
  }

  if (/^(?:in|at|from|with|about|during|near)\b/i.test(raw)) {
    return { patch: { addConstraints: [raw] }, ambiguous: false }
  }

  const only = raw.match(/^only\s+(.+)$/i)
  if (only) {
    const value = cleanConstraint(only[1]!)
    return value ? { patch: { addConstraints: [value] }, ambiguous: false } : { patch: null, ambiguous: true }
  }

  if (/^(?:this|that|those|these|there|here)\b/i.test(raw) || raw.split(/\s+/).length <= 2) {
    return { patch: null, ambiguous: true }
  }

  // A full sentence is treated as a replacement subject only when it clearly
  // contains the original subject. Otherwise changing goals needs confirmation.
  if (lower.includes(current.subject.toLowerCase())) {
    return { patch: { subject: raw }, ambiguous: false }
  }
  return { patch: null, ambiguous: true }
}

export function applyIntentPatch(intent: SearchIntent, patch: SearchIntentPatch): SearchIntent {
  const next: SearchIntent = {
    subject: patch.subject === undefined ? intent.subject : normalizeText(patch.subject, 512),
    targetCount: patch.targetCount === undefined ? intent.targetCount : clampTarget(patch.targetCount),
    mediaType: patch.mediaType ?? intent.mediaType,
    constraints: uniqueStrings([...intent.constraints, ...(patch.addConstraints ?? []).map(cleanConstraint).filter(Boolean)]),
    exclusions: uniqueStrings([...intent.exclusions, ...(patch.addExclusions ?? []).map(cleanConstraint).filter(Boolean)]),
    site: patch.site === undefined ? intent.site : normalizeSite(patch.site),
  }
  if (!next.subject.trim()) throw new ResearchError('invalid_query')
  return next
}

export function queryForIntent(intent: SearchIntent): string {
  const parts = [intent.subject]
  if (intent.mediaType !== 'auto' && intent.mediaType !== 'web') parts.push(mediaQueryWord(intent.mediaType))
  parts.push(...intent.constraints)
  if (intent.site) parts.push(`site:${intent.site}`)
  for (const exclusion of intent.exclusions) parts.push(`-${quoteIfNeeded(exclusion)}`)
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 512)
}

export interface SearchSessionManagerOptions {
  searcher: Pick<Searcher, 'searchWeb'>
  store?: SearchSessionStore
  now?: () => Date
  newId?: () => string
}

export class SearchSessionManager {
  readonly store: SearchSessionStore
  private readonly active = new Map<string, AbortController>()
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly options: SearchSessionManagerOptions) {
    this.store = options.store ?? new MemorySearchSessionStore()
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? randomUUID
  }

  async create(request: string | SearchIntent): Promise<SearchSession> {
    const intent = typeof request === 'string' ? parseSearchRequest(request).intent : validateIntent(request)
    const now = this.now().toISOString()
    const session: SearchSession = {
      sessionId: validateId(this.newId()),
      ownerText: typeof request === 'string' ? request : intent.subject,
      intent,
      intentVersion: 1,
      state: 'active',
      page: 0,
      results: [],
      createdAt: now,
      updatedAt: now,
      lastError: null,
    }
    await this.store.put(session)
    return cloneSession(session)
  }

  async read(sessionId: string): Promise<SearchSession | null> {
    return this.store.read(validateId(sessionId))
  }

  async list(): Promise<SearchSession[]> {
    return this.store.list()
  }

  async patch(sessionId: string, patch: SearchIntentPatch): Promise<SearchSession> {
    const id = validateId(sessionId)
    const current = await this.requireSession(id)
    this.active.get(id)?.abort()
    const intent = applyIntentPatch(current.intent, patch)
    const compatible = current.results.filter((result) => resultCompatible(result, intent))
    const updated: SearchSession = {
      ...current,
      intent,
      intentVersion: current.intentVersion + 1,
      state: 'active',
      page: 0,
      results: compatible.map((result, index) => ({ ...result, rank: index + 1 })),
      updatedAt: this.now().toISOString(),
      lastError: null,
    }
    await this.store.put(updated)
    return cloneSession(updated)
  }

  async patchFollowUp(sessionId: string, text: string): Promise<{ session: SearchSession; ambiguous: boolean }> {
    const current = await this.requireSession(validateId(sessionId))
    const interpreted = patchFromFollowUp(text, current.intent)
    if (!interpreted.patch) return { session: current, ambiguous: true }
    return { session: await this.patch(current.sessionId, interpreted.patch), ambiguous: false }
  }

  async pause(sessionId: string): Promise<SearchSession> {
    const id = validateId(sessionId)
    this.active.get(id)?.abort()
    return this.setState(id, 'paused')
  }

  async resume(sessionId: string): Promise<SearchSession> {
    const id = validateId(sessionId)
    const current = await this.requireSession(id)
    if (current.state === 'cancelled' || current.state === 'completed') return current
    const updated = { ...current, state: 'active' as const, updatedAt: this.now().toISOString(), lastError: null }
    await this.store.put(updated)
    return cloneSession(updated)
  }

  async cancel(sessionId: string): Promise<SearchSession> {
    const id = validateId(sessionId)
    this.active.get(id)?.abort()
    return this.setState(id, 'cancelled')
  }

  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort()
  }

  async collect(
    sessionId: string,
    options: { signal?: AbortSignal; maxPages?: number } = {},
  ): Promise<SearchSession> {
    const id = validateId(sessionId)
    if (this.active.has(id)) throw new ResearchError('invalid_response')
    if (this.active.size >= SEARCH_SESSION_LIMITS.concurrent) throw new ResearchError('invalid_response')
    let session = await this.requireSession(id)
    if (session.state === 'cancelled' || session.state === 'completed') return session
    if (session.state === 'paused') session = await this.resume(id)

    const controller = new AbortController()
    this.active.set(id, controller)
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    const maxPages = Math.max(1, Math.min(SEARCH_SESSION_LIMITS.pages, Math.floor(options.maxPages ?? SEARCH_SESSION_LIMITS.pages)))

    try {
      for (let attempted = 0; attempted < maxPages; attempted += 1) {
        if (signal.aborted) throw new ResearchError('cancelled')
        session = await this.requireSession(id)
        if (session.state !== 'active') return session
        if (session.results.length >= session.intent.targetCount) return this.setState(id, 'completed')
        if (session.page >= SEARCH_SESSION_LIMITS.pages) return this.setState(id, 'partial')

        const remaining = session.intent.targetCount - session.results.length
        const limit = Math.min(10, remaining)
        const found = await this.options.searcher.searchWeb(queryForIntent(session.intent), {
          signal,
          limit,
          offset: session.page,
          vertical: verticalForMedia(session.intent.mediaType),
          ...(session.intent.site ? { site: session.intent.site } : {}),
        })
        const merged = mergeResults(session, found)
        const state: SearchSessionState =
          merged.results.length >= merged.intent.targetCount ? 'completed'
            : found.length < limit ? 'partial'
              : merged.page >= SEARCH_SESSION_LIMITS.pages ? 'partial'
                : 'active'
        session = { ...merged, state, updatedAt: this.now().toISOString(), lastError: null }
        await this.store.put(session)
        if (state !== 'active') return cloneSession(session)
      }
      return cloneSession(session)
    } catch (error) {
      const latest = await this.requireSession(id)
      if (signal.aborted) {
        // Explicit pause/cancel writes its state before/while aborting. A caller
        // cancellation without such a state becomes paused so it can be resumed.
        if (latest.state === 'paused' || latest.state === 'cancelled') return latest
        return this.setState(id, 'paused')
      }
      const safe = safeResearchError(error, 'provider_error')
      const failed = { ...latest, state: 'failed' as const, updatedAt: this.now().toISOString(), lastError: safe.code }
      await this.store.put(failed)
      return cloneSession(failed)
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id)
    }
  }

  private async setState(sessionId: string, state: SearchSessionState): Promise<SearchSession> {
    const current = await this.requireSession(sessionId)
    const updated = { ...current, state, updatedAt: this.now().toISOString() }
    await this.store.put(updated)
    return cloneSession(updated)
  }

  private async requireSession(sessionId: string): Promise<SearchSession> {
    const current = await this.store.read(sessionId)
    if (!current) throw new ResearchError('invalid_query')
    return validateSearchSession(current)
  }
}

function mergeResults(session: SearchSession, found: readonly SearchResult[]): SearchSession {
  const seen = new Set(session.results.map((result) => result.url))
  const next = [...session.results]
  for (const row of found) {
    if (seen.has(row.url)) continue
    seen.add(row.url)
    const classified = classifyResult(row, session.intent.mediaType)
    if (session.intent.mediaType !== 'auto' && classified.confidence === 'weak') continue
    if (!resultCompatible({ ...row, mediaType: classified.mediaType, confidence: classified.confidence }, session.intent)) continue
    next.push({
      ...row,
      resultId: `${session.sessionId}:${next.length + 1}`,
      rank: next.length + 1,
      mediaType: classified.mediaType,
      confidence: classified.confidence,
      collection: classified.collection,
      intentVersion: session.intentVersion,
    })
    if (next.length >= session.intent.targetCount) break
  }
  return { ...session, page: session.page + 1, results: next }
}

function resultCompatible(result: Pick<SearchSessionResult, 'title' | 'snippet' | 'sourceDomain' | 'url' | 'mediaType' | 'confidence' | 'metadata'>, intent: SearchIntent): boolean {
  const text = `${result.title} ${result.snippet} ${result.sourceDomain} ${result.url}`.toLowerCase()
  if (intent.site && !(result.sourceDomain.toLowerCase() === intent.site.toLowerCase() || result.sourceDomain.toLowerCase().endsWith(`.${intent.site.toLowerCase()}`))) return false
  if (intent.mediaType !== 'auto' && intent.mediaType !== 'web' && result.mediaType !== intent.mediaType && result.confidence === 'weak') return false
  for (const exclusion of intent.exclusions) {
    const token = significantWords(exclusion)
    if (token.some((word) => text.includes(word))) return false
  }
  for (const constraint of intent.constraints) {
    const duration = videoDurationConstraint(constraint)
    if (duration) {
      if (result.mediaType !== 'video' || !matchesVideoDuration(result.metadata?.duration, duration)) return false
      continue
    }
    const words = significantWords(constraint)
    if (words.length && !words.every((word) => text.includes(word))) return false
  }
  return true
}

function classifyResult(result: SearchResult, requested: SearchMediaType): { mediaType: Exclude<SearchMediaType, 'auto'>; confidence: SearchResultConfidence; collection: SearchCollectionName } {
  const url = result.url.toLowerCase()
  const text = `${result.title} ${result.snippet}`.toLowerCase()
  let mediaType: Exclude<SearchMediaType, 'auto'> = 'web'
  let strong = false

  if (result.vertical === 'images' && (result.mediaUrl || result.thumbnailUrl)) { mediaType = 'image'; strong = true }
  else if (result.vertical === 'videos') { mediaType = 'video'; strong = true }
  else if (result.vertical === 'audio') { mediaType = 'audio'; strong = true }
  else if (/\.(?:mp4|webm|mov|m4v)(?:$|[?#])/.test(url) || isVideoPage(url)) { mediaType = 'video'; strong = true }
  else if (/\.(?:png|jpe?g|gif|webp|avif)(?:$|[?#])/.test(url)) { mediaType = 'image'; strong = true }
  else if (/\.(?:mp3|wav|m4a|ogg|flac)(?:$|[?#])/.test(url)) { mediaType = 'audio'; strong = true }
  else if (/\.(?:pdf|docx?|pptx?|xlsx?)(?:$|[?#])/.test(url)) { mediaType = 'document'; strong = true }
  else if (/\.(?:zip|tar|gz|7z|csv|json|xml)(?:$|[?#])/.test(url)) { mediaType = 'file'; strong = true }
  else if (/\b(video|watch|clip|footage)\b/.test(text)) mediaType = 'video'
  else if (/\b(image|photo|picture|gallery)\b/.test(text)) mediaType = 'image'
  else if (/\b(audio|podcast|listen)\b/.test(text)) mediaType = 'audio'
  else if (/\b(pdf|document|report|paper)\b/.test(text)) mediaType = 'document'

  const requestedType = requested === 'auto' ? mediaType : requested
  const confidence: SearchResultConfidence =
    requested === 'auto' || requested === 'web'
      ? (strong ? 'exact' : 'probable')
      : mediaType === requestedType
        ? (strong ? 'exact' : 'probable')
        : 'weak'

  return { mediaType, confidence, collection: collectionFor(mediaType) }
}

function isVideoPage(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./, '')
    return (host === 'youtube.com' && (url.pathname === '/watch' && url.searchParams.has('v') || /^\/(shorts|embed)\//.test(url.pathname))) || (host === 'youtu.be' && url.pathname.length > 1) || (host === 'vimeo.com' && /^\/\d+/.test(url.pathname)) || (host === 'tiktok.com' && /\/video\/\d+/.test(url.pathname))
  } catch { return false }
}

function collectionFor(mediaType: Exclude<SearchMediaType, 'auto'>): SearchCollectionName {
  if (mediaType === 'video') return 'Videos Found'
  if (mediaType === 'image') return 'Images Found'
  if (mediaType === 'audio') return 'Audio Found'
  if (mediaType === 'document' || mediaType === 'file') return 'Files Found'
  return 'Sources'
}

function detectRequestedMedia(text: string): { mediaType: SearchMediaType; token: string | null } {
  const match = text.match(/\b(videos?|images?|photos?|audio|podcasts?|pdfs?|documents?|files?|websites?|sites?)\b/i)
  if (!match) return { mediaType: 'auto', token: null }
  const word = match[1]!.toLowerCase()
  if (word.startsWith('video')) return { mediaType: 'video', token: match[0] }
  if (word.startsWith('image') || word.startsWith('photo')) return { mediaType: 'image', token: match[0] }
  if (word === 'audio' || word.startsWith('podcast')) return { mediaType: 'audio', token: match[0] }
  if (word.startsWith('pdf') || word.startsWith('document')) return { mediaType: 'document', token: match[0] }
  if (word.startsWith('file')) return { mediaType: 'file', token: match[0] }
  return { mediaType: 'web', token: match[0] }
}

function mediaQueryWord(mediaType: SearchMediaType): string {
  if (mediaType === 'image') return 'images'
  if (mediaType === 'video') return 'videos'
  if (mediaType === 'audio') return 'audio'
  if (mediaType === 'document') return 'document'
  if (mediaType === 'file') return 'file'
  return ''
}

function siteDomain(value: string): string {
  const lower = value.toLowerCase()
  if (lower === 'youtube') return 'youtube.com'
  if (lower === 'vimeo') return 'vimeo.com'
  if (lower === 'tiktok') return 'tiktok.com'
  if (lower === 'reddit') return 'reddit.com'
  return normalizeSite(value) ?? ''
}

function normalizeSite(value: string | null): string | null {
  if (value === null) return null
  const site = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
  if (!/^[a-z0-9.-]{1,253}$/.test(site) || site.includes('..')) throw new ResearchError('invalid_query')
  return site
}

function validateIntent(intent: SearchIntent): SearchIntent {
  if (!intent || typeof intent !== 'object') throw new ResearchError('invalid_query')
  if (!['auto', 'web', 'image', 'video', 'audio', 'document', 'file'].includes(intent.mediaType)) throw new ResearchError('invalid_query')
  return {
    subject: normalizeText(intent.subject, 512),
    targetCount: clampTarget(intent.targetCount),
    mediaType: intent.mediaType,
    constraints: uniqueStrings((intent.constraints ?? []).map(cleanConstraint).filter(Boolean)),
    exclusions: uniqueStrings((intent.exclusions ?? []).map(cleanConstraint).filter(Boolean)),
    site: normalizeSite(intent.site ?? null),
  }
}

export function validateSearchSession(session: SearchSession): SearchSession {
  if (!session || typeof session !== 'object') throw new ResearchError('invalid_response')
  const id = validateId(session.sessionId)
  if (session.ownerText !== undefined && (typeof session.ownerText !== 'string' || session.ownerText.length > 16384)) throw new ResearchError('invalid_response')
  const intent = validateIntent(session.intent)
  if (!Number.isInteger(session.intentVersion) || session.intentVersion < 1 || session.intentVersion > 10000) throw new ResearchError('invalid_response')
  if (!['active', 'paused', 'completed', 'partial', 'cancelled', 'failed'].includes(session.state)) throw new ResearchError('invalid_response')
  if (!Number.isInteger(session.page) || session.page < 0 || session.page > SEARCH_SESSION_LIMITS.pages) throw new ResearchError('invalid_response')
  if (!Array.isArray(session.results) || session.results.length > SEARCH_SESSION_LIMITS.targetResults) throw new ResearchError('invalid_response')
  if (!Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))) throw new ResearchError('invalid_response')
  return { ...session, sessionId: id, intent }
}

function validateId(id: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ResearchError('invalid_query')
  return id
}

function normalizeText(value: string, max: number): string {
  if (typeof value !== 'string') throw new ResearchError('invalid_query')
  const text = value.trim().replace(/\s+/g, ' ')
  if (!text || text.length > max) throw new ResearchError('invalid_query')
  return text
}

function cleanConstraint(value: string): string {
  return typeof value === 'string' ? value.trim().replace(/[.,;]+$/g, '').replace(/\s+/g, ' ').slice(0, 256) : ''
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 16)
}

function significantWords(value: string): string[] {
  const ignored = new Set(['in', 'the', 'a', 'an', 'at', 'from', 'with', 'without', 'of', 'on', 'for', 'only'])
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !ignored.has(word))
    .map((word) => word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)
}

function clampTarget(value: number): number {
  if (!Number.isFinite(value)) throw new ResearchError('invalid_query')
  return Math.max(1, Math.min(SEARCH_SESSION_LIMITS.targetResults, Math.floor(value)))
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

function cloneSession(session: SearchSession): SearchSession {
  return {
    ...session,
    intent: {
      ...session.intent,
      constraints: [...session.intent.constraints],
      exclusions: [...session.intent.exclusions],
    },
    results: session.results.map((result) => ({ ...result })),
  }
}

function verticalForMedia(media: SearchMediaType): SearchVertical {
  if (media === 'image') return 'images'
  if (media === 'video') return 'videos'
  if (media === 'audio') return 'audio'
  if (media === 'document' || media === 'file') return 'documents'
  return 'web'
}
