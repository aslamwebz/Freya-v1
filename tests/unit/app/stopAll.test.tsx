import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SettingsOverlay } from '../../../src/app/screens/Settings'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import type { UiSnapshot } from '../../../src/ui-v2/state/contract'
import { resetCoreMirror, coreMirror } from '../../../src/platform/coreClient'

/**
 * STOP ALL from the shipping App Mode.
 *
 * App Mode previously had **no way to stop Freya at all**. `security.stopAll` was
 * whitelisted in the preload allowlist, payload-bounded in the bridge, and handled
 * by main — and nothing in `src/app` referenced it. The surface carrying the most
 * serious control in the application existed only in the legacy shell.
 *
 * These cases pin the properties that make the control honest rather than merely
 * present, because a STOP ALL button is the easiest thing in a UI to fake:
 *
 *   - the button state comes from **Core's projection**, not from the click;
 *   - a refusal is rendered as a refusal, with Core's own sentence;
 *   - there is no local "stopped" flag that could disagree with Core.
 */

const CORE = {
  lifecycle: 'ready',
  sequence: 42,
  activeRequests: 0,
  stopped: false,
  integrity: 'ok',
  faultCount: 0,
}

function snapshotWith(stopped: boolean): UiSnapshot {
  return {
    home: { status: 'unavailable', reason: 'unused by Settings' },
    core: { status: 'ready', source: 'live', data: { ...CORE, stopped } },
    mission: { status: 'unavailable', reason: 'unused by Settings' },
    workforce: { status: 'unavailable', reason: 'unused by Settings' },
    activity: { status: 'unavailable', reason: 'unused by Settings' },
    attention: { status: 'unavailable', reason: 'unused by Settings' },
    provider: { status: 'unavailable', reason: 'unused by Settings' },
  } as unknown as UiSnapshot
}

function mountSecurity(stopped: boolean) {
  return render(
    <SettingsOverlay
      snapshot={snapshotWith(stopped)}
      preferences={new PreferencesStore()}
      category="security"
      onCategory={() => {}}
      onDone={() => {}}
    />,
  )
}

let submit: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetCoreMirror()
  submit = vi.fn(async () => ({ requestId: 'r', ok: true }))
  // A complete bridge, so `hostBridge()` is defined and the command path is reachable.
  ;(window as unknown as { freyaHost: unknown }).freyaHost = {
    isDesktop: true,
    getRuntimeInfo: async () => ({
      version: '0.1.0', electron: '44', platform: 'win32', arch: 'x64',
      userData: 'C:/tmp', workspaceFile: 'workspace.json', dev: false,
    }),
    loadWorkspace: async () => null,
    saveWorkspace: async () => true,
    onCollect: () => {},
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    providerConfig: async () => ({
      baseUrl: '', model: '', liveEnabled: false, hasKey: false,
      credentialState: 'none' as const, credentialReason: null,
    }),
    saveProviderConfig: async () => ({
      baseUrl: '', model: '', liveEnabled: false, hasKey: false,
      credentialState: 'none' as const, credentialReason: null,
    }),
    coreSubmit: async () => ({ requestId: 'r', ok: true }),
    coreStatus: async () => ({ lifecycle: 'booting' }),
    onCoreStatus: () => () => {},
  }
  // The command goes through the shared mirror, so the submission is observed there.
  vi.spyOn(coreMirror(), 'submit').mockImplementation(submit as never)
})

afterEach(() => {
  // Unmount between cases: two mounted Security cards means two STOP ALL buttons,
  // and `getByRole` correctly refuses to guess which one was meant.
  cleanup()
  delete (window as unknown as { freyaHost?: unknown }).freyaHost
  resetCoreMirror()
  vi.restoreAllMocks()
})

describe('App Mode can stop Freya', () => {
  it('offers STOP ALL, and Resume only once Core reports a latch', () => {
    const running = mountSecurity(false)
    const stopRunning = running.getByRole('button', { name: 'STOP ALL' }) as HTMLButtonElement
    const resumeRunning = running.getByRole('button', { name: 'Resume' }) as HTMLButtonElement
    // Not latched: stopping is available, resuming is not.
    expect(stopRunning.disabled).toBe(false)
    expect(resumeRunning.disabled).toBe(true)
    running.unmount()

    const stopped = mountSecurity(true)
    const stopStopped = stopped.getByRole('button', { name: 'STOP ALL' }) as HTMLButtonElement
    const resumeStopped = stopped.getByRole('button', { name: 'Resume' }) as HTMLButtonElement
    // Latched: the reverse. The button follows Core, not the click.
    expect(stopStopped.disabled).toBe(true)
    expect(resumeStopped.disabled).toBe(false)
  })

  it('says the latch is durable rather than implying a temporary pause', () => {
    const { container, unmount } = mountSecurity(true)
    const text = container.textContent ?? ''
    expect(text).toContain('LATCHED')
    expect(text).toMatch(/survives a restart/i)
    unmount()
  })

  it('sends the canonical command with a reason, not a local flag', async () => {
    const { getByRole, unmount } = mountSecurity(false)
    const stop = getByRole('button', { name: 'STOP ALL' }) as HTMLButtonElement
    stop.click()
    await Promise.resolve()
    expect(submit).toHaveBeenCalledWith('security.stopAll', { reason: 'requested from App Mode' })
    unmount()
  })

  it('renders a refusal as a refusal, in Core\'s words', async () => {
    submit.mockResolvedValueOnce({
      requestId: 'r', ok: false, refusal: { reason: 'the journal cannot be believed' },
    } as never)
    const { getByRole, container, unmount } = mountSecurity(false)
    ;(getByRole('button', { name: 'STOP ALL' }) as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const text = container.textContent ?? ''
    expect(text).toContain('the journal cannot be believed')
    // And it must not also claim success.
    expect(text).not.toContain('Core accepted STOP ALL')
    unmount()
  })
})
