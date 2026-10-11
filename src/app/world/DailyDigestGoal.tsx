import { useEffect, useState } from 'react'
import type { GoalProjectionView } from '../../../core/protocol/longhorizon'
import { hostBridge } from '../../platform/host'

export interface DailyDigestDraft {
  readonly topics: string
  readonly sources: string
  readonly localTime: string
  readonly timezone: string
}

/** No fetching or scheduling. This is a private, owner-reviewed Goal draft only. */
export function buildDailyDigestGoal(input: DailyDigestDraft): { title: string; description: string; completionCriteria: string[] } {
  const topics = input.topics.split(',').map(value => value.trim()).filter(Boolean)
  if (topics.length < 1 || topics.length > 8 || topics.some(value => value.length > 100)) {
    throw new Error('Choose 1?8 short topics, separated by commas.')
  }
  const sourceLines = input.sources.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (sourceLines.length > 10) throw new Error('At most ten public source URLs are supported.')
  const sources: string[] = []
  for (const line of sourceLines) {
    let parsed: URL
    try { parsed = new URL(line) } catch { throw new Error('Every source must be a valid public HTTPS URL.') }
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.port || !host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
      || host.endsWith('.test') || host.endsWith('.example') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
      throw new Error('Use public HTTPS source URLs without credentials, ports, query parameters or fragments.')
    }
    if (!sources.includes(parsed.href)) sources.push(parsed.href)
  }
  if (input.localTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) throw new Error('Use 24-hour HH:MM for the proposed time.')
  const tz = input.timezone.trim()
  if (tz.length > 80 || !/^[A-Za-z0-9_+-]+$/.test(tz.replaceAll('/', ''))) throw new Error('Choose a valid timezone identifier.')
  try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { throw new Error('The timezone is not supported.') }
  const planned = input.localTime ? `Proposed local delivery: ${input.localTime} (${tz})` : `Delivery time is not selected (${tz})`
  return {
    title: 'Daily Digest - 7-day pilot',
    description: [
      'OWNER DRAFT ONLY: no collection, spending, autonomous continuation or timer is authorized by this goal.',
      'Requested outcome: a verified daily briefing for a seven-day pilot, pending a separate approved Mission and scheduler.',
      `Topics: ${topics.join('; ')}`,
      planned,
      `Proposed public sources: ${sources.length ? sources.join('; ') : 'not configured - research candidates and request review first'}`,
      'Each briefing must deduplicate stories, link sources, separate evidence from analysis, and record unavailable or disputed facts.',
    ].join('\n'),
    completionCriteria: [
      'One dated briefing for each explicitly authorized pilot day, with linked sources and a clear UTC timestamp.',
      'Deduplicate overlapping headlines, record independent evidence and refuse unsupported claims.',
      'Keep a durable record of completed and missed briefs; never mark a day complete without verified evidence.',
      'STOP ALL, revoked approval, missing sources or budget exhaustion prevents further collection.',
    ],
  }
}

export function DailyDigestGoal({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [topics, setTopics] = useState('World developments, AI and software engineering')
  const [sources, setSources] = useState('')
  const [localTime, setLocalTime] = useState('')
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Lisbon')
  const [projection, setProjection] = useState<GoalProjectionView | null>(null)
  const [createdId, setCreatedId] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const host = hostBridge()
    if (host && typeof host.coreGoals === 'function') void host.coreGoals().then(value => { if (alive) setProjection(value) }).catch(() => { if (alive) setNotice('Core Goals could not be read.') })
    return () => { alive = false }
  }, [])

  const create = async () => {
    const host = hostBridge()
    if (!host) { setNotice('Freya Core is not connected; nothing was created.'); return }
    let draft: ReturnType<typeof buildDailyDigestGoal>
    try { draft = buildDailyDigestGoal({ topics, sources, localTime, timezone }) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The goal details were rejected.'); return }
    setBusy(true)
    setNotice('')
    try {
      const outcome = await host.coreSubmit('goal.create', draft)
      if (outcome.ok && outcome.goal?.ok && outcome.goal.goalId) {
        setCreatedId(outcome.goal.goalId)
        setNotice('Draft Goal saved by Core. Collection and scheduling are OFF until separately authorized.')
        if (typeof host.coreGoals === 'function') setProjection(await host.coreGoals())
      } else {
        setNotice(outcome.goal?.reason ?? outcome.refusal?.reason ?? 'Core refused to create the Goal.')
      }
    } catch {
      setNotice('The Core request failed. Do not assume the Goal was created.')
    } finally { setBusy(false) }
  }

  return <section className="wn-setup wn-digest-setup" aria-label="Daily Digest goal setup">
    <article className="uw-record">
      <h2>First Goal: Daily Digest</h2>
      <p>A real encrypted seven-day Goal draft. Creating it does not activate a scheduler, access websites or spend tokens.</p>
      <div className="wn-goal-form">
        <label htmlFor="digest-topics">Topics (comma separated)</label>
        <input id="digest-topics" value={topics} maxLength={450} onChange={event => setTopics(event.target.value)} />
        <label htmlFor="digest-sources">Approved source candidates (public HTTPS, one URL per line)</label>
        <textarea id="digest-sources" value={sources} rows={5} onChange={event => setSources(event.target.value)} placeholder="Optional. Research sources in Chats before approving them." />
        <label htmlFor="digest-time">Proposed daily time (not scheduled)</label>
        <input id="digest-time" aria-label="Proposed daily time" type="time" value={localTime} onChange={event => setLocalTime(event.target.value)} />
        <label htmlFor="digest-timezone">Time zone</label>
        <input id="digest-timezone" value={timezone} onChange={event => setTimezone(event.target.value)} />
        <button type="button" onClick={() => { void create() }} disabled={busy || !!createdId || !hostBridge()}>Create draft Goal in Core</button>
        {createdId && <p role="status">Draft Goal ID: {createdId}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
    </article>
    <article className="uw-record">
      <h2>Collection and delivery</h2>
      <p><strong>Off</strong> ? no recurring execution has been authorized or wired yet.</p>
      <p>Next: verify source choices, authorize an actual read-only research Mission, then connect its verified output to the approved daily schedule and durable history.</p>
      <p>{projection ? `Core reports ${projection.goalsTotal} retained Goal record(s); persistence: ${projection.persistence.mode}.` : 'Waiting for Core Goal metadata.'}</p>
      <p>Goal titles and private criteria remain encrypted and are not exposed in this list. Review an existing Goal before creating another pilot after restart.</p>
      <button type="button" onClick={() => onNavigate('missions/goals')}>View Goals</button>
    </article>
  </section>
}
