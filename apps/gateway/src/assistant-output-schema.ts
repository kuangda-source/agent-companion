import type {Evidence} from './assistant-source.ts';
type Schema=Record<string,unknown>;
const text=(max:number):Schema=>({type:'string',minLength:1,maxLength:max});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items:Schema,max:number,min=0):Schema=>({type:'array',items,minItems:min,maxItems:max});
const choice=(values:string[]):Schema=>({type:'string',enum:values});

/** Constrain provider decoding and retain independent local provenance checks.
 * IDs are application-owned; model text cannot expand the citation scope. */
export function briefingOutputSchema(sessions:{session_id:string;project_id:string}[],allowed:Map<string,Evidence>):Schema{
 const projects=[...new Set(sessions.map(s=>s.project_id))];
 if(!sessions.length||sessions.some(s=>![...allowed.values()].some(e=>e.session_id===s.session_id)))throw new Error('no_readable_sources');
 const refs=(values:string[])=>array(choice(values),4,1);
 const key:Schema={type:'string',minLength:1,maxLength:100,pattern:'^[a-zA-Z0-9_.:-]+$'};
 const stages=choice(['planned','reported','verified','accepted']);
 const projectSchema=(id:string)=>{
  const source=refs([...allowed.values()].filter(e=>e.project_id===id).map(e=>e.id));
  return{project:object({project_id:{type:'string',const:id},text:text(180),source_ids:source}),attention:object({project_id:{type:'string',const:id},key,status:choice(['open','resolved']),text:text(80),source_ids:source}),change:object({project_id:{type:'string',const:id},key,kind:choice(['decision','blocker','milestone','completed','resolved']),text:text(80),source_ids:source})};
 };
 const note=(s:{session_id:string;project_id:string})=>{
  const source=refs([...allowed.values()].filter(e=>e.session_id===s.session_id).map(e=>e.id));
  const fact=(issue=false)=>object({key,text:text(100),source_ids:source,stage:stages,...(issue?{status:choice(['open','resolved'])}:{})});
  return object({session_id:{type:'string',const:s.session_id},summary:text(150),source_ids:source,memory:object({current_task:{anyOf:[fact(),{type:'null'}]},latest_results:array(fact(),1),open_questions:array(fact(true),2)})});
 };
 const variants=(items:Schema[]):Schema=>items.length===1?items[0]:{anyOf:items};
 return object({projects:array(variants(projects.map(id=>projectSchema(id).project)),projects.length,1),attention:array(variants(projects.map(id=>projectSchema(id).attention)),8),changes:array(variants(projects.map(id=>projectSchema(id).change)),8),sessions:array(variants(sessions.map(note)),sessions.length,1)});
}
