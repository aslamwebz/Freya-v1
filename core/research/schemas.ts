import { ResearchError } from './errors'
import type { ResearchSource } from './evidence'

export const RESEARCH_LIMITS = Object.freeze({
  iterations: 2, queries: 4, results: 24, pages: 6, evidenceChars: 48000,
  durationMs: 120000, modelTurns: 5, failures: 4, documentChars: 8000, maxOutputTokens: 2048,
})
export type ResearchLimits = { [K in keyof typeof RESEARCH_LIMITS]: number }
export function researchLimits(overrides: Partial<ResearchLimits> = {}): Readonly<ResearchLimits> {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new ResearchError('invalid_response')
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(RESEARCH_LIMITS, key) || !Number.isInteger(value) || value <= 0 || value > RESEARCH_LIMITS[key as keyof ResearchLimits]) throw new ResearchError('invalid_response')
  }
  return Object.freeze({ ...RESEARCH_LIMITS, ...overrides })
}
export interface ResearchPlan { queries: string[]; evidence?: string[]; done?: boolean }
export interface ResearchFinding { text: string; sourceIds: string[] }
export interface ResearchSynthesis { findings: ResearchFinding[]; conflicts: ResearchFinding[]; uncertainties: string[] }

function invalid(): never { throw new ResearchError('invalid_response') }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value as Record<string, unknown>
}
function strings(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > count) return invalid()
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.length > length) return invalid()
    return item.trim()
  })
}
function decode(text: string): unknown {
  if (typeof text !== 'string' || text.length > 32768) return invalid()
  try { return JSON.parse(text) as unknown } catch { return invalid() }
}
export function parsePlan(text: string): ResearchPlan {
  const value = object(decode(text), ['queries', 'evidence', 'done'])
  const queries = strings(value.queries, 4, 512)
  if (value.done !== undefined && typeof value.done !== 'boolean') return invalid()
  return { queries, ...(value.evidence === undefined ? {} : { evidence: strings(value.evidence, 8, 512) }), ...(value.done === undefined ? {} : { done: value.done as boolean }) }
}
export function parseSynthesis(text: string, sources: readonly ResearchSource[]): ResearchSynthesis {
  const value = object(decode(text), ['findings', 'conflicts', 'uncertainties'])
  const known = new Set(sources.filter(source => source.excerpt.trim()).map(source => source.sourceId))
  function findings(input: unknown, max: number, minimum: number): ResearchFinding[] {
    if (!Array.isArray(input) || input.length > max) return invalid()
    return input.map(item => {
      const row = object(item, ['text', 'sourceIds'])
      const text = strings([row.text], 1, 2048)[0]!
      const sourceIds = [...new Set(strings(row.sourceIds, 6, 128))]
      if (sourceIds.length < minimum || sourceIds.some(id => !known.has(id))) return invalid()
      return { text, sourceIds }
    })
  }
  return { findings: findings(value.findings, 24, 1), conflicts: findings(value.conflicts, 12, 2), uncertainties: strings(value.uncertainties, 16, 1024) }
}
