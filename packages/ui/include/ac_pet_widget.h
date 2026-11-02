#ifndef AC_PET_WIDGET_H
#define AC_PET_WIDGET_H

#include "lvgl.h"
#include "ac_pet_contract.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ac_pet_widget ac_pet_widget_t;

/* Metadata and every image descriptor/pixel buffer remain valid until
 * widget destruction. The widget never frees shared assets.
 * frames has pack->unique_frame_count entries, all 112x112 RGB565A8.
 */
typedef struct {
    uint16_t frame_id;
    uint8_t x, y, width, height, expression_mask;
} ac_pet_blink_t;
typedef struct {
    const ac_pet_pack_t *pack;
    const lv_image_dsc_t *const *frames;
    const ac_pet_blink_t *blink;
} ac_pet_assets_t;

/* Frames, declarative motion/effects and completion playback share one UI clock.
 * A procedural perspective stage and contact shadow use no extra image assets.
 * Pointer/touch parallax is bounded to 3x2px and disabled with reduced motion.
 * Every call must run in the UI execution context. */
ac_pet_widget_t *ac_pet_widget_create(lv_obj_t *parent,
                                    const ac_pet_assets_t *assets);

/* Copy view/UUID synchronously; repeated state and selection preserve phase. */
void ac_pet_widget_set_view(ac_pet_widget_t *pet, const ac_pet_view_t *view);

/* now_ms is a monotonic clock shared with the rest of the UI.
 * Advances image frames and the optional motion/effect presets.
 */
void ac_pet_widget_tick(ac_pet_widget_t *pet, uint64_t now_ms);
uint32_t ac_pet_widget_frame_updates(const ac_pet_widget_t *pet);

/* Frees this component and its children, leaves parent and assets alive. */
void ac_pet_widget_destroy(ac_pet_widget_t *pet);

#ifdef __cplusplus
}
#endif

#endif
