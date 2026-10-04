import type { SyncChange, ConflictRecord, ConflictPolicy, ConflictResolution } from './types.js';

export function createDefaultConflictPolicy(): ConflictPolicy {
  return {
    defaultResolution: 'remote-wins',
    pathPolicies: {},
  };
}

export function resolveConflict(
  local: SyncChange,
  remote: SyncChange,
  policy: ConflictPolicy,
  resolvedBy: string,
  resolvedAt: number = Date.now()
): ConflictRecord {
  const resolution = policy.pathPolicies[local.path] || policy.defaultResolution;

  let finalResolution: 'local' | 'remote' | 'merged';

  if (resolution === 'local-wins') {
    finalResolution = 'local';
  } else if (resolution === 'remote-wins') {
    finalResolution = 'remote';
  } else {
    finalResolution = tryMerge(local, remote) ? 'merged' : (local.timestamp >= remote.timestamp ? 'local' : 'remote');
  }

  return {
    path: local.path,
    localChange: local,
    remoteChange: remote,
    resolution: finalResolution,
    resolvedAt,
    resolvedBy,
  };
}

function tryMerge(local: SyncChange, remote: SyncChange): boolean {
  if (local.operation !== 'set' || remote.operation !== 'set') return false;
  if (typeof local.value !== 'object' || local.value === null) return false;
  if (typeof remote.value !== 'object' || remote.value === null) return false;
  if (Array.isArray(local.value) || Array.isArray(remote.value)) return false;
  return true;
}

export function hasConflict(local: SyncChange, remote: SyncChange): boolean {
  if (local.path !== remote.path) return false;
  if (local.operation !== remote.operation) return true;
  if (local.operation === 'set' && local.value !== remote.value) return true;
  return false;
}
