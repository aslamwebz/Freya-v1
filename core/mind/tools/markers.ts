/* ----------------------------------------------------------- wire protocol */

export const TOOL_CALL_OPEN = 'FREYA_TOOL_CALL'

export const TOOL_CALL_CLOSE = 'FREYA_TOOL_CALL_END'

/**
 * What a shortened extract says, in the observation rather than in a flag nobody reads.
 *
 * Spelled out here rather than inlined so that `renderObservation`, the tests and any
 * future tool all agree on the words a person would see.
 */
export const EXTRACT_CUT_MARKER = '(the extract was cut; the page said more than this)'
