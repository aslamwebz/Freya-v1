// Phase 19 ui-v2 is the default UI now that the owner alpha is testing it.
// The Phase ≤18 UI remains reachable via ?ui=legacy for comparison and rollback.
if (new URLSearchParams(window.location.search).get('ui') === 'legacy') {
  void import('./legacyEntry')
} else {
  void import('./ui-v2/entry')
}
