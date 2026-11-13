#pragma once
#include "cJSON.h"
#include <stdbool.h>
void ac_audio_init(void);
void ac_audio_tick(void);
void ac_audio_capability(void);
/* USB diagnostic stays physically restricted. Formal packets require a fresh paired view. */
void ac_audio_submit(const cJSON *packet);
void ac_audio_packet(const cJSON *packet,bool remote);
unsigned ac_audio_volume(void);
bool ac_audio_muted(void);
void ac_audio_settings(unsigned volume,bool muted);
void ac_audio_stop(void);
