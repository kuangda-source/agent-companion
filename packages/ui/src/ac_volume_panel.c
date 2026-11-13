#include "ac_volume_panel.h"
#include "ac_neon.h"
static lv_obj_t *overlay,*slider,*value,*mute,*previous;static lv_group_t *group,*screen_group;
static unsigned volume=80;static bool muted,mock_mode;
static void (*save_handler)(unsigned,bool);static void (*stop_handler)(void);
static void keys(lv_group_t *g){for(lv_indev_t *i=lv_indev_get_next(NULL);i;i=lv_indev_get_next(i))if(lv_indev_get_type(i)==LV_INDEV_TYPE_KEYPAD||lv_indev_get_type(i)==LV_INDEV_TYPE_ENCODER)lv_indev_set_group(i,g);}
static lv_obj_t *text(lv_obj_t *p,int x,int y,const char *s,int width){lv_obj_t *l=ac_neon_text(p,x,y,s,AC_NEON_TEXT);lv_obj_set_width(l,width);lv_obj_set_style_text_font(l,ac_theme_font(16),0);return l;}
void ac_volume_panel_update(unsigned v,bool m){if(slider&&lv_obj_has_state(slider,LV_STATE_PRESSED))return;volume=v>100?100:v;muted=m;if(!overlay)return;lv_slider_set_value(slider,(int)volume,LV_ANIM_OFF);lv_label_set_text_fmt(value,"%s音量 %u%%",mock_mode?"MOCK · ":"",volume);if(muted)lv_obj_add_state(mute,LV_STATE_CHECKED);else lv_obj_remove_state(mute,LV_STATE_CHECKED);}
static void changed(lv_event_t *e){volume=(unsigned)lv_slider_get_value(slider);muted=lv_obj_has_state(mute,LV_STATE_CHECKED);lv_label_set_text_fmt(value,"%s音量 %u%%",mock_mode?"MOCK · ":"",volume);if(save_handler&&(lv_event_get_code(e)!=LV_EVENT_VALUE_CHANGED||!lv_obj_has_state(slider,LV_STATE_PRESSED)))save_handler(volume,muted);}
static void toggle(lv_event_t *e){(void)e;muted=lv_obj_has_state(mute,LV_STATE_CHECKED);if(save_handler)save_handler(volume,muted);}
bool ac_volume_panel_close(void){if(!overlay||lv_obj_has_flag(overlay,LV_OBJ_FLAG_HIDDEN))return false;lv_obj_add_flag(overlay,LV_OBJ_FLAG_HIDDEN);keys(screen_group);if(previous&&lv_obj_is_valid(previous))lv_group_focus_obj(previous);return true;}
static void closed(lv_event_t *e){(void)e;ac_volume_panel_close();}
static void stopped(lv_event_t *e){(void)e;if(stop_handler)stop_handler();}
static void key(lv_event_t *e){if(lv_event_get_key(e)==LV_KEY_ESC)ac_volume_panel_close();}
static lv_obj_t *button(lv_obj_t *p,int x,int y,int w,const char *s,lv_event_cb_t fn){lv_obj_t *b=ac_neon_box(p,x,y,w,44,AC_NEON_SURFACE);lv_obj_add_flag(b,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(b,AC_NEON_CYAN);text(b,12,10,s,w-18);lv_obj_add_event_cb(b,fn,LV_EVENT_CLICKED,NULL);lv_group_add_obj(group,b);lv_obj_add_event_cb(b,key,LV_EVENT_KEY,NULL);return b;}
void ac_volume_panel_create(lv_obj_t *screen,bool mock){
 mock_mode=mock;screen_group=lv_group_get_default();group=lv_group_create();
 overlay=lv_obj_create(screen);lv_obj_remove_style_all(overlay);lv_obj_set_size(overlay,1024,600);lv_obj_set_style_bg_color(overlay,lv_color_hex(0),0);lv_obj_set_style_bg_opa(overlay,LV_OPA_50,0);lv_obj_remove_flag(overlay,LV_OBJ_FLAG_SCROLLABLE);lv_obj_add_flag(overlay,LV_OBJ_FLAG_CLICKABLE);
 lv_obj_t *p=ac_neon_box(overlay,282,144,460,312,AC_NEON_SURFACE);text(p,24,22,"声音 / 监视器扬声器",380);button(p,386,14,52,"×",closed);
 value=text(p,24,76,"",380);slider=lv_slider_create(p);lv_obj_set_pos(slider,30,128);lv_obj_set_size(slider,392,16);lv_slider_set_range(slider,0,100);lv_obj_set_style_bg_color(slider,ac_color(AC_NEON_CYAN),LV_PART_INDICATOR);lv_obj_set_style_bg_color(slider,ac_color(AC_NEON_CYAN),LV_PART_KNOB);lv_group_add_obj(group,slider);lv_obj_add_event_cb(slider,changed,LV_EVENT_VALUE_CHANGED,NULL);lv_obj_add_event_cb(slider,changed,LV_EVENT_RELEASED,NULL);lv_obj_add_event_cb(slider,key,LV_EVENT_KEY,NULL);
 mute=lv_switch_create(p);lv_obj_set_pos(mute,24,186);lv_obj_set_size(mute,56,30);text(p,98,190,"静音",280);lv_group_add_obj(group,mute);lv_obj_add_event_cb(mute,toggle,LV_EVENT_VALUE_CHANGED,NULL);lv_obj_add_event_cb(mute,key,LV_EVENT_KEY,NULL);
 button(p,24,244,156,"停止当前播报",stopped);text(p,200,258,"设置保存在本机",238);ac_volume_panel_update(volume,muted);lv_obj_add_flag(overlay,LV_OBJ_FLAG_HIDDEN);
}
void ac_volume_panel_handler(void (*settings)(unsigned,bool),void (*stop)(void)){save_handler=settings;stop_handler=stop;}
void ac_volume_panel_open(void){if(!overlay)return;previous=lv_group_get_focused(screen_group);lv_obj_remove_flag(overlay,LV_OBJ_FLAG_HIDDEN);lv_obj_move_foreground(overlay);keys(group);lv_group_focus_obj(slider);}
void ac_volume_panel_destroy(void){if(overlay)lv_obj_delete(overlay);overlay=NULL;if(group)lv_group_delete(group);group=NULL;save_handler=NULL;stop_handler=NULL;}
