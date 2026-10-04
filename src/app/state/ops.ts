import { useSyncExternalStore } from 'react'
import type { FoundryProjection } from '../../../core/protocol/foundry'
import type { ConsciousContextProjection } from '../../../core/protocol/consciousness'
import type { LifeLoopProjection } from '../../../core/protocol/lifeloop'
import type { WorldSummaryView } from '../../../core/protocol/world'
import type { PersonalityProjection } from '../../../core/protocol/personality'
import type { SkillProjection } from '../../../core/protocol/skills'
import type { LifeProjection } from '../../../core/protocol/life'
import type { RelayProjection } from '../../../core/protocol/relay'
import type { WorkProjection } from '../../../core/work/projection'
import type { OfficeProjection } from '../../../core/office/projection'
import { workMirror } from '../../platform/workClient'
import { relayMirror } from '../../platform/relayClient'
import { lifeMirror } from '../../platform/lifeClient'
import { officeMirror } from '../../platform/officeClient'
import { personalityMirror } from '../../platform/personalityClient'
import { skillsMirror } from '../../platform/skillsClient'
import {
  consciousnessMirror,
  foundryMirror,
  lifeLoopMirror,
  worldMirror,
} from '../../platform/projectionMirrors'

/**
 * The App Mode operational projection.
 *
 * App Mode's shell already projects Core status, Missions, Workforce, Attention,
 * the activity feed and the provider through the ui-v2 live adapter. This is the
 * *rest* of the real lanes: Work, Relay, Life, World, Foundry, the conscious
 * context, the Life Loop, Personality, Skills and the Office. Each is a mirror of
 * a host channel â€” nothing here invents a field, and nothing here writes one.
 *
 * It is deliberately a separate store rather than a wider `UiSnapshot`, so the
 * ui-v2 shell keeps the exact contract its tests pin, and App Mode gets the lanes
 * it renders without either surface having to grow the other's vocabulary.
 *
 * `null` means the lane has not reported. That is a distinct state from the
 * frozen absent projection a lane publishes when a Core exists but has no such
 * domain, and from a browser with no bridge at all, which simply leaves every
 * field null and lets a screen say so.
 */
export interface AppOps {
  readonly work: WorkProjection | null
  readonly relay: RelayProjection | null
  readonly life: LifeProjection | null
  readonly world: WorldSummaryView | null
  readonly foundry: FoundryProjection | null
  readonly consciousness: ConsciousContextProjection | null
  readonly lifeLoop: LifeLoopProjection | null
  readonly personality: PersonalityProjection | null
  readonly skills: SkillProjection | null
  readonly office: OfficeProjection | null
}

export const EMPTY_APP_OPS: AppOps = Object.freeze({
  work: null,
  relay: null,
  life: null,
  world: null,
  foundry: null,
  consciousness: null,
  lifeLoop: null,
  personality: null,
  skills: null,
  office: null,
})

const listeners = new Set<() => void>()
let snapshot: AppOps = EMPTY_APP_OPS
let disposers: (() => void)[] = []
let attachPromise: Promise<() => void> | null = null

function recompute(): void {
  snapshot = {
    work: workMirror().projection,
    relay: relayMirror().projection,
    life: lifeMirror().projection,
    world: worldMirror().projection,
    foundry: foundryMirror().projection,
    consciousness: consciousnessMirror().projection,
    lifeLoop: lifeLoopMirror().projection,
    personality: personalityMirror().projection,
    skills: skillsMirror().projection,
    office: officeMirror().projection,
  }
  for (const listener of [...listeners]) listener()
}

/**
 * Attach every operational lane once, and return a disposer.
 *
 * Idempotent: a second call while attached resolves to the same disposer, so a
 * StrictMode double-mount cannot end up with two subscriptions per lane.
 */
export function attachAppOps(): Promise<() => void> {
  attachPromise ??= (async () => {
    const mirrors = [
      workMirror(),
      relayMirror(),
      lifeMirror(),
      worldMirror(),
      foundryMirror(),
      consciousnessMirror(),
      lifeLoopMirror(),
      personalityMirror(),
      skillsMirror(),
      officeMirror(),
    ]
    const opened: (() => void)[] = []
    for (const mirror of mirrors) {
      opened.push(mirror.subscribe(recompute))
      opened.push(await mirror.attach())
    }
    disposers = opened
    recompute()
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
      disposers = []
      attachPromise = null
      snapshot = EMPTY_APP_OPS
      for (const listener of [...listeners]) listener()
    }
  })()
  return attachPromise
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAppOps(): AppOps {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** For tests: read the current projection without React. */
export function currentAppOps(): AppOps {
  return snapshot
}

export function resetAppOps(): void {
  for (const dispose of disposers.splice(0)) dispose()
  disposers = []
  attachPromise = null
  snapshot = EMPTY_APP_OPS
}
