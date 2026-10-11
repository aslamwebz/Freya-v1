import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SourceRequest, SourceResult } from '../../shared/contracts/explorer'

const OPERATIONS = ['list', 'read', 'write', 'create', 'rename', 'delete', 'diff', 'validate', 'test', 'commit', 'rollback', 'search']
const BLOCKED = /(^|\/)(\.git|\.env(?:\..*)?|node_modules|dist(?:-electron)?|artifacts|\.kilo|vault|\.aws|\.codex|\.agents)(\/|$)|(?:\.db|\.keyring\.json|\.tokens|\.node|\.exe|\.dll)$/i
const revision = (text: string) => createHash('sha256').update(text).digest('hex')
export class SourceWorkspace {
  static forProfile(repository: string, dataPath: string): SourceWorkspace {
    const id = createHash('sha256').update(dataPath).digest('hex').slice(0, 12)
    return new SourceWorkspace(repository, join(repository, '.kilo', `development-${id}`))
  }
  private ready = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly repository: string, private readonly worktree: string) {}
  execute(request: SourceRequest): Promise<SourceResult> {
    const run = this.tail.then(() => this.run(request))
    this.tail = run.catch(() => {})
    return run
  }
  private command(binary: string, args: string[], cwd = this.worktree): Promise<string> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|^FREYA_/i.test(key)) delete env[key]
    env.FREYA_ALLOW_LIVE_MODEL = '0'; env.FREYA_ALLOW_WEB_SEARCH = '0'
    if (binary === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
    return new Promise((accept, reject) => execFile(binary, args, { cwd, env, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 180_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Development command failed: ${(stderr || stdout || error.message).slice(0, 2000)}`))
      else accept((stdout + stderr).slice(0, 100_000))
    }))
  }
  private async open(): Promise<void> {
    const path = resolve(this.worktree), repo = resolve(this.repository)
    if (path === repo || !path.startsWith(repo + '\\') && !path.startsWith(repo + '/')) throw new Error('Development worktree must be inside the selected repository')
    if ((await realpath(repo)).toLowerCase() !== repo.toLowerCase()) throw new Error('Development repository cannot be a redirected path')
    let cursor = repo
    for (const part of relative(repo, path).split(/[\\/]/)) {
      cursor = join(cursor, part)
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Development worktree ancestors cannot be symlinks or junctions') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await mkdir(dirname(path), { recursive: true })
    try { await lstat(join(path, '.git')) }
    catch (error) { if (this.ready || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Development worktree identity is missing', { cause: error }); await this.command('git', ['worktree', 'add', '--detach', path, 'HEAD'], repo) }
    if ((await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('Development worktree is redirected')
    const top = (await this.command('git', ['rev-parse', '--show-toplevel'])).trim()
    if (resolve(top) !== path) throw new Error('Development worktree identity mismatch')
    const common = (await this.command('git', ['rev-parse', '--git-common-dir'])).trim()
    const expected = (await this.command('git', ['rev-parse', '--git-common-dir'], repo)).trim()
    if (resolve(this.worktree, common).toLowerCase() !== resolve(repo, expected).toLowerCase()) throw new Error('Development repository identity mismatch')
    this.ready = true
  }
  private async path(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value || value.length > 500 || isAbsolute(value) || /[\\:<>"|?*]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32) || value.split('/').some(part => !part || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) || BLOCKED.test(value)) throw new Error('Source path is outside the permitted development files')
    const path = resolve(this.worktree, value)
    if (relative(this.worktree, path).startsWith('..')) throw new Error('Source path escapes development worktree')
    let cursor = this.worktree
    for (const part of value.split('/')) {
      cursor = join(cursor, part)
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Source symlinks are not permitted') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return path
  }
  private async read(path: string): Promise<string> {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size > 256_000) throw new Error('Only text files up to 256 KB can be edited')
    const text = await readFile(path, 'utf8')
    if (text.includes('\0')) throw new Error('Binary files cannot be edited')
    return text
  }
  private content(value: unknown): asserts value is string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256_000 || value.includes('\0')) throw new Error('Source content must be bounded UTF-8 text without NUL bytes')
  }
  private async files(): Promise<string[]> {
    const files = (await this.command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
    const allowed: string[] = []
    for (const file of files) { try { await this.path(file); allowed.push(file) } catch { /* Protected paths are never returned or staged. */ } }
    return allowed
  }
  private async changes(): Promise<string[]> {
    const names = (await this.command('git', ['diff', '--name-only', '-z', 'HEAD'])) + (await this.command('git', ['ls-files', '-z', '--others', '--exclude-standard']))
    const allowed: string[] = []
    for (const name of new Set(names.split('\0').filter(Boolean))) {
      try { const path = await this.path(name); try { await this.read(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; allowed.push(name) } catch { /* Skip protected and binary changes. */ }
    }
    return allowed
  }
  private async run(request: SourceRequest): Promise<SourceResult> {
    if (!request || typeof request !== 'object' || !OPERATIONS.includes(request.operation) || Object.keys(request).some(key => !['operation', 'path', 'target', 'content', 'revision', 'query', 'message'].includes(key))) throw new Error('Invalid source operation')
    await this.open()
    const base = { worktree: this.worktree }
    if (request.operation === 'list' || request.operation === 'search') {
      const files = await this.files()
      if (request.operation === 'list') return { ...base, files: files.slice(0, 5000) }
      if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 100) throw new Error('Search needs a bounded query')
      const matches: string[] = []
      for (const file of files.slice(0, 5000)) {
        try {
          const text = await this.read(await this.path(file))
          text.split('\n').forEach((line, index) => { if (line.toLowerCase().includes(request.query!.toLowerCase()) && matches.length < 200) matches.push(`${file}:${index + 1}: ${line.slice(0, 240)}`) })
        } catch { /* Omit binary and oversized files. */ }
      }
      return { ...base, output: matches.join('\n') }
    }
    if (request.operation === 'diff') {
      const files = await this.changes()
      if (files.length) await this.command('git', ['add', '--intent-to-add', '--', ...files.map(file => `:(literal)${file}`)])
      return { ...base, output: files.length ? await this.command('git', ['diff', 'HEAD', '--', ...files.map(file => `:(literal)${file}`)]) : 'No permitted source changes.' }
    }
    if (request.operation === 'validate') {
      // Fixed command only; no renderer-supplied shell or script. Staged code never deploys.
      const output = await this.command(process.execPath, [join(this.repository, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(this.worktree, 'tsconfig.json'), '--noEmit', '--incremental', 'false'])
      return { ...base, output: output || 'TypeScript validation passed in the development worktree.' }
    }
    if (request.operation === 'test') {
      return { ...base, output: 'Test execution is unavailable in Core: editable test/configuration code requires an enforced execution sandbox. Review the diff, then use your separately authorized development runner in this worktree: npm run test:architecture. No test process was launched.' }
    }
    if (request.operation === 'commit') {
      if (typeof request.message !== 'string' || !request.message.trim() || request.message.length > 240) throw new Error('Commit needs a bounded message')
      const staged = (await this.command('git', ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
      for (const file of staged) { try { await this.path(file) } catch { throw new Error('Commit refused: protected files are already staged') } }
      const files = await this.changes()
      if (!files.length) throw new Error('No permitted source files to commit')
      await this.command('git', ['add', '--', ...files.map(file => `:(literal)${file}`)])
      return { ...base, output: await this.command('git', ['-c', 'core.hooksPath=', 'commit', '--no-verify', '-m', request.message]) }
    }
    const path = await this.path(request.path)
    if (request.operation === 'read') { const content = await this.read(path); return { ...base, content, revision: revision(content) } }
    if (request.operation === 'create') {
      this.content(request.content)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, request.content, { flag: 'wx' })
      return { ...base, content: request.content, revision: revision(request.content) }
    }
    if (request.operation === 'rollback' && request.revision === 'missing') {
      try { await lstat(path); throw new Error('Source revision changed. File exists again; reload before rollback.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await this.command('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${request.path!}`])
      const content = await this.read(path)
      return { ...base, content, revision: revision(content) }
    }
    const existing = await this.read(path)
    if (request.revision !== revision(existing)) throw new Error('Source revision changed. Reload and review the latest file.')
    if (request.operation === 'write') {
      this.content(request.content)
      await writeFile(path, request.content)
      return { ...base, content: request.content, revision: revision(request.content) }
    }
    if (request.operation === 'rename') {
      const target = await this.path(request.target)
      try { await lstat(target); throw new Error('Rename target exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await mkdir(dirname(target), { recursive: true }); await rename(path, target)
    } else if (request.operation === 'delete') { await unlink(path); return { ...base, revision: 'missing' } }
    else if (request.operation === 'rollback') await this.command('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${request.path!}`])
    return base
  }
}
