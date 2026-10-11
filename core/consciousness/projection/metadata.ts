/** The note attached to a section that could not be built. */
const ABSENT = 'this Core has not built this subsystem'

/** The note attached to a section whose source exists but could not be read. */
const UNREADABLE = 'this source exists but could not be read'

/** Turn an absent subsystem into a stated absence, never a null or zeroed claim. */
export function absentMeta(note: string | null): { state: 'absent'; note: string | null } {
  return { state: 'absent', note: note === null ? ABSENT : note }
}

/** Keep unreadability distinct from absence so consumers do not infer too much. */
export function degradedMeta(note: string | null): { state: 'degraded'; note: string | null } {
  return { state: 'degraded', note: note === null ? UNREADABLE : note }
}

export { ABSENT }
