import { useSyncExternalStore } from 'react'
import { attentionMirror } from '../../platform/attentionClient'
import type { CoreView, Resource } from '../../ui-v2/state/contract'
import { useAppOps } from '../state/ops'
import { WORKFLOW_SECTIONS } from '../state/routes'
import { ContextTabs, WorkspaceFrame } from '../screens/WorkspaceFrame'
import { NotConnected } from '../screens/WorkspaceResource'
import { TaskBoard } from './TaskBoard'
import './workflows.css'

const labels = { tasks: 'Tasks', running: 'Running', scheduling: 'Scheduling', workflows: 'Workflows' } as const
const subscribe = (listener: () => void) => attentionMirror().subscribe(() => listener())
const getAttention = () => attentionMirror().projection
const activeStatuses = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'paused'])

/** Reads the already-attached shipping mirrors; this workspace never drives them. */
export function WorkflowsWorkspace({ section, onNavigate, core }: {
  section: string; onNavigate: (path: string) => void; core?: Resource<CoreView>
}) {
  const { work } = useAppOps()
  const attention = useSyncExternalStore(subscribe, getAttention, getAttention)
  const coreKnown = core && (core.status === 'ready' || core.status === 'stale') && core.source === 'live' ? core.data : null
  const lastKnown = core && (core.status !== 'ready' || coreKnown?.operational !== true)
  return <WorkspaceFrame title="Workflows" description="Tasks, running work and schedules in one place." icon="widgets">
    <ContextTabs label="Workflows sections" tabs={WORKFLOW_SECTIONS.map(id => ({ id, label: labels[id] }))}
      selected={section} onSelect={id => onNavigate(`workflows/${id}`)}>
      {section === 'workflows' ? <div className="uw-empty"><h2>Workflows</h2><p>No workflows yet.</p></div> : <>
        {lastKnown && <p className="uw-source" role="status">Last reported records · {core && 'reason' in core ? core.reason : 'Freya Core is not running.'}</p>}
        {coreKnown?.stopped && <p className="uw-source" role="status">STOP ALL is active.</p>}
        {section === 'scheduling' ? attention?.health === 'ready' ? <>
          <p className="uw-summary">Freya’s reported schedules. These trigger attention events; news collection is configured separately in World.</p>
          {attention.schedules.length ? <div className="uw-records">{attention.schedules.map(schedule => <article className="uw-record" key={schedule.scheduleId}>
            <h2>{schedule.scheduleId}</h2><span className="uw-status">{schedule.status}</span>
            <p>{schedule.kind} · Due <time dateTime={schedule.dueAt}>{new Date(schedule.dueAt).toLocaleString('en-GB')}</time></p>
            <p>{schedule.intervalMs === null ? 'One-time schedule' : `Every ${schedule.intervalMs / 3_600_000} hours`} · {schedule.repeats} of {schedule.maxRepeats} repeats</p>
            <p>Condition: {schedule.condition}{schedule.goalRef ? ` · Goal: ${schedule.goalRef}` : ''}</p>
          </article>)}</div> : <p className="uw-empty">No schedules reported.</p>}
        </> : <NotConnected title="Scheduling">{attention?.reason ?? 'No schedule records are reachable from this window.'}</NotConnected>
          : work?.health !== 'ready' ? <NotConnected title={section === 'tasks' ? 'Tasks' : 'Running'}>{work?.reason ?? 'No task or run records are reachable from this window.'}</NotConnected>
            : section === 'tasks' ? <TaskBoard projection={work} /> : <>
              <p className="uw-summary">Active runs include queued, waiting and paused work. {work.runsHidden} finished runs are outside this retained view.</p>
              {work.runs.some(run => activeStatuses.has(run.status)) ? <div className="uw-records">{work.runs.filter(run => activeStatuses.has(run.status)).map(run => <article className="uw-record" key={run.runId}>
                <h2>{run.runId}</h2><span className="uw-status">{run.status.replaceAll('_', ' ')}</span>
                <p>Reported engine state: {run.live ? 'held' : 'not held'}</p>
                {run.live && run.status === 'running' && !lastKnown && !coreKnown?.stopped && <p className="wf-executing">Executing now</p>}<p>{run.progress.summary}</p>
                <p>{run.progress.verified} verified steps of {run.progress.stepsTotal}</p>
                {run.waitingOn && <p>{run.waitingOn}</p>}{run.failure && <p>{run.failure}</p>}
                {run.taskId && <p className="uw-id">Task: {run.taskId}</p>}
              </article>)}</div> : <p className="uw-empty">No active runs reported.</p>}
            </>}
      </>}
    </ContextTabs>
  </WorkspaceFrame>
}
