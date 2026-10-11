# Freya Startup Guide

Development uses **FreyaDebug.cmd**. It builds the existing application and starts Core, Freya and Superapp as separate processes, with tagged output in one console. The custom Freya.exe and freyadebugging.exe launchers have been retired. Electron's runtime executable remains required.

Run the launcher from the checkout:

```powershell
.\FreyaDebug.cmd
```

The default isolated development profile is `.kilo/freya-debug-profile`. Existing owner data is left in place. Use `--profile=PATH` to select a profile deliberately; use `--no-build` only when the current build is already available. Core opens the existing keyring and encrypted stores with their current schemas. An unreadable key never silently becomes a replacement key.

In the debug console:

- `status` checks each live process.
- `restart freya`, `restart core`, or `restart superapp` restarts only that component.
- `stop superapp` closes the UI and keeps both services running.
- `start superapp` reopens the UI.
- `stop all` explicitly shuts down the whole stack.

The same commands work from another terminal using `FreyaDebug.cmd --no-build status` or `FreyaDebug.cmd --no-build restart freya`. Specify the same profile when using a custom profile. Normal window close still hides the application; UI Quit disconnects only Superapp.

Core's work heartbeat runs every 30 seconds. The supervisor checks live readiness every 60 seconds and prints `HEARTBEAT HEALTH OK` only when all three components are ready. Otherwise it names the affected component and its failure. No inference or action is automatically replayed after a lost connection. Due reminders remain retained while Freya is disconnected and reconcile on reconnection.

The debug UI exposes CDP only on `127.0.0.1:9234`; override with `FREYA_CDP_PORT`. The existing `dev:kilo`, `dev:desktop`, `npm start`, `Freya.cmd` and `FreyaChatDebug.cmd` commands delegate to the same supervisor. `dev:desktop` retains Vite hot reload.

For CLI control with the default development profile:

```powershell
$env:FREYA_USER_DATA = Join-Path $PWD '.kilo/freya-debug-profile'
node bin\freya.mjs status
node bin\freya.mjs health
```

Provider settings remain private host configuration. Live model use still requires the existing opt-in. The process acceptance harness creates its own new profile and explicitly uses the labelled developer provider; it never substitutes test keys into an existing keyring.

Verify the compiled application with `node scripts/structural-split-acceptance.mjs`. It checks real renderer communication, protected persistence, browser admission, installed voice discovery, the independent Core clock and recovery. See [control.md](control.md) for the existing CLI and browser controls.
