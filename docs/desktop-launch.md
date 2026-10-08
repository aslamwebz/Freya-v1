# Freya desktop launch

A real Freya launch goes straight from a desktop shortcut to a built Electron
process. There is no Vite dev server, no localhost port, and no
PowerShell / cmd console in the middle.

## End-user path

```text
Freya shortcut (Freya.lnk)
        ↓
node_modules\electron\dist\electron.exe
        ↓
dist-electron\main.cjs
        ↓
dist\index.html (built renderer)
        ↓
Freya window
```

The shortcut's target is `electron.exe`. Its first argument is the path to
the working copy. Its working directory is the same. No environment, no npm,
no Vite.

## Build

```bash
npm install        # one-time
npm run build:desktop   # vite build + esbuild main + presence
```

`build:desktop` is `npm run build:renderer && npm run build:main`. It writes
the built artifacts into `dist/` (renderer) and `dist-electron/` (main +
preloads + presence). Neither target is a development server; both are
production-shaped outputs that Electron can load directly.

## Install the shortcut

```bash
npm run install:shortcut
```

Writes two shortcuts:

- `Desktop\Freya.lnk`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Freya.lnk`

Both target the same `electron.exe` and the same working copy. Both are
idempotent: re-running the installer replaces them in place with the current
working directory and icon. To remove the desktop entry only:

```bash
node scripts/install-shortcut.mjs --no-desktop
```

To remove the Start Menu entry only:

```bash
node scripts/install-shortcut.mjs --no-start-menu
```

## How the launch works

The shortcut's `.lnk` file has three fields that matter:

- `TargetPath` — `node_modules\electron\dist\electron.exe` in this checkout.
- `Arguments` — the path to the working copy, quoted.
- `WorkingDirectory` — the working copy itself.

`electron.exe` is a GUI binary, so Windows gives it a window and nothing
else. There is no console. There is no `cmd.exe` foreground flash.

`electron.exe` reads `package.json`'s `"main"` field, which is
`dist-electron/main.cjs`, and loads the renderer from `dist/index.html`
(also written by `build:desktop`).

The launch is not a development launch. The Electron main process sees no
`FREYA_DEV_SERVER` environment variable, so it does not try to attach to a
Vite dev server. There is no Vite dev server.

## Single instance

A second double-click of the shortcut does **not** start a second Freya.
Electron's `app.requestSingleInstanceLock()` is taken during boot. If a
second launch fails to acquire the lock, it quits immediately. The original
process receives a `second-instance` event and focuses its existing window.

That same lock is what makes the control plane (see `docs/control-plane.md`)
safe to share: there is exactly one Freya process per user profile, and the
control plane's named pipe is owned by it.

## Where state lives

- Workspace file: `%APPDATA%\freya\workspace.json`
- Event journal: `%APPDATA%\freya\core-events.jsonl`
- Device-hands journal: `%APPDATA%\freya\device-hands.jsonl`
- Vault: `%APPDATA%\freya\vault\freya.db`
- Provider config: `%APPDATA%\freya\provider.json`
- Capability settings: `%APPDATA%\freya\capabilities.json`
- Voice settings: `%APPDATA%\freya\voice.json`
- Control token: `%APPDATA%\freya\control.token`
- Control endpoint: `%APPDATA%\freya\control.endpoint`

All are owned by the current OS user.

## Updating

```bash
git pull
npm install            # if dependencies changed
npm run build:desktop  # always
npm run install:shortcut
```

`install:shortcut` rewrites the shortcuts in place to point at the same
working copy. It does not need administrator rights.

## Development launches are different

These are intentionally separate paths and they are explicitly not what the
shortcut launches:

| Script              | What it does                                                 |
| ------------------- | ------------------------------------------------------------ |
| `npm run dev`       | Vite dev server in a browser, no Electron.                   |
| `npm run dev:desktop` | Builds main, starts Vite on a port, launches Electron pointed at it. |
| `npm run dev:kilo`  | Same as `dev:desktop` but with an isolated user-data dir.    |
| `npm run electron:dev` | Builds main, launches Electron with `--dev`.               |

These scripts leave a Vite dev server running, bind a localhost port, and
expect a different (development) window state. The shortcut does none of
those things.

## Headless launches

`scripts/launch.mjs <display-number>` is the build-and-launch path used by
`npm start` and `npm run start:display2`. It builds first and then launches
with the chosen display number. It is not the shortcut.

## Acceptance test

1. Close any running Freya.
2. `npm run build:desktop` once.
3. `npm run install:shortcut`.
4. Double-click `Freya` on the desktop.
5. The window opens. No console appears. No Vite / localhost port is in use.
6. Open a separate terminal and run `freya status` (it requires Node and
   the CLI to be on PATH or invoked as `node bin/freya.mjs status` from the
   working copy). The response is a healthy Freya status.
7. Double-click the shortcut again. The same window comes to the front.
   No new Freya process is spawned.
