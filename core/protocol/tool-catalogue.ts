/** Metadata of registered conversation tools. No executable bodies or authority. */
export interface ToolCatalogueView {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    readonly capability: string
    readonly parameters: readonly { readonly name: string; readonly description: string; readonly required: boolean }[]
  }[]
}
