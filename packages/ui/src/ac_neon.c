#include "ac_neon.h"
static bool motion=true;
static lv_style_transition_dsc_t transition;
static const lv_style_prop_t props[]={LV_STYLE_BG_COLOR,LV_STYLE_BG_OPA,LV_STYLE_BORDER_COLOR,LV_STYLE_BORDER_OPA,LV_STYLE_SHADOW_WIDTH,LV_STYLE_SHADOW_OPA,LV_STYLE_OUTLINE_OPA,LV_STYLE_TRANSFORM_SCALE_X,LV_STYLE_TRANSFORM_SCALE_Y,LV_STYLE_TRANSFORM_ROTATION,0};
uint32_t ac_neon_color(uint32_t c)
{
    switch(c) {
        case 0x07090e: return AC_NEON_BG;
        case 0x0d1524: case 0x111d31: case 0x111f30: case 0x101d2c: case 0x0a1220: return AC_NEON_SURFACE;
        case 0x173449: case 0x15263a: case 0x173046: case 0x102232: case 0x142b3a: return 0x003039;
        case 0x00e7ff: return AC_NEON_CYAN;
        case 0xde64ff: return AC_NEON_MAGENTA;
        case 0x3897ff: return AC_NEON_BLUE;
        case 0x9bb0c6: return 0xb8faff;
        case 0x64849e: return AC_NEON_MUTED;
        case 0xe9f6ff: return AC_NEON_TEXT;
        case 0x30f0b0: return AC_NEON_GREEN;
        case 0xffd057: return AC_NEON_YELLOW;
        case 0xff5b83: return AC_NEON_ERROR;
        case 0x1e3650: case 0x173044: case 0x234c55: case 0x20394d: case 0x245469: return 0x006877;
        default: return c;
    }
}
lv_obj_t *ac_neon_box(lv_obj_t *parent,int x,int y,int w,int h,uint32_t color)
{
    lv_obj_t *o=lv_obj_create(parent); lv_obj_remove_style_all(o); lv_obj_set_pos(o,x,y); lv_obj_set_size(o,w,h);
    lv_obj_set_style_bg_color(o,ac_color(ac_neon_color(color)),0); lv_obj_set_style_bg_opa(o,LV_OPA_COVER,0);
    lv_obj_set_style_radius(o,ac_theme_radius(),0); lv_obj_set_style_border_color(o,ac_color(AC_NEON_CYAN),0);
    lv_obj_set_style_border_width(o,1,0); lv_obj_set_style_border_opa(o,LV_OPA_30,0);
    lv_obj_remove_flag(o,LV_OBJ_FLAG_SCROLLABLE|LV_OBJ_FLAG_CLICKABLE); lv_obj_add_flag(o,LV_OBJ_FLAG_EVENT_BUBBLE); ac_theme_surface(o,false,false);return o;
}
lv_obj_t *ac_neon_text(lv_obj_t *parent,int x,int y,const char *value,uint32_t color)
{
    lv_obj_t *o=lv_label_create(parent); lv_label_set_text(o,value); lv_obj_set_pos(o,x,y);
    lv_obj_set_style_text_color(o,ac_color(ac_neon_color(color)),0); lv_obj_add_flag(o,LV_OBJ_FLAG_EVENT_BUBBLE); return o;
}
void ac_neon_flat(lv_obj_t *o) { lv_obj_set_style_bg_opa(o,LV_OPA_TRANSP,0); lv_obj_set_style_border_width(o,0,0); lv_obj_set_style_radius(o,0,0);ac_theme_surface(o,true,false); }
void ac_neon_rule(lv_obj_t *parent,int x,int y,int w,uint32_t color,lv_opa_t opacity)
{
    lv_obj_t *line=ac_neon_box(parent,x,y,w,1,color); lv_obj_set_style_border_width(line,0,0); lv_obj_set_style_bg_opa(line,opacity,0);
}
static void glow_draw(lv_event_t *e)
{
    lv_obj_t *obj=lv_event_get_current_target_obj(e);
    if(lv_event_get_code(e)==LV_EVENT_REFR_EXT_DRAW_SIZE) { lv_event_set_ext_draw_size(e,3); return; }
    if(lv_event_get_code(e)!=LV_EVENT_DRAW_MAIN_BEGIN) return;
    if(ac_theme_current()==AC_THEME_NEUMORPHISM) return;
    lv_draw_label_dsc_t d; lv_draw_label_dsc_init(&d);
    d.font=lv_obj_get_style_text_font(obj,0); d.text=lv_label_get_text(obj); d.color=lv_obj_get_style_text_color(obj,0);
    d.letter_space=lv_obj_get_style_text_letter_space(obj,0); d.opa=28;
    lv_area_t bounds; lv_obj_get_coords(obj,&bounds);
    if(ac_theme_current()==AC_THEME_COMIC) {
        lv_area_t at=bounds;lv_area_move(&at,-1,1);d.color=lv_color_hex(0xff3333);d.opa=160;lv_draw_label(lv_event_get_layer(e),&d,&at);
        at=bounds;lv_area_move(&at,1,-1);d.color=lv_color_hex(0x3366ff);lv_draw_label(lv_event_get_layer(e),&d,&at);return;
    }
    const int offsets[4][2]={{-2,0},{2,0},{0,-2},{0,2}};
    for(int i=0;i<4;++i) { lv_area_t at=bounds; lv_area_move(&at,offsets[i][0],offsets[i][1]); lv_draw_label(lv_event_get_layer(e),&d,&at); }
}
void ac_neon_glow_text(lv_obj_t *label)
{
    lv_obj_add_event_cb(label,glow_draw,LV_EVENT_DRAW_MAIN_BEGIN,NULL);
    lv_obj_add_event_cb(label,glow_draw,LV_EVENT_REFR_EXT_DRAW_SIZE,NULL); lv_obj_refresh_ext_draw_size(label);
}
static void press_event(lv_event_t *e)
{
    lv_obj_t *o=lv_event_get_current_target_obj(e); lv_event_code_t code=lv_event_get_code(e);
    lv_indev_t *input=lv_event_get_indev(e);
    if(code==LV_EVENT_PRESSED && input && lv_indev_get_type(input)==LV_INDEV_TYPE_POINTER) lv_obj_remove_state(o,LV_STATE_FOCUS_KEY);
    if(code==LV_EVENT_PRESSED && ac_theme_current()==AC_THEME_NEON) { lv_obj_set_style_translate_x(o,2,0); lv_obj_set_style_translate_y(o,-1,0); }
    if(code==LV_EVENT_PRESSED && ac_theme_current()==AC_THEME_COMIC && motion) {lv_obj_set_style_translate_x(o,2,0);lv_obj_set_style_translate_y(o,2,0);}
    if(code==LV_EVENT_RELEASED || code==LV_EVENT_PRESS_LOST) { lv_obj_set_style_translate_x(o,0,0); lv_obj_set_style_translate_y(o,0,0); }
}
static void scan_draw(lv_event_t *e)
{
    if(ac_theme_current()!=AC_THEME_NEON) return;
    lv_obj_t *o=lv_event_get_current_target_obj(e); lv_area_t bounds; lv_obj_get_coords(o,&bounds);
    bool hover=ac_theme_interaction_hint(o) && lv_obj_get_width(o)<350;
    lv_draw_line_dsc_t d; lv_draw_line_dsc_init(&d); d.color=ac_color(AC_NEON_CYAN); d.opa=hover?18:7; d.width=1;
    for(int y=bounds.y1+3;y<bounds.y2;y+=hover?4:8) {
        d.p1=(lv_point_precise_t){bounds.x1+1,y}; d.p2=(lv_point_precise_t){bounds.x2-1,y};
        lv_draw_line(lv_event_get_layer(e),&d);
    }
}
void ac_neon_scanlines(lv_obj_t *o) { lv_obj_add_event_cb(o,scan_draw,LV_EVENT_DRAW_MAIN_END,NULL); }
static void grid_draw(lv_event_t *e)
{
    if(ac_theme_current()==AC_THEME_NEUMORPHISM) return;
    if(ac_theme_current()==AC_THEME_COMIC) {lv_area_t area;lv_obj_get_coords(lv_event_get_current_target_obj(e),&area);ac_theme_dots(lv_event_get_layer(e),&area,24);return;}
    lv_draw_line_dsc_t d;lv_draw_line_dsc_init(&d);d.color=ac_color(AC_NEON_CYAN);d.opa=8;d.width=1;
    lv_area_t area;lv_obj_get_coords(lv_event_get_current_target_obj(e),&area);
    for(int y=area.y1+4;y<=area.y2;y+=4) {d.p1=(lv_point_precise_t){area.x1,y};d.p2=(lv_point_precise_t){area.x2,y};lv_draw_line(lv_event_get_layer(e),&d);}
    for(int x=area.x1+16;x<=area.x2;x+=64) {d.p1=(lv_point_precise_t){x,area.y1};d.p2=(lv_point_precise_t){x,area.y2};lv_draw_line(lv_event_get_layer(e),&d);}
}
void ac_neon_grid(lv_obj_t *o) {lv_obj_add_event_cb(o,grid_draw,LV_EVENT_DRAW_MAIN_END,NULL);}
void ac_neon_interactive(lv_obj_t *o,uint32_t color)
{
    uint32_t accent=ac_neon_color(color);
    lv_style_transition_dsc_init(&transition,props,ac_theme_current()==AC_THEME_NEUMORPHISM?lv_anim_path_ease_in_out:lv_anim_path_ease_out,ac_theme_duration(),0,NULL);
    lv_obj_set_style_transition(o,&transition,0);
    lv_obj_set_style_shadow_color(o,ac_color(accent),0);
    const lv_state_t states[]={LV_STATE_FOCUS_KEY,LV_STATE_HOVERED};
    for(unsigned i=0;i<(ac_theme_pointer_hover_enabled()?2u:1u);++i) {
        lv_obj_set_style_border_color(o,ac_color(accent),states[i]);
        lv_obj_set_style_border_opa(o,LV_OPA_COVER,states[i]);
        lv_obj_set_style_shadow_width(o,ac_theme_current()==AC_THEME_NEON?20:0,states[i]);
        lv_obj_set_style_shadow_opa(o,LV_OPA_40,states[i]);
        lv_obj_set_style_bg_color(o,ac_color(0x00343e),states[i]);
        lv_obj_set_style_bg_opa(o,LV_OPA_COVER,states[i]);
    }
    if(lv_group_get_default()) lv_group_add_obj(lv_group_get_default(),o);
    lv_obj_set_style_border_color(o,ac_color(AC_NEON_MAGENTA),LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(o,ac_color(0x330033),LV_STATE_PRESSED);
    lv_obj_add_event_cb(o,press_event,LV_EVENT_PRESSED,NULL); lv_obj_add_event_cb(o,press_event,LV_EVENT_RELEASED,NULL); lv_obj_add_event_cb(o,press_event,LV_EVENT_PRESS_LOST,NULL);
    ac_theme_surface(o,false,true);
}
static void reveal_x(void *o,int32_t value) { lv_obj_set_style_translate_x(o,value,0); }
static void reveal_opa(void *o,int32_t value) { lv_obj_set_style_opa(o,(lv_opa_t)value,0); }
void ac_neon_reveal(lv_obj_t *o,int direction,unsigned delay)
{
    lv_anim_delete(o,reveal_x); lv_anim_delete(o,reveal_opa);
    if(!motion) { reveal_x(o,0); reveal_opa(o,255); return; }
    lv_anim_t a; lv_anim_init(&a); lv_anim_set_var(&a,o); lv_anim_set_duration(&a,ac_theme_duration()); lv_anim_set_delay(&a,delay); lv_anim_set_path_cb(&a,ac_theme_current()==AC_THEME_NEUMORPHISM?lv_anim_path_ease_in_out:lv_anim_path_ease_out);
    if(ac_theme_current()==AC_THEME_NEUMORPHISM) reveal_x(o,0);
    else {lv_anim_set_exec_cb(&a,reveal_x); lv_anim_set_values(&a,direction*12,0); lv_anim_start(&a);}
    lv_anim_set_exec_cb(&a,reveal_opa); lv_anim_set_values(&a,40,255); lv_anim_start(&a);
}
void ac_neon_animations(bool enabled) { motion=enabled;ac_theme_set_motion(enabled);lv_style_transition_dsc_init(&transition,props,ac_theme_current()==AC_THEME_NEUMORPHISM?lv_anim_path_ease_in_out:lv_anim_path_ease_out,ac_theme_duration(),0,NULL); }
static void bar_height(void *o,int32_t value)
{
    int bottom=(int)(intptr_t)lv_obj_get_user_data(o);
    lv_obj_set_height(o,value>0?value:1); lv_obj_set_y(o,bottom-value);
}
void ac_neon_bar_to(lv_obj_t *o,int bottom,int height,bool animate)
{
    lv_anim_delete(o,bar_height); lv_obj_set_user_data(o,(void *)(intptr_t)bottom);
    if(!motion || !animate) { bar_height(o,height); return; }
    int start=lv_obj_get_height(o); if(start<=0 || start>170) start=1;
    lv_anim_t a; lv_anim_init(&a); lv_anim_set_var(&a,o); lv_anim_set_exec_cb(&a,bar_height);
    lv_anim_set_values(&a,start,height); lv_anim_set_duration(&a,ac_theme_duration()); lv_anim_set_path_cb(&a,ac_theme_current()==AC_THEME_NEUMORPHISM?lv_anim_path_ease_in_out:lv_anim_path_ease_out); lv_anim_start(&a);
}
