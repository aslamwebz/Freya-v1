import type { CSSProperties } from 'react'
const paths: Record<string, string> = {
  focus: 'M20 12a8 8 0 1 1-8-8m0 4a4 4 0 1 0 4 4m-4 0 9-9m-5 0h5v5',
  people: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9v-2a8 8 0 0 1 16 0v2H4Z',
  memory: 'M20 6c0 2-16 2-16 0s16-2 16 0ZM4 6v12c0 4 16 4 16 0V6M4 12c0 3 16 3 16 0',
  create: 'm12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7Z',
  home: 'M3 11 12 3l9 8M5 10v10h5v-6h4v6h5V10',
  chat: 'M4 5h16v11H9l-4 4V5Zm3 4h10M7 12h6',
  mind: 'M9 18c-5 0-6-7-3-9 0-5 6-6 6-2 0-4 6-3 6 2 3 2 2 9-3 9M12 7v14M7 11l3 2m7-2-3 2',
  mission: 'M12 3 2 21h20L12 3Zm0 6v5m0 3h.01',
  forge: 'm12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6',
  world: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z',
  life: 'M2 12h4l3-8 5 16 3-8h5',
  relay: 'M4 5h16v12H9l-5 4V5Zm4 5h8M8 13h5',
  workforce: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10v-2a7 7 0 0 1 14 0v2m1-17a4 4 0 0 1 0 7m2 3a6 6 0 0 1 3 5v2',
  widgets: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  core: 'M12 3 21 8v9l-9 5-9-5V8l9-5Zm0 5 5 3v5l-5 3-5-3v-5l5-3Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M6 6l1 1m10 10 1 1M6 18l1-1m10-10 1-1',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 6 6',
  mic: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4Zm-3 7v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',
  plus: 'M12 4v16M4 12h16',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  'win-min': 'M5 12h14',
  'win-max': 'M5 5h14v14H5z',
  'win-close': 'M6 6l12 12M18 6 6 18',
  attach: 'M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.19 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  chip: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M6 6h12v12H6zM9.5 9.5h5v5h-5z',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  chevron: 'm6 9 6 6 6-6',
  star: 'm12 3 2.55 5.9 6.45.55-4.9 4.2 1.5 6.35L12 16.9 6.4 20l1.5-6.35-4.9-4.2 6.45-.55L12 3Z',
  dress: 'M8 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 12v4m-3 0h6',
  activity: 'M3 12h3l2-5 4 10 3-7 2 2h4',
  bell: 'M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6m4 10a2.4 2.4 0 0 0 4 0',
}
export function Glyph({ name, size = 20, style }: { name: string; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name] ?? paths.core} /></svg>
}
