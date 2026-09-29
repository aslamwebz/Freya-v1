import type * as THREE from 'three'

/** The contract every centrepiece implements. */
export interface VoiceLevels {
  user: number
  ai: number
  morph: number
}

export interface BuildContext {
  world: THREE.Group
  /** Vertical centre of the centrepiece. */
  height: number
  random: () => number
  pixelRatio: number
}

export type Readout = [label: string, value: (t: number, activity: number, voice: VoiceLevels) => string]

export interface Centerpiece {
  group: THREE.Group
  /** Whether the surrounding instrument rings should be visible. */
  hud: boolean
  labels: Readout[]
  update(time: number, delta: number, voice: VoiceLevels, activity: number): void
}
