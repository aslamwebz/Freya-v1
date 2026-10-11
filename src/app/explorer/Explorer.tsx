import { useEffect, useMemo, useState, type PointerEvent } from 'react'
import type { ExplorerNode, ExplorerSnapshot } from '../../../shared/contracts/explorer'
import './explorer.css'

export function Explorer({ snapshot, initialMode = 'graph', onAction, onSelectNode }: { snapshot: ExplorerSnapshot; initialMode?: 'graph' | 'table' | 'detail'; onAction?: (node: ExplorerNode, action: string) => void; onSelectNode?: (node: ExplorerNode) => void }) {
  const [mode, setMode] = useState(initialMode)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => setMode(initialMode), [initialMode])
  const select = (id: string | null) => { setSelected(id); const node = snapshot.nodes.find(node => node.id === id); if (node) onSelectNode?.(node) }
  const [search, setSearch] = useState('')
  const [category, filter] = useState('all')
  const [focused, focus] = useState<string | null>(null)
  const [sort, setSort] = useState<keyof ExplorerNode>('name')
  const [descending, reverse] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [positions, position] = useState<Record<string, { x: number; y: number }>>({})
  const [drag, setDrag] = useState<{ id: string | null; x: number; y: number; startX: number; startY: number } | null>(null)
  const categories = [...new Set(snapshot.nodes.map(node => node.type))].sort()
  const neighbours = useMemo(() => new Set(snapshot.edges.filter(edge => edge.from === focused || edge.to === focused).flatMap(edge => [edge.from, edge.to])), [focused, snapshot.edges])
  const nodes = snapshot.nodes.filter(node => (category === 'all' || node.type === category) && (!focused || node.id === focused || neighbours.has(node.id)) && `${node.name} ${node.type} ${node.purpose} ${node.source}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (descending ? -1 : 1))
  const coordinates = useMemo(() => Object.fromEntries(nodes.map((node, index) => {
    const ring = Math.floor(index / 18), rings = Math.max(1, Math.ceil(nodes.length / 18) - 1), angle = (index % 18 / Math.min(18, nodes.length) + ring * .025) * Math.PI * 2
    return [node.id, positions[node.id] ?? { x: 430 + Math.cos(angle) * (70 + ring * 280 / rings), y: 320 + Math.sin(angle) * (55 + ring * 195 / rings) }]
  })), [nodes, positions])
  const detail = snapshot.nodes.find(node => node.id === selected)
  const edges = snapshot.edges.filter(edge => coordinates[edge.from] && coordinates[edge.to])
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const x = drag.startX + (event.clientX - drag.x) / zoom, y = drag.startY + (event.clientY - drag.y) / zoom
    if (drag.id) position(prev => ({ ...prev, [drag.id!]: { x, y } }))
    else setOffset({ x, y })
  }
  return <div className="fx-explorer">
    <div className="fx-toolbar"><div role="tablist" aria-label="Explorer views">{(['graph', 'table', 'detail'] as const).map(view => <button key={view} role="tab" aria-selected={mode === view} onClick={() => setMode(view)}>{view === 'graph' ? 'Graph' : view === 'table' ? 'Table' : 'Details'}</button>)}</div><input aria-label="Search explorer" placeholder="Search names, purpose or source" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Filter category" value={category} onChange={event => filter(event.target.value)}><option value="all">All categories</option>{categories.map(type => <option key={type}>{type}</option>)}</select></div>
    <p className="fx-provenance">{snapshot.source} · {new Date(snapshot.generatedAt).toLocaleString('en-GB')} · {nodes.length} of {snapshot.nodes.length} nodes</p>
    {focused && <button onClick={() => focus(null)}>Show all connections</button>}
    <div className="fx-body"><section className="fx-canvas" aria-label="Explorer content">
      {mode === 'graph' ? <><div className="fx-zoom"><button aria-label="Zoom in" onClick={() => setZoom(value => Math.min(3, value + .2))}>+</button><button aria-label="Zoom out" onClick={() => setZoom(value => Math.max(.2, value - .2))}>−</button><button onClick={() => { setOffset({ x: 0, y: 0 }); setZoom(1) }}>Reset map</button><small>Solid · architecture / records &nbsp; Dashed · runtime activity</small></div>
        <svg viewBox="0 0 960 640" role="img" aria-label="Relationship graph" onWheel={event => setZoom(value => Math.max(.2, Math.min(3, value + (event.deltaY < 0 ? .1 : -.1))))} onPointerDown={event => { if (event.target === event.currentTarget) { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ id: null, x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y }) } }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}>
          <g transform={`translate(${offset.x} ${offset.y}) translate(480 320) scale(${zoom}) translate(-480 -320)`}>
            {edges.map(edge => <line key={edge.id} x1={coordinates[edge.from]!.x} y1={coordinates[edge.from]!.y} x2={coordinates[edge.to]!.x} y2={coordinates[edge.to]!.y} data-kind={edge.kind}><title>{edge.label}</title></line>)}
            {nodes.map(node => <g key={node.id} role="button" aria-label={node.name} tabIndex={0} data-selected={selected === node.id} data-status={node.status} transform={`translate(${coordinates[node.id]!.x} ${coordinates[node.id]!.y})`} onClick={() => select(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') select(node.id) }} onPointerDown={event => { event.stopPropagation(); select(node.id); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); setDrag({ id: node.id, x: event.clientX, y: event.clientY, startX: coordinates[node.id]!.x, startY: coordinates[node.id]!.y }) }}><circle r={selected === node.id ? 11 : 7} /><text x="13" y="4">{node.name.length > 35 ? node.name.slice(0, 32) + '…' : node.name}</text><title>{node.name} · {node.status}</title></g>)}
          </g>
        </svg></> : mode === 'table' ? <div className="fx-table-scroll"><table><thead><tr>{(['name', 'type', 'purpose', 'status', 'process', 'version', 'source'] as const).map(field => <th key={field} aria-sort={sort === field ? descending ? 'descending' : 'ascending' : 'none'}><button onClick={() => { if (sort === field) reverse(!descending); else { setSort(field); reverse(false) } }}>{field}</button></th>)}</tr></thead><tbody>{nodes.map(node => <tr key={node.id} aria-selected={selected === node.id} onClick={() => select(node.id)}><td><button onClick={() => select(node.id)}>{node.name}</button></td><td>{node.type}</td><td>{node.purpose}</td><td>{node.status}</td><td>{node.process}</td><td>{node.version ?? '—'}</td><td>{node.source}</td></tr>)}</tbody></table></div> : <div className="fx-description">{detail ? <><h2>{detail.name}</h2><p>{detail.purpose}</p></> : <p>Select a graph node or table row to read its description.</p>}</div>}
    </section><aside className="fx-inspector" aria-label="Record inspector">{detail ? <><small>{detail.type}</small><h2>{detail.name}</h2><p>{detail.purpose}</p><dl><dt>Status</dt><dd>{detail.status}</dd><dt>Process</dt><dd>{detail.process}</dd><dt>Source</dt><dd>{detail.source}</dd><dt>Last update</dt><dd>{detail.updatedAt ?? 'Not reported'}</dd><dt>Version</dt><dd>{detail.version ?? 'Not reported'}</dd></dl><button onClick={() => { focus(detail.id); setSearch(''); filter('all'); setMode('graph') }}>Focus and expand neighbours</button><h3>Connected systems</h3>{snapshot.edges.filter(edge => edge.from === detail.id || edge.to === detail.id).map(edge => { const other = snapshot.nodes.find(node => node.id === (edge.from === detail.id ? edge.to : edge.from)); return <button className="fx-link" key={edge.id} onClick={() => select(other?.id ?? null)}>{edge.label} · {other?.name}</button> })}{detail.actions.length ? detail.actions.map(action => <button key={action} onClick={() => onAction?.(detail, action)}>{action === 'source' ? 'Open development source' : `Manage ${detail.type}`}</button>) : <p>Read-only system fact or history. No direct rewrite is supported.</p>}{detail.detail && <pre>{JSON.stringify(detail.detail, null, 2)}</pre>}</> : <><h2>Inspector</h2><p>Select a node to inspect its evidence, source and connected systems.</p></>}</aside></div>
    {snapshot.limitations.map(line => <p className="fx-provenance" key={line}>{line}</p>)}
  </div>
}
