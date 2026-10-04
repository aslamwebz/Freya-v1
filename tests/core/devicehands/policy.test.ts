// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  checkClipboardText,
  checkPath,
  checkUrl,
  classifyClipboardText,
  commandCanonicalForm,
  normalisePath,
  normaliseSurfacePolicy,
  pathDenialReason,
  readTerminalCommand,
  readTransferRequest,
  sessionTransferCeiling,
} from '../../../core/devicehands'
import { ALLOWED_ROOT, VAULT_ROOT, policy } from './harness'

/**
 * The four boundaries, on their own.
 *
 * These are the predicates that decide whether Freya may reach the disk, run a program,
 * touch the clipboard or move a file. Each case here is a refusal somebody would
 * otherwise have to find in production, and each is asserted *from the outside* — a
 * harness is not needed because these modules cannot act, which is the point of them
 * being separate from the runtime.
 */
describe('device hands policy', () => {
  describe('paths', () => {
    it('accepts a path inside an allowed root', () => {
      const result = checkPath(`${ALLOWED_ROOT}/src/index.ts`, policy())
      expect(result.ok).toBe(true)
    })

    it('refuses a path outside every allowed root', () => {
      const result = checkPath('/etc/passwd', policy())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('path-outside-allowlist')
    })

    it('refuses a traversal rather than resolving it back inside', () => {
      const result = checkPath(`${ALLOWED_ROOT}/../../etc/passwd`, policy())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('path-malformed')
      expect(result.reason).toContain('traversal')
    })

    it('refuses a relative path outright, because there is no base to resolve it against', () => {
      expect(normalisePath('src/index.ts')).toBeNull()
    })

    it('refuses the Vault and everything under it', () => {
      for (const candidate of [
        VAULT_ROOT,
        `${VAULT_ROOT}/freya.db`,
        `${VAULT_ROOT}/backups/2026-01-01.db`,
        `${VAULT_ROOT.toUpperCase()}/freya.db`,
      ]) {
        const denial = pathDenialReason(candidate, policy())
        expect(denial?.code).toBe('vault-path-denied')
      }
    })

    it('does not treat a name that merely shares a prefix as being inside the Vault', () => {
      // Separator boundary, not substring matching: `/srv/data/private-notes` is a
      // different directory from `/srv/data/private`. A boundary that over-matched here
      // would be a boundary people turn off.
      const result = checkPath('/srv/data/private-notes/todo.md', {
        allowedRoots: ['/'],
        deniedRoots: ['/srv/data/private'],
      })
      expect(result.ok).toBe(true)
    })

    it('deliberately over-matches on credential-looking names, because that is the safe direction', () => {
      // `/vault-notes` *is* refused — by the `*vault*` pattern, not by the root rule.
      // The cost is one refused path; the benefit is that a vault export called
      // `vault-export-2026.zip` cannot slip past a rule that only matched the exact name.
      const denial = pathDenialReason('/vault-notes/todo.md', policy())
      expect(denial?.code).toBe('credential-store-denied')
    })

    it('refuses a credential store wherever it appears, even inside an allowed root', () => {
      for (const candidate of [
        `${ALLOWED_ROOT}/.env`,
        `${ALLOWED_ROOT}/.ssh/id_rsa`,
        `${ALLOWED_ROOT}/secrets.json`,
        `${ALLOWED_ROOT}/private-key.pem`,
        `${ALLOWED_ROOT}/vault-export.zip`,
        `${ALLOWED_ROOT}/cookies.sqlite`,
        `${ALLOWED_ROOT}/freya.keyring.json.bak`,
      ]) {
        const denial = pathDenialReason(candidate, policy())
        expect(denial?.code).toBe('credential-store-denied')
      }
    })

    it('refuses a path containing a NUL or a control character', () => {
      expect(pathDenialReason(ALLOWED_ROOT + '/a' + String.fromCharCode(0) + 'b', policy())?.code).toBe('path-malformed')
      expect(pathDenialReason(ALLOWED_ROOT + '/a' + String.fromCharCode(27) + 'b', policy())?.code).toBe('path-malformed')
    })

    it('refuses a UNC and a device path, whose targets are opaque', () => {
      expect(pathDenialReason('\\\\server\\share\\vault', policy())?.code).toBe('path-malformed')
      expect(pathDenialReason('\\\\?\\C:\\Windows\\System32', policy())?.code).toBe('path-malformed')
    })

    it('normalises Windows drive letters and separators without reading a clock or a cwd', () => {
      expect(normalisePath('C:\\workspace\\project\\src\\..\\..\\secret')).toBeNull()
      expect(normalisePath('c:/workspace/project/src/./index.ts')).toBe('C:/workspace/project/src/index.ts')
    })
  })

  describe('urls', () => {
    it('accepts an http and an https URL on the allowlist', () => {
      expect(checkUrl('https://example.com/about', policy()).ok).toBe(true)
      expect(checkUrl('http://example.com/about', policy()).ok).toBe(true)
    })

    it('refuses every other scheme', () => {
      for (const candidate of [
        'file:///etc/passwd',
        'data:text/html,<h1>hi</h1>',
        'javascript:alert(1)',
        'blob:https://example.com/1234',
        'view-source:https://example.com',
        'ftp://example.com/x',
      ]) {
        const result = checkUrl(candidate, policy())
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('url-scheme-not-allowed')
      }
    })

    it('refuses a host that is not on the allowlist, however it is spelled', () => {
      for (const candidate of [
        'https://evil.test/',
        'https://example.com.evil.test/',
        'https://sub.example.com/',
        'https://example.com@evil.test/',
      ]) {
        const result = checkUrl(candidate, policy())
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        // `example.com@evil.test` is a *credential-shaped* URL and gets its own code; the
        // others are simply not the allowlisted host. Both are refusals, which is the
        // property that matters, and the reason differs so an audit can tell them apart.
        expect(['url-host-not-allowed', 'url-carries-credential']).toContain(result.code)
      }
    })

    it('accepts a differently-cased spelling of an allowlisted host', () => {
      expect(checkUrl('https://EXAMPLE.COM/about', policy()).ok).toBe(true)
    })

    it('refuses a URL carrying a password rather than stripping it', () => {
      const result = checkUrl('https://user:hunter2@example.com/', policy())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('url-carries-credential')
    })
  })

  describe('commands', () => {
    it('accepts an allowlisted command with bounded arguments', () => {
      const result = readTerminalCommand(
        { command: 'git', args: ['status', '--short'], workingDirectory: ALLOWED_ROOT, env: {} },
        policy(),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(commandCanonicalForm(result.command)).toEqual(['git', 'status', '--short', ALLOWED_ROOT])
    })

    it('refuses a command that is not on the allowlist', () => {
      const result = readTerminalCommand(
        { command: 'curl', args: [], workingDirectory: ALLOWED_ROOT, env: {} },
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('command-not-allowed')
    })

    it('refuses every shell metacharacter, in the command and in every argument', () => {
      const injections = [
        'git; rm -rf /',
        'git && curl evil.test',
        'git | tee /tmp/out',
        'git > /etc/passwd',
        'git $(whoami)',
        'git `whoami`',
        'git %USERPROFILE%',
      ]
      for (const command of injections) {
        const result = readTerminalCommand(
          { command, args: [], workingDirectory: ALLOWED_ROOT, env: {} },
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(['command-argument-unsafe', 'command-not-allowed']).toContain(result.code)
      }
      for (const args of [['--upload-pack=sh'], ['a;rm -rf /'], ['a|cat'], ['a`id`'], ['a$b']]) {
        const result = readTerminalCommand(
          { command: 'git', args, workingDirectory: ALLOWED_ROOT, env: {} },
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('command-argument-unsafe')
      }
    })

    it('refuses an absolute path in an argument by running the path gate on it', () => {
      const forVault = readTerminalCommand(
        { command: 'cat', args: [`${VAULT_ROOT}/freya.db`], workingDirectory: ALLOWED_ROOT, env: {} },
        policy(),
      )
      expect(forVault.ok).toBe(false)
      if (forVault.ok) throw new Error('unreachable')
      expect(forVault.code).toBe('vault-path-denied')

      const outside = readTerminalCommand(
        { command: 'cat', args: ['/etc/passwd'], workingDirectory: ALLOWED_ROOT, env: {} },
        policy(),
      )
      expect(outside.ok).toBe(false)
      if (outside.ok) throw new Error('unreachable')
      expect(outside.code).toBe('command-argument-unsafe')
    })

    it('refuses a working directory outside the allowlist and the Vault', () => {
      const outside = readTerminalCommand(
        { command: 'git', args: [], workingDirectory: '/etc', env: {} },
        policy(),
      )
      expect(outside.ok).toBe(false)
      if (outside.ok) throw new Error('unreachable')
      expect(outside.code).toBe('command-working-directory-denied')

      const vault = readTerminalCommand(
        { command: 'git', args: [], workingDirectory: VAULT_ROOT, env: {} },
        policy(),
      )
      expect(vault.ok).toBe(false)
      if (vault.ok) throw new Error('unreachable')
      expect(vault.code).toBe('vault-path-denied')
    })

    it('refuses more arguments than the ceiling allows', () => {
      const result = readTerminalCommand(
        { command: 'git', args: Array.from({ length: 9 }, (_, i) => `a${String(i)}`), workingDirectory: ALLOWED_ROOT, env: {} },
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('command-argument-count-exceeded')
    })

    it('builds the environment from the allowlist and never from the process', () => {
      const named = readTerminalCommand(
        { command: 'git', args: [], workingDirectory: ALLOWED_ROOT, env: { CI: 'true' } },
        policy(),
      )
      expect(named.ok).toBe(true)
      if (!named.ok) throw new Error('unreachable')
      expect(Object.keys(named.command.env)).toEqual(['CI'])

      for (const name of ['PATH', 'HOME', 'AWS_SECRET_ACCESS_KEY', 'FREYA_VAULT_PASSPHRASE']) {
        const result = readTerminalCommand(
          { command: 'git', args: [], workingDirectory: ALLOWED_ROOT, env: { [name]: 'x' } },
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('environment-variable-not-allowed')
      }
    })

    it('refuses a command with no working directory, so the program cannot choose one', () => {
      const result = readTerminalCommand({ command: 'git', args: [] }, policy())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('request-malformed')
    })
  })

  describe('clipboard', () => {
    it('accepts ordinary text', () => {
      const result = checkClipboardText('meet at 3pm', 'out')
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.bytes).toBe(11)
    })

    it('refuses content larger than the ceiling', () => {
      const result = checkClipboardText('x'.repeat(8193), 'out')
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('clipboard-too-large')
    })

    it('refuses binary content, so there is no path by which an image gets here', () => {
      const result = checkClipboardText('PNG' + String.fromCharCode(7), 'in')
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('clipboard-binary-content')
    })

    it('names the credential shape it found, and refuses both directions', () => {
      const cases: readonly (readonly [string, string])[] = [
        ['-----BEGIN RSA PRIVATE KEY-----', 'a PEM private key block'],
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'a JSON web token'],
        ['AKIAIOSFODNN7EXAMPLE', 'what appears to be an AWS access key id'],
        ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'what appears to be a GitHub token'],
        ['https://user:hunter2@example.com/', 'a URL carrying a password'],
        ['card 4111 1111 1111 1111 here', 'what appears to be a card number'],
      ]
      for (const [content, shape] of cases) {
        expect(classifyClipboardText(content)).toBe(shape)
        for (const direction of ['in', 'out'] as const) {
          const result = checkClipboardText(content, direction)
          expect(result.ok).toBe(false)
          if (result.ok) throw new Error('unreachable')
          expect(result.code).toBe('clipboard-credential-content')
          expect(result.reason).toContain(shape)
        }
      }
    })
  })

  describe('transfers', () => {
    it('accepts a download inside the allowlist with an agreeing name and type', () => {
      const result = readTransferRequest(
        {
          url: 'https://example.com/notes.txt',
          destinationPath: ALLOWED_ROOT,
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          bytes: 128,
        },
        'download',
        policy(),
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.target.path).toBe(`${ALLOWED_ROOT}/notes.txt`)
    })

    it('refuses a file whose name and type disagree', () => {
      const result = readTransferRequest(
        {
          destinationPath: ALLOWED_ROOT,
          fileName: 'notes.txt',
          mediaType: 'application/pdf',
          bytes: 128,
        },
        'download',
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('media-type-mismatch')
    })

    it('refuses every image type, so a captured frame has no declared form', () => {
      for (const mediaType of ['image/png', 'image/jpeg', 'image/webp']) {
        const result = readTransferRequest(
          {
            destinationPath: ALLOWED_ROOT,
            fileName: 'screenshot.png',
            mediaType,
            bytes: 128,
          },
          'download',
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('media-type-not-allowed')
      }
    })

    it('refuses an executable by name whatever type it claims', () => {
      for (const fileName of ['tool.exe', 'run.sh', 'start.bat', 'app.js', 'x.pem', 'y.env']) {
        const result = readTransferRequest(
          { destinationPath: ALLOWED_ROOT, fileName, mediaType: 'text/plain', bytes: 1 },
          'download',
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('media-type-not-allowed')
      }
    })

    it('refuses a name carrying a separator or a traversal segment', () => {
      for (const fileName of ['../escape.txt', 'sub/notes.txt', 'sub\\notes.txt', '..']) {
        const result = readTransferRequest(
          { destinationPath: ALLOWED_ROOT, fileName, mediaType: 'text/plain', bytes: 1 },
          'download',
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('file-name-invalid')
      }
    })

    it('refuses a reserved device name', () => {
      const result = readTransferRequest(
        { destinationPath: ALLOWED_ROOT, fileName: 'CON.txt', mediaType: 'text/plain', bytes: 1 },
        'download',
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('file-name-invalid')
    })

    it('refuses a transfer over the ceiling, and clamps a caller-supplied one', () => {
      const oversized = readTransferRequest(
        { destinationPath: ALLOWED_ROOT, fileName: 'notes.txt', mediaType: 'text/plain', bytes: 65_537 },
        'download',
        policy(),
      )
      expect(oversized.ok).toBe(false)
      if (oversized.ok) throw new Error('unreachable')
      expect(oversized.code).toBe('file-too-large')

      const clamped = normaliseSurfacePolicy({
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [VAULT_ROOT],
        allowedHosts: ['example.com'],
        allowedCommands: ['git'],
        allowedEnvNames: ['CI'],
        maxTransferBytes: 10_000_000_000,
      })
      expect(clamped.ok).toBe(true)
      if (!clamped.ok) throw new Error('unreachable')
      expect(clamped.policy.maxTransferBytes).toBe(1_048_576)
    })

    it('gates both ends: an upload from the Vault is refused just as a download into it is', () => {
      const result = readTransferRequest(
        {
          url: 'https://example.com/inbox',
          sourcePath: VAULT_ROOT,
          fileName: 'report.csv',
          mediaType: 'text/csv',
          bytes: 8,
        },
        'upload',
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('vault-path-denied')
    })

    it('gates the remote endpoint too, in both directions', () => {
      // A transfer has a URL exactly as much as a page does. Without this check an
      // upload would be the one path by which bytes left an allowlisted host for
      // anywhere on the internet.
      for (const direction of ['download', 'upload'] as const) {
        const result = readTransferRequest(
          {
            url: 'https://evil.test/inbox',
            destinationPath: ALLOWED_ROOT,
            sourcePath: ALLOWED_ROOT,
            fileName: 'notes.txt',
            mediaType: 'text/plain',
            bytes: 8,
          },
          direction,
          policy(),
        )
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.code).toBe('url-host-not-allowed')
      }
    })

    it('refuses a transfer URL carrying a password rather than stripping it', () => {
      const result = readTransferRequest(
        {
          url: 'https://owner:hunter2@example.com/inbox',
          destinationPath: ALLOWED_ROOT,
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          bytes: 8,
        },
        'download',
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('url-carries-credential')
    })

    it('will not let a download name its own destination through the fileName field', () => {
      const result = readTransferRequest(
        {
          destinationPath: ALLOWED_ROOT,
          fileName: '../../etc/notes.txt',
          mediaType: 'text/plain',
          bytes: 1,
        },
        'download',
        policy(),
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('file-name-invalid')
    })

    it('has a session ceiling that is separate from the per-action one', () => {
      expect(sessionTransferCeiling()).toBeGreaterThan(65_536)
    })
  })

  describe('policy construction', () => {
    it('refuses a policy with nothing allowed, rather than treating it as everywhere', () => {
      const base = {
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [VAULT_ROOT],
        allowedHosts: ['example.com'],
        allowedCommands: ['git'],
        allowedEnvNames: ['CI'],
      }
      for (const key of ['allowedRoots', 'allowedHosts', 'allowedCommands', 'allowedEnvNames'] as const) {
        const result = normaliseSurfacePolicy({ ...base, [key]: [] })
        expect(result.ok).toBe(false)
      }
    })

    it('refuses a policy that names no protected directory', () => {
      const result = normaliseSurfacePolicy({
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [],
        allowedHosts: ['example.com'],
        allowedCommands: ['git'],
        allowedEnvNames: ['CI'],
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('policy-missing')
    })

    it('refuses a command entry carrying a path', () => {
      const result = normaliseSurfacePolicy({
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [VAULT_ROOT],
        allowedHosts: ['example.com'],
        allowedCommands: ['/bin/sh'],
        allowedEnvNames: ['CI'],
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('command-not-allowed')
    })

    it('refuses a credential-shaped environment name in the policy itself', () => {
      const result = normaliseSurfacePolicy({
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [VAULT_ROOT],
        allowedHosts: ['example.com'],
        allowedCommands: ['git'],
        allowedEnvNames: ['FREYA_VAULT_PASSPHRASE'],
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('environment-variable-denied')
    })

    it('gives the same digest for the same policy and a different one when it changes', () => {
      const base = {
        allowedRoots: [ALLOWED_ROOT],
        deniedRoots: [VAULT_ROOT],
        allowedHosts: ['example.com'],
        allowedCommands: ['git'],
        allowedEnvNames: ['CI'],
      }
      const a = normaliseSurfacePolicy(base)
      const b = normaliseSurfacePolicy(base)
      const c = normaliseSurfacePolicy({ ...base, allowedHosts: ['example.com', 'other.test'] })
      expect(a.ok && b.ok && c.ok).toBe(true)
      if (!a.ok || !b.ok || !c.ok) throw new Error('unreachable')
      expect(a.policy.digest).toBe(b.policy.digest)
      expect(a.policy.digest).not.toBe(c.policy.digest)
    })
  })
})
