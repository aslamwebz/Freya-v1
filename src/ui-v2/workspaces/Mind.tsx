import { Panel } from '../primitives/Controls'
import { Compass, ListRow, PendingView, isLiveMode, type WorkspaceProps } from './shared'
export function Mind({ snapshot }: WorkspaceProps) {
  if (isLiveMode(snapshot)) {
    return <div className="f-workspace"><PendingView title="Mind is not wired yet"
      detail="No live Mind projection exists. The panels above are concept art from the design preview, not Freya's current context. Phase 20 wires this to the Unified Conscious Context." /></div>
  }
  return <div className="f-mind-grid">
    <Panel title="Self · Who I am now">
      <ListRow icon="mind" title="Curious" detail="Always learning, always connecting." />
      <ListRow icon="heart" title="Empathetic" detail="People and possibilities matter." />
      <ListRow icon="mission" title="Analytical" detail="Find patterns, seek truth." />
      <ListRow icon="mission" title="Purpose-driven" detail="Turn insight into meaningful impact." />
    </Panel>
    <Compass compact />
    <Panel title="You · About You">
      <ListRow icon="mind" title="Thoughtful" detail="You value depth, balance, and real progress." />
      <ListRow icon="world" title="Big-picture thinker" detail="You care about meaningful impact over noise." />
      <ListRow icon="mission" title="You trust me" detail="You bring great questions and bold ideas." />
      <ListRow icon="heart" title="You're building something important" detail="And you don't have to do it alone." />
    </Panel>
    <Panel title="Focus · What I'm Focusing On">
      <ListRow icon="mission" title="Product Roadmap — Phase 19" detail="72% complete" />
      <ListRow icon="world" title="Research Agent" detail="48% complete" />
      <ListRow icon="forge" title="Creator Tools" detail="36% complete" />
    </Panel>
    <Panel title="Goals · What We're Working Toward">
      <ListRow icon="mission" title="Launch Freya Phase 19" detail="A more abundant, connected, and intelligent future. · Mar 2025" />
      <ListRow icon="world" title="Grow community" detail="Expand reach and early adopter network. · Apr 2025" />
      <ListRow icon="forge" title="Enable real-world impact" detail="Turn ideas into tools, and tools into opportunity. · Ongoing" />
    </Panel>
    <Panel title="Now · What's Happening Right Now">
      <ListRow icon="life" title="Preparing design concepts" detail="Mind view, memory upgrades, and creator tools." />
      <ListRow icon="world" title="Monitoring key updates" detail="AI developments, market shifts, and opportunities." />
      <ListRow icon="mind" title="In a productive state" detail="Focused, aligned, and making steady progress." />
    </Panel>
    <Panel title="Aware of · Important Context">
      <ListRow icon="world" title="AI industry is accelerating" detail="New models, tools, and regulatory changes." />
      <ListRow icon="people" title="Your growing community" detail="Increasing interest and engagement." />
      <ListRow icon="mission" title="Opportunities for real-world use" detail="Education, business, and creative sectors." />
    </Panel>
    <Panel title="Waiting for · External Dependencies">
      <ListRow icon="relay" title="Partner feedback" detail="On collaboration and integration ideas. · 1-3 days" />
      <ListRow icon="mission" title="Content approvals" detail="For website and launch materials. · 2-4 days" />
      <ListRow icon="world" title="Market research data" detail="Final reports and trend analysis. · This week" />
    </Panel>
    <Panel title="Uncertain about · Open Questions">
      <ListRow icon="mind" title="Which partnerships will move fastest?" detail="Still evaluating fit and timing." />
      <ListRow icon="world" title="How will regulations evolve?" detail="Potential impacts on roadmap." />
      <ListRow icon="mission" title="What features will matter most?" detail="Gathering more user feedback." />
    </Panel>
    <Panel title="Next · What's Coming Up">
      <ListRow icon="life" title="Review design concepts" detail="Mind view and memory updates. · Today" />
      <ListRow icon="forge" title="Prepare launch messaging" detail="Refine positioning and key differentiators. · This week" />
      <ListRow icon="relay" title="Plan community update" detail="Share progress and next steps. · This week" />
    </Panel>
  </div>
}
