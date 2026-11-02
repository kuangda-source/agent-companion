#include "ac_theme.h"
#include <string.h>
#include <stdlib.h>
static ac_theme_id_t current=AC_THEME_NEON;
static bool motion=true;
static bool pointer_hover=true;
void ac_theme_set_pointer_hover(bool enabled) { pointer_hover=enabled; }
bool ac_theme_pointer_hover_enabled(void) { return pointer_hover; }
bool ac_theme_interaction_hint(const lv_obj_t *obj) { return lv_obj_has_state(obj,LV_STATE_FOCUS_KEY)||(pointer_hover&&lv_obj_has_state(obj,LV_STATE_HOVERED)); }
/* Distinct role colors make the live color mapping reversible. */
static const uint32_t palette[][AC_THEME_COUNT]={
    {0x0a0a0f,0xfffef0,0xe0e5ec}, {0x0c1019,0xffffff,0xe1e6ed},
    {0xe9ffff,0x202020,0x333333}, {0xb8faff,0x333332,0x525c6a},
    {0x70d6e2,0x4a4a4a,0x5b6472}, {0x00ffff,0x3366ff,0x5746c8},
    {0xff00ff,0xff3333,0x806078}, {0x009dff,0x1750c0,0x386e80},
    {0x00ffad,0x238123,0x28664c}, {0xffe600,0x916400,0x795a13},
    {0xff3973,0xcc2020,0xa24b5b}, {0x006877,0x1a1a1a,0xdfe4eb},
    {0x003039,0x555554,0xd9dfe7}, {0x001d25,0xfffce0,0xe0e5eb},
    {0x002832,0xfff8ce,0xdde3eb}, {0x00343e,0xffcc00,0xdce2ea},
    {0x330033,0xffde55,0xd7dee8}, {0x070d17,0xffdc3a,0xd7dde6}
};
static const char *slugs[]={"neon","comic","neumorphism"};
static const char *names[]={"赛博霓虹","漫画风格","新拟物派"};
typedef struct surface {
    lv_obj_t *obj;
    struct surface *next;
    bool flat, interactive;
    int radius, shadow;
    lv_opa_t border_opa, shadow_opa;
} surface_t;
static surface_t *surfaces;
ac_theme_id_t ac_theme_current(void) { return current; }
const char *ac_theme_slug(ac_theme_id_t id) { return slugs[(unsigned)id<AC_THEME_COUNT?id:0]; }
const char *ac_theme_name(ac_theme_id_t id) { return names[(unsigned)id<AC_THEME_COUNT?id:0]; }
bool ac_theme_parse(const char *slug, ac_theme_id_t *id)
{
    for(unsigned i=0;i<AC_THEME_COUNT;++i) if(strcmp(slug,slugs[i])==0) { *id=(ac_theme_id_t)i; return true; }
    return false;
}
uint32_t ac_theme_color(uint32_t canonical)
{
    for(unsigned i=0;i<sizeof(palette)/sizeof(palette[0]);++i) if(palette[i][0]==canonical) return palette[i][current];
    return canonical;
}
lv_color_t ac_color(uint32_t canonical) { return lv_color_hex(ac_theme_color(canonical)); }
static const lv_font_t *font_for(ac_theme_id_t id,unsigned index)
{
    static const lv_font_t *mono[]={&ac_font_mono_13,&ac_font_ui_16,&ac_font_mono_20,&ac_font_display_22};
    static const lv_font_t *comic[]={&ac_font_comic_13,&ac_font_comic_16,&ac_font_mono_20,&ac_font_display_22};
    static const lv_font_t *sans[]={&ac_font_sans_13,&ac_font_sans_16,&ac_font_sans_20,&ac_font_sans_22};
    return id==AC_THEME_NEON?mono[index]:id==AC_THEME_COMIC?comic[index]:sans[index];
}
const lv_font_t *ac_theme_font(unsigned size) { return font_for(current,size==13?0:size==20?2:size==22?3:1); }
int ac_theme_radius(void) { return current==AC_THEME_NEON?2:current==AC_THEME_COMIC?0:18; }
int ac_theme_tracking(void) { return current==AC_THEME_NEON || current==AC_THEME_COMIC?1:0; }
bool ac_theme_dark(void) { return current==AC_THEME_NEON; }
unsigned ac_theme_duration(void) { return !motion?0:current==AC_THEME_COMIC?90:current==AC_THEME_NEUMORPHISM?300:140; }

