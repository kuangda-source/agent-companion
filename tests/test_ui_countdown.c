/* Reproduce a snapshot arriving between two UI ticks, before any subsequent tick. */
#include "lvgl.h"
#include "ac_bootstrap_screen.h"
#include "ac_theme.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static ac_snapshot_t snapshot;
static uint8_t pixels[1024*600*2];
static void flush(lv_display_t *display,const lv_area_t *area,uint8_t *data){(void)area;(void)data;lv_display_flush_ready(display);}
static bool contains(lv_obj_t *o,const char *s){
    if(lv_obj_has_flag(o,LV_OBJ_FLAG_HIDDEN))return false;
    if(lv_obj_check_type(o,&lv_label_class)&&strstr(lv_label_get_text(o),s))return true;
    for(uint32_t i=0;i<lv_obj_get_child_count(o);i++)if(contains(lv_obj_get_child(o,i),s))return true;
    return false;
}
static lv_obj_t *label_with(lv_obj_t *o,const char *s){
    if(lv_obj_has_flag(o,LV_OBJ_FLAG_HIDDEN))return NULL;
    if(lv_obj_check_type(o,&lv_label_class)&&!strcmp(lv_label_get_text(o),s))return o;
    for(uint32_t i=0;i<lv_obj_get_child_count(o);i++){lv_obj_t *found=label_with(lv_obj_get_child(o,i),s);if(found)return found;}
    return NULL;
}
static void label_fits(lv_obj_t *label){
    lv_point_t size;lv_text_get_size(&size,lv_label_get_text(label),lv_obj_get_style_text_font(label,0),lv_obj_get_style_text_letter_space(label,0),0,10000,0);assert(size.x<=lv_obj_get_width(label));
}
int main(void){
    lv_init();lv_display_t *display=lv_display_create(1024,600);lv_display_set_color_format(display,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(display,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(display,flush);ac_bootstrap_screen_create(false,true,NULL);
    for(int i=0;i<AC_AGENT_COUNT;i++){snapshot.agents[i].state=AC_STATE_IDLE;snapshot.agents[i].quality=AC_QUALITY_CONFIRMED;snapshot.agents[i].health=AC_OBSERVATION_FRESH;}
    snapshot.mock=true;snapshot.seq=1;snapshot.schedules.as_of_epoch=1800000000;
    snapshot.schedules.agents[0]=(ac_agent_schedule_t){.available=true,.fresh=true,.count=1};
    snapshot.schedules.agents[0].tasks[0]=(ac_schedule_t){.status=1,.next_epoch=1800000090};
    strcpy(snapshot.schedules.agents[0].tasks[0].title,"Future task");
    ac_bootstrap_screen_tick(1000);ac_bootstrap_screen_apply(&snapshot,1005);
    assert(!contains(lv_screen_active(),"等待调度"));assert(contains(lv_screen_active(),"还剩1分30秒"));
    ac_bootstrap_screen_tick(1016);snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1019);
    assert(!contains(lv_screen_active(),"等待调度"));
    snapshot.schedules.agents[0].tasks[0].next_epoch=1800000000;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1021);
    assert(contains(lv_screen_active(),"等待调度"));
    ac_schedule_t *task=&snapshot.schedules.agents[0].tasks[0];strcpy(task->session_id,"scheduled-thread");strcpy(task->thread_title,"Linked conversation");task->next_epoch=1800000120;
    snapshot.agents[0].session_count=1;ac_session_t *session=&snapshot.agents[0].sessions[0];strcpy(session->id,"scheduled-thread");strcpy(session->title,"Linked conversation");session->health=AC_OBSERVATION_FRESH;session->quality=AC_QUALITY_CONFIRMED;session->state=AC_STATE_RUNNING;task->activity=AC_SCHEDULE_RUNNING;
    snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1022);assert(contains(lv_screen_active(),"运行中"));assert(!contains(lv_screen_active(),"Future task"));
    ac_bootstrap_screen_show_schedules(true);assert(contains(lv_screen_active(),"运行中"));assert(!contains(lv_screen_active(),"Future task"));assert(!contains(lv_screen_active(),"还剩"));
    session->state=AC_STATE_COMPLETED;task->activity=AC_SCHEDULE_PLANNED;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1023);assert(contains(lv_screen_active(),"Future task"));assert(contains(lv_screen_active(),"还剩2分0秒"));
    ac_bootstrap_screen_show_schedules(false);assert(contains(lv_screen_active(),"Future task"));assert(!contains(lv_screen_active(),"已完成"));
    ac_bootstrap_screen_set_scheduled_tasks_visible(false);assert(!contains(lv_screen_active(),"Future task"));assert(contains(lv_screen_active(),"已完成"));
    snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1024);assert(!contains(lv_screen_active(),"Future task"));
    session->state=AC_STATE_RUNNING;task->activity=AC_SCHEDULE_RUNNING;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1025);assert(contains(lv_screen_active(),"运行中"));assert(!contains(lv_screen_active(),"Future task"));
    ac_bootstrap_screen_set_scheduled_tasks_visible(true);session->state=AC_STATE_COMPLETED;task->activity=AC_SCHEDULE_PLANNED;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1026);assert(contains(lv_screen_active(),"Future task"));
    snapshot.agents[0].quota=(ac_metric_t){.available=true,.value=.64};snapshot.agents[0].quota_minutes=10080;snapshot.agents[0].quota_stale=true;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1027);assert(contains(lv_screen_active(),"上次 7d 剩余 36%"));
    snapshot.agents[0].quota_stale=false;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1028);assert(!contains(lv_screen_active(),"上次 7d"));assert(contains(lv_screen_active(),"7d 剩余 36%"));
    snapshot.agent_count=1;snapshot.agent_order[0]=AC_AGENT_GROK;ac_agent_t *grok=&snapshot.agents[AC_AGENT_GROK];grok->session_count=1;grok->total=1;
    grok->quota=(ac_metric_t){.available=true,.value=.1};grok->quota_minutes=10080;grok->quota_stale=true;
    ac_session_t *bot=&grok->sessions[0];strcpy(bot->id,"example-bot");strcpy(bot->title,"Example Bot");strcpy(bot->latest_message,"Recent public message");bot->latest_message_assistant=true;bot->health=AC_OBSERVATION_FRESH;bot->state=AC_STATE_UNKNOWN;bot->quality=AC_QUALITY_UNKNOWN;
    snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1029);assert(contains(lv_screen_active(),"Recent public message"));assert(contains(lv_screen_active(),"状态未知"));assert(!contains(lv_screen_active(),"IN / OUT"));assert(!contains(lv_screen_active(),"CACHE"));assert(!contains(lv_screen_active(),"CTX"));assert(!contains(lv_screen_active(),"TIME"));assert(contains(lv_screen_active(),"7d 剩余 90%"));assert(!contains(lv_screen_active(),"上次 7d"));
    snapshot.agent_order[0]=AC_AGENT_CODEX;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,1030);assert(contains(lv_screen_active(),"IN / OUT"));assert(contains(lv_screen_active(),"TIME"));assert(contains(lv_screen_active(),"还剩"));assert(!contains(lv_screen_active(),"Recent public message"));
    snapshot.generated_epoch=1800000000;snapshot.agents[0].quota_reset_epoch=1800000091;
    snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,2000);assert(contains(lv_screen_active(),"7d余36%"));assert(contains(lv_screen_active(),"1m31s重置"));
    ac_bootstrap_screen_tick(3000);assert(contains(lv_screen_active(),"1m30s重置"));
    for(int theme=0;theme<AC_THEME_COUNT;theme++){
        ac_theme_apply(lv_screen_active(),(ac_theme_id_t)theme);snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,4000+theme);
        lv_obj_update_layout(lv_screen_active());lv_obj_t *left=label_with(lv_screen_active(),"7d余36%"),*right=label_with(lv_screen_active(),"1m31s重置");assert(left&&right);
        lv_area_t a,b;lv_obj_get_coords(left,&a);lv_obj_get_coords(right,&b);assert(a.x2<b.x1&&a.y1==b.y1);
        label_fits(left);label_fits(right);
        snapshot.agents[0].quota.value=0;snapshot.agents[0].quota_stale=true;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,4000+theme);
        lv_obj_update_layout(lv_screen_active());left=label_with(lv_screen_active(),"上次7d100%");assert(left);label_fits(left);assert(contains(lv_screen_active(),"待更新"));
        snapshot.agents[0].quota.value=.64;snapshot.agents[0].quota_stale=false;
    }
    snapshot.agents[0].quota_reset_epoch=snapshot.generated_epoch+1;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,5000);
    ac_bootstrap_screen_tick(6000);assert(contains(lv_screen_active(),"待确认"));assert(contains(lv_screen_active(),"7d余36%"));
    ac_bootstrap_screen_tick(12000);assert(contains(lv_screen_active(),"待更新"));
    snapshot.agents[0].quota_reset_epoch=0;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,13000);assert(contains(lv_screen_active(),"7d 剩余 36%"));assert(!contains(lv_screen_active(),"待确认"));
    snapshot.agent_order[0]=AC_AGENT_GROK;grok->quota_reset_epoch=snapshot.generated_epoch+2*86400+4*3600;snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,14000);
    assert(contains(lv_screen_active(),"7d余90%"));assert(contains(lv_screen_active(),"2d04h重置"));assert(!contains(lv_screen_active(),"上次7d"));
    grok->balance=(ac_balance_t){.available=true,.health=AC_OBSERVATION_FRESH,.total=12.34};strcpy(grok->balance.currency,"CNY");snapshot.seq++;ac_bootstrap_screen_apply(&snapshot,15000);
    assert(contains(lv_screen_active(),"余额 ¥12.34"));assert(!contains(lv_screen_active(),"2d04h重置"));
    ac_bootstrap_screen_destroy();lv_display_delete(display);lv_deinit();puts("PASS snapshot clock and scheduled conversation: running replaces future, no duplicate, completion restores countdown");return 0;
}
