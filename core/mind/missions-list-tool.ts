import type { MindTool } from './tools'

export interface MissionsListToolOptions {
  readonly getMissions: () => readonly {
    readonly id: string
    readonly title?: string
    readonly status: string
    readonly currentStep?: {
      readonly stepId: string
      readonly status: string
    } | null
    readonly progress?: {
      readonly completedSteps: number
      readonly totalSteps: number
    }
    readonly activePlan?: {
      readonly steps: readonly {
        readonly stepId: string
        readonly status: string
      }[]
    }
    readonly blockers?: readonly string[]
  }[]
}

export function createMissionsListTool(options: MissionsListToolOptions): MindTool {
  return {
    name: 'missions_list',
    capability: 'mission.status.read',
    description:
      'List active and recent autonomous Missions, including their status, current plan steps, and blockers. ' +
      'Use this when the owner asks about active missions, ongoing tasks, or research execution progress.',
    parameters: [
      {
        name: 'status',
        description: 'Optional filter: "active", "completed", "all". Defaults to "all".',
        required: false,
      },
    ],
    async run(request) {
      const filter = (request.arguments['status'] ?? 'all').trim().toLowerCase()
      const all = options.getMissions()
      const filtered =
        filter === 'all'
          ? all
          : filter === 'active'
            ? all.filter((m) => m.status === 'active' || m.status === 'running')
            : all.filter((m) => m.status.toLowerCase() === filter)

      if (filtered.length === 0) {
        return {
          summary: 'No missions found matching the requested status.',
          sources: [],
          provenance: {
            actor: 'missions_list',
            steps: ['Queried mission engine status ledger — 0 records matched.'],
          },
        }
      }

      const lines: string[] = [
        `Found ${filtered.length} mission(s):`,
        ...filtered.map((m) => {
          const planInfo = m.progress
            ? ` (${m.progress.completedSteps}/${m.progress.totalSteps} steps complete)`
            : m.activePlan
              ? ` (${m.activePlan.steps.filter((s) => s.status === 'completed').length}/${m.activePlan.steps.length} steps complete)`
              : ''
          const stepInfo = m.currentStep ? ` [Current step: ${m.currentStep.stepId} (${m.currentStep.status})]` : ''
          const blockerInfo =
            m.blockers && m.blockers.length > 0 ? ` [Blocked: ${m.blockers.join(', ')}]` : ''
          const title = m.title ?? m.id
          return `- [${m.id}] "${title}" — Status: ${m.status}${planInfo}${stepInfo}${blockerInfo}`
        }),
      ]

      return {
        summary: lines.join('\n'),
        sources: [],
        provenance: {
          actor: 'missions_list',
          steps: [`Queried mission engine status ledger — returned ${filtered.length} records.`],
        },
      }
    },
  }
}
