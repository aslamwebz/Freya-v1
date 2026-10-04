import type { VectorClock, DeviceId } from './types.js';

export function emptyVectorClock(): VectorClock {
  return {};
}

export function incrementVectorClock(vc: VectorClock, deviceId: DeviceId): VectorClock {
  return { ...vc, [deviceId]: (vc[deviceId] || 0) + 1 };
}

export function mergeVectorClocks(vc1: VectorClock, vc2: VectorClock): VectorClock {
  const result: VectorClock = { ...vc1 };
  for (const [deviceId, timestamp] of Object.entries(vc2)) {
    result[deviceId] = Math.max(result[deviceId] || 0, timestamp);
  }
  return result;
}

export function compareVectorClocks(
  vc1: VectorClock,
  vc2: VectorClock
): 'less' | 'greater' | 'concurrent' | 'equal' {
  let hasLess = false;
  let hasGreater = false;

  const allKeys = new Set([...Object.keys(vc1), ...Object.keys(vc2)]);

  for (const key of allKeys) {
    const v1 = vc1[key] || 0;
    const v2 = vc2[key] || 0;
    if (v1 < v2) hasLess = true;
    if (v1 > v2) hasGreater = true;
  }

  if (hasLess && hasGreater) return 'concurrent';
  if (hasLess) return 'less';
  if (hasGreater) return 'greater';
  return 'equal';
}

/**
 * True when `candidate` has observed everything `seen` describes.
 *
 * Used by the sync engine to decide whether a change is already known: a remote
 * that dominates a change's clock has seen it, so re-sending it would be a
 * replay.
 */
export function isVectorClockAtLeast(candidate: VectorClock, seen: VectorClock): boolean {
  for (const [deviceId, value] of Object.entries(seen)) {
    if ((candidate[deviceId] || 0) < value) return false;
  }
  return true;
}

export function vectorClockToString(vc: VectorClock): string {
  return JSON.stringify(vc);
}

export function vectorClockFromString(s: string): VectorClock {
  const parsed: unknown = JSON.parse(s);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('vector clock must be an object');
  }
  const clock: VectorClock = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`vector clock entry ${key} is not a non-negative integer`);
    }
    clock[key] = value;
  }
  return clock;
}
