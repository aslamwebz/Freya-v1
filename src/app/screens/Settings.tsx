import { buildCapabilityRegistry, CAPABILITY_IDS, describeCapability, describeProvider, PROVIDER_IDS, type CapabilityId, type CapabilityRegistry } from '../../../core/capabilities'
import { useEffect, useState } from 'react'
import { Card, Chip, Row } from '../cards/Card'
import { VoiceSettings } from '../voice/VoiceSettings'
import { VoicePreferences } from '../voice/VoicePreferences'
import type { VoiceDock } from '../voice/useVoiceDock'
import { hostBridge } from '../../platform/host'
import { coreMirror } from '../../platform/coreClient'
import { THEMES, type ThemeId } from '../../ui-v2/theme/tokens'
import type { PreferencesStore } from '../../ui-v2/theme/preferences'
import type { CoreView, ProviderView, Resource } from '../../ui-v2/state/contract'
import { ready, reason } from '../state/view'

/*
 * Settings — the real controls, in the same visual language as every other screen.
 *
 * This screen used to be a row of hardcoded claims: `Gmail Connected`,
 * `Reasoning engine Configured`, `Journal Encrypted`, `Memory Durable`,
 * `Window observation: Ask each time`. None of it was read from anywhere, and four
 * of those five were false — the Relay connectors are never supplied by the host and
 * report `unavailable`, journal encryption and memory durability are per-domain and
 * can each be absent, and window observation is a launch-time environment variable
 * that has never been a user choice. A settings screen that asserts things Freya
 * cannot do is worse than none, because it is believed.
 */

export type SettingsCategory = 'appearance' | 'provider' | 'voice' | 'privacy' | 'security' | 'about'

export interface SettingsProps {
  /** The live snapshot, typed by the same contract every other surface reads. */
  readonly snapshot: {
    readonly provider: Resource<ProviderView>
    readonly core: Resource<CoreView>
  }
  readonly voiceControls?: VoiceDock
  readonly preferences: PreferencesStore
  /** Owned by the caller, because a screen function cannot hold a hook. */
  readonly category: SettingsCategory
  readonly onCategory: (category: SettingsCategory) => void
}

const CATEGORIES: readonly (readonly [SettingsCategory, string, string])[] = [
  ['appearance', 'Appearance', 'focus'],
  ['provider', 'Provider', 'core'],
  ['voice', 'Voice', 'mic'],
  ['privacy', 'Privacy', 'settings'],
  ['security', 'Security', 'settings'],
  ['about', 'About', 'world'],
]

/** The swatch colour per real theme id, so a swatch is the theme it selects. */
const THEME_SWATCH: Record<ThemeId, string> = {
  abyss: '#6fdcff',
  dawn: '#0a6d86',
  vessel: '#7fe3c4',
  violet: '#b79cf0',
}

interface ProviderForm {
  baseUrl: string
  model: string
  liveEnabled: boolean
  apiKey: string
}

/**
 * Seed the form from whatever provider view is at hand.
 *
 * Typed on the three editable fields rather than on a whole view, because the form
 * is seeded from two shapes: the live adapter's derived `ProviderView` on first read,
 * and the host's raw `ProviderConfigView` after a save. Both carry these three.
 */
type ProviderFormSource = Pick<ProviderView, 'baseUrl' | 'model' | 'liveEnabled'>

function formOf(data: ProviderFormSource): ProviderForm {
  return { baseUrl: data.baseUrl, model: data.model, liveEnabled: data.liveEnabled, apiKey: '' }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // A bridge rejection arrives as `Error: Error: <reason>`; the inner sentence is
    // the one Core or the host wrote and the only one worth showing.
    return error.message.replace(/^Error:\s*/, '')
  }
  return 'the reason was not reported'
}

/**
 * Settings — a full overlay over the board, after the reference chat's frame:
 * a header with the one way out (Done), the categories down the side, and one
 * category at a time. It replaced a three-column arrangement whose middle was
 * a portrait preview — a screen and a half of scrolling to find one control.
 *
 * Every value still comes from one of three places and nowhere else:
 *
 *   - `snapshot.provider` — the host's masked provider view, including *why* a
 *     credential is in the state it is in;
 *   - `snapshot.core` — what Core reports about itself: lifecycle, journal
 *     integrity, stop latch, recorded faults;
 *   - the preferences store — the appearance settings App Mode actually reads.
 *
 * Where the backend cannot supply a value, the row says so. There is no third
 * option, and no default that looks like a fact.
 *
 * The provider form reuses the proven `?ui=v2` semantics rather than a second
 * set: a key is sent only when typed, an empty field leaves the stored key
 * alone, and forgetting one is its own explicit action.
 */
