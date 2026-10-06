# Phase 45 — Voice

**Status:** IMPLEMENTED — push-to-talk and speech output are live; hosted transcription is available behind an explicit paid-provider opt-in. Hands-free wake remains an honest gap.
**Branch:** `runtime/phase45-voice`
**Baseline:** `89d4fa7` (Phases 38 + 39 merge, App Mode/UI merge, provider endpoint
security, provider reconfiguration correctness)

---

## 1. The one-paragraph version

Phase 3 gave Freya an honest microphone: it could capture, it refused to pretend a
transcript was a turn, and it said so when no engine was configured. What it could
not do was *work* — there was no permission lifecycle, no state machine, no way to
interrupt, no way for Freya to speak. This phase finishes that while leaving every
authority boundary exactly where it was. Voice is I/O. A spoken sentence reaches
the same door typed text reaches, a stored answer can be read aloud, and nothing
about either can mint a grant, choose a provider, raise a budget or outlive STOP
ALL.

---

## 2. Architecture

```
  window                                        main process                Core
┌──────────────────────────────┐   ┌───────────────────────────┐  ┌──────────────────┐
│ VoiceRuntime                  │   │ permission gate           │  │ VoiceService     │
│  press/release/cancel         │──▶│  reads Core's projection  │  │  state machine   │
│  openMicrophone (PCM 16k)     │   │                           │  │  bounds          │
│ WindowSpeechOutput            │◀──│ HostVoiceOutput           │◀─│  ports           │
│  speechSynthesis              │   │  forwards, then waits     │  │                  │
│ detectRecognitionSupport()    │   │                           │  │ injected         │
│ wake meter (RMS, stores none) │   │                           │  │  submitTurn()    │
└──────────┬───────────────────┘   └───────────────────────────┘  │  resolveTurnText │
           │ voiceClient                                          └────────┬─────────┘
           ▼ 19 bounded commands                                             │ same door
┌──────────────────────────────┐                                            ▼
│ preload (no text to be spoken)│                        ConversationService → Mind
└──────────────────────────────┘                              → Guard → Governor → Gateway
```

The split is the design: **Core decides, the window operates the device.** Core
has no store, no Mind, no grant and no Gateway in the voice path, so the only way a
spoken word becomes a turn is by being handed to Core's own submitter.

### Files

| File | What it owns |
|---|---|
| `core/voice/types.ts` | The state machine, the ports, the deterministic bounds, the closed allowlists |
| `core/voice/audio.ts` | The audio edge — takes `unknown`, checks metadata against bytes |
| `core/voice/stt.ts` | STT port, deadline enforcement, deterministic and scripted adapters |
| `core/voice/tts.ts` | TTS port, tuning clamps, unavailability that refuses |
| `core/voice/wake.ts` | The local energy gate, and what it honestly is |
| `core/voice/service.ts` | The state machine, the permission lifecycle, the queue |
| `electron/voiceHost.ts` | The speech adapter that reaches the platform from main |
| `src/voice/runtime.ts` | Device capture, barge-in, the wake meter, disposal |
| `src/voice/output.ts` | `speechSynthesis`, its missing callbacks and its sharp edges |
| `src/voice/recognition.ts` | Feature detection, and the finding that it is unusable |
| `src/platform/voiceClient.ts` | The renderer's mirror, with no method that executes a transcript |
| `src/app/voice/` | App Mode's push-to-talk and the settings row |

---

## 3. The microphone permission model

Four facts, and every gate reads the same two of them:

| Fact | Who sets it | Durable? |
|---|---|---|
| The platform offers a capture path | the renderer, by feature detection | no |
| The microphone is on | `voice.mic.enable`, owner only | **no** — nothing restores it |
| Permission is held | `voice.permission.report`, reporting the OS | no |
| A capture is open | `voice.capture.start`, after the two above | no |

`voice.permission.report` is a **report**, not a request. Core cannot grant
permission and has no way to ask for it; capture is refused unless the last thing
reported was `granted`. A renderer that lies here can only obtain a capture the
operating system has already refused — and the host grants the device from its own
gate, not from this flag.

