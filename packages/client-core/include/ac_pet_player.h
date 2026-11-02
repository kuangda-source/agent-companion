#ifndef AC_PET_PLAYER_H
#define AC_PET_PLAYER_H

#include "ac_pet_contract.h"

typedef struct {
    ac_pet_expression_t base, expression;
    bool initialized, animation_enabled;
    uint64_t started_ms, celebrate_until_ms;
    char completion_ids[16][AC_PET_COMPLETION_ID_CAPACITY];
    unsigned completion_cursor;
    unsigned motion_offset_ms;
    uint32_t random_state;
    uint64_t next_blink_ms, blink_until_ms, blink_ready_ms;
} ac_pet_player_t;
typedef struct {
    ac_pet_expression_t expression;
    uint16_t frame_id;
    int8_t x, y;
    int16_t rotation;
    uint16_t scale_x, scale_y;
    uint8_t effect_opa[4];
    ac_pet_effect_t effect;
    uint8_t phase;
    bool eyes_closed;
} ac_pet_sample_t;

void ac_pet_player_set(ac_pet_player_t *player, const ac_pet_view_t *view,
                       const ac_pet_pack_t *pack, uint64_t now_ms);
ac_pet_sample_t ac_pet_player_sample(ac_pet_player_t *player,
                                    const ac_pet_pack_t *pack, uint64_t now_ms);

#endif
