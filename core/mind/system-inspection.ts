import type { MindTool } from './tools'

export function createSystemInspectionTool(options: { read: () => Readonly<Record<string, unknown>> }): MindTool {
  return {
    name: 'system_inspect', capability: 'core.status.read',
    description: 'Inspect Freya’s actual connected systems, Mind, memory health, work, schedules, agents, skills, tools and Matrix. Read this before claiming systems are absent. Facts are live metadata; no credentials or private file bodies are exposed.',
    parameters: [{ name: 'section', description: 'all (default), mind, memory, missions, goals, attention, agents, skills, tools, matrix, or runtime', required: false }],
    async run(request) {
      const state = options.read()
      const section = request.arguments.section ?? 'all'
      if (section !== 'all' && !Object.hasOwn(state, section)) throw new Error('Unknown system section.')
      const entries = Object.entries(state).filter(([name]) => section === 'all' || name === section)
      return { summary: `Inspected ${entries.map(([name]) => name).join(', ')} from Freya Core.`, sources: [], provenance: { actor: 'freya.core', extract: entries.map(([name, data]) => `${name}: ${JSON.stringify(data)}`) } }
    },
  }
}
