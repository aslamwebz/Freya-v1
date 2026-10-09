import { useEffect, useMemo, useState } from 'react'
import type { ActiveTurnView } from '../../../core/protocol/conversation'
import type { CoreActivityEvent } from '../../../core/protocol/activity'
import { coreMirror, ensureActivityAttached } from '../../platform/coreClient'
import { ActivityFeed } from './ActivityFeed'

export interface ActiveTurnTrackerProps {
  readonly activeTurn: ActiveTurnView | null
  readonly onStopResponse?: () => void
}

/**
 * Check if an activity event represents a pending approval request.
 */
function isApprovalEvent(event: CoreActivityEvent): boolean {
  if (event.kind === 'work.approval.requested') return true
  if (event.type === 'cognition.authorization_required') return true
  return false
}

export function ActiveTurnTracker({
  activeTurn,
  onStopResponse,
}: ActiveTurnTrackerProps) {
  const [now, setNow] = useState<number>(() => Date.now())
  const mirror = coreMirror()
  const [events, setEvents] = useState<CoreActivityEvent[]>(() => mirror.activity)

  useEffect(() => {
    let disposed = false
    let disposeSubscription: (() => void) | null = null
    void ensureActivityAttached().then(() => {
      if (disposed) return
      disposeSubscription = mirror.subscribeActivity(setEvents)
    })
    return () => {
      disposed = true
      disposeSubscription?.()
    }
  }, [mirror])

  // Timer ticker every second for accurate duration reporting
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const startedTime = useMemo(() => {
    if (!activeTurn?.startedAt) return now
    const parsed = Date.parse(activeTurn.startedAt)
    return Number.isFinite(parsed) ? parsed : now
  }, [activeTurn?.startedAt])

  const elapsedSec = Math.max(0, Math.floor((now - startedTime) / 1000))

  // Find any active approval requests
  const pendingApproval = useMemo(() => {
    const cutoff = startedTime - 30_000
    return events
      .filter((e) => e.at >= cutoff && isApprovalEvent(e))
      .sort((a, b) => b.at - a.at)[0] ?? null
  }, [events, startedTime])

  const isExecuting = activeTurn?.providerExecuting === true
  const statusLabel = isExecuting ? 'Generating response' : 'Thinking & planning'

  return (
    <div className="chats-active-turn" data-testid="active-turn-tracker" aria-live="polite">
      <div className="chats-active-turn-card">
        <header className="chats-active-turn-head">
          <span className="chats-active-turn-dot" data-state={isExecuting ? 'executing' : 'planning'} aria-hidden="true" />
          <span className="chats-active-turn-label">
            <b>{statusLabel}</b>
            <span className="chats-active-turn-timer">· {elapsedSec}s</span>
          </span>
          {onStopResponse ? (
            <button
              type="button"
              className="chats-active-turn-stop"
              onClick={onStopResponse}
              aria-label="Stop response"
            >
              Stop
            </button>
          ) : null}
        </header>

        {pendingApproval ? (
          <div className="chats-approval-card" role="alert" aria-label="Approval required">
            <div className="chats-approval-head">
              <span className="chats-approval-icon" aria-hidden="true">⚠</span>
              <b>Approval Required by Core Guard</b>
            </div>
            <p className="chats-approval-text">{pendingApproval.text}</p>
            <small className="chats-approval-note">Action stopped for owner authorization.</small>
          </div>
        ) : null}

        <div className="chats-bubble chats-thinking">
          <i />
          <i />
          <i />
        </div>

        <ActivityFeed active={true} />
      </div>
    </div>
  )
}
