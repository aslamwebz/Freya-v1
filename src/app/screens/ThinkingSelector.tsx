import { Glyph } from '../../ui-v2/primitives/Glyph'

/**
 * Reasoning effort is intentionally display-only until the provider contract can
 * carry it end to end.
 *
 * A local selector that never reaches Core is worse than no selector: it makes a
 * person believe a paid/model behaviour changed when the request is identical. The
 * control stays in the canonical composer so the layout does not churn when the
 * capability arrives, but it tells the truth about today's contract.
 */
export function ThinkingSelector() {
  const label = 'Provider reasoning'
  const detail = 'Reasoning effort is controlled by the selected provider in this build; Freya does not yet send an effort setting.'

  return (
    <button
      type="button"
      className="hd-tool hd-tool-think"
      aria-label={label}
      aria-disabled="true"
      title={detail}
      onClick={event => event.preventDefault()}
    >
      <Glyph name="mind" size={18} />
      <span>Provider</span>
    </button>
  )
}
