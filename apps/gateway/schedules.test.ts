import {newSession} from "./src/adapters/common.ts";
import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ScheduleReader,projectScheduledConversations} from "./src/schedules.ts";
test('schedule reader keeps nearest active task per conversation, hides paused tasks and preserves actual scheduler times',()=>{
 const home=mkdtempSync(join(tmpdir(),'ac-schedules-'));mkdirSync(join(home,'.codex/sqlite'),{recursive:true});const path=join(home,'.codex/sqlite/codex-dev.db');const db=new Database(path);
 db.exec('CREATE TABLE automations(id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,kind TEXT,target_thread_id TEXT,updated_at INTEGER,prompt TEXT);CREATE TABLE automation_runs(thread_id TEXT,automation_id TEXT,created_at INTEGER)');
 const now=Date.now();db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,?)').run('real','Real title','ACTIVE',now+90000,null,'heartbeat','thread',1,'PRIVATE PROMPT MUST NOT LEAVE');db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,?)').run('paused','Paused','PAUSED',now+1000,null,'cron',null,2,'private');db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,?)').run('later','Later same thread','ACTIVE',now+190000,null,'heartbeat','thread',3,'private');db.close();
 try{const reader=new ScheduleReader(home),value=reader.current(now);expect(value.status).toBe('ready');expect(value.tasks).toHaveLength(1);expect(value.tasks[0]?.next_run_at).toBe(new Date(now+90000).toISOString());expect(value.tasks.some(t=>t.status==='paused')).toBe(false);expect(value.sources[1]?.quality).toBe('unavailable');expect(JSON.stringify(value)).not.toContain('PRIVATE PROMPT');
  const session=newSession("codex","thread","test");session.id="codex:rollout:thread";session.state="running";session.status_quality="confirmed";session.observation_health="fresh";
  const projected=projectScheduledConversations(value,[session]);expect(projected.tasks[0]?.conversation_state).toBe("running");expect(value.tasks[0]?.conversation_state).toBeUndefined();
  projectScheduledConversations(value,[]);expect(reader.current(now+1000).tasks[0]?.session_id).toBe("codex:rollout:thread");
  const advanced=new Database(path);advanced.exec("DELETE FROM automations WHERE id='real'");advanced.close();const later=reader.current(now+6000);
  expect(later.tasks[0]?.title).toBe("Later same thread");expect(projectScheduledConversations(later,[session]).tasks[0]?.conversation_state).toBe("running");
  session.observation_health="stale";expect(projectScheduledConversations(later,[session]).tasks[0]?.conversation_state).toBe("unknown");session.observation_health="fresh";
  session.state="completed";const finished=projectScheduledConversations(later,[session]);expect(finished.tasks[0]?.conversation_state).toBeNull();expect(finished.tasks[0]?.next_run_at).toBe(new Date(now+190000).toISOString());
  const corrupt=new Database(path);corrupt.exec('DROP TABLE automations');corrupt.close();const failed=reader.current(now+12000);expect(failed.status).toBe('failed');expect(failed.tasks[0]?.title).toBe('Later same thread');
 }finally{rmSync(home,{recursive:true,force:true});}
});
