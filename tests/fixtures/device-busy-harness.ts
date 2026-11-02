/** Isolated fault-injection child process; never uses the user's runtime or model credentials. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MockState} from '../../apps/gateway/src/scenarios.ts';
import {SettingsStore} from '../../apps/gateway/src/settings.ts';
import {Assistant} from '../../apps/gateway/src/assistant.ts';
import {LanLink} from '../../apps/gateway/src/lan-link.ts';
import type {Collector} from '../../apps/gateway/src/state.ts';
const dir=process.argv[2]!;const mock=new MockState(false,0),settings=new SettingsStore();settings.update({device:{transport:'wifi'}});
const collector:Collector={current:()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),refresh:async()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),detail:id=>mock.detail(id)};
const assistant=new Assistant(collector,dir);let refreshCalls=0;
assistant.refresh=()=>{refreshCalls++;throw new Error('assistant_busy');};
const lan=new LanLink(dir,collector,settings,assistant,0);
const health=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({alive:true,refreshCalls,lan:lan.status(),theme:settings.current().appearance.theme})});
writeFileSync(join(dir,'ready.json'),JSON.stringify({lan:lan.status().url.replace(new URL(lan.status().url).hostname,'127.0.0.1'),health:String(health.url)}),{mode:0o600});
process.on('SIGTERM',()=>{lan.close();health.stop(true);assistant.close();process.exit(0);});
