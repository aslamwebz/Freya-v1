/**
 * FREYA METACOGNITION — MetacognitionEngine
 *
 * Coordinates performance observation, weakness classification,
 * encrypted/ephemeral persistence, and metacognitive reporting.
 */

import type {
  ActiveStrategyRecord,
  FailedImprovementRecord,
  MetacognitiveReport,
  MetacognitiveSummary,
  PerformanceTelemetry,
  WeaknessRecord,
} from './types'
import { MemoryMetacognitionStore, type MetacognitionStore } from './store'
import { PerformanceObserver, type ObserveMissionOptions } from './observer'
import { WeaknessClassifier, type ClassifyWeaknessOptions } from './weakness'
import { MetacognitiveReporter } from './reporting'

export interface MetacognitionEngineOptions {
  readonly store?: MetacognitionStore
}

export class MetacognitionEngine {
  private readonly store: MetacognitionStore
  private readonly observer: PerformanceObserver
  private readonly classifier: WeaknessClassifier
  private readonly reporter: MetacognitiveReporter

  constructor(options?: MetacognitionEngineOptions) {
    this.store = options?.store ?? new MemoryMetacognitionStore()
    this.observer = new PerformanceObserver(this.store)
    this.classifier = new WeaknessClassifier(this.store)
    this.reporter = new MetacognitiveReporter(this.store)
  }

  get storeHealth() {
    return {
      mode: this.store.mode,
      durable: this.store.durable,
      faultReason: this.store.faultReason,
    }
  }

  async observeMission(options: ObserveMissionOptions): Promise<PerformanceTelemetry> {
    return await this.observer.observeMission(options)
  }

  async getTelemetries(): Promise<readonly PerformanceTelemetry[]> {
    return await this.observer.getRecentTelemetries()
  }

  async classifyWeaknesses(options?: ClassifyWeaknessOptions): Promise<readonly WeaknessRecord[]> {
    return await this.classifier.analyzeAndClassify(options)
  }

  async getSummary(): Promise<MetacognitiveSummary> {
    return await this.reporter.generateSummary()
  }

  async getReport(): Promise<MetacognitiveReport> {
    return await this.reporter.generateReport()
  }

  async recordActiveStrategy(strategy: ActiveStrategyRecord): Promise<void> {
    await this.store.writeActiveStrategy(strategy)
  }

  async recordFailedImprovement(failed: FailedImprovementRecord): Promise<void> {
    await this.store.writeFailedImprovement(failed)
  }

  // Metacognitive Questions
  async whatAreYouStrugglingWith(): Promise<string> {
    return await this.reporter.whatAreYouStrugglingWith()
  }

  async whatMistakesDoYouKeepMaking(): Promise<string> {
    return await this.reporter.whatMistakesDoYouKeepMaking()
  }

  async whatHaveYouImproved(): Promise<readonly ActiveStrategyRecord[]> {
    return await this.reporter.whatHaveYouImproved()
  }

  async whatEvidenceSupportsThat(id: string): Promise<readonly PerformanceTelemetry[]> {
    return await this.reporter.whatEvidenceSupportsThat(id)
  }

  async whichImprovementsFailed(): Promise<readonly FailedImprovementRecord[]> {
    return await this.reporter.whichImprovementsFailed()
  }

  async areYouBecomingMoreEfficient() {
    return await this.reporter.areYouBecomingMoreEfficient()
  }

  async whatShouldWeImproveNext(): Promise<WeaknessRecord | null> {
    return await this.reporter.whatShouldWeImproveNext()
  }

  async close(): Promise<void> {
    await this.store.close()
  }
}
