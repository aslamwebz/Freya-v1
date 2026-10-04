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

export function compareVectorClocks(vc1: VectorClock, vc2: VectorClock): 'less' | 'greater' | 'concurrent' | 'equal' {
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

export function vectorClockToString(vc: VectorClock): string {
  return JSON.stringify(vc);
}

export function vectorClockFromString(s: string): VectorClock {
  return JSON.parse(s) as VectorClock;
}
