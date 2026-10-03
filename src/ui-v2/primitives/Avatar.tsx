import people from '../assets/reference-people.webp'

const portraits = [
  { x: 1401, y: 213, size: 112 },
  { x: 384, y: 240, size: 66 },
  { x: 413, y: 181, size: 38 },
  { x: 282, y: 308, size: 52 },
]

/** Native SVG viewport crops portraits from the supplied current design reference. */
export function Avatar({ index = 0, size = 40, label }: { index?: number; size?: number; label?: string }) {
  const portrait = portraits[index % portraits.length]!
  return <svg className="f-avatar" width={size} height={size} viewBox={`0 0 ${portrait.size} ${portrait.size}`}
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <image href={people} width="1672" height="941" x={-portrait.x + portrait.size / 2} y={-portrait.y + portrait.size / 2} />
  </svg>
}
