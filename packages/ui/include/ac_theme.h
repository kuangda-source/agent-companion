#ifndef AC_THEME_H
#define AC_THEME_H
#include "lvgl.h"
typedef enum { AC_THEME_NEON, AC_THEME_COMIC, AC_THEME_NEUMORPHISM, AC_THEME_COUNT } ac_theme_id_t;
LV_FONT_DECLARE(ac_font_ui_16)
LV_FONT_DECLARE(ac_font_mono_13)
LV_FONT_DECLARE(ac_font_mono_20)
LV_FONT_DECLARE(ac_font_display_22)
LV_FONT_DECLARE(ac_font_sans_13)
LV_FONT_DECLARE(ac_font_sans_16)
LV_FONT_DECLARE(ac_font_sans_20)
LV_FONT_DECLARE(ac_font_sans_22)
LV_FONT_DECLARE(ac_font_comic_13)
LV_FONT_DECLARE(ac_font_comic_16)
ac_theme_id_t ac_theme_current(void);
const char *ac_theme_slug(ac_theme_id_t theme);
const char *ac_theme_name(ac_theme_id_t theme);
bool ac_theme_parse(const char *slug, ac_theme_id_t *theme);
uint32_t ac_theme_color(uint32_t canonical);
lv_color_t ac_color(uint32_t canonical);
const lv_font_t *ac_theme_font(unsigned size);
int ac_theme_radius(void);
int ac_theme_tracking(void);
bool ac_theme_dark(void);
/* Styles are attached to existing objects and released with their owner. */
void ac_theme_surface(lv_obj_t *obj, bool flat, bool interactive);
void ac_theme_selected(lv_obj_t *obj, bool selected);
void ac_theme_set_motion(bool enabled);
unsigned ac_theme_duration(void);
void ac_theme_dots(lv_layer_t *layer, const lv_area_t *area, lv_opa_t opacity);
/* Restyles existing objects: selection, scroll, clip clocks and live data survive. */
void ac_theme_apply(lv_obj_t *root, ac_theme_id_t theme);
/* Configure pointer capability before creating widgets: touch has no hover. */
void ac_theme_set_pointer_hover(bool enabled);
bool ac_theme_pointer_hover_enabled(void);
bool ac_theme_interaction_hint(const lv_obj_t *obj);
#endif
