#ifndef AC_WIFI_H
#define AC_WIFI_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define AC_WIFI_NETWORK_LIMIT 12
typedef struct {char ssid[33];int8_t rssi;bool secured,supported;} ac_wifi_network_t;
typedef struct {char ssid[33],password[65];bool use_saved_password,open_network;} ac_wifi_join_t;
typedef struct {
    uint32_t revision;
    ac_wifi_network_t networks[AC_WIFI_NETWORK_LIMIT];size_t count;
    char ssid[33],message[112];
    bool scanning,connecting,connected,has_saved_password,relay_configured,lan_configured,mac_connected;
} ac_wifi_status_t;
bool ac_wifi_join_valid(const ac_wifi_join_t *request);
/* Only these two buffers can change; relay credentials and pairing are untouched. */
bool ac_wifi_apply_join(const ac_wifi_join_t *request,char ssid[33],char password[65]);
void ac_wifi_clear_secret(void *data,size_t length);
#endif
