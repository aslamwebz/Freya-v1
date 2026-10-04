import { Card, Chip, Row } from '../cards/Card'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import type { ScreenSlots } from './Home'

/**
 * Settings — no dedicated render; built in the same language as Home/Mind.
 *
 * The environment's controls, grouped: appearance, cognition, privacy,
 * connections and about. Design-phase sample state; the live appearance
 * controls are owned by the dressing table and preferences store.
 */

const CATEGORIES = [
  { id: 'appearance', label: 'Appearance', icon: 'focus' },
  { id: 'cognition', label: 'Cognition', icon: 'core' },
  { id: 'privacy', label: 'Privacy', icon: 'settings' },
  { id: 'connections', label: 'Connections', icon: 'relay' },
  { id: 'about', label: 'About', icon: 'world' },
] as const

const THEMES_UI = [['Abyss', '#6fdcff'], ['Dawn', '#0a6d86'], ['Vessel', '#7fe3c4'], ['Violet', '#b79cf0']] as const
const PRIVACY = [['Local-only memory', 'On'], ['Cloud sync', 'Off'], ['Telemetry', 'Off'], ['Window observation', 'Ask each time']] as const
const COGNITION = [['Reasoning engine', 'Configured'], ['Embeddings', 'Local'], ['Speech to text', 'Not installed'], ['Text to speech', 'Not installed']] as const
const ABOUT = [['Version', 'Phase 19 · Build 19.0.1'], ['Licence', 'Personal'], ['Journal', 'Encrypted'], ['Memory', 'Durable']] as const

export function Settings(): ScreenSlots {
  return {
    left: (
      <Card title="Settings" icon="settings">
        <nav className="st-nav">
          {CATEGORIES.map((category, index) => (
            <button key={category.id} type="button" className="st-cat" data-active={index === 0} aria-current={index === 0 ? 'true' : undefined}>
              <Glyph name={category.icon} size={16} /><span>{category.label}</span>
            </button>
          ))}
        </nav>
      </Card>
    ),
    right: (
      <>
        <Card title="Appearance" icon="focus" subtitle="Look and feel">
          <div className="st-themes">{THEMES_UI.map(([name, color], index) => (
            <button key={name} type="button" className="st-theme" data-active={index === 0} aria-pressed={index === 0}>
              <span className="st-swatch" style={{ background: color }} />
              <span>{name}</span>
            </button>
          ))}</div>
          <div className="c-rows">
            <Row title="Density" detail="Comfortable" end={<Chip>Change</Chip>} />
            <Row title="Reduced motion" detail="Follow system" end={<Chip tone="accent">On</Chip>} />
            <Row title="Ambient glow" detail="Activity only" end={<Chip tone="accent">On</Chip>} />
          </div>
        </Card>
        <Card title="Privacy" icon="settings" subtitle="Local-first">
          <div className="c-rows">{PRIVACY.map(([label, value]) => <Row key={label} title={label} end={<span className="st-value">{value}</span>} />)}</div>
        </Card>
      </>
    ),
    bottom: (
      <>
        <Card title="Cognition" icon="core" subtitle="Models and engines" className="c-bottom-card">
          <div className="c-rows">{COGNITION.map(([label, value]) => <Row key={label} icon="core" title={label} end={<span className="st-value">{value}</span>} />)}</div>
        </Card>
        <Card title="Connections" icon="relay" subtitle="4 services" className="c-bottom-card">
          <div className="c-rows">
            <Row icon="relay" title="Gmail" detail="Mail" end={<Chip tone="accent">Connected</Chip>} />
            <Row icon="relay" title="Notion" detail="Documents" end={<Chip tone="accent">Connected</Chip>} />
            <Row icon="relay" title="Slack" detail="Messaging" end={<Chip>Paused</Chip>} />
            <Row icon="relay" title="GitHub" detail="Code" end={<Chip tone="accent">Connected</Chip>} />
          </div>
        </Card>
        <Card title="About" icon="world" subtitle="This build" className="c-bottom-card">
          <div className="c-rows">{ABOUT.map(([label, value]) => <div key={label} className="c-mini-row"><span className="c-mini-dot" /><span className="c-row-text"><b>{label}</b></span><span className="c-row-end">{value}</span></div>)}</div>
        </Card>
      </>
    ),
  }
}
