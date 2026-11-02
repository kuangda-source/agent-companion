#include "ac_relay_url.h"
#include <assert.h>
int main(void){
    assert(ac_relay_url_valid("wss://relay.example.org/v1/link"));
    assert(ac_relay_url_valid("wss://relay.example.org:8443/v1/link"));
    const char *bad[]={"","ws://relay.example.org/v1/link","wss:///v1/link","wss://user@host/v1/link","wss://host/v1/link?key=secret","wss://host:65536/v1/link","wss://host:0/v1/link","wss://host/other","wss://host/v1/link\n"};
    for(unsigned i=0;i<sizeof(bad)/sizeof(*bad);i++)assert(!ac_relay_url_valid(bad[i]));
    return 0;
}
