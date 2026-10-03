// Phase 19 UI is now the default. Legacy UI available via ?ui=legacy.
if (new URLSearchParams(window.location.search).get('ui') === 'legacy') {
  void import('./legacyEntry')
} else {
  void import('./ui-v2/entry')
}