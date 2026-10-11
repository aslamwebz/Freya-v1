// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../../core/index'
import { skillOwnerScope } from '../../../core/testing'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import type { CoreCommandName, CoreCommandResult } from '../../../core/protocol/core-protocol'
import {
  expectNoSentinels,
  journalEvents,
  RED_TEAM_SENTINELS,
  startRedTeamCore,
  stopRedTeamCore,
  type RedTeamCore,
} from '../harness'

/**
 * SKILLS RED-TEAM HARNESS.
 *
 * A Core on a temp journal with a deterministic fake provider, an optional skill key,
 * and helpers that submit skill commands and read the journal back. Nothing here
 * touches a network, a real provider or a real secret.
 */

export interface SkillsFixture extends RedTeamCore {
  dataPath: string
  submit(command: string, payload?: unknown): Promise<CoreCommandResult>
  scope(): ReturnType<typeof skillOwnerScope>
  projection(): ReturnType<Core['skills']>
}

let counter = 0

export async function startSkillsCore(options: { skillKey?: Uint8Array | null } = {}): Promise<SkillsFixture> {
  const base = await startRedTeamCore(options.skillKey === undefined ? {} : { skillKey: options.skillKey })
  counter += 1
  const prefix = `sk-rt-${counter}-`
  const submit = (command: string, payload?: unknown): Promise<CoreCommandResult> =>
    base.core.handleCommand({
      command: command as CoreCommandName,
      requestId: `${prefix}${Math.random().toString(36).slice(2)}`,
      payload,
    })
  return {
    ...base,
    dataPath: base.journalPath,
    submit,
    scope: () => skillOwnerScope(base.core),
    projection: () => base.core.skills(),
  }
}

export async function stopSkillsCore(fixture: SkillsFixture | null): Promise<void> {
  await stopRedTeamCore(fixture)
}

/** A procedure body this Core can actually execute, with a sentinel in the prose. */
export function procedure(
  name: string,
  summary = 'Reads a file and produces a bounded summary of it.',
): Record<string, unknown> {
  return {
    name,
    kind: 'procedure',
    summary,
    contract: {
      inputs: [{ name: 'path', description: 'The file to read.' }],
      outputs: [{ name: 'summary', description: 'A bounded summary.' }],
      preconditions: [],
      postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
    },
    applicability: ['research'],
    requiredCapabilities: ['work.execute'],
    steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
  }
}

/**
 * Record `count` established evaluations across **distinct** subjects.
 *
 * Distinct on purpose: this is the *honest* evidence shape, and a red-team test that
 * used it when it meant to replay one lucky run would prove nothing. For the replay
 * attack, write the loop out by hand with one `subjectRef`.
 */
export async function establishDistinct(
  fixture: SkillsFixture,
  skillId: string,
  count: number,
  code = 'passed',
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = await fixture.submit('skill.recordEvaluation', {
      skillId,
      subjectKind: 'trial-run',
      subjectRef: `run-${index}`,
      evidence: [{ kind: 'test-result', code, count: 1 }],
    })
    if (!result.ok) throw new Error(`evaluation refused: ${result.skill?.reason ?? 'unknown'}`)
  }
}

/**
 * Walk `candidate → draft → trial → verified → promoted` once and report the last step.
 *
 * **Once**, and that is the point: withdrawing from `verified` marks the version
 * `stale` by design, because "stop relying on this evidence" and "the evidence is
 * still good" are different claims. A test that walked twice would be asking the
 * second walk to re-verify on the first walk's evidence, which is exactly the stale
 * reuse this domain refuses.
 */
export async function walkTo(
  fixture: SkillsFixture,
  skillId: string,
  target: 'draft' | 'trial' | 'verified' | 'promoted',
): Promise<CoreCommandResult> {
  for (const step of ['draft', 'trial', 'verified', 'promoted'] as const) {
    const result = await fixture.submit('skill.transition', { skillId, to: step })
    if (step === target) return result
    if (!result.ok) {
      throw new Error(`transition to ${step} refused: ${result.skill?.reason ?? 'unknown'}`)
    }
  }
  throw new Error(`unreachable: ${target}`)
}

/** A fresh Core on the same journal, as a restart would see it. */
export async function reopen(fixture: SkillsFixture, key: Uint8Array | null): Promise<RedTeamCore> {
  const fake = new FakeModelProvider()
  const core = createCore({
    dataPath: fixture.dataPath,
    providers: [fake],
    attentionObserveSources: false,
    testCapabilities: true,
    ...(key === null ? {} : { skillKey: key }),
  })
  await core.start()
  return {
    core,
    owner: skillOwnerScope(core) as never,
    worker: skillOwnerScope(core) as never,
    fake,
    journalPath: fixture.dataPath,
    dir: fixture.dir,
  } as unknown as RedTeamCore
}

export async function readJournal(fixture: SkillsFixture): Promise<Record<string, unknown>[]> {
  return (await journalEvents(fixture)) as Record<string, unknown>[]
}

export async function readJournalRaw(fixture: SkillsFixture): Promise<string> {
  try {
    return await readFile(fixture.journalPath, 'utf8')
  } catch {
    return ''
  }
}

export { expectNoSentinels, RED_TEAM_SENTINELS }

export async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-skills-redteam-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}