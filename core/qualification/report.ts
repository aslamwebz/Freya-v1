import type { QualificationReport } from './verdict'
import { READINESS_STATES } from './types'

/**
 * The human-readable report.
 *
 * Markdown is rendered from the same report object the JSON is, never from the
 * runner's own running state, so the two can never describe different runs. Where the
 * two could disagree the function is deterministic and has no inputs beyond the report.
 *
 * The ordering rules are deliberate:
 *
 *   1. The verdict, first, on its own line.
 *   2. What that verdict was decided on: the gate states, then the capability
 *      readiness, then the reasons.
 *   3. Only then the detail.
 *
 * A reader who stops after the first section must still have been told the truth.
 */

const STATE_MARK: Readonly<Record<string, string>> = Object.freeze({
  pass: 'pass',
  fail: '**FAIL**',
  degraded: 'degraded',
  blocked: 'blocked',
  unavailable: 'unavailable',
  'not-run': 'not-run',
})

function mark(state: string): string {
  return STATE_MARK[state] ?? state
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function qualificationMarkdown(report: QualificationReport): string {
  const lines: string[] = []

  lines.push('# Release qualification')
  lines.push('')
  lines.push(
    report.verdict === 'ship'
      ? '## Verdict: ship'
      : '## Verdict: no-ship',
  )
  lines.push('')
  if (report.verdict === 'ship') {
    lines.push(
      'Every required gate executed in this run and proved its claim, and every capability the release declared shipping is genuinely running.',
    )
  } else {
    lines.push(
      `${String(report.reasons.length)} reason(s) below. A gate that did not run, could not run, or ran and did not prove its claim is not a pass.`,
    )
  }
  lines.push('')

  lines.push('## Gate states')
  lines.push('')
  lines.push('| state | gate | kind | claim |')
  lines.push('| --- | --- | --- | --- |')
  for (const gate of report.gates) {
    lines.push(
      `| ${mark(gate.state)} | \`${gate.id}\` | ${gate.kind} | ${oneLine(gate.claim)} |`,
    )
  }
  lines.push('')

  lines.push('## Capability readiness')
  lines.push('')
  lines.push(
    `Counts: ${READINESS_STATES.map((state) => `${String(report.readinessCounts[state] ?? 0)} ${state}`).join(', ')}.`,
  )
  lines.push('')
  lines.push('| capability | family | readiness | release claim | reason |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const capability of report.capabilities) {
    lines.push(
      `| \`${capability.id}\` | ${capability.family} | **${capability.readiness}** | ${capability.claim} | ${oneLine(capability.reason)} |`,
    )
  }
  lines.push('')

  lines.push('## Why this verdict')
  lines.push('')
  if (report.reasons.length === 0) {
    lines.push('Nothing is outstanding. Every required gate passed and every shipping claim is met.')
  } else {
    for (const reason of report.reasons) lines.push(`- **${reason.kind}** — ${reason.subject}: ${oneLine(reason.detail)}`)
  }
  lines.push('')

  lines.push('## Declared shipping scope')
  lines.push('')
  lines.push('| capability | claim | reason |')
  lines.push('| --- | --- | --- |')
  for (const declaration of report.scope) {
    lines.push(`| \`${declaration.id}\` | ${declaration.claim} | ${oneLine(declaration.reason)} |`)
  }
  lines.push('')

  lines.push('## Gate detail')
  lines.push('')
  for (const gate of report.gates) {
    lines.push(`### \`${gate.id}\` — ${gate.title}`)
    lines.push('')
    lines.push(`- claim: ${oneLine(gate.claim)}`)
    lines.push(`- state: **${mark(gate.state)}**`)
    lines.push(
      `- command: ${gate.command === null ? 'none declared' : `\`${gate.command.join(' ')}\``}`,
    )
    lines.push(
      `- exit: ${gate.exitCode === null ? 'no process ran' : String(gate.exitCode)} in ${gate.durationMs === null ? 'unknown' : String(gate.durationMs)}ms`,
    )
    lines.push(`- detail: ${oneLine(gate.detail)}`)
    if (gate.blockedBy.length > 0) {
      lines.push(`- not run because: ${gate.blockedBy.map((id) => `\`${id}\``).join(', ')}`)
    }
    lines.push(`- evidence for: ${gate.capabilities.length === 0 ? 'no named capability' : gate.capabilities.map((id) => `\`${id}\``).join(', ')}`)
    if (gate.output.length > 0) {
      lines.push('')
      lines.push('```')
      for (const line of gate.output) lines.push(line)
      lines.push('```')
    }
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}