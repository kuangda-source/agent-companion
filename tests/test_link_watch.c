#include "ac_link_watch.h"
#include <assert.h>
#include <stdio.h>
int main(void){
    ac_link_watch_t w;ac_link_watch_start(&w,0);assert(ac_link_watch_tick(&w,29999)==AC_LINK_WAIT);assert(ac_link_watch_tick(&w,30000)==AC_LINK_RECONNECT);
    ac_link_watch_open(&w,100);assert(ac_link_watch_tick(&w,5099)==AC_LINK_WAIT);assert(ac_link_watch_tick(&w,5100)==AC_LINK_PROBE);assert(ac_link_watch_tick(&w,5101)==AC_LINK_WAIT);
    /* Sending probes is not evidence of receiving a response. */
    assert(ac_link_watch_tick(&w,10100)==AC_LINK_PROBE);assert(ac_link_watch_tick(&w,15100)==AC_LINK_PROBE);assert(ac_link_watch_tick(&w,20100)==AC_LINK_RECONNECT);
    /* A healthy relay can outlive an offline Mac without reconnect churn. */
    ac_link_watch_open(&w,100000);for(uint64_t now=105000;now<=225000;now+=5000){assert(ac_link_watch_tick(&w,now)==AC_LINK_PROBE);ac_link_watch_response(&w,now+1);assert(!ac_link_watch_allow_upgrade(&w,now+1,true));assert(ac_link_watch_allow_upgrade(&w,now+1,false));}
    assert(ac_link_watch_tick(&w,245000)==AC_LINK_PROBE);assert(ac_link_watch_tick(&w,245001)==AC_LINK_RECONNECT);
    assert(ac_link_watch_allow_upgrade(&w,245001,true));
    ac_link_watch_open(&w,250000);ac_link_watch_response(&w,250005);assert(ac_link_watch_tick(&w,255000)==AC_LINK_PROBE);
    puts("PASS link watchdog: handshake timeout, response timeout, probe pacing, idle Mac and reconnect reset");return 0;
}
