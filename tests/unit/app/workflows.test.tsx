import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ABSENT_WORK_PROJECTION, type WorkProjection, type WorkRunView } from '../../../core/work/projection'
import { ABSENT_ATTENTION_PROJECTION, type AttentionProjection } from '../../../core/protocol/attention'
import { WorkflowsWorkspace } from '../../../src/app/workflows/WorkflowsWorkspace'
import { TaskBoard } from '../../../src/app/workflows/TaskBoard'

const stores = vi.hoisted(() => ({ work: null as WorkProjection | null, attention: null as AttentionProjection | null }))
vi.mock('../../../src/app/state/ops', () => ({ useAppOps: () => ({ work: stores.work }) }))
vi.mock('../../../src/platform/attentionClient', () => ({ attentionMirror: () => ({ projection: stores.attention, subscribe: () => () => {} }) }))
afterEach(cleanup)
beforeEach(() => { stores.work = null; stores.attention = null })

function run(runId: string, status: WorkRunView['status'], live = false): WorkRunView {
  return { runId, status, live, kind: 'deterministic', createdAt: '2026-10-10T09:00:00Z', startedAt: null, completedAt: null,
    cancelledAt: null, failure: null, waitingOn: status === 'awaiting_approval' ? 'Owner approval' : null,
    taskId: 't-in_progress', parentKind: null, parentId: null, limitHit: null,
    progress: { stepsTotal: 3, verified: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 2, actions: 1, attempts: 1, percent: null, summary: 'One verified step' },
    steps: [], actions: [], observations: [], verifications: [] }
}
function work(): WorkProjection {
  const tasks: WorkProjection['tasks'] = ['open', 'in_progress', 'blocked', 'done', 'cancelled'].map((status, index) => ({
    taskId: `t-${status}`, status: status as WorkProjection['tasks'][number]['status'], title: index ? `Task ${status}` : null,
    createdAt: '2026-10-10T08:00:00Z', updatedAt: '2026-10-10T09:00:00Z', titleLength: 0, runIds: status === 'in_progress' ? ['r-live', 'r-old'] : [],
  }))
  return { ...ABSENT_WORK_PROJECTION, health: 'ready', reason: null, tasks,
    counts: { ...ABSENT_WORK_PROJECTION.counts, tasks: 5 }, runs: [run('r-live', 'running', true)], runsHidden: 2, runsTotal: 3, runsRetained: 1 }
}

