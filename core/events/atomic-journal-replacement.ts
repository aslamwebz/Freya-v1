import { randomUUID } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'

/** A recognized integrity defect remains unresolved if its repair cannot be persisted. */
export class JournalRepairError extends Error {
  constructor(cause: unknown) {
    super('known journal repair could not be made durable', { cause })
    this.name = 'JournalRepairError'
  }
}

/** Exclusive filenames and fsync keep earlier recovery evidence intact. */
export async function preserveJournalBytes(file: string, tag: string, raw: Buffer, note: string): Promise<string> {
  const target = `${file}.${tag}.${randomUUID()}`
  try {
    await writeSynced(target, raw)
    await writeSynced(`${target}.txt`, Buffer.from(note, 'utf8'))
    return target
  } catch (error) { throw new JournalRepairError(error) }
}

/** The active file is always either the entire original or the entire replacement. */
export async function replaceJournalAtomically(file: string, expected: Buffer, replacement: string): Promise<void> {
  const temporary = `${file}.repair-temp.${randomUUID()}`
  try {
    await writeSynced(temporary, Buffer.from(replacement, 'utf8'))
    if (!(await readFile(file)).equals(expected)) throw new Error('journal changed while preparing its repair')
    // Never remove the active journal first: a failed rename leaves it untouched.
    await rename(temporary, file)
  } catch (error) {
    throw new JournalRepairError(error)
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw new JournalRepairError(error)
    })
  }
}

async function writeSynced(path: string, raw: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(raw); await handle.sync() }
  finally { await handle.close() }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}
