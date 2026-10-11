import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { UnifiedWorkspace } from '../../../src/app/screens/UnifiedWorkspaces'
import { PRIMARY_DESTINATIONS, resolveRoute } from '../../../src/app/state/routes'
import { NO_CORE_SNAPSHOT } from './mindFixtures'
import { ABSENT_SKILL_PROJECTION, type SkillView } from '../../../core/protocol/skills'
import { resetSkillsMirror } from '../../../src/platform/skillsClient'

afterEach(() => { cleanup(); resetSkillsMirror(); delete window.freyaHost })

it('opens War Room on Agents and migrates old skills/tools shortcuts', () => {
  expect(PRIMARY_DESTINATIONS.find(([id]) => id === 'office')?.[1]).toBe('War Room')
  for (const path of ['office', 'war-room', 'workforce']) expect(resolveRoute(path).path).toBe('office/agents')
  for (const path of ['skills', 'settings/advanced/skills']) expect(resolveRoute(path).path).toBe('office/skills')
  for (const path of ['tools', 'war-room/tools']) expect(resolveRoute(path).path).toBe('office/tools')
  for (const path of ['foundry', 'create', 'settings/advanced/foundry']) expect(resolveRoute(path).path).toBe('office/tools')
})

it('shows Core names on agent cards, separately from their roles and IDs', () => {
  render(<UnifiedWorkspace path="office/agents" snapshot={{ ...NO_CORE_SNAPSHOT,
    workforce: { status: 'ready', source: 'live', data: { total: 3, working: 1, rows: [
      { id: 'worker-alpha', name: 'Alpha', state: 'working', specialization: 'Research' },
      { id: 'worker-beta', name: 'Beta', state: 'idle', specialization: 'Planning' },
      { id: 'worker-third', name: 'Archivist', state: 'blocked', specialization: null },
    ] } },
  }} onNavigate={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'War Room' })).toBeInTheDocument()
  const cards = screen.getAllByRole('article')
  expect(cards.map(card => within(card).getByRole('heading').textContent)).toEqual(['Alpha', 'Beta', 'Archivist'])
  expect(cards[0]).toHaveTextContent('working')
  expect(cards[0]).toHaveTextContent('Research')
  expect(cards[0]).toHaveTextContent('worker-alpha')
  expect(screen.getByRole('tablist', { name: 'War Room sections' })).toHaveAttribute('aria-orientation', 'horizontal')
})

it('shows Alpha and Beta slots without claiming missing workers exist or run', () => {
  render(<UnifiedWorkspace path="office/agents" snapshot={NO_CORE_SNAPSHOT} onNavigate={vi.fn()} />)
  for (const name of ['Alpha', 'Beta']) {
    const card = screen.getByRole('heading', { name }).closest('article')
    expect(card).toHaveTextContent('Not connected')
    expect(card).not.toHaveTextContent('working')
  }
})

it('shows the Skills catalogue inside War Room and navigates to Tools', () => {
  const navigate = vi.fn()
  render(<UnifiedWorkspace path="office/skills" snapshot={NO_CORE_SNAPSHOT} onNavigate={navigate} />)
  expect(screen.getByRole('tabpanel', { name: 'Skills' })).toHaveTextContent('Skills are not available')
  fireEvent.click(screen.getByRole('tab', { name: 'Tools' }))
  expect(navigate).toHaveBeenCalledWith('office/tools')
})

it('renders every procedure from the current Core skill catalogue', async () => {
  const skill: SkillView = {
    skillId: 'fixture-skill', name: 'Digest research procedure', kind: 'procedure', status: 'candidate', version: 1,
    verification: 'unverified', source: 'owner', trustClass: 'owner-declared', admittedBy: 'owner',
    admittedAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', promotedAt: null, retiredAt: null,
    retirementReason: null, applicability: ['research'], stepCount: 1, requiredCapabilityCount: 1,
    inputCount: 1, outputCount: 1, preconditionCount: 0, postconditionCount: 1, summaryLength: 80,
    executionsPlanned: 0, establishedCount: 0, contradictedCount: 0, inconclusiveCount: 0, evaluationCount: 0,
    lastEvaluation: null, versions: [],
  }
  const submit = vi.fn()
  window.freyaHost = {
    coreSkills: async () => ({ ...ABSENT_SKILL_PROJECTION, health: 'ready', reason: null, skills: [skill, { ...skill, skillId: 'second', name: 'Second procedure' }], counts: { ...ABSENT_SKILL_PROJECTION.counts, retained: 2 } }),
    onCoreSkills: () => () => {}, coreSubmit: submit,
  } as never
  render(<UnifiedWorkspace path="office/skills" snapshot={NO_CORE_SNAPSHOT} onNavigate={vi.fn()} />)
  expect(await screen.findByText('Digest research procedure')).toBeInTheDocument()
  expect(screen.getByText('Second procedure')).toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})
