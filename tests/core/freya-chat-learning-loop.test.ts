// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { admitWorkStepOutcome } from '../../core/learning/work-admission'

let core: Core | undefined
let dir = ''
afterEach(async () => {
  await core?.stop('test')
  core = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('Freya applies verified learning to later conversation turns', () => {
  it('inserts relevant verified advice, then stops including withdrawn advice', async () => {
    dir = await mkdtemp(join(tmpdir(), 'freya-chat-learning-'))
    const provider = new FakeModelProvider()
    const requests: string[] = []
    vi.spyOn(provider, 'complete').mockImplementation(async request => {
      requests.push(JSON.stringify(request.messages ?? []))
      return { requestId: request.requestId, providerId: provider.id,
        model: provider.model, inputTokens: 10, outputTokens: 10, text: 'Acknowledged.' }
    })
    core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [provider] })
    await core.start()
    const created = await core.handleCommand({ command: 'conversation.create', requestId: 'c-learning' })
    if (created.conversation?.operation !== 'created') throw new Error('conversation creation refused')
    const conversationId = created.conversation.conversation.conversationId
    const submit = async (requestId: string) => {
      const result = await core!.handleCommand({ command: 'conversation.turn.submit',
        requestId, payload: { conversationId, text: 'Can filesystem.inspect verify metadata for this file?' } })
      if (result.conversation?.operation !== 'turn') throw new Error('turn was not returned')
      expect(result.conversation.turn.outcome).toBe('completed')
      return requests[requests.length - 1] ?? ''
    }
    expect(await submit('first')).not.toContain('ADVISORY PRIOR EXPERIENCE')

    const engine = core.learningEngineInstance()!
    const at = new Date().toISOString()
    const admitted = await admitWorkStepOutcome(engine, {
      step: { stepId: 'learning-chat-sample', runId: 'run-verified', key: 'step_0', index: 0,
        status: 'verified', attempts: 1, capability: 'filesystem.inspect',
        verifier: 'filesystem.inspect.verified', approvalId: null,
        startedAt: at, settledAt: at, reason: null },
      verification: { verificationId: 'ver-learning-chat', runId: 'run-verified',
        stepId: 'learning-chat-sample', verifier: 'filesystem.inspect.verified',
        status: 'passed', verdictAt: at, reason: 'passed' },
      missionContent: null, nowIso: at,
    })
    expect(admitted.admitted).toBe(true)
    expect(await submit('second')).toContain('ADVISORY PRIOR EXPERIENCE')

    expect(admitted.knowledgeId).toBeDefined()
    const withdrawn = await engine.withdraw(admitted.knowledgeId!)
    expect(withdrawn.ok).toBe(true)
    expect(await submit('third')).not.toContain('ADVISORY PRIOR EXPERIENCE')
  })
})
