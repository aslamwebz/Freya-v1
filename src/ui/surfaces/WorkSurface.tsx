import { useEffect, useMemo, useState } from 'react'
import type { WorkRunView } from '../../../core/work/projection'
import type { TaskStatus } from '../../../core/work/types'
import { workMirror } from '../../platform/workClient'
import { useWork } from '../../core/useWork'

/**
 * THE WORK BOARD.
 *
 * This window exists to answer the questions a person is entitled to ask about work
 * Freya is doing, and it is built around exactly those:
 *
 *   1. **Is anything happening, and what?** Live runs, queued runs, waiting runs —
 *      each with a *step*, not a percentage, so "half done" is never a number that
 *      will change under the reader.
 *   2. **Is she waiting on me?** Approvals are the loudest thing on the window,
 *      because an approval is the one thing only the owner can move and the one
 *      thing that silently stops all work when it goes unanswered.
 *   3. **Did it work?** Every run shows its verification outcome, and a failed
 *      verification is displayed as a failure — not softened into "completed with
 *      issues", which is the phrasing that makes an engine look reliable.
 *
 * ## What it deliberately does not do
 *
 * There is no "mark as done". A step closes on a verifier, in Core, and a window
 * that could close one would make the whole verification boundary decorative.
 *
 * There is also no percentage unless Core derived one. The progress line is
 * structural — "2 of 3 steps verified, 1 failed" — because a percentage computed
 * from work that has not been decided is a number that will change and one a
 * person who saw it would remember.
 *
 * ## The geometry rules this window does not get to break
 *
 * It is an absolutely positioned surface in a sibling layer, like every other. It
 * cannot reflow the shell grid, cannot move the orb, and cannot change the brain —
 * those live in `.presence-overlay`, outside the grid, and are sized from the
 * viewport alone.
 */

/** Refusal and result messages are ours, and bounded like everything else. */
const MAX_COMPOSED_CHARS = 200

/**
 * The two demonstration plans.
 *
 * Fixed here rather than generated, and split rather than combined. They exist to
 * prove two different mechanisms, and combining them would hide both: a run stops
 * at its first failed step, so a plan containing both a failing step and a gated one
 * could never reach the gate. Two buttons is also the more honest board — each one
 * demonstrates one property, and its name says which.
 *
 * Every capability in them is one Core already has, and Core refuses the whole plan
 * if any is not there. A window composes nothing itself.
 */
const GATED_PLAN = [
  {
    key: 'record',
    label: 'Record the first note',
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: { expect: 'record' },
  },
  {
    key: 'consequential',
    label: 'Apply a consequential effect',
    capability: 'test.consequential',
    verifier: 'test.change.applied',
    input: { effect: 'overwrite the local demonstration configuration' },
  },
] as const

const UNVERIFIABLE_PLAN = [
  {
    key: 'record',
    label: 'Record the first note',
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: { expect: 'record' },
  },
  {
    key: 'mismatch',
    label: 'Record something verification will reject',
    capability: 'test.record',
    verifier: 'test.record.matches',
    input: { expect: 'something-else' },
  },
] as const

