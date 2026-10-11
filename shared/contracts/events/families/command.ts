export const COMMAND_EVENT_TYPES = [
// Commands arriving from the user
  'command.received',
] as const
export interface CommandEventPayloads {
/**
   * The journal records that a command arrived, not what it said.
   *
   * An audit log is read by people, shipped in backups, and kept far longer
   * than a conversation. Whatever a user types belongs in conversation storage,
   * which has its own retention rules. The security journal needs only enough
   * to answer "did this happen, and was it this long".
   */
  'command.received': {
    commandId: string
    /** Characters in the submitted text. Metadata, not content. */
    contentLength: number
    /** Which surface submitted it, e.g. 'command-bar'. */
    source: string
  }
}