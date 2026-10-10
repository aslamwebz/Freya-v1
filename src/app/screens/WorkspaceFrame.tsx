import { useId, useRef, type ReactNode } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import './unified-workspaces.css'

export interface SectionTab { readonly id: string; readonly label: string }

export function ContextTabs({ label, tabs, selected, onSelect, children }: {
  label: string; tabs: readonly SectionTab[]; selected: string; onSelect: (id: string) => void; children: ReactNode
}) {
  const prefix = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const active = tabs.find(tab => tab.id === selected) ?? tabs[0]!
  return <>
    <div className="uw-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
        id={`${prefix}-${tab.id}-tab`} aria-controls={`${prefix}-panel`} aria-selected={active.id === tab.id}
        tabIndex={active.id === tab.id ? 0 : -1} ref={node => { buttons.current[index] = node }}
        onClick={() => onSelect(tab.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
          if (next === null) return
          event.preventDefault()
          onSelect(tabs[next]!.id)
          buttons.current[next]?.focus()
        }}>{tab.label}</button>)}
    </div>
    <section className="uw-panel" role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-${active.id}-tab`} tabIndex={0}>
      {children}
    </section>
  </>
}

export function WorkspaceFrame({ title, description, icon, children }: {
  title: string; description: string; icon: string; children: ReactNode
}) {
  return <div className="uw-workspace">
    <header className="uw-heading"><Glyph name={icon} size={28} /><div><h1>{title}</h1><p>{description}</p></div></header>
    {children}
  </div>
}
