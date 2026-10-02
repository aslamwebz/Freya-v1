// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillsSurface } from '../../src/ui/surfaces/SkillsSurface'
import { resetSkillsMirror } from '../../src/platform/skillsClient'
import {
  ABSENT_SKILL_PROJECTION,
  NO_SKILL_DOMAIN_REASON,
  type SkillProjection,
} from '../../core/protocol/skills'
import { initialSkillState, projectSkills } from '../../core/skills'

/**
 * The Skills view.
 *
 *   - It prints Core's own status, verdict and reason codes and invents none of them.
 *   - A procedure's summary and contract text never appear from a projection; the one
 *     way to see them is the explicit per-skill read.
 *   - Model commentary appears as a **character count next to the verdict**, so a reader
 *     can see that a great deal of opinion moved nothing.
 *   - "No Skill domain" is not drawn as "Freya has learned nothing".
 *   - There is no control here that promotes an artifact into the running runtime.
 */

const SENTINEL = 'FREYA_RED_TEAM_SECRET_7A91'

let coreSubmit: ReturnType<typeof vi.fn>
let coreSkills: ReturnType<typeof vi.fn>
let current: SkillProjection | null

function ready(over: Partial<SkillProjection> = {}): SkillProjection {
  const base = projectSkills({
    sequence: 7,
    state: {
      ...initialSkillState(),
      records: [
        {
          skillId: 'sk_candidate',
          name: 'candidate-procedure',
          nameLength: 18,
          kind: 'procedure',
          status: 'candidate',
          version: 1,
          verification: 'unverified',
          source: 'owner',
          trustClass: 'owner-declared',
          admittedBy: 'owner',
          admittedAt: '2026-10-02T09:00:00.000Z',
          promotedAt: null,
          retiredAt: null,
          retirementReason: null,
          applicability: ['research'],
          versions: [
            {
              version: 1,
              contentHash: 'a'.repeat(32),
              createdAt: '2026-10-02T09:00:00.000Z',
              source: 'owner',
              trustClass: 'owner-declared',
              admittedBy: 'owner',
              stepCount: 1,
              requiredCapabilityCount: 1,
              applicabilityCount: 1,
              inputCount: 1,
              outputCount: 1,
              preconditionCount: 0,
              postconditionCount: 1,
              summaryLength: SENTINEL.length,
              revisions: 0,
            },
          ],
          evaluations: [],
          executionsPlanned: 0,
          updatedAt: '2026-10-02T09:00:00.000Z',
        },
        {
          skillId: 'sk_promoted',
          name: 'promoted-procedure',
          nameLength: 17,
          kind: 'procedure',
          status: 'promoted',
          version: 2,
          verification: 'verified',
          source: 'improvement',
          trustClass: 'derived',
          admittedBy: 'owner',
          admittedAt: '2026-10-02T09:00:00.000Z',
          promotedAt: '2026-10-02T09:10:00.000Z',
          retiredAt: null,
          retirementReason: null,
          applicability: ['research'],
          versions: [],
          evaluations: [
            {
              evaluationId: 'ev-1',
              skillId: 'sk_promoted',
              version: 2,
              subjectKind: 'trial-run',
              subjectRef: 'run-1',
              author: 'owner',
              evaluatedAt: '2026-10-02T09:09:00.000Z',
              decision: {
                verdict: 'established',
                reason: 'verification-passed',
                deterministicCount: 2,
                positiveCount: 2,
                negativeCount: 0,
                commentaryChars: 4_000,
              },
            },
          ],
          executionsPlanned: 3,
          updatedAt: '2026-10-02T09:10:00.000Z',
        },
      ],
    },
    persistence: { mode: 'encrypted', durable: true, reason: null },
  })
  return { ...base, ...over }
}

beforeEach(() => {
  resetSkillsMirror()
  current = ready()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    skill: { operation: 'admitted', ok: true, skillId: 'sk_new', version: 1, status: 'candidate' },
  }))
  coreSkills = vi.fn(async () => current)
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreSkills: coreSkills as never,
    onCoreSkills: (() => () => {}) as never,
  } as never
})

afterEach(() => {
  cleanup()
  resetSkillsMirror()
  delete window.freyaHost
})