describe('Workflows task board', () => {
  it('places each actual task in its own status column and preserves missing titles', () => {
    render(<TaskBoard projection={work()} />)
    for (const [label, status] of [['To do', 'open'], ['In progress', 'in_progress'], ['Blocked', 'blocked'], ['Done', 'done'], ['Cancelled', 'cancelled']]) {
      const column = screen.getByRole('region', { name: label })
      expect(within(column).getByRole('button', { name: status === 'open' ? 't-open' : `Task ${status}` })).toBeInTheDocument()
      expect(within(column).getAllByRole('button')).toHaveLength(1)
    }
    expect(screen.getByText('Title unavailable')).toBeInTheDocument()
  })
  it('filters without changing task status and shows linked retained run details', () => {
    render(<TaskBoard projection={work()} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'in_progress' } })
    expect(screen.queryByRole('button', { name: 't-open' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 5')
    fireEvent.click(screen.getByRole('button', { name: 'Task in_progress' }))
    const details = screen.getByRole('region', { name: 'Task details' })
    expect(details).toHaveTextContent('r-live')
    expect(details).toHaveTextContent('r-old')
    expect(details).toHaveTextContent('Run details not retained')
  })
  it('updates the selected task from new projections instead of retaining stale card data', () => {
    const initial = work()
    const { rerender } = render(<TaskBoard projection={initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Task in_progress' }))
    rerender(<TaskBoard projection={{ ...initial, tasks: initial.tasks.map(task => task.taskId === 't-in_progress' ? { ...task, title: 'Updated task', status: 'blocked' } : task) }} />)
    expect(screen.getByRole('region', { name: 'Task details' })).toHaveTextContent('Updated task')
    expect(within(screen.getByRole('region', { name: 'Blocked' })).getByRole('button', { name: 'Updated task' })).toBeInTheDocument()
  })
})

describe('Workflows operational pages', () => {
  it('distinguishes unavailable task data from an empty ready board', () => {
    const { rerender } = render(<WorkflowsWorkspace section="tasks" onNavigate={vi.fn()} />)
    expect(screen.getByText('Tasks not connected.')).toBeInTheDocument()
    expect(screen.queryByText('No tasks yet.')).toBeNull()
    stores.work = { ...work(), tasks: [], counts: { ...work().counts, tasks: 0 } }
    rerender(<WorkflowsWorkspace section="tasks" onNavigate={vi.fn()} />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
  })
  it('lists every active run state and keeps executing-now separate from queued or waiting', () => {
    stores.work = { ...work(), runs: [run('executing', 'running', true), run('queued', 'queued', true), run('approval', 'awaiting_approval'), run('paused', 'paused', true), run('waiting', 'waiting'), run('finished', 'completed')] }
    render(<WorkflowsWorkspace section="running" onNavigate={vi.fn()} />)
    for (const name of ['executing', 'queued', 'approval', 'paused', 'waiting']) expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'finished' })).toBeNull()
    expect(screen.getAllByText('Executing now')).toHaveLength(1)
    expect(screen.getByText('Owner approval')).toBeInTheDocument()
  })
  it('renders real schedule metadata without registering a reminder or collecting news', () => {
    stores.attention = { ...ABSENT_ATTENTION_PROJECTION, health: 'ready', reason: null, schedules: [{
      scheduleId: 'schedule-core', kind: 'reminder', goalRef: null, dueAt: '2026-10-11T08:00:00Z', intervalMs: 86_400_000,
      maxRepeats: 5, repeats: 2, condition: 'focus-available', status: 'pending',
    }] }
    render(<WorkflowsWorkspace section="scheduling" onNavigate={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'schedule-core' })).toBeInTheDocument()
    expect(screen.getByText(/2 of 5/)).toBeInTheDocument()
    expect(screen.getByText(/focus-available/)).toBeInTheDocument()
    expect(screen.getByText(/24 hours/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start|enable|register/i })).toBeNull()
  })
  it('does not call retained run data executing now when Core is unavailable', () => {
    stores.work = work()
    render(<WorkflowsWorkspace section="running" core={{ status: 'unavailable', reason: 'Connection lost' }} onNavigate={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Last reported records · Connection lost')
    expect(screen.queryByText('Executing now')).toBeNull()
    expect(screen.getByRole('heading', { name: 'r-live' })).toBeInTheDocument()
  })
  it('distinguishes equally queued runs held by the engine from retained records', () => {
    stores.work = { ...work(), runs: [run('held-queue', 'queued', true), run('retained-queue', 'queued')] }
    render(<WorkflowsWorkspace section="running" onNavigate={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'held-queue' }).closest('article')).toHaveTextContent('Reported engine state: held')
    expect(screen.getByRole('heading', { name: 'retained-queue' }).closest('article')).toHaveTextContent('Reported engine state: not held')
    expect(screen.queryByText('Executing now')).toBeNull()
  })
  it('shows STOP ALL without labelling a held run as executing', () => {
    stores.work = work()
    render(<WorkflowsWorkspace section="running" core={{ status: 'ready', source: 'live', data: {
      lifecycle: 'running', sequence: 1, activeRequests: 0, stopped: true, operational: true, integrity: 'ok', faultCount: 0,
      persistenceDurable: true, persistenceMode: 'durable', persistenceReason: null, diagnosticsPath: null,
      diagnosticsWriteFailures: 0, faults: [], governorStatus: 'deny_all', grantsActive: 0,
    } }} onNavigate={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('STOP ALL is active.')
    expect(screen.queryByText('Executing now')).toBeNull()
    expect(screen.getByText('Reported engine state: held')).toBeInTheDocument()
  })
  it('leaves the Workflows subpage empty even when actual tasks exist', () => {
    stores.work = work()
    render(<WorkflowsWorkspace section="workflows" onNavigate={vi.fn()} />)
    expect(screen.getByText('No workflows yet.')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Task board' })).toBeNull()
  })
})
