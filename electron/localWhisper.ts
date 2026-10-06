import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Owns only Freya's CPU recognizer. No microphone, credentials or transcripts. */
export class LocalWhisperHost {
  private child: ChildProcess | null = null
  private starting: Promise<boolean> | null = null
  private generation = 0
  ready = false
  constructor(private readonly directory: string) {}
  get installed(): boolean { return existsSync(join(this.directory, 'bin', 'Release', 'whisper-server.exe')) && existsSync(join(this.directory, 'ggml-base.en.bin')) }
  async start(): Promise<boolean> {
    if (this.ready) return true
    if (this.starting) return this.starting
    const generation = this.generation
    this.starting = this.launch(generation).finally(() => { this.starting = null })
    return this.starting
  }
  private async launch(generation: number): Promise<boolean> {
    const binary = join(this.directory, 'bin', 'Release', 'whisper-server.exe')
    const model = join(this.directory, 'ggml-base.en.bin')
    if (!existsSync(binary) || !existsSync(model)) return false
    // An existing local server is usable, but Freya never kills one it did not spawn.
    if (await this.healthy()) { this.ready = generation === this.generation; return this.ready }
    if (generation !== this.generation) return false
    const child = spawn(binary, ['--model', model, '--host', '127.0.0.1', '--port', '8080', '--no-gpu', '--threads', '4', '--language', 'en', '--suppress-nst'], { cwd: this.directory, windowsHide: true, stdio: 'ignore' })
    this.child = child
    child.on('error', () => { if (this.child === child) { this.child = null; this.ready = false } })
    child.on('exit', () => { if (this.child === child) { this.child = null; this.ready = false } })
    const deadline = Date.now() + 8_000
    while (this.child === child && generation === this.generation && Date.now() < deadline) {
      if (await this.healthy()) { this.ready = generation === this.generation; return this.ready }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (this.child === child) this.stop()
    return false
  }
  private async healthy(): Promise<boolean> {
    try {
      const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(500), redirect: 'error' })
      return response.ok && (await response.text()) === '{"status":"ok"}'
    } catch { return false }
  }
  stop(): void {
    this.generation++
    this.ready = false
    const child = this.child
    this.child = null
    child?.kill()
  }
}
