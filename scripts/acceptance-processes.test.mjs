import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { once } from 'node:events'
import { acquireAcceptanceProcesses } from './acceptance-processes.mjs'

test('prevents overlapping process tests and releases ownership after cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freya-process-cleanup-'))
  try {
    const run = await acquireAcceptanceProcesses(directory)
    await assert.rejects(acquireAcceptanceProcesses(directory), /already running/)
    await run.close()
    const next = await acquireAcceptanceProcesses(directory)
    await next.close()
  } finally { await rmdir(directory) }
})

test('cleans up a real owned child and handles an already terminated child without hanging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freya-process-cleanup-'))
  const run = await acquireAcceptanceProcesses(directory)
  try {
    const child = run.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }))
    await run.stop(child)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    await run.stop(child)
    await run.close()
  } finally { await run.close(); await rmdir(directory) }
})

test('Windows cleanup also terminates descendants of the owned test process', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freya-process-cleanup-'))
  const run = await acquireAcceptanceProcesses(directory)
  try {
    const script = 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1000)'
    const child = run.track(spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }))
    const [output] = await once(child.stdout, 'data')
    const descendant = Number(String(output).trim())
    assert.ok(Number.isInteger(descendant) && descendant > 0)
    await run.stop(child)
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
  } finally { await run.close(); await rmdir(directory) }
})
