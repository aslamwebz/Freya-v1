import { useEffect, useRef, useState } from 'react'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings as Preferences } from '../../../core/voice/settings'
import { hostBridge } from '../../platform/host'
import { voiceMirror } from '../../platform/voiceClient'

export function VoicePreferences() {
  const [value, setValue] = useState<Preferences>({ ...DEFAULT_VOICE_SETTINGS })
  const [notice, setNotice] = useState('')
  const discoveryCancel = useRef<(() => void) | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const bridge = hostBridge()
    if (!bridge?.voiceSettingsRead) return
    let alive = true
    void bridge.voiceSettingsRead().then(p => { if (alive) { setValue(p); setConnected(true) } }).catch(() => { if (alive) setNotice('Voice preferences are unavailable.') })
    return () => { alive = false; discoveryCancel.current?.() }
  }, [])
  const discoverInputs = async () => {
    const mirror = voiceMirror()
    let stream: MediaStream | null = null
    let cancelled = false
    let activated = false
    const cancel = () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()) }
    discoveryCancel.current = cancel
    const deadline = setTimeout(cancel, 10_000)
    const detach = mirror.subscribe(p => {
      if (p?.state === 'stopped-by-STOP-ALL' || p?.permission === 'revoked' || p?.permission === 'denied' || (activated && !p?.micEnabled)) {
        cancel()
      }
    })
    setSaving(true)
    try {
      const enabled = await mirror.micEnable()
      if (!enabled.ok || cancelled) throw new Error('Microphone unavailable.')
      activated = true
      await mirror.refresh()
      if (mirror.projection?.permission !== 'granted') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } else {
        const started = await mirror.startCapture()
        if (!started.ok) throw new Error('Turn off Hands-free before refreshing microphones.')
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      if (cancelled) throw new Error('Microphone cancelled.')
      const inputs = await navigator.mediaDevices.enumerateDevices()
      if (cancelled) throw new Error('Microphone cancelled.')
      if (mirror.projection?.permission !== 'granted') await mirror.reportPermission('granted')
      setDevices(inputs.filter(d => d.kind === 'audioinput' && d.deviceId))
      setNotice('Choose your microphone, then save.')
    } catch { setNotice('Turn off Hands-free and allow the microphone, then try again.') }
    finally { clearTimeout(deadline); discoveryCancel.current = null; detach(); stream?.getTracks().forEach(t => t.stop()); await mirror.cancelCapture(); await mirror.refresh(); setSaving(false) }
  }
  const save = async () => {
    const bridge = hostBridge()
    if (!bridge?.voiceSettingsWrite) return
    setSaving(true)
    try { setValue(await bridge.voiceSettingsWrite(value)); await voiceMirror().refresh(); setNotice('Saved. Turn on Hands-free when you are ready to talk.') }
    catch { setNotice('Voice preferences could not be saved. Try again.') }
    finally { setSaving(false) }
  }
  return <div className="voice-preferences">
    <label>Microphone device<select value={value.inputDeviceId} disabled={!connected || saving} onChange={e => setValue({ ...value, inputDeviceId: e.target.value })}>
      <option value="">System default microphone</option>
      {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>)}
      {value.inputDeviceId && !devices.some(d => d.deviceId === value.inputDeviceId) ? <option value={value.inputDeviceId}>Saved microphone</option> : null}
    </select></label>
    <button type="button" className="st-mini" disabled={!connected || saving} onClick={() => { void discoverInputs() }}>Refresh microphones</button>
    <label>Voice Input Provider<select value={value.inputProvider} disabled={!connected || saving} onChange={e => setValue({ ...value, inputProvider: e.target.value as Preferences['inputProvider'] })}>
      <option value="nanogpt">NanoGPT</option><option value="local-whisper">Local whisper.cpp</option>
    </select></label>
    <label>Voice Input Model<input value={value.inputProvider === 'local-whisper' ? 'base.en' : value.inputModel} maxLength={200} disabled={!connected || saving || value.inputProvider === 'local-whisper'} onChange={e => setValue({ ...value, inputModel: e.target.value })} /></label>
    <p>{value.inputProvider === 'local-whisper' ? 'Base English runs on your CPU only when needed after you call Freya or press the microphone. No speech API charges.' : 'Uses your protected NanoGPT credential, independently of the Chat model.'}</p>
    <label>Voice Output Provider<select value="platform" disabled><option value="platform">Local system speech</option></select></label>
    <p>Voice Output Model: your operating system speech engine. Choose its speaker below.</p>
    <label><input type="checkbox" checked={value.remoteAudioEnabled} disabled={!connected || saving} onChange={e => setValue({ ...value, remoteAudioEnabled: e.target.checked })} />Allow NanoGPT speech recognition</label>
    <p>Short microphone recordings leave this computer only with this opt-in. Standby detects “Freya” locally; only speech after you call her is transcribed. Freya does not save the recordings.</p>
    <label>Return to standby after<select value={value.attentionTimeoutMs} disabled={!connected || saving} onChange={e => setValue({ ...value, attentionTimeoutMs: Number(e.target.value) })}>
      {[15000, 30000, 60000, 120000, 300000].map(ms => <option value={ms} key={ms}>{ms / 1000} seconds</option>)}
    </select></label>
    <button type="button" className="st-mini" disabled={!connected || saving} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Save voice preferences'}</button>
    {notice ? <p role="status">{notice}</p> : null}
  </div>
}




