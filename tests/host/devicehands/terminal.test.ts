import { describe, expect, it } from 'vitest'
import { hostHarness, ALLOWED_ROOT } from './harness'
import type { TerminalCommand } from '../../../core/devicehands'

function command(overrides: Partial<TerminalCommand> = {}): TerminalCommand {
  return {
    command: 'git',
    args: ['status'],
    workingDirectory: ALLOWED_ROOT,
    env: {},
    ...overrides,
  }
}

describe('terminal host adapter', () => {
  it('spawns without a shell and passes only the constructed environment', async () => {
    const h = await hostHarness()
    const pending = h.effects.runTerminal({ command: command({ env: { CI: '1' } }) })
    const child = h.terminal.children[0]
    expect(child).toBeDefined()
    child?.emitExit(0)
    const outcome = await pending

    expect(h.terminal.calls).toHaveLength(1)
    const call = h.terminal.calls[0]
    expect(call?.options.shell).toBe(false)
    expect(call?.options.env).toEqual({ CI: '1' })
    // The parent environment is never inherited: no PATH, no HOME, nothing unnamed.
    expect(call?.options.env).not.toHaveProperty('PATH')
    expect(call?.file).toBe('/usr/bin/git')
    expect(call?.args).toEqual(['status'])
    expect(outcome.evidence).toBe('observed')
    expect(outcome.holds).toBe(true)
    expect(outcome.exitCode).toBe(0)
  })

  it('refuses a shell metacharacter in an argument without spawning', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.runTerminal({ command: command({ args: ['status; rm -rf /'] }) })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('command-argument-unsafe')
    expect(h.counts.spawn).toBe(0)
    expect(h.counts.resolve).toBe(0)
  })

  it('refuses a command that is not a bare program name without spawning', async () => {
    const h = await hostHarness()
    const outcome = await h.effects.runTerminal({ command: command({ command: '../evil' }) })
    expect(outcome.code).toBe('command-not-allowed')
    expect(h.counts.spawn).toBe(0)
  })

  it('reports command-not-found when the program cannot be resolved', async () => {
    const h = await hostHarness()
    h.terminal.setResolve(() => null)
    const outcome = await h.effects.runTerminal({ command: command() })
    expect(outcome.holds).toBe(false)
    expect(outcome.code).toBe('command-not-found')
    expect(h.counts.spawn).toBe(0)
  })

  it('records a non-zero exit as observed and not held', async () => {
    const h = await hostHarness()
    const pending = h.effects.runTerminal({ command: command() })
    h.terminal.children[0]?.emitExit(2)
    const outcome = await pending
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('observed')
    expect(outcome.code).toBe('exited-2')
    expect(outcome.exitCode).toBe(2)
  })

  it('bounds the output byte count to the code-owned ceiling', async () => {
    const h = await hostHarness()
    const pending = h.effects.runTerminal({ command: command() })
    const child = h.terminal.children[0]
    child?.emitStdout(new Uint8Array(20 * 1024))
    child?.emitStderr(new Uint8Array(20 * 1024))
    child?.emitExit(0)
    const outcome = await pending
    expect(outcome.stdoutBytes).toBe(16 * 1024)
    expect(outcome.stderrBytes).toBe(16 * 1024)
  })

  it('kills a program that runs past its deadline and reports timeout, not success', async () => {
    const h = await hostHarness({ terminalTimeoutMs: 20 })
    const outcome = await h.effects.runTerminal({ command: command() })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('reported')
    expect(outcome.code).toBe('timeout')
    expect(h.terminal.children[0]?.killed).toBe(true)
  })

  it('reports a spawn failure as reported rather than observed', async () => {
    const h = await hostHarness()
    const pending = h.effects.runTerminal({ command: command() })
    h.terminal.children[0]?.emitError(new Error('EACCES'))
    const outcome = await pending
    expect(outcome.holds).toBe(false)
    expect(outcome.evidence).toBe('reported')
    expect(outcome.code).toBe('spawn-failed')
  })
})
