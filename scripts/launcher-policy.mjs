export function requireSelectedProfile(exists, initialize) {
  if (!exists && !initialize) throw new Error('Selected profile is missing or not initialized. Choose an existing profile with --profile=PATH, or explicitly create a new profile with --profile=PATH --initialize-profile. Historical profiles are never restored automatically.')
}
export function formatHeartbeat(observations, at) {
  return observations.map(row => `[${at}] ${row.component} ${row.state} pid=${row.pid ?? 'none'} health=${row.lastSuccessAt ?? 'missing'} heartbeat=${row.health?.lastProgressAt ?? 'missing'} source=${row.source} ${row.detail}`).join('\n')
}
export function redactRuntimeOutput(line, secrets = []) {
  let safe = line
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]')
  return safe.replace(/((?:api[_-]?key|access[_-]?token|authorization|secret|password|encryption[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
}
