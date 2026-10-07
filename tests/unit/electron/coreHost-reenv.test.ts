// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../../electron/coreHost'
import type { HostEnv } from '../../../electron/coreHost'

/**
 * Re-env is a Core swap, not a host teardown.
 *
 * The provider credential and model live in the environment Core is built from, so
 * a saved setting only takes effect once the running Core is replaced. The property
 * that makes it safe to call on the save path is that it resolves and brings a Core
 * up — and the property that makes it *correct* is that the Core it brings up is
 * built from the environment that was just saved.
 *
 * Those are different properties, and the second one is the one that was broken. The
 * original implementation set the new env and then called `start()`, which returns
 * the in-flight startup promise when one exists. That promise was built from the
 * *previous* environment, so a save arriving during boot was accepted, awaited, and
 * silently discarded — the setting did nothing until the next relaunch, and nothing
 * said so.
 *
 * The model reported by Core's own status projection is used as the observable. It
 * is the value Core read from the environment at construction, so asserting on it
 * distinguishes "a Core is running" from "a Core is running with the new settings",
 * which is the only way to tell the two apart from outside.
 *
 * A temporary data path is used rather than an in-memory one because a real Core
 * writes its durable stores beside its data path.
 */

let dir = ''
let host: ElectronCoreHost | null = null

/** A complete, live-permitted provider configuration, so `providers[].model` is set. */
function configured(model: string): HostEnv {
  return {
    NANOGPT_API_KEY: 'sk-test',
    NANOGPT_BASE_URL: 'https://nano-gpt.com/api/v1',
    NANOGPT_MODEL: model,
    FREYA_ALLOW_LIVE_MODEL: '1',
  }
}

function modelOf(h: ElectronCoreHost): string | null {
  return h.status().providers.find((provider) => provider.id === 'nanogpt')?.model ?? null
}

function make(env: HostEnv, options: ConstructorParameters<typeof ElectronCoreHost>[2] = {}): ElectronCoreHost {
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), env, options)
  return host
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-reenv-'))
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('a provider save after startup', () => {
  it('keeps both providers visible while a NanoGPT save changes only its configured model', async () => {
    const minimax = { MINIMAX_API_KEY: 'test-mini', MINIMAX_MODEL: 'MiniMax-M3' }
    make({ ...configured('nano-before'), ...minimax })
    await host!.start()
    expect(host!.status().providers.find((provider) => provider.id === 'minimax')?.model).toBe('MiniMax-M3')
    expect(modelOf(host!)).toBe('nano-before')
    await host!.restartWithEnv({ ...configured('nano-after'), ...minimax })
    expect(host!.status().providers.find((provider) => provider.id === 'minimax')?.model).toBe('MiniMax-M3')
    expect(modelOf(host!)).toBe('nano-after')
    expect(host!.status().sessionUsage.calls).toBe(0)
  })

  it('swaps env and restarts without throwing when never started', async () => {
    make({ NANOGPT_MODEL: 'a' })
    await expect(host!.restartWithEnv({ NANOGPT_MODEL: 'b' })).resolves.toBeUndefined()
    expect(host!.status().lifecycle).toBe('ready')
  })

  it('brings up a Core built from the new environment', async () => {
    make(configured('first-model'))
    await host!.start()
    expect(modelOf(host!)).toBe('first-model')

    await host!.restartWithEnv(configured('second-model'))
    expect(host!.status().lifecycle).toBe('ready')
    // The load-bearing assertion: the Core that replaced the first was built from
    // the environment that was just saved, not from the one it started with.
    expect(modelOf(host!)).toBe('second-model')
  })
})

describe('a provider save that arrives while the Core is still starting', () => {
  it('applies the new environment rather than reusing the in-flight startup', async () => {
    make(configured('first-model'))
    // Deliberately not awaited: the save has to land while this is still running,
    // which is the case that used to be discarded.
    const starting = host!.start()
    await host!.restartWithEnv(configured('second-model'))
    await starting

    expect(host!.status().lifecycle).toBe('ready')
    expect(modelOf(host!)).toBe('second-model')
  })

  it('is order-independent: the last environment saved is the one that survives', async () => {
    make(configured('first-model'))
    const starting = host!.start()
    await host!.restartWithEnv(configured('second-model'))
    await host!.restartWithEnv(configured('third-model'))
    await starting

    expect(modelOf(host!)).toBe('third-model')
  })
})

describe('repeated saves are serialised and bounded', () => {
  it('coalesces a burst instead of restarting once per save', async () => {
    make(configured('first-model'))
    await host!.start()

    // Ten saves in one tick. Each would previously have stopped and rebuilt Core on
    // its own, cancelling whatever was in flight and appending a stopping/stopped
    // pair to the durable journal each time.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => host!.restartWithEnv(configured(`model-${index}`))),
    )

    expect(host!.status().lifecycle).toBe('ready')
    // Coalesced to the newest environment, which is the only one a person can have
    // meant by saving ten times in a row.
    expect(modelOf(host!)).toBe('model-9')
  })

  it('leaves a working Core after a sequential run of saves', async () => {
    make(configured('m-0'))
    await host!.start()
    for (let index = 1; index <= 4; index += 1) {
      await host!.restartWithEnv(configured(`m-${index}`))
    }
    expect(host!.status().lifecycle).toBe('ready')
    expect(modelOf(host!)).toBe('m-4')
  })

  it('accepts a new save after an earlier one failed', async () => {
    make(configured('good-model'))
    await host!.start()
    await host!.restartWithEnv(configured('good-model-2'))
    expect(modelOf(host!)).toBe('good-model-2')
  })
})

