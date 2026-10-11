import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const finished = child => child.exitCode != null || child.signalCode != null
const exited = (child, milliseconds) => finished(child) ? Promise.resolve() : new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); resolve() }
  const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error(`owned test process ${child.pid} did not exit`)) }, milliseconds)
  child.once('exit', done)
})

/** Own only this acceptance run's children; never enumerate or kill arbitrary apps. */
export async function acquireAcceptanceProcesses(directory, timeoutMs = 180_000) {
  const file = join(directory, 'process-acceptance.lock'), token = randomUUID()
  let handle
  try { handle = await open(file, 'wx') }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const previous = JSON.parse(await readFile(file, 'utf8'))
    let alive = true
    try { process.kill(previous.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') alive = false }
    if (alive) throw new Error(`a process acceptance test is already running (PID ${previous.pid}); stop it before starting another`, { cause: error })
    await unlink(file); handle = await open(file, 'wx')
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })) } finally { await handle.close() }
  const children = new Set()
  let closing
  const stop = async child => {
    if (!child || finished(child)) { children.delete(child); return }
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 6_000 }, error => error && !finished(child) ? reject(error) : resolve()))
    } else child.kill('SIGKILL')
    await exited(child, 6_000); children.delete(child)
  }
  const close = () => closing ??= (async () => {
    clearTimeout(deadline)
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
    const results = await Promise.allSettled([...children].map(stop))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'acceptance process cleanup failed')
    const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
    if (current.token === token) await unlink(file)
  })()
  const quit = code => { void close().catch(error => console.error(error.message)).finally(() => process.exit(code)) }
  const interrupt = () => quit(130), terminate = () => quit(143)
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  const deadline = setTimeout(() => { console.error('Acceptance exceeded its time limit; stopping all owned test processes.'); quit(1) }, timeoutMs)
  deadline.unref()
  return { track: child => { if (closing) throw new Error('acceptance is closing'); children.add(child); return child }, stop, close }
}
