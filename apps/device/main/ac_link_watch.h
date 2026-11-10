#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef enum { AC_LINK_WAIT,AC_LINK_PROBE,AC_LINK_RECONNECT } ac_link_action_t;
typedef struct {uint64_t started_ms,last_response_ms,last_probe_ms;bool connected;} ac_link_watch_t;
void ac_link_watch_start(ac_link_watch_t *watch,uint64_t now);
void ac_link_watch_open(ac_link_watch_t *watch,uint64_t now);
void ac_link_watch_response(ac_link_watch_t *watch,uint64_t now);
ac_link_action_t ac_link_watch_tick(ac_link_watch_t *watch,uint64_t now);
/* A reachable candidate port is not a reason to preempt a healthy peer path. */
bool ac_link_watch_allow_upgrade(const ac_link_watch_t *watch,uint64_t now,bool peer_present);
