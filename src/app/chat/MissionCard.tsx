import { useState } from 'react'
import type { ChatMissionProposal, ConversationMissionView } from '../../../core/missions/chat-types'

export function MissionCard({ proposal, mission, decided, disabled, onDecision }: {
  proposal: ChatMissionProposal
  mission?: ConversationMissionView
  decided?: string
  disabled: boolean
  onDecision: (decision: 'approve' | 'reject' | 'cancel' | 'resume') => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const act = async (decision: 'approve' | 'reject' | 'cancel' | 'resume') => {
    setBusy(true)
    try { setError(await onDecision(decision)) } catch { setError('Mission decision could not reach Freya.') } finally { setBusy(false) }
  }
  const terminal = mission && ['completed', 'failed', 'cancelled'].includes(mission.status)
  return <section className="chat-mission" aria-label="Research Mission">
    <strong>{mission ? `Mission ${mission.paused ? 'paused' : mission.status}` : decided === 'rejected' ? 'Mission declined' : 'Approve research Mission'}</strong>
    <p>{proposal.scope}</p>
    {mission?.steps.length ? <ol>{mission.steps.map(step => <li key={step.stepId}>{step.intent} — {step.status}</li>)}</ol> : null}
    {mission?.blockers.length ? <p>Blocked: {mission.blockers.join(', ')}</p> : null}
    <div className="chat-mission-actions">
      {!mission && !decided ? <><button disabled={busy || disabled} onClick={() => { void act('approve') }}>Approve Mission</button><button disabled={busy || disabled} onClick={() => { void act('reject') }}>Decline</button></> : null}
      {mission && !terminal ? <><button disabled={busy} onClick={() => { void act('cancel') }}>Cancel Mission</button>{mission.paused ? <button disabled={busy || disabled} onClick={() => { void act('resume') }}>Resume</button> : null}</> : null}
    </div>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
