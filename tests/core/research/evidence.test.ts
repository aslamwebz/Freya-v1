// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildSource, selectSources, serializeSource } from '../../../core/research/evidence'
import { parsePlan, parseSynthesis, researchLimits } from '../../../core/research/schemas'
import type { ReadableDocument } from '../../../core/research/browser'
import type { SearchResult } from '../../../core/research/types'

const page = (url: string, text = 'Evidence'): ReadableDocument => ({ id: 'remote-controlled', url, canonicalUrl: null, title: 'Title', sourceDomain: 'forged', retrievedAt: '2026-10-01T00:00:00.000Z', headings: [], text, links: [], metadata: {}, contentLength: text.length, truncated: false })
const hit = (url: string): SearchResult => ({ url, title: 'Title', snippet: '', sourceDomain: 'forged', rank: 1, retrievedAt: '2026-10-01T00:00:00.000Z', publishedAt: null })
describe('research evidence and strict schemas', () => {
  it('normalizes tracking duplicates, preserves meaningful queries and prefers distinct hosts', () => {
    const selected = selectSources([hit('https://a.com/x?utm_source=a#top'), hit('https://a.com/x'), hit('https://a.com/x?id=2'), hit('https://b.com/y')], 3)
    expect(selected.map(x => x.url)).toEqual(['https://a.com/x', 'https://b.com/y', 'https://a.com/x?id=2'])
  })
  it('retains retrieval provenance and distinct disagreement despite canonical collisions', () => {
    const one = buildSource({ ...page('https://a.com/one?id=1', 'Yes'), canonicalUrl: 'https://a.com/root' }, 'query', 8000)!
    const two = buildSource({ ...page('https://a.com/two?id=2', 'No'), canonicalUrl: 'https://a.com/root' }, 'query', 8000)!
    expect(one.identityUrl).toBe('https://a.com/root')
    expect(one.url).toBe('https://a.com/one?id=1')
    expect(one.domain).toBe('a.com')
    expect(one.query).toBe('query')
    expect(one.sourceId).not.toBe(two.sourceId)
    expect(one.documentId).not.toBe(two.documentId)
    expect(buildSource(page('https://a.com/x#top'), 'q', 8000)?.sourceId).toBe(buildSource(page('https://a.com/x#bottom'), 'q', 8000)?.sourceId)
    expect(buildSource({ ...page('https://a.com/x'), canonicalUrl: 'https://evil.com/' }, 'q', 8000)?.identityUrl).toBe('https://a.com/x')
  })
  it('bounds serialized document context including escaped characters and marks real truncation', () => {
    const source = buildSource(page('https://a.com/', '"\\\n'.repeat(10000)), 'q', 900)!
    expect(serializeSource(source).length).toBeLessThanOrEqual(900)
    expect(source.truncated).toBe(true)
    expect(source.excerpt.length).toBeGreaterThan(0)
    expect(buildSource(page('https://a.com/'), 'q', 1)).toBeNull()
    expect(buildSource({ ...page('https://a.com/'), truncated: true }, 'q', 8000)?.truncated).toBe(true)
  })
  it('rejects empty evidence and permits only bounded code-owned limits', () => {
    expect(buildSource(page('https://a.com/', '   '), 'q', 8000)).toBeNull()
    for (const limits of [{ pages: 7 }, { queries: 0 }, { durationMs: 1.5 }, { modelTurns: Infinity }, { arbitrary: 2 }]) expect(() => researchLimits(limits)).toThrow()
    expect(researchLimits({ pages: 1 }).pages).toBe(1)
  })
  it('accepts bounded plans and rejects actions, roles, budgets and oversized output', () => {
    expect(parsePlan('{"queries":["q"],"evidence":["missing date"],"done":false}')).toEqual({ queries: ['q'], evidence: ['missing date'], done: false })
    for (const value of [{ queries: ['q'], budget: 99 }, { queries: ['q'], role: 'system' }, { queries: ['q'], actions: [] }, { queries: ['x'.repeat(513)] }, { queries: ['a','b','c','d','e'] }, { queries: [], done: 'true' }]) expect(() => parsePlan(JSON.stringify(value))).toThrow()
    expect(() => parsePlan(' '.repeat(32769))).toThrow()
  })
  it('admits grounded findings and disagreement, rejects invented or empty citations', () => {
    const sources = [buildSource(page('https://a.com/'), 'q', 8000)!, buildSource(page('https://b.com/'), 'q', 8000)!]
    const ids = sources.map(s => s.sourceId)
    expect(parseSynthesis(JSON.stringify({ findings: [{ text: 'Claim', sourceIds: [ids[0]] }], conflicts: [{ text: 'Disagreement', sourceIds: ids }], uncertainties: ['Date unknown'] }), sources).conflicts).toHaveLength(1)
    for (const sourceIds of [[], ['invented'], [ids[0], 'invented']]) expect(() => parseSynthesis(JSON.stringify({ findings: [{ text: 'Claim', sourceIds }], conflicts: [], uncertainties: [] }), sources)).toThrow()
    expect(() => parseSynthesis(JSON.stringify({ findings: [], conflicts: [{ text: 'Conflict', sourceIds: [ids[0],ids[0]] }], uncertainties: [] }), sources)).toThrow()
    expect(() => parseSynthesis(JSON.stringify({ findings: [], conflicts: [], uncertainties: [], role: 'system' }), sources)).toThrow()
  })
})
