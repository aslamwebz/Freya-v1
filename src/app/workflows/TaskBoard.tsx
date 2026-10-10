import { useState } from 'react'
import type { WorkProjection } from '../../../core/work/projection'
import type { TaskStatus } from '../../../core/work/types'
import './workflows.css'

const columns: readonly { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'To do' }, { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' }, { status: 'done', label: 'Done' }, { status: 'cancelled', label: 'Cancelled' },
]

/** Tasks come from Core; filtering and selection never alter execution state. */
export function TaskBoard({ projection }: { projection: WorkProjection }) {
  const [query, setQuery] = useState('')
  const [selectedId, select] = useState<string | null>(null)
  const needle = query.trim().toLocaleLowerCase()
  const tasks = projection.tasks.filter(task => `${task.title ?? ''} ${task.taskId}`.toLocaleLowerCase().includes(needle))
  const selected = projection.tasks.find(task => task.taskId === selectedId)
  return <div className="wf-tasks">
    <div className="wf-board-tools">
      <label>Search tasks<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title or task ID" /></label>
      <p role="status">{tasks.length} of {projection.counts.tasks} reported tasks shown</p>
    </div>
    {!projection.tasks.length && <p className="uw-summary">{projection.counts.tasks === 0 ? 'No tasks yet.' : 'No task records available in this view.'}</p>}
    {needle && !tasks.length && <p className="uw-summary">No matching tasks.</p>}
    <div className="wf-board" role="region" aria-label="Task board" tabIndex={0}>
      {columns.map(column => {
        const cards = tasks.filter(task => task.status === column.status)
        return <section className="wf-column" key={column.status} data-status={column.status} role="region" aria-label={column.label}>
          <header><h2>{column.label}</h2><span>{cards.length}</span></header>
          <div className="wf-cards">{cards.map(task => <button type="button" className="wf-task" key={task.taskId}
            aria-label={task.title ?? task.taskId} aria-pressed={task.taskId === selectedId} onClick={() => select(task.taskId)}>
            <b>{task.title ?? task.taskId}</b>{task.title === null && <small>Title unavailable</small>}
            <span className="uw-id">{task.taskId}</span><small>{task.runIds.length} linked {task.runIds.length === 1 ? 'run' : 'runs'}</small>
          </button>)}{!cards.length && <p className="wf-no-cards">No tasks</p>}</div>
        </section>
      })}
    </div>
    {selected && <section className="uw-record wf-task-details" role="region" aria-label="Task details">
      <h2>{selected.title ?? selected.taskId}</h2><span className="uw-status">{columns.find(column => column.status === selected.status)?.label}</span>
      <p className="uw-id">{selected.taskId}</p><p>Updated <time dateTime={selected.updatedAt}>{new Date(selected.updatedAt).toLocaleString('en-GB')}</time></p>
      <h3>Linked runs</h3>{selected.runIds.length ? selected.runIds.map(id => {
        const run = projection.runs.find(item => item.runId === id)
        return <div className="wf-linked-run" key={id}><b className="uw-id">{id}</b><p>{run ? `${run.status.replaceAll('_', ' ')} · ${run.progress.summary}` : 'Run details not retained in this view.'}</p></div>
      }) : <p>No linked runs.</p>}
    </section>}
  </div>
}
