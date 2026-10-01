/**
 * Freya's own icon set.
 *
 * A shared grammar rather than a borrowed shape: every glyph is drawn on a
 * 24-unit grid with a 1.5 stroke, a deliberately plain silhouette, and one
 * small "instrument" accent — a tick, a dot, or a bar — so the set reads as
 * laboratory equipment. Corner joins are cut, not rounded, except where a
 * circle is the subject.
 *
 * Drawn in-house so the set belongs to Freya rather than to the reference.
 */

export type IconName =
  | 'home'
  | 'search'
  | 'work'
  | 'mission'
  | 'vault'
  | 'harness'
  | 'foundry'
  | 'relay'
  | 'team'
  | 'context'
  | 'office'
  | 'shield'
  | 'settings'
  | 'mic'
  | 'close'
  | 'minus'
  | 'expand'
  | 'pin'
  | 'send'

const PATHS: Record<IconName, React.ReactNode> = {
  // Roofline over a plinth, with a centre tick.
  home: (
    <>
      <path d="M4 10.5 12 3.5l8 7" />
      <path d="M6.5 9v11.5h11V9" />
      <path d="M12 13.5v4" />
    </>
  ),

  // A lens with a focus dot; the handle stops short of the corner.
  search: (
    <>
      <path d="M10.5 3.8a6.7 6.7 0 1 0 0 13.4 6.7 6.7 0 0 0 0-13.4Z" />
      <path d="m15.4 15.4 5 5" />
      <circle cx="10.5" cy="10.5" r="1.7" />
    </>
  ),

  // Square brackets with a bar running through the middle.
  work: (
    <>
      <path d="M8.5 4.5h-4v15h4" />
      <path d="M15.5 4.5h4v15h-4" />
      <path d="M8 12h8" />
    </>
  ),

  // Three rings and a centre dot.
  mission: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.6" />
      <path d="M12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2" />
    </>
  ),

  // A door seam with a dial.
  vault: (
    <>
      <path d="M4 3.5h16v17H4z" />
      <path d="M12 3.5v17" />
      <circle cx="8.2" cy="12" r="2.4" />
      <path d="M17.4 8.6v6.8" />
    </>
  ),

  // A signal inside brackets.
  harness: (
    <>
      <path d="M4 5v14" />
      <path d="M20 5v14" />
      <path d="M8 14.5 10.4 9l2.4 4L15 7.5" />
      <path d="M8 17.5h8" />
    </>
  ),

  // A hexagonal cell with a spark at the core.
  foundry: (
    <>
      <path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <path d="M12 8.6v6.8M8.6 12h6.8" />
    </>
  ),

  // An outbound arrow crossing a channel.
  relay: (
    <>
      <path d="M3 6.5h6M3 17.5h6" />
      <path d="M3 12h12" />
      <path d="m12 8 4 4-4 4" />
      <path d="M20.5 6.5v11" />
    </>
  ),

  // Three posts on a triangle, joined by spokes.
  team: (
    <>
      <circle cx="12" cy="4.9" r="2.1" />
      <circle cx="5" cy="17.5" r="2.1" />
      <circle cx="19" cy="17.5" r="2.1" />
      <path d="m10.4 6.6-4 9.2M13.6 6.6l4 9.2M7.2 17.5h9.6" />
    </>
  ),

  // Four corner brackets around a subject dot: what is framed, not what is
  // watched — context as Core reports it, never capture.
  context: (
    <>
      <path d="M4 8.4V4h4.4M15.6 4H20v4.4M20 15.6V20h-4.4M8.4 20H4v-4.4" />
      <circle cx="12" cy="12" r="2.3" />
    </>
  ),

  // An open cell over a floor line.
  office: (
    <>
      <path d="M12 3.5 20 8v9l-8 3.5L4 17V8z" />
      <path d="M4 8l8 4.5L20 8M12 12.5v8" />
    </>
  ),

  // A shield with a keyhole notch cut from the top.
  shield: (
    <>
      <path d="M12 3.2 4.8 6v6.2c0 4 3 7 7.2 8.6 4.2-1.6 7.2-4.6 7.2-8.6V6z" />
      <circle cx="12" cy="11" r="2.1" />
      <path d="M12 13.2v3.4" />
    </>
  ),

  // A hexagonal ring with three ticks: a dial, not a cog.
  settings: (
    <>
      <path d="m12 3.6 7 4v8.8l-7 4-7-4V7.6z" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 3.6v3.2M19 16.4l-2.8-1.6M5 16.4l2.8-1.6" />
    </>
  ),

  // A capsule on a stand, closing on a bar rather than an arc.
  mic: (
    <>
      <rect x="9" y="2.8" width="6" height="11.4" rx="3" />
      <path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0" />
      <path d="M12 17.8v3.4M8.6 21.2h6.8" />
    </>
  ),

  close: (
    <>
      <path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />
    </>
  ),

  minus: (
    <>
      <path d="M5 12h14" />
      <path d="M7.6 8.4v7.2M16.4 8.4v7.2" opacity="0.4" />
    </>
  ),

  // Four corner brackets drawn as one continuous gesture.
  expand: (
    <>
      <path d="M9.4 4H4v5.4M14.6 4H20v5.4M20 14.6V20h-5.4M9.4 20H4v-5.4" />
    </>
  ),

  // A tack: cap, shaft, crossbar.
  pin: (
    <>
      <circle cx="12" cy="7.4" r="3.9" />
      <path d="M12 11.3v9.4" />
      <path d="M7.4 7.4h9.2" opacity="0.45" />
    </>
  ),

  // A dart leaving a launch bar.
  send: (
    <>
      <path d="M20.5 3.5 10 14" />
      <path d="M20.5 3.5 14 20.5l-4-6.5-6.5-4z" />
      <path d="M3.5 20.5h5" />
    </>
  ),
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ?? 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/**
 * The Freya mark: an aperture.
 *
 * A vesica — two mirrored arcs meeting at two points — with a smaller one
 * nested inside and a core dot. It is the presence: an instrument pointed at
 * something, not a letter.
 */
export function FreyaMark({ size = 48, id = 'freya-mark' }: { size?: number; id?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Freya"
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#fff2d6" />
          <stop offset="0.55" stopColor="#e2ac5c" />
          <stop offset="1" stopColor="#a96a24" />
        </linearGradient>
      </defs>
      <path
        d="M24 2.6C33.4 13.8 33.4 34.2 24 45.4 14.6 34.2 14.6 13.8 24 2.6Z"
        fill={`url(#${id})`}
        fillOpacity="0.16"
        stroke={`url(#${id})`}
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M24 11.2c5.4 6.6 5.4 19 0 25.6-5.4-6.6-5.4-19 0-25.6Z"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="1.4"
        opacity="0.78"
      />
      <circle cx="24" cy="24" r="2.1" fill={`url(#${id})`} />
    </svg>
  )
}
