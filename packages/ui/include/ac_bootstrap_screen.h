#ifndef AC_BOOTSTRAP_SCREEN_H
#define AC_BOOTSTRAP_SCREEN_H

#include <stdint.h>
#include <stdbool.h>
#include "ac_model.h"

typedef void (*ac_detail_request_fn)(const char *id);
typedef void (*ac_theme_request_fn)(const char *theme);
void ac_bootstrap_screen_set_theme(const char *theme);
bool ac_bootstrap_screen_close_theme_picker(void);
bool ac_bootstrap_screen_close_overlay(void);
void ac_bootstrap_screen_theme_handler(ac_theme_request_fn handler);
void ac_bootstrap_screen_create(bool use_assets, bool mock, ac_detail_request_fn request_detail);
void ac_bootstrap_screen_apply(const ac_snapshot_t *snapshot, uint64_t now_ms);
void ac_bootstrap_screen_detail(const ac_session_detail_t *detail);
void ac_bootstrap_screen_connection_lost(void);
/* Dedicated schedule view is retained only for USB diagnostics. */
void ac_bootstrap_screen_show_schedules(bool enabled);
void ac_bootstrap_screen_set_scheduled_tasks_visible(bool visible);
void ac_bootstrap_screen_set_animations(bool enabled);
int32_t ac_bootstrap_screen_detail_scroll_y(void);
void ac_bootstrap_screen_scroll_at(int x, int y, int delta);
void ac_bootstrap_screen_tick(uint64_t now_ms);
uint32_t ac_bootstrap_screen_pet_frame_updates(unsigned agent);
void ac_bootstrap_screen_destroy(void);

#endif

/* Optional device transport hint while no fresh data is connected. */
void ac_bootstrap_screen_connection_hint(const char *text);
