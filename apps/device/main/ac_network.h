#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "cJSON.h"
typedef void (*ac_network_receive_cb)(const char *data,size_t length,bool remote);
void ac_network_init(ac_network_receive_cb callback);
bool ac_network_provision(const cJSON *value);
bool ac_network_configure_link(const cJSON *value);
void ac_network_send(const char *json);
const char *ac_network_label(void);
