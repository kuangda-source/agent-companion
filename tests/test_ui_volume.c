#include "ac_volume_panel.h"
#include "ac_neon.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static bool pressed;static int px,py,saves,stops;static unsigned saved_volume;static bool saved_muted;
static void read_pointer(lv_indev_t *i,lv_indev_data_t *d){(void)i;d->point=(lv_point_t){px,py};d->state=pressed?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;}
static void flush(lv_display_t *d,const lv_area_t *a,uint8_t *p){(void)a;(void)p;lv_display_flush_ready(d);}
static void click(lv_indev_t *i,int x,int y){px=x;py=y;pressed=true;lv_tick_inc(40);lv_indev_read(i);lv_timer_handler();pressed=false;lv_tick_inc(40);lv_indev_read(i);lv_timer_handler();}
static void save(unsigned volume,bool muted){saves++;saved_volume=volume;saved_muted=muted;}static void stop(void){stops++;}
static bool contains(lv_obj_t *o,const char *text){if(lv_obj_has_flag(o,LV_OBJ_FLAG_HIDDEN))return false;if(lv_obj_check_type(o,&lv_label_class)&&strstr(lv_label_get_text(o),text))return true;for(uint32_t i=0;i<lv_obj_get_child_count(o);i++)if(contains(lv_obj_get_child(o,i),text))return true;return false;}
static lv_obj_t *find(lv_obj_t *p,const lv_obj_class_t *type,unsigned *at){if(lv_obj_check_type(p,type)){if(!*at)return p;--*at;}for(uint32_t i=0;i<lv_obj_get_child_count(p);i++){lv_obj_t *r=find(lv_obj_get_child(p,i),type,at);if(r)return r;}return NULL;}
int main(void){
    lv_init();lv_display_t *d=lv_display_create(1024,600);static uint8_t pixels[1024*600*2];lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(d,flush);
    lv_group_t *g=lv_group_create();lv_group_set_default(g);lv_indev_t *pointer=lv_indev_create();lv_indev_set_type(pointer,LV_INDEV_TYPE_POINTER);lv_indev_set_read_cb(pointer,read_pointer);ac_neon_animations(false);
    ac_volume_panel_create(lv_screen_active(),false);ac_volume_panel_handler(save,stop);ac_volume_panel_update(80,false);ac_volume_panel_open();lv_obj_update_layout(lv_screen_active());
    assert(contains(lv_screen_active(),"音量 80%"));unsigned at=0;lv_obj_t *slider=find(lv_screen_active(),&lv_slider_class,&at);assert(slider);
    lv_obj_add_state(slider,LV_STATE_PRESSED);lv_slider_set_value(slider,50,LV_ANIM_OFF);lv_obj_send_event(slider,LV_EVENT_VALUE_CHANGED,NULL);assert(saves==0);ac_volume_panel_update(80,false);assert(lv_slider_get_value(slider)==50);
    lv_obj_remove_state(slider,LV_STATE_PRESSED);lv_obj_send_event(slider,LV_EVENT_RELEASED,NULL);assert(saves==1&&saved_volume==50&&!saved_muted);
    click(pointer,334,346);assert(saves==2&&saved_muted);click(pointer,360,410);assert(stops==1);assert(ac_volume_panel_close());assert(!contains(lv_screen_active(),"音量"));
    ac_volume_panel_open();ac_volume_panel_update(100,false);assert(contains(lv_screen_active(),"音量 100%"));assert(lv_slider_get_value(slider)==100);lv_obj_send_event(slider,LV_EVENT_RELEASED,NULL);assert(saved_volume==100);
    ac_volume_panel_update(101,false);assert(lv_slider_get_value(slider)==100);
    ac_volume_panel_update(0,true);assert(contains(lv_screen_active(),"音量 0%"));ac_volume_panel_destroy();
    lv_group_set_default(NULL);lv_obj_clean(lv_screen_active());lv_indev_delete(pointer);lv_group_delete(g);lv_display_delete(d);lv_deinit();puts("PASS volume: drag survives refresh, release saves, mute, stop and reopen");return 0;
}
