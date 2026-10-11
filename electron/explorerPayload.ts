/** Bounded named explorer requests; Core still validates authority and persistence. */
export function explorerPayload(command: string, payload: unknown): { ok: true; payload?: unknown } | { ok: false; reason: string } | undefined {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  switch (command) {
    case 'development.source': {
      if (!record) return { ok: false, reason: 'Source request is missing' }
      if (Object.keys(record).some(key => !['operation', 'path', 'target', 'content', 'revision', 'query', 'message'].includes(key))) return { ok: false, reason: 'Unknown source field' }
      const operation = record.operation
      if (typeof operation !== 'string' || !['list', 'read', 'write', 'create', 'rename', 'delete', 'diff', 'validate', 'test', 'commit', 'rollback', 'search'].includes(operation)) return { ok: false, reason: 'Unknown source operation' }
      for (const [key, limit] of [['path', 500], ['target', 500], ['content', 256000], ['revision', 64], ['query', 100], ['message', 240]] as const) if (record[key] !== undefined && (typeof record[key] !== 'string' || (record[key] as string).length > limit)) return { ok: false, reason: 'Source field is invalid or too long' }
      return { ok: true, payload: { ...record } }
    }
    case 'vault.explorer': {
      if (!record || Object.keys(record).some(key => !['operation', 'id', 'expectedVersion', 'title', 'content', 'category', 'links', 'items'].includes(key))) return { ok: false, reason: 'Invalid Vault request' }
      if (JSON.stringify(record).length > 1800000) return { ok: false, reason: 'Vault request exceeds import limit' }
      return { ok: true, payload: { ...record } }
    }
    case 'system.explorer.read': return record && Object.keys(record).length ? { ok: false, reason: 'System read accepts no fields' } : { ok: true }

    default: return undefined
  }
}
