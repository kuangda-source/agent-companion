#include "ac_device_decode.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>

static const cJSON *get(const cJSON *o,const char *k){return cJSON_GetObjectItemCaseSensitive(o,k);}
static const char *str(const cJSON *o){return cJSON_IsString(o)?o->valuestring:"";}
static double num(const cJSON *o){return cJSON_IsNumber(o)&&isfinite(o->valuedouble)&&o->valuedouble>=0?o->valuedouble:-1;}
static void text(char *out,size_t n,const cJSON *o){const char *s=str(o);size_t z=strlen(s);if(z>=n){z=n-1;while(z&&((unsigned char)s[z]&0xc0)==0x80)--z;}memcpy(out,s,z);out[z]=0;}
static int choice(const cJSON *o,const char *const *values,size_t n,int fallback){for(size_t i=0;i<n;++i)if(strcmp(str(o),values[i])==0)return i;return fallback;}
static int state(const cJSON *v){static const char *const a[]={"running","waiting_user","idle","completed","error","unknown","disconnected"};return choice(v,a,7,AC_STATE_UNKNOWN);}
static int quality(const cJSON *v){static const char *const a[]={"confirmed","estimated","unavailable","unknown"};return choice(v,a,4,AC_QUALITY_UNKNOWN);}
static int health(const cJSON *v){static const char *const a[]={"fresh","stale","disconnected","unknown"};return choice(v,a,4,AC_OBSERVATION_UNKNOWN);}
static int agent(const cJSON *v){static const char *const a[]={"codex","claude","deepseek","grok"};return choice(v,a,AC_AGENT_COUNT,-1);}
static ac_metric_t metric(const cJSON *o){int q=quality(get(o,"quality"));double n=num(get(o,"value"));return(ac_metric_t){.value=n>=0?n:0,.available=n>=0&&(q==AC_QUALITY_CONFIRMED||q==AC_QUALITY_ESTIMATED),.estimated=q==AC_QUALITY_ESTIMATED};}
static time_t timestamp(const cJSON *o){
    const char *s=str(o);int y,m,d,h,mi,se;if(strlen(s)<20||s[strlen(s)-1]!='Z'||sscanf(s,"%d-%d-%dT%d:%d:%d",&y,&m,&d,&h,&mi,&se)!=6||y<1970||y>2100||m<1||m>12||h<0||h>23||mi<0||mi>59||se<0||se>59)return 0;
    static const int md[]={31,28,31,30,31,30,31,31,30,31,30,31};int leap=(y%4==0&&(y%100!=0||y%400==0));if(d<1||d>md[m-1]+(m==2&&leap))return 0;
    y-=m<=2;int era=y/400,yoe=y-era*400,mp=m+(m>2?-3:9),doy=(153*mp+2)/5+d-1,doe=yoe*365+yoe/4-yoe/100+doy;
    return (time_t)((int64_t)(era*146097+doe-719468)*86400+h*3600+mi*60+se);
}
static bool whole(const cJSON *o,double min,double max){double n=num(o);return n>=min&&n<=max&&floor(n)==n;}
bool ac_device_display_command(const cJSON *o,ac_display_command_t *out){
    if(!cJSON_IsObject(o)||!whole(get(o,"revision"),1,9007199254740991.0)||!whole(get(o,"brightness_percent"),0,100)||!cJSON_IsBool(get(o,"screen_on")))return false;
    *out=(ac_display_command_t){.revision=(uint64_t)num(get(o,"revision")),.brightness_percent=(unsigned)num(get(o,"brightness_percent")),.screen_on=cJSON_IsTrue(get(o,"screen_on"))};return true;
}
static void session(ac_session_t *d,const cJSON *s){
    memset(d,0,sizeof(*d));text(d->id,sizeof(d->id),get(s,"id"));text(d->title,sizeof(d->title),get(s,"title"));text(d->project,sizeof(d->project),get(s,"project_name"));text(d->model,sizeof(d->model),get(s,"model"));
    text(d->status_source,sizeof(d->status_source),get(s,"status_source"));text(d->observed_at,sizeof(d->observed_at),get(s,"status_observed_at"));text(d->last_activity_at,sizeof(d->last_activity_at),get(s,"last_activity_at"));text(d->completion_id,sizeof(d->completion_id),get(s,"completion_event_id"));
    time_t at=timestamp(get(s,"completion_event_at")),now=time(NULL);d->completion_recent=at&&now-at>=-2&&now-at<=15;
    d->state=state(get(s,"state"));d->quality=quality(get(s,"status_quality"));d->health=health(get(s,"observation_health"));d->duration_seconds=num(get(s,"run_duration_seconds"));
    const cJSON *u=get(s,"usage");d->input=metric(get(u,"input_tokens"));d->output=metric(get(u,"output_tokens"));d->cache_ratio=metric(get(u,"cache_ratio"));d->context_ratio=metric(get(u,"context_ratio"));
    if(d->cache_ratio.value>1)d->cache_ratio.available=false;if(d->context_ratio.value>1)d->context_ratio.available=false;
}
static bool decimal(const cJSON *v,double *out){if(!cJSON_IsString(v)||!v->valuestring[0]||strlen(v->valuestring)>40)return false;char *end;double n=strtod(v->valuestring,&end);if(!isfinite(n)||*end)return false;*out=n;return true;}
static void balance(ac_balance_t *d,const cJSON *o){
    d->health=health(get(o,"health"));text(d->note,sizeof(d->note),get(o,"note"));const cJSON *w=NULL,*v;
    cJSON_ArrayForEach(v,get(o,"wallets")){const char *c=str(get(v,"currency"));if(strcmp(c,"CNY")==0||(!w&&strcmp(c,"USD")==0))w=v;}
    if(!w||!decimal(get(w,"total"),&d->total)||!decimal(get(w,"granted"),&d->granted)||!decimal(get(w,"topped_up"),&d->topped_up))return;
    time_t at=timestamp(get(o,"observed_at"));if(!at||at-time(NULL)>120)return;d->available=true;if(time(NULL)-at>300)d->health=AC_OBSERVATION_STALE;
    text(d->currency,sizeof(d->currency),get(w,"currency"));text(d->observed_at,sizeof(d->observed_at),get(o,"observed_at"));const cJSON *b=get(o,"budget");if(strcmp(str(get(b,"currency")),d->currency)==0&&num(get(b,"amount"))>0)d->budget=num(get(b,"amount"));
}
static bool statistics(ac_usage_stats_t *d,const cJSON *o){
    static const char *const statuses[]={"loading","ready","partial","failed"};int status=choice(get(o,"status"),statuses,4,-1);
    const cJSON *as=get(o,"agents"),*days=get(o,"days"),*v;if(status<0||!cJSON_IsArray(as)||(cJSON_GetArraySize(as)<1||cJSON_GetArraySize(as)>AC_VISIBLE_AGENT_LIMIT)||!cJSON_IsArray(days)||cJSON_GetArraySize(days)!=30)return false;
    d->loading=status==0;d->partial=status==2;d->failed=status==3;text(d->timezone,sizeof(d->timezone),get(o,"timezone"));text(d->observed_at,sizeof(d->observed_at),get(o,"generated_at"));unsigned seen=0;
    cJSON_ArrayForEach(v,as){int i=agent(get(v,"id"));if(i<0||(seen&(1u<<i))||!cJSON_IsBool(get(v,"available"))||!cJSON_IsBool(get(v,"partial")))return false;seen|=1u<<i;d->agent_order[d->agent_count++]=(ac_agent_id_t)i;d->available[i]=cJSON_IsTrue(get(v,"available"));d->agent_partial[i]=cJSON_IsTrue(get(v,"partial"));}
    char previous[11]="";cJSON_ArrayForEach(v,days){const char *date=str(get(v,"date"));if(strlen(date)!=10||strcmp(date,previous)<=0)return false;ac_usage_day_t *day=&d->days[d->day_count++];text(day->date,sizeof(day->date),get(v,"date"));memcpy(previous,day->date,11);
        const cJSON *counts=get(v,"tokens");static const char *const ids[]={"codex","claude","deepseek","grok"};for(int i=0;i<AC_AGENT_COUNT;++i){const cJSON *n=get(counts,ids[i]);if(!n||cJSON_IsNull(n))continue;if(!whole(n,0,9007199254740991.0))return false;day->tokens[i]=(ac_metric_t){.value=num(n),.available=d->available[i],.estimated=d->agent_partial[i]};}}
    return true;
}
bool ac_device_snapshot_checked(const cJSON *s,ac_snapshot_t *d,ac_decode_info_t *info){
    const cJSON *as=get(s,"agents"),*ss=get(s,"sessions"),*v;time_t at=timestamp(get(s,"generated_at"));
    if(info)*info=(ac_decode_info_t){.reason="snapshot_shape",.source_age_seconds=at?(int64_t)difftime(time(NULL),at):0};
    if(num(get(s,"schema_version"))!=1||strcmp(str(get(s,"data_source")),"live")||!whole(get(s,"seq"),1,9007199254740991.0)||!cJSON_IsArray(as)||(cJSON_GetArraySize(as)<1||cJSON_GetArraySize(as)>AC_VISIBLE_AGENT_LIMIT)||!cJSON_IsArray(ss)||cJSON_GetArraySize(ss)>15)return false;
    if(info)info->reason="source_time";if(!at||fabs(difftime(time(NULL),at))>10)return false;
    memset(d,0,sizeof(*d));d->seq=(uint64_t)num(get(s,"seq"));text(d->generated_at,sizeof(d->generated_at),get(s,"generated_at"));if(info)info->reason="token_statistics";if(!statistics(&d->token_statistics,get(s,"token_statistics")))return false;unsigned seen=0;
    for(int i=0;i<AC_AGENT_COUNT;++i){d->agents[i].state=AC_STATE_UNKNOWN;d->agents[i].quality=AC_QUALITY_UNKNOWN;}
    cJSON_ArrayForEach(v,as){if(info)info->reason="agent_identity";int i=agent(get(v,"id"));if(i<0||(seen&(1u<<i)))return false;seen|=1u<<i;d->agent_order[d->agent_count++]=(ac_agent_id_t)i;ac_agent_t *a=&d->agents[i];
        if(info)info->reason="agent_counts";
        if(!whole(get(v,"session_count"),0,1000000)||!whole(get(v,"running_count"),0,1000000)||!whole(get(v,"waiting_count"),0,1000000))return false;
        a->state=state(get(v,"state"));a->quality=quality(get(v,"status_quality"));a->health=health(get(v,"observation_health"));a->total=num(get(v,"session_count"));a->running=num(get(v,"running_count"));a->waiting=num(get(v,"waiting_count"));text(a->note,sizeof(a->note),get(v,"note"));balance(&a->balance,get(v,"balance"));
        const cJSON *q;cJSON_ArrayForEach(q,get(v,"quota")){ac_metric_t used=metric(get(q,"used_ratio"));const cJSON *mins=get(q,"window_minutes");if(!used.available||used.value>1||!whole(mins,1,1000000))continue;if(!a->quota.available||used.value>a->quota.value||(used.value==a->quota.value&&num(mins)<a->quota_minutes)){a->quota=used;a->quota_minutes=num(mins);a->quota_stale=!strcmp(str(get(q,"health")),"stale");}}}
    if(info)info->reason="session_identity";
    cJSON_ArrayForEach(v,ss){int i=agent(get(v,"agent_id"));if(i<0||!(seen&(1u<<i))||!str(get(v,"id"))[0]||!str(get(v,"title"))[0])return false;ac_agent_t *a=&d->agents[i];if(a->session_count<5)session(&a->sessions[a->session_count++],v);}
    const cJSON *scheduled=get(s,"scheduled_tasks"),*entry;
    if(cJSON_IsObject(scheduled)&&num(get(scheduled,"as_of_epoch"))>=1700000000&&num(get(scheduled,"as_of_epoch"))<=4102444800)d->schedules.as_of_epoch=(int64_t)num(get(scheduled,"as_of_epoch"));
    cJSON_ArrayForEach(entry,get(scheduled,"sources")){int i=agent(get(entry,"agent_id"));if(i>=0){d->schedules.agents[i].available=!strcmp(str(get(entry,"quality")),"confirmed");d->schedules.agents[i].fresh=!strcmp(str(get(scheduled,"status")),"ready");}}
    cJSON_ArrayForEach(entry,get(scheduled,"tasks")){if(strcmp(str(get(entry,"status")),"active"))continue;int i=agent(get(entry,"agent_id"));if(i<0||d->schedules.agents[i].count>=AC_SCHEDULE_LIMIT)continue;ac_schedule_t *task=&d->schedules.agents[i].tasks[d->schedules.agents[i].count++];text(task->title,sizeof(task->title),get(entry,"title"));text(task->session_id,sizeof(task->session_id),get(entry,"session_id"));text(task->thread_title,sizeof(task->thread_title),get(entry,"thread_title"));task->status=!strcmp(str(get(entry,"status")),"active")?1:!strcmp(str(get(entry,"status")),"paused")?2:0;task->activity=!strcmp(str(get(entry,"conversation_state")),"running")?AC_SCHEDULE_RUNNING:!strcmp(str(get(entry,"conversation_state")),"waiting_user")?AC_SCHEDULE_WAITING:!strcmp(str(get(entry,"conversation_state")),"error")?AC_SCHEDULE_ERROR:!strcmp(str(get(entry,"conversation_state")),"unknown")?AC_SCHEDULE_UNCONFIRMED:AC_SCHEDULE_PLANNED;task->heartbeat=!strcmp(str(get(entry,"kind")),"heartbeat");task->next_epoch=timestamp(get(entry,"next_run_at"));task->last_epoch=timestamp(get(entry,"last_run_at"));}
    if(info)info->reason=NULL;
    return true;
}
bool ac_device_snapshot(const cJSON *s,ac_snapshot_t *d){return ac_device_snapshot_checked(s,d,NULL);}
bool ac_device_assistant(const cJSON *s,ac_assistant_feed_t *d){
    static const char *const statuses[]={"unconfigured","ready","updating","failed","offline"};int status=choice(get(s,"status"),statuses,5,-1);const cJSON *ms=get(s,"messages"),*v;
    if(num(get(s,"schema_version"))!=1||strcmp(str(get(s,"data_source")),"live")||status<0||!whole(get(s,"revision"),0,9007199254740991.0)||!cJSON_IsArray(ms)||cJSON_GetArraySize(ms)>8)return false;
    memset(d,0,sizeof(*d));d->status=status;d->revision=num(get(s,"revision"));cJSON_ArrayForEach(v,ms){time_t at=timestamp(get(v,"created_at"));const char *role=str(get(v,"role")),*kind=str(get(v,"kind"));
        if(!str(get(v,"id"))[0]||strlen(str(get(v,"id")))>=96||!str(get(v,"text"))[0]||!at||(strcmp(role,"user")&&strcmp(role,"assistant"))||(strcmp(kind,"briefing")&&strcmp(kind,"chat")))return false;
        ac_assistant_message_t *m=&d->messages[d->message_count++];text(m->id,sizeof(m->id),get(v,"id"));text(m->text,sizeof(m->text),get(v,"text"));struct tm tm;localtime_r(&at,&tm);strftime(m->time,sizeof(m->time),"%H:%M",&tm);snprintf(m->source,sizeof(m->source),"%s",!strcmp(role,"user")?"你":!strcmp(kind,"briefing")?"AI 助手 · 项目简报":"AI 助手 · 对话回复");}
    return true;
}
bool ac_device_detail(const cJSON *s,ac_session_detail_t *d){
    if(!str(get(s,"id"))[0]||!str(get(s,"title"))[0])return false;memset(d,0,sizeof(*d));session(&d->session,s);d->truncated=cJSON_IsTrue(get(s,"transcript_truncated"));const cJSON *v;
    cJSON_ArrayForEach(v,get(s,"messages")){if(d->message_count>=12){d->truncated=true;break;}const char *r=str(get(v,"role"));if(strcmp(r,"user")&&strcmp(r,"assistant"))continue;ac_message_t *m=&d->messages[d->message_count++];m->assistant=strcmp(r,"assistant")==0;text(m->id,sizeof(m->id),get(v,"id"));text(m->text,sizeof(m->text),get(v,"text"));if(strlen(str(get(v,"text")))>=sizeof(m->text))d->truncated=true;}return true;
}

/* Sequence is scoped to a Gateway boot; only freshly authenticated full views enter UI. */
bool ac_device_remote_frame(const cJSON *packet,const char *previous_boot,uint64_t last_id,int64_t now){
    const cJSON *id=cJSON_GetObjectItemCaseSensitive(packet,"id"),*clock=cJSON_GetObjectItemCaseSensitive(packet,"sent_at"),*boot=cJSON_GetObjectItemCaseSensitive(packet,"gateway_boot_id");
    if(!cJSON_IsNumber(id)||!isfinite(id->valuedouble)||id->valuedouble<1||id->valuedouble>9007199254740991.0||floor(id->valuedouble)!=id->valuedouble||!cJSON_IsNumber(clock)||!isfinite(clock->valuedouble)||fabs((double)now-clock->valuedouble)>15||!cJSON_IsString(boot)||strlen(boot->valuestring)!=36)return false;
    for(int i=0;i<36;++i){char c=boot->valuestring[i];if(i==8||i==13||i==18||i==23){if(c!='-')return false;}else if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;}
    return strcmp(previous_boot,boot->valuestring)||(uint64_t)id->valuedouble>last_id;
}
