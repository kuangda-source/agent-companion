#include "ac_device_decode.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static ac_snapshot_t snapshot;
static ac_assistant_feed_t feed;
static ac_session_detail_t detail;
static void set(cJSON *o,const char *key,cJSON *v){cJSON_DeleteItemFromObject(o,key);cJSON_AddItemToObject(o,key,v);}
int main(int argc,char **argv){
    assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);char *s=malloc(n+1);assert(s);assert(fread(s,1,n,f)==(size_t)n);fclose(f);s[n]=0;cJSON *base=cJSON_Parse(s);free(s);assert(base);
    ac_display_command_t power={0};cJSON *power_json=cJSON_Parse("{\"revision\":1,\"brightness_percent\":60,\"screen_on\":true}");assert(ac_device_display_command(power_json,&power));assert(power.brightness_percent==60&&power.screen_on);
    set(power_json,"brightness_percent",cJSON_CreateNumber(101));assert(!ac_device_display_command(power_json,&power));assert(power.brightness_percent==60);
    set(power_json,"brightness_percent",cJSON_CreateNumber(0));set(power_json,"screen_on",cJSON_CreateFalse());assert(ac_device_display_command(power_json,&power));assert(!power.screen_on&&power.brightness_percent==0);
    set(power_json,"screen_on",cJSON_CreateNumber(0));assert(!ac_device_display_command(power_json,&power));cJSON_Delete(power_json);
    time_t now=time(NULL);struct tm tm;gmtime_r(&now,&tm);char at[32];strftime(at,sizeof(at),"%Y-%m-%dT%H:%M:%SZ",&tm);set(base,"generated_at",cJSON_CreateString(at));set(base,"data_source",cJSON_CreateString("live"));assert(ac_device_snapshot(base,&snapshot));assert(snapshot.seq>0);
    assert(snapshot.generated_epoch==(int64_t)now);
    cJSON *quota_fixture=cJSON_Duplicate(base,1),*qa=cJSON_GetArrayItem(cJSON_GetObjectItem(quota_fixture,"agents"),0);
    cJSON *windows=cJSON_Parse("[{\"window_minutes\":300,\"used_ratio\":{\"value\":0.1,\"quality\":\"confirmed\"},\"resets_at\":\"2027-01-15T08:01:30Z\"},{\"window_minutes\":10080,\"used_ratio\":{\"value\":0.64,\"quality\":\"confirmed\"},\"resets_at\":\"2027-01-16T08:01:30.000Z\"}]");set(qa,"quota",windows);
    assert(ac_device_snapshot(quota_fixture,&snapshot));assert(snapshot.agents[0].quota_minutes==10080&&snapshot.agents[0].quota_reset_epoch==1800086490);
    cJSON *weekly=cJSON_GetArrayItem(windows,1);set(weekly,"resets_at",cJSON_CreateNull());assert(ac_device_snapshot(quota_fixture,&snapshot));assert(snapshot.agents[0].quota_reset_epoch==0);
    set(weekly,"resets_at",cJSON_CreateString("not-a-date"));assert(ac_device_snapshot(quota_fixture,&snapshot));assert(snapshot.agents[0].quota_reset_epoch==0);cJSON_Delete(quota_fixture);
    cJSON *schedule_fixture=cJSON_Duplicate(base,1);
    cJSON *schedules=cJSON_Parse("{\"status\":\"ready\",\"as_of_epoch\":1800000000,\"sources\":[{\"agent_id\":\"codex\",\"quality\":\"confirmed\"}],\"tasks\":[{\"agent_id\":\"codex\",\"title\":\"Next run\",\"thread_title\":\"Conversation title\",\"status\":\"active\",\"next_run_at\":\"2027-01-15T08:01:30Z\"},{\"agent_id\":\"codex\",\"title\":\"Paused\",\"status\":\"paused\"}]}");assert(schedules);set(schedule_fixture,"scheduled_tasks",schedules);
    assert(ac_device_snapshot(schedule_fixture,&snapshot));assert(snapshot.schedules.agents[0].count==1&&snapshot.schedules.agents[0].fresh&&snapshot.schedules.agents[0].available);assert(!strcmp(snapshot.schedules.agents[0].tasks[0].thread_title,"Conversation title"));assert(snapshot.schedules.agents[0].tasks[0].next_epoch==1800000090);
    cJSON *scheduled_task=cJSON_GetArrayItem(cJSON_GetObjectItem(schedules,"tasks"),0);set(scheduled_task,"conversation_state",cJSON_CreateString("running"));assert(ac_device_snapshot(schedule_fixture,&snapshot));assert(snapshot.schedules.agents[0].tasks[0].activity==AC_SCHEDULE_RUNNING);
    set(schedules,"status",cJSON_CreateString("failed"));assert(ac_device_snapshot(schedule_fixture,&snapshot));assert(!snapshot.schedules.agents[0].fresh&&snapshot.schedules.agents[0].count==1);cJSON_Delete(schedule_fixture);
    cJSON *o=cJSON_Duplicate(base,1);set(o,"data_source",cJSON_CreateString("mock"));assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);set(o,"generated_at",cJSON_CreateString("2020-01-01T00:00:00Z"));ac_decode_info_t info;assert(!ac_device_snapshot_checked(o,&snapshot,&info));assert(!strcmp(info.reason,"source_time")&&info.source_age_seconds>10);cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);set(o,"generated_at",cJSON_CreateString("2026-02-30T00:00:00Z"));assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);set(o,"seq",cJSON_CreateNumber(1.5));assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);cJSON *as=cJSON_GetObjectItem(o,"agents");set(cJSON_GetArrayItem(as,1),"id",cJSON_CreateString("codex"));assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);set(o,"token_statistics",cJSON_CreateNull());assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);cJSON *ss=cJSON_GetObjectItem(o,"sessions");while(cJSON_GetArraySize(ss)<=15)cJSON_AddItemToArray(ss,cJSON_Duplicate(cJSON_GetArrayItem(ss,0),1));assert(!ac_device_snapshot(o,&snapshot));cJSON_Delete(o);
    o=cJSON_Duplicate(base,1);char chinese[1501];for(int i=0;i<500;++i)memcpy(chinese+3*i,"测",3);chinese[1500]=0;set(cJSON_GetArrayItem(cJSON_GetObjectItem(o,"sessions"),0),"title",cJSON_CreateString(chinese));assert(ac_device_snapshot(o,&snapshot));assert(strlen(snapshot.agents[0].sessions[0].title)%3==0);cJSON_Delete(o);
    o=cJSON_CreateObject();cJSON_AddNumberToObject(o,"schema_version",1);cJSON_AddStringToObject(o,"data_source","live");cJSON_AddNumberToObject(o,"revision",1);cJSON_AddStringToObject(o,"status","ready");cJSON *ms=cJSON_AddArrayToObject(o,"messages"),*m=cJSON_CreateObject();cJSON_AddStringToObject(m,"id","test");cJSON_AddStringToObject(m,"text","中文测试");cJSON_AddStringToObject(m,"role","assistant");cJSON_AddStringToObject(m,"kind","briefing");cJSON_AddStringToObject(m,"created_at",at);cJSON_AddItemToArray(ms,m);assert(ac_device_assistant(o,&feed));assert(feed.message_count==1&&!strcmp(feed.messages[0].text,"中文测试"));
    set(m,"role",cJSON_CreateString("tool"));assert(!ac_device_assistant(o,&feed));set(m,"role",cJSON_CreateString("assistant"));while(cJSON_GetArraySize(ms)<=8)cJSON_AddItemToArray(ms,cJSON_Duplicate(m,1));assert(!ac_device_assistant(o,&feed));cJSON_Delete(o);
    cJSON *wire=cJSON_CreateObject();cJSON_AddNumberToObject(wire,"id",5);cJSON_AddNumberToObject(wire,"sent_at",now);cJSON_AddStringToObject(wire,"gateway_boot_id","11111111-1111-1111-1111-111111111111");
    assert(ac_device_remote_frame(wire,"",0,now));assert(!ac_device_remote_frame(wire,"11111111-1111-1111-1111-111111111111",5,now));assert(ac_device_remote_frame(wire,"22222222-2222-2222-2222-222222222222",100,now));assert(!ac_device_remote_frame(wire,"",0,now+20));
    set(wire,"id",cJSON_CreateNumber(1.5));assert(!ac_device_remote_frame(wire,"",0,now));set(wire,"id",cJSON_CreateNumber(6));set(wire,"gateway_boot_id",cJSON_CreateString("11111111-1111-1111-1111-11111111111x"));assert(!ac_device_remote_frame(wire,"",0,now));cJSON_Delete(wire);
    assert(!ac_device_detail(NULL,&detail));cJSON_Delete(base);puts("PASS device decoder: live fixture, freshness, invalid dates, sequence, duplicate agent, missing stats, bounds, UTF8, assistant roles/counts, WSS boot/sequence/freshness");return 0;
}
