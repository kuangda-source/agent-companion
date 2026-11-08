/** Provider-scoped budgets; never send Qwen extension parameters to other services. */
function bailianQwen(config:{base_url:string;model:string}){
 const host=new URL(config.base_url).hostname;
 const bailian=host==='dashscope.aliyuncs.com'||host==='dashscope-intl.aliyuncs.com'||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host);
 return bailian&&/^qwen3\.8(?:-|$)/.test(config.model);
}
export function assistantSessionBatch(config:{base_url:string;model:string}){return bailianQwen(config)?1:2;}
export function assistantProviderBody(config:{base_url:string;model:string},body:Record<string,unknown>,operation:"briefing"|"chat"="briefing",schema?:Record<string,unknown>):Record<string,unknown>{
 const common={...body,model:config.model,stream:false,max_tokens:10000};
 if(!bailianQwen(config))return common;
 const {reasoning_effort:_,...request}=common as typeof common & {reasoning_effort?:unknown};
 if(operation==='briefing'&&schema&&config.model.startsWith('qwen3.8-flash')){
  const {max_tokens:__,max_completion_tokens:___,...bounded}=request as typeof request & {max_completion_tokens?:unknown};
  return{...bounded,enable_thinking:false,preserve_thinking:false,response_format:{type:'json_schema',json_schema:{name:'companion_briefing',strict:true,schema}}};
 }
 return{...request,max_tokens:8000,enable_thinking:operation==="chat",...(operation==="chat"?{thinking_budget:1024}:{}),preserve_thinking:false};
}
