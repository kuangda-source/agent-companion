/** Provider-scoped budgets; never send Qwen extension parameters to other services. */
export function assistantProviderBody(config:{base_url:string;model:string},body:Record<string,unknown>,operation:"briefing"|"chat"="briefing"){
 const common={...body,model:config.model,stream:false,max_tokens:10000};
 const host=new URL(config.base_url).hostname;
 const bailian=host==='dashscope.aliyuncs.com'||host==='dashscope-intl.aliyuncs.com'||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host);
 if(!bailian||!/^qwen3\.8(?:-|$)/.test(config.model))return common;
 const {reasoning_effort:_,...request}=common as typeof common & {reasoning_effort?:unknown};
 return{...request,max_tokens:8000,enable_thinking:operation==="chat",...(operation==="chat"?{thinking_budget:1024}:{}),preserve_thinking:false};
}
