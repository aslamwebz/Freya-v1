/**
 * The Browser Service, as one import.
 *
 * The surface-agnostic half of Freya's browser: tab lifecycle, the Semantic Browser Protocol,
 * and the port a surface implements. `EmbeddedElectronSurface` in `electron/browser` is one
 * implementation; a `BrowserRelaySurface` over the paired extension is meant to be the other,
 * and nothing above this folder would need to change for it to arrive.
 */
export * from './types'
export * from './lifecycle'
export * from './refs'
export * from './surface'
export * from './service'
