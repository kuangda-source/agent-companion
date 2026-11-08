#include "ac_assistant_panel.h"
#include "ac_neon.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t pixels[1024*600*2];
static void flush(lv_display_t *d,const lv_area_t *a,uint8_t *p){(void)a;(void)p;lv_display_flush_ready(d);}
static bool contains(lv_obj_t *o,const char *text){
    if(lv_obj_has_flag(o,LV_OBJ_FLAG_HIDDEN))return false;
    if(lv_obj_check_type(o,&lv_label_class)&&strstr(lv_label_get_text(o),text))return true;
    for(uint32_t i=0;i<lv_obj_get_child_count(o);++i)if(contains(lv_obj_get_child(o,i),text))return true;
    return false;
}
static void tick(uint32_t ms){lv_tick_inc(ms);lv_timer_handler();}
int main(void){
    lv_init();lv_display_t *d=lv_display_create(1024,600);lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(d,flush);
    ac_neon_animations(false);ac_assistant_panel_create(lv_screen_active(),true,NULL);
    lv_obj_t *compact=lv_obj_get_child(lv_screen_active(),0);lv_obj_update_layout(compact);
    assert(lv_obj_get_y(compact)==480&&lv_obj_get_height(compact)==108);
    ac_assistant_message_view_t messages[]={
        {"one","09:00","项目简报（据公开对话）\n\n第一条：实验结果待复核。\n\n本轮：1个会话；来源说法未经独立验收。","AI 助手 · 项目简报"},
        {"two","09:01","项目动态（据公开对话）\n\n第二条：导出接口已整理，需要确认。\n\n详情可在项目简报和来源中核对，Agent报告不代表独立验收。","AI 助手 · 项目简报"},
        {"user","09:02","这是一条用户追问，不冒充助手消息。","你"}
    };
    ac_assistant_feed_view_t feed={AC_ASSISTANT_READY,true,messages,3};assert(ac_assistant_panel_set_feed(&feed));
    assert(contains(compact,"第二条"));assert(contains(compact,"1 / 2"));assert(!contains(compact,"据公开对话"));assert(!contains(compact,"详情可在"));assert(!contains(compact,"用户追问"));
    /* Identical two-second heartbeats must not restart the ten-second carousel. */
    for(int i=0;i<4;++i){tick(2000);assert(ac_assistant_panel_set_feed(&feed));assert(contains(compact,"第二条"));}
    tick(2001);assert(contains(compact,"第一条"));assert(contains(compact,"2 / 2"));assert(!contains(compact,"本轮："));assert(contains(compact,"3 条未读"));
    /* An expanded history pauses rotation, but it still shows every message. */
    lv_obj_send_event(compact,LV_EVENT_CLICKED,NULL);tick(10001);assert(contains(compact,"第一条"));assert(contains(lv_screen_active(),"用户追问"));
    assert(ac_assistant_panel_close());tick(10001);assert(contains(compact,"第二条"));
    /* A new arrival returns to the newest message without marking it read. */
    messages[2]=(ac_assistant_message_view_t){"three","09:03","第三条：需要复核的新结果。","AI 助手 · 对话回复"};
    assert(ac_assistant_panel_set_feed(&feed));assert(contains(compact,"第三条"));assert(contains(compact,"1 / 3"));
    for(int theme=0;theme<AC_THEME_COUNT;++theme){ac_theme_apply(lv_screen_active(),(ac_theme_id_t)theme);lv_obj_update_layout(compact);assert(lv_obj_get_y(compact)+lv_obj_get_height(compact)<=600);}
    feed.message_count=0;assert(ac_assistant_panel_set_feed(&feed));tick(20001);assert(contains(compact,"项目简报、关注事项"));
    ac_assistant_panel_destroy();tick(20001);lv_obj_clean(lv_screen_active());lv_display_delete(d);lv_deinit();
    puts("PASS assistant carousel: body preview, timing, unchanged feeds, modal pause, arrivals and lifecycle");return 0;
}
