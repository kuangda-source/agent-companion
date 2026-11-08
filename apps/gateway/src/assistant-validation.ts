/** Fixed schema diagnostics only: never include model text, references or credentials. */
export function invalidOutput(stage:string):never {throw Object.assign(new Error('invalid_model_output'),{validation_stage:stage});}
export const VALIDATION_STAGES=new Set(['summary_shape','summary_text','attention_shape','changes_shape','memory_key','memory_text','memory_stage','memory_status','memory_refs','memory_shape','memory_duplicates','memory_limit','notes_missing','notes_rejected','changes_kind']);

/** Same-topic repeats are normal model output; newest evidence wins. Equal-time
 * contradictory statuses are withheld rather than guessing which one is true. */
export function uniqueTopics<T extends {project_id:string;key:string;source_at:number;source_ids:string[]}>(items:T[],state:(item:T)=>string):T[]{
 const byKey=new Map<string,T>(),conflicts=new Map<string,number>();
 for(const item of items){const key=item.project_id+":"+item.key,old=byKey.get(key),conflict=conflicts.get(key);
  if(conflict!==undefined){if(item.source_at<=conflict)continue;conflicts.delete(key);}
  if(!old||item.source_at>old.source_at)byKey.set(key,item);
  else if(item.source_at===old.source_at){if(state(item)!==state(old)){byKey.delete(key);conflicts.set(key,item.source_at);}else byKey.set(key,{...old,source_ids:[...new Set([...old.source_ids,...item.source_ids])].slice(0,32)});}
 }return [...byKey.values()];
}