export function SettingsOverlay({ snapshot, preferences, voiceControls, category, onCategory, onDone }: SettingsProps & { readonly onDone: () => void }) {
  return (
    <div className="st-overlay" role="dialog" aria-label="Settings">
      <header className="st-top">
        <h2>Settings</h2>
        <button type="button" className="st-done" onClick={onDone}>Done</button>
      </header>
      <div className="st-layout">
        <nav className="st-nav" aria-label="Settings categories">
          {CATEGORIES.map(([id, label]) => (
            <button key={id} type="button" className="st-tab" data-active={category === id}
              aria-current={category === id ? 'true' : undefined} onClick={() => onCategory(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="st-content">
          <section className="st-pane" hidden={category !== 'appearance'}><AppearanceCard preferences={preferences} /></section>
          <section className="st-pane" hidden={category !== 'provider'}><ProviderCard snapshot={snapshot} /></section>
          <section className="st-pane" hidden={category !== 'voice'}><Card title="Voice" icon="core" subtitle="Talk to Freya"><VoicePreferences />{voiceControls ? <VoiceSettings voice={voiceControls} expanded /> : null}</Card></section>
          <section className="st-pane" hidden={category !== 'privacy'}><PrivacyCard /></section>
          <section className="st-pane" hidden={category !== 'security'}><SecurityCard snapshot={snapshot} /></section>
          <section className="st-pane" hidden={category !== 'about'}><AboutCard snapshot={snapshot} /></section>
        </div>
      </div>
    </div>
  )
}

function AppearanceCard({ preferences }: { preferences: PreferencesStore }) {
  const current = preferences.getSnapshot()
  return (
    <Card title="Appearance" icon="focus" subtitle="Look and feel">
      <div className="st-themes">
        {THEMES.map((id) => (
          <button key={id} type="button" className="st-theme" data-active={current.theme === id}
            aria-pressed={current.theme === id} onClick={() => preferences.update({ theme: id })}>
            <span className="st-swatch" style={{ background: THEME_SWATCH[id] }} />
            <span>{id}</span>
          </button>
        ))}
      </div>
      <div className="c-rows">
        <Row title="Text size" detail="Applied to this shell"
          end={
            <span className="st-actions">
              {[1, 1.125, 1.25].map((scale) => (
                <button key={scale} type="button" className="st-mini" aria-pressed={current.textScale === scale}
                  onClick={() => preferences.update({ textScale: scale as 1 | 1.125 | 1.25 })}>
                  {Math.round(scale * 100)}%
                </button>
              ))}
            </span>
          } />
        {/*
          Density, backdrop and reduced effects are deliberately absent. They exist in
          the preferences store but no App Mode surface reads them, so a control here
          would change nothing while appearing to. They appear once something
          consumes them — not before.
        */}
        <Row title="Reduced effects" detail="Follows the operating system"
          end={<Chip tone="accent">{current.reducedEffects ? 'On' : 'System'}</Chip>} />
      </div>
    </Card>
  )
}

function ProviderCard({ snapshot }: { snapshot: SettingsProps['snapshot'] }) {
  const provider = ready(snapshot.provider)
  const [form, setForm] = useState<ProviderForm | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * Seed the form once, when the live read arrives.
   *
   * Seeded exactly once — the `form === null` guard is the whole mechanism. Re-seeding
   * on every snapshot would overwrite whatever the person was in the middle of typing
   * each time a status push landed.
   */
  useEffect(() => {
    if (form !== null || provider === null) return
    setForm(formOf(provider))
  }, [form, provider])

  const bridge = hostBridge()

  const save = async (patch: Partial<ProviderForm>): Promise<void> => {
    if (bridge === undefined) {
      setNotice('This window cannot reach the host, so nothing was saved.')
      return
    }
    const base = form ?? (provider === null ? null : formOf(provider))
    if (base === null) {
      setNotice('The provider configuration has not been read yet.')
      return
    }
    const next = { ...base, ...patch }
    setBusy(true)
    setNotice('')
    try {
      await bridge.saveProviderConfig({
        baseUrl: next.baseUrl,
        model: next.model,
        liveEnabled: next.liveEnabled,
        // Only a typed key is sent. An empty field means "leave the stored key
        // alone" — forgetting one is its own explicit action below, because a save
        // that silently erased a credential would be the worst possible surprise.
        ...(next.apiKey.length > 0 ? { apiKey: next.apiKey } : {}),
      })
      const refreshed = await bridge.providerConfig()
      setForm({ ...next, ...formOf(refreshed), apiKey: '' })
      setNotice('Provider settings saved. Freya is restarting with the new configuration.')
    } catch (error) {
      // The host distinguishes "not saved" from "saved but the restart failed", and
      // both sentences arrive here intact. Nothing is rewritten or softened.
      setNotice(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Forget the stored credential.
   *
   * `apiKey: ''` is the canonical way to remove it, and the store honours it even
   * when secure storage is currently unavailable — so this works in exactly the case
   * where somebody most needs it. An ordinary save never sends an empty key, for the
   * same reason.
   */
  const forgetKey = async (): Promise<void> => {
    if (bridge === undefined) {
      setNotice('This window cannot reach the host, so nothing was changed.')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      await bridge.saveProviderConfig({ apiKey: '' })
      const refreshed = await bridge.providerConfig()
      setForm((current) => (current === null ? null : { ...current, ...formOf(refreshed) }))
      setNotice('The stored API key was removed from this machine.')
    } catch (error) {
      setNotice(`The stored key was not removed: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (provider === null) {
    return (
      <Card title="Provider" icon="core" subtitle="Models and engines">
        <div className="c-rows">
          <Row title="Provider" detail={reason(snapshot.provider)} />
        </div>
      </Card>
    )
  }

  const credential =
    provider.credentialState === 'stored'
      ? 'Stored, wrapped by this machine'
      : provider.credentialState === 'storage-unavailable'
        ? provider.credentialReason ?? 'This machine cannot protect a key'
        : provider.credentialState === 'unreadable'
          ? provider.credentialReason ?? 'Stored but unreadable here'
          : 'Not configured'

  const edit = (patch: Partial<ProviderForm>): void =>
    setForm({ baseUrl: provider.baseUrl, model: provider.model, liveEnabled: provider.liveEnabled, apiKey: '', ...patch })

  return (
    <Card title="Provider" icon="core" subtitle="Models and engines">
      <div className="c-rows">
        <Row title="Status" detail={provider.detail}
          end={<Chip tone={provider.connected ? 'accent' : undefined}>
            {provider.connected ? (provider.liveEnabled ? 'Live' : 'Configured') : 'Not live'}
          </Chip>} />
        {/*
          A refused endpoint is reported as its own state. The key exists and would
          be sent somewhere it must not go, which is not the same situation as "no key
          configured" and needs a different remedy.
        */}
        {!provider.endpointApproved && provider.baseUrl.length > 0 && (
          <Row title="Endpoint"
            detail={`${provider.baseUrl} is not an approved Freya provider host. Freya will not send a key there.`} />
        )}
        <Row title="API key" detail={credential} />
      </div>
      <div className="st-form">
        <label className="st-field">
          <span>Base URL</span>
          <input value={form?.baseUrl ?? provider.baseUrl} spellCheck={false}
            placeholder="https://nano-gpt.com/api/v1"
            onChange={(event) => edit({ baseUrl: event.target.value })} />
        </label>
        <label className="st-field">
          <span>Model</span>
          <input value={form?.model ?? provider.model} spellCheck={false}
            placeholder="openai/gpt-4.1-nano"
            onChange={(event) => edit({ model: event.target.value })} />
        </label>
        <label className="st-field">
          <span>API key</span>
          <input type="password" autoComplete="off" value={form?.apiKey ?? ''}
            placeholder={provider.hasKey ? 'Stored — type to replace' : 'Not stored'}
            onChange={(event) => edit({ apiKey: event.target.value })} />
        </label>
        <label className="st-check">
          <input type="checkbox" checked={form?.liveEnabled ?? provider.liveEnabled}
            onChange={(event) => edit({ liveEnabled: event.target.checked })} />
          <span>Allow Freya to spend on live inference</span>
        </label>
        <div className="st-actions">
          <button type="button" className="st-save" disabled={busy}
            onClick={() => { void save({}) }}>Save</button>
          {provider.hasKey && (
            <button type="button" className="st-forget" disabled={busy}
              onClick={() => { void forgetKey() }}>Forget stored key</button>
          )}
        </div>
        {/*
          The live-enable flag is presented as what it is: a separate, deliberate
          decision to spend, not a consequence of having a key.
        */}
        <p className="st-note">Live inference needs both a stored key and this switch. Either alone spends nothing.</p>
      </div>
      <CapabilityPanel />
      {notice.length > 0 && <p className="st-notice" role="status">{notice}</p>}
    </Card>
  )
}

/** Host-backed capability preferences: a successful write affects the next request. */
export function CapabilityPanel() {
  const [registry, setRegistry] = useState<CapabilityRegistry>(buildCapabilityRegistry)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let live = true
    const host = hostBridge()
    if (!host) { setNotice('Capability settings require the desktop host.'); return }
    void host.getCapabilitySettings().then((next) => { if (live) setRegistry(next) }).catch(() => { if (live) setNotice('Capability settings could not be read.') })
    return () => { live = false }
  }, [])
  const save = async (capability: CapabilityId, providers: CapabilityRegistry[CapabilityId]['providers']) => {
    const host = hostBridge()
    if (!host || busy) return
    setBusy(true); setNotice('')
    try { setRegistry(await host.setCapabilitySettings({ [capability]: providers })); setNotice('Preference saved. It applies to the next request.') }
    catch { setNotice('Preference was not saved. The host refused or could not persist it.') }
    finally { setBusy(false) }
  }
  return (
    <div className="st-capabilities">
      <header><b>Capabilities</b><small>Web search defaults to SearXNG. Readiness means an adapter is configured; it does not guarantee network availability.</small></header>
      <ul>{CAPABILITY_IDS.map((capability) => {
        const selection = registry[capability]
        const description = describeCapability(capability)
        return <li key={capability}>
          <header><span><b>{description.name}</b><small>{description.blurb}</small></span><Chip tone={selection.status === 'ready' ? 'accent' : undefined}>{selection.available ? describeProvider(selection.available) : selection.status}</Chip></header>
          {selection.reason && <p className="st-note">{selection.reason}</p>}
          <label className="st-field"><span>Preferred provider</span><select aria-label={`${description.name} preferred provider`} value={selection.providers[0]} disabled={busy} onChange={(event) => {
            const provider = PROVIDER_IDS.find((id) => id === event.target.value)
            if (provider) void save(capability, [provider, ...selection.providers.filter((id) => id !== provider)])
          }}>{(capability === 'search' ? ['searxng' as const, ...PROVIDER_IDS.filter((id) => id !== 'searxng')] : PROVIDER_IDS).map((id) => <option key={id} value={id}>{describeProvider(id)}</option>)}</select></label>
          <ol className="st-capability-providers">{selection.providers.map((provider, index) => <li key={provider} data-active={provider === selection.available || undefined}>
            <span>{describeProvider(provider)}</span><small>{provider === selection.available ? 'configured' : `position ${index + 1}`}</small>
            <button type="button" disabled={busy || index === 0} aria-label={`Move ${describeProvider(provider)} up for ${description.name}`} onClick={() => {
              const next = [...selection.providers]
              const previous = next[index - 1]
              if (previous !== undefined) { next[index - 1] = provider; next[index] = previous; void save(capability, next) }
            }}>↑</button>
          </li>)}</ol>
        </li>
      })}</ul>
      <p className="st-note">Unsupported selections do not enable a capability. Freya uses the first configured adapter in the saved order; a paid call is never retried through a fallback.</p>
      {notice && <p className="st-notice" role="status">{notice}</p>}
    </div>
  )
}

function PrivacyCard() {
  return (
    <Card title="Privacy" icon="settings" subtitle="What Freya holds, and where">
      <div className="c-rows">
        {/* Said only because Freya has no way to send any of it anywhere. */}
        <Row title="Cloud sync" detail="None — Freya has no network sync" />
        <Row title="Telemetry" detail="None — no telemetry is collected or sent" />
        {/*
          Window observation is a launch-time environment variable, chosen by whoever
          starts Freya. It has never been a setting on this screen, and claiming
          "Ask each time" described a consent flow that does not exist.
        */}
        <Row title="Window observation" detail="Set when Freya launches, and off unless asked for — not a choice made here" />
        <Row title="Where your data lives" detail="On this machine only, in the host's own data folder" />
      </div>
    </Card>
  )
}

function SecurityCard({ snapshot }: { snapshot: SettingsProps['snapshot'] }) {
  const core = ready(snapshot.core)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  /**
   * Stop and resume Freya, through Core's existing command surface.
   *
   * There is no second stop system here and no local boolean pretending Freya is
   * stopped. `security.stopAll` is the same command the legacy Security surface
   * issues; it latches in Core, cancels in-flight provider calls,
   * closes research, Relay and the workforce. Durability follows Core's store. The only way
   * back is an explicit `security.resume`.
   *
   * Two rules this deliberately keeps:
   *
   *   - **The button reflects Core, not the click.** `stopped` comes from
   *     `snapshot.core`, so a refused stop leaves STOP ALL available rather than
   *     latching a control that only looks engaged.
   *   - **A refusal is shown as a refusal.** Core's own reason is rendered verbatim.
   *     There is no branch that turns a refusal into a success sentence, because a
   *     person who pressed the most serious button in the application must never be
   *     told it worked when it did not.
   */
  const submit = async (command: 'security.stopAll' | 'security.resume'): Promise<void> => {
    if (hostBridge() === undefined) {
      setNotice('This window cannot reach the host, so nothing was changed.')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      const result = await coreMirror().submit(
        command,
        command === 'security.stopAll' ? { reason: 'requested from App Mode' } : undefined,
      )
      setNotice(result.ok
        ? command === 'security.stopAll'
          ? 'Core accepted STOP ALL. Nothing runs until it is cleared.'
          : 'Core accepted the resume. Cognition may run again.'
        : (result.refusal?.reason ?? result.error?.message ?? 'Core refused the command.'))
    } catch (error) {
      setNotice(`Core could not be reached — ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  if (core === null) {
    return (
      <Card title="Security" icon="settings" subtitle="Core's own report">
        <div className="c-rows"><Row title="Security" detail={reason(snapshot.core)} /></div>
      </Card>
    )
  }

  const stopped = core.stopped
  return (
    <Card title="Security" icon="settings" subtitle="Core's own report">
      <div className="c-rows">
        <Row title="Freya is" detail={core.lifecycle} />
        <Row title="Stop authority" detail={stopped ? 'LATCHED — Freya will not think' : 'Not latched'} />
        <Row title="Journal integrity" detail={core.integrity} />
        <Row title="Recorded faults" detail={core.faultCount === 0 ? 'None' : `${core.faultCount}`} />
      </div>
      <div className="st-form">
        <div className="st-actions">
          <button type="button" className="st-save" disabled={busy || stopped}
            onClick={() => { void submit('security.stopAll') }}>STOP ALL</button>
          <button type="button" className="st-forget" disabled={busy || !stopped}
            onClick={() => { void submit('security.resume') }}>Resume</button>
        </div>
        <p className="st-note">
          STOP ALL latches in Core: it cancels in-flight provider calls, closes research,
          Relay and the workforce. Only an explicit resume clears it.{' '}
          {core.persistenceDurable
            ? 'The latch survives a restart.'
            : 'Event history is temporary: the latch cannot be guaranteed after a restart.'}
        </p>
        {notice.length > 0 && <p className="st-notice" role="status">{notice}</p>}
      </div>
    </Card>
  )
}

interface RuntimeInfo {
  readonly version: string
  readonly electron: string
  readonly platform: string
  readonly arch: string
}

function AboutCard({ snapshot }: { snapshot: SettingsProps['snapshot'] }) {
  const core = ready(snapshot.core)
  /**
   * The build version, read from the host.
   *
   * This used to be a hardcoded `Phase 19 · Build 19.0.1` — invented, and stale the
   * moment the version changed. The host already reports the real one through
   * `getRuntimeInfo`. Until that read resolves the row says so: a build number is
   * what a person quotes in a bug report, and a plausible invented one is worse than
   * an honest blank.
   */
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  useEffect(() => {
    const host = hostBridge()
    if (host === undefined) return
    let live = true
    void host.getRuntimeInfo()
      .then((info) => { if (live) setRuntime(info) })
      .catch(() => { /* The row keeps its unavailable wording. */ })
    return () => { live = false }
  }, [])

  const host = hostBridge()
  return (
    <Card title="About" icon="world" subtitle="This build">
      <div className="c-rows">
        <Row title="Version"
          detail={host === undefined
            ? 'Unavailable — this window is not attached to a desktop host'
            : runtime === null
              ? 'Reported by the host — not read yet'
              : `Freya ${runtime.version} · Electron ${runtime.electron}`} />
        <Row title="Platform" detail={runtime === null ? '—' : `${runtime.platform} ${runtime.arch}`} />
        <Row title="Journal events" detail={core === null ? '—' : `${core.sequence}`} />
      </div>
    </Card>
  )
}
