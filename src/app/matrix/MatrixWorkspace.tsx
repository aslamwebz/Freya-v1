import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MATRIX_LIMITS, type MatrixCommandOutcome, type MatrixEntry, type MatrixEntryKind, type MatrixProjection, type MatrixSpace } from '../../../core/protocol/matrix'
import { matrixClient } from '../../platform/matrixClient'
import { ContextTabs, WorkspaceFrame } from '../screens/WorkspaceFrame'
import './matrix.css'

const sections = ['overview', 'knowledge', 'people', 'files', 'settings'] as const
const label = (section: string): string => section[0]!.toUpperCase() + section.slice(1)
const kindFor = (section: string): MatrixEntryKind | undefined => section === 'knowledge' ? 'knowledge' : section === 'people' ? 'person' : section === 'files' ? 'file' : undefined

export function MatrixWorkspace({ section = 'overview', onNavigate }: { section?: string; onNavigate: (path: string) => void }) {
  const client = matrixClient()
  const [projection, setProjection] = useState<MatrixProjection | null>(client.projection)
  const [selected, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<readonly MatrixEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [editor, setEditor] = useState<MatrixEntry | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const upload = useRef<HTMLInputElement>(null)
  const active = sections.includes(section as typeof sections[number]) ? section : 'overview'
  const space = projection?.spaces.find(item => item.id === selected)
  const kind = kindFor(active)

  useEffect(() => { const unsubscribe = client.subscribe(setProjection); void client.read(); return unsubscribe }, [client])
  useEffect(() => {
    if (!projection?.spaces.some(item => item.id === selected)) setSelected(projection?.spaces[0]?.id ?? '')
  }, [projection, selected])
  useEffect(() => { setEditor(null); setPendingDelete(null); setEntries([]) }, [selected, active])
  useEffect(() => { setQuery('') }, [selected])
  useEffect(() => {
    let live = true
    setEntries([])
    if (!selected || active === 'settings') return () => { live = false }
    setLoading(true)
    void client.readEntries(selected, { ...(kind ? { kind } : {}), ...(query ? { query } : {}) }).then(result => {
      if (!live) return
      setEntries(result.entries ?? [])
      setLoading(false)
      if (!result.ok) setNotice(result.reason ?? 'Records could not be read.')
    })
    return () => { live = false }
  }, [client, selected, active, kind, query, refresh])

  const accept = (result: MatrixCommandOutcome): boolean => {
    if (!result.ok) { setNotice(result.reason ?? 'Changes could not be saved.'); return false }
    setNotice('')
    setRefresh(value => value + 1)
    return true
  }
  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (!space) return
    setBusy(true)
    try {
      for (const file of files) {
        if (file.size > MATRIX_LIMITS.fileBytes) { setNotice(`${file.name} is larger than 1 MB. Choose a smaller file.`); break }
        const dataBase64 = await fileBase64(file)
        const isText = file.type.startsWith('text/') || /\.(txt|md|json|csv|tsv|log)$/i.test(file.name)
        const content = isText ? decodeText(dataBase64).slice(0, MATRIX_LIMITS.contentChars) : ''
        if (!accept(await client.submit('matrix.entries.create', { spaceId: space.id, kind: 'file', title: file.name, content, mimeType: file.type || (isText ? 'text/plain' : 'application/octet-stream'), dataBase64 }))) break
      }
    } catch { setNotice('This file could not be read. Select it again to retry.') }
    finally { setBusy(false); if (upload.current) upload.current.value = '' }
  }
  const download = async (entry: MatrixEntry): Promise<void> => {
    const full = await client.readEntry(entry.spaceId, entry.id)
    if (full?.dataBase64 === undefined) { setNotice('This file has no saved bytes to download.'); return }
    const bytes = Uint8Array.from(atob(full.dataBase64), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: full.mimeType ?? 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url; link.download = full.title; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return <WorkspaceFrame title="Matrix" description="Spaces for the knowledge, people and files you share with Freya." icon="memory">
    <div className="mx-workspace">
      <aside className="mx-spaces" aria-label="Matrix spaces">
        <div className="mx-space-heading"><h2>Spaces</h2><button type="button" onClick={() => { setCreating(true); setNotice('') }} disabled={!projection?.durable}>New space</button></div>
        {projection === null ? <p className="mx-muted">Loading spaces…</p> : projection.spaces.length === 0 ? <p className="mx-muted">Create a space to keep related knowledge, people and files together.</p> : <div className="mx-space-list">{projection.spaces.map(item => <button key={item.id} type="button" aria-label={`Open ${item.name}`} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setCreating(false); setNotice('') }}><span>{item.name}</span><small>{item.counts.knowledge + item.counts.person + item.counts.file} records</small></button>)}</div>}
        <p className="mx-storage">{projection?.durable ? 'Saved securely on this device' : projection?.reason ?? 'Connecting to Core…'}</p>
      </aside>
      <div className="mx-main">
        {notice && <p className="mx-notice" role="alert">{notice}</p>}
        {creating ? <SpaceForm onCancel={() => setCreating(false)} onSave={async values => {
          const result = await client.submit('matrix.spaces.create', values)
          if (!accept(result)) return false
          setSelected(result.space!.id); setCreating(false); onNavigate('matrix/overview'); return true
        }} /> : space ? <>
          <header className="mx-current"><div><h2>{space.name}</h2>{space.description && <p>{space.description}</p>}</div><button type="button" aria-label="Refresh Matrix" disabled={loading || busy} onClick={() => { void client.read().then(() => setRefresh(value => value + 1)) }}>Refresh</button></header>
          <label className="mx-search">Search this space<input type="search" aria-label="Search this space" placeholder="Search knowledge, people and files" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <ContextTabs label="Matrix sections" tabs={sections.map(id => ({ id, label: label(id) }))} selected={active} onSelect={id => onNavigate(`matrix/${id}`)}>
            {active === 'settings' ? <div className="mx-settings"><SpaceForm key={space.id} initial={space} onSave={async values => accept(await client.submit('matrix.spaces.update', { spaceId: space.id, ...values }))} />
              <div className="mx-delete-space"><h3>Delete space</h3><p>Deleting this space removes its knowledge, people and saved files, and detaches it from chats.</p>{pendingDelete === space.id ? <div className="mx-actions"><button type="button" className="mx-danger" disabled={busy} onClick={async () => { setBusy(true); try { if (accept(await client.submit('matrix.spaces.delete', { spaceId: space.id }))) setPendingDelete(null) } finally { setBusy(false) } }}>Delete this space and its records</button><button type="button" onClick={() => setPendingDelete(null)}>Cancel</button></div> : <button type="button" onClick={() => setPendingDelete(space.id)}>Delete space</button>}</div>
            </div> : <>
              {active === 'overview' && !query ? <><div className="mx-overview">{(['knowledge', 'people', 'files'] as const).map(id => <button type="button" key={id} onClick={() => onNavigate(`matrix/${id}`)}><strong>{space.counts[kindFor(id)!]}</strong><span>{label(id)}</span></button>)}</div><p className="mx-hint">Attach this space from the chat’s attachment menu to let Freya read and manage its records.</p><h3 className="mx-record-heading">In this space</h3></> : <div className="mx-record-toolbar"><p>{entries.length} {entries.length === 1 ? 'record' : 'records'}{query ? ' found' : ''}</p>{kind && <div className="mx-actions">{kind === 'file' && <button type="button" disabled={busy || !projection?.durable} onClick={() => upload.current?.click()}>Upload files</button>}<button type="button" disabled={busy || !projection?.durable} onClick={() => setEditor('new')}>{kind === 'person' ? 'Add person' : kind === 'file' ? 'Add text file' : 'Add knowledge'}</button></div>}</div>}
              <input ref={upload} type="file" multiple hidden aria-label="Upload files to this space" onChange={event => { const files = Array.from(event.target.files ?? []); void uploadFiles(files) }} />
              {editor && <EntryForm key={editor === 'new' ? `new-${kind}` : editor.id} kind={kind ?? (editor === 'new' ? 'knowledge' : editor.kind)} initial={editor === 'new' ? undefined : editor} onCancel={() => setEditor(null)} onSave={async values => {
                const entryKind = editor === 'new' ? kind! : editor.kind
                const payload = { spaceId: space.id, ...values, ...(editor === 'new' ? { kind: entryKind } : { entryId: editor.id }), ...(entryKind === 'file' && editor === 'new' ? { mimeType: 'text/plain', dataBase64: encodeText(values.content) } : {}) }
                if (!accept(await client.submit(editor === 'new' ? 'matrix.entries.create' : 'matrix.entries.update', payload))) return false
                setEditor(null); return true
              }} />}
              {loading ? <p className="mx-muted" role="status">Loading records…</p> : entries.length ? <div className="mx-records">{entries.map(entry => <article className="mx-record" key={entry.id}><div className="mx-record-type">{entry.kind === 'person' ? 'Person' : label(entry.kind)}{entry.kind === 'file' && entry.sizeBytes !== undefined ? ` · ${formatBytes(entry.sizeBytes)}` : ''}</div><h3>{entry.title}</h3>{entry.content && <p className="mx-record-content">{entry.content}</p>}<div className="mx-actions">{entry.kind === 'file' && entry.sizeBytes !== undefined && <button type="button" onClick={() => { void download(entry) }}>Download</button>}<button type="button" onClick={() => setEditor(entry)} aria-label={`Edit ${entry.title}`}>Edit</button>{pendingDelete === entry.id ? <><button type="button" className="mx-danger" disabled={busy} onClick={async () => { setBusy(true); try { if (accept(await client.submit('matrix.entries.delete', { spaceId: space.id, entryId: entry.id }))) setPendingDelete(null) } finally { setBusy(false) } }} aria-label={`Confirm delete ${entry.title}`}>Confirm delete</button><button type="button" onClick={() => setPendingDelete(null)}>Cancel</button></> : <button type="button" onClick={() => setPendingDelete(entry.id)} aria-label={`Delete ${entry.title}`}>Delete</button>}</div></article>)}</div> : <p className="mx-empty">{query ? 'No records match this search.' : active === 'overview' ? 'This space is ready. Add knowledge, people or files using the tabs above.' : `No ${active === 'people' ? 'people' : active} in this space yet.`}</p>}
            </>}
          </ContextTabs>
        </> : !creating && projection?.health !== 'ready' ? <div className="mx-empty"><h2>Matrix is unavailable</h2><p>{projection?.reason ?? 'Connecting to Freya Core…'}</p><button type="button" onClick={() => { void client.read() }}>Retry connection</button></div> : <div className="mx-empty"><h2>Your first space</h2><p>Choose New space to start collecting knowledge, people and files.</p></div>}
      </div>
    </div>
  </WorkspaceFrame>
}

