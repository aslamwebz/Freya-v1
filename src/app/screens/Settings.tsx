import { useEffect, useState } from 'react'
import { Card, Chip, Row } from '../cards/Card'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { hostBridge } from '../../platform/host'
import { THEMES, type ThemeId } from '../../ui-v2/theme/tokens'
import type { PreferencesStore } from '../../ui-v2/theme/preferences'
import type { CoreView, ProviderView, Resource } from '../../ui-v2/state/contract'
import type { ScreenSlots } from './Home'
import { ready, reason } from '../state/view'

/**
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
 *
 * Every value now comes from one of three places and nowhere else:
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
 * ## Why `Settings` itself holds no hooks
 *
 * `App.tsx` calls every screen as a plain function — `Settings({ … })` — and a hook
 * called from there runs outside a component render, which React rejects outright.
 * So the selected category is owned by `App.tsx` and passed in, and the interactive
 * cards are components rendered *inside* the returned slots. The screen contract is
 * unchanged, the two-column layout is untouched, and the hooks live one level down
 * where React can see them.
 *
 * The provider form reuses the proven `?ui=v2` semantics rather than a second set: a
 * key is sent only when typed, an empty field leaves the stored key alone, and
 * forgetting one is its own explicit action.
 */

export type SettingsCategory = 'appearance' | 'provider' | 'privacy' | 'security' | 'about'

export interface SettingsProps {
  /** The live snapshot, typed by the same contract every other surface reads. */
  readonly snapshot: {
    readonly provider: Resource<ProviderView>
    readonly core: Resource<CoreView>
  }
  readonly preferences: PreferencesStore
  /** Owned by the caller, because a screen function cannot hold a hook. */
  readonly category: SettingsCategory
  readonly onCategory: (category: SettingsCategory) => void
}

const CATEGORIES: readonly (readonly [SettingsCategory, string, string])[] = [
  ['appearance', 'Appearance', 'focus'],
  ['provider', 'Provider', 'core'],
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

export function Settings({ snapshot, preferences, category, onCategory }: SettingsProps): ScreenSlots {
  return {
    left: (
      <Card title="Settings" icon="settings">
        <nav className="st-nav">
          {CATEGORIES.map(([id, label, icon]) => (
            <button key={id} type="button" className="st-cat" data-active={category === id}
              aria-current={category === id ? 'true' : undefined} onClick={() => onCategory(id)}>
              <Glyph name={icon as Parameters<typeof Glyph>[0]['name']} size={16} /><span>{label}</span>
            </button>
          ))}
        </nav>
      </Card>
    ),
    right: (
      <>
        {category === 'appearance' && <AppearanceCard preferences={preferences} />}
        {category === 'provider' && <ProviderCard snapshot={snapshot} />}
        {category === 'privacy' && <PrivacyCard />}
        {category === 'security' && <SecurityCard snapshot={snapshot} />}
        {category === 'about' && <AboutCard snapshot={snapshot} />}
      </>
    ),
    bottom: null,
  }
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
      {notice.length > 0 && <p className="st-notice" role="status">{notice}</p>}
    </Card>
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
  if (core === null) {
    return (
      <Card title="Security" icon="settings" subtitle="Core's own report">
        <div className="c-rows"><Row title="Security" detail={reason(snapshot.core)} /></div>
      </Card>
    )
  }
  return (
    <Card title="Security" icon="settings" subtitle="Core's own report">
      <div className="c-rows">
        <Row title="Freya is" detail={core.lifecycle} />
        <Row title="Stop authority" detail={core.stopped ? 'LATCHED — Freya will not think' : 'Not latched'} />
        <Row title="Journal integrity" detail={core.integrity} />
        <Row title="Recorded faults" detail={core.faultCount === 0 ? 'None' : `${core.faultCount}`} />
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
