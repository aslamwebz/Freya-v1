# Freya Startup Guide

Operational runbook for launching Freya for normal use, automated testing, and external agent control.

---

## 1. Launching Freya

Freya can be launched either as a normal desktop app or with debugging/automation enabled.

### A. Everyday Desktop Use (Standard Mode)
Run standard Freya without remote debugging:
- **Executable**: Double-click `Freya.exe` in `C:\Users\you\Desktop\AI\Freya`.
- **Command script**: Run `Freya.cmd` in `C:\Users\you\Desktop\AI\Freya`.
- **PowerShell**:
  ```powershell
  cd C:\Users\you\Desktop\AI\Freya
  npm start
  ```

*Characteristics*:
- Uses standard user profile in `%APPDATA%\freya`.
- Local control pipe is active (`\\.\pipe\freya-control-<pid>`).
- Chrome DevTools Protocol (CDP) is **not** exposed.

---

### B. Live Automated Testing & External Control (Debugging Mode)
When external tools, Playwright, or AI agents need to control the visible UI like a user:
- **Executable**: Double-click **`freyadebugging.exe`** in `C:\Users\you\Desktop\AI\Freya`.
- **Node launcher**:
  ```powershell
  cd C:\Users\you\Desktop\AI\Freya
  node scripts/dev-kilo.mjs --port=9234 --no-build
  ```

*Characteristics*:
- Opens the visible Freya Electron window on screen (Display 1).
- Binds Chrome DevTools Protocol to `127.0.0.1:9234`.
- Authenticated named pipe (`\\.\pipe\freya-control-<pid>`) remains fully active.
- Playwright and external agents can directly attach to `http://127.0.0.1:9234` to click buttons, switch tabs, type in the composer, and inspect rendered DOM state.

---

### C. Isolated Profile Testing (Multi-Instance)
To run a second instance of Freya alongside an existing one without touching your primary profile:
```powershell
cd C:\Users\you\Desktop\AI\Freya
node scripts/dev-kilo.mjs --port=9235 --profile=.kilo/test-profile --no-build
```

---

## 2. Verifying the Running Instance

### Verify CDP (when running `freyadebugging.exe` or `dev-kilo.mjs`):
```powershell
Invoke-RestMethod http://127.0.0.1:9234/json | Select-Object title, url
```
Expected output:
- `Freya` pointing to `dist/index.html`
- `Freya Presence` pointing to `dist/presence.html`

### Verify Named Pipe Control Plane:
```powershell
node bin\freya.mjs status
node bin\freya.mjs health
```
Expected output:
```text
ready: true
stopAllActive: false
```

---

## 3. Environment & Credentials

- All provider credentials (NanoGPT, MiniMax, Brave Search, etc.) are read from `.env` in the repository root.
- The `.env` file is loaded strictly by the Electron main process; credentials are never exposed across the preload bridge or written to renderer logs.
- Live billing requires `FREYA_ALLOW_LIVE_MODEL=1` in `.env`.

---

## 4. Operational Rule

Freya's generated text is not the source of truth. Always verify real outcomes:
1. Verify open browser tabs with `node bin\freya.mjs browser tabs`.
2. Verify conversation state with `node bin\freya.mjs chats`.
3. Verify live UI state using Playwright CDP or DOM snapshots.

For full details on driving Freya via CLI, Playwright CDP, and MCP, see [`control.md`](control.md).
