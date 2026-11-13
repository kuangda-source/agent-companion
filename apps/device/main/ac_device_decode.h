#pragma once
#include "ac_model.h"
#include "cJSON.h"
bool ac_device_snapshot(const cJSON *json,ac_snapshot_t *out);
typedef struct { const char *reason; int64_t source_age_seconds; } ac_decode_info_t;
bool ac_device_snapshot_checked(const cJSON *json,ac_snapshot_t *out,ac_decode_info_t *info);
bool ac_device_assistant(const cJSON *json,ac_assistant_feed_t *out);
bool ac_device_detail(const cJSON *json,ac_session_detail_t *out);

bool ac_device_remote_frame(const cJSON *packet,const char *previous_boot,uint64_t last_id,int64_t now);
typedef struct {uint64_t revision;unsigned brightness_percent;bool screen_on;} ac_display_command_t;
bool ac_device_display_command(const cJSON *json,ac_display_command_t *out);

/* Bounded USB diagnostic clip: 16 kHz, mono, signed little-endian PCM16. */
#define AC_AUDIO_PCM_LIMIT 128000
#define AC_AUDIO_VOLUME_LIMIT 80
typedef struct {const char *base64;size_t bytes;char id[49];unsigned volume;} ac_audio_command_t;
bool ac_device_audio_command(const cJSON *json,ac_audio_command_t *out);