The host installs **both** Electron permission handlers. `setPermissionCheckHandler`
is not redundancy: it is the only place a renderer can be caught asking whether it
may use the microphone *between* captures, and installing only the request handler
would have left that as a side channel into Core's state. Both are
origin-blind — a page loaded into any window cannot obtain a stream by asking while
an unrelated capture happens to be running.

Revocation mid-capture ends the session immediately. The device is going away
whether or not this process noticed, so the session is closed here rather than left
to fail later with an empty buffer.

---

## 4. STT and TTS adapters

### STT — the port is provider-neutral, the engine is absent

`kind` names where an adapter runs: `local`, `platform`, `provider`. The Phase 3
`local: true` literal could not express a hosted engine, and a boundary that
cannot describe the thing it refuses will be broken open later by somebody in a
hurry.

What did not change is the rule that matters: **an absent engine is an object that
refuses**, reports `configuration-required`, and the recording is discarded. There
is no default engine and no fallback anywhere in the repository.

Browser speech recognition was feature-detected rather than assumed, and the
finding is that it is not usable here:

- Chromium in an Electron build does not ship `webkitSpeechRecognition`.
- Where the API does exist in a browser, it is a cloud recogniser that sends audio
  off the machine.

`detectRecognitionSupport()` reports those two situations separately — "the
platform has no recognition API" and "the platform has one that would send audio
off this machine" — and enables neither. It never invokes the constructor it finds,
because a feature detector that calls what it finds is no longer a detector.

**This build can now transcribe when the owner explicitly enables hosted STT.**
The production host supplies a main-process-only adapter for NanoGPT's transcription
endpoint. It remains `configuration-required` unless `FREYA_ALLOW_REMOTE_STT=1`
and `NANOGPT_API_KEY` are both present. The endpoint is fixed in code, the key
never crosses the preload bridge, audio is wrapped as WAV in memory only, and
nothing is written to disk or to the journal. With the switch off, the original
Phase 45 behavior is unchanged: the recording is discarded and no network request
exists.

### TTS — the platform really does provide this

`window.speechSynthesis` exists in Electron, so Freya can genuinely read a stored
answer aloud with no network, no credential and no endpoint.

The adapter lives in main (`HostVoiceOutput`) because Core cannot make a sound:
Core calls `speak`, the adapter forwards an instruction to the attached window, the
window plays it, and it reports back through Core's own `voice.tts.settle`. The
promise `speak` returns resolves when **Core** says the utterance is over, so the
trusted half decides when playback finished rather than the window announcing it.

Availability is reported, never assumed. The adapter starts `unavailable` — until a
window says it found an engine, this process genuinely does not know — and a build
where every window reports nothing ends up with an honest `synthesis.unavailable`
rather than a claim about talking that cannot be backed.

### What Freya may say

`voice.tts.speak` takes a **turn id**. Core reads the stored answer out of its own
conversation store. A window cannot supply the words, so it cannot synthesise a
sentence in Freya's voice. A turn with no stored answer is refused; a denied or
cancelled turn has nothing to read.

---

## 5. App Mode wiring

Minimal and functional; no visual redesign.

- The composer's microphone is push-to-talk. `pointerdown` opens, `pointerup`
  closes, and `pointerleave` while held also closes — a person who slid off
  mid-sentence did not mean to leave the microphone open.
- It is **disabled only** when the platform genuinely cannot capture. A permission
  or engine problem is not disabled, because pressing it is what produces the
  sentence that explains the problem, and a greyed-out button explains nothing.
- Its accessible name is the truthful state, not a fixed label. The decorative
  placeholder it replaced was a live control whose honest outcome was "not
  connected yet".
- Durable preferences live in Settings: microphone, Freya speaks, send-what-I-say,
  hands-free, and a voice picker. Each states what it currently means in words.
- The legacy shell's microphone goes through the same runtime, so both surfaces
  share one implementation rather than two that can disagree.

---

## 6. STOP ALL behaviour

Voice is I/O, not authority — but a microphone that stays open after the panic
button is still a microphone the owner asked to be shut, and a queued utterance
that plays out afterwards is Freya talking when somebody believes she has stopped.

So `security.stopAll` does, in the same synchronous turn that closes the gateway:

