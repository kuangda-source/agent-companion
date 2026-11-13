#ifndef AC_ASSISTANT_PANEL_H
#define AC_ASSISTANT_PANEL_H

#include "lvgl.h"
#include <stdbool.h>
#include <stddef.h>

typedef enum {
    AC_ASSISTANT_UNCONFIGURED, AC_ASSISTANT_READY,
    AC_ASSISTANT_UPDATING, AC_ASSISTANT_FAILED, AC_ASSISTANT_OFFLINE
} ac_assistant_status_t;
typedef enum { AC_TOOL_PELICAN, AC_TOOL_CONNECTIVITY, AC_TOOL_WIFI, AC_TOOL_VOLUME } ac_tool_id_t;
typedef void (*ac_tool_request_fn)(ac_tool_id_t tool);

/* UI view only, not a network DTO. Oldest to newest; the newest eight are copied.
 * Stable IDs identify messages; updated text under the same ID is a new revision.
 * The producer owns its strings and may release them after set_feed returns.
 * Mock data is accepted only by a screen explicitly created in mock mode. */
typedef struct {
    const char *id, *time, *text, *source;
} ac_assistant_message_view_t;
typedef struct {
    ac_assistant_status_t status;
    bool mock;
    const ac_assistant_message_view_t *messages;
    size_t message_count;
} ac_assistant_feed_view_t;

void ac_assistant_panel_create(lv_obj_t *screen, bool mock, ac_tool_request_fn tool_request);
void ac_assistant_panel_refresh_handler(void (*handler)(void));
bool ac_assistant_panel_set_feed(const ac_assistant_feed_view_t *feed);
/* Compact view rotates meaningful assistant bodies every 10 seconds. Identical
 * feed heartbeats preserve the timer; opening history pauses rotation. */
bool ac_assistant_panel_close(void);
bool ac_assistant_panel_scroll_at(int x, int y, int delta);
void ac_assistant_panel_destroy(void);

#endif
