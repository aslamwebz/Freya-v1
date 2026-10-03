import { useSyncExternalStore } from 'react'
import type { UiAdapter } from './contract'
export function useUiState(adapter: UiAdapter) {
  return useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot)
}
