// The from-scratch App Mode is the default. The previous ui-v2 shell and the
// Phase ≤18 legacy UI remain reachable for comparison and rollback.
//
// Every shell's stylesheet is imported here, statically, even though only one of
// them will ever mount. That looks wasteful and is deliberate.
//
// Each shell is reached through a dynamic `import()`, and a shell's CSS is a
// side-effect import of its entry module — so in the built output the CSS for a
// dynamically-imported entry is supposed to be linked by that entry's chunk. With
// three entry graphs sharing stylesheets (`tokens.css` and `controls.css` are used
// by both App Mode and ui-v2), the bundler stopped emitting that link for the
// legacy shell entirely: `legacyEntry.css` was written to `dist/` and referenced by
// nothing at all. A legacy window then mounted with only App Mode's CSS applied, so
// `.presence-canvas` had no size constraint and the presence grew to the height of
// the document — roughly 27,000px — while the rail never stopped moving.
//
// Importing the CSS from the entry puts all of it in the entry's own stylesheet,
// which the entry already links, so whichever shell mounts is styled. That is also
// exactly what the two-shell build did before App Mode existed, and it is why the
// legacy suite passed with both of its stylesheets present.
//
// The cost is that a window loads the CSS for shells it is not showing. That is a
// few tens of kilobytes on a local file, and it is the price of three shells
// sharing one document. When App Mode replaces the other two, this collapses back
// to a single import with nothing extra loaded.
import './styles/tokens.css'
import './styles/atmosphere.css'
import './styles/shell.css'
import './styles/dashboard.css'
import './styles/presence.css'
import './styles/surfaces.css'
import './ui-v2/theme/tokens.css'
import './ui-v2/primitives/controls.css'
import './app/cards/cards.css'
import './app/chat/chat.css'
import './app/dressing/dressing.css'
import './app/screens/screens.css'
import './app/app.css'
import './app/shell-chrome.css'
import './app/boot/boot.css'

const ui = new URLSearchParams(window.location.search).get('ui')
if (ui === 'legacy') {
  void import('./legacyEntry')
} else if (ui === 'v2') {
  void import('./ui-v2/entry')
} else {
  void import('./app/entry')
}