import { useEffect, useState } from 'react'
export function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      if (!document.hidden) {
        setNow(new Date())
        timer = setInterval(() => setNow(new Date()), 1000)
      }
    }
    sync(); document.addEventListener('visibilitychange', sync)
    return () => { if (timer !== undefined) clearInterval(timer); document.removeEventListener('visibilitychange', sync) }
  }, [])
  return <div className="f-clock"><small>{now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</small>
    <time dateTime={now.toISOString()}>{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()}</time></div>
}
