import {
  DEVICE_HANDS_LIMITS,
  isDeviceHandsActionKey,
  isDeviceHandsSurface,
  type DeviceHandsActionKey,
  type DeviceHandsApprovalRecord,
  type DeviceHandsEventType,
  type DeviceHandsGrantRecord,
  type DeviceHandsPayload,
  type DeviceHandsProbeOutcome,
  type DeviceHandsRefusalCode,
  type DeviceHandsSurface,
  type DeviceHandsVerdict,
  type DeviceHandsVerificationRecord,
} from './types'
import { normaliseSurfacePolicy, policyMatchesDigest, type SurfacePolicy } from './paths'
import { checkClipboardText } from './clipboard'
import {
  authoriseDeviceAction,
  authoriseDeviceProbe,
  buildSubject,
  type DeviceHandsActionRequest,
  type PreparedAction,
} from './gates'
import { approvalDecisionIsOwners, mayRequestApproval } from './approvals'
import {
  consumedActionIds,
  initialDeviceHandsState,
  reduceDeviceHandsEntry,
  unresolvedActions,
  type DeviceHandsState,
} from './state'
import { mayOpenJournal, recoveryReport, type RecoveryReport } from './recovery'
import { projectDeviceHandsState, type DeviceHandsProjection } from './projection'
import { mayBeConsideredComplete, verifyDeviceAction, type DeviceOutcome } from './verification'
import { probeSummary } from './probe'
import { canonicalDigest } from './digest'
import type { DeviceHandsPorts, GrantFact } from './ports'

/**
 * The runtime: the only file in this phase that touches a port.
 *
 * It holds no authority of its own. Every route to the outside world goes through
 * {@link DeviceHandsPorts}, which Core fills with machinery that already existed — the
 * Guard, the Governor, the host adapters — and which this phase cannot reach around.
 * What the runtime adds is the ordering, and the ordering is the whole safety argument:
 *
 * ```
 *   all ten gates  →  STOP ALL read again  →  journal the start  →  one port  →  verify  →  journal the verdict
 * ```
 *
 * No port is reached before every gate has held. No effect is called complete before a
 * verifier has passed it. No refusal is silent.
 *
 * It schedules nothing. There is no `setTimeout`, no interval and no self-wake in this
 * file, and `./assertions` scans the source to keep it that way — a phase that can run
 * a terminal and drive a browser and cannot set a timer is a phase that only acts when
 * somebody asks it to.
 */

/* ----------------------------------------------------------------- outcomes */

export interface DeviceHandsOutcome {
  /** Whether an effect port was reached at all. False on every refusal. */
  readonly performed: boolean
  readonly actionId: string
  readonly actionKey: DeviceHandsActionKey
  /** The gate that refused, or null. */
  readonly refusedAt: string | null
  readonly code: DeviceHandsRefusalCode | null
  readonly reason: string
  readonly verdict: DeviceHandsVerdict | null
  /** Every gate actually consulted, in order. */
  readonly evaluated: readonly string[]
  readonly verification: DeviceHandsVerificationRecord | null
  /** Bytes this action moved. Zero when it moved none, or when it never ran. */
  readonly bytes: number
}

export interface DeviceHandsRuntimeOptions {
  readonly ports: DeviceHandsPorts
  /** Development profile: remove grants/approvals/allowlists, while keeping no-delete. */
  readonly localUnrestricted?: boolean
  /** Whether an untrustworthy journal refuses to open. Default true. */
  readonly requireTrustworthyJournal?: boolean
}

export interface RefusalRecordView {
  readonly actionId: string
  readonly actionKey: string
  readonly gate: string
  readonly code: string
  readonly reason: string
}

