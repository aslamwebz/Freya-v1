import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { openDeviceHandsJournal, denyAllAuthority, type DeviceHandsEffects } from './devicehands'
import type { DeviceHandsHostOptions, ElectronCoreHost } from './coreHost'
type GrantFact = NonNullable<ReturnType<ElectronCoreHost['ownerBrowserGrant']>>

function splitDeviceHandsList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Strict unless asked: approvals, path roots and command rules stay on for every run,
 * packaged or from source. A developer who wants them off for capability testing sets
 * FREYA_LOCAL_UNRESTRICTED=1 on an unpackaged build; a packaged build is always strict.
 */
function localUnrestrictedMode(): boolean {
  return process.env.FREYA_LOCAL_UNRESTRICTED === '1' && !app.isPackaged
}

function readDeviceHandsGrants(path: string): GrantFact[] {
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is GrantFact => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  } catch {
    // A grant file that cannot be parsed is no grants, not a permissive default.
    return []
  }
}

export function buildRuntimeDeviceHands(profile: string, effects: DeviceHandsEffects, grant: (principal: string, scope: string) => GrantFact | null): DeviceHandsHostOptions | undefined {
  const localUnrestricted = localUnrestrictedMode()
  if (!localUnrestricted && process.env.FREYA_PUBLIC_BROWSER === '0' && process.env.FREYA_DEVICE_HANDS !== '1') return undefined
  const userData = profile
  const grants = localUnrestricted
    ? []
    : readDeviceHandsGrants(join(userData, 'device-hands.grants.json'))
  const journal = openDeviceHandsJournal(join(userData, 'device-hands.jsonl'))
  const authority = denyAllAuthority({
    enabled: () => true,
    activeGrant: (principalId, scope) =>
      grant(principalId, scope) ?? grants.find(
        (grant) => grant.principalId === principalId && grant.scope === scope && grant.revokedAt === null,
      ) ?? null,
  })
  return {
    effects,
    journal,
    authority,
    policy: localUnrestricted
      ? {
          localUnrestricted: true,
          allowedRoots: [],
          deniedRoots: [],
          allowedHosts: [],
          allowedCommands: [],
          allowedEnvNames: [],
        }
      : {
          ownerPublicBrowser: process.env.FREYA_PUBLIC_BROWSER !== '0',
          allowedRoots: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ROOTS),
          deniedRoots: [join(userData, 'vault')],
          allowedHosts: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_HOSTS),
          allowedCommands: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_COMMANDS),
          // Device Hands refuses an empty allowlist — correctly, since "nothing is shared"
          // must be a decision somebody made. A surface that genuinely shares nothing
          // therefore has to say so with a name it will never match, rather than with an
          // empty list the policy refuses outright. Without this, a strict build could
          // not start the browser at all and every page read arrived as
          // `authority-refused`, which reads like a permissions problem rather than a
          // list nobody filled in.
          allowedEnvNames: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ENV_NAMES),
        },
    grants,
    enabled: true,
    localUnrestricted,
  }
}
