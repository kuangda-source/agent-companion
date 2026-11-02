#ifndef AC_NEON_H
#define AC_NEON_H
#include "lvgl.h"
#include "ac_theme.h"
enum { AC_NEON_BG=0x0a0a0f, AC_NEON_SURFACE=0x0c1019, AC_NEON_CYAN=0x00ffff,
       AC_NEON_MAGENTA=0xff00ff, AC_NEON_BLUE=0x009dff, AC_NEON_TEXT=0xe9ffff,
       AC_NEON_MUTED=0x70d6e2, AC_NEON_GREEN=0x00ffad, AC_NEON_YELLOW=0xffe600, AC_NEON_ERROR=0xff3973 };
uint32_t ac_neon_color(uint32_t color);
lv_obj_t *ac_neon_box(lv_obj_t *parent,int x,int y,int width,int height,uint32_t color);
lv_obj_t *ac_neon_text(lv_obj_t *parent,int x,int y,const char *value,uint32_t color);
void ac_neon_flat(lv_obj_t *obj);
void ac_neon_rule(lv_obj_t *parent,int x,int y,int width,uint32_t color,lv_opa_t opacity);
void ac_neon_glow_text(lv_obj_t *label);
void ac_neon_scanlines(lv_obj_t *obj);
void ac_neon_grid(lv_obj_t *obj);
void ac_neon_interactive(lv_obj_t *obj,uint32_t accent);
void ac_neon_reveal(lv_obj_t *obj,int direction,unsigned delay);
void ac_neon_animations(bool enabled);
void ac_neon_bar_to(lv_obj_t *obj,int bottom,int height,bool animate);
#endif
