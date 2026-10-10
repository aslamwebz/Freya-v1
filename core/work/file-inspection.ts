import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { WorkRegistry } from './capability'

/** Read-only metadata in host-authorized roots. No shell or file content access. */
export function registerFileInspection(registry: WorkRegistry, roots: readonly string[]): void {
  // Snapshot the actual host-authorized locations, rather than trusting later redirects.
  const authorizedRoots = Promise.all(roots.map(root => realpath(root).catch(() => null)))
  const inspect = async (input: Record<string, unknown>) => {
    if (Object.keys(input).length !== 1 || typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.length > 2048) throw new Error('File inspection input is invalid.')
    try {
      const canonical = await realpath(input.path)
      let permitted = false
      for (const root of await authorizedRoots) {
        if (root === null) continue
        const difference = relative(root, canonical)
        if (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)) permitted = true
      }
      if (!permitted) throw new Error('not permitted')
      const stat = await lstat(canonical)
      if (!stat.isFile()) throw new Error('not a regular file')
      if (await realpath(input.path) !== canonical) throw new Error('file binding changed')
      return { size: stat.size, mtimeMs: stat.mtimeMs, inode: stat.ino }
    } catch { throw new Error('File inspection could not establish authorized file metadata.') }
  }
  registry.register({
    name: 'filesystem.inspect', capability: 'work.execute', risk: 'routine', verifier: 'filesystem.inspect.verified',
    describe: () => 'inspects one authorized file without changing it or reading its contents',
    async execute(request, context) {
      context.signal.throwIfAborted()
      const data = await inspect(request.input)
      context.signal.throwIfAborted()
      return { observation: { kind: 'result', summary: 'Observed file metadata.', data } }
    },
  })
  registry.registerVerifier({ name: 'filesystem.inspect.verified', async verify(request) {
    try {
      const actual = await inspect(request.input)
      const observed = request.observation.data
      return Object.keys(actual).every(key => actual[key as keyof typeof actual] === observed[key])
        ? { verdict: 'passed', reason: 'An independent file inspection matched the observation.' }
        : { verdict: 'failed', reason: 'File metadata changed or did not match the observation.' }
    } catch { return { verdict: 'failed', reason: 'An independent file inspection could not verify the observation.' } }
  } })
}
