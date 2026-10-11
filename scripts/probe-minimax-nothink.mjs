// Finds a request shape that makes the provider answer inside a small budget.
//
// The budget probe showed MiniMax-M3.1-Flash-Preview consuming 100% of
// max_tokens on reasoning and emitting nothing visible, at every budget tried.
// So the question this answers is not "how big should the budget be" but
// "how do we ask for an answer rather than a think". Each variant is tried at a
// deliberately small budget: if a shape works, it produces visible text at 512.
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const BASE = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/+$/, '')
const MODEL = env.MINIMAX_MODEL
const KEY = env.MINIMAX_API_KEY
const Q = 'What is the latest stable version of Node.js right now? Tell me, with sources.'

async function tryShape(label, extra) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: 'user', content: Q }], ...extra }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) { console.log(`${label.padEnd(34)} HTTP ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 90)}`); return }
    const c = json.choices?.[0] ?? {}
    const msg = c.message ?? {}
    const reasoning = msg.reasoning_content ?? msg.reasoning ?? ''
    const visible = (msg.content ?? '').replace(/\s+/g, ' ').slice(0, 60)
    const ok = String(c.finish_reason) !== 'length'
    console.log(`${ok ? 'WORKS ' : 'no    '} ${label.padEnd(30)} finish=${String(c.finish_reason).padEnd(9)} reasoning=${reasoning ? reasoning.length : 0}c  visible="${visible}"`)
  } catch (e) { console.log(`${label.padEnd(34)} ERROR ${e.message}`) }
}

console.log(`# ${MODEL} @ ${BASE}\n`)
await tryShape('(baseline, no extra)', {})
await tryShape('thinking:{type:disabled}', { thinking: { type: 'disabled' } })
await tryShape('thinking:{type:disabled} alt', { thinking: { type: 'Disabled' } })
await tryShape('reasoning_effort:"none"', { reasoning_effort: 'none' })
await tryShape('reasoning_effort:"minimal"', { reasoning_effort: 'minimal' })
await tryShape('reasoning_split:true', { reasoning_split: true })
await tryShape('enable_thinking:false', { enable_thinking: false })
await tryShape('thinking:false', { thinking: false })
await tryShape('extra_body style', { chat_template_kwargs: { enable_thinking: false } })