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
if (ui === 'v2') {
  void import('./ui-v2/entry')
} else {
  void import('./app/entry')
}
