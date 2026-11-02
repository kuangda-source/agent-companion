#ifndef AC_USAGE_PANEL_H
#define AC_USAGE_PANEL_H
#include "lvgl.h"
#include "ac_model.h"
void ac_usage_panel_create(lv_obj_t *parent,void (*on_close)(void));
void ac_usage_panel_open(const ac_usage_stats_t *stats,unsigned days);
void ac_usage_panel_update(const ac_usage_stats_t *stats);
void ac_usage_panel_filter(int agent);
void ac_usage_panel_hide(void);
#endif
