import { useEffect, useState } from 'react'
import { hostBridge } from '../../platform/host'
import type { ExplorerSnapshot } from '../../../shared/contracts/explorer'
import { Explorer } from './Explorer'
import { SourceEditor } from './SourceEditor'

export function SystemExplorer({ mode, onNavigate }: { mode: 'graph' | 'table'; onNavigate: (route: string) => void }) {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null)
  const [error, setError] = useState('')
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    let active = true, running = false
    const read = async () => {
      if (running) return
      running = true
      try {
        const result = await hostBridge()?.coreSubmit('system.explorer.read')
        if (!result?.ok || !result.explorer) throw new Error(result?.refusal?.reason ?? 'Authenticated Core connection unavailable')
        if (active) { setSnapshot(result.explorer); setError('') }
      } catch (error) { if (active) { setSnapshot(null); setError(error instanceof Error ? error.message : 'Core read failed') } }
      finally { running = false }
    }
    void read(); const timer = setInterval(() => { void read() }, 10_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  return <><div className="fx-toolbar"><button onClick={() => setSource(source === null ? '' : null)}>{source === null ? 'Development source editor' : 'Close source editor'}</button><button onClick={() => onNavigate('office/skills')}>Manage skills</button><button onClick={() => onNavigate('office/tools')}>Manage tools</button><button onClick={() => onNavigate('settings/provider')}>Model configuration</button></div>{source !== null && <SourceEditor initialPath={source} />}{error ? <p role="alert">{error}</p> : snapshot ? <Explorer snapshot={snapshot} initialMode={mode} onAction={(node, action) => { if (action === 'source') setSource(node.source); else onNavigate(action) }} /> : <p role="status">Waiting for authenticated Core inventory…</p>}</>
}