1. releases the capture and aborts the transcription,
2. drops the speech queue and cuts playback,
3. disarms hands-free,
4. latches the state to `stopped-by-STOP-ALL`.

And then **again** once the latch is durable. A `voice.capture.start` already in
flight can land in the window between the synchronous gate and the latch; the second
call is the first moment at which `stopAllLatch()` reads true, so it is the first
moment Core can honestly refuse one. `onStopAll` is idempotent, so one stop writes
one journal line.

A final transcript that arrives after a stop is **discarded**, not submitted and
refused — a turn that exists and is denied still writes a user message and shows up
in the transcript as something the owner said when they did not get to.

`security.resume` recomputes where the state machine sits and clears nothing.
`micEnabled` survives, because resuming Freya's authority to think says nothing
about the microphone, and hands-free stays disarmed.

**This inverts a Phase 3 assertion.** That phase asserted that STOP ALL said
nothing about the microphone. This phase inverts it, and the old assertion was not
kept.

---

## 7. Privacy guarantees

| Guarantee | Where it is enforced |
|---|---|
| Mic OFF by default, and OFF after a restart | `micEnabled` is `false` from construction; no durable flag, no hydration path, no assignment outside `enableMic` |
| No recording before explicit activation | `beginCapture` requires `micEnabled`; the host gate additionally requires an open capture |
| No hidden background capture | A session exists only between `beginCapture` and an end call. Nothing runs at start-up, on a timer, or on a wake event the owner did not arm |
| No continuous audio storage | `CapturedAudio` is a parameter with no field holding it anywhere; released on every return path |
| No raw audio journals or logs | Fifteen voice events, all metadata, field-by-field validated. A structural test asserts no voice payload has an `audio`, `bytes`, `transcript`, `text`, `interim` or `content` field |
| Interim never reaches a sink | Display-only: clipped, pushed, dropped, never journalled, and no command anywhere that would submit one |
| No STT/TTS credential in the renderer | `speechSynthesis` is an OS facility; nothing in `voiceHost.ts` or `output.ts` has a URL, a `fetch` or a key field |
| No renderer-forged permission | `permission.report` is a report; capture needs `granted`; the host grants the device from its own gate |
| Web content cannot activate the mic | No path to `getUserMedia`; the permission gate is the second lock, and origin-blind |
| Bounded audio | Duration, bytes, frames, codec, MIME, sample rate, channels, whole-frame alignment, and duration-reachability — all checked against each other |
| Transcript retention follows normal policy | A transcript is a user message in the encrypted conversation store, or a composer draft. It is not a memory, a brain record or a journal line |

---

## 8. Activation matrix — what is actually live on this build

| Capability | Active? | Why, precisely |
|---|---|---|
| **Push-to-talk** | **YES** | Core agrees before `getUserMedia`; both permission handlers read Core's projection |
| **Mic permission lifecycle** | **YES** | `permission-required` → `permission-denied` / `granted` / `revoked`, all distinct states |
| **TTS — Freya reads stored answers** | **YES** | `speechSynthesis` is present in Electron; Core resolves the words from a turn id |
| **TTS — cancel / stop / queue** | **YES** | `cancel` truncates mid-word, `stop` at a boundary; Core holds the queue and the status |
| **Barge-in — press while she speaks** | **YES** | Playback cancelled, then capture begins |
| **Barge-in — automatic, via wake** | **NO** | Needs a microphone open during playback. Available only when hands-free is armed, and hands-free is unavailable on this build |
| **STT — transcription** | **YES, opt-in** | Paid hosted adapter; requires `FREYA_ALLOW_REMOTE_STT=1` plus `NANOGPT_API_KEY`. Otherwise reports `configuration-required` and sends nothing |
| **STT — interim transcripts** | **NO** | Follows STT. Interim display works the moment an adapter streams |
| **STT — browser recognition** | **NO** | Feature-detected absent in Electron, and cloud where present. Neither enabled |
| **Final transcript → conversation** | **YES** | Injected submitter, same function typed text uses. One model call |
| **Auto-submit** | **YES, off by default** | Owner toggle; a microphone press is not a purchase |
| **Mute / unmute** | **YES** | |
| **Truthful indicators** | **YES** | Every label derives from Core's `VoiceState` |
| **STOP ALL over voice** | **YES** | Capture, transcription, submission and playback, twice around the latch |
| **Hands-free wake** | **NO, honestly** | A local energy gate exists and is wired, but the projection reports `kind: 'speech-activity'` and Core refuses to arm it: no local detector is configured. There is no wake-*word* model and the UI never claims one |
| **Interruption during a turn** | **YES** | `voice.tts.cancel` marks `interrupted`; the underlying text response is untouched |

