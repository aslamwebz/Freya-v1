// @vitest-environment node
import { createCore, type Core } from '../../../core/index'
import { lifeOwnerScope } from '../../../core/testing'
import type { CoreCommandName, CoreCommandResult } from '../../../core/protocol/core-protocol'
import type { LifeRecordInput } from '../../../core/life/engine'
import { StaticVaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../../core/testKey'
import { bindingAvailable, loadTestBinding } from '../../core/vault/binding'
import {
  startRedTeamCore,
  stopRedTeamCore,
  type RedTeamCore,
} from '../harness'

/**
 * LIFE HISTORY RED-TEAM HARNESS.
 *
 * A Core on a temp journal with a deterministic fake provider and helpers that
 * submit Life commands, record entries through the internal owner scope and read
 * the projection back. Nothing here touches a network, a real provider or a real
 * secret.
 */

export interface LifeFixture extends RedTeamCore {
  dataPath: string
  vaultPath: string | null
  submit(command: string, payload?: unknown): Promise<CoreCommandResult>
  scope(): ReturnType<typeof lifeOwnerScope>
  projection(): ReturnType<Core['life']>
}

let counter = 0

export async function startLifeCore(options: { vault?: boolean } = {}): Promise<LifeFixture> {
  const base = await startRedTeamCore()
  let vaultPath: string | null = null
  if (options.vault && bindingAvailable) {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const vaultDir = await mkdtemp(join(tmpdir(), 'freya-life-vault-'))
    vaultPath = join(vaultDir, 'freya.db')
    const core = createCore({
      dataPath: base.journalPath,
      providers: [base.fake],
      attentionObserveSources: false,
      vault: { path: vaultPath, keyProvider: new StaticVaultKeyProvider(testVaultKey()), binding: await loadTestBinding() },
    })
    await core.start()
    return {
      ...base,
      core,
      dataPath: base.journalPath,
      vaultPath,
      submit: (command: string, payload?: unknown): Promise<CoreCommandResult> =>
        core.handleCommand({ command: command as CoreCommandName, requestId: `life-rt-${Math.random().toString(36).slice(2)}`, payload }),
      scope: () => lifeOwnerScope(core),
      projection: () => core.life(),
    }
  }
  counter += 1
  const prefix = `life-rt-${counter}-`
  const submit = (command: string, payload?: unknown): Promise<CoreCommandResult> =>
    base.core.handleCommand({
      command: command as CoreCommandName,
      requestId: `${prefix}${Math.random().toString(36).slice(2)}`,
      payload,
    })
  return {
    ...base,
    dataPath: base.journalPath,
    vaultPath,
    submit,
    scope: () => lifeOwnerScope(base.core),
    projection: () => base.core.life(),
  }
}

export async function stopLifeCore(fixture: LifeFixture | null): Promise<void> {
  await stopRedTeamCore(fixture)
}

/** A life entry the owner might have recorded. `body` defaults to a sentinel. */
export function entryDraft(overrides: Partial<LifeRecordInput> = {}): LifeRecordInput {
  return {
    kind: 'episode',
    title: 'A recorded episode',
    summary: 'A short summary of what happened.',
    body: 'FREYA_RED_TEAM_SECRET_7A91',
    salience: 'medium',
    derivation: 'owner-stated',
    confidence: 'high',
    sourceDomain: 'owner',
    sourceId: null,
    actor: 'owner',
    references: [],
    occurredAt: '2026-05-01T10:00:00.000Z',
    tags: ['red-team'],
    ...overrides,
  }
}
