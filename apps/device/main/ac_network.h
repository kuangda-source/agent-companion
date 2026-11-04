#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "cJSON.h"
#include "ac_wifi.h"
typedef void (*ac_network_receive_cb)(const char *data,size_t length,bool remote);
void ac_network_init(ac_network_receive_cb callback);
bool ac_network_provision(const cJSON *value);
bool ac_network_configure_link(const cJSON *value);
void ac_network_send(const char *json);
const char *ac_network_label(void);
bool ac_network_scan(void);
bool ac_network_join_local(const ac_wifi_join_t *request);
void ac_network_wifi_status(ac_wifi_status_t *status);
