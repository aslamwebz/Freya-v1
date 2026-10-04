// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../../electron/coreHost'

/**
 * Re-env is a Core swap, not a host teardown.
 *
 * The provider credential and model live in the environment Core is built from,
 * so a saved setting only takes effect once the running Core is replaced. This
 * pins the property that makes it safe to call on the save path: it resolves and
 * brings a Core up even when none had been started yet.
 *
 * A temporary data path is used rather than an in-memory one because a real Core
 * writes its durable stores beside its data path; a bare `memory` name would
 * scatter files through the repository.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-reenv-'))
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('core re-env', () => {
  it('swaps env and restarts without throwing when never started', async () => {
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), { NANOGPT_MODEL: 'a' })
    await expect(host.restartWithEnv({ NANOGPT_MODEL: 'b' })).resolves.toBeUndefined()
    // It really did come up rather than silently no-op.
    expect(host.status().lifecycle).toBe('ready')
  })
})