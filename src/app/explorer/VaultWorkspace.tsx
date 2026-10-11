import { useEffect, useRef, useState } from 'react'
import { hostBridge } from '../../platform/host'
import type { ExplorerSnapshot } from '../../../shared/contracts/explorer'
import type { OwnerNote, VaultRequest, VaultResult } from '../../../shared/contracts/vault-explorer'
import { WorkspaceFrame } from '../screens/WorkspaceFrame'
import { Explorer } from './Explorer'

export function VaultWorkspace() {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null)
  const [note, setNote] = useState<OwnerNote | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<OwnerNote['category']>('knowledge')
  const [links, setLinks] = useState('')
  const [editing, setEditing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [history, setHistory] = useState<OwnerNote[]>([])
  const [cipher, setCipher] = useState('')
  const [historyId, setHistoryId] = useState('')
  const selection = useRef(0)
  const request = async (value: VaultRequest): Promise<VaultResult> => {
    const result = await hostBridge()?.coreSubmit('vault.explorer', value)
    if (!result?.ok || !result.vault) throw new Error(result?.refusal?.reason ?? result?.error?.message ?? 'Authenticated encrypted Vault is unavailable')
    return result.vault
  }
  const reload = async () => { const data = await request({ operation: 'catalog' }); if (data.explorer) { setSnapshot(data.explorer); setCipher(data.cipherVersion) } }
  useEffect(() => {
    let active = true, running = false
    const read = async () => {
      if (running) return
      running = true
      try { const data = await request({ operation: 'catalog' }); if (active && data.explorer) { setSnapshot(data.explorer); setCipher(data.cipherVersion); setError('') } }
      catch (error) { if (active) { setSnapshot(null); setNote(null); setError(error instanceof Error ? error.message : 'Vault disconnected') } }
      finally { running = false }
    }
    void read(); const timer = setInterval(() => { void read() }, 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const act = async (run: () => Promise<void>) => { setBusy(true); setError(''); try { await run() } catch (error) { setError(error instanceof Error ? error.message : 'Vault operation failed') } finally { setBusy(false) } }
  const selectNote = async (id: string) => {
    const epoch = ++selection.current
    setNote(null); setEditing(false)
    const data = await request({ operation: 'read', id })
    if (epoch !== selection.current) return
    if (data.note) { setNote(data.note); setTitle(data.note.title); setContent(data.note.content); setCategory(data.note.category); setLinks(data.note.links.join(', ')); setHistory([]); setHistoryId(data.note.id); setEditing(false) }
  }
  const write = async (operation: VaultRequest['operation']) => {
    const data = await request({ operation, ...(note ? { id: note.id, expectedVersion: note.version } : {}), ...(operation === 'create' || operation === 'update' ? { title, content, category } : {}), ...(operation === 'relate' ? { links: links.split(',').map(id => id.trim()).filter(Boolean) } : {}) })
    if (data.note) setNote(data.note)
    else if (operation === 'delete' && note) { setNote(null); setHistoryId(note.id); setHistory((await request({ operation: 'history', id: note.id })).history ?? []) }
    setEditing(false); await reload()
  }
  const exportNotes = async () => {
    const data = await request({ operation: 'export' })
    const items = data.notes?.map(({ id, title, content, category, links }) => ({ id, title, content, category, links })) ?? []
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'freya-owner-notes-v1', items }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'freya-owner-notes.json'; link.click(); URL.revokeObjectURL(url)
  }
  return <WorkspaceFrame title="Vault" description="Encrypted knowledge and its provenance. Owner changes stay inside Freya Core." icon="memory"><div className="fx-explorer">
    <div className="fx-toolbar"><button disabled={busy || !snapshot} onClick={() => { setNote(null); setTitle(''); setContent(''); setCategory('knowledge'); setEditing(true); setImporting(false) }}>Create owner record</button><button disabled={busy || !snapshot} onClick={() => void act(exportNotes)}>Export owner records</button><button disabled={busy || !snapshot} onClick={() => { setImporting(!importing); setContent(''); setEditing(false) }}>Import owner records</button></div>
    <p className="fx-provenance">{cipher ? `SQLCipher ${cipher} · authenticated Core · encrypted at rest` : 'Waiting for encrypted storage evidence'}</p>{error && <p role="alert">{error}</p>}
    {importing && <section className="fx-source"><h2>Import owner assertions</h2><p>Paste a Freya owner-note export. Records receive new ids, unverified provenance and version 1.</p><textarea aria-label="Import JSON" value={content} onChange={event => setContent(event.target.value)} /><button disabled={busy} onClick={() => void act(async () => { const parsed = JSON.parse(content); if (parsed.format !== 'freya-owner-notes-v1') throw new Error('Unsupported import format'); await request({ operation: 'import', items: parsed.items }); setImporting(false); await reload() })}>Import into encrypted Vault</button></section>}
    {editing && <form className="fx-source" aria-label="Owner record editor" onSubmit={event => { event.preventDefault(); void act(() => write(note ? 'update' : 'create')) }}><h2>{note ? 'Edit owner record' : 'Create owner record'}</h2><label>Title<input aria-label="Record title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Category<select aria-label="Record category" value={category} onChange={event => setCategory(event.target.value as OwnerNote['category'])}><option value="knowledge">Knowledge</option><option value="memory">Memory</option><option value="artifact">Artifact</option></select></label><textarea aria-label="Record content" maxLength={16000} value={content} onChange={event => setContent(event.target.value)} /><button disabled={busy}>Save encrypted record</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></form>}
    {note && !editing && <section className="fx-source" aria-label="Selected owner record"><h2>{note.title}</h2><p>Owner assertion · unverified · {note.status} · Version {note.version}</p><p className="fx-note-content">{note.content}</p><p className="fx-provenance">Created {note.createdAt} · Updated {note.updatedAt} · {note.id}</p><div className="fx-toolbar"><button disabled={busy} onClick={() => { setTitle(note.title); setContent(note.content); setCategory(note.category); setEditing(true) }}>Edit record</button><button disabled={busy} onClick={() => void act(() => write(note.status === 'archived' ? 'restore' : 'archive'))}>{note.status === 'archived' ? 'Restore record' : 'Archive record'}</button><button disabled={busy} onClick={() => window.confirm('Delete this owner record? Encrypted revision history is retained with a deletion record.') && void act(() => write('delete'))}>Delete record…</button><button disabled={busy} onClick={() => void act(async () => { const data = await request({ operation: 'history', id: note.id }); setHistory(data.history ?? []) })}>Version history</button></div><label>Linked owner record ids<input aria-label="Linked record ids" value={links} onChange={event => setLinks(event.target.value)} /></label><button disabled={busy} onClick={() => void act(() => write('relate'))}>Save relationships</button></section>}
    <section className="fx-source" aria-label="Retained revision history"><label>Record history id<input aria-label="Record history id" maxLength={128} value={historyId} onChange={event => setHistoryId(event.target.value)} /></label><button disabled={busy || !historyId} onClick={() => void act(async () => setHistory((await request({ operation: 'history', id: historyId })).history ?? []))}>Read retained history</button>{history.map(item => <details key={item.version}><summary>Version {item.version} · {item.updatedAt} · {item.status}</summary><p>{item.content}</p></details>)}</section>
    {snapshot ? <Explorer snapshot={snapshot} onSelectNode={node => { if (busy) return; if (node.id.startsWith('note:')) void act(() => selectNote(node.id.slice(5))); else { selection.current++; setNote(null); setEditing(false) } }} onAction={node => { if (node.id.startsWith('note:')) void act(() => selectNote(node.id.slice(5))) }} /> : <p role="status">{error || 'Waiting for authenticated Vault records…'}</p>}
    </div></WorkspaceFrame>
}
