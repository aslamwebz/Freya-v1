import { useEffect, useState } from 'react'
import type { ForgeCommandOutcome, ForgeProjection, ForgeSearchReportView } from '../../../core/protocol/forge'
import { hostBridge } from '../../platform/host'

/**
 * Current Foundry: Core-owned Forge packages, not a simulated app gallery.
 * Search is LOCAL over already-known manifests. Internet research produces
 * untrusted references in Chats; owner reviews a manifest before submission.
 * The host/Core remain responsible for policy, verification and approval.
 */
export function ForgeManager() {
  const [projection, setProjection] = useState<ForgeProjection | null>(null)
  const [payload, setPayload] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<ForgeSearchReportView | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    const host = hostBridge()
    if (host?.coreForge) {
      try {
        const report = await host.coreForge()
        setProjection(report)
      } catch { setStatus('Core Forge could not be read.') }
    } else setStatus('Core Forge is not available in this window.')
  }
  useEffect(() => {
    let live = true
    let pushed = false
    const host = hostBridge()
    if (host?.coreForge) void host.coreForge().then(result => { if (live && !pushed) setProjection(result) }).catch(() => { if (live && !pushed) setStatus('Core Forge could not be read.') })
    else setStatus('Core Forge is not available in this window.')
    const detach = host?.onCoreForge?.(next => { if (live) { pushed = true; setProjection(next) } })
    return () => { live = false; detach?.() }
  }, [])

  const submit = async (command: 'forge.generate' | 'forge.validate' | 'forge.approve' | 'forge.install' | 'forge.enable' | 'forge.disable' | 'forge.search' | 'forge.remove', input: unknown): Promise<void> => {
    const host = hostBridge()
    if (!host) { setStatus('Core is disconnected; no package was changed.'); return }
    setBusy(true)
    setStatus('')
    try {
      const response = await host.coreSubmit(command, input)
      const outcome: ForgeCommandOutcome | undefined = response.forge
      if (outcome?.ok) {
        setStatus(command + ': ' + (outcome.status ?? outcome.operation) + (outcome.skillId ? ' (' + outcome.skillId + ')' : ''))
        if (command === 'forge.search') setResults(outcome.search ?? null)
        if (command === 'forge.generate') { setPayload(''); setReviewed(false) }
      } else {
        setStatus(outcome?.reason ?? response.refusal?.reason ?? 'Core refused the Forge command.')
      }
      await refresh()
    } catch { setStatus('Forge request failed. Do not assume it was applied.') }
    finally { setBusy(false) }
  }
  const candidate = () => {
    if (!reviewed) { setStatus('Review the candidate contents and confirm ownership first.'); return }
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('A manifest must be one JSON object.')
      void submit('forge.generate', parsed)
    } catch { setStatus('The candidate must be a complete JSON object. Nothing was installed.') }
  }
  const action = (command: 'forge.validate' | 'forge.approve' | 'forge.install' | 'forge.enable' | 'forge.disable' | 'forge.remove', skillId: string) => {
    // Approval is never inferred from an AI-generated manifest or a click to validate.
    if (['forge.approve', 'forge.install', 'forge.enable', 'forge.remove'].includes(command)
      && !window.confirm('Authorize ' + command + ' for ' + skillId + '? Core still enforces Guard and the validation gates.')) return
    void submit(command, { skillId, ...(command === 'forge.approve' ? { decision: 'approved' } : {}) })
  }
  return <div className="st-forge-manager">
    <h2>Foundry - Packages, tools and skills</h2>
    <p className="st-note">This is Freya's existing Forge runtime, not an unrestricted plugin installer. It accepts bounded declarative manifests; it cannot run arbitrary downloaded code or create workers with new permissions. Generate, validate, approve, install and enable are separate guarded decisions.</p>
    {projection
      ? <p className="st-note">Core: {projection.health}; {projection.counts.packages} packages; {projection.counts.enabled} enabled; persistence: {projection.persistence.mode}. {projection.runtimeNotice}</p>
      : <p role="status">Waiting for Core Forge.</p>}
    <button type="button" onClick={() => { void refresh() }} disabled={busy}>Refresh Forge catalogue</button>
    <section aria-label="Search local packages">
      <h3>Search packages already known to Freya</h3>
      <label htmlFor="forge-query">Search by name, tag or capability</label>
      <input id="forge-query" value={search} onChange={event => setSearch(event.target.value)} />
      <button type="button" onClick={() => { void submit('forge.search', { query: search, includeUnavailable: true, limit: 20 }) }} disabled={busy}>Search catalogue</button>
      {results ? <p role="status">{results.hits.length} matches from {results.considered} known packages (local only).</p> : null}
    </section>
    <section aria-label="Import reviewed manifest">
      <h3>Create or import a candidate</h3>
      <p className="st-note">Research package ideas and sources in Freya Chats; inspect third-party code and licensing before pasting a declarative manifest here. A URL or model proposal is NOT a trusted installation or permission grant.</p>
      <label htmlFor="forge-manifest">Reviewed Forge manifest (JSON)</label>
      <textarea id="forge-manifest" rows={8} value={payload} maxLength={16_000} onChange={event => { setPayload(event.target.value); setReviewed(false) }} placeholder="Paste a reviewed, declarative Forge manifest; no executable scripts." />
      <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I reviewed the manifest and understand it is submitted as owner-authored content.</label>
      <button type="button" onClick={candidate} disabled={busy || !reviewed || payload.trim().length === 0}>Submit as disabled candidate</button>
    </section>
    {status && <p role="status">{status}</p>}
    <section aria-label="Forge packages"><h3>Recorded packages</h3>
      {projection?.packages.length ? <ul>{projection.packages.map(item => <li key={item.skillId} className="uw-record">
        <strong>{item.name}</strong> - v{item.version}, {item.status}, {item.runtime}
        <p>Origin: {item.origin}; verified: {String(item.verified)}; permissions declared: {item.declaredCapabilityCount}; enabled: {String(item.enabled)}</p>
        <p>Integrity hash: <code>{item.integrityHash}</code></p>
        <div className="st-actions">
          {item.status === 'candidate' || item.status === 'generated' || item.status === 'quarantined' ? <button type="button" disabled={busy} onClick={() => action('forge.validate', item.skillId)}>Validate</button> : null}
          {item.verified && item.approval === 'pending' ? <button type="button" disabled={busy} onClick={() => action('forge.approve', item.skillId)}>Approve exact version</button> : null}
          {item.verified && !item.enabled && item.status !== 'installed' ? <button type="button" disabled={busy} onClick={() => action('forge.install', item.skillId)}>Request install</button> : null}
          {item.status === 'installed' ? <button type="button" disabled={busy} onClick={() => action('forge.enable', item.skillId)}>Request enable</button> : null}
          {item.enabled ? <button type="button" disabled={busy} onClick={() => action('forge.disable', item.skillId)}>Disable</button> : null}
        </div>
      </li>)}</ul> : <p>No Forge packages reported by Core.</p>}
    </section>
  </div>
}
