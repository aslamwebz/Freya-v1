import { useEffect, useState } from 'react'
import type { ToolCatalogueView } from '../../../core/protocol/tool-catalogue'
import type { ForgeProjection } from '../../../core/protocol/forge'
import { hostBridge } from '../../platform/host'
import { ForgeManager } from '../screens/ForgeManager'

export function ToolInventory() {
  const [catalogue, setCatalogue] = useState<ToolCatalogueView | null>(null)
  const [packages, setPackages] = useState<ForgeProjection | null>(null)
  const [revision, refresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [manage, setManage] = useState(false)
  useEffect(() => {
    let live = true
    let packagesPushed = false
    setLoading(true)
    const host = hostBridge()
    const read = async () => {
      const [tools, forge] = await Promise.allSettled([host?.coreTools?.(), host?.coreForge?.()])
      if (!live) return
      setCatalogue(tools.status === 'fulfilled' ? tools.value ?? null : null)
      if (!packagesPushed) setPackages(forge.status === 'fulfilled' ? forge.value ?? null : null)
      setLoading(false)
    }
    void read()
    const detach = host?.onCoreForge?.(next => { if (live) { packagesPushed = true; setPackages(next) } })
    return () => { live = false; detach?.() }
  }, [revision])
  return <div className="wr-inventory">
    <div className="wr-catalogue-header"><div><h2>Conversation tools</h2><p className="uw-summary">Tools registered in this Core. Each action still needs permission.</p></div>
      <button type="button" disabled={loading} onClick={() => refresh(value => value + 1)}>Refresh catalogue</button></div>
    {loading ? <p role="status">Reading tool catalogue…</p> : catalogue?.health === 'ready' ? <>
      <p className="uw-source">{catalogue.tools.length} registered tools</p>
      {catalogue.tools.length ? <div className="wr-tool-grid">{catalogue.tools.map(tool => <article className="uw-record wr-tool" key={tool.name}>
        <h3>{tool.name}</h3><p>{tool.description}</p><small>Capability: {tool.capability}</small>
        {tool.parameters.length > 0 && <details><summary>Arguments</summary><dl>{tool.parameters.map(parameter => <div key={parameter.name}>
          <dt>{parameter.name}</dt><dd>{parameter.description}{parameter.required ? ' · Required' : ' · Optional'}</dd></div>)}</dl></details>}
      </article>)}</div> : <p className="uw-empty">No conversation tools registered.</p>}
    </> : <p className="uw-empty" role="status">Tool catalogue not connected. {catalogue?.reason ?? 'Core has not reported its registered tools.'}</p>}
    <section aria-label="Tool packages"><h2>Tool packages</h2>
      {packages?.health === 'ready' ? <>
        <p className="uw-summary">{packages.counts.packages} packages recorded · {packages.counts.enabled} enabled</p>
        {packages.packages.length ? <div className="wr-tool-grid">{packages.packages.map(item => <article className="uw-record wr-tool" key={item.skillId}>
          <h3>{item.name}</h3><span className="uw-status">{item.status}</span><p>Version {item.version} · {item.enabled ? 'Enabled' : 'Not enabled'} · {item.runtime}</p>
          <small>Origin: {item.origin} · {item.verified ? 'Verified' : 'Unverified'}</small>
        </article>)}</div> : <p className="uw-empty">No tool packages recorded.</p>}
      </> : <p className="uw-empty">Package catalogue not connected. {packages?.reason ?? 'Waiting for Core to report its packages.'}</p>}
    </section>
    <details className="wr-manager" onToggle={event => setManage(event.currentTarget.open)}><summary>Create or add a package</summary>
      {manage && <ForgeManager />}
    </details>
  </div>
}
