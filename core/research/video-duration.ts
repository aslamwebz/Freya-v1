export interface VideoDurationConstraint { readonly text: string; readonly seconds: number; readonly comparison: 'gt' | 'gte' | 'lt' | 'lte' }

export function videoDurationConstraint(text: string): VideoDurationConstraint | null {
  const match = /\b(over|longer than|more than|at least|minimum(?: of)?|under|shorter than|less than|at most|maximum(?: of)?)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|minues|seconds?|secs?)\b/i.exec(text)
  if (!match) return null
  const amount = Number(match[2])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const factor = /^h/i.test(match[3]!) ? 3600 : /^m/i.test(match[3]!) ? 60 : 1
  const word = match[1]!.toLowerCase()
  return { text: match[0], seconds: amount * factor, comparison: /^(at least|minimum)/.test(word) ? 'gte' : /^(at most|maximum)/.test(word) ? 'lte' : /^(under|shorter|less)/.test(word) ? 'lt' : 'gt' }
}

/** Metadata only: unknown, live, ambiguous and malformed durations stay unknown. */
export function parseVideoDuration(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const text = String(raw).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) > 0 ? Number(text) : null
  if (/^\d+:\d{2}(?::\d{2})?$/.test(text)) {
    const parts = text.split(':').map(Number)
    if (parts.slice(1).some(part => part >= 60)) return null
    return parts.reduce((value, part) => value * 60 + part, 0) || null
  }
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text)
  if (iso) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0) || null
  const units = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)]
  if (!units.length || text.replace(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi, '').trim()) return null
  return units.reduce((total, match) => total + Number(match[1]) * (/^h/i.test(match[2]!) ? 3600 : /^m/i.test(match[2]!) ? 60 : 1), 0) || null
}

export function matchesVideoDuration(raw: unknown, constraint: VideoDurationConstraint): boolean {
  const seconds = parseVideoDuration(raw)
  if (seconds === null) return false
  return constraint.comparison === 'gt' ? seconds > constraint.seconds : constraint.comparison === 'gte' ? seconds >= constraint.seconds : constraint.comparison === 'lt' ? seconds < constraint.seconds : seconds <= constraint.seconds
}