describe('the Skills view renders Core’s truth', () => {
  it('shows each procedure with Core’s own status, version and verification', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    expect(screen.getByText(/candidate-procedure/)).toBeInTheDocument()
    expect(screen.getByText(/v1 · candidate · unverified/)).toBeInTheDocument()
    expect(screen.getByText(/v2 · promoted · verified/)).toBeInTheDocument()
    expect(screen.getByText(/2 recorded/)).toBeInTheDocument()
  })

  it('never draws a summary or a contract description from the projection', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    expect(screen.queryByText(new RegExp(SENTINEL))).toBeNull()
    // Only a measured length crosses.
    expect(screen.getByText(new RegExp(`${SENTINEL.length} characters of summary`))).toBeInTheDocument()
  })

  it('prints the verdict code and the commentary count together', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    expect(screen.getByText(/established \(verification-passed\)/)).toBeInTheDocument()
    // The point of showing the count next to the verdict: the opinion changed nothing.
    expect(screen.getByText(/4000 characters of model commentary, which changed no verdict/)).toBeInTheDocument()
  })

  it('says the bodies are encrypted at rest', async () => {
    const { container } = render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    expect(container.querySelector('.skills-posture')?.getAttribute('data-durable')).toBe('true')
    expect(screen.getByText(/Bodies are/)).toBeInTheDocument()
  })

  it('says plainly when bodies are held in this process only', async () => {
    // A fresh mount, because the mirror holds what Core pushed: a surface must not
    // re-read on its own and disagree with the last push.
    cleanup()
    resetSkillsMirror()
    current = ready({
      persistence: { mode: 'ephemeral', durable: false, reason: 'held in this process only' },
    })
    const { container } = render(<SkillsSurface />)
    await waitFor(() =>
      expect(container.querySelector('.skills-posture')?.getAttribute('data-durable')).toBe('false'),
    )
    expect(screen.getByText(/held in this process only/)).toBeInTheDocument()
  })

  it('reads one body back only when asked', async () => {
    coreSubmit.mockImplementation(async (command: string) => {
      if (command === 'skill.detail.read') {
        return {
          requestId: 'r1',
          ok: true,
          skill: {
            operation: 'detail',
            ok: true,
            detail: {
              skillId: 'sk_candidate',
              name: 'candidate-procedure',
              kind: 'procedure',
              status: 'candidate',
              version: 1,
              verification: 'unverified',
              contentHash: 'a'.repeat(32),
              summary: `Reads a file. ${SENTINEL}`,
              steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
              requiredCapabilities: ['work.execute'],
              applicability: ['research'],
              contract: {
                inputs: [{ name: 'path', description: 'The file to read.' }],
                outputs: [{ name: 'summary', description: 'A bounded summary.' }],
                preconditions: [],
                postconditions: [{ name: 'recorded', description: 'Closed on its verifier.' }],
              },
              provenance: {
                source: 'owner',
                trustClass: 'owner-declared',
                admittedBy: 'owner',
                admittedAt: '2026-10-02T09:00:00.000Z',
                parentSkillId: null,
                parentVersion: null,
              },
            },
          },
        }
      }
      return { requestId: 'r1', ok: true, skill: { operation: 'selected', ok: true } }
    })
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/candidate-procedure/)).toBeInTheDocument())
    expect(screen.queryByText(new RegExp(SENTINEL))).toBeNull()

    const readButtons = screen.getAllByRole('button', { name: 'Read' })
    fireEvent.click(readButtons[0]!)
    await waitFor(() => expect(screen.getByText(new RegExp(SENTINEL))).toBeInTheDocument())
    // And it came from one explicit read, not from a standing feed.
    expect(coreSubmit.mock.calls.at(-1)?.[0]).toBe('skill.detail.read')
  })
})

