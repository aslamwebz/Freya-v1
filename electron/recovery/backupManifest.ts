import { basename, dirname, join } from 'node:path'

export type BackupClass = 'journal' | 'encrypted-domain' | 'protected-keyring' | 'workspace'
export type RestoreMode = 'same-profile' | 'migration'

export interface BackupEntry {
  readonly path: string
  readonly class: BackupClass
  readonly requiredForCompleteRestore: boolean
  readonly portableAcrossProfiles: boolean
}

export function backupManifest(dataPath: string): readonly BackupEntry[] {
  const dir = dirname(dataPath)
  const entries: BackupEntry[] = [
    { path: dataPath, class: 'journal', requiredForCompleteRestore: true, portableAcrossProfiles: true },
    { path: `${dataPath}.conversations`, class: 'encrypted-domain', requiredForCompleteRestore: false, portableAcrossProfiles: true },
    { path: `${dataPath}.brain`, class: 'encrypted-domain', requiredForCompleteRestore: false, portableAcrossProfiles: true },
    { path: `${dataPath}.missions`, class: 'encrypted-domain', requiredForCompleteRestore: false, portableAcrossProfiles: true },
    { path: `${dataPath}.context.enc`, class: 'encrypted-domain', requiredForCompleteRestore: false, portableAcrossProfiles: true },
    { path: `${dataPath}.personality.enc`, class: 'encrypted-domain', requiredForCompleteRestore: false, portableAcrossProfiles: true },
    { path: join(dir, 'freya.keyring.json'), class: 'protected-keyring', requiredForCompleteRestore: true, portableAcrossProfiles: false },
    { path: join(dir, 'workspace.json'), class: 'workspace', requiredForCompleteRestore: false, portableAcrossProfiles: true },
  ]
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

export function validateRestoreSet(
  dataPath: string,
  presentPaths: ReadonlySet<string>,
  mode: RestoreMode = 'same-profile',
): readonly string[] {
  const manifest = backupManifest(dataPath)
  const failures: string[] = []

  if (mode === 'migration') {
    failures.push('cross-profile migration is not supported: freya.keyring.json is protected by OS secure storage and is not portable')
  }

  for (const entry of manifest) {
    if (entry.requiredForCompleteRestore && !presentPaths.has(entry.path)) {
      failures.push(`missing required restore component: ${entry.path}`)
    }
  }

  const encrypted = manifest.some((entry) => entry.class === 'encrypted-domain' && presentPaths.has(entry.path))
  const keyring = manifest.find((entry) => entry.class === 'protected-keyring')
  if (encrypted && keyring && !presentPaths.has(keyring.path)) {
    failures.push('encrypted domain files are present without the protected keyring; do not claim a complete restore')
  }
  if (!presentPaths.has(dataPath)) {
    failures.push(`the event journal ${basename(dataPath)} is absent; durable security state cannot be reconstructed`)
  }
  return Object.freeze(failures)
}
