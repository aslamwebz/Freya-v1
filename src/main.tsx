// The from-scratch App Mode is the shipping default. The previous ui-v2 shell
// and Phase ≤18 legacy UI remain dynamically reachable for comparison and rollback.
//
// Each shell module graph imports its own stylesheets internally (in src/app/entry.tsx,
// src/ui-v2/entry.tsx, and src/legacyEntry.tsx). Because each shell is loaded via
// distinct await import() branches in mount(), Vite generates per-entry CSS chunks
// and dynamic preload maps. This eliminates cross-shell stylesheet collisions,
// drops the bloated static CSS bundle from the primary document, and ensures
// each shell receives only its required styles.


export {}

const ui = new URLSearchParams(window.location.search).get('ui')

async function mount(): Promise<void> {
  if (ui === 'legacy') {
    await import('./legacyEntry')
  } else if (ui === 'v2') {
    await import('./ui-v2/entry')
  } else {
    await import('./app/entry')
  }
}

void mount()
