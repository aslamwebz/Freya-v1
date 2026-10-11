export const OFFICE_EVENT_TYPES = [
// Office (Phase 14) — the bounded record of a presence request.
  //
  // A request is not a command to Presence. It carries a workerId and nothing
  // else: no principal, no authority, no capability, no expression. Whether
  // and how the agent appears on the desktop is a Presence concern (Phase 13),
  // and these events have no field that could influence it. The Office can
  // ask, and it can show that it asked, and it can do nothing else.
  'office.presence.requested',
'office.presence.fulfilled',
] as const
export interface OfficeEventPayloads {
'office.presence.requested': {
    workerId: string
  }

'office.presence.fulfilled': {
    workerId: string
  }
}