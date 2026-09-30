import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The conversation master key.
 *
 * This is the one place in Freya that handles a secret, and it lives in the main
 * process on purpose: the renderer is disposable and possibly compromised, and
 * nothing in `core/` imports Electron at all. Core receives the key as bytes
 * through dependency injection and cannot persist, log, journal or forward it.
 *
 * ## The design
 *
 *   256-bit random key
 *          ↓
 *   wrapped by the OS secure storage      ← DPAPI / Keychain / libsecret
 *          ↓
 *   written beside the conversation store
 *
 * The key file on disk is worthless on its own: it is encrypted by the operating
 * system's credential store, which is tied to the user account. Copying
 * `conversations.enc` and `conversations.key` to another machine, or another
 * account, yields nothing readable.
 *
 * ## When the OS says no
 *
 * `safeStorage.isEncryptionAvailable()` is false on some Linux configurations
 * with no keyring. The honest response is to return **no key**, which makes Core
 * fall back to an ephemeral in-memory conversation store that labels itself as
 * such. The alternative — writing the key next to the data it protects, or
 * writing the conversation in plaintext — would be a worse bug than forgetting a
 * conversation, and neither is offered as a fallback here.
 *
 * Nothing in this file logs, returns, or formats the key. The returned bytes go
 * straight into Core.
 */

const KEY_BYTES = 32

export interface ConversationKeyResult {
  /** Null when no secure key is available. Never a plaintext substitute. */
  key: Uint8Array | null
  /** Why there is no key, in words a person can act on. Null when there is one. */
  reason: string | null
}

export async function loadConversationKey(dataPath: string): Promise<ConversationKeyResult> {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      key: null,
      reason:
        'this machine has no OS secure storage available, so Freya cannot encrypt ' +
        'conversation history and will not save it',
    }
  }

  const path = `${dataPath}.key`
  try {
    if (existsSync(path)) {
      const wrapped = await readFile(path)
      // `decryptString` returns '' for input it cannot open, so a truncated or
      // tampered key file is treated as unusable rather than as an empty key.
      const plaintext = safeStorage.decryptString(wrapped)
      if (plaintext.length === 0) {
        return {
          key: null,
          reason:
            'the stored conversation key could not be decrypted, so conversation history ' +
            'cannot be read or safely written',
        }
      }
      const bytes = Buffer.from(plaintext, 'base64')
      if (bytes.length !== KEY_BYTES) {
        return {
          key: null,
          reason: 'the stored conversation key is the wrong length and will not be used',
        }
      }
      return { key: new Uint8Array(bytes), reason: null }
    }

    // First run. A fresh 256-bit key, wrapped by the OS before it touches disk.
    const generated = randomBytes(KEY_BYTES)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, safeStorage.encryptString(generated.toString('base64')), {
      encoding: 'utf8',
      mode: 0o600,
    })
    return { key: new Uint8Array(generated), reason: null }
  } catch (error) {
    return {
      key: null,
      reason: `the conversation key could not be prepared: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    }
  }
}
