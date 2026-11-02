#include "ac_pet_player.h"
#include <string.h>
#include <math.h>

static bool urgent(ac_pet_expression_t e)
{
    return e == AC_PET_WAITING || e == AC_PET_ERROR || e == AC_PET_OFFLINE || e == AC_PET_UNKNOWN;
}
static uint32_t random_next(ac_pet_player_t *p)
{
    uint32_t n=p->random_state;n^=n<<13;n^=n>>17;n^=n<<5;p->random_state=n;return n;
}
static void schedule_blink(ac_pet_player_t *p,uint64_t now)
{
    p->next_blink_ms=now+3000+random_next(p)%3501;
}

void ac_pet_player_set(ac_pet_player_t *p, const ac_pet_view_t *v,
                       const ac_pet_pack_t *pack, uint64_t now)
{
    ac_pet_expression_t base = v->base_expression;
    if(v->observation_health == AC_OBSERVATION_DISCONNECTED) base = AC_PET_OFFLINE;
    else if(v->observation_health != AC_OBSERVATION_FRESH || v->status_quality != AC_QUALITY_CONFIRMED) base = AC_PET_UNKNOWN;
    if(base >= AC_PET_CELEBRATE) base = AC_PET_UNKNOWN;
    if(!p->initialized) {
        if(!p->random_state) p->random_state=0x9e3779b9u*((unsigned)v->agent_id+1u)^(uint32_t)now;
        if(!p->random_state) p->random_state=1;
        schedule_blink(p,now);
    }
    if(!p->initialized || p->base != base) {
        p->blink_until_ms=0;p->blink_ready_ms=now+600;
        p->base = base;
        if(!p->celebrate_until_ms || urgent(base)) { p->expression = base; p->started_ms = now; p->celebrate_until_ms = 0; }
    }
    if(!p->initialized) p->motion_offset_ms=(unsigned)v->agent_id*337;
    if(p->initialized && v->animation_enabled && !p->animation_enabled) schedule_blink(p,now);
    p->initialized = true;
    p->animation_enabled = v->animation_enabled;
    if(!v->animation_enabled) { p->celebrate_until_ms = 0; p->expression = base;p->blink_until_ms=0; }
    if(v->completion_event_id && strlen(v->completion_event_id) == 36) {
        bool seen = false;
        for(unsigned i = 0; i < 16; ++i) if(strcmp(p->completion_ids[i], v->completion_event_id) == 0) seen = true;
        if(!seen) {
            memcpy(p->completion_ids[p->completion_cursor++ % 16], v->completion_event_id, 37);
            if(v->animation_enabled && !urgent(base) && pack && pack->clips[AC_PET_CELEBRATE].frame_count) {
                p->expression = AC_PET_CELEBRATE; p->started_ms = now;
                p->celebrate_until_ms = now + AC_PET_MAX_CELEBRATION_MS;
            }
        }
    }
}

static double wave(uint64_t elapsed,uint32_t period)
{
    return sin((double)(elapsed%period)*6.283185307179586/(double)period);
}

ac_pet_sample_t ac_pet_player_sample(ac_pet_player_t *p, const ac_pet_pack_t *pack, uint64_t now)
{
    if(p->celebrate_until_ms && now >= p->celebrate_until_ms) {
        p->celebrate_until_ms = 0; p->expression = p->base; p->started_ms = now;
        p->blink_ready_ms=now+600;
    }
    ac_pet_sample_t sample = {.expression = p->expression,.scale_x=256,.scale_y=256,.effect_opa={255,255,255,255}};
    if(!pack) return sample;
    const ac_pet_clip_t *clip = &pack->clips[p->expression];
    uint64_t elapsed = now >= p->started_ms ? now - p->started_ms : 0;
    unsigned frame = p->animation_enabled ? (unsigned)(elapsed * clip->fps / 1000) : 0;
    if(clip->frame_count) {
        frame = clip->loop ? frame % clip->frame_count : frame < clip->frame_count ? frame : clip->frame_count - 1;
        sample.frame_id = clip->frame_ids[frame];
    } else sample.frame_id = pack->poster_frame_id;
    sample.effect = clip->effect;
    if(p->animation_enabled) {
        uint64_t t=elapsed+p->motion_offset_ms;
        if(clip->motion == AC_PET_MOTION_BREATHE) {
            /* Expand gently around the image's foot pivot. No floating/rocking. */
            sample.scale_y=(uint16_t)(256+lround(1.5*(1+wave(t,p->expression==AC_PET_OFFLINE?5200:4200))));
        }
        if(clip->motion == AC_PET_MOTION_BOB) {
            double v=wave(t,1600);sample.y=(int8_t)lround(-3*v);sample.rotation=(int16_t)lround(13*wave(t,2200));
            sample.scale_x=(uint16_t)(256+lround(2*v));sample.scale_y=(uint16_t)(256+lround(4*wave(t+300,1600)));
        }
        if(clip->motion == AC_PET_MOTION_SHAKE) {
            sample.x=(int8_t)lround(2*wave(t,620));sample.rotation=(int16_t)lround(9*wave(t,900));
        }
        bool blinkable=p->expression==AC_PET_IDLE || p->expression==AC_PET_RUNNING || p->expression==AC_PET_WAITING || p->expression==AC_PET_UNKNOWN;
        if(!blinkable || now<p->blink_ready_ms) p->blink_until_ms=0;
        if(now>=p->next_blink_ms) {
            if(blinkable && now>=p->blink_ready_ms) p->blink_until_ms=now+140;
            schedule_blink(p,now);
        }
        sample.eyes_closed=blinkable && now<p->blink_until_ms;
        sample.phase = (uint8_t)((elapsed / 250) % 4);
        for(unsigned i=0;i<4;++i) sample.effect_opa[i]=(uint8_t)lround(55+200*(wave(t+i*210,1100)+1)/2);
    } else if(sample.effect != AC_PET_EFFECT_ERROR_MARK && sample.effect != AC_PET_EFFECT_ATTENTION) sample.effect = AC_PET_EFFECT_NONE;
    return sample;
}