---

## 9. Tests

| Suite | Count | What it pins |
|---|---|---|
| `tests/core/voice/runtime.test.ts` | 51 | The mic is off until pressed; restart returns it off; permission lifecycle; interim never executes; one canonical turn; audio bounds; timeout vs. unconfigured vs. engine failure; cancel reaches a running transcription; STOP ALL at every stage; stored-answer playback; barge-in; hands-free refusal; metadata-only journal; a pushed projection |
| `tests/red-team/voice/voice-redteam.test.ts` | 50 | Transcript injection; 16 hostile audio descriptors; STOP vs. final transcript; permission revoke and stop races; stale and duplicate transcripts; renderer-forged permission and wake source; forging what Freya says; hidden capture; leakage; cost |
| `tests/host/voiceBridge.test.ts` | 13 | The preload allowlist; no function sends text to be spoken; the audio allowlist; the permission vocabulary; a real host round trip; the adapter's availability and settlement |
| `tests/unit/voice/platform.test.ts` | 13 | Recognition feature detection; `speechSynthesis` completion, watchdog, cancel vs. stop, voice selection, `voiceschanged` |
| `tests/unit/voiceClient.test.ts` | 15 | Core decides first; unreachable host is a resolved refusal; interim never offered onward; `turnId` vs. text; the format is not a parameter |
| `tests/unit/app/voiceSettings.test.tsx` | 10 | Every switch states its real state; a missing Core degrades to a sentence, not five dead controls |
| Whole suite | 7,341 | green, zero unhandled rejections |
| Red team | 1,250 | green |
| Desktop E2E | 217 | green |

Two defects were found by writing these and fixed:

- A `voice.capture.start` in flight could survive a stop (see §6).
- `voiceClient.attach` threw inside a passive React effect when a bridge lacked the
  voice channels — 48 unhandled rejections across the suite while every assertion
  still passed. A missing push channel is a real state and is now reported as one.

---

## 10. Two tests that were rewritten rather than adjusted

- The E2E boundary check matched `/capabilit/` and failed on
  `reportVoiceCapabilities`. Renaming the function until it passed would have made
  the check meaningless. It now asks what it actually means — does any bridge
  function reach Work's capability registry, a verifier or a plan body? — and a
  second check pins the voice channel to the exact declared set.
- A test in `mind.test.ts` opened a capture with no lifecycle because none
  existed. It now walks the path the composer walks.

---

## 11. Release budget

`preloadBytes` 120k → 135k and `rendererTotalBytes` 3.5MB → 3.7MB, each with a
comment naming what was added and why it lands twice. Measured: preload 130,288;
renderer total 3,599,318. The increase is voice source in two entry bundles —
not compression, imagery or a dependency.

---

## 12. What a later phase would have to do

- **A local recogniser.** Whisper.cpp, `whisper.cpp` bindings, Vosk, or a platform
  engine. Supplied through `CoreOptions.voiceStt`; nothing else changes. Until then
  `configuration-required` is the truthful answer.
- **A local wake-phrase detector**, which would let `wake.kind` stop being
  `speech-activity` and mean the word it currently refuses to mean.
- **A hosted STT or TTS adapter**, if one is ever wanted. The port fits one
  unchanged; the credential stays in the main process and the endpoint follows the
  same discipline as a model request. It should not be added to close the
  transcription gap — that gap is the honest part of this phase.

## 13. Safe to integrate

Yes. No authority boundary moved: Guard, Governor, STOP ALL, budgets, approvals and
the conversation path are all upstream of voice, and one test per boundary exists
to say so. The two things that are not live — transcription and hands-free — report
themselves as not live rather than degrading into something that looks like it
works.