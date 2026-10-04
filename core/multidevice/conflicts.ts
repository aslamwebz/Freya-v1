import type { SyncChange, ConflictRecord, ConflictPolicy } from './types.js';

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
  let mergedValue: unknown;

  let resolvedChange: SyncChange;

  if (resolution === 'local-wins') {
    finalResolution = 'local';
    mergedValue = local.value;
    resolvedChange = local;
  } else if (resolution === 'remote-wins') {
    finalResolution = 'remote';
    mergedValue = remote.value;
    resolvedChange = remote;
  } else {
    const mergeResult = tryMerge(local, remote);
    if (mergeResult !== null) {
      finalResolution = 'merged';
      mergedValue = mergeResult;
      resolvedChange = { ...local, value: mergeResult };
    } else {
      finalResolution = local.timestamp >= remote.timestamp ? 'local' : 'remote';
      mergedValue = finalResolution === 'local' ? local.value : remote.value;
      resolvedChange = finalResolution === 'local' ? local : remote;
    }
  }

  return {
    path: local.path,
    localChange: local,
    remoteChange: remote,
    resolution: finalResolution,
    resolvedChange,
    mergedValue,
    resolvedAt,
    resolvedBy,
  };
}

function tryMerge(local: SyncChange, remote: SyncChange): unknown | null {
  if (local.operation !== 'set' || remote.operation !== 'set') return null;
  if (typeof local.value !== 'object' || local.value === null) return null;
  if (typeof remote.value !== 'object' || remote.value === null) return null;
  if (Array.isArray(local.value) || Array.isArray(remote.value)) return null;

  const localObj = local.value as Record<string, unknown>;
  const remoteObj = remote.value as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...localObj };

  for (const [key, remoteVal] of Object.entries(remoteObj)) {
    if (!(key in merged)) {
      merged[key] = remoteVal;
    } else {
      const localVal = merged[key];
      if (JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
        return null;
      }
    }
  }

  return merged;
}

export function hasConflict(local: SyncChange, remote: SyncChange): boolean {
  if (local.path !== remote.path) return false;
  if (local.operation !== remote.operation) return true;
  if (local.operation === 'set' && JSON.stringify(local.value) !== JSON.stringify(remote.value)) return true;
  return false;
}
