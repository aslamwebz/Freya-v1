export const THEMES = ['abyss', 'dawn', 'violet', 'vessel'] as const
export type ThemeId = (typeof THEMES)[number]

export interface ThemeTokens {
  bg: string; panel: string; panelRaised: string
  ink: string; muted: string; heading: string
  line: string; glass: string; glassEdge: string
  intelligence: string; cognition: string; positive: string
  attention: string; danger: string; glow: string; onIntelligence: string
  sidebar: string; dock: string; dialog: string; input: string; button: string
  scrim: string; shadow: string; colorScheme: 'dark' | 'light'
}

const REGISTRY: Record<ThemeId, ThemeTokens> = {
  abyss: {
    bg: '#03070f', panel: '#081420', panelRaised: '#1d3346',
    ink: '#e8f1fb', muted: '#aec2d8', heading: '#a9ecff',
    line: '#7fb6d94a', glass: 'linear-gradient(135deg,#24425c66,#08131fb3 46%,#152a3f8a)',
    glassEdge: '#a9d6eeab',
    intelligence: '#6fdcff', cognition: '#b79cf0', positive: '#5fe3bd',
    attention: '#f0b45c', danger: '#ff8aa0', glow: '0 0 16px #6fdcff33',
    onIntelligence: '#04222f',
    sidebar: 'linear-gradient(180deg,#020710ea,#061321bd)',
    dock: 'linear-gradient(120deg,#0a2233e6,#06101cea 65%,#22354ade)',
    dialog: '#08182af5', input: '#05131f78', button: '#07162685',
    scrim: '#081524ea', shadow: '0 12px 35px #0007', colorScheme: 'dark',
  },
  dawn: {
    bg: '#eef3f9', panel: '#f8fbff', panelRaised: '#dde7f2',
    ink: '#16263a', muted: '#4a5e76', heading: '#0d566b',
    line: '#5b7c9960', glass: 'linear-gradient(135deg,#ffffffc7,#e6eff9d1)',
    glassEdge: '#6b8fab9e',
    intelligence: '#0a6d86', cognition: '#6949a0', positive: '#0f7a5f',
    attention: '#8a5a12', danger: '#b02a4d', glow: '0 0 16px #0a6d8633',
    onIntelligence: '#f2fbff',
    sidebar: 'linear-gradient(180deg,#e7eff8d9,#dbe6f2d4)',
    dock: 'linear-gradient(120deg,#f7fbfff2,#dde8f4eb)',
    dialog: '#f4f9fdf5', input: '#eef5fbaa', button: '#e6eff899',
    scrim: '#eaf2f9f0', shadow: '0 10px 30px #14315126', colorScheme: 'light',
  },
  vessel: {
    bg: '#101214', panel: '#191d21', panelRaised: '#2b3238',
    ink: '#eef1f2', muted: '#a9b4b8', heading: '#bdf3df',
    line: '#8fa4a84a', glass: 'linear-gradient(135deg,#333d4366,#15191db3 46%,#242b318a)',
    glassEdge: '#b6c9c9ab',
    intelligence: '#7fe3c4', cognition: '#c8b2e6', positive: '#7ff0c0',
    attention: '#e8b268', danger: '#ff8fa0', glow: '0 0 16px #7fe3c433',
    onIntelligence: '#062b20',
    sidebar: 'linear-gradient(180deg,#0b0d0fea,#151a1ebd)',
    dock: 'linear-gradient(120deg,#18272ae6,#111518ea 65%,#2c3539de)',
    dialog: '#191f24f5', input: '#12171b78', button: '#161c2085',
    scrim: '#12181cea', shadow: '0 12px 35px #0007', colorScheme: 'dark',
  },
  violet: {
    bg: '#07050f', panel: '#120b21', panelRaised: '#2c1d48',
    ink: '#f1ecfb', muted: '#c2b4de', heading: '#dcc2ff',
    line: '#b79cf045', glass: 'linear-gradient(135deg,#3a2a5b66,#0d0818b3 46%,#1e16388a)',
    glassEdge: '#cbb4f0ab',
    intelligence: '#b79cf0', cognition: '#e0a9ff', positive: '#6fe3c4',
    attention: '#f0b45c', danger: '#ff8aa0', glow: '0 0 16px #b79cf033',
    onIntelligence: '#1a0f2b',
    sidebar: 'linear-gradient(180deg,#07050fea,#110b1fbd)',
    dock: 'linear-gradient(120deg,#1c1330e6,#0b0717ea 65%,#2a2044de)',
    dialog: '#130e20f5', input: '#0c081778', button: '#110c2185',
    scrim: '#0d091aea', shadow: '0 12px 35px #0007', colorScheme: 'dark',
  },
}

export function themeTokens(id: ThemeId): ThemeTokens { return REGISTRY[id] }

const VAR: Record<keyof ThemeTokens, string> = {
  bg: '--f-bg', panel: '--f-panel', panelRaised: '--f-panel-raised',
  ink: '--f-ink', muted: '--f-muted', heading: '--f-heading', line: '--f-line',
  glass: '--f-glass', glassEdge: '--f-glass-edge', intelligence: '--f-action',
  cognition: '--f-cognition', positive: '--f-positive', attention: '--f-attention',
  danger: '--f-danger', glow: '--f-glow', onIntelligence: '--f-on-action',
  sidebar: '--f-sidebar', dock: '--f-dock', dialog: '--f-dialog', input: '--f-input',
  button: '--f-button', scrim: '--f-scrim', shadow: '--f-shadow',
  colorScheme: 'color-scheme',
}

export function themeCss(id: ThemeId): string {
  const tokens = REGISTRY[id]
  const body = (Object.keys(tokens) as (keyof ThemeTokens)[])
    .map((key) => `  ${VAR[key]}: ${tokens[key]};`).join('\n')
  return `.freya-v2[data-theme='${id}'] {\n${body}\n}`
}
export function allThemeCss(): string { return THEMES.map(themeCss).join('\n') }
