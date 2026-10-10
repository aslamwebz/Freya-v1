import { Glyph } from '../../ui-v2/primitives/Glyph'
import { PRIMARY_DESTINATIONS, type Destination } from '../state/routes'

/** Stable page navigation; conversation history belongs to its own context region. */
export function PrimaryNavigation({ active, onSelect }: { active: Destination; onSelect: (destination: Destination) => void }) {
  return <nav className="hd-rail-list" aria-label="Primary">
    {PRIMARY_DESTINATIONS.map(([id, label, icon]) => <button key={id} className="hd-place" type="button"
      aria-label={id === 'chat' ? 'Open Chats' : label} title={label} aria-current={id === active ? 'page' : undefined}
      onClick={() => onSelect(id)}><Glyph name={icon} size={20} /><span>{label}</span></button>)}
  </nav>
}
