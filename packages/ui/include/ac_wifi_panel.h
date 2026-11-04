#ifndef AC_WIFI_PANEL_H
#define AC_WIFI_PANEL_H
#include "lvgl.h"
#include "ac_wifi.h"
typedef bool (*ac_wifi_scan_fn)(void);
typedef bool (*ac_wifi_join_fn)(const ac_wifi_join_t *request);
void ac_wifi_panel_create(lv_obj_t *screen,bool mock);
void ac_wifi_panel_handlers(ac_wifi_scan_fn scan,ac_wifi_join_fn join);
void ac_wifi_panel_update(const ac_wifi_status_t *status);
void ac_wifi_panel_open(void);
bool ac_wifi_panel_close(void);
bool ac_wifi_panel_visible(void);
bool ac_wifi_panel_scroll_at(int x,int y,int delta);
void ac_wifi_panel_destroy(void);
#endif
