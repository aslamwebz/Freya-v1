import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import './styles/tokens.css'
import './styles/atmosphere.css'
import './styles/shell.css'
import './styles/dashboard.css'
import './styles/presence.css'
import './styles/surfaces.css'

const container = document.getElementById('root')
if (!container) throw new Error('Freya: #root is missing from the document')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
