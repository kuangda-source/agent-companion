#include "ac_wifi_panel.h"
#include "ac_neon.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
static bool pressed;static int px,py,scans,joins;static ac_wifi_join_t accepted;
static void read_pointer(lv_indev_t *i,lv_indev_data_t *d){(void)i;d->point=(lv_point_t){px,py};d->state=pressed?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;}
static void flush(lv_display_t *d,const lv_area_t *a,uint8_t *p){(void)a;(void)p;lv_display_flush_ready(d);}
static void click(lv_indev_t *i,int x,int y){px=x;py=y;pressed=true;lv_tick_inc(40);lv_indev_read(i);lv_timer_handler();pressed=false;lv_tick_inc(40);lv_indev_read(i);lv_timer_handler();}
static bool scan(void){scans++;return true;}static bool join(const ac_wifi_join_t *r){accepted=*r;joins++;return true;}
static lv_obj_t *find(lv_obj_t *p,const lv_obj_class_t *type,unsigned *at){if(lv_obj_check_type(p,type)){if(!*at)return p;--*at;}for(uint32_t i=0;i<lv_obj_get_child_count(p);i++){lv_obj_t *r=find(lv_obj_get_child(p,i),type,at);if(r)return r;}return NULL;}
int main(void){
    lv_init();lv_display_t *d=lv_display_create(1024,600);static uint8_t pixels[1024*600*2];lv_display_set_color_format(d,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(d,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(d,flush);
    lv_group_t *g=lv_group_create();lv_group_set_default(g);lv_indev_t *pointer=lv_indev_create();lv_indev_set_type(pointer,LV_INDEV_TYPE_POINTER);lv_indev_set_read_cb(pointer,read_pointer);ac_neon_animations(false);
    ac_wifi_panel_create(lv_screen_active(),false);ac_wifi_panel_handlers(scan,join);ac_wifi_status_t status={.revision=1,.count=3,.has_saved_password=true,.relay_configured=true};strcpy(status.ssid,"Saved Wi-Fi");strcpy(status.networks[0].ssid,"Saved Wi-Fi");status.networks[0].supported=true;status.networks[0].secured=true;strcpy(status.networks[1].ssid,"Guest");status.networks[1].supported=true;strcpy(status.networks[2].ssid,"Enterprise");
    ac_wifi_panel_update(&status);ac_wifi_panel_open();lv_obj_update_layout(lv_screen_active());assert(scans==1&&ac_wifi_panel_visible());
    unsigned at=0;lv_obj_t *ssid=find(lv_screen_active(),&lv_textarea_class,&at);at=1;lv_obj_t *password=find(lv_screen_active(),&lv_textarea_class,&at);at=0;lv_obj_t *keyboard=find(lv_screen_active(),&lv_keyboard_class,&at);assert(ssid&&password&&keyboard);
    lv_area_t bounds;lv_obj_get_coords(keyboard,&bounds);assert(bounds.x1>=0&&bounds.y1>=0&&bounds.x2<1024&&bounds.y2<600);
    click(pointer,162,433);assert(!strcmp(lv_textarea_get_text(ssid),"q"));
    click(pointer,60,115);assert(!strcmp(lv_textarea_get_text(ssid),"Saved Wi-Fi"));click(pointer,830,307);assert(joins==1&&accepted.use_saved_password&&!accepted.password[0]);
    lv_textarea_set_text(ssid,"New Wi-Fi");lv_textarea_set_text(password,"short");lv_obj_send_event(keyboard,LV_EVENT_READY,NULL);assert(joins==1);
    lv_textarea_set_text(password,"fixture123");assert(lv_textarea_get_password_mode(password));click(pointer,920,220);assert(!lv_textarea_get_password_mode(password));lv_obj_send_event(keyboard,LV_EVENT_READY,NULL);assert(joins==2&&!strcmp(accepted.password,"fixture123")&&!lv_textarea_get_text(password)[0]&&lv_textarea_get_password_mode(password));
    click(pointer,60,160);click(pointer,830,307);assert(joins==3&&accepted.open_network&&!accepted.password[0]);
    click(pointer,60,210);click(pointer,830,307);assert(joins==3);
    lv_textarea_set_text(password,"fixture-secret");lv_obj_send_event(keyboard,LV_EVENT_CANCEL,NULL);assert(ac_wifi_panel_visible()&&lv_obj_has_flag(keyboard,LV_OBJ_FLAG_HIDDEN)&&!strcmp(lv_textarea_get_text(password),"fixture-secret"));click(pointer,500,220);assert(!lv_obj_has_flag(keyboard,LV_OBJ_FLAG_HIDDEN));assert(ac_wifi_panel_close());assert(!lv_textarea_get_text(password)[0]&&!ac_wifi_panel_visible());
    ac_wifi_panel_open();assert(scans==2);ac_wifi_panel_destroy();lv_group_set_default(NULL);lv_obj_clean(lv_screen_active());lv_indev_delete(pointer);lv_group_delete(g);lv_display_delete(d);lv_deinit();puts("PASS Wi-Fi panel: touch, keyboard submit, validation, saved/open networks and password clearing");return 0;
}