export interface DeviceHandsRuntime {
  /** Replay the journal, reconcile, and build the derived state. Idempotent. */
  open(): Promise<void>
  /** The folded state. */
  snapshot(): DeviceHandsState
  /** The explainable projection, for the owner. */
  projection(): DeviceHandsProjection
  /** What a restart can honestly claim. */
  recovery(): RecoveryReport
  /** Load and journal the surface policy. Refuses a policy it cannot enforce. */
  loadPolicy(
    policy: unknown,
  ): Promise<{ readonly ok: boolean; readonly code: DeviceHandsRefusalCode | null; readonly reason: string }>
  /** Record a grant Core minted. Bounded, narrowed, and journaled. */
  registerGrant(
    grant: unknown,
  ): Promise<{ readonly ok: boolean; readonly code: DeviceHandsRefusalCode | null; readonly reason: string }>
  /** Revoke a grant. */
  revokeGrant(grantId: string): Promise<{ readonly ok: boolean; readonly reason: string }>
  /** Ask the owner about one exact action body. */
  requestApproval(
    input: unknown,
  ): Promise<{ readonly ok: boolean; readonly approvalId: string | null; readonly reason: string }>
  /** Probe a surface for availability. Grants nothing, and cannot. */
  probe(
    surface: string,
  ): Promise<{ readonly ok: boolean; readonly outcome: DeviceHandsProbeOutcome | null; readonly reason: string }>
  /** Attempt one action. Authorization first, effect second, verification third. */
  perform(request: DeviceHandsActionRequest): Promise<DeviceHandsOutcome>
  /**
   * Cancel a running action.
   *
   * Honoured **at settle**, not preempted. This phase does not own the process it
   * started and has no way to interrupt it, so a cancellation here means "whatever comes
   * back is recorded as cancelled, not as done". Claiming to interrupt the port would be
   * a lie, and a lie about cancellation is the worst one available: a person who
   * pressed stop and was told it stopped.
   */
  cancel(actionId: string): { readonly accepted: boolean; readonly reason: string }
  /** Approvals the journal holds. A read, so a test can see what a gate saw. */
  approvals(): readonly DeviceHandsApprovalRecord[]
  /** Refusals the journal holds, newest last. */
  refusals(): readonly RefusalRecordView[]
}

