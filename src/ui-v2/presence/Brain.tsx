import type { BrainState } from './state'

/**
 * The Brain — Freya thinking.
 *
 * A cognition orb, not a face. Its colour comes from the active theme's CSS
 * tokens (`--f-action` intelligence, `--f-cognition` lilac), so it recolours with
 * the theme without a component edit. Its geometry is a golden-angle point
 * lattice inside two or three instrument rings, with a single core.
 *
 * Externally stable: `contain: layout size` and a fixed viewBox mean opening a
 * panel or sidebar never reflows, squashes or resizes it (uiplan.md:93–97). The
 * motion is internal, and it stops under `data-effects='reduced'`.
 */

const NODES = Array.from({ length: 26 }, (_, index) => {
  const angle = index * 2.399963229728653 // golden angle
  const radius = 8 + 92 * Math.sqrt((index + 0.5) / 26)
  return {
    x: 120 + radius * Math.cos(angle),
    y: 120 + radius * Math.sin(angle),
    r: 1 + (index % 3),
  }
})

export function Brain({ state, size = 260 }: { state: BrainState; size?: number }) {
  return (
    <div
      className="f-brain"
      data-state={state}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Freya cognition: ${state}`}
    >
      <svg className="f-brain-field" viewBox="0 0 240 240" aria-hidden="true">
        <circle className="f-brain-ring" cx="120" cy="120" r="112" />
        <circle className="f-brain-ring f-brain-ring--dim" cx="120" cy="120" r="96" strokeDasharray="1 10" />
        <circle className="f-brain-ring" cx="120" cy="120" r="78" />
        <g className="f-brain-lattice">
          {NODES.map((node, index) => (
            <circle key={index} className="f-brain-node" cx={node.x} cy={node.y} r={node.r} />
          ))}
        </g>
        <circle className="f-brain-core" cx="120" cy="120" r="9" />
      </svg>
    </div>
  )
}
