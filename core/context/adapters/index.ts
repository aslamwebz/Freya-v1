/**
 * CONTEXT SOURCE ADAPTERS — the closed front doors of the context domain.
 *
 * One module per human act: explicit selection (#25), authorised project/file
 * (#25), shared tab/media (#25). Each converts a caller-supplied, already-
 * authorised input into a `ContextAdmission` candidate for the #15 store,
 * validating kind/source combinations without ever deciding authority,
 * discovering content, or capturing anything.
 *
 * Deliberately *not* exported from `core/index.ts`: facade wiring is issue
 * #20's lane, transport/UI is #24's. Nothing here reaches those layers, and
 * nothing here imports anything outside `core/context/`.
 */
export * from './admission'
export * from './explicit-selection'
export * from './project-file'
export * from './tab-media'