export function createDeviceHandsRuntime(options: DeviceHandsRuntimeOptions): DeviceHandsRuntime {
  const { ports } = options
  const requireTrustworthy = options.requireTrustworthyJournal !== false
  const localUnrestricted = options.localUnrestricted === true

  let state: DeviceHandsState = initialDeviceHandsState()
  let policy: SurfacePolicy | null = null
  let opened = false
  const cancelled = new Set<string>()

  /* ------------------------------------------------------------------ journal */

  async function append(type: DeviceHandsEventType, payload: DeviceHandsPayload): Promise<void> {
    // Durable before it resolves. Every derived fact here comes from these entries and
    // nothing else, so a refused append must fail loudly — there is no in-memory state
    // to fall back on that would not be lost on the next restart.
    await ports.append(type, payload)
    state = reduceDeviceHandsEntry(state, { type, recordedAt: ports.now(), payload }).state
  }

  function text(value: string): string {
    return value.slice(0, DEVICE_HANDS_LIMITS.maxPayloadTextLength)
  }

  function verificationRecord(
    actionId: string,
    verdict: DeviceHandsVerdict,
    reason: string,
  ): DeviceHandsVerificationRecord {
    return Object.freeze({
      verificationId: ports.newId(),
      actionId,
      verdict,
      reason: text(reason),
      verifiedAt: ports.now(),
    })
  }

  async function recordRefusal(
    request: DeviceHandsActionRequest,
    gate: string,
    code: DeviceHandsRefusalCode,
    reason: string,
  ): Promise<DeviceHandsOutcome> {
    await append('hands.action.refused', {
      actionId: request.actionId,
      actionKey: request.actionKey,
      gate,
      code,
      reason: text(reason),
      at: request.at,
    })
    ports.onChange()
    return {
      performed: false,
      actionId: request.actionId,
      actionKey: request.actionKey,
      refusedAt: gate,
      code,
      reason,
      verdict: null,
      evaluated: [],
      verification: null,
      bytes: 0,
    }
  }

  /* -------------------------------------------------------------------- open */

  async function open(): Promise<void> {
    if (opened) return
    const entries = await ports.replay()
    // Fold first, then decide whether the record can be acted on. Reversing those two
    // steps would mean refusing on a count we had not yet counted.
    let folded = initialDeviceHandsState()
    for (const entry of entries) {
      folded = reduceDeviceHandsEntry(folded, entry).state
    }
    const gate = mayOpenJournal({
      trustworthy: ports.journalTrustworthy(),
      actionCount: Object.keys(folded.actions).length,
    })
    if (requireTrustworthy && !gate.ok) {
      throw new Error(`${gate.code}: ${gate.reason}`)
    }
    state = folded
    opened = true

    // Restart truthfulness, made durable: every action the journal cannot account for
    // is reconciled as interrupted, so the next process inherits a fact rather than a
    // guess.
    const pending = unresolvedActions(state)
    for (const action of pending) {
      await append('hands.reconciled', {
        actionId: action.actionId,
        from: 'running',
        to: 'interrupted',
        code: 'process-ended-before-settle',
        at: ports.now(),
      })
    }

    await append('hands.runtime.opened', {
      at: ports.now(),
      recoveredActions: pending.length,
    })
    ports.onChange()
  }

  /* ------------------------------------------------------------------ policy */

  async function loadPolicy(candidate: unknown): Promise<{
    ok: boolean
    code: DeviceHandsRefusalCode | null
    reason: string
  }> {
    if (!opened) await open()
    const reading = normaliseSurfacePolicy(candidate)
    if (!reading.ok) {
      await append('hands.probe.refused', {
        surface: 'browser',
        code: reading.code,
        reason: text(reading.reason),
        at: ports.now(),
      })
      ports.onChange()
      return { ok: false, code: reading.code, reason: reading.reason }
    }
    const narrowed = reading.policy
    const alreadyOnRecord = state.policyDigest
    if (alreadyOnRecord !== null && !policyMatchesDigest(narrowed, alreadyOnRecord)) {
      // Refused rather than applied. A journal that recorded one policy and is now
      // handed another means the rules changed underneath the actions already on the
      // record, and this phase is the thing that has to notice.
      const reason =
        'This journal already records a surface policy, and the policy offered now is a different one. A policy may be set once; it cannot be swapped underneath the record.'
      await append('hands.probe.refused', {
        surface: 'browser',
        code: 'policy-mismatch',
        reason: text(reason),
        at: ports.now(),
      })
      ports.onChange()
      return { ok: false, code: 'policy-mismatch', reason }
    }
    policy = narrowed
    await append('hands.policy.set', {
      policyDigest: narrowed.digest,
      rootCount: narrowed.allowedRoots.length,
      hostCount: narrowed.allowedHosts.length,
      commandCount: narrowed.allowedCommands.length,
      envCount: narrowed.allowedEnvNames.length,
      at: ports.now(),
    })
    ports.onChange()
    return {
      ok: true,
      code: null,
      reason: `A policy with ${String(narrowed.allowedRoots.length)} root(s), ${String(narrowed.allowedHosts.length)} host(s) and ${String(narrowed.allowedCommands.length)} command(s) is in force, and its digest is on the record.`,
    }
  }

  /* ------------------------------------------------------------------ grants */

  async function registerGrant(candidate: unknown): Promise<{
    ok: boolean
    code: DeviceHandsRefusalCode | null
    reason: string
  }> {
    if (!opened) await open()
    const reading = readGrant(candidate)
    if (!reading.ok) return { ok: false, code: reading.code, reason: reading.reason }
    if (policy === null) {
      return {
        ok: false,
        code: 'policy-missing',
        reason: 'No surface policy is loaded, so there is nothing for a grant to narrow.',
      }
    }
    const ttl = Date.parse(reading.grant.expiresAt) - Date.parse(reading.grant.issuedAt)
    if (!Number.isFinite(ttl) || ttl <= 0) {
      return { ok: false, code: 'grant-expired', reason: 'A grant must expire after it was issued.' }
    }
    if (ttl > DEVICE_HANDS_LIMITS.maxGrantTtlMs) {
      // Refused, not clamped. A grant clamped to fifteen minutes still *reads* like a
      // longer one to anybody who does not check; a refused grant is unambiguous.
      return {
        ok: false,
        code: 'grant-expired',
        reason: `A grant may live for at most ${String(DEVICE_HANDS_LIMITS.maxGrantTtlMs / 60_000)} minutes. This one asked for ${String(Math.round(ttl / 1000))} seconds and was refused rather than shortened.`,
      }
    }
    await append('hands.grant.registered', {
      grantId: reading.grant.grantId,
      principalId: reading.grant.principalId,
      scope: reading.grant.scope,
      surfaces: reading.grant.surfaces.join(','),
      actions: reading.grant.actions.join(','),
      issuedAt: reading.grant.issuedAt,
      expiresAt: reading.grant.expiresAt,
    })
    ports.onChange()
    return {
      ok: true,
      code: null,
      reason: `The grant covers ${String(reading.grant.actions.length)} action(s) and expires at ${reading.grant.expiresAt}.`,
    }
  }

  async function revokeGrant(grantId: string): Promise<{ ok: boolean; reason: string }> {
    if (!opened) await open()
    const current = state.grants[grantId]
    if (current === undefined) return { ok: false, reason: 'There is no such grant on the record.' }
    if (current.revokedAt !== null) return { ok: false, reason: 'That grant was already revoked.' }
    await append('hands.grant.revoked', {
      grantId,
      principalId: current.principalId,
      at: ports.now(),
    })
    ports.onChange()
    return { ok: true, reason: 'The grant is revoked. It cannot be revived.' }
  }

  /* ---------------------------------------------------------------- approval */

  async function requestApproval(input: unknown): Promise<{
    ok: boolean
    approvalId: string | null
    reason: string
  }> {
    if (!opened) await open()
    const raw =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const actionKey = raw.actionKey
    if (!isDeviceHandsActionKey(actionKey)) {
      return { ok: false, approvalId: null, reason: 'An approval request must name a routable action.' }
    }
    const approvalId =
      typeof raw.approvalId === 'string' && raw.approvalId.length > 0 ? raw.approvalId : ports.newId()
    const actionId =
      typeof raw.actionId === 'string' && raw.actionId.length > 0 ? raw.actionId : approvalId
    const subjectRef =
      typeof raw.subjectRef === 'string' && raw.subjectRef.length > 0 ? raw.subjectRef : actionId

    // The subject is derived from the action the caller describes, and the *gate*
    // recomputes it from the normalised action at perform time. If the two disagree the
    // approval will not match, which is the point: a caller cannot be approved for one
    // body and then run another.
    const subject = buildSubject(actionKey, readPrepared(raw.prepared), actionId)

    const room = mayRequestApproval(Object.values(state.approvals))
    if (!room.ok) return { ok: false, approvalId: null, reason: room.reason }

    const now = ports.now()
    const expiresAt = readApprovalTtl(raw.expiresAt, now)
    if (expiresAt === null) {
      return {
        ok: false,
        approvalId: null,
        reason: `An approval request needs an absolute expiry within ${String(DEVICE_HANDS_LIMITS.maxApprovalTtlMs / 60_000)} minutes. A relative or missing expiry is refused.`,
      }
    }

    await append('hands.approval.requested', {
      approvalId,
      actionKey,
      subjectRef: text(subjectRef),
      digest: subject.digest,
      expiresAt,
      at: now,
    })

    const answer = await ports.requestOwnerApproval({
      approvalId,
      actionKey,
      subjectRef,
      digest: subject.digest,
      expiresAt,
    })

    // The one question that decides whether this is safe to have: was that actually the
    // owner? If it was not, the request stays a denial. A decision from `core` is not a
    // softer yes; it is a no.
    const denied = async (reason: string): Promise<{ ok: boolean; approvalId: string | null; reason: string }> => {
      await append('hands.approval.denied', { approvalId, actionKey, decidedAt: answer.decidedAt })
      ports.onChange()
      return { ok: false, approvalId: null, reason }
    }
    if (!approvalDecisionIsOwners(answer.decidedBy)) {
      return denied('That decision did not come from the owner, so it is recorded as a denial.')
    }
    if (answer.approvalId !== approvalId) {
      return denied('The decision refers to a different approval than the one that was requested.')
    }
    if (!answer.granted) return denied('The owner declined.')
    if (!ports.approvalStillValid(approvalId)) {
      return denied('The owner granted it and then it was no longer valid.')
    }

    await append('hands.approval.granted', {
      approvalId,
      actionKey,
      subjectRef: text(subjectRef),
      digest: subject.digest,
      decidedAt: answer.decidedAt,
    })
    ports.onChange()
    return { ok: true, approvalId, reason: 'The owner granted this exact action body.' }
  }

  /* ------------------------------------------------------------------- probe */

  async function probe(
    candidate: string,
  ): Promise<{ ok: boolean; outcome: DeviceHandsProbeOutcome | null; reason: string }> {
    if (!opened) await open()
    const decision = authoriseDeviceProbe({
      enabled: ports.enabled(),
      journalTrustworthy: ports.journalTrustworthy(),
      stopped: ports.stopAllActive(),
      surface: typeof candidate === 'string' ? candidate : '',
    })
    const surface = typeof candidate === 'string' ? candidate : ''
    if (!decision.allowed) {
      await append('hands.probe.refused', {
        surface: isDeviceHandsSurface(surface) ? surface : 'browser',
        code: decision.code ?? 'probe-refused',
        reason: text(decision.reason),
        at: ports.now(),
      })
      ports.onChange()
      return { ok: false, outcome: null, reason: decision.reason }
    }

    const raw = await ports.probeSurface({ surface: surface as DeviceHandsSurface })
    const outcome: DeviceHandsProbeOutcome = Object.freeze({
      probeId: ports.newId(),
      surface: surface as DeviceHandsSurface,
      available: raw.available === true,
      code: text(raw.code),
      probedAt: ports.now(),
    })
    await append('hands.probe.performed', {
      probeId: outcome.probeId,
      surface: outcome.surface,
      available: outcome.available,
      code: outcome.code,
      at: outcome.probedAt,
    })
    ports.onChange()
    // The result is a measurement. Nothing above this line read it as a permission and
    // nothing below can: `DeviceHandsProbeOutcome` has no field capable of being one,
    // and no port method exists that could turn availability into authority.
    return { ok: true, outcome, reason: probeSummary(outcome) }
  }

  /* ----------------------------------------------------------------- perform */

  async function perform(request: DeviceHandsActionRequest): Promise<DeviceHandsOutcome> {
    if (!opened) await open()

    // The grant is read from Core *and* from the journal, and both must agree. A host
    // reporting a grant this phase has no record of is refused rather than believed —
    // otherwise the journal would be decorative, and a record nobody checks is a record
    // nobody can audit.
    const fact: GrantFact | null = ports.activeGrant(request.principalId, request.scope)
    const recorded = findRecordedGrant(state, fact)

    const decision = authoriseDeviceAction(
      {
        localUnrestricted,
        enabled: ports.enabled(),
        journalTrustworthy: ports.journalTrustworthy(),
        stopped: ports.stopAllActive(),
        policy,
        policyDigest: state.policyDigest,
        seenActionIds: consumedActionIds(state),
        grant: recorded,
        approvals: Object.values(state.approvals),
        actionCountThisSession: state.actionCountThisSession,
        transferCountThisSession: state.transferCountThisSession,
        bytesThisSession: state.bytesThisSession,
        inFlightActions: 0,
      },
      request,
    )

    if (!decision.allowed) {
      const code = decision.code ?? 'request-malformed'
      await recordRefusal(request, decision.refusedAt ?? 'unknown', code, decision.reason)
      return {
        performed: false,
        actionId: request.actionId,
        actionKey: request.actionKey,
        refusedAt: decision.refusedAt,
        code,
        reason: decision.reason,
        verdict: null,
        evaluated: decision.evaluated,
        verification: null,
        bytes: 0,
      }
    }

    const prepared = decision.prepared
    if (prepared === null) {
      // Unreachable while the gate sets `prepared` whenever it allows. Stated rather
      // than assumed: a gate that allowed an action with nothing prepared would be
      // approving an action nobody has described.
      return recordRefusal(
        request,
        'policy',
        'request-malformed',
        'The gates allowed an action with nothing prepared, which is a bug in this build rather than a decision.',
      )
    }

    // The latch is read again here, after the gates and immediately before the effect.
    // A check that happened "recently" is a check that can be wrong, and STOP ALL is the
    // one thing that must never be wrong.
    if (ports.stopAllActive()) {
      return recordRefusal(
        request,
        'stop-all',
        'stop-all-latched',
        'STOP ALL was latched after this action passed its gates, so it did not run.',
      )
    }

    const grantId = recorded?.grantId ?? ''
    await append('hands.action.started', {
      actionId: request.actionId,
      actionKey: request.actionKey,
      surface: prepared.kind,
      principalId: request.principalId,
      grantId,
      deadlineAt: request.deadlineAt,
      at: request.at,
    })
    await append('hands.budget.checked', {
      actionId: request.actionId,
      actionsThisSession: state.actionCountThisSession,
      maxActions: DEVICE_HANDS_LIMITS.maxActionsPerSession,
      bytesThisSession: state.bytesThisSession,
      maxBytes: DEVICE_HANDS_LIMITS.maxTransferBytesPerSession,
    })

    const outcome = await execute(request, prepared, decision.evaluated)
    ports.onChange()
    return outcome
  }

  /* ----------------------------------------------------------------- effects */

  /**
   * Reach exactly one surface port, journal what it reported, and settle.
   *
   * One `switch`, one `await` per branch, and every branch ends in `settle`. There is no
   * path that reaches a port and then returns without the record saying what happened.
   */
  async function execute(
    request: DeviceHandsActionRequest,
    prepared: PreparedAction,
    evaluated: readonly string[],
  ): Promise<DeviceHandsOutcome> {
    const actionId = request.actionId

    switch (prepared.kind) {
      case 'browser': {
        const result = await ports.performBrowser({
          actionId,
          url: prepared.url,
          selector: prepared.selector,
          text: prepared.text,
          deadlineAt: request.deadlineAt,
        })
        await append('hands.browser.performed', {
          actionId,
          actionKey: request.actionKey,
          url: text(prepared.url),
          holds: result.holds,
          code: text(result.code),
          textBytes: result.textBytes,
          at: request.at,
        })
        return settle(request, evaluated, {
          holds: result.holds,
          evidence: result.evidence,
          code: result.code,
        })
      }

      case 'terminal': {
        const result = await ports.runTerminal({ command: prepared.command })
        await append('hands.terminal.performed', {
          actionId,
          command: prepared.command.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          at: request.at,
        })
        return settle(request, evaluated, {
          holds: result.holds,
          evidence: result.evidence,
          code: result.code,
        })
      }

      case 'clipboard': {
        if (prepared.key === 'clipboard.read') {
          const raw = await ports.readClipboard({ actionId })
          // The boundary. Content arrives here, is judged, and either comes back as
          // bounded text or does not come back at all. Nothing above this line has seen
          // it, and the only thing journaled is a byte count.
          const judged = checkClipboardText(raw.text, 'in')
          if (!judged.ok) {
            const bytes = typeof raw.text === 'string' ? new TextEncoder().encode(raw.text).length : 0
            await append('hands.clipboard.credential-detected', {
              actionId,
              direction: 'in',
              bytes,
              at: request.at,
            })
            return {
              performed: true,
              actionId,
              actionKey: request.actionKey,
              refusedAt: 'policy',
              code: judged.code,
              reason: judged.reason,
              verdict: null,
              evaluated,
              verification: null,
              bytes: 0,
            }
          }
          await append('hands.clipboard.read', { actionId, bytes: judged.bytes, at: request.at })
          // A clipboard read that got bounded text back *has* observed the clipboard —
          // the content was read and judged here, which is a read-back rather than a
          // claim. Nothing is written to the journal beyond the byte count.
          return settle(request, evaluated, { holds: true, evidence: 'observed', code: 'read' })
        }
        if (prepared.key === 'clipboard.clear') {
          const result = await ports.clearClipboard({ actionId })
          await append('hands.clipboard.cleared', { actionId, at: request.at })
          return settle(request, evaluated, {
            holds: result.holds,
            evidence: result.evidence,
            code: result.code,
          })
        }
        const written = await ports.writeClipboard({ actionId, text: prepared.text ?? '' })
        const bytes = new TextEncoder().encode(prepared.text ?? '').length
        await append('hands.clipboard.written', { actionId, bytes, at: request.at })
        return settle(request, evaluated, {
          holds: written.holds,
          evidence: written.evidence,
          code: written.code,
        })
      }

      case 'transfer': {
        const target = prepared.target
        const result =
          target.direction === 'download'
            ? await ports.fetchDownload({ actionId, url: target.url, target })
            : await ports.sendUpload({ actionId, url: target.url, target })

        if (!result.holds) {
          await append('hands.transfer.failed', {
            actionId,
            direction: target.direction,
            code: text(result.code),
            reason: text(`the surface reported that it did not move the bytes (${result.code})`),
            at: request.at,
          })
        }
        // Only a transfer that both moved *and* was observed at the destination moves
        // the session's byte ledger. A reported success does not, because the ledger is
        // a budget number and a number that moves on a claim can be inflated by one.
        return settle(
          request,
          evaluated,
          { holds: result.holds, evidence: result.evidence, code: result.code },
          result.holds && result.evidence === 'observed' ? result.bytes : 0,
          async (verification, verdict) => {
            if (verdict !== 'passed') return
            await append('hands.transfer.completed', {
              actionId,
              direction: target.direction,
              mediaType: target.mediaType,
              bytes: result.bytes,
              destinationRef: text(target.fileName),
              verificationId: verification.verificationId,
              at: request.at,
            })
          },
        )
      }
    }
  }

  /**
   * Judge the outcome, journal the verdict, and return.
   *
   * `onSettled` exists so a transfer can write its `transfer.completed` entry *with*
   * the verification id that justifies it, rather than before it. That ordering is the
   * difference between a journal that can be audited and one that has to be believed.
   */
  async function settle(
    request: DeviceHandsActionRequest,
    evaluated: readonly string[],
    outcome: DeviceOutcome | null,
    bytes = 0,
    onSettled?: (
      verification: DeviceHandsVerificationRecord,
      verdict: DeviceHandsVerdict,
    ) => Promise<void>,
  ): Promise<DeviceHandsOutcome> {
    const actionId = request.actionId

    if (cancelled.has(actionId)) {
      // Settled by cancellation rather than by verification: we are not claiming the
      // action did the thing, so there is nothing to verify. A verification entry here
      // would be theatre.
      await append('hands.action.cancelled', {
        actionId,
        actionKey: request.actionKey,
        reason: 'cancelled before the surface settled',
        at: request.at,
      })
      cancelled.delete(actionId)
      return {
        performed: true,
        actionId,
        actionKey: request.actionKey,
        refusedAt: null,
        code: 'action-cancelled',
        reason:
          'This action was cancelled. Whatever the surface did with it is recorded as not done, and a retry is a new action id with a new approval.',
        verdict: null,
        evaluated,
        verification: null,
        bytes: 0,
      }
    }

    const decision = verifyDeviceAction({
      actionId,
      actionKey: request.actionKey,
      at: ports.now(),
      deadlineAt: request.deadlineAt,
      stopped: ports.stopAllActive(),
      cancelled: false,
      attempted: outcome !== null,
      outcome,
    })
    const verification = verificationRecord(actionId, decision.verdict, decision.reason)
    const complete = mayBeConsideredComplete(verification)

    if (decision.verdict === 'failed' && decision.code === 'action-timed-out') {
      await append('hands.action.timed-out', { actionId, actionKey: request.actionKey, at: request.at })
    }
    // The verdict is written **before** the entry it authorises. A log that records a
    // transfer completing and only then says whether it was verified reads backwards;
    // this order means a reader going forward meets the evidence first, and the journal
    // audit in `./assertions` can hold the ledger to it without looking ahead.
    await append('hands.verified', {
      verificationId: verification.verificationId,
      actionId,
      result: decision.verdict,
      reason: text(decision.reason),
      at: request.at,
    })
    if (onSettled !== undefined) {
      await onSettled(verification, decision.verdict)
    }

    return {
      performed: true,
      actionId,
      actionKey: request.actionKey,
      refusedAt: null,
      code: complete.complete ? null : (decision.code ?? 'verification-failed'),
      reason: decision.reason,
      verdict: decision.verdict,
      evaluated,
      verification,
      bytes: complete.complete ? bytes : 0,
    }
  }

  /* ------------------------------------------------------------------- reads */

  return {
    open,
    snapshot: () => state,
    projection: () => projectDeviceHandsState({ state, at: ports.now() }),
    recovery: () => recoveryReport(state),
    loadPolicy,
    registerGrant,
    revokeGrant,
    requestApproval,
    probe,
    perform,
    cancel(actionId: string) {
      if (!opened) {
        return { accepted: false, reason: 'This runtime has not opened, so nothing is running.' }
      }
      const action = state.actions[actionId]
      if (action === undefined) {
        return { accepted: false, reason: 'There is no such action on the record.' }
      }
      if (action.state !== 'running') {
        return { accepted: false, reason: `That action is already ${action.outcome ?? 'settled'}.` }
      }
      cancelled.add(actionId)
      return {
        accepted: true,
        reason:
          'The cancellation is recorded. It takes effect when the surface settles: this phase does not own the process it started and will not pretend to interrupt it.',
      }
    },
    approvals: () => Object.values(state.approvals),
    refusals: () => state.refusals.map((entry) => ({ ...entry })),
  }
}

