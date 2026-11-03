/* Reproduce a snapshot arriving between two UI ticks, before any subsequent tick. */
#include "lvgl.h"
#include "ac_bootstrap_screen.h"
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
    ac_bootstrap_screen_destroy();lv_display_delete(display);lv_deinit();puts("PASS snapshot clock and scheduled conversation: running replaces future, no duplicate, completion restores countdown");return 0;
}
