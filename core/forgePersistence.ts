import { openForgePersistence } from './forge/persistence/open'
import type { ForgePersistencePort } from './forge/persistence/port'
import type { ForgeStoredPackage } from './forge/engine'

/**
 * Core's Forge persistence lifecycle. No journal, provider or renderer access.
 *
 * ## The rule it holds
 *
 * The encrypted store is a **cache of the engine's live body set**, and the journal
 * is the authority for status. A body recovered from disk is used only when the
 * fold says that package exists at that version *and* the bytes still hash to what
 * the journal recorded; anything else is discarded rather than adopted.
 *
 * That ordering is what makes an edited file harmless. Deleting the store loses
 * programs, not permissions: the fold still reports the packages, their statuses
 * and their validation verdicts, and every attempt to run one says its body is not
 * readable. The reverse ordering would let a file on disk reintroduce a package the
 * journal never recorded.
 */
export class ForgePersistenceRuntime {
  private tail: Promise<void> = Promise.resolve()
  private fault: string | null = null
  private closed = false

  private constructor(
    private readonly port: ForgePersistencePort,
    private readonly onHealthChange: () => void,
  ) {}

  static async open(options: {
    path: string
    key: Uint8Array | null
    onHealthChange?: () => void
  }): Promise<{ runtime: ForgePersistenceRuntime; packages: readonly ForgeStoredPackage[] }> {
    const port = openForgePersistence({ path: options.path, key: options.key })
    const runtime = new ForgePersistenceRuntime(port, options.onHealthChange ?? (() => {}))
    let packages: readonly ForgeStoredPackage[]
    try {
      const loaded = await port.load()
      if (!loaded.ok) {
        runtime.degrade()
        return { runtime, packages: [] }
      }
      packages = loaded.packages
    } catch {
      runtime.degrade()
      return { runtime, packages: [] }
    }
    return { runtime, packages }
  }

  health(): { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null } {
    const reason = this.fault ?? this.port.faultReason ?? this.port.durabilityReason
    return { mode: this.port.mode, durable: this.port.durable && reason === null, reason }
  }

  commit(packages: readonly ForgeStoredPackage[]): void {
    if (this.closed || this.fault !== null || this.port.faultReason !== null || !this.port.durable) return
    const port = this.port
    this.tail = this.tail.then(async () => {
      if (this.fault !== null) return
      try {
        await port.commit(packages)
      } catch {
        this.degrade()
      }
    })
  }

  flush(): Promise<void> {
    return this.tail
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
    await this.port.close()
  }

  private degrade(): void {
    // A fixed sentence rather than the underlying error: a decoder or filesystem
    // message can echo private input, and "storage is unavailable" is the only
    // thing a person needs to read here.
    if (this.fault !== null) return
    this.fault =
      'encrypted Forge storage is unavailable; packages are held in this process only and none can run after a restart'
    this.onHealthChange()
  }
}