function SpaceForm({ initial, onSave, onCancel }: { initial?: MatrixSpace; onSave: (values: { name: string; description: string }) => Promise<boolean>; onCancel?: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setSaved(false); try { setSaved(await onSave({ name, description })) } finally { setSaving(false) } }
  return <form className="mx-form" onSubmit={event => { void submit(event) }}><h3>{initial ? 'Space settings' : 'Create a space'}</h3><label>Space name<input required maxLength={MATRIX_LIMITS.titleChars} value={name} onChange={event => { setName(event.target.value); setSaved(false) }} autoFocus={!initial} /></label><label>Description<textarea maxLength={MATRIX_LIMITS.descriptionChars} value={description} onChange={event => { setDescription(event.target.value); setSaved(false) }} rows={3} /></label><div className="mx-actions"><button type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : initial ? 'Save space' : 'Create space'}</button>{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}{saved && <span role="status">Space saved</span>}</div></form>
}
function EntryForm({ initial, kind, onSave, onCancel }: { initial?: MatrixEntry; kind: MatrixEntryKind; onSave: (values: { title: string; content: string }) => Promise<boolean>; onCancel: () => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [saving, setSaving] = useState(false)
  return <form className="mx-form" onSubmit={event => { event.preventDefault(); setSaving(true); void onSave({ title, content }).finally(() => setSaving(false)) }}><h3>{initial ? 'Edit record' : kind === 'person' ? 'Add a person' : kind === 'file' ? 'Create a text file' : 'Add knowledge'}</h3><label>{kind === 'person' ? 'Name' : kind === 'file' ? 'Filename' : 'Title'}<input required maxLength={MATRIX_LIMITS.titleChars} value={title} onChange={event => setTitle(event.target.value)} autoFocus /></label><label>{kind === 'person' || (kind === 'file' && initial) ? 'Notes' : 'Content'}<textarea maxLength={MATRIX_LIMITS.contentChars} value={content} onChange={event => setContent(event.target.value)} rows={6} /></label><div className="mx-actions"><button type="submit" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save record'}</button><button type="button" onClick={onCancel}>Cancel</button></div></form>
}
function encodeText(text: string): string { return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')) }
function decodeText(base64: string): string { return new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0))) }
function fileBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(file) }) }
function formatBytes(bytes: number): string { return bytes < 1_000 ? `${bytes} B` : `${(bytes / 1_000).toFixed(0)} KB` }