void ac_theme_dots(lv_layer_t *layer,const lv_area_t *area,lv_opa_t opacity)
{
    static const uint8_t dots[64]={0,0,0,0,0,0,0,0, 0,220,220,0,0,0,0,0, 0,220,220,0,0,0,0,0};
    static const lv_image_dsc_t tile={.header={.magic=LV_IMAGE_HEADER_MAGIC,.cf=LV_COLOR_FORMAT_A8,.w=8,.h=8,.stride=8},.data_size=64,.data=dots};
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=0;d.bg_image_src=&tile;d.bg_image_tiled=1;d.bg_image_opa=opacity;d.bg_image_recolor=lv_color_hex(0x1a1a1a);d.bg_image_recolor_opa=255;
    lv_draw_rect(layer,&d,area);
}
static surface_t *find_surface(lv_obj_t *obj)
{
    for(surface_t *s=surfaces;s;s=s->next) if(s->obj==obj) return s;
    return NULL;
}
static void configure(surface_t *s)
{
    lv_obj_t *o=s->obj;
    bool large=lv_obj_get_style_width(o,0)>=32 && lv_obj_get_style_height(o,0)>=24;
    lv_obj_set_style_radius(o,s->flat?0:large?ac_theme_radius():s->radius,0);
    if(current==AC_THEME_NEON) {
        lv_obj_set_style_border_opa(o,s->border_opa,0);lv_obj_set_style_shadow_width(o,s->shadow,0);lv_obj_set_style_shadow_opa(o,s->shadow_opa,0);
    } else if(large) {lv_obj_set_style_border_opa(o,0,0);lv_obj_set_style_shadow_width(o,current==AC_THEME_NEUMORPHISM?16:0,0);lv_obj_set_style_shadow_opa(o,0,0);}
    if(s->interactive) {
        const lv_state_t states[]={LV_STATE_FOCUS_KEY,LV_STATE_HOVERED};
        bool pop=current==AC_THEME_COMIC && motion && lv_obj_get_style_width(o,0)<200 && lv_obj_get_style_height(o,0)<50;
        for(unsigned i=0;i<(pointer_hover?2u:1u);++i) {
            lv_obj_set_style_border_opa(o,current==AC_THEME_NEON?255:0,states[i]);
            lv_obj_set_style_shadow_width(o,current==AC_THEME_NEON?20:current==AC_THEME_NEUMORPHISM?8:0,states[i]);
            lv_obj_set_style_shadow_opa(o,current==AC_THEME_NEON?LV_OPA_40:0,states[i]);
            lv_obj_set_style_transform_scale_x(o,pop?282:256,states[i]);lv_obj_set_style_transform_scale_y(o,pop?282:256,states[i]);
            lv_obj_set_style_transform_rotation(o,pop?-30:0,states[i]);
        }
        lv_obj_set_style_border_opa(o,current==AC_THEME_NEON?255:0,LV_STATE_PRESSED);
        lv_obj_set_style_outline_width(o,0,0);lv_obj_set_style_outline_opa(o,0,0);
        lv_obj_set_style_outline_opa(o,current==AC_THEME_NEUMORPHISM?255:0,LV_STATE_PRESSED);
        lv_obj_set_style_translate_x(o,0,0);lv_obj_set_style_translate_y(o,0,0);
    }
    lv_obj_refresh_ext_draw_size(o);
}
static void inset(lv_layer_t *layer,lv_area_t area,int radius,unsigned amount)
{
    for(int i=0;i<5;++i) {
        lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=0;d.radius=radius-i;d.border_width=1;d.border_opa=(lv_opa_t)((90-i*15)*amount/255);
        d.border_side=LV_BORDER_SIDE_TOP|LV_BORDER_SIDE_LEFT;d.border_color=lv_color_hex(0xb8bcc2);lv_draw_rect(layer,&d,&area);
        d.border_side=LV_BORDER_SIDE_BOTTOM|LV_BORDER_SIDE_RIGHT;d.border_color=lv_color_white();lv_draw_rect(layer,&d,&area);
        area.x1++;area.y1++;area.x2--;area.y2--;
    }
}
static void surface_event(lv_event_t *e)
{
    surface_t *s=lv_event_get_user_data(e);lv_event_code_t code=lv_event_get_code(e);
    if(code==LV_EVENT_DELETE) {
        surface_t **at=&surfaces;while(*at && *at!=s) at=&(*at)->next;if(*at) *at=s->next;free(s);return;
    }
    if(current==AC_THEME_NEON || lv_obj_get_width(s->obj)<32 || lv_obj_get_height(s->obj)<24) return;
    if(code==LV_EVENT_REFR_EXT_DRAW_SIZE) {if(!s->flat) lv_event_set_ext_draw_size(e,current==AC_THEME_COMIC?8:24);return;}
    if(code!=LV_EVENT_DRAW_MAIN_BEGIN && code!=LV_EVENT_DRAW_MAIN_END) return;
    lv_area_t area;lv_obj_get_coords(s->obj,&area);lv_layer_t *layer=lv_event_get_layer(e);
    bool pressed=lv_obj_has_state(s->obj,LV_STATE_PRESSED),hover=ac_theme_interaction_hint(s->obj);
    bool selected=lv_obj_has_state(s->obj,LV_STATE_CHECKED);
    unsigned pressure=selected?255:s->interactive?lv_obj_get_style_outline_opa(s->obj,0):0;
    if(code==LV_EVENT_DRAW_MAIN_BEGIN && !s->flat) {
        lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=0;
        if(current==AC_THEME_COMIC) {
            if(!pressed) {lv_area_move(&area,4,4);d.bg_color=lv_color_hex(0x1a1a1a);d.bg_opa=255;lv_draw_rect(layer,&d,&area);}
        } else if(pressure<255) {
            int width=lv_obj_get_style_shadow_width(s->obj,0);if(width<1) width=1;
            int offset=width/2;d.radius=18;d.shadow_width=width;d.shadow_opa=(lv_opa_t)(150*(255-pressure)/255);
            d.shadow_color=lv_color_hex(0xb8bcc2);d.shadow_offset_x=offset;d.shadow_offset_y=offset;lv_draw_rect(layer,&d,&area);
            d.shadow_color=lv_color_white();d.shadow_offset_x=-offset;d.shadow_offset_y=-offset;lv_draw_rect(layer,&d,&area);
        }
    }
    if(code==LV_EVENT_DRAW_MAIN_END) {
        if(current==AC_THEME_COMIC) {
            if(hover && s->interactive) ac_theme_dots(layer,&area,25);
            lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=0;d.border_color=lv_color_hex(0x1a1a1a);d.border_opa=255;
            if(!s->flat) {d.border_width=4;lv_draw_rect(layer,&d,&area);}
            else if(s->interactive) {d.border_width=2;d.border_side=LV_BORDER_SIDE_BOTTOM;lv_draw_rect(layer,&d,&area);}
            if(selected && !s->flat) {lv_area_t tag={area.x2-17,area.y1+6,area.x2-7,area.y1+16};d.border_width=2;d.bg_opa=255;d.bg_color=lv_color_hex(0xffcc00);lv_draw_rect(layer,&d,&tag);}
        } else if(pressure && (s->interactive || !s->flat)) inset(layer,area,s->flat?12:18,pressure);
    }
}
void ac_theme_surface(lv_obj_t *obj,bool flat,bool interactive)
{
    surface_t *s=find_surface(obj);
    if(!s) {
        s=calloc(1,sizeof(*s));if(!s) return;s->obj=obj;s->radius=2;s->border_opa=LV_OPA_30;s->next=surfaces;surfaces=s;
        lv_obj_add_event_cb(obj,surface_event,LV_EVENT_ALL,s);
    }
    if(!interactive || flat) s->flat=flat;
    s->interactive=interactive||s->interactive;
    if(flat) {s->radius=0;s->border_opa=0;}
    configure(s);
}
void ac_theme_selected(lv_obj_t *obj,bool selected)
{
    if(selected) lv_obj_add_state(obj,LV_STATE_CHECKED);else lv_obj_remove_state(obj,LV_STATE_CHECKED);
}
void ac_theme_set_motion(bool enabled) {motion=enabled;for(surface_t *s=surfaces;s;s=s->next) configure(s);}
static void restyle(lv_obj_t *o, ac_theme_id_t old)
{
    surface_t *binding=find_surface(o);
    if(binding && old==AC_THEME_NEON) {
        lv_style_value_t v;
        if(lv_obj_get_local_style_prop(o,LV_STYLE_RADIUS,&v,0)==LV_STYLE_RES_FOUND) binding->radius=v.num;
        if(lv_obj_get_local_style_prop(o,LV_STYLE_BORDER_OPA,&v,0)==LV_STYLE_RES_FOUND) binding->border_opa=(lv_opa_t)v.num;
        if(lv_obj_get_local_style_prop(o,LV_STYLE_SHADOW_WIDTH,&v,0)==LV_STYLE_RES_FOUND) binding->shadow=v.num;
        if(lv_obj_get_local_style_prop(o,LV_STYLE_SHADOW_OPA,&v,0)==LV_STYLE_RES_FOUND) binding->shadow_opa=(lv_opa_t)v.num;
    }
    static const lv_style_prop_t colors[]={LV_STYLE_BG_COLOR,LV_STYLE_TEXT_COLOR,LV_STYLE_BORDER_COLOR,LV_STYLE_SHADOW_COLOR,LV_STYLE_OUTLINE_COLOR};
    static const lv_style_selector_t states[]={0,LV_STATE_HOVERED,LV_STATE_FOCUS_KEY,LV_STATE_PRESSED};
    for(unsigned s=0;s<sizeof(states)/sizeof(states[0]);++s) {
        for(unsigned p=0;p<sizeof(colors)/sizeof(colors[0]);++p) {
            lv_style_value_t v;if(lv_obj_get_local_style_prop(o,colors[p],&v,states[s])!=LV_STYLE_RES_FOUND) continue;
            uint32_t color=lv_color_to_u32(v.color)&0xffffff;
            for(unsigned i=0;i<sizeof(palette)/sizeof(palette[0]);++i) if(palette[i][old]==color) {v.color=lv_color_hex(palette[i][current]);lv_obj_set_local_style_prop(o,colors[p],v,states[s]);break;}
        }
        lv_style_value_t v;
        if(lv_obj_get_local_style_prop(o,LV_STYLE_TEXT_FONT,&v,states[s])==LV_STYLE_RES_FOUND) {
            for(unsigned i=0;i<4;++i) if(v.ptr==font_for(old,i)) {v.ptr=font_for(current,i);lv_obj_set_local_style_prop(o,LV_STYLE_TEXT_FONT,v,states[s]);break;}
        }
        if(lv_obj_get_local_style_prop(o,LV_STYLE_TEXT_LETTER_SPACE,&v,states[s])==LV_STYLE_RES_FOUND && v.num==(old==AC_THEME_NEUMORPHISM?0:1)) {v.num=ac_theme_tracking();lv_obj_set_local_style_prop(o,LV_STYLE_TEXT_LETTER_SPACE,v,states[s]);}
    }
    if(binding) configure(binding);
    for(uint32_t i=0;i<lv_obj_get_child_count(o);++i) restyle(lv_obj_get_child(o,(int32_t)i),old);
}
void ac_theme_apply(lv_obj_t *root, ac_theme_id_t theme)
{
    if(theme>=AC_THEME_COUNT || theme==current) return;
    ac_theme_id_t old=current;current=theme;restyle(root,old);lv_obj_set_style_text_font(root,ac_theme_font(16),0);lv_obj_invalidate(root);
}
