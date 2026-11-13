#pragma once
#include "lvgl.h"
#include <stdbool.h>
void ac_volume_panel_create(lv_obj_t *screen,bool mock);
void ac_volume_panel_handler(void (*settings)(unsigned,bool),void (*stop)(void));
void ac_volume_panel_update(unsigned volume,bool muted);
void ac_volume_panel_open(void);
bool ac_volume_panel_close(void);
void ac_volume_panel_destroy(void);
