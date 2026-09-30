/**
 * A single live provider call, for a human who has asked for one.
 *
 * This is a developer tool, not part of Freya. It exists because "is my
 * credential right, is my endpoint right, will it answer at all" is a miserable
 * question to answer through the UI and a trivial one to answer here.
 *
 * ## What makes it safe to run
 *
 * It refuses unless **both** are present:
 *
 *   - `NANOGPT_API_KEY`, `NANOGPT_BASE_URL` and `NANOGPT_MODEL` — the credential;
 *   - `FREYA_ALLOW_LIVE_MODEL=1` — the decision to spend.
 *
 * The first without the second is a normal state: a configured but disabled
 * provider, exactly as in the app. Only someone who has typed the second gets a
 * call.
 *
 * ## What it does when it runs
 *
 * One request, a small output ceiling, and it exits. It goes through the same
 * Governor and the same Gateway that Freya uses, so a probe that succeeds is
 * evidence the real path works, rather than evidence that a side channel works.
 *
 * It never prints the key. It writes its event log to a temporary directory that
 * is deleted afterwards, so probing does not leave a journal behind.
 *
 * It is not part of `verify`, `test`, application boot, or CI.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../core/index'
import { readNanoGptConfig, type NanoGptEnv } from '../core/model/nanogpt-provider'
import { ownerAuthority } from '../core/testing'

/** A probe should be a probe: the smallest request that proves the path. */
const PROBE_MAX_OUTPUT_TOKENS = 16
const PROBE_PROMPT = 'Reply with the single word: ok'

async function main(): Promise<number> {
  const env: NanoGptEnv = {
    NANOGPT_API_KEY: process.env['NANOGPT_API_KEY'],
    NANOGPT_BASE_URL: process.env['NANOGPT_BASE_URL'],
    NANOGPT_MODEL: process.env['NANOGPT_MODEL'],
    FREYA_ALLOW_LIVE_MODEL: process.env['FREYA_ALLOW_LIVE_MODEL'],
  }

  const config = readNanoGptConfig(env)
  if (!config) {
    console.error('refusing to probe: the provider is not configured.')
    console.error('  set NANOGPT_API_KEY, NANOGPT_BASE_URL and NANOGPT_MODEL')
    return 2
  }
  if (env.FREYA_ALLOW_LIVE_MODEL !== '1') {
    // The credential is present and the decision is not. Say which is which,
    // without printing anything sensitive.
    console.error('refusing to probe: FREYA_ALLOW_LIVE_MODEL is not set to 1.')
    console.error('  the credential is present, so this is the decision, not the config.')
    console.error(`  configured model: ${config.model}`)
    return 2
  }

  console.log(`probing ${config.baseUrl} with model ${config.model}`)
  console.log(`at most one request, capped at ${PROBE_MAX_OUTPUT_TOKENS} output tokens`)

  const dir = await mkdtemp(join(tmpdir(), 'freya-probe-'))
  let exitCode = 1
  try {
    // The same Core, Governor and Gateway Freya uses, on a throwaway log.
    // `ownerAuthority` is the test seam, which is the right tool here: this is
    // a CLI, not a subsystem, and it must not widen the production surface.
    const core = createCore({ dataPath: join(dir, 'probe-events.jsonl'), env })
    await core.start()

    const outcome = await ownerAuthority(core).request({
      kind: 'user_turn',
      prompt: PROBE_PROMPT,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    })

    // Metadata, plus the reply — seeing the reply is the point. None of these
    // fields is the key.
    if (outcome.status === 'allowed') {
      console.log('')
      console.log(`  provider:  ${outcome.providerId}`)
      console.log(`  model:     ${outcome.model}`)
      console.log(`  reply:     ${outcome.text.slice(0, 200)}`)
      console.log('')
      console.log(`  session calls: ${core.status().sessionUsage.calls}`)
      console.log(`  durable calls: ${core.status().durableUsage.calls}`)
      exitCode = 0
    } else if (outcome.status === 'denied') {
      console.error(`the Governor refused this request: ${outcome.reason}`)
    } else {
      console.error(`the provider did not answer: ${outcome.reason}`)
    }
    await core.stop('probe complete')
  } catch (error: unknown) {
    console.error(`probe failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  } finally {
    // The probe's journal goes with it.
    await rm(dir, { recursive: true, force: true })
  }
  return exitCode
}

process.exitCode = await main()