/* --------------------------------------------------------------- internals */

/**
 * The recorded grant that matches what Core reports.
 *
 * Both must agree on id, principal, scope, revocation, expiry, surfaces and actions. A
 * mismatch is `null`, which the gate refuses as `grant-missing` — the safe direction,
 * because the alternative is believing one of two records that disagree.
 */
function findRecordedGrant(
  state: DeviceHandsState,
  fact: GrantFact | null,
): DeviceHandsGrantRecord | null {
  if (fact === null) return null
  const recorded = state.grants[fact.grantId]
  if (recorded === undefined) return null
  if (recorded.principalId !== fact.principalId) return null
  if (recorded.scope !== fact.scope) return null
  if (recorded.revokedAt !== fact.revokedAt) return null
  if (recorded.expiresAt !== fact.expiresAt) return null
  if ([...recorded.surfaces].sort().join(',') !== [...fact.surfaces].sort().join(',')) return null
  if ([...recorded.actions].sort().join(',') !== [...fact.actions].sort().join(',')) return null
  return recorded
}

type GrantReading =
  | { readonly ok: true; readonly grant: DeviceHandsGrantRecord }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

/**
 * Read and narrow a grant a host offers.
 *
 * There is no wildcard and no "everything on this surface": a grant is a list of action
 * keys, each checked against the routable vocabulary, and every one of them must name a
 * surface the grant itself listed. A grant that says `browser` and `terminal.run` is
 * refused rather than quietly unioned into "browser and terminal".
 */
