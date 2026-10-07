import { useEffect, useState } from 'react'
import { researchMirror } from '../../platform/researchClient'
import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'
import type { WorkspaceResearchView } from './modes'
import { handAllEyeResultsToDockedBrowser } from './eyeHandoff'

/** Finder collections are durable Eye sessions; every control submits to Core. */
export function EyeSessionControls({ view, onChange }: { view: WorkspaceResearchView; onChange: (view: WorkspaceResearchView) => void }) {
  const [sessions, setSessions] = useState<NonNullable<ResearchCommandOutcome['sessions']>>([])
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const session = view.outcome.session
  useEffect(() => {
    let mounted = true
    void researchMirror().listSessions().then((outcome) => {
      if (!mounted) return
      if (outcome.sessions) setSessions(outcome.sessions)
      if (outcome.operation === 'refused') setNotice(outcome.reason ?? 'Session history unavailable.')
    })
    return () => { mounted = false }
  }, [session?.sessionId, session?.updatedAt])
  const perform = async (operation: () => Promise<ResearchCommandOutcome>) => {
    setPending(true); setNotice('')
    try {
      const outcome = await operation()
      if (outcome.session) onChange({ mode: 'eye', ownerText: outcome.session.ownerText, outcome })
      if (outcome.operation === 'refused') setNotice(outcome.reason ?? 'Eye could not complete that action.')
    } finally { setPending(false) }
  }
  return <div className="chats-eye-controls">
    <label>Saved searches <select aria-label="Eye session" value={session?.sessionId ?? ''} disabled={pending} onChange={(event) => { const id = event.target.value; if (id) void perform(() => researchMirror().readSession(id)) }}>
      <option value="">Choose a search</option>
      {session && !sessions.some((row) => row.sessionId === session.sessionId) ? <option value={session.sessionId}>{session.intent.subject}</option> : null}
      {sessions.map((row) => <option key={row.sessionId} value={row.sessionId}>{row.subject} · {row.resultCount}/{row.targetCount} · {row.state}</option>)}
    </select></label>
    {session ? <div className="chats-eye-actions">
      <button type="button" disabled={pending || session.results.length === 0} onClick={() => { const count = handAllEyeResultsToDockedBrowser(session, session.ownerText ?? view.ownerText ?? session.intent.subject); setNotice(`${count} findings opened in the browser.`) }}>Open all findings</button>
      {session.state === 'active' ? <button type="button" disabled={pending} onClick={() => void perform(() => researchMirror().pauseSession(session.sessionId))}>Pause search</button> : null}
      {['paused', 'partial', 'failed'].includes(session.state) ? <button type="button" disabled={pending} onClick={() => void perform(async () => { const resumed = await researchMirror().resumeSession(session.sessionId); return resumed.operation === 'refused' ? resumed : researchMirror().collectSession(session.sessionId) })}>Continue search</button> : null}
      {session.state !== 'cancelled' && session.state !== 'completed' ? <button type="button" disabled={pending} onClick={() => void perform(() => researchMirror().cancelSession(session.sessionId))}>Cancel search</button> : null}
    </div> : null}
    {session?.state === 'partial' ? <p>Found {session.resultCount} of {session.intent.targetCount}. The provider or collection limit was reached.</p> : null}
    {session?.lastError ? <p role="status">Search stopped: {session.lastError}. Existing findings are retained.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>
}
