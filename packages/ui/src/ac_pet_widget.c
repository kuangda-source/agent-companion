#include "ac_pet_widget.h"
#include "ac_pet_player.h"
#include "ac_neon.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

struct ac_pet_widget {
    lv_obj_t *root, *stage, *rim, *art, *head, *body, *eyes[2], *caption, *image, *ghost, *signal, *effects[4], *blink_clip, *blink_image;
    const ac_pet_assets_t *assets;
    ac_pet_player_t player;
    uint64_t last_tick;
    uint16_t frame;
    uint32_t frame_updates;
    uint32_t color;
    ac_pet_sample_t last_sample;
    bool sampled;
    unsigned agent;
    uint64_t fade_until;
    float camera_x, camera_y;
    int8_t parallax_x, parallax_y;
    bool selected, stage_dirty, blink_visible;
};
static const uint16_t fallback_frame[] = {0};
enum { POSE_FADE_MS=180 };
#define FALLBACK(m, e) {.frame_ids=fallback_frame, .frame_count=1, .fps=8, .loop=true, .motion=m, .effect=e}
static const ac_pet_pack_t fallback_pack = {.unique_frame_count=1, .clips={
    FALLBACK(AC_PET_MOTION_BREATHE, AC_PET_EFFECT_NONE),
    FALLBACK(AC_PET_MOTION_BREATHE, AC_PET_EFFECT_ACTIVITY_DOTS),
    FALLBACK(AC_PET_MOTION_BREATHE, AC_PET_EFFECT_ATTENTION),
    FALLBACK(AC_PET_MOTION_NONE, AC_PET_EFFECT_ERROR_MARK),
    FALLBACK(AC_PET_MOTION_NONE, AC_PET_EFFECT_NONE),
    FALLBACK(AC_PET_MOTION_NONE, AC_PET_EFFECT_NONE),
    FALLBACK(AC_PET_MOTION_NONE, AC_PET_EFFECT_SPARKLE)
}};
static lv_obj_t *shape(lv_obj_t *parent, int x, int y, int w, int h)
{
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_set_pos(obj, x, y); lv_obj_set_size(obj, w, h);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(obj, LV_OBJ_FLAG_EVENT_BUBBLE);
    return obj;
}

static void stage_line(lv_layer_t *layer, int ox, int oy, int x1, int y1, int x2, int y2,
                       lv_color_t color, lv_opa_t opacity)
{
    lv_draw_line_dsc_t d; lv_draw_line_dsc_init(&d);
    d.p1=(lv_point_precise_t){ox+x1,oy+y1}; d.p2=(lv_point_precise_t){ox+x2,oy+y2};
    d.color=color; d.opa=opacity; d.width=ac_theme_current()==AC_THEME_COMIC?2:1;
    lv_draw_line(layer,&d);
}

static void stage_polygon(lv_layer_t *layer, int ox, int oy, const lv_point_t *points,
                          unsigned count, lv_color_t color)
{
    lv_draw_triangle_dsc_t d; lv_draw_triangle_dsc_init(&d); d.color=color; d.opa=LV_OPA_COVER;
    d.p[0]=(lv_point_precise_t){ox+points[0].x,oy+points[0].y};
    for(unsigned i=1;i+1<count;++i) {
        d.p[1]=(lv_point_precise_t){ox+points[i].x,oy+points[i].y};
        d.p[2]=(lv_point_precise_t){ox+points[i+1].x,oy+points[i+1].y};
        lv_draw_triangle(layer,&d);
    }
}

/* Small raster ellipses keep the contact shadow soft without a blur buffer. */
static void stage_ellipse(lv_layer_t *layer, int cx, int cy, int rx, int ry,
                          lv_color_t color, lv_opa_t opacity)
{
    for(int y=-ry;y<=ry;++y) {
        float v=(float)y/(float)(ry+1);
        int half=(int)lroundf((float)rx*sqrtf(1.0f-v*v));
        stage_line(layer,cx,cy,-half,y,half,y,color,opacity);
    }
}