export function WorkSurface() {
  const projection = useWork()
  const mirror = workMirror()

  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [tone, setTone] = useState<'ok' | 'refused'>('ok')

  useEffect(() => {
    void mirror.attach()
  }, [mirror])

  const taskId = useMemo(() => {
    const first = projection?.tasks[0]
    return first && first.status !== 'done' && first.status !== 'cancelled' ? first.taskId : undefined
  }, [projection])

  // A refusal is shown as a refusal, with Core's own words. Swallowing the reason
  // would leave a person unable to find out why Freya declined, which is exactly
  // when they most need to know.
  const report = (outcome: { ok: boolean; operation: string; reason?: string }): boolean => {
    setTone(outcome.ok ? 'ok' : 'refused')
    setReply(outcome.reason ?? (outcome.ok ? `Core: ${outcome.operation}.` : null))
    return outcome.ok
  }

  const act = async (task: () => Promise<{ ok: boolean; operation: string; reason?: string }>) => {
    setBusy(true)
    setReply(null)
    try {
      return report(await task())
    } finally {
      setBusy(false)
    }
  }

  const addTask = () =>
    act(async () => {
      const outcome = await mirror.createTask(title.trim().slice(0, MAX_COMPOSED_CHARS))
      if (outcome.ok) setTitle('')
      return outcome
    })

  const start = (plan: readonly { key: string; label: string; capability: string; verifier: string; input: Record<string, unknown> }[]) =>
    act(async () => {
      const created = await mirror.createRun({
        steps: plan.map((step) => ({ ...step })),
        ...(taskId === undefined ? {} : { taskId }),
      })
      if (!created.ok || created.runId === undefined) return created
      // Created means `queued`. Starting is a second, explicit command, so nothing
      // begins executing merely because the board was opened.
      return mirror.startRun(created.runId)
    })

  if (projection === null) {
    return (
      <div className="work-surface">
        <p className="work-absent">Waiting for Freya Core to report what she is working on.</p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    return (
      <div className="work-surface">
        <p className="work-absent" role="status">
          {projection.reason ?? 'the Work engine is not available'}
        </p>
      </div>
    )
  }

  const active = projection.runs.filter((run) => !isSettled(run.status))
  const finished = projection.runs.filter((run) => isSettled(run.status)).slice(0, 12)
  const pending = projection.approvals.filter((approval) => approval.status === 'pending')

  return (
    <div className="work-surface" data-runs={projection.counts.runs}>
      {/* Durability and the limits, first. Somebody deciding whether to plan work
          needs to know what the engine will refuse before they plan it, not after a
          run stops on a ceiling they did not know existed. */}
      <section className="work-posture">
        <b>{projection.counts.liveCapabilities > 0 ? 'WORKING' : 'IDLE'}</b>
        <span>
          History is durable in Freya's event journal: what ran, in what order, how it ended, and
          whether it verified. Step detail is not — a plan and an observation live only while Freya is
          running, so after a restart a run shows its structure and not its contents.
        </span>
        <span className="work-limits">
          Per run: up to {projection.limits.maxSteps} steps, {projection.limits.maxActions}{' '}
          capability calls, {Math.round(projection.limits.maxDurationMs / 60000)} minutes, and{' '}
          {projection.limits.maxAttemptsPerStep} attempts per step.
        </span>
        {/* Retention stated rather than applied silently. A board that quietly stopped
            listing runs would read as "they finished and went away", which is the
            false impression a bounded viewer is most likely to create. Everything is
            still in the journal — this is what the window was shown. */}
        {projection.runsHidden > 0 ? (
          <span className="work-limits">
            Showing the {projection.runsRetained} most recent of {projection.runsTotal} runs.{' '}
            {projection.runsHidden} older {projection.runsHidden === 1 ? 'run is' : 'runs are'} kept in
            Freya's journal and still counted, just not listed here.
          </span>
        ) : null}
      </section>

      <section className="work-section">
        <h3>Waiting for you</h3>
        <p className="work-note">
          Nothing has run for an approval below. A request stays open until it is answered; the run is
          stopped, not slowed, while it waits.
        </p>
        {pending.length === 0 ? (
          <p className="work-none">No approval is outstanding.</p>
        ) : (
          <ul className="work-approvals">
            {pending.map((approval) => (
              <li key={approval.approvalId} className="work-approval" data-risk={approval.risk}>
                {/* The proposal is written by the capability's own `describe()`, which
                    already says what would happen. Prefixing it with "would" here is
                    how you get "would would" on screen, so the name is set apart and
                    the sentence is quoted as the capability wrote it. */}
                <p className="work-approval-what">
                  <b>{approval.capability}</b> <span>{approval.proposal}</span>
                </p>
                <p className="work-approval-why">{approval.justification}</p>
                <p className="work-approval-meta">
                  Needs <code>{approval.requiredCapability}</code> · risk {approval.risk}
                </p>
                <div className="work-approval-actions">
                  <button
                    type="button"
                    className="work-button work-button-primary"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        mirror.decide(approval.approvalId, 'approved', 'approved from the Work board'),
                      )
                    }
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="work-button"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        mirror.decide(approval.approvalId, 'denied', 'denied from the Work board'),
                      )
                    }
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {projection.approvals.filter((approval) => approval.status !== 'pending').length > 0 ? (
          <p className="work-decided">
            Decided:{' '}
            {projection.approvals
              .filter((approval) => approval.status !== 'pending')
              .slice(0, 4)
              .map((approval) => `${approval.capability} ${approval.status}`)
              .join(', ')}
          </p>
        ) : null}
      </section>

      <section className="work-section">
        <h3>Tasks</h3>
        <label className="work-field">
          <span>A piece of work</span>
          <input
            type="text"
            value={title}
            maxLength={MAX_COMPOSED_CHARS}
            placeholder="something worth tracking"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="work-button"
          disabled={busy || title.trim().length === 0}
          onClick={() => void addTask()}
        >
          Add task
        </button>
        {projection.tasks.length === 0 ? (
          <p className="work-none">No tasks yet. A task is work you can see; a step is not.</p>
        ) : (
          <ul className="work-tasks">
            {projection.tasks.slice(0, 8).map((task) => (
              <li key={task.taskId} data-status={task.status}>
                <span className="work-task-title">
                  {task.title ?? 'A task from a previous session (title not kept)'}
                </span>
                <span className="work-task-meta">
                  {task.status} · {task.runIds.length} run{task.runIds.length === 1 ? '' : 's'}
                </span>
                {!isTaskSettled(task.status) ? (
                  <span className="work-task-actions">
                    <button
                      type="button"
                      className="work-button work-button-small"
                      disabled={busy}
                      onClick={() => void act(() => mirror.updateTask(task.taskId, 'blocked'))}
                    >
                      Block
                    </button>
                    <button
                      type="button"
                      className="work-button work-button-small"
                      disabled={busy}
                      onClick={() => void act(() => mirror.updateTask(task.taskId, 'cancelled'))}
                    >
                      Cancel
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="work-section">
        <h3>Run something</h3>
        <p className="work-note">
          Two runs, each demonstrating one thing. The first verifies a step and then stops for your
          approval before a consequential one — and nothing has run at that point. The second's second
          step <em>completes</em> and still fails, because the observation it returned is not the one the
          step intended. That is what an action that ran and did not work looks like from outside.
        </p>
        <div className="work-run-actions">
          <button
            type="button"
            className="work-button work-button-primary"
            disabled={busy}
            onClick={() => void start(GATED_PLAN)}
          >
            {busy ? 'Working…' : 'Run until it asks'}
          </button>
          <button
            type="button"
            className="work-button"
            disabled={busy}
            onClick={() => void start(UNVERIFIABLE_PLAN)}
          >
            Run something unverifiable
          </button>
        </div>
        {reply ? (
          <p className="work-reply" data-tone={tone} role={tone === 'refused' ? 'alert' : 'status'}>
            {reply}
          </p>
        ) : null}
      </section>

      <section className="work-section">
        <h3>Running and waiting</h3>
        {active.length === 0 ? (
          <p className="work-none">Nothing is executing.</p>
        ) : (
          <ul className="work-runs">
            {active.map((run) => (
              <RunRow key={run.runId} run={run} busy={busy} act={act} mirror={mirror} />
            ))}
          </ul>
        )}
      </section>

      <section className="work-section">
        <h3>Finished</h3>
        {finished.length === 0 ? (
          <p className="work-none">No run has finished yet.</p>
        ) : (
          <ul className="work-runs">
            {finished.map((run) => (
              <RunRow key={run.runId} run={run} busy={busy} act={act} mirror={mirror} />
            ))}
          </ul>
        )}
      </section>

      <section className="work-section">
        <h3>What Freya can run here</h3>
        <p className="work-note">
          Core decides this list, not the window. Phase 6 registers only inert capabilities — nothing
          here starts a process, reads a file or opens a network connection.
        </p>
        <p className="work-capabilities">{projection.capabilities.join(' · ') || 'none registered'}</p>
      </section>
    </div>
  )
}

function RunRow({
  run,
  busy,
  act,
  mirror,
}: {
  run: WorkRunView
  busy: boolean
  act: (
    task: () => Promise<{ ok: boolean; operation: string; reason?: string }>,
  ) => Promise<boolean>
  mirror: ReturnType<typeof workMirror>
}) {
  return (
    <li className="work-run" data-status={run.status}>
      <p className="work-run-head">
        <b>{run.kind} run</b>
        <span className="work-run-status">{run.status}</span>
        {run.limitHit ? <span className="work-run-limit">limit: {run.limitHit}</span> : null}
      </p>
      {/* Structural progress, never a fabricated percentage. */}
      <p className="work-run-progress">
        {run.progress.summary}
        {run.progress.percent === null ? '' : ` (${run.progress.percent}% of steps verified)`}
      </p>
      <ol className="work-steps">
        {run.steps.map((step) => (
          <li key={step.stepId} data-status={step.status}>
            <span className="work-step-label">{step.label ?? step.key}</span>
            <span className="work-step-meta">
              {step.status}
              {step.attempts > 1 ? ` · attempt ${step.attempts}` : ''}
              {step.reason ? ` — ${step.reason}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {run.failure ? <p className="work-run-reason">{run.failure}</p> : null}
      {run.waitingOn ? <p className="work-run-waiting">{run.waitingOn}</p> : null}
      {!isSettled(run.status) ? (
        <div className="work-run-actions">
          {run.status === 'paused' ? (
            <button
              type="button"
              className="work-button work-button-small"
              disabled={busy}
              onClick={() => void act(() => mirror.resumeRun(run.runId))}
            >
              Resume
            </button>
          ) : null}
          {run.status === 'running' ? (
            <button
              type="button"
              className="work-button work-button-small"
              disabled={busy}
              onClick={() => void act(() => mirror.pauseRun(run.runId))}
            >
              Pause
            </button>
          ) : null}
          <button
            type="button"
            className="work-button work-button-small"
            disabled={busy}
            onClick={() => void act(() => mirror.cancelRun(run.runId, 'cancelled from the Work board'))}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </li>
  )
}

function isSettled(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isTaskSettled(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled'
}