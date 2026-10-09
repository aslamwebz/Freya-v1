// App Mode is the shipping default; UI v2 remains available for comparison.
// Each shell dynamically imports its own CSS to prevent style collisions.
// The removed Athena-era legacy entry is no longer loaded.
export {}

const ui = new URLSearchParams(window.location.search).get('ui')

async function mount(): Promise<void> {
  if (ui === 'v2') {
    await import('./ui-v2/entry')
  } else {
    await import('./app/entry')
  }
}

void mount()