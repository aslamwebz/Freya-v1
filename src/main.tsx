// Legacy UI is the default. Phase 19 ui-v2 is opt-in via ?ui=phase19, because the
// real Core wiring it needs is deferred until after the Vault correction and the
// adapted Phases 21/22/20 (PLAN Step G).
if (new URLSearchParams(window.location.search).get('ui') === 'phase19') {
  void import('./ui-v2/entry')
} else {
  void import('./legacyEntry')
}