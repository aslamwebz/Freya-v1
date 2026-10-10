import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, normalize, basename, extname } from 'node:path'
import type { MindTool } from './tools'
import { DENIED_PATH_SEGMENTS, DENIED_PATH_SEGMENT_PATTERNS } from '../devicehands/paths'

export interface WorkspaceReportToolOptions {
  readonly workspaceRoot: string
}

const SAFE_FILENAME = /^[A-Za-z0-9_.-]{1,80}$/

export function createWorkspaceReportTool(options: WorkspaceReportToolOptions): MindTool {
  const root = resolve(options.workspaceRoot)

  return {
    name: 'workspace_save_report',
    capability: 'workspace.report.save',
    description:
      'Save a generated research, analysis, or comparison report to the owner\'s approved workspace directory. ' +
      'Only .md and .txt files are permitted. Filenames must be safe relative names without path traversal.',
    parameters: [
      {
        name: 'filename',
        description: 'The target filename, ending in .md or .txt (e.g. "three-technologies-comparison.md"). No directories.',
        required: true,
        maxChars: 80,
      },
      {
        name: 'content',
        description: 'The markdown or text report content to write to the file.',
        required: true,
        maxChars: 32_000,
        multiline: true,
      },
    ],
    async run(request) {
      const rawName = (request.arguments['filename'] ?? '').trim()
      const content = request.arguments['content'] ?? ''

      if (!rawName) {
        throw new Error('A filename is required.')
      }

      const name = basename(rawName)
      if (name !== rawName || !SAFE_FILENAME.test(name)) {
        throw new Error(`Filename "${rawName}" is invalid. Provide a simple filename without path traversal or separators.`)
      }

      const ext = extname(name).toLowerCase()
      if (ext !== '.md' && ext !== '.txt') {
        throw new Error(`File extension "${ext}" is not permitted. Only .md and .txt reports may be saved.`)
      }

      // Check denied segments
      const lower = name.toLowerCase()
      for (const denied of DENIED_PATH_SEGMENTS) {
        if (lower.includes(denied.toLowerCase())) {
          throw new Error(`Filename "${name}" contains restricted keyword "${denied}".`)
        }
      }
      for (const pattern of DENIED_PATH_SEGMENT_PATTERNS) {
        const cleanPat = pattern.replace(/\*/g, '.*')
        if (new RegExp(cleanPat, 'i').test(lower)) {
          throw new Error(`Filename "${name}" matches restricted pattern "${pattern}".`)
        }
      }

      // Resolve target path strictly inside root
      const targetPath = resolve(root, name)
      const normalizedRoot = normalize(root)
      const normalizedTarget = normalize(targetPath)
      if (!normalizedTarget.startsWith(normalizedRoot)) {
        throw new Error('Path traversal detected: destination must be inside the approved workspace.')
      }

      await mkdir(root, { recursive: true })
      await writeFile(targetPath, content, 'utf8')

      const bytes = Buffer.byteLength(content, 'utf8')
      const summary = `Successfully saved report "${name}" (${bytes} bytes) to approved workspace.`

      return {
        summary,
        sources: [],
        provenance: {
          actor: 'workspace_save_report',
          steps: [`Wrote ${bytes} bytes to approved workspace file "${name}".`],
        },
      }
    },
  }
}
