@echo off
rem The CLI entry point. `npm run freya` and `npx freya` both route through here.
rem
rem Resolving from the repo root is the contract: the CLI knows where Freya's
rem user-data directory is, and the named pipe / token file live there. A copy
rem of `bin\freya.mjs` is unnecessary; this wrapper just calls node on it.
node "%~dp0freya.mjs" %*