static void stage_draw(lv_event_t *event)
{
    ac_pet_widget_t *pet=lv_event_get_user_data(event);
    bool front=lv_event_get_current_target_obj(event)==pet->rim;
    lv_area_t bounds; lv_obj_get_coords(lv_event_get_current_target_obj(event),&bounds);
    int ox=bounds.x1+pet->parallax_x/3, oy=bounds.y1+pet->parallax_y/2;
    lv_layer_t *layer=lv_event_get_layer(event);
    lv_color_t accent=ac_color(pet->color), dark=ac_color(0x070d17);
    if(ac_theme_current()==AC_THEME_NEUMORPHISM) {
        int cx=ox+56,cy=oy+104,lift=pet->last_sample.y<0?-pet->last_sample.y:0;
        if(front) {stage_ellipse(layer,cx+2,cy+4,43,2,lv_color_hex(0xb8bcc2),70);return;}
        stage_ellipse(layer,cx+3,cy+3,48,5,lv_color_hex(0xb8bcc2),100);
        stage_ellipse(layer,cx-3,cy-2,48,4,lv_color_white(),120);
        stage_ellipse(layer,cx,cy,46,4,lv_color_hex(0xe0e5ec),255);
        stage_ellipse(layer,cx+pet->parallax_x/2,cy,17-lift/2,2,lv_color_hex(0xb8bcc2),(lv_opa_t)(170-lift*10));return;
    }
    bool comic=ac_theme_current()==AC_THEME_COMIC;
    if(comic) {accent=lv_color_hex(0x1a1a1a);dark=lv_color_hex(0xffcc00);}
    lv_color_t top=lv_color_mix(accent,dark,24), edge=lv_color_mix(accent,dark,48);
    if(comic) top=lv_color_hex(0xffcc00);
    const lv_point_t face[][4]={
        {{103,102},{88,108},{88,111},{103,105}},
        {{88,108},{24,108},{24,111},{88,111}},
        {{24,108},{9,102},{9,105},{24,111}}
    };
    if(front) {
        stage_polygon(layer,ox,oy,face[0],4,edge);
        stage_polygon(layer,ox,oy,face[1],4,lv_color_mix(accent,dark,36));
        stage_polygon(layer,ox,oy,face[2],4,lv_color_mix(accent,dark,18));
        int strength=comic?255:pet->selected?220:135;
        stage_line(layer,ox,oy,9,102,24,108,accent,strength/2);
        stage_line(layer,ox,oy,24,108,88,108,accent,strength);
        stage_line(layer,ox,oy,88,108,103,102,accent,strength*3/4);
        stage_line(layer,ox,oy,24,111,88,111,accent,strength/3);
        if(comic) return;
        int highlight=pet->parallax_x*2;
        stage_line(layer,ox,oy,44+highlight,108,67+highlight,108,
                   lv_color_mix(lv_color_white(),accent,150),pet->selected?230:150);
        return;
    }
    if(!comic) stage_ellipse(layer,ox+56,oy+108,50,3,accent,18);
    const lv_point_t surface[]={{24,96},{88,96},{103,102},{88,108},{24,108},{9,102}};
    stage_polygon(layer,ox,oy,surface,6,top);
    for(unsigned i=0;i<6;++i) stage_line(layer,ox,oy,surface[i].x,surface[i].y,
        surface[(i+1)%6].x,surface[(i+1)%6].y,accent,comic?255:pet->selected?130:75);
    if(comic) {stage_ellipse(layer,ox+58,oy+105,19,2,lv_color_hex(0x1a1a1a),220);return;}
    /* Receding seams and an inset ring establish a plane under the feet. */
    stage_line(layer,ox,oy,39,97,31,107,accent,35);
    stage_line(layer,ox,oy,73,97,81,107,accent,35);
    stage_line(layer,ox,oy,14,102,98,102,accent,30);
    const lv_point_t inner[]={{34,99},{78,99},{89,103},{78,106},{34,106},{23,103}};
    for(unsigned i=0;i<6;++i) stage_line(layer,ox,oy,inner[i].x,inner[i].y,
        inner[(i+1)%6].x,inner[(i+1)%6].y,accent,50);
    int lift=pet->last_sample.y<0?-pet->last_sample.y:0;
    int sx=ox+57+(pet->last_sample.x+pet->parallax_x)/2, sy=oy+104;
    stage_ellipse(layer,sx,sy,24-lift/2,4,lv_color_black(),35);
    stage_ellipse(layer,sx,sy,18-lift/2,3,lv_color_black(),65);
    stage_ellipse(layer,sx,sy,12-lift/3,1,lv_color_black(),(lv_opa_t)(150-lift*12));
}

