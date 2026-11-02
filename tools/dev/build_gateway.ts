import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const entry=resolve(process.argv[2]??"apps/gateway/src/main.ts");
const outfile=resolve(process.argv[3]??".build/agent-companion-gateway");
const result=await Bun.build({entrypoints:[entry],target:"bun",compile:{target:"bun-darwin-arm64",outfile},plugins:[{
  name:"libsql-native-for-fixed-macos-target",
  setup(build){
    build.onLoad({filter:/[/\\]node_modules[/\\]libsql[/\\]index\.js$/},args=>{
      const source=readFileSync(args.path,"utf8"),needle='return require(`@libsql/${target}`);';
      if(!source.includes(needle))throw new Error("LibSQL native loader changed; verify standalone packaging before updating dependencies.");
      return{contents:source.replace(needle,'return require("@libsql/darwin-arm64");'),loader:"js"};
    });
  },
}]});
if(!result.success){for(const log of result.logs)console.error(log);process.exit(1);}
console.log(outfile);
