// Synthetic subprocess checks the exact outbound method boundary and records cleanup evidence.
const file=process.argv[2],mode=process.argv[3];let buffer="";const methods:string[]=[];
if(mode==="hang"){await Bun.write(file,JSON.stringify({pid:process.pid}));await Bun.sleep(60000);}
for await (const chunk of Bun.stdin.stream()){
 buffer+=new TextDecoder().decode(chunk);let end:number;
 while((end=buffer.indexOf("\n"))>=0){
  const request=JSON.parse(buffer.slice(0,end)) as {id?:number;method:string};buffer=buffer.slice(end+1);methods.push(request.method);
  if(request.method==="initialize")console.log(JSON.stringify({id:request.id,result:{userAgent:"synthetic"}}));
  else if(request.method==="initialized")continue;
  else if(request.method==="account/rateLimits/read"){
   await Bun.write(file,JSON.stringify({pid:process.pid,methods}));
   console.log(JSON.stringify({id:request.id,result:{rateLimitsByLimitId:{codex:{limitId:"codex",primary:{usedPercent:81,windowDurationMins:10080,resetsAt:1900000000},secondary:null},other:{limitId:"other",primary:{usedPercent:99,windowDurationMins:300}}}}}));
   await Bun.sleep(60000);
  }else process.exit(42);
 }
}
