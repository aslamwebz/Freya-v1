# Phase 18 — Integration, security and packaging

Status: **integrated hardening complete**, now verified together with Phase 17 Skills.

Phase 18 is the release-hardening layer. Its deterministic release, startup, recovery and
artifact-integrity controls are now verified against the complete Phase 17 Skills surface.

## Implemented now

### Reproducible supply-chain gate

`npm run release:check` validates the committed dependency graph without requiring network access:

- `packageManager` is pinned to `npm@11.5.1`;
- lockfile version is fixed at v3;
- package.json dependency declarations must match the lock root;
- resolved packages must come from `https://registry.npmjs.org/`;
- every resolved package must carry a `sha512-` integrity hash;
- install scripts are deny-by-default with an explicit allowlist for current required packages;
- the private prototype must remain `private: true`.

This is not a substitute for an online vulnerability scan. It is the deterministic release
gate that catches dependency-source drift and lock tampering before a candidate is built.

### Service-separation readiness

The same release check walks `core/**/*.ts` and fails if Core imports Electron, React/UI,
renderer source, or Electron IPC/window APIs.

The prototype does **not** move Core into a separate service yet. This gate preserves that
option: a future split should be composition work, not an excavation of desktop dependencies.

### Performance budgets

A successful build is measured against hard ceilings:

| Artifact | Ceiling |
| --- | ---: |
| `dist-electron/main.cjs` | 1,500,000 bytes |
| `dist-electron/preload.cjs` | 100,000 bytes |
| `dist-electron/presencePreload.cjs` | 50,000 bytes |
| largest renderer JS chunk | 650,000 bytes |
| total renderer assets | 1,500,000 bytes |

A release does not silently grow past these values. Raising a ceiling is a reviewed policy
change, not an automatic response to a larger bundle.

### Backup and recovery contract

`electron/recovery/backupManifest.ts` defines the files belonging to one Core data path:
the event journal, encrypted conversation/Brain/Mission/Context/Personality/Skills stores,
the OS-protected `freya.keyring.json`, and workspace layout.

The validator refuses incomplete security-state restores and explicitly refuses to describe
an OS-protected keyring copy as cross-profile migration. The current keyring is protected
by the operating-system account and is intentionally not portable.

No live-copy command is exposed yet. Copying mutable stores while Freya is writing could
create a backup that only *looks* complete. A real backup command needs a Core-owned
quiesce/snapshot boundary first.

### Startup ownership

Production now acquires Electron's single-instance profile lock before opening the workspace,
keyring, journal or encrypted domain stores. A second launch restores/focuses the existing
window; it cannot construct a second Core against the same profile. The E2E harness has a
separate two-factor test-only bypass (`FREYA_E2E=1` plus `FREYA_E2E_ALLOW_MULTI_INSTANCE=1`)
because some restart/session tests intentionally run two throwaway processes against one
temporary profile. Production cannot enter that path accidentally.

### Artifact integrity manifest

`npm run release:manifest` hashes every distributable renderer and Electron artifact with
SHA-256 and writes `release/release-manifest.json`. The manifest is path-sorted, contains no
timestamp, records app/version, source revision plus dirty state, and target platform/arch.
This is the integrity/provenance payload a later signed installer/update can sign. A dirty
source tree is recorded honestly rather than being presented as a reproducible candidate.

### Release gate

`npm run release:gate` runs the existing full verification pipeline, the explicit Red-Team
Gauntlet, and the Phase-18 structural/supply-chain/performance checks. Any failure blocks
the candidate.

## Still deferred to a release candidate

Final installer generation, code signing/notarization, signed update-channel configuration,
live backup snapshot/quiesce, and the decision on whether Core actually moves to a separate
local service remain release-candidate work. The full verification and Red-Team release gate
is now exercised with Phase 17 Skills integrated; those deployment-specific items should be
closed only when the first distributable alpha/release candidate is prepared.
