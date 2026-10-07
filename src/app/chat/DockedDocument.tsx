import { useEffect, useState } from 'react'
import { hostBridge } from '../../platform/host'

/** Reuse the bounded host PDF reader, keeping the browser partition's policy intact. */
export function DockedDocument({ url }: { url: string }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setPreview(null); setReason(null)
    void (async () => {
      const response = await hostBridge()?.mediaDocument(url).catch(() => null) as { ok?: boolean; base64?: string; reason?: string } | null | undefined
      if (!alive) return
      if (!response?.ok || typeof response.base64 !== 'string') { setReason(response?.reason ?? 'Document preview is unavailable.'); return }
      try {
        const bytes = Uint8Array.from(atob(response.base64), (value) => value.charCodeAt(0))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        setPreview(objectUrl)
      } catch { setReason('The document could not be displayed.') }
    })()
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [url])
  return preview ? <iframe className="chats-browser-document" src={preview} title="Document preview" /> : <div className="chats-browser-empty"><b>{reason ? 'Document unavailable' : 'Opening document…'}</b><p role="status">{reason ?? 'Fetching the document through Freya’s page reader.'}</p></div>
}
