// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { startRedTeamCore, stopRedTeamCore, type RedTeamCore } from '../harness'
import type { CoreCommandResult } from '../../../core/protocol/core-protocol'
import { attentionSource } from '../../../core/testing'

/**
 * ATTENTION RED-TEAM HARNESS.
 *
 * A Core on a temp journal with a deterministic fake provider and a controllable
 * clock. Nothing here touches a network, a real provider or a real secret.
 */

export interface AttentionFixture extends RedTeamCore {
  clock: { now: Date }
}

export async function startAttentionCore(): Promise<AttentionFixture> {
  const clock = { now: new Date('2026-10-02T09:00:00.000Z') }
  const base = await startRedTeamCore({
    now: () => clock.now,
    attentionObserveSources: false,
  })
  return { ...base, clock }
}

export async function stopAttentionCore(fixture: AttentionFixture | null): Promise<void> {
  await stopRedTeamCore(fixture)
}

export function submit(
  fixture: AttentionFixture,
  command: string,
  payload?: unknown,
): Promise<CoreCommandResult> {
  return fixture.core.handleCommand({
    command: command as never,
    requestId: `rt-${Math.random().toString(36).slice(2)}`,
    payload,
  })
}

export function ingest(fixture: AttentionFixture, payload: Record<string, unknown>): Promise<CoreCommandResult> {
  return submit(fixture, 'attention.event.ingest', payload)
}

export function sourceScope(fixture: AttentionFixture, source: 'work' | 'mission' | 'system' | 'owner') {
  return attentionSource(fixture.core, source)
}

export async function journalText(fixture: AttentionFixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

/** One synthetic secret, reused so a leak test can sweep every sink. */
export const ATTENTION_SENTINEL = 'FREYA_RED_TEAM_SECRET_7A91'