describe('what this window may and may not do', () => {
  it('records a candidate and claims nothing else', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-procedure' } })
    fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'does one thing' } })
    fireEvent.change(screen.getByLabelText('Capability it needs'), { target: { value: 'work.execute' } })
    fireEvent.change(screen.getByLabelText('Verifier that closes its step'), {
      target: { value: 'test.record.matches' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record as a candidate' }))
    await waitFor(() => expect(coreSubmit).toHaveBeenCalled())
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.admit')
    expect(payload.name).toBe('new-procedure')
    expect(payload.status).toBeUndefined()
    expect(payload.trustClass).toBeUndefined()
    expect(payload.verification).toBeUndefined()
  })

  it('withdraws a promotion and retires, through named commands only', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/promoted-procedure/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw from use' }))
    await waitFor(() => expect(coreSubmit).toHaveBeenCalled())
    expect(coreSubmit.mock.calls[0]?.[0]).toBe('skill.transition')
    expect(coreSubmit.mock.calls[0]?.[1]).toEqual({ skillId: 'sk_promoted', to: 'draft' })

    // One Retire per live procedure, so the promoted one is the second in the list.
    const retireButtons = screen.getAllByRole('button', { name: 'Retire' })
    fireEvent.click(retireButtons[1]!)
    await waitFor(() => expect(coreSubmit.mock.calls.length).toBeGreaterThan(1))
    expect(coreSubmit.mock.calls.at(-1)?.[0]).toBe('skill.retire')
    expect(coreSubmit.mock.calls.at(-1)?.[1]).toEqual({ skillId: 'sk_promoted', reason: 'owner-request' })
  })

  it('renders Core’s refusal with its code, never as a success', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'a Core refusal' },
      skill: {
        operation: 'refused',
        ok: false,
        code: 'boundary-violation',
        reason: 'a Core refusal',
      },
    }))
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw from use' }))
    await waitFor(() => expect(screen.getByText(/boundary-violation/)).toBeInTheDocument())
    expect(screen.getByText(/a Core refusal/)).toBeInTheDocument()
  })

  it('has no control that puts an artifact into the running runtime', async () => {
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    const labels = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    for (const forbidden of ['Deploy', 'Install', 'Write to disk', 'Ship to runtime', 'Self-modify']) {
      expect(labels).not.toContain(forbidden)
    }
    // The exact set of actions this window offers, with no duplicates invented.
    expect(new Set(labels)).toEqual(
      new Set([
        'Mark reviewed',
        'Withdraw from use',
        'Retire',
        'Read',
        'Record as a candidate',
        'Ask Core which procedures apply',
      ]),
    )
  })

  it('shows the thresholds Core will not bend, and the retired procedures', async () => {
    current = ready({
      ...ready(),
      skills: [
        {
          ...ready().skills[0]!,
          status: 'retired',
          retirementReason: 'unsafe',
        },
      ],
    })
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/SKILLS/)).toBeInTheDocument())
    expect(screen.getByText(/retired: unsafe/)).toBeInTheDocument()
    expect(screen.getByText(/3 established evaluation\(s\) across 2 subjects/)).toBeInTheDocument()
    expect(screen.getByText(/Thresholds Core will not bend/)).toBeInTheDocument()
  })
})

describe('the absent states are truthful', () => {
  it('says Core has not reported, rather than drawing an empty board', async () => {
    // A host with no Core yet answers `null`, and the mirror publishes Core's own absent
    // projection for it — which is `unavailable`, never a `ready` board with no rows.
    coreSkills.mockImplementation(async () => null)
    const { container } = render(<SkillsSurface />)
    await waitFor(() =>
      expect(container.querySelector('.skills-surface')?.getAttribute('data-health')).toBe('unavailable'),
    )
    expect(screen.queryByText(/Procedures/)).toBeNull()
  })

  it('draws "no Skill domain" as a domain absence, not as a learned-nothing board', async () => {
    current = { ...ABSENT_SKILL_PROJECTION, reason: NO_SKILL_DOMAIN_REASON }
    const { container } = render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/NO SKILL DOMAIN/)).toBeInTheDocument())
    expect(container.querySelector('.skills-surface')?.getAttribute('data-health')).toBe('unavailable')
    expect(screen.queryByText(/Procedures/)).toBeNull()
    expect(screen.getByText(/none is simulated/)).toBeInTheDocument()
  })

  it('says plainly that an empty registry is a fact about this install', async () => {
    current = projectSkills({
      state: initialSkillState(),
      persistence: { mode: 'encrypted', durable: true, reason: null },
    })
    render(<SkillsSurface />)
    await waitFor(() => expect(screen.getByText(/no procedures recorded/)).toBeInTheDocument())
    expect(screen.getByText(/not a placeholder/)).toBeInTheDocument()
  })
})