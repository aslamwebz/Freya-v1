import type { MindTool, ToolProvenance } from './types'
import { MIND_TOOL_LIMITS } from './limits'
import { EXTRACT_CUT_MARKER } from './markers'
import { sanitiseUntrustedText, sanitiseArgumentText } from './text'

/**
 * Bound a tool's provenance, dropping anything it did not shape like provenance.
 *
 * `actor` is a name, not a report, so it gets a short bound. `steps` and `extract` are
 * quoted material and get the sanitising treatment: control characters flattened, the
 * envelope markers defanged, and each list **truncated rather than sliced at a character
 * boundary** — a truncated list says the rest existed, which is the difference between a
 * bound and a lie.
 */
export function boundProvenance(value: ToolProvenance | undefined): ToolProvenance | undefined {
  if (value === undefined || typeof value !== 'object' || value === null) return undefined

  const actor =
    typeof value.actor === 'string'
      ? sanitiseUntrustedText(value.actor, MIND_TOOL_LIMITS.maxProvenanceActorChars)
      : ''

  const steps = boundLines(value.steps, MIND_TOOL_LIMITS.maxProvenanceSteps, MIND_TOOL_LIMITS.maxProvenanceStepChars)
  const extract: string[] = []
  let extractChars = 0
  let extractCut = false
  const rawExtract = Array.isArray(value.extract) ? value.extract : []
  for (const line of rawExtract) {
    if (extract.length >= MIND_TOOL_LIMITS.maxProvenanceExtractLines) {
      extractCut = true
      break
    }
    if (typeof line !== 'string') continue
    const remaining = MIND_TOOL_LIMITS.maxProvenanceExtractChars - extractChars
    if (remaining <= 0) {
      extractCut = true
      break
    }
    const bounded = sanitiseUntrustedText(line, remaining)
    if (bounded === '') continue
    // Shorter than it arrived means the bound cut it. Compared rather than inferred from a
    // trailing ellipsis, because a page may legitimately end in one and a quote that was
    // silently shortened is the exact thing the marker exists to prevent.
    if (bounded.length < line.length) extractCut = true
    extract.push(bounded)
    extractChars += bounded.length
  }
  if (rawExtract.length > extract.length) extractCut = true

  return {
    ...(actor === '' ? {} : { actor }),
    ...(steps.length === 0 ? {} : { steps }),
    ...(extract.length === 0 ? {} : { extract }),
    ...(extractCut ? { extract: [...extract, EXTRACT_CUT_MARKER] } : {}),
  }
}

/** Take at most `limit` non-empty strings, each bounded, and say whether any were dropped. */
function boundLines(value: unknown, limit: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const line of value) {
    if (out.length >= limit) break
    if (typeof line !== 'string') continue
    const bounded = sanitiseUntrustedText(line, maxChars)
    if (bounded === '') continue
    out.push(bounded)
  }
  return out
}

/**
 * Keep only the tool's own declared parameters, bounded.
 *
 * Two directions, both needed: an argument the tool never declared is dropped
 * (so a model cannot smuggle an extra instruction into a tool's inputs), and a
 * declared argument that is missing or oversized is dropped (so the tool decides
 * what to do about a missing required one, rather than receiving a surprise).
 */
export function boundArguments(tool: MindTool, args: Readonly<Record<string, string>>): Record<string, string> {
  const declared = new Map(tool.parameters.map((parameter) => [parameter.name, parameter]))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    const parameter = declared.get(key)
    if (parameter === undefined) continue
    if (typeof value !== 'string') continue
    // The per-parameter bound, and newlines kept only for a parameter that is a
    // list. `sanitiseArgumentText` still defangs the envelope markers, so a value
    // cannot smuggle protocol syntax into a tool's inputs either way.
    const bounded = sanitiseArgumentText(
      value,
      parameter.maxChars ?? MIND_TOOL_LIMITS.maxArgumentChars,
      parameter.multiline === true,
    )
    if (bounded.length === 0) continue
    out[key] = bounded
  }
  return out
}
