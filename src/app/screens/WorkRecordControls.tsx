import { useEffect, useState } from 'react'
import type { CoreCommandName } from '../../../core/protocol/core-protocol'
import { hostBridge } from '../../platform/host'

interface RecordRow {
  id: string
  state: string
  actions: readonly string[]
  verified: number
  needsAttention: boolean
}
interface RecordsView {
  rows: RecordRow[]
  total: number
  mode: string
  durable: boolean
}

/** Reads metadata broadly and private text only when the owner opens one record. */
export function WorkRecordControls({ kind }: { kind: 'goal' | 'mission' }) {
  const label = kind === 'goal' ? 'Goal' : 'Mission'
  const [view, setView] = useState<RecordsView | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ id: string; title: string; description: string; criteria: readonly string[] } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function reload() {
    const host = hostBridge()
    if (!host) throw new Error('Core is not connected.')
    if (kind === 'goal') {
      const projection = await host.coreGoals()
      if (!projection) throw new Error('Core is not reporting Goals.')
      setView({ total: projection.goalsTotal, ...projection.persistence, rows: projection.goals.map(goal => ({ id: goal.goalId, state: goal.state, actions: goal.availableActions, verified: goal.counts.verified, needsAttention: goal.needsAttention })) })
    } else {
      const projection = await host.coreMission()
      if (!projection) throw new Error('Core is not reporting Missions.')
      setView({ total: projection.missionsTotal, ...projection.persistence, rows: projection.missions.map(mission => ({ id: mission.missionId, state: mission.status, actions: mission.availableActions, verified: mission.counts.completed, needsAttention: mission.needsAttention })) })
    }
  }

  async function perform(operation: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try { await operation() } catch (error) { setMessage(error instanceof Error ? error.message : `Core ${label} request failed.`) }
    finally { setBusy(false) }
  }
  useEffect(() => { void perform(reload) }, [kind])

  async function submit(action: string, payload: unknown) {
    const host = hostBridge()
    if (!host) throw new Error('Core is not connected.')
    const result = await host.coreSubmit(`${kind}.${action}` as CoreCommandName, payload)
    const outcome = kind === 'goal' ? result.goal : result.mission
    if (!result.ok || !outcome?.ok) throw new Error(outcome?.reason ?? result.refusal?.reason ?? result.error?.message ?? 'Core returned no record result.')
    return result
  }

  function resetForm() { setTitle(''); setDescription(''); setCriteria(''); setEditing(null) }
  async function save() {
    const lines = criteria.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const payload = kind === 'goal'
      ? { title, description, completionCriteria: lines, ...(editing ? { goalId: editing } : {}) }
      : { title, intent: description, successCriteria: lines, ...(editing ? { missionId: editing } : {}) }
    await submit(editing ? 'update' : 'create', payload)
    setMessage(`${label} ${editing ? 'saved' : 'created'} in Core.`)
    resetForm()
    setDetail(null)
    await reload()
  }
  async function openRecord(id: string, edit: boolean) {
    const result = await submit('read', kind === 'goal' ? { goalId: id } : { missionId: id })
    const content = kind === 'goal' ? result.goal?.detail?.content : result.mission?.detail?.content
    if (!content) throw new Error('Private record content is unavailable.')
    const text = 'description' in content ? content.description : content.intent
    const lines = 'completionCriteria' in content ? content.completionCriteria : content.successCriteria
    setDetail({ id, title: content.title, description: text, criteria: lines })
    if (edit) { setEditing(id); setTitle(content.title); setDescription(text); setCriteria(lines.join('\n')) }
  }
  return <div className={`uw-${kind}s`} aria-label={`Core ${label}s`}>
    <p className="uw-summary">{kind === 'goal' ? 'Long-term Goals stay in Core' : 'Missions stay in Core'}; only state, counts, dates and IDs are shared with the window. Content is private until you open a record.</p>
    <form onSubmit={event => { event.preventDefault(); void perform(save) }}>
      <label>{label} title<input aria-label={`${label} title`} value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <label>{label} {kind === 'goal' ? 'description' : 'intent'}<textarea aria-label={`${label} ${kind === 'goal' ? 'description' : 'intent'}`} value={description} onChange={event => setDescription(event.target.value)} required /></label>
      <label>Criteria (one per line)<textarea aria-label={`${label} criteria`} value={criteria} onChange={event => setCriteria(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{editing ? `Save ${label}` : `Create ${label}`}</button>
      {editing ? <button type="button" onClick={resetForm}>Cancel edit</button> : null}
    </form>
    <button type="button" onClick={() => { void perform(reload) }} disabled={busy}>Refresh {label} records</button>
    {message ? <p role="status">{message}</p> : null}
    {view ? <><p className="uw-summary">{view.total} {label}s reported; storage: {view.mode}{view.durable ? ' (durable)' : ' (not confirmed durable)'}.</p>
      {view.rows.length ? <div className="uw-records">{view.rows.map(row => <article key={row.id} className="uw-record">
        <h2>{label} {row.id}</h2><span className="uw-status">{row.state}</span>
        <p>{row.verified} {kind === 'goal' ? 'verified checkpoint(s)' : 'completed child run(s)'} reported. {row.needsAttention ? 'Needs attention.' : ''}</p>
        <button type="button" disabled={busy} onClick={() => { void perform(() => openRecord(row.id, false)) }}>Open {label}</button>
        {row.state === 'draft' ? <button type="button" disabled={busy} onClick={() => { void perform(() => openRecord(row.id, true)) }}>Edit {label}</button> : null}
        {row.actions.filter(action => ['activate', 'pause', 'resume', 'cancel', 'requestCompletion'].includes(action)).map(action => <button key={action} type="button" disabled={busy} onClick={() => { void perform(async () => {
          await submit(action, kind === 'goal' ? { goalId: row.id } : { missionId: row.id })
          setMessage(`${label} command accepted by Core.`)
          await reload()
        }) }}>{action === 'requestCompletion' ? 'Verify completion' : `${action.charAt(0).toUpperCase()}${action.slice(1)}`}</button>)}
        {['draft', 'completed', 'failed', 'cancelled'].includes(row.state) ? <button type="button" disabled={busy} onClick={() => setDeleting(row.id)}>Delete {label}</button> : null}
        {deleting === row.id ? <div role="group" aria-label={`Confirm delete ${label}`}><p>Delete this record and its private content?</p><button type="button" disabled={busy} onClick={() => { void perform(async () => {
          await submit('delete', kind === 'goal' ? { goalId: row.id } : { missionId: row.id })
          setDeleting(null); setDetail(null); if (editing === row.id) resetForm(); setMessage(`${label} deleted from Core.`); await reload()
        }) }}>Confirm delete</button><button type="button" onClick={() => setDeleting(null)}>Keep record</button></div> : null}
      </article>)}</div> : <p className="uw-empty">No {label}s reported by Core.</p>}</> : <p className="uw-empty">Waiting for {label} metadata.</p>}
    {detail ? <article aria-label={`${label} details`}><h2>{detail.title}</h2><p>{detail.description}</p><ul>{detail.criteria.map((line, index) => <li key={index}>{line}</li>)}</ul><button type="button" onClick={() => setDetail(null)}>Close details</button></article> : null}
  </div>
}
