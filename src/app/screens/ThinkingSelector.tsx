import { useEffect, useRef, useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { readModelCatalog } from '../../platform/modelClient'
import { coreMirror } from '../../platform/coreClient'
import { AnchoredMenu } from './AnchoredMenu'

export type ThinkingLevel = string
export const THINKING_LEVEL_KEY = 'freya.thinkingLevel'
export function readStoredThinkingLevel(): ThinkingLevel {
  try { return localStorage.getItem(THINKING_LEVEL_KEY) || 'auto' } catch { return 'auto' }
}
export function writeStoredThinkingLevel(level: ThinkingLevel): void {
  try { localStorage.setItem(THINKING_LEVEL_KEY, level) } catch { /* Optional preference storage. */ }
}

/** Provider metadata defines choices. No model-family inference or effort templates. */
export function ThinkingSelector({ value, onChange, defaultModel = null }: {
  value?: string | null; onChange?: (level: ThinkingLevel) => void; defaultModel?: string | null
} = {}) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState(value || 'auto')
  const [efforts, setEfforts] = useState<readonly string[]>([])
  const [note, setNote] = useState('The model has not reported selectable thinking levels.')
  const [loading, setLoading] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  useEffect(() => { setCurrent(value || 'auto') }, [value])
  useEffect(() => {
    const mirror = coreMirror()
    let selection = JSON.stringify(mirror.status?.modelSelection)
    return mirror.subscribe(() => {
      const next = JSON.stringify(mirror.status?.modelSelection)
      if (selection === next) return
      selection = next
      generation.current += 1
      setEfforts([])
      setLoading(false)
      setCurrent('auto')
      writeStoredThinkingLevel('auto')
      onChange?.('auto')
      setNote('The model has not reported selectable thinking levels.')
    })
  }, [onChange])
  useEffect(() => () => { generation.current += 1 }, [])
  const choose = (effort: string) => {
    setCurrent(effort); writeStoredThinkingLevel(effort); onChange?.(effort); setOpen(false)
  }
  const toggle = async () => {
    if (open) { setOpen(false); return }
    setOpen(true); setLoading(true)
    const requestGeneration = ++generation.current
    try {
      const result = await readModelCatalog()
      if (requestGeneration !== generation.current) return
      const model = result.selected ?? result.defaultModel ?? defaultModel
      const status = coreMirror().status?.modelSelection
      const providerId = result.selectedProviderId ?? status?.providerId
      const entry = result.models?.find(candidate => candidate.id === model && (!providerId || candidate.providerId === providerId))
      const reported = entry?.reasoningEfforts ?? []
      setEfforts(reported)
      setNote(result.operation === 'refused' ? result.reason ?? 'Thinking metadata could not be read.' : 'The model has not reported selectable thinking levels.')
      if (current !== 'auto' && !reported.includes(current)) {
        setCurrent('auto'); writeStoredThinkingLevel('auto'); onChange?.('auto')
      }
    } catch { if (requestGeneration === generation.current) { setEfforts([]); setNote('Thinking metadata could not be read.') } }
    finally { if (requestGeneration === generation.current) setLoading(false) }
  }
  const selected = efforts.includes(current) ? current : 'Provider default'
  return <div className="hd-select hd-thinking-select">
    <button ref={anchor} type="button" className="hd-tool hd-tool-thinking" aria-haspopup="menu" aria-expanded={open} aria-label={`Thinking level: ${selected}`} title={efforts.length ? 'Levels reported by the selected model' : note} onClick={() => { void toggle() }}>
      <Glyph name="mind" size={16} /><span>{selected}</span>
    </button>
    {open ? <AnchoredMenu anchorRef={anchor} onClose={() => setOpen(false)} label="Thinking effort level">
      <li><button type="button" role="menuitemradio" aria-checked={current === 'auto'} onClick={() => choose('auto')}>Provider default</button></li>
      {loading ? <li role="status">Reading model capabilities…</li> : efforts.length ? efforts.map(effort => <li key={effort}><button type="button" role="menuitemradio" aria-checked={effort === current} onClick={() => choose(effort)}>{effort}</button></li>) : <li role="status">{note}</li>}
    </AnchoredMenu> : null}
  </div>
}
