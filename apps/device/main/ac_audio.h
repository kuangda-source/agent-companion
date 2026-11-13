#pragma once
#include "cJSON.h"
/* Caller must restrict diagnostic playback to the physical USB transport. */
void ac_audio_submit(const cJSON *packet);
