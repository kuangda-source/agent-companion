/* Real LVGL input/state dispatch: logical focus is distinct from touch feedback. */
#include "ac_neon.h"
#include <assert.h>
#include <stdio.h>
static bool down,key_down;
static uint32_t key=LV_KEY_NEXT;
static int x=35,y=35,clicks,releases;
static void pointer(lv_indev_t *indev,lv_indev_data_t *data){(void)indev;data->point=(lv_point_t){x,y};data->state=down?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;}
static void keyboard(lv_indev_t *indev,lv_indev_data_t *data){(void)indev;data->key=key;data->state=key_down?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;}
static void count(lv_event_t *e){if(lv_event_get_code(e)==LV_EVENT_CLICKED)clicks++;if(lv_event_get_code(e)==LV_EVENT_RELEASED)releases++;}
static void flush(lv_display_t *display,const lv_area_t *area,uint8_t *data){(void)area;(void)data;lv_display_flush_ready(display);}
static void read(lv_indev_t *indev){lv_tick_inc(40);lv_indev_read(indev);lv_timer_handler();}
static void settle(void){for(int i=0;i<25;++i){lv_tick_inc(20);lv_timer_handler();}}
static uint32_t background(lv_obj_t *obj){return lv_color_to_u32(lv_obj_get_style_bg_color(obj,LV_PART_MAIN))&0xffffff;}
int main(void){
    lv_init();lv_display_t *display=lv_display_create(200,120);static uint8_t pixels[200*120*2];lv_display_set_color_format(display,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(display,pixels,NULL,sizeof(pixels),LV_DISPLAY_RENDER_MODE_FULL);lv_display_set_flush_cb(display,flush);
    lv_group_t *group=lv_group_create();lv_group_set_default(group);
    lv_indev_t *touch=lv_indev_create();lv_indev_set_type(touch,LV_INDEV_TYPE_POINTER);lv_indev_set_read_cb(touch,pointer);
    lv_indev_t *keys=lv_indev_create();lv_indev_set_type(keys,LV_INDEV_TYPE_KEYPAD);lv_indev_set_read_cb(keys,keyboard);lv_indev_set_group(keys,group);
    ac_neon_animations(false);ac_theme_set_pointer_hover(false);
    lv_obj_t *button=ac_neon_box(lv_screen_active(),10,10,70,50,AC_NEON_SURFACE);lv_obj_add_flag(button,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(button,AC_NEON_CYAN);lv_obj_add_event_cb(button,count,LV_EVENT_ALL,NULL);
    lv_obj_t *other=ac_neon_box(lv_screen_active(),110,10,70,50,AC_NEON_SURFACE);lv_obj_add_flag(other,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(other,AC_NEON_CYAN);lv_obj_add_event_cb(other,count,LV_EVENT_ALL,NULL);
    for(int theme=0;theme<AC_THEME_COUNT;++theme){
        ac_theme_apply(lv_screen_active(),(ac_theme_id_t)theme);lv_obj_remove_state(button,LV_STATE_FOCUS_KEY|LV_STATE_HOVERED|LV_STATE_CHECKED);lv_obj_update_layout(lv_screen_active());uint32_t normal=background(button);
        x=35;y=35;down=true;read(touch);assert(lv_obj_has_state(button,LV_STATE_PRESSED));assert(background(button)!=normal);
        down=false;read(touch);assert(!lv_obj_has_state(button,LV_STATE_PRESSED));assert(background(button)==normal);assert(lv_obj_get_style_translate_x(button,0)==0&&lv_obj_get_style_translate_y(button,0)==0);
        /* Touch devices may keep the last hover location; it must not light the button. */
        lv_obj_add_state(button,LV_STATE_FOCUSED|LV_STATE_HOVERED);assert(!ac_theme_interaction_hint(button));assert(background(button)==normal);
        /* Keypad input still exposes a visible focus cue and can activate controls. */
        key=LV_KEY_NEXT;key_down=true;read(keys);key_down=false;read(keys);lv_obj_t *focused=lv_group_get_focused(group);assert(lv_obj_has_state(focused,LV_STATE_FOCUS_KEY));assert(ac_theme_interaction_hint(focused));
        x=lv_obj_get_x(focused)+20;y=35;down=true;read(touch);down=false;read(touch);assert(!lv_obj_has_state(focused,LV_STATE_FOCUS_KEY));assert(!ac_theme_interaction_hint(focused));
        /* A true selected item survives pointer release; never clear CHECKED globally. */
        ac_theme_selected(button,true);x=35;y=35;down=true;read(touch);down=false;read(touch);assert(lv_obj_has_state(button,LV_STATE_CHECKED));ac_theme_selected(button,false);
        /* Enabled transitions must also settle to the normal released appearance. */
        ac_neon_animations(true);down=true;read(touch);settle();assert(background(button)!=normal);down=false;read(touch);settle();assert(background(button)==normal);ac_neon_animations(false);
    }
    assert(clicks==12&&releases==12);
    /* Desktop mouse hover remains available independently from logical click focus. */
    ac_theme_set_pointer_hover(true);lv_obj_t *mouse=ac_neon_box(lv_screen_active(),10,70,70,40,AC_NEON_SURFACE);lv_obj_add_flag(mouse,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(mouse,AC_NEON_CYAN);uint32_t normal=background(mouse);lv_obj_add_state(mouse,LV_STATE_HOVERED);assert(ac_theme_interaction_hint(mouse)&&background(mouse)!=normal);lv_obj_remove_state(mouse,LV_STATE_HOVERED);assert(background(mouse)==normal);
    lv_group_set_default(NULL);lv_obj_clean(lv_screen_active());lv_indev_delete(touch);lv_indev_delete(keys);lv_group_delete(group);lv_display_delete(display);lv_deinit();puts("PASS UI input: three themes, touch release, retained coordinates/focus, keyboard cue, true selection and desktop hover");return 0;
}
