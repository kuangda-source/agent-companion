#ifndef AC_PET_CONTRACT_H
#define AC_PET_CONTRACT_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    AC_PET_SOURCE_SIZE = 128,
    AC_PET_RENDER_SIZE = 112,
    AC_PET_MAX_FRAMES_PER_CLIP = 16,
    AC_PET_MAX_UNIQUE_FRAMES = 64,
    AC_PET_MAX_FPS = 12,
    AC_PET_MAX_CELEBRATION_MS = 1500,
    AC_PET_COMPLETION_ID_CAPACITY = 37 /* UUID text + NUL */
};

typedef enum {
    AC_AGENT_CODEX = 0,
    AC_AGENT_CLAUDE,
    AC_AGENT_DEEPSEEK,
    AC_AGENT_GROK,
    AC_AGENT_COUNT
} ac_agent_id_t;

/* Clip order is part of the generated-resource contract. */
typedef enum {
    AC_PET_IDLE = 0,
    AC_PET_RUNNING,
    AC_PET_WAITING,
    AC_PET_ERROR,
    AC_PET_OFFLINE,
    AC_PET_UNKNOWN,
    AC_PET_CELEBRATE,
    AC_PET_EXPRESSION_COUNT
} ac_pet_expression_t;

typedef enum {
    AC_QUALITY_CONFIRMED = 0,
    AC_QUALITY_ESTIMATED,
    AC_QUALITY_UNAVAILABLE,
    AC_QUALITY_UNKNOWN
} ac_data_quality_t;

typedef enum {
    AC_OBSERVATION_FRESH = 0,
    AC_OBSERVATION_STALE,
    AC_OBSERVATION_DISCONNECTED,
    AC_OBSERVATION_UNKNOWN
} ac_observation_health_t;

/* Optional declarative visual presets; omitted JSON fields map to NONE.
 * These values never establish or change an Agent's business state.
 */
typedef enum {
    AC_PET_MOTION_NONE = 0,
    AC_PET_MOTION_BREATHE,
    AC_PET_MOTION_BOB,
    AC_PET_MOTION_SHAKE
} ac_pet_motion_t;

typedef enum {
    AC_PET_EFFECT_NONE = 0,
    AC_PET_EFFECT_ACTIVITY_DOTS,
    AC_PET_EFFECT_ATTENTION,
    AC_PET_EFFECT_ERROR_MARK,
    AC_PET_EFFECT_SPARKLE
} ac_pet_effect_t;

/* Generated frame IDs index the UI layer's lv_image_dsc_t table.
 * A missing optional celebrate clip has frame_count=0 and frame_ids=NULL.
 * Six base clips must contain 1..16 frames; a one-frame clip may still
 * use procedural motion/effects without advancing its image frame.
 */
typedef struct {
    const uint16_t *frame_ids;
    uint8_t frame_count;
    uint8_t fps;
    bool loop;
    ac_pet_motion_t motion;
    ac_pet_effect_t effect;
} ac_pet_clip_t;

typedef struct {
    const char *asset_id;
    const char *asset_version;
    uint16_t unique_frame_count;
    uint16_t poster_frame_id;
    ac_pet_clip_t clips[AC_PET_EXPRESSION_COUNT];
} ac_pet_pack_t;

/* UI projection only, never a claim about an external App by itself.
 * base_expression excludes CELEBRATE; retain the original business state
 * and observation timestamp separately in the client store.
 * completion_event_id is NULL or a new, deduplicated UUID; widgets copy it.
 * selected changes the enclosing card decoration, not animation phase.
 */
typedef struct {
    ac_agent_id_t agent_id;
    ac_pet_expression_t base_expression;
    ac_data_quality_t status_quality;
    ac_observation_health_t observation_health;
    bool selected;
    bool animation_enabled;
    const char *completion_event_id;
} ac_pet_view_t;

#ifdef __cplusplus
}
#endif

#endif
