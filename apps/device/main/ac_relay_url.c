#include "ac_relay_url.h"
#include <string.h>
#include <stdlib.h>
bool ac_relay_url_valid(const char *url) {
    if(!url || strlen(url)>=160 || strncmp(url,"wss://",6))return false;
    const char *host=url+6,*p=host;
    while((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='-'||*p=='.')p++;
    if(p==host || *host=='.' || *host=='-' || p[-1]=='.' || p[-1]=='-')return false;
    if(*p==':'){
        const char *start=++p;unsigned port=0;
        while(*p>='0'&&*p<='9'){port=port*10+(unsigned)(*p++-'0');if(port>65535)return false;}
        if(p==start||port==0)return false;
    }
    return !strcmp(p,"/v1/link");
}
