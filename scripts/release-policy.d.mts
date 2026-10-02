export const ALLOWED_INSTALL_SCRIPT_PACKAGES: ReadonlySet<string>
export const PERFORMANCE_BUDGETS: Readonly<{
  mainBytes: number
  preloadBytes: number
  presencePreloadBytes: number
  largestRendererJsBytes: number
  rendererTotalBytes: number
}>
export interface BoundaryFile { path: string; source: string }
export function inspectLockfile(pkg: Record<string, unknown>, lock: Record<string, unknown>): string[]
export function inspectCoreBoundary(files: readonly BoundaryFile[]): string[]
export function coreSourceFiles(root: string): Promise<BoundaryFile[]>
export function artifactMeasurements(root: string): Promise<{
  mainBytes: number
  preloadBytes: number
  presencePreloadBytes: number
  largestRendererJsBytes: number
  rendererTotalBytes: number
}>
export function inspectPerformance(measured: Record<string, number>, budgets?: Record<string, number>): string[]