static bool update_parallax(ac_pet_widget_t *pet, uint64_t delta)
{
    float target_x=0, target_y=0;
    if(pet->player.animation_enabled) {
        lv_area_t area; lv_obj_get_coords(pet->root,&area);
        for(lv_indev_t *input=lv_indev_get_next(NULL);input;input=lv_indev_get_next(input)) {
            if(lv_indev_get_type(input)!=LV_INDEV_TYPE_POINTER) continue;
            lv_point_t point; lv_indev_get_point(input,&point);
            if(point.x>=area.x1 && point.x<=area.x2 && point.y>=area.y1 && point.y<=area.y2) {
                target_x=(point.x-area.x1-55.5f)/55.5f;
                target_y=(point.y-area.y1-55.5f)/55.5f;
                break;
            }
        }
        float weight=(float)(delta>32?32:delta)/100.0f;
        pet->camera_x+=(target_x-pet->camera_x)*weight;
        pet->camera_y+=(target_y-pet->camera_y)*weight;
    } else pet->camera_x=pet->camera_y=0;
    int8_t x=(int8_t)lroundf(pet->camera_x*3), y=(int8_t)lroundf(pet->camera_y*2);
    bool changed=x!=pet->parallax_x || y!=pet->parallax_y;
    pet->parallax_x=x; pet->parallax_y=y;
    return changed;
}

