import { ResearchError } from './errors'

/** Bounds even dependencies that ignore cancellation, and discards late completions. */
export function withResearchAbort<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new ResearchError('cancelled'))
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error !== null) {
        // Abort the request/stream as well as ending the public wait.
        controller.abort(error)
        reject(error)
      } else resolve(value as T)
    }
    const cancel = (): void => finish(new ResearchError('cancelled'))
    const timer = setTimeout(() => finish(new ResearchError('timeout')), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ResearchError('cancelled')
      return operation(controller.signal)
    }).then((value) => finish(null, value), (error: unknown) => finish(error))
  })
}
