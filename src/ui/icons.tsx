/**
 * 16 hand-drawn 24px stroke icons.
 *
 * A whole icon package is a dependency we do not need for sixteen glyphs, and
 * an inlined sprite keeps the offline/local-first promise with zero requests.
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
  home: <path d="M3 11 12 3l9 8v10h-6v-6H9v6H3z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  work: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5h6v2M3 12h18" />
    </>
  ),
  mission: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  vault: (
    <>
      <path d="M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 1-3-2-6-2-9-1z" />
      <path d="M12 6v14" />
    </>
  ),
  harness: (
    <>
      <path d="M4 17 8 8l3 5 3-8 5 12" />
      <path d="M3 21h18" />
    </>
  ),
  foundry: (
    <>
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="m3 7 9 5 9-5M12 12v10" />
    </>
  ),
  relay: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" />
    </>
  ),
  team: (
    <>
      <circle cx="12" cy="6" r="2.6" />
      <circle cx="6" cy="17" r="2.6" />
      <circle cx="18" cy="17" r="2.6" />
      <path d="M10.6 8.2 7.4 14.8M13.4 8.2l3.2 6.6M8.6 17h6.8" />
    </>
  ),
  office: (
    <>
      <path d="M3 20h18" />
      <path d="M5 20V9l7-5 7 5v11" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  minus: <path d="M5 12h14" />,
  expand: <path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5" />,
  pin: <path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ?? 'icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** The Freya mark. Replaces the prototype's wordmark glyph. */
export function FreyaMark({ size = 50, id = 'freya-mark' }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size * 0.88} viewBox="0 0 50 44" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe0a8" />
          <stop offset="1" stopColor="#b8752c" />
        </linearGradient>
      </defs>
      <path d="M25 2 48 42H38L25 19 12 42H2z" fill={`url(#${id})`} />
      <path d="M25 27l6 10H19z" fill="#0a0806" stroke={`url(#${id})`} strokeWidth="1.5" />
    </svg>
  )
}