ac_pet_widget_t *ac_pet_widget_create(lv_obj_t *parent, const ac_pet_assets_t *assets)
{
    ac_pet_widget_t *pet = calloc(1, sizeof(*pet));
    if(!pet) return NULL;
    pet->assets = assets; pet->frame = UINT16_MAX;
    pet->player.random_state=(uint32_t)((uintptr_t)pet>>4)^(uint32_t)lv_tick_get()^0xa341316cu;
    pet->root = shape(parent, 0, 0, AC_PET_RENDER_SIZE, AC_PET_RENDER_SIZE);
    pet->stage=shape(pet->root,0,0,AC_PET_RENDER_SIZE,AC_PET_RENDER_SIZE);
    lv_obj_add_event_cb(pet->stage,stage_draw,LV_EVENT_DRAW_MAIN,pet);
    pet->art = shape(pet->root, 0, 0, AC_PET_RENDER_SIZE, AC_PET_RENDER_SIZE);
    if(assets && assets->pack && assets->frames) {
        pet->ghost=lv_image_create(pet->art); lv_obj_remove_flag(pet->ghost,LV_OBJ_FLAG_CLICKABLE); lv_obj_add_flag(pet->ghost,LV_OBJ_FLAG_HIDDEN|LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_image_set_pivot(pet->ghost,56,103); lv_image_set_antialias(pet->ghost,true);
        pet->image = lv_image_create(pet->art);
        lv_obj_remove_flag(pet->image, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_flag(pet->image, LV_OBJ_FLAG_EVENT_BUBBLE);
        lv_image_set_src(pet->image, assets->frames[assets->pack->poster_frame_id]);
        lv_image_set_pivot(pet->image,56,103); lv_image_set_antialias(pet->image,true);
        if(assets->blink && assets->blink->frame_id<assets->pack->unique_frame_count) {
            const ac_pet_blink_t *blink=assets->blink;
            pet->blink_clip=shape(pet->art,blink->x,blink->y,blink->width,blink->height);
            pet->blink_image=lv_image_create(pet->blink_clip);
            lv_obj_remove_flag(pet->blink_image,LV_OBJ_FLAG_CLICKABLE);
            lv_image_set_src(pet->blink_image,assets->frames[blink->frame_id]);
            lv_obj_set_pos(pet->blink_image,-blink->x,-blink->y);
            lv_image_set_pivot(pet->blink_image,56,103);lv_image_set_antialias(pet->blink_image,true);
            lv_obj_add_flag(pet->blink_clip,LV_OBJ_FLAG_HIDDEN);
        }
    } else {
        pet->head = shape(pet->art, 27, 17, 58, 52);
        lv_obj_set_style_radius(pet->head, 17, 0);
        lv_obj_set_style_bg_opa(pet->head, LV_OPA_20, 0);
        lv_obj_set_style_border_width(pet->head, 2, 0);
        pet->body = shape(pet->art, 35, 71, 42, 17);
        lv_obj_set_style_bg_opa(pet->body, LV_OPA_20, 0);
        lv_obj_set_style_radius(pet->body, 8, 0);
        for(int i = 0; i < 2; ++i) {
            pet->eyes[i] = shape(pet->art, 39 + 23 * i, 35, 10, 14);
            lv_obj_set_style_radius(pet->eyes[i], 4, 0);
            lv_obj_set_style_bg_opa(pet->eyes[i], LV_OPA_COVER, 0);
        }
        pet->caption = lv_label_create(pet->art);
        lv_label_set_text(pet->caption, "PLACEHOLDER");
        lv_obj_set_style_text_font(pet->caption, ac_theme_font(13), 0);
        lv_obj_set_style_text_color(pet->caption, ac_color(0xb8faff), 0);
        lv_obj_align(pet->caption, LV_ALIGN_BOTTOM_MID, 0, -10);
        lv_obj_add_flag(pet->caption, LV_OBJ_FLAG_EVENT_BUBBLE);
    }
    pet->rim=shape(pet->root,0,0,AC_PET_RENDER_SIZE,AC_PET_RENDER_SIZE);
    lv_obj_add_event_cb(pet->rim,stage_draw,LV_EVENT_DRAW_MAIN,pet);
    for(int i = 0; i < 4; ++i) {
        pet->effects[i] = lv_label_create(pet->root);
        lv_obj_set_style_text_font(pet->effects[i], ac_theme_font(20), 0);
        lv_obj_add_flag(pet->effects[i], LV_OBJ_FLAG_EVENT_BUBBLE | LV_OBJ_FLAG_HIDDEN);
    }
    pet->signal=shape(pet->root,94,5,10,2); lv_obj_set_style_bg_opa(pet->signal,LV_OPA_COVER,0);
    return pet;
}
void ac_pet_widget_set_view(ac_pet_widget_t *pet, const ac_pet_view_t *view)
{
    static const uint32_t accents[AC_AGENT_COUNT] = {0x00ffff, 0xff00ff, 0x009dff};
    uint32_t color=accents[view->agent_id < AC_AGENT_COUNT ? view->agent_id : 0];
    if(color!=pet->color || view->selected!=pet->selected) pet->stage_dirty=true;
    pet->color=color; pet->selected=view->selected;
    pet->agent=(unsigned)view->agent_id;
    if(pet->head) {
        lv_color_t color = ac_color(pet->color);
        lv_obj_set_style_bg_color(pet->head, color, 0); lv_obj_set_style_border_color(pet->head, color, 0);
        lv_obj_set_style_bg_color(pet->body, color, 0);
        for(int i = 0; i < 2; ++i) lv_obj_set_style_bg_color(pet->eyes[i], color, 0);
    }
    ac_pet_player_set(&pet->player, view, pet->assets ? pet->assets->pack : &fallback_pack, pet->last_tick);
}
void ac_pet_widget_tick(ac_pet_widget_t *pet, uint64_t now_ms)
{
    /* The caller paces frames. A 15ms rounded tick is valid in a 60Hz loop. */
    if(now_ms - pet->last_tick < 8) return;
    uint64_t delta=now_ms-pet->last_tick;
    pet->last_tick = now_ms;
    bool parallax_changed=update_parallax(pet,delta);
    const ac_pet_pack_t *pack = pet->assets ? pet->assets->pack : &fallback_pack;
    ac_pet_sample_t sample = ac_pet_player_sample(&pet->player, pack, now_ms);
    ac_pet_sample_t old=pet->last_sample;
    if(pet->sampled && !parallax_changed && !pet->stage_dirty && sample.expression==old.expression && sample.frame_id==old.frame_id && sample.x==old.x && sample.y==old.y && sample.rotation==old.rotation && sample.scale_x==old.scale_x && sample.scale_y==old.scale_y && sample.eyes_closed==old.eyes_closed && sample.effect==old.effect && memcmp(sample.effect_opa,old.effect_opa,4)==0 && now_ms>=pet->fade_until) return;
    bool changed=pet->sampled && sample.expression!=old.expression;
    if(!pet->sampled || changed) {
        static const char *expressions[]={"idle","running","waiting","error","offline","unknown","celebrate"};
        printf("PET agent=%u expression=%s frame=%u at_ms=%llu\n",pet->agent,expressions[sample.expression],sample.frame_id,(unsigned long long)now_ms); fflush(stdout);
        if(changed && pet->image && pet->player.animation_enabled && pet->frame<pack->unique_frame_count) {
            lv_image_set_src(pet->ghost,pet->assets->frames[pet->frame]); lv_obj_remove_flag(pet->ghost,LV_OBJ_FLAG_HIDDEN); pet->fade_until=now_ms+POSE_FADE_MS;
        } else pet->fade_until=0;
    }
    bool stage_changed=!pet->sampled || pet->stage_dirty || parallax_changed || sample.x!=old.x || sample.y!=old.y;
    pet->last_sample=sample; pet->sampled=true; pet->stage_dirty=false;
    if(stage_changed) { lv_obj_invalidate(pet->stage); lv_obj_invalidate(pet->rim); }
    int art_y=sample.y+pet->parallax_y;
    int art_x=sample.x+pet->parallax_x;
    if(art_x < -4) art_x=-4;
    if(art_x > 4) art_x=4;
    if(art_y < -6) art_y=-6;
    if(art_y > 5) art_y=5;
    lv_obj_set_pos(pet->art, art_x, art_y);
    if(pet->image) {
        int rotation=sample.rotation+pet->parallax_x*2;
        lv_image_set_rotation(pet->image,rotation<0?3600+rotation:rotation);
        lv_image_set_scale_x(pet->image,sample.scale_x-abs(pet->parallax_x)); lv_image_set_scale_y(pet->image,sample.scale_y);
        if(pet->blink_image) {
            bool visible=sample.eyes_closed && (pet->assets->blink->expression_mask & (1u<<sample.expression)) && now_ms>=pet->fade_until;
            lv_image_set_rotation(pet->blink_image,rotation<0?3600+rotation:rotation);
            lv_image_set_scale_x(pet->blink_image,sample.scale_x-abs(pet->parallax_x));lv_image_set_scale_y(pet->blink_image,sample.scale_y);
            if(visible) lv_obj_remove_flag(pet->blink_clip,LV_OBJ_FLAG_HIDDEN);else lv_obj_add_flag(pet->blink_clip,LV_OBJ_FLAG_HIDDEN);
            if(visible!=pet->blink_visible) {
                printf("PET agent=%u blink=%s at_ms=%llu\n",pet->agent,visible?"closed":"open",(unsigned long long)now_ms);fflush(stdout);pet->blink_visible=visible;
            }
        }
        if(now_ms<pet->fade_until && pet->player.animation_enabled) {
            unsigned incoming=(unsigned)((POSE_FADE_MS-(pet->fade_until-now_ms))*255/POSE_FADE_MS);
            lv_obj_set_style_opa(pet->image,(lv_opa_t)incoming,0); lv_obj_set_style_opa(pet->ghost,(lv_opa_t)(255-incoming),0);
        } else { lv_obj_set_style_opa(pet->image,LV_OPA_COVER,0); lv_obj_add_flag(pet->ghost,LV_OBJ_FLAG_HIDDEN); pet->fade_until=0; }
    }
    if(pet->image && pet->frame != sample.frame_id && sample.frame_id < pack->unique_frame_count) {
        lv_image_set_src(pet->image, pet->assets->frames[sample.frame_id]); pet->frame = sample.frame_id; pet->frame_updates++;
    }
    if(pet->eyes[0]) for(int i = 0; i < 2; ++i) lv_obj_set_height(pet->eyes[i], sample.expression == AC_PET_OFFLINE ? 3 : 14);
    lv_obj_set_style_bg_color(pet->signal,ac_color(sample.expression==AC_PET_ERROR?AC_NEON_ERROR:sample.expression==AC_PET_WAITING?AC_NEON_YELLOW:pet->color),0);
    lv_obj_set_style_opa(pet->signal,pet->player.animation_enabled?sample.effect_opa[0]:LV_OPA_50,0);
    for(int i = 0; i < 4; ++i) {
        lv_obj_t *effect = pet->effects[i]; bool visible = false;
        if(sample.effect == AC_PET_EFFECT_ACTIVITY_DOTS && i < 3) {
            lv_label_set_text(effect, "|"); lv_obj_set_style_text_font(effect,ac_theme_font(13),0); lv_obj_set_pos(effect, 92 + i * 5, 88 - sample.effect_opa[i]/52);
            lv_obj_set_style_text_color(effect, ac_color(pet->color), 0);
            lv_obj_set_style_opa(effect, sample.effect_opa[i], 0); visible = true;
        } else if((sample.effect == AC_PET_EFFECT_ATTENTION || sample.effect == AC_PET_EFFECT_ERROR_MARK) && i == 0) {
            lv_obj_set_style_text_font(effect,ac_theme_font(20),0);
            lv_label_set_text(effect, "!"); lv_obj_set_pos(effect, 88, 9);
            lv_obj_set_style_text_color(effect, ac_color(sample.effect == AC_PET_EFFECT_ERROR_MARK ? 0xff3973 : 0xffe600), 0);
            lv_obj_set_style_opa(effect,sample.effect==AC_PET_EFFECT_ERROR_MARK?LV_OPA_COVER:sample.effect_opa[0],0); visible = true;
        } else if(sample.effect == AC_PET_EFFECT_SPARKLE) {
            lv_obj_set_style_text_font(effect,ac_theme_font(20),0);
            static const int x[] = {14, 87, 16, 86}, y[] = {13, 17, 76, 78};
            lv_label_set_text(effect, "+"); lv_obj_set_pos(effect, x[i], y[i] - sample.effect_opa[i]/55);
            lv_obj_set_style_text_color(effect, ac_color(i % 2 ? 0xff00ff : pet->color), 0);
            lv_obj_set_style_opa(effect,sample.effect_opa[i],0); visible = true;
        }
        if(visible) lv_obj_remove_flag(effect, LV_OBJ_FLAG_HIDDEN); else lv_obj_add_flag(effect, LV_OBJ_FLAG_HIDDEN);
    }
}
uint32_t ac_pet_widget_frame_updates(const ac_pet_widget_t *pet){return pet?pet->frame_updates:0;}
void ac_pet_widget_destroy(ac_pet_widget_t *pet)
{
    if(!pet) return;
    lv_obj_delete(pet->root); free(pet);
}