function readGrant(candidate: unknown): GrantReading {
  const raw =
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : {}
  const readField = (key: string): string | null => {
    const value = raw[key]
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null
    return value
  }
  const grantId = readField('grantId')
  const principalId = readField('principalId')
  const scope = readField('scope')
  const issuedAt = readField('issuedAt')
  const expiresAt = readField('expiresAt')
  if (
    grantId === null ||
    principalId === null ||
    scope === null ||
    issuedAt === null ||
    expiresAt === null
  ) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: 'A grant needs an id, a principal, a scope, and an issue and an expiry instant.',
    }
  }
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0 || raw.surfaces.length > 4) {
    return { ok: false, code: 'grant-missing', reason: 'A grant must name between one and four surfaces.' }
  }
  const surfaces: DeviceHandsSurface[] = []
  for (const surface of raw.surfaces) {
    if (!isDeviceHandsSurface(surface)) {
      return {
        ok: false,
        code: 'grant-surface-mismatch',
        reason: `"${String(surface)}" is not a surface this build routes.`,
      }
    }
    surfaces.push(surface)
  }
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 16) {
    return {
      ok: false,
      code: 'grant-action-mismatch',
      reason: 'A grant must name between one and sixteen actions.',
    }
  }
  const actions: DeviceHandsActionKey[] = []
  for (const action of raw.actions) {
    if (!isDeviceHandsActionKey(action)) {
      return {
        ok: false,
        code: 'grant-action-mismatch',
        reason: `"${String(action)}" is not an action this build routes, so a grant cannot name it. There is no wildcard and no "everything on this surface".`,
      }
    }
    actions.push(action)
  }
  for (const action of actions) {
    if (!surfaces.includes(action.slice(0, action.indexOf('.')) as DeviceHandsSurface)) {
      return {
        ok: false,
        code: 'grant-surface-mismatch',
        reason: `"${action}" names a surface this grant does not cover.`,
      }
    }
  }
  return {
    ok: true,
    grant: Object.freeze({
      grantId,
      principalId,
      scope,
      surfaces: Object.freeze(surfaces),
      actions: Object.freeze(actions),
      issuedAt,
      expiresAt,
      revokedAt: readField('revokedAt'),
    }),
  }
}

