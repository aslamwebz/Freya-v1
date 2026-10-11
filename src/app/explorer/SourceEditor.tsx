import { useEffect, useState } from 'react'
import { hostBridge } from '../../platform/host'
import type { SourceRequest, SourceResult } from '../../../shared/contracts/explorer'

function Highlight({ text }: { text: string }) {
  return <pre className="fx-syntax" aria-label="Syntax preview">{text.split(/(\/\/[^\n]*|\b(?:import|export|const|let|function|return|class|async|await|if|else|throw|type|interface)\b|'[^'\n]*'|"[^"\n]*")/g).map((part, index) => <span key={index} style={{ color: part.startsWith('//') ? '#7397a7' : /^["']/.test(part) ? '#efc574' : /^(import|export|const|let|function|return|class|async|await|if|else|throw|type|interface)$/.test(part) ? '#98c9ff' : 'inherit' }}>{part}</span>)}</pre>
}
export function SourceEditor({ initialPath }: { initialPath: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [path, setPath] = useState(initialPath)
  const [content, edit] = useState('')
  const [revision, setRevision] = useState('')
  const [worktree, setWorktree] = useState('')
  const [output, setOutput] = useState('')
  const [query, search] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (request: SourceRequest): Promise<SourceResult | undefined> => {
    setBusy(true)
    try {
      const result = await hostBridge()?.coreSubmit('development.source', request)
      if (!result?.ok || !result.source) throw new Error(result?.refusal?.reason ?? result?.error?.message ?? 'Source operation unavailable')
      const data = result.source
      setWorktree(data.worktree)
      if (data.files) setFiles(data.files)
      if (data.revision) setRevision(data.revision)
      if (data.content !== undefined) { edit(data.content); setRevision(data.revision ?? '') }
      setOutput(data.output ?? 'Operation completed in development worktree.')
      return data
    } catch (error) { setOutput(error instanceof Error ? error.message : 'Source operation failed') }
    finally { setBusy(false) }
  }
  useEffect(() => { void run({ operation: 'list' }) }, [])
  useEffect(() => { if (initialPath) { setPath(initialPath); void run({ operation: 'read', path: initialPath }) } }, [initialPath])
  const open = (file: string) => { setPath(file); void run({ operation: 'read', path: file }) }
  const confirm = (message: string) => window.confirm(`${message}\nChanges apply only to the development worktree and never deploy to running components.`)
  return <section className="fx-source" aria-label="Development source editor"><h2>Development source</h2><p className="fx-provenance">{worktree || 'Core will create a dedicated development worktree.'} · Running Core, Guard and Governor are never edited here.</p><div className="fx-toolbar"><input aria-label="Source search" value={query} onChange={event => search(event.target.value)} placeholder="Search files or symbols" /><button disabled={busy} onClick={() => void run({ operation: 'search', query })}>Search symbols</button><button disabled={busy} onClick={() => void run({ operation: 'diff' })}>Preview changes and diff</button><button disabled={busy} onClick={() => confirm('Validate staged code?') && void run({ operation: 'validate' })}>Validate TypeScript</button><button disabled={busy} onClick={() => void run({ operation: 'test' })}>Test instructions</button><button disabled={busy} onClick={() => { const message = window.prompt('Commit message'); if (message && confirm('Commit staged modifications?')) void run({ operation: 'commit', message }) }}>Commit…</button></div><div className="fx-source-body"><nav aria-label="Source folders and files">{files.filter(file => file.toLowerCase().includes(query.toLowerCase())).slice(0, 500).map(file => <button key={file} onClick={() => open(file)}>{file}</button>)}</nav><div><input aria-label="Source path" value={path} onChange={event => setPath(event.target.value)} /><div className="fx-toolbar"><button disabled={busy || !path} onClick={() => open(path)}>Open</button><button disabled={busy || !revision} onClick={() => void run({ operation: 'write', path, content, revision })}>Save staged file</button><button disabled={busy || !path} onClick={() => void run({ operation: 'create', path, content }).then(() => run({ operation: 'list' }))}>Create file</button><button disabled={busy || !revision} onClick={() => { const target = window.prompt('New relative file path'); if (target && confirm('Rename this staged file?')) void run({ operation: 'rename', path, target, revision }).then(() => run({ operation: 'list' })) }}>Rename…</button><button disabled={busy || !revision} onClick={() => confirm('Delete this staged file?') && void run({ operation: 'delete', path, revision }).then(() => run({ operation: 'list' }))}>Delete…</button><button disabled={busy || !revision} onClick={() => confirm('Roll back this file to its development commit?') && void run({ operation: 'rollback', path, revision }).then(() => run({ operation: 'read', path }))}>Rollback…</button></div><textarea aria-label="Source code" spellCheck={false} value={content} onChange={event => edit(event.target.value)} /><Highlight text={content} /></div></div><pre role="status">{output}</pre><p className="fx-provenance">Protected runtime deployment requires a separate explicit owner review. No deploy operation is exposed.</p></section>
}
