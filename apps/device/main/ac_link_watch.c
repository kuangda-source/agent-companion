#include "ac_link_watch.h"
void ac_link_watch_start(ac_link_watch_t *w,uint64_t now){*w=(ac_link_watch_t){.started_ms=now,.last_response_ms=now,.last_probe_ms=now};}
void ac_link_watch_open(ac_link_watch_t *w,uint64_t now){ac_link_watch_start(w,now);w->connected=true;}
void ac_link_watch_response(ac_link_watch_t *w,uint64_t now){w->last_response_ms=now;}
ac_link_action_t ac_link_watch_tick(ac_link_watch_t *w,uint64_t now){
    if(!w->connected)return now-w->started_ms>=30000?AC_LINK_RECONNECT:AC_LINK_WAIT;
    if(now-w->last_response_ms>=20000)return AC_LINK_RECONNECT;
    if(now-w->last_probe_ms>=5000){w->last_probe_ms=now;return AC_LINK_PROBE;}
    return AC_LINK_WAIT;
}
