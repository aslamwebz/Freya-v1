import { createRoot } from 'react-dom/client'
import { DesktopPresence } from './DesktopPresence'

const root = document.getElementById('root')
if (!root) throw new Error('presence window has no #root element')

createRoot(root).render(<DesktopPresence />)
