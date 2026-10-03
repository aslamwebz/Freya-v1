import { Card } from '../cards/Card'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import type { ScreenSlots } from './Home'
import portrait from '../../ui-v2/assets/freya-portrait.webp'

/**
 * Relay — render #7, 1:1.
 *
 * Conversations on the left, Freya at the centre of people, conversations and
 * connections, and the open thread on the right. Sample data for the design
 * phase; a live build would bind the list and thread to real Relay channels.
 */

const FILTERS = ['All', 'People', 'Groups', 'Unread', 'Mentions']

interface Conversation { readonly name: string; readonly preview: string; readonly when: string; readonly unread: number; readonly initial: string }
const CONVERSATIONS: readonly Conversation[] = [
  { name: 'Jordan Kim', preview: "Here's the updated timeline for Phase 19…", when: '9:42 AM', unread: 3, initial: 'J' },
  { name: 'Design Studio', preview: 'The visual direction is looking incredible…', when: '8:17 AM', unread: 1, initial: 'D' },
  { name: 'Elena Cruz', preview: 'Would love your thoughts on this…', when: '6:58 AM', unread: 0, initial: 'E' },
  { name: 'Operations', preview: 'Summary and next steps are ready…', when: 'Yesterday', unread: 4, initial: 'O' },
  { name: 'Marcus Lee', preview: 'This aligns perfectly with our goals…', when: 'Yesterday', unread: 0, initial: 'M' },
  { name: 'Strategic Council', preview: 'A few key decisions to confirm…', when: 'Jan 26', unread: 2, initial: 'S' },
]

const TABS = ['Conversation', 'Profile', 'Shared', 'Connections']

const NODES = [
  { label: 'EMAIL', detail: 'Gmail · Outlook · + others', icon: 'relay', pos: 'tl' },
  { label: 'MESSAGING', detail: 'Teams · Slack · WhatsApp', icon: 'chat', pos: 'tr' },
  { label: 'FILES', detail: 'Drive · Notion · SharePoint', icon: 'memory', pos: 'bl' },
  { label: 'TOOLS', detail: 'Asana · Linear · GitHub', icon: 'core', pos: 'br' },
] as const

interface Message { readonly from: string; readonly time: string; readonly text: string; readonly recs?: readonly string[]; readonly file?: { name: string; meta: string } }
const MESSAGES: readonly Message[] = [
  { from: 'Jordan Kim', time: '9:12 AM', text: "Here's the updated timeline for Phase 19. The team is aligned and ready to move forward." },
  { from: 'Jordan Kim', time: '9:14 AM', text: '', file: { name: 'Phase 19 Launch Plan', meta: 'Notion Document · Updated 9:14 AM' } },
  { from: 'Jordan Kim', time: '9:28 AM', text: 'Would love your thoughts on the messaging angle for the customer announcement.' },
  { from: 'Freya', time: '9:36 AM', text: "I've analyzed the latest feedback and market sentiment. Here are a few recommendations for the messaging direction…", recs: ['Emphasize real-world impact and outcomes', 'Highlight customer success signals', 'Position Phase 19 as a platform for broader potential'] },
  { from: 'Jordan Kim', time: '9:42 AM', text: "This looks great. Let's discuss in our sync." },
]

const SERVICES = ['G', 'O', 'D', 'S', 'A', 'L', 'H', 'F']

export function Relay(): ScreenSlots {
  return {
    left: null,
    right: null,
    layout: 'wide',
    centre: (
      <div className="rl-view">
        <Card title="Conversations" icon="relay" className="rl-conversations" meta={<button type="button" className="rl-add" aria-label="New conversation">+</button>}>
          <div className="w-filters">{FILTERS.map((filter, index) => <button key={filter} type="button" className="w-filter" aria-pressed={index === 0}>{filter}</button>)}</div>
          <div className="rl-list">
            {CONVERSATIONS.map((conversation, index) => (
              <button key={conversation.name} type="button" className="rl-conv" data-active={index === 0} aria-current={index === 0 ? 'true' : undefined}>
                <span className="c-avatar">{conversation.initial}</span>
                <span className="rl-conv-text"><b>{conversation.name}</b><small>{conversation.preview}</small></span>
                <span className="rl-conv-meta"><em>{conversation.when}</em>{conversation.unread > 0 ? <i className="rl-badge">{conversation.unread}</i> : null}</span>
              </button>
            ))}
          </div>
        </Card>

        <div className="rl-centre">
          <div className="rl-portrait">
            <img src={portrait} alt="" aria-hidden="true" />
            {NODES.map((node) => (
              <span key={node.label} className="rl-node" data-pos={node.pos}>
                <span className="rl-node-icon"><Glyph name={node.icon} size={16} /></span>
                <b>{node.label}</b>
                <small>{node.detail}</small>
              </span>
            ))}
            <div className="rl-caption"><b>FREYA</b><span>RELAY</span><small>PEOPLE · CONVERSATIONS · CONNECTIONS</small></div>
          </div>
          <div className="rl-stats">
            <div className="rl-stat">
              <header><Glyph name="people" size={16} /> People</header>
              <b>28</b><small>Active collaborators</small>
              <span className="rl-avatars">{['A', 'B', 'C', 'D'].map((initial) => <span key={initial} className="c-avatar">{initial}</span>)}<span className="c-avatar c-avatar-more">+22</span></span>
            </div>
            <div className="rl-stat">
              <header><Glyph name="relay" size={16} /> Conversations</header>
              <b>12</b><small>Active threads</small>
              <span className="rl-bars" aria-hidden="true">{[8, 14, 10, 18, 12, 16].map((height, index) => <i key={index} style={{ height }} />)}</span>
            </div>
            <div className="rl-stat">
              <header><Glyph name="core" size={16} /> Connectors</header>
              <b>8</b><small>Connected services</small>
              <span className="rl-services">{SERVICES.map((service) => <i key={service}>{service}</i>)}</span>
            </div>
          </div>
        </div>

        <Card title="Jordan Kim" icon="people" subtitle="Head of Product · Aurora Labs" className="rl-thread" meta={<span className="c-more" aria-hidden="true">•••</span>}>
          <div className="w-tabs">{TABS.map((tab, index) => <span key={tab} data-active={index === 0}>{tab}</span>)}</div>
          <div className="rl-messages">
            {MESSAGES.map((message, index) => (
              <article key={index} className="rl-msg" data-mine={message.from === 'Freya'}>
                <span className="c-avatar">{message.from === 'Freya' ? 'F' : 'J'}</span>
                <div className="rl-bubble">
                  <header><b>{message.from}</b><small>{message.time}</small></header>
                  {message.text ? <p>{message.text}</p> : null}
                  {message.file ? <div className="rl-file"><Glyph name="memory" size={16} /><span><b>{message.file.name}</b><small>{message.file.meta}</small></span></div> : null}
                  {message.recs ? (
                    <div className="rl-recs">
                      <header><b>3 key recommendations</b><span aria-hidden="true">›</span></header>
                      <ul>{message.recs.map((rec) => <li key={rec}>{rec}</li>)}</ul>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
          <form className="rl-reply" onSubmit={(event) => event.preventDefault()}>
            <input aria-label="Reply to Jordan" placeholder="Reply to Jordan…" />
            <button type="submit" aria-label="Send reply"><Glyph name="arrow" size={16} /></button>
          </form>
        </Card>
      </div>
    ),
    bottom: null,
  }
}
