import { useEffect, useState } from 'react'
import { Badge, Button, Field, Panel } from '../primitives/Controls'
import { hostBridge } from '../../platform/host'
import { readModelCatalog } from '../../platform/modelClient'
import type { ProviderView, Resource } from '../state/contract'
import type { WorkspaceProps } from './shared'

/**
 * Settings — the provider section.
 *
 * The key field is write-only. It starts empty every time the workspace opens, the
 * stored credential is represented only by a `••••` placeholder, and a save sends a
 * key only when one was actually typed. Nothing here reads the key back, because the
 * bridge has no field to return it in; the display is always a masked status.
 *
 * The form is seeded once from the snapshot, then owned locally. A live provider read
 * lands after mount, so the seed is deliberately a one-way fill rather than a
 * controlled mirror that would overwrite what the owner is typing. Saving re-reads
 * through the bridge and refreshes the status line from the authoritative answer.
 */

interface ProviderForm {
  baseUrl: string
  model: string
  apiKey: string
  liveEnabled: boolean
}

function providerData(resource: Resource<ProviderView>): ProviderView | null {
  return resource.status === 'ready' || resource.status === 'stale' ? resource.data : null
}

function formOf(data: { baseUrl: string; model: string; liveEnabled: boolean } | null): ProviderForm {
  return {
    baseUrl: data?.baseUrl ?? '',
    model: data?.model ?? '',
    apiKey: '',
    liveEnabled: data?.liveEnabled ?? false,
  }
}

function statusTone(detail: string): 'positive' | 'attention' | 'neutral' {
  if (detail === 'connected') return 'positive'
  if (detail === 'live-disabled') return 'attention'
  return 'neutral'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'an unknown error'
}

export function Settings({ snapshot }: WorkspaceProps) {
  const resource = snapshot.provider
  const data = providerData(resource)
  const [form, setForm] = useState<ProviderForm>(() => formOf(data))
  const [seeded, setSeeded] = useState(data !== null)
  const [notice, setNotice] = useState('')
  const [testResult, setTestResult] = useState('')
  const [busy, setBusy] = useState(false)

  // A live provider read can arrive after the first render. Fill the form once, and
  // never again: a later snapshot must not clobber an edit in progress.
  useEffect(() => {
    if (seeded || data === null) return
    setForm(formOf(data))
    setSeeded(true)
  }, [data, seeded])

  const status = data?.detail ?? (resource.status === 'unavailable' || resource.status === 'error' ? resource.reason : 'loading')

  const save = async (): Promise<void> => {
    const bridge = hostBridge()
    if (!bridge) {
      setNotice('This window cannot reach the host, so nothing was saved.')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      await bridge.saveProviderConfig({
        baseUrl: form.baseUrl,
        model: form.model,
        liveEnabled: form.liveEnabled,
        // Only a typed key is sent. An empty field means "leave the stored key
        // alone", never "clear it" — a save that silently erased the credential
        // would be the exact surprise this form must not cause.
        ...(form.apiKey.length > 0 ? { apiKey: form.apiKey } : {}),
      })
      const refreshed = await bridge.providerConfig()
      setForm((current) => ({ ...current, ...formOf(refreshed), apiKey: '' }))
      setSeeded(true)
      setNotice('Provider settings saved. Core is rebuilding with the new configuration.')
    } catch (error) {
      setNotice(`Provider settings were not saved: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async (): Promise<void> => {
    setBusy(true)
    setTestResult('')
    const outcome = await readModelCatalog()
    if (outcome.operation === 'catalog' && outcome.models) {
      const ids = outcome.models.map((model) => model.id)
      const rows = ids.slice(0, 6).join(', ')
      setTestResult(`Connected. ${ids.length} model${ids.length === 1 ? '' : 's'} available${rows.length > 0 ? `: ${rows}` : ''}`)
    } else {
      setTestResult(outcome.reason ?? 'The provider did not return a model catalogue.')
    }
    setBusy(false)
  }

  return (
    <div className="f-settings">
      <Panel title="Provider" icon="settings" meta={<Badge tone={statusTone(status)}>{status}</Badge>}>
        <p className="f-muted">
          Freya reaches nano-gpt for live inference. The API key is write-only: it is
          stored by the OS keychain and is never shown again.
        </p>
        <Field
          label="Base URL"
          value={form.baseUrl}
          placeholder="https://nano-gpt.com/api/v1"
          onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
        />
        <Field
          label="Model"
          value={form.model}
          placeholder="openai/gpt-4.1-nano"
          onChange={(event) => setForm({ ...form, model: event.target.value })}
        />
        <Field
          label="API key"
          type="password"
          value={form.apiKey}
          placeholder={data?.hasKey ? '••••' : 'No key saved'}
          autoComplete="off"
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
        <label className="f-check">
          <input
            type="checkbox"
            checked={form.liveEnabled}
            onChange={(event) => setForm({ ...form, liveEnabled: event.target.checked })}
          />
          Allow live inference
        </label>
        <div className="f-settings-actions">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>Save provider</Button>
          <Button disabled={busy} onClick={() => void testConnection()}>Test connection</Button>
        </div>
        {notice && <p role="status" className="f-composer-status">{notice}</p>}
        {testResult && <p role="status" className="f-muted">{testResult}</p>}
      </Panel>
    </div>
  )
}