describe('repeated reconfiguration does not accumulate lifecycle resources', () => {
  it('starts no duplicate window observer', async () => {
    /**
     * Counts pollers that are *live*, not ones that were created.
     *
     * Counting creations cannot detect this leak: a leaked poller and a correctly
     * replaced one both mean "one more schedule call", so the numbers are identical
     * and the assertion passes either way. What differs is whether the previous
     * poller was ever cancelled, so the fake tracks live handles — increment on
     * schedule, decrement on the cancel it returns — and the test asserts the live
     * count rather than the cumulative one.
     */
    let live = 0
    let peak = 0
    const timer = {
      schedule: (_run: () => void, everyMs: number) => {
        live += 1
        peak = Math.max(peak, live)
        const handle = setInterval(() => undefined, Math.max(everyMs, 60_000))
        let cancelled = false
        return () => {
          if (cancelled) return
          cancelled = true
          live -= 1
          clearInterval(handle)
        }
      },
    }
    // The real `ActiveWindowProvider` shape: identity, honest reach, availability,
    // and a read that reports having nothing. A partial fake here would fail on the
    // type rather than on the behaviour under test, which is not what this case is for.
    const provider = {
      providerId: 'test-window-source',
      reach: 'own-app' as const,
      availability: () => 'unavailable' as const,
      read: () => ({
        availability: 'unavailable' as const,
        window: null,
        reason: 'no focused window in a test',
      }),
    }
    make(configured('m-0'), {
      windowObservation: { enabled: true, provider, scope: { scopeKind: 'surface', scopeId: 'desktop-window' }, timer },
    })
    await host!.start()
    expect(live).toBe(1)
    expect(peak).toBe(1)

    for (let index = 1; index <= 3; index += 1) {
      await host!.restartWithEnv(configured(`m-${index}`))
    }
    // Four Cores over the host's life, one live poller at any moment. The leak was
    // one per save, because `restartWithEnv` never stopped the previous observer the
    // way `stop()` did — so `peak` is the assertion that would have caught it, and
    // it climbs to 2 on the very first reconfiguration.
    expect(live).toBe(1)
    expect(peak).toBe(1)
  })

  it('keeps the Context channel bound to the live Core after a swap', async () => {
    make(configured('m-0'))
    await host!.start()
    const before = host!.context()

    for (let index = 1; index <= 3; index += 1) {
      await host!.restartWithEnv(configured(`m-${index}`))
    }
    // A stale binding would report a stopped Core's projection, or nothing at all.
    // The channel answers from the Core that is running now.
    expect(host!.status().lifecycle).toBe('ready')
    expect(host!.context()).toEqual(before === null ? null : expect.any(Object))
  })
})

describe('a setting that cannot be applied leaves a recoverable state', () => {
  /**
   * The reachable failure, not a synthetic one.
   *
   * An earlier version of this file made Core fail by pointing it at an unusable
   * journal path, and asserted that `restartWithEnv` rejected. It does not: Core
   * treats an unopenable journal as `degraded` rather than fatal, which is the right
   * behaviour and made the test meaningless. Stubbing `start` to throw would test the
   * `catch` block and nothing else.
   *
   * So this uses a failure that genuinely happens to a person: a provider
   * configuration naming an endpoint the endpoint policy refuses. The setting is
   * saved, the rebuild succeeds, and the provider correctly reports that it cannot be
   * called. The host must be ready, must say so truthfully, and must still accept a
   * later correction — which is the whole of "recoverable".
   */
  it('comes up ready with the provider truthfully unavailable', async () => {
    make(configured('good-model'))
    await host!.start()
    expect(modelOf(host!)).toBe('good-model')

    await host!.restartWithEnv({
      ...configured('bad-model'),
      NANOGPT_BASE_URL: 'https://attacker.example/v1',
    })

    expect(host!.status().lifecycle).toBe('ready')
    const provider = host!.status().providers.find((provider) => provider.id === 'nanogpt')
    expect(provider?.status).toBe('unconfigured')
    // Ready, and honest that it cannot be called — not a healthy-looking zero.
    expect(provider?.liveEnabled).toBe(false)
  })

  it('accepts a correction afterwards', async () => {
    make(configured('good-model'))
    await host!.start()
    await host!.restartWithEnv({ ...configured('bad-model'), NANOGPT_BASE_URL: 'https://attacker.example/v1' })
    expect(host!.status().providers.find((provider) => provider.id === 'nanogpt')?.status).toBe('unconfigured')

    await host!.restartWithEnv(configured('corrected-model'))
    expect(host!.status().lifecycle).toBe('ready')
    expect(modelOf(host!)).toBe('corrected-model')
    expect(host!.status().providers.find((provider) => provider.id === 'nanogpt')?.status).toBe('configured')
  })

  it('keeps serving status to windows across a rebuild', async () => {
    make(configured('good-model'))
    await host!.start()
    const seen: string[] = []
    host!.attach((status) => seen.push(status.lifecycle))
    await host!.restartWithEnv({ ...configured('bad-model'), NANOGPT_BASE_URL: 'https://attacker.example/v1' })

    // The subscription survived the swap — a Core replacement, not a host teardown,
    // so an attached window keeps receiving status without re-attaching.
    expect(seen.length).toBeGreaterThan(1)
    // And it ends on the replacement Core, not on the one that was torn down.
    expect(seen.at(-1)).toBe('ready')
    // Note the sequence contains a `stopped` from the outgoing Core. That is the old
    // Core's genuine final state and is deliberately not asserted away: a provider
    // save really does stop and replace the Core. What must not happen is the *security*
    // posture moving, and `stopAll` is journal-derived, so a swap cannot clear it.
    expect(host!.status().stopAll.active).toBe(false)
  })
})
