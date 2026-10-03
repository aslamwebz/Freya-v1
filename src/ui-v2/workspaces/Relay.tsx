import { Badge, Button, Panel, Field } from '../primitives/Controls'
import { Filters, ListRow, PendingView, isLiveMode, type WorkspaceProps } from './shared'
const chats = [
  { id: 'jordan', name: 'Jordan Kim', role: 'Product lead', topic: 'Product launch alignment', text: 'The updated timeline is ready for review.', org: 'Aurora Labs', location: 'San Francisco' },
  { id: 'studio', name: 'Design Studio', role: 'Creative team', topic: 'Creative review tomorrow', text: 'Let\'s compare the next workspace concepts.', org: 'Freya Labs', location: 'Remote' },
  { id: 'elena', name: 'Elena Cruz', role: 'Collaborator', topic: 'Partnership opportunity', text: 'A few possibilities to explore together.', org: 'Cedar Capital', location: 'New York' },
  { id: 'operations', name: 'Operations', role: 'Operations team', topic: 'Weekly sync notes', text: 'A summary of the next steps.', org: 'Freya Labs', location: 'Remote' },
]
export function Relay({ snapshot, view, update }: WorkspaceProps) {
  if (isLiveMode(snapshot)) {
    return <div className="f-workspace"><PendingView title="Relay is not wired yet"
      detail="No live Relay projection exists. The conversations above are concept art from the design preview, not real messages. Relay connectors arrive with the connector phases." /></div>
  }
  const selected = chats.find((chat) => chat.id === view.selected) ?? chats[0]!
  const draft = view.conversationDrafts[selected.id] ?? ''
  const filtered = chats.filter((chat) => (view.filter !== 'Pinned' || view.pinned.includes(chat.id)) &&
    (chat.name + chat.topic).toLowerCase().includes(view.query.toLowerCase()))
    .sort((a, b) => Number(view.pinned.includes(b.id)) - Number(view.pinned.includes(a.id)))
  return <div className="f-relay-grid">
    <Panel title="Conversations"><Filters options={['All', 'Pinned']} selected={view.filter} onSelect={(filter) => update({ filter })} />
      <Field label="Search conversations" value={view.query} placeholder="People or conversations…" onChange={(event) => update({ query: event.target.value })} />
      <div className="f-conversations">{filtered.map((chat) => <div className="f-chat-row" data-selected={selected.id === chat.id} key={chat.id}>
        <Button className="f-chat-select" onClick={() => update({ selected: chat.id })}><span className="f-avatar">{chat.name.split(' ').map((word) => word[0]).slice(0, 2).join('')}</span>
          <span><strong>{chat.name}</strong><small>{chat.topic}</small></span></Button>
        <Button aria-label={`${view.pinned.includes(chat.id) ? 'Unpin' : 'Pin'} conversation with ${chat.name}`} aria-pressed={view.pinned.includes(chat.id)}
          onClick={() => update({ pinned: view.pinned.includes(chat.id) ? view.pinned.filter((id) => id !== chat.id) : [...view.pinned, chat.id] })}>⌖</Button>
      </div>)}</div>{!filtered.length && <p className="f-muted">No conversations match this view.</p>}
    </Panel>
    <Panel title={selected.name} meta={<Badge tone="cognition">{selected.role}</Badge>}>
      <div className="f-thread">
        <div className="f-message"><small>{selected.name}</small><p>{selected.text}</p></div>
        <div className="f-message f-message--freya"><small>Freya</small><p>We can bring the decisions, context and next steps into one place.</p></div>
        {view.replies.filter((reply) => reply.conversation === selected.id).map((reply, index) => <div className="f-message" key={index}><small>Your reply</small><p>{reply.text}</p></div>)}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) update({ replies: [...view.replies, { conversation: selected.id, text: draft }], conversationDrafts: { ...view.conversationDrafts, [selected.id]: '' } }) }}>
        <Field label="Preview reply" value={draft} placeholder="Try the conversation layout…" onChange={(event) => update({ conversationDrafts: { ...view.conversationDrafts, [selected.id]: event.target.value } })} />
        <Button type="submit" disabled={!draft.trim()}>Add preview reply</Button>
      </form>
    </Panel>
    <Panel title="Person details">
      <ListRow icon="mission" title="Role" detail={selected.role} />
      <ListRow icon="world" title="Organization" detail={selected.org} />
      <ListRow icon="relay" title="Location" detail={selected.location} />
      <ListRow icon="people" title="Shared projects" detail="3 active" />
      <ListRow icon="mission" title="Last interaction" detail="2 hours ago" />
    </Panel>
    <Panel title="Connections">
      <div className="f-connector-grid">{['Email', 'Messaging', 'Files', 'Tools'].map((label) =>
        <div key={label} className="f-connector"><span className="f-orbit-mark" aria-hidden="true" /><b>{label}</b><small>Connect</small></div>)}</div>
      <p className="f-muted">Connect services to share context across conversations.</p>
    </Panel>
  </div>
}
