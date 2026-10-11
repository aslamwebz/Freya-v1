import type { ProcessObservation } from '../shared/contracts/control-center'
export function requireSelectedProfile(exists: boolean, initialize: boolean): void
export function formatHeartbeat(observations: ProcessObservation[], at: string): string
export function redactRuntimeOutput(line: string, secrets?: string[]): string
