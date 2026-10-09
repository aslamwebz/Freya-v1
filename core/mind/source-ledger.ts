import type { ToolObservation, ToolSource } from './tools'

/** Citation identity belongs to the whole turn, rather than each lookup. */
export class SourceLedger {
  private readonly ranks = new Map<string, number>()
  private readonly usedRanks = new Set<number>()
  private nextRank = 1

  constructor(carried: readonly ToolSource[] = []) {
    for (const source of carried) {
      this.ranks.set(source.url, source.rank)
      this.usedRanks.add(source.rank)
    }
  }

  observation(value: ToolObservation): ToolObservation {
    if (value.kind !== 'ok') return value
    return { ...value, sources: value.sources.map(source => {
      let rank = this.ranks.get(source.url)
      if (rank === undefined) {
        while (this.usedRanks.has(this.nextRank)) this.nextRank += 1
        rank = this.nextRank++
        this.usedRanks.add(rank)
        this.ranks.set(source.url, rank)
      }
      return { ...source, rank }
    }) }
  }
}
