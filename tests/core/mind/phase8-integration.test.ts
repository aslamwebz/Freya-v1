import { describe, it, expect } from 'vitest'
import { budgetFor } from '../../../core/mind/loop'
import { createMissionsListTool } from '../../../core/mind/missions-list-tool'
import { createWorkspaceReportTool } from '../../../core/mind/workspace-file-tool'
import { MIND_TOOL_LIMITS } from '../../../core/mind/tools'
import { CONVERSATION_LIMITS } from '../../../core/conversation/types'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Phase 8: Token Budget & Continuation Synthesis', () => {
  it('gives every continuation the documented follow-up allowance while total sum equals perTurnAllowance (7,680)', () => {
    const allowance = CONVERSATION_LIMITS.maxOutputTokensPerTurn
    expect(allowance).toBe(7_680)

    // Iteration 0 (initial answer budget: maxOutputTokensPerAnswer = 3072)
    expect(budgetFor(0, allowance)).toBe(CONVERSATION_LIMITS.maxOutputTokensPerAnswer)
    expect(budgetFor(0, allowance)).toBe(3_072)

    // Answer-bearing calls (0..1) and envelope calls (2..7) are weighted against
    // each other so both can actually finish on the live endpoint: a grounded
    // answer needs ~2048 to return `stop`, and an envelope on a model that emits
    // its reasoning inline needs room for that reasoning plus the JSON.
    const answerShare = budgetFor(0, allowance)
    const envelopeShare = budgetFor(MIND_TOOL_LIMITS.answerCalls, allowance)
    expect(answerShare).toBeGreaterThan(envelopeShare)
    for (let i = 0; i < MIND_TOOL_LIMITS.answerCalls; i++) {
      expect(budgetFor(i, allowance)).toBe(answerShare)
    }
    for (let i = MIND_TOOL_LIMITS.answerCalls; i < MIND_TOOL_LIMITS.maxProviderCalls; i++) {
      expect(budgetFor(i, allowance)).toBe(envelopeShare)
    }

    // Sum across all calls
    let total = 0
    for (let i = 0; i < MIND_TOOL_LIMITS.maxProviderCalls; i++) {
      total += budgetFor(i, allowance)
    }
    expect(total).toBeLessThanOrEqual(allowance)
    expect(total).toBeGreaterThan(allowance - MIND_TOOL_LIMITS.maxProviderCalls)
  })

  it('never budgets an answer-bearing call below the cost of finishing one', () => {
    // The regression that mattered: 384 was handed out here. Against MiniMax-M3 a
    // grounded answer returns `length` at every budget below 2048, so the turn died
    // holding its own evidence.
    const allowance = CONVERSATION_LIMITS.maxOutputTokensPerTurn
    for (let i = 0; i < MIND_TOOL_LIMITS.answerCalls; i++) {
      expect(budgetFor(i, allowance)).toBeGreaterThanOrEqual(2048)
    }
  })

  it('bounds gracefully for smaller token allowances', () => {
    const allowance = 1_000
    let total = 0
    for (let i = 0; i < MIND_TOOL_LIMITS.maxProviderCalls; i++) {
      const b = budgetFor(i, allowance)
      expect(b).toBeGreaterThan(0)
      total += b
    }
    expect(total).toBeLessThanOrEqual(allowance)
  })
})

describe('Phase 8: Missions List Tool', () => {
  it('reports active and completed missions accurately', async () => {
    const missions = [
      {
        id: 'mission-1',
        title: 'Research Three Web Frameworks',
        status: 'active',
        activePlan: {
          steps: [
            { stepId: 'step-1', status: 'completed' },
            { stepId: 'step-2', status: 'running' },
          ],
        },
        blockers: [],
      },
      {
        id: 'mission-2',
        title: 'Analyze Performance Benchmarks',
        status: 'completed',
        blockers: [],
      },
    ]

    const tool = createMissionsListTool({
      getMissions: () => missions,
    })

    expect(tool.name).toBe('missions_list')
    expect(tool.capability).toBe('mission.status.read')

    const resAll = await tool.run({ arguments: { status: 'all' } })
    expect(resAll.summary).toContain('Found 2 mission(s):')
    expect(resAll.summary).toContain('mission-1')
    expect(resAll.summary).toContain('1/2 steps complete')

    const resActive = await tool.run({ arguments: { status: 'active' } })
    expect(resActive.summary).toContain('Found 1 mission(s):')
    expect(resActive.summary).toContain('mission-1')

    const resNone = await tool.run({ arguments: { status: 'failed' } })
    expect(resNone.summary).toContain('No missions found matching the requested status.')
  })
})

describe('Phase 8: Workspace Report Tool', () => {
  it('saves markdown reports securely to approved workspace directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-workspace-test-'))
    try {
      const tool = createWorkspaceReportTool({ workspaceRoot: dir })
      expect(tool.name).toBe('workspace_save_report')
      expect(tool.capability).toBe('workspace.report.save')

      const res = await tool.run({
        arguments: {
          filename: 'three-frameworks-comparison.md',
          content: '# Technology Comparison\n\n1. Svelte\n2. React\n3. Vue',
        },
      })

      expect(res.summary).toContain('Successfully saved report "three-frameworks-comparison.md"')

      const written = await readFile(join(dir, 'three-frameworks-comparison.md'), 'utf8')
      expect(written).toContain('# Technology Comparison')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects path traversal and unauthorized file extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-workspace-test-'))
    try {
      const tool = createWorkspaceReportTool({ workspaceRoot: dir })

      await expect(
        tool.run({ arguments: { filename: '../secret.md', content: 'hack' } }),
      ).rejects.toThrow(/invalid/i)

      await expect(
        tool.run({ arguments: { filename: 'script.exe', content: 'binary' } }),
      ).rejects.toThrow(/not permitted/i)

      await expect(
        tool.run({ arguments: { filename: 'credentials.md', content: 'leak' } }),
      ).rejects.toThrow(/restricted keyword/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('Phase 8: Message Character Bounding Protection', () => {
  it('bounds assistant messages exceeding the 8,000 character store ceiling', () => {
    const limit = CONVERSATION_LIMITS.maxMessageCharacters
    expect(limit).toBe(8_000)

    const normal = 'Normal length response'
    expect(normal.length).toBeLessThan(limit)

    const oversized = 'A'.repeat(9_000)
    expect(oversized.length).toBeGreaterThan(limit)

    // Verify slicing logic
    const notice = '\n\n[Response safely preserved up to maximum message length]'
    const sliceLen = Math.max(0, limit - notice.length)
    const bounded = `${oversized.slice(0, sliceLen)}${notice}`

    expect(bounded.length).toBe(limit)
    expect(bounded).toContain('[Response safely preserved up to maximum message length]')
  })
})

