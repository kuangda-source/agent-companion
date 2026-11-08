/** Local-only credential editing. Responses contain presence flags, never values. */
import {chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
export class CredentialStore {
  constructor(private runtime:string, private changed:(service:string)=>void=()=>{}) {}
  private file(service:string) {
    if(service!=="assistant"&&service!=="deepseek"&&service!=="tts")throw new Error("invalid_service");
    return join(this.runtime,"secrets",service+"-api-key");
  }
  status(){return {assistant:existsSync(this.file("assistant")),deepseek:existsSync(this.file("deepseek"))};}
  async response(request:Request){
    const headers={"Cache-Control":"no-store"};
    if(request.method==="GET")return Response.json(this.status(),{headers});
    if(request.method!=="PATCH")return Response.json({error:"method_not_allowed"},{status:405,headers});
    try{
      if(!request.headers.get("content-type")?.startsWith("application/json"))throw new Error("json_required");
      const raw=await request.text();if(raw.length>2048)throw new Error("invalid_credential");
      const value:unknown=JSON.parse(raw);
      if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_credential");
      const v=value as Record<string,unknown>;
      if(Object.keys(v).some(k=>!["service","key"].includes(k))||typeof v.service!=="string")throw new Error("invalid_credential");
      const file=this.file(v.service);
      if(v.key===null)rmSync(file,{force:true});
      else{
        if(typeof v.key!=="string"||!/^[\x21-\x7e]{8,512}$/.test(v.key)||(v.service==="deepseek"&&!/^sk-[A-Za-z0-9_-]{16,200}$/.test(v.key)))throw new Error("invalid_credential");
        const dir=join(this.runtime,"secrets");mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
        writeFileSync(file+".tmp",v.key,{mode:0o600});chmodSync(file+".tmp",0o600);renameSync(file+".tmp",file);
      }
      this.changed(v.service);return Response.json(this.status(),{headers});
    }catch{return Response.json({error:"invalid_credential"},{status:400,headers});}
  }
}
