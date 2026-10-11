// Measures what a turn's output budget actually buys from the live provider.
//
// The symptom this explains: a turn does its lookups, gets evidence, and then
// the answer is reported as cut off. This asks the endpoint directly whether a
// small `max_tokens` leaves anything for the answer once reasoning is counted —
// which is the difference between "the model writes long" and "the model spends
// its budget thinking".
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter(l => /^[A-Z0-9_]+=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const BASE = (env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/+$/, '')
const MODEL = env.MINIMAX_MODEL
const KEY = env.MINIMAX_API_KEY

const QUESTION = 'What is the latest stable version of Node.js right now? Tell me, with sources.'

async function probe(label, maxTokens, extra = {}) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: QUESTION }],
      ...extra,
    }),
  })
  const ms = Date.now() - t0
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    console.log(`${label.padEnd(26)} HTTP ${res.status}  ${JSON.stringify(json).slice(0, 180)}`)
    return
  }
  const choice = json.choices?.[0] ?? {}
  const usage = json.usage ?? {}
  const content = choice.message?.content ?? ''
  const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? ''
  console.log(
    `${label.padEnd(26)} finish=${String(choice.finish_reason).padEnd(10)} ` +
    `out=${String(usage.completion_tokens).padStart(5)}  ` +
    `reasoning=${String(reasoning ? reasoning.length + ' chars' : '-').padStart(14)}  ` +
    `visible=${String(content.length + ' chars').padStart(6)}  ${ms}ms`,
  )
}

console.log(`# ${MODEL} @ ${BASE}\n`)
console.log(`# question: ${QUESTION}\n`)
console.log('max_tokens   finish     output   reasoning            visible          time')
console.log('-'.repeat(88))
await probe('512  (a continuation)', 512)
await probe('1024', 1024)
await probe('2048', 2048)
await probe('3072 (first call today)', 3072)
await probe('6144', 6144)