#include "ac_wifi.h"
#include <string.h>
void ac_wifi_clear_secret(void *data,size_t length){volatile unsigned char *p=data;while(length--)*p++=0;}
bool ac_wifi_join_valid(const ac_wifi_join_t *r){
    if(!r||!memchr(r->ssid,0,sizeof(r->ssid))||!memchr(r->password,0,sizeof(r->password)))return false;
    size_t n=strlen(r->ssid),p=strlen(r->password);if(n<1||n>32||strpbrk(r->ssid,"\r\n")||strpbrk(r->password,"\r\n"))return false;
    if(r->use_saved_password&&r->open_network)return false;
    if(!p)return r->use_saved_password||r->open_network;
    if(r->use_saved_password||r->open_network||p<8||p>64)return false;
    if(p==64)for(size_t i=0;i<p;i++)if(!((r->password[i]>='0'&&r->password[i]<='9')||(r->password[i]>='a'&&r->password[i]<='f')||(r->password[i]>='A'&&r->password[i]<='F')))return false;
    return true;
}
bool ac_wifi_apply_join(const ac_wifi_join_t *r,char ssid[33],char password[65]){
    if(!ac_wifi_join_valid(r))return false;
    if(r->use_saved_password){if(strcmp(ssid,r->ssid)||!password[0])return false;}
    else{ac_wifi_clear_secret(password,65);memcpy(password,r->password,strlen(r->password)+1);}
    memcpy(ssid,r->ssid,strlen(r->ssid)+1);return true;
}
