import {newSession} from "./src/adapters/common.ts";
import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
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

test('local pause overrides stale active SQLite rows before per-conversation deduplication',()=>{
 const home=mkdtempSync(join(tmpdir(),'ac-schedule-config-'));
 mkdirSync(join(home,'.codex/sqlite'),{recursive:true});
 const path=join(home,'.codex/sqlite/codex-dev.db'),db=new Database(path),now=Date.now();
 db.exec('CREATE TABLE automations(id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,kind TEXT,target_thread_id TEXT,updated_at INTEGER);CREATE TABLE automation_runs(thread_id TEXT,automation_id TEXT,created_at INTEGER)');
 const put=(id:string,kind:string,thread:string|null,next:number,status='ACTIVE')=>db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?)').run(id,id,status,next,null,kind,thread,now);
 const config=(id:string,body:string)=>{const dir=join(home,'.codex/automations',id);mkdirSync(dir,{recursive:true});const file=join(dir,'automation.toml');writeFileSync(file,body);return file;};
 put('paused-heartbeat','heartbeat','thread',now-60000);
 put('next-active','heartbeat','thread',now+90000);
 put('paused-cron','cron',null,now-30000);
 put('legacy','cron',null,now+120000);
 put('db-paused','heartbeat','other',now+1000,'PAUSED');
 const paused=config('paused-heartbeat','id = "paused-heartbeat"\nstatus = "PAUSED"\nprompt = "PRIVATE CONFIG CONTENT"\n');
 config('paused-cron','id = "paused-cron"\nstatus = "PAUSED"\n');
 config('next-active',`id = "next-active"\nprompt = '''\nstatus = "PAUSED"\n'''\nstatus = "ACTIVE"\n`);
 config('db-paused','id = "db-paused"\nstatus = "ACTIVE"\n');
 db.close();
 try{
  const original=readFileSync(paused),value=new ScheduleReader(home).current(now);
  expect(value.status).toBe('ready');
  expect(value.tasks.map(t=>t.id)).toEqual(['codex:automation:next-active','codex:automation:legacy']);
  expect(value.tasks[0]?.next_run_at).toBe(new Date(now+90000).toISOString());
  expect(JSON.stringify(value)).not.toContain('PRIVATE CONFIG CONTENT');
  expect(readFileSync(paused)).toEqual(original);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('pause and resume are observed on refresh without changing the original SQLite row',()=>{
 const home=mkdtempSync(join(tmpdir(),'ac-schedule-transition-'));
 mkdirSync(join(home,'.codex/sqlite'),{recursive:true});mkdirSync(join(home,'.codex/automations/task'),{recursive:true});
 const path=join(home,'.codex/sqlite/codex-dev.db'),file=join(home,'.codex/automations/task/automation.toml'),now=Date.now(),db=new Database(path);
 db.exec('CREATE TABLE automations(id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,kind TEXT,target_thread_id TEXT,updated_at INTEGER);CREATE TABLE automation_runs(thread_id TEXT,automation_id TEXT,created_at INTEGER)');
 db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?)').run('task','Task','ACTIVE',now-60000,null,'heartbeat','thread',now);db.close();
 const set=(status:string)=>writeFileSync(file,`id = "task"\nstatus = "${status}"\n`);
 try{
  const reader=new ScheduleReader(home);set('ACTIVE');expect(reader.current(now).tasks).toHaveLength(1);
  set('PAUSED');expect(reader.current(now+6000).tasks).toHaveLength(0);
  expect(reader.current(now+7000).tasks).toHaveLength(0);
  set('ACTIVE');expect(reader.current(now+12000).tasks).toHaveLength(1);
  const original=new Database(path,{readonly:true});try{expect(original.query<{status:string},[]>('SELECT status FROM automations').get()?.status).toBe('ACTIVE');}finally{original.close();}
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('SQLite read failure cannot restore a cached task explicitly paused in local config',()=>{
 const home=mkdtempSync(join(tmpdir(),'ac-schedule-failure-'));
 mkdirSync(join(home,'.codex/sqlite'),{recursive:true});mkdirSync(join(home,'.codex/automations/task'),{recursive:true});
 const path=join(home,'.codex/sqlite/codex-dev.db'),now=Date.now(),db=new Database(path);
 db.exec('CREATE TABLE automations(id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,kind TEXT,target_thread_id TEXT,updated_at INTEGER);CREATE TABLE automation_runs(thread_id TEXT,automation_id TEXT,created_at INTEGER)');
 db.query('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?)').run('task','Task','ACTIVE',now-60000,null,'heartbeat','thread',now);db.close();
 try{
  const reader=new ScheduleReader(home);expect(reader.current(now).tasks).toHaveLength(1);
  writeFileSync(join(home,'.codex/automations/task/automation.toml'),'id = "task"\nstatus = "PAUSED"\n');
  const broken=new Database(path);broken.exec('DROP TABLE automations');broken.close();
  const failed=reader.current(now+6000);expect(failed.status).toBe('failed');expect(failed.tasks).toHaveLength(0);
 }finally{rmSync(home,{recursive:true,force:true});}
});
