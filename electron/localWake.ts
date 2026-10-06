import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Keyword-only CPU worker, controlled by the host and bounded at both pipes. */
export class LocalWakeHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<boolean> | null = null
  ready = false
  frames = 0
  detections = 0
  peak = 0
  constructor(private readonly root: string, private readonly detected: () => void, private readonly failed: () => void = () => {}) {}
  async start(): Promise<boolean> {
    if (this.ready) return true
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => { this.starting = null })
    return this.starting
  }
  private async launch(): Promise<boolean> {
    const directory = join(this.root, '.local', 'wake')
    const python = join(directory, 'venv', 'Scripts', 'python.exe')
    if (!existsSync(python)) return false
    const child = spawn(python, ['-u', join(this.root, 'scripts', 'wake-detector.py'), directory], { windowsHide: true, stdio: 'pipe' })
    this.child = child
    let output = ''
    child.stdout.on('data', (data: Buffer) => {
      if (this.child !== child) return
      output += data.toString('utf8')
      if (output.length > 1024) { this.stop(); return }
      let end: number
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end).trim(); output = output.slice(end + 1)
        if (line === '{"ready": true}') this.ready = true
        if (line === '{"wake": true}' && this.ready) { this.detections++; this.detected() }
      }
    })
    child.stderr.on('data', () => { /* diagnostic output is dropped; never retain audio */ })
    child.stdin.on('error', () => this.stop())
    child.on('error', () => { if (this.child === child) this.stop() })
    child.on('exit', () => { if (this.child === child) { const wasReady = this.ready; this.child = null; this.ready = false; if (wasReady) this.failed() } })
    const deadline = Date.now() + 10_000
    while (this.child === child && !this.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (!this.ready && this.child === child) this.stop()
    return this.ready
  }
  push(audio: unknown): void {
    if (!this.ready || !this.child || !(audio instanceof Uint8Array) || !audio.length || audio.length > 8192 || audio.length % 2 || this.child.stdin.writableLength > 64 * 1024) return
    this.frames++
    const samples = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    for (let i = 0; i < audio.length; i += 2) this.peak = Math.max(this.peak, Math.abs(samples.getInt16(i, true)) / 32768)
    const header = Buffer.alloc(4); header.writeUInt32LE(audio.length)
    this.child.stdin.write(Buffer.concat([header, Buffer.from(audio)]))
  }
  reset(): void { if (this.ready && this.child && this.child.stdin.writableLength < 64 * 1024) this.child.stdin.write(Buffer.alloc(4)) }
  stop(): void { this.ready = false; const child = this.child; this.child = null; child?.kill() }
}