/**
 * Read a normalised action back for an approval request.
 *
 * Treated as opaque on purpose. Only its digest is used, and the gate recomputes the
 * subject at perform time from the *policy-normalised* action — so an approval raised
 * for one body does not authorise a different one. A caller-supplied shape that does
 * not normalise to the same body simply produces a digest the gate will not match.
 */
function readPrepared(candidate: unknown): PreparedAction | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const raw = candidate as Record<string, unknown>
  const kind = raw.kind
  if (kind === 'browser' || kind === 'terminal' || kind === 'clipboard' || kind === 'transfer') {
    return raw as unknown as PreparedAction
  }
  return null
}

/** An approval expiry: absolute, in the future, and no further out than the ceiling. */
function readApprovalTtl(value: unknown, now: string): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  const nowMs = Date.parse(now)
  const expiryMs = Date.parse(value)
  if (!Number.isFinite(nowMs)) return null
  if (expiryMs <= nowMs) return null
  if (expiryMs - nowMs > DEVICE_HANDS_LIMITS.maxApprovalTtlMs) return null
  return new Date(expiryMs).toISOString()
}

/** The canonical digest, exposed so the approval path and the perform path agree. */
export function deviceHandsDigest(parts: readonly string[]): string {
  return canonicalDigest(parts)
}