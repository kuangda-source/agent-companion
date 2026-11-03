#include "ac_model.h"
#include <stdio.h>
#include <string.h>
static bool busy(const ac_session_t *s){return s->state==AC_STATE_RUNNING||s->state==AC_STATE_WAITING||s->state==AC_STATE_ERROR;}
static bool scheduled_visible(const ac_schedule_t *t){return t->status==1&&(t->next_epoch>0||t->activity!=AC_SCHEDULE_PLANNED);}
static bool active_session(const ac_agent_t *a,const ac_schedule_t *t){
    if(!t->session_id[0])return false;
    for(size_t i=0;i<a->session_count;i++)if(!strcmp(a->sessions[i].id,t->session_id)&&busy(&a->sessions[i]))return true;
    return false;
}
static bool planned_session(const ac_agent_schedule_t *tasks,const ac_session_t *s){
    if(!tasks||!s->id[0])return false;
    for(size_t i=0;i<tasks->count;i++)if(scheduled_visible(&tasks->tasks[i])&&!strcmp(tasks->tasks[i].session_id,s->id))return true;
    return false;
}
size_t ac_activity_order(const ac_agent_t *a,const ac_agent_schedule_t *tasks,ac_activity_item_t *out,size_t capacity){
    size_t count=0;
    for(size_t i=0;i<a->session_count&&count<capacity;i++)if(busy(&a->sessions[i]))out[count++]=(ac_activity_item_t){false,i};
    /* Active linked conversations outside the five captured rows must still beat future plans. */
    for(size_t i=0;tasks&&i<tasks->count&&count<capacity;i++)if(scheduled_visible(&tasks->tasks[i])&&tasks->tasks[i].activity!=AC_SCHEDULE_PLANNED&&!active_session(a,&tasks->tasks[i]))out[count++]=(ac_activity_item_t){true,i};
    for(size_t i=0;tasks&&i<tasks->count&&count<capacity;i++)if(scheduled_visible(&tasks->tasks[i])&&tasks->tasks[i].activity==AC_SCHEDULE_PLANNED&&!active_session(a,&tasks->tasks[i]))out[count++]=(ac_activity_item_t){true,i};
    for(size_t i=0;i<a->session_count&&count<capacity;i++)if(!busy(&a->sessions[i])&&!planned_session(tasks,&a->sessions[i]))out[count++]=(ac_activity_item_t){false,i};
    return count;
}
void ac_schedule_countdown(char *out,size_t capacity,const ac_schedule_t *t,int64_t now,bool fresh){
    if(!fresh||now<1700000000){snprintf(out,capacity,"待更新");return;}
    if(t->activity){static const char *labels[]={"","运行中","等待操作","异常","运行状态待确认"};snprintf(out,capacity,"%s",labels[t->activity<=AC_SCHEDULE_UNCONFIRMED?t->activity:AC_SCHEDULE_UNCONFIRMED]);return;}
    if(t->status==2){snprintf(out,capacity,"已暂停");return;}
    if(t->status!=1||t->next_epoch<=0){snprintf(out,capacity,"未排期");return;}
    long long left=t->next_epoch-now;
    if(left<=0)snprintf(out,capacity,"等待调度");
    else if(left>=86400)snprintf(out,capacity,"还剩%lld天%lld小时",left/86400,left%86400/3600);
    else if(left>=3600)snprintf(out,capacity,"还剩%lld小时%lld分",left/3600,left%3600/60);
    else if(left>=60)snprintf(out,capacity,"还剩%lld分%lld秒",left/60,left%60);
    else snprintf(out,capacity,"还剩%lld秒",left);
}
#include <math.h>

ac_metric_t ac_usage_total(const ac_usage_stats_t *stats,int agent,unsigned days)
{
    ac_metric_t total={0};
    if(agent < -1 || agent>=AC_AGENT_COUNT || days==0) return total;
    size_t start=stats->day_count>days?stats->day_count-days:0;
    for(int a=0;a<AC_AGENT_COUNT;++a) {
        if(agent>=0 && a!=agent) continue;
        if(!stats->available[a]) { total.estimated=true; continue; }
        total.available=true;
        total.estimated |= stats->agent_partial[a] || stats->loading || stats->failed;
        for(size_t i=start;i<stats->day_count && i<AC_USAGE_DAYS;++i)
            if(stats->days[i].tokens[a].available) total.value+=stats->days[i].tokens[a].value;
    }
    if(!isfinite(total.value)) total.available=false;
    return total;
}
#include <string.h>
#include <math.h>

ac_quota_view_t ac_quota_view(ac_metric_t used, ac_observation_health_t health)
{
    ac_quota_view_t result={0};
    if(!used.available || health!=AC_OBSERVATION_FRESH || !isfinite(used.value) || used.value<0 || used.value>1) return result;
    result.available=true;
    result.remaining_ratio=1.0-used.value;
    result.band=result.remaining_ratio>=2.0/3.0?AC_QUOTA_GREEN:result.remaining_ratio>=1.0/3.0?AC_QUOTA_YELLOW:AC_QUOTA_RED;
    return result;
}

ac_pet_expression_t ac_expression_for(ac_state_t state, ac_data_quality_t quality,
                                    ac_observation_health_t health)
{
    if(health == AC_OBSERVATION_DISCONNECTED) return AC_PET_OFFLINE;
    if(health != AC_OBSERVATION_FRESH || quality != AC_QUALITY_CONFIRMED) return AC_PET_UNKNOWN;
    switch(state) {
        case AC_STATE_RUNNING: return AC_PET_RUNNING;
        case AC_STATE_WAITING: return AC_PET_WAITING;
        case AC_STATE_ERROR: return AC_PET_ERROR;
        case AC_STATE_DISCONNECTED: return AC_PET_OFFLINE;
        case AC_STATE_IDLE: case AC_STATE_COMPLETED: return AC_PET_IDLE;
        default: return AC_PET_UNKNOWN;
    }
}

const char *ac_completion_transition(const ac_agent_t *before, const ac_agent_t *after)
{
    if(before->health != AC_OBSERVATION_FRESH || after->health != AC_OBSERVATION_FRESH) return NULL;
    for(size_t i = 0; i < after->session_count; ++i) {
        const ac_session_t *s = &after->sessions[i];
        if(s->health != AC_OBSERVATION_FRESH || s->quality != AC_QUALITY_CONFIRMED || !s->completion_recent || strlen(s->completion_id) != 36) continue;
        for(size_t j = 0; j < before->session_count; ++j) {
            const ac_session_t *old = &before->sessions[j];
            if(old->health == AC_OBSERVATION_FRESH && strcmp(s->id, old->id) == 0 && strcmp(old->completion_id, s->completion_id) != 0)
                return s->completion_id;
        }
    }
    return NULL;
}

const char *ac_state_label(ac_state_t state)
{
    static const char *labels[] = {"运行中", "等待输入", "空闲", "已完成", "任务异常", "状态未知", "已断开"};
    return state >= AC_STATE_RUNNING && state <= AC_STATE_DISCONNECTED ? labels[state] : "状态未知";
}
