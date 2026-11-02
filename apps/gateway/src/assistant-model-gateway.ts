import type { AssistantModelGatewayLease,AssistantTask } from "./assistant-runtime.ts";
import { object,array } from "./adapters/common.ts";

interface Lease {task:Readonly<AssistantTask>;signal:AbortSignal;expires:number;busy:boolean;used:boolean}
type Provider=(body:Record<string,unknown>,signal:AbortSignal,operationId:string)=>Promise<Record<string,unknown>>;
/** Private SDK transport. Provider credentials and accounting stay in Assistant. */
export class AssistantModelGateway {
  private server:ReturnType<typeof Bun.serve>|null=null;
  private leases=new Map<string,Lease>();
  constructor(private provider:Provider){}
  open(task:Readonly<AssistantTask>,signal:AbortSignal):AssistantModelGatewayLease {
    if(signal.aborted)throw new Error("assistant_cancelled");
    this.server??=Bun.serve({hostname:"127.0.0.1",port:0,maxRequestBodySize:512*1024,fetch:request=>this.response(request)});
    const token=crypto.randomUUID()+crypto.randomUUID(),expires=Date.now()+95_000;
    this.leases.set(token,{task,signal,expires,busy:false,used:false});
    const close=async()=>{this.leases.delete(token);signal.removeEventListener("abort",abort);};
    const abort=()=>{void close();};signal.addEventListener("abort",abort,{once:true});
    return{operation_id:task.operation_id,base_url:this.server.url.toString()+"v1",bearer_token:token,expires_at:new Date(expires).toISOString(),close};
  }
  private async response(request:Request):Promise<Response> {
    const headers={"Cache-Control":"no-store"};
    const token=(request.headers.get("Authorization")??"").replace(/^Bearer /,""),lease=this.leases.get(token);
    if(!lease||lease.signal.aborted||lease.expires<Date.now())return Response.json({error:{message:"model_scope_expired"}},{status:401,headers});
    if(request.method!=="POST"||new URL(request.url).pathname!=="/v1/chat/completions"||request.headers.has("Origin"))return Response.json({error:{message:"unsupported_model_route"}},{status:403,headers});
    if(lease.busy)return Response.json({error:{message:"model_scope_busy"}},{status:409,headers});
    if(lease.used)return Response.json({error:{message:"assistant_model_scope_used"}},{status:400,headers});
    lease.busy=true;
    try {
      const body=object(await request.json());
      if(body.model!==lease.task.model?.id||!Array.isArray(body.messages))throw new Error("invalid_model_request");
      if(body.tools!==undefined && (!Array.isArray(body.tools)||body.tools.length))throw new Error("assistant_model_tools_disabled");
      lease.used=true;
      const response=await this.provider({...body,stream:false,max_tokens:10000},lease.signal,lease.task.operation_id);
      if(lease.signal.aborted||!this.leases.has(token))throw new Error("assistant_cancelled");
      if(body.stream!==true)return Response.json(response,{headers});
      // Current provider path remains non-streaming. The SDK consumes an SSE
      // envelope after completion; this does not claim end-to-end live streaming.
      const choice=object(array(response.choices)[0]),message=object(choice.message),id=String(response.id??crypto.randomUUID()),model=String(response.model??body.model),created=Number(response.created??Math.floor(Date.now()/1000));
      const chunks=[{id,model,created,object:"chat.completion.chunk",choices:[{index:0,delta:{role:"assistant",content:message.content??""},finish_reason:null}]},
        {id,model,created,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:response.usage}];
      return new Response(chunks.map(c=>"data: "+JSON.stringify(c)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{...headers,"Content-Type":"text/event-stream"}});
    }catch(error){const code=error instanceof Error?error.message:"assistant_model_failed";const safe=/^(provider_http_\d+|daily_request_limit|assistant_cancelled|invalid_model_request|assistant_model_tools_disabled)$/.test(code)?code:"assistant_model_failed";
      // This private single-attempt endpoint must not trigger SDK transport retries.
      // The application exposes the original error code and owns any user retry.
      return Response.json({error:{message:safe}},{status:400,headers});
    }finally{lease.busy=false;}
  }
  close(){this.leases.clear();this.server?.stop(true);this.server=null;}
}
