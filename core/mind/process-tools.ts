import { createChartTool, createCanvasTool, type MindTool } from './tools'
import { createMissionProposalTool } from './mission-proposal'
import { createWorkspaceReportTool } from './workspace-file-tool'

/** Existing bodies that need no protected storage or security authority. */
export const PROCESS_TOOL_NAMES: ReadonlySet<string> = new Set(['make_chart', 'open_canvas', 'propose_mission', 'workspace_save_report'])

export function processToolBodies(workspaceRoot: string): readonly MindTool[] {
  return [createChartTool(), createCanvasTool(), createMissionProposalTool(), createWorkspaceReportTool({ workspaceRoot })]
}
