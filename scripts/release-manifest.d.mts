export interface ReleaseArtifact {
  path: string
  bytes: number
  sha256: string
}
export interface ReleaseMetadata {
  revision: string
  dirty: boolean
  platform: string
  arch: string
}
export interface ReleaseManifest {
  schemaVersion: 1
  app: { name: string; version: string }
  source: { revision: string; dirty: boolean }
  target: { platform: string; arch: string }
  artifacts: ReleaseArtifact[]
}
export function sha256File(path: string): Promise<string>
export function collectReleaseArtifacts(root: string): Promise<ReleaseArtifact[]>
export function canonicalManifestJson(manifest: ReleaseManifest): string
export function buildReleaseManifest(root: string, metadata: ReleaseMetadata): Promise<ReleaseManifest>
export function sourceMetadata(root: string): ReleaseMetadata
