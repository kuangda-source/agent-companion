#include "ac_wifi.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>
int main(void){
    ac_wifi_join_t r={0};strcpy(r.ssid,"Example Wi-Fi");assert(!ac_wifi_join_valid(&r));
    r.open_network=true;assert(ac_wifi_join_valid(&r));r.open_network=false;strcpy(r.password,"fixture123");assert(ac_wifi_join_valid(&r));
    memset(r.password,'a',64);r.password[64]=0;assert(ac_wifi_join_valid(&r));r.password[3]='z';assert(!ac_wifi_join_valid(&r));
    memset(r.password,'p',63);r.password[63]=0;assert(ac_wifi_join_valid(&r));strcpy(r.password,"short");assert(!ac_wifi_join_valid(&r));strcpy(r.password,"fixture\n123");assert(!ac_wifi_join_valid(&r));
    struct {char ssid[33],password[65],relay[160],token[65],ca[96];} c={"Saved Wi-Fi","saved-fixture","wss://relay.example.org/v1/link","fixture-role-token","fixture-local-certificate"};
    unsigned char preserved[sizeof(c.relay)+sizeof(c.token)+sizeof(c.ca)];memcpy(preserved,c.relay,sizeof(preserved));
    memset(&r,0,sizeof(r));strcpy(r.ssid,"New Wi-Fi");r.use_saved_password=true;assert(!ac_wifi_apply_join(&r,c.ssid,c.password));assert(!strcmp(c.ssid,"Saved Wi-Fi")&&!strcmp(c.password,"saved-fixture"));
    strcpy(r.ssid,c.ssid);assert(ac_wifi_apply_join(&r,c.ssid,c.password));assert(!strcmp(c.password,"saved-fixture"));
    r.use_saved_password=false;strcpy(r.ssid,"New Wi-Fi");strcpy(r.password,"new-fixture");assert(ac_wifi_apply_join(&r,c.ssid,c.password));assert(!strcmp(c.ssid,"New Wi-Fi")&&!strcmp(c.password,"new-fixture"));assert(!memcmp(preserved,c.relay,sizeof(preserved)));
    strcpy(r.ssid,"Guest");r.password[0]=0;r.open_network=true;assert(ac_wifi_apply_join(&r,c.ssid,c.password)&&!c.password[0]);
    memset(r.ssid,'x',sizeof(r.ssid));assert(!ac_wifi_join_valid(&r));ac_wifi_clear_secret(&r,sizeof(r));for(size_t i=0;i<sizeof(r);i++)assert(!((unsigned char *)&r)[i]);
    puts("PASS Wi-Fi credentials: bounds, saved-password scope, isolated updates and secret clearing");return 0;
}
