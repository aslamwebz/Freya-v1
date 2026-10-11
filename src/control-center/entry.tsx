import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ControlCenterSnapshot } from '../../shared/contracts/control-center'
import type { ComponentName } from '../../shared/contracts/runtime'
import './style.css'

interface CenterBridge {
  read(): Promise<ControlCenterSnapshot>
  open(route: string): Promise<void>
  restart(component: ComponentName): Promise<string>
  stopAll(): Promise<unknown>
}
declare global { interface Window { freyaCenter?: CenterBridge } }
export function ControlCenter() {
  const [snapshot, setSnapshot] = useState<ControlCenterSnapshot | null>(null)
  const [error, setError] = useState('')
  const [selected, select] = useState<ComponentName>('core')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true, running = false
    const read = async () => {
      if (running) return
      running = true
      try {
        if (!window.freyaCenter) throw new Error('Desktop host unavailable')
        const next = await window.freyaCenter.read()
        if (active) { setSnapshot(next); setError('') }
      } catch { if (active) { setSnapshot(null); setError('Runtime connection lost. Use the CMD launcher to reconnect.') } }
      finally { running = false }
    }
    void read(); const timer = setInterval(() => { void read() }, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const observations = snapshot?.observations ?? []
  const connected = observations.length === 3 && observations.every(item => item.health && ['healthy', 'degraded'].includes(item.state))
  const detail = observations.find(item => item.component === selected)
  const action = async (run: () => Promise<unknown>) => { setBusy(true); try { await run() } catch { setError('Operation failed. Inspect the CMD console for runtime diagnostics.') } finally { setBusy(false) } }
  return <main className="cc" data-startup={connected ? 'connected' : 'waiting'}>
    <header><div className="cc-orb" aria-hidden="true"><i /><i /><b /></div><div><small>FREYA · DESKTOP</small><h1>{connected ? 'Control Center' : 'Connecting Freya'}</h1><p>{connected ? 'Your intelligence environment, as it reports itself.' : 'Waiting for authenticated process health. Open a component for diagnostics.'}</p></div></header>
    <nav aria-label="Open workspace">{[['home', 'Dashboard'], ['mind/system', 'Freya Explorer'], ['vault', 'Vault'], ['settings', 'Settings'], ['chat', 'Mini Chat']].map(([route, label]) => <button key={route} onClick={() => void window.freyaCenter?.open(route!)}>{label}</button>)}</nav>
    <p className="cc-profile">Profile · {snapshot?.profile ?? 'Waiting for host'}</p>
    {error && <p role="alert">{error}</p>}
    <section className="cc-processes" aria-label="Runtime components">{(['core', 'freya', 'superapp'] as ComponentName[]).map(component => {
      const observation = observations.find(item => item.component === component)
      return <button className="cc-panel" key={component} data-state={observation?.state ?? 'unavailable'} aria-pressed={selected === component} onClick={() => select(component)}><small>{component === 'freya' ? 'INTELLIGENCE' : 'RUNTIME'}</small><h2>{component === 'core' ? 'Freya Core' : component === 'freya' ? 'Freya' : 'Superapp'}</h2><b className="cc-state">{observation?.state ?? 'Awaiting response'}</b><p>PID {observation?.pid ?? '—'}</p><small>{observation?.source ?? 'runtime.health'}<br />Last successful update · {observation?.lastSuccessAt ? new Date(observation.lastSuccessAt).toLocaleTimeString('en-GB') : 'None'}</small></button>
    })}</section>
    <section className="cc-panel cc-detail"><h2>{selected} diagnostics</h2><p>{detail?.detail ?? 'No health response received.'}</p><dl><dt>Heartbeat</dt><dd>{detail?.health?.lastProgressAt ?? 'Missing'}</dd><dt>Instance</dt><dd>{detail?.health?.instanceId ?? 'Unavailable'}</dd></dl>{Object.entries(detail?.health?.dependencies ?? {}).map(([name, dependency]) => <p key={name}>{name} · {dependency.state} · {dependency.checkedAt}</p>)}<button disabled={busy} onClick={() => void action(() => window.freyaCenter!.restart(selected))}>Restart {selected}…</button></section>
    <footer><span>Health is reported by the processes. Missing responses clear previous success.</span><button className="cc-stop" disabled={busy} onClick={() => void action(() => window.freyaCenter!.stopAll())}>STOP ALL</button></footer>
  </main>
}
createRoot(document.getElementById('root')!).render(<ControlCenter />)
