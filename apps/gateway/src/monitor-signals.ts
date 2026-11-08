/** Metadata only. Commands, tool arguments/output and private reasoning never enter alerts. */
export interface MonitorSignal {
  id:string;session_id:string;turn_id:string;at:string;
  kind:"input_requested"|"input_resolved"|"tool_failed"|"tool_recovered";
  topic:string;blocking?:boolean;
}
