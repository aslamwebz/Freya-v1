import { WorkRecordControls } from './WorkRecordControls'

/** Metadata remains private; content is read only when the owner opens one Goal. */
export function GoalRecords() {
  return <WorkRecordControls kind="goal" />
}
