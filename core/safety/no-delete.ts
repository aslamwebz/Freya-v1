/**
 * Freya's temporary no-delete invariant.
 *
 * Local development deliberately removes permission/approval friction so capabilities
 * can be tested end to end. Deletion is the exception: until that capability is
 * explicitly enabled later, destructive removal is refused regardless of profile.
 *
 * This is not a general "safe command" filter. It only recognises deletion/removal
 * semantics so the local profile remains otherwise unrestricted.
 */

const DIRECT_DELETE_PROGRAMS = new Set([
  'rm',
  'rmdir',
  'del',
  'erase',
  'unlink',
  'shred',
  'sdelete',
  'trash',
  'trash-put',
  'remove-item',
])

function joined(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ').toLowerCase()
}

export function terminalDeleteReason(command: string, args: readonly string[]): string | null {
  const program = command.trim().toLowerCase()
  const lowerArgs = args.map((value) => value.toLowerCase())
  const all = joined(program, args)

  if (DIRECT_DELETE_PROGRAMS.has(program)) return `${program} is a deletion/removal program`

  if (program === 'git') {
    if (lowerArgs[0] === 'clean' || lowerArgs[0] === 'rm') return 'git would delete working-tree content'
    if (lowerArgs[0] === 'reset' && lowerArgs.includes('--hard')) return 'git reset --hard would destructively discard local work'
    if (lowerArgs[0] === 'branch' && lowerArgs.some((arg) => arg === '-d' || arg === '-D'.toLowerCase())) return 'git would delete a branch'
    if (lowerArgs[0] === 'tag' && lowerArgs.includes('-d')) return 'git would delete a tag'
    if (lowerArgs[0] === 'push' && lowerArgs.includes('--delete')) return 'git would delete a remote ref'
  }

  if ((program === 'docker' || program === 'podman') && ['rm', 'rmi'].includes(lowerArgs[0] ?? '')) {
    return `${program} would remove container/image data`
  }
  if ((program === 'docker' || program === 'podman') && lowerArgs[0] === 'system' && lowerArgs[1] === 'prune') {
    return `${program} system prune would delete data`
  }
  if (program === 'kubectl' && lowerArgs[0] === 'delete') return 'kubectl would delete a resource'
  if (program === 'helm' && lowerArgs[0] === 'uninstall') return 'helm would remove a release'
  if (program === 'terraform' && lowerArgs[0] === 'destroy') return 'terraform would destroy managed resources'

  if (
    ['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'composer', 'apt', 'apt-get', 'dnf', 'yum', 'brew', 'winget', 'choco'].includes(program) &&
    lowerArgs.some((arg) => ['remove', 'uninstall', 'purge'].includes(arg))
  ) {
    return `${program} would remove installed dependencies/software`
  }

  if (
    ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'bash', 'sh', 'zsh', 'fish'].includes(program) &&
    /\b(?:rm|rmdir|del|erase|remove-item|unlink|shred|trash|delete|destroy|wipe|purge)\b/i.test(all)
  ) {
    return 'the shell invocation contains deletion/removal semantics'
  }

  if (
    ['python', 'python3', 'python.exe', 'node', 'node.exe', 'deno', 'bun'].includes(program) &&
    /\b(?:os\.remove|os\.unlink|rmtree|path\.unlink|fs\.unlink|fs\.rm|fs\.rmdir|delete|remove)\b/i.test(all)
  ) {
    return 'the script invocation contains deletion/removal semantics'
  }

  if (/\b(?:drop\s+(?:table|database|schema)|delete\s+from|truncate\s+table)\b/i.test(all)) {
    return 'the command contains destructive database semantics'
  }

  return null
}

/** Refuse obvious destructive controls before the browser click is performed. */
export function browserDeleteReason(label: string): string | null {
  const value = label.trim()
  if (!value) return null
  if (
    /\b(?:delete|destroy|erase|wipe|purge|trash|uninstall)\b/i.test(value) ||
    /\bremove\s+(?:account|profile|workspace|project|repository|repo|file|folder|message|record|item)\b/i.test(value)
  ) {
    return `the page control is destructive: "${value.slice(0, 120)}"`
  }
  return null
}
