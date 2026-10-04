// The from-scratch App Mode is the default. The previous ui-v2 shell and the
// Phase ≤18 legacy UI remain reachable for comparison and rollback.
const ui = new URLSearchParams(window.location.search).get('ui')
if (ui === 'legacy') {
  void import('./legacyEntry')
} else if (ui === 'v2') {
  void import('./ui-v2/entry')
} else {
  void import('./app/entry')
}
