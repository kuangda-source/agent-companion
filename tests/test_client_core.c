#include "ac_model.h"
#include "ac_pet_player.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>

static const uint16_t frames[]={0,1,2,3};
static ac_pet_pack_t pack;
static ac_pet_view_t view(ac_pet_expression_t expression)
{
    return (ac_pet_view_t){.agent_id=AC_AGENT_CODEX,.base_expression=expression,.status_quality=AC_QUALITY_CONFIRMED,.observation_health=AC_OBSERVATION_FRESH,.animation_enabled=true};
}
int main(void)
{
    ac_schedule_t task={.status=1,.next_epoch=1800000090};char countdown[96];
    ac_schedule_countdown(countdown,sizeof(countdown),&task,1800000000,true);assert(!strcmp(countdown,"还剩1分30秒"));
    ac_schedule_countdown(countdown,sizeof(countdown),&task,1800000091,true);assert(!strcmp(countdown,"等待调度"));
    task.status=2;ac_schedule_countdown(countdown,sizeof(countdown),&task,1800000000,true);assert(!strcmp(countdown,"已暂停"));
    ac_schedule_countdown(countdown,sizeof(countdown),&task,1800000000,false);assert(!strcmp(countdown,"待更新"));
    ac_agent_t mixed={.session_count=2};mixed.sessions[0].state=AC_STATE_COMPLETED;mixed.sessions[1].state=AC_STATE_RUNNING;
    ac_agent_schedule_t upcoming={.count=2};upcoming.tasks[0]=(ac_schedule_t){.status=1,.next_epoch=1800000090};upcoming.tasks[1]=(ac_schedule_t){.status=2,.next_epoch=1800000090};ac_activity_item_t items[5];
    assert(ac_activity_order(&mixed,&upcoming,items,5)==3);assert(!items[0].scheduled&&items[0].index==1);assert(items[1].scheduled&&items[1].index==0);assert(!items[2].scheduled&&items[2].index==0);
    strcpy(mixed.sessions[1].id,"linked");strcpy(upcoming.tasks[0].session_id,"linked");upcoming.tasks[0].activity=AC_SCHEDULE_RUNNING;
    assert(ac_activity_order(&mixed,&upcoming,items,5)==2);assert(!items[0].scheduled&&items[0].index==1);
    mixed.sessions[1].state=AC_STATE_COMPLETED;upcoming.tasks[0].activity=AC_SCHEDULE_PLANNED;
    assert(ac_activity_order(&mixed,&upcoming,items,5)==2);assert(items[0].scheduled&&items[0].index==0);assert(!items[1].scheduled&&items[1].index==0);
    mixed.session_count=0;upcoming.tasks[0].activity=AC_SCHEDULE_RUNNING;upcoming.tasks[0].next_epoch=1800010000;upcoming.tasks[1]=(ac_schedule_t){.status=1,.next_epoch=1800000090};
    assert(ac_activity_order(&mixed,&upcoming,items,5)==2);assert(items[0].scheduled&&items[0].index==0);assert(items[1].scheduled&&items[1].index==1);
    ac_schedule_countdown(countdown,sizeof(countdown),&upcoming.tasks[0],1800000000,true);assert(!strcmp(countdown,"运行中"));
    for(int i=0;i<AC_PET_EXPRESSION_COUNT;++i) pack.clips[i]=(ac_pet_clip_t){.frame_ids=frames,.frame_count=4,.fps=4,.loop=i!=AC_PET_CELEBRATE,.motion=i==AC_PET_ERROR || i==AC_PET_CELEBRATE?AC_PET_MOTION_NONE:AC_PET_MOTION_BREATHE,.effect=AC_PET_EFFECT_ACTIVITY_DOTS};
    pack.unique_frame_count=4;
    assert(ac_expression_for(AC_STATE_RUNNING,AC_QUALITY_CONFIRMED,AC_OBSERVATION_FRESH)==AC_PET_RUNNING);
    assert(ac_expression_for(AC_STATE_RUNNING,AC_QUALITY_ESTIMATED,AC_OBSERVATION_FRESH)==AC_PET_UNKNOWN);
    assert(ac_expression_for(AC_STATE_RUNNING,AC_QUALITY_CONFIRMED,AC_OBSERVATION_STALE)==AC_PET_UNKNOWN);
    assert(ac_expression_for(AC_STATE_COMPLETED,AC_QUALITY_CONFIRMED,AC_OBSERVATION_DISCONNECTED)==AC_PET_OFFLINE);
    ac_pet_player_t player={0}; ac_pet_view_t v=view(AC_PET_RUNNING);
    ac_pet_player_set(&player,&v,&pack,1000);
    v.selected=true; ac_pet_player_set(&player,&v,&pack,1400);
    assert(ac_pet_player_sample(&player,&pack,1450).frame_id==1); // selection/upsert did not restart
    unsigned min_scale=999,max_scale=0;
    for(uint64_t t=1466;t<3000;t+=16) {
        ac_pet_sample_t next=ac_pet_player_sample(&player,&pack,t);
        assert(next.x==0 && next.y==0 && next.rotation==0 && next.scale_x==256);
        assert(next.scale_y>=256 && next.scale_y<=259);
        if(next.scale_y<min_scale) min_scale=next.scale_y;if(next.scale_y>max_scale) max_scale=next.scale_y;
    }
    assert(min_scale<max_scale); // breathing changes gently while the feet stay planted
    ac_pet_player_t blinking={.random_state=1};ac_pet_view_t w=view(AC_PET_IDLE);
    ac_pet_player_set(&blinking,&w,&pack,1000);uint64_t due=blinking.next_blink_ms;
    assert(due>=4000 && due<=7500);
    ac_pet_player_set(&blinking,&w,&pack,2000);assert(blinking.next_blink_ms==due);
    assert(!ac_pet_player_sample(&blinking,&pack,due-1).eyes_closed);
    assert(ac_pet_player_sample(&blinking,&pack,due).eyes_closed);
    w.selected=true;ac_pet_player_set(&blinking,&w,&pack,due+50);
    assert(ac_pet_player_sample(&blinking,&pack,due+139).eyes_closed);
    assert(!ac_pet_player_sample(&blinking,&pack,due+140).eyes_closed);
    assert(blinking.next_blink_ms>=due+3000 && blinking.next_blink_ms<=due+6500);
    due=blinking.next_blink_ms;ac_pet_player_sample(&blinking,&pack,due);
    w.base_expression=AC_PET_OFFLINE;ac_pet_player_set(&blinking,&w,&pack,due+30);
    assert(!ac_pet_player_sample(&blinking,&pack,due+31).eyes_closed);
    w.base_expression=AC_PET_IDLE;w.animation_enabled=false;ac_pet_player_set(&blinking,&w,&pack,due+100);
    assert(!ac_pet_player_sample(&blinking,&pack,due+9000).eyes_closed);
    w.animation_enabled=true;ac_pet_player_set(&blinking,&w,&pack,due+9000);
    assert(blinking.next_blink_ms>=due+12000); // re-enable never flashes an overdue blink
    v.base_expression=AC_PET_IDLE; v.completion_event_id="00000000-0000-5000-a000-000000000001";
    ac_pet_player_set(&player,&v,&pack,1500);
    assert(ac_pet_player_sample(&player,&pack,2999).expression==AC_PET_CELEBRATE);
    ac_pet_player_set(&player,&v,&pack,2900);
    assert(ac_pet_player_sample(&player,&pack,3000).expression==AC_PET_IDLE); // same UUID cannot extend the 1500ms window
    v.completion_event_id="00000000-0000-5000-a000-000000000002"; ac_pet_player_set(&player,&v,&pack,4000);
    v.base_expression=AC_PET_WAITING; ac_pet_player_set(&player,&v,&pack,4050);
    assert(ac_pet_player_sample(&player,&pack,4051).expression==AC_PET_WAITING);
    v.base_expression=AC_PET_IDLE; v.completion_event_id="00000000-0000-5000-a000-000000000001"; ac_pet_player_set(&player,&v,&pack,4100);
    assert(ac_pet_player_sample(&player,&pack,4200).expression==AC_PET_IDLE); // non-consecutive replay deduplicated
    v.animation_enabled=false; ac_pet_player_set(&player,&v,&pack,4300);
    ac_pet_sample_t sample=ac_pet_player_sample(&player,&pack,5000); assert(sample.frame_id==0 && sample.x==0 && sample.y==0 && sample.rotation==0 && sample.scale_x==256 && sample.scale_y==256);
    v.observation_health=AC_OBSERVATION_STALE; ac_pet_player_set(&player,&v,&pack,5100);
    assert(ac_pet_player_sample(&player,&pack,5200).expression==AC_PET_UNKNOWN);
    ac_pet_player_t independent={0}; v=view(AC_PET_RUNNING); ac_pet_player_set(&independent,&v,&pack,2000);
    assert(ac_pet_player_sample(&independent,&pack,2250).frame_id==1);
    assert(player.expression==AC_PET_UNKNOWN);
    /* Compiled Grok error plays its four frames once; repeated views/selection do
       not restart it. Leaving and re-entering error does restart the response. */
    ac_pet_pack_t held_pack=pack;held_pack.clips[AC_PET_ERROR].loop=false;held_pack.clips[AC_PET_ERROR].fps=8;
    ac_pet_player_t held={0};ac_pet_view_t held_view=view(AC_PET_ERROR);
    ac_pet_player_set(&held,&held_view,&held_pack,1000);
    for(unsigned i=0;i<4;++i)assert(ac_pet_player_sample(&held,&held_pack,1000+i*125).frame_id==i);
    held_view.selected=true;ac_pet_player_set(&held,&held_view,&held_pack,2000);
    assert(ac_pet_player_sample(&held,&held_pack,9000).frame_id==3);
    held_view.base_expression=AC_PET_RUNNING;ac_pet_player_set(&held,&held_view,&held_pack,10000);
    held_view.base_expression=AC_PET_ERROR;ac_pet_player_set(&held,&held_view,&held_pack,10001);
    assert(ac_pet_player_sample(&held,&held_pack,10001).frame_id==0);
    /* Unknown telemetry can have neutral ambient frames without becoming idle,
       running or celebrating. Repeated updates keep the animation clock. */
    static const uint16_t neutral_frames[]={0,1,2,3,4,5,6,7,8,9,10,11};
    ac_pet_pack_t neutral=pack;neutral.unique_frame_count=12;
    neutral.clips[AC_PET_UNKNOWN]=(ac_pet_clip_t){.frame_ids=neutral_frames,.frame_count=12,.fps=4,.loop=true,.motion=AC_PET_MOTION_NONE};
    ac_pet_player_t ambient={0};ac_pet_view_t unknown=view(AC_PET_UNKNOWN);
    unknown.observation_health=AC_OBSERVATION_UNKNOWN;
    ac_pet_player_set(&ambient,&unknown,&neutral,1000);
    for(unsigned i=0;i<12;i++){
        uint64_t now=1000+i*250;ac_pet_player_set(&ambient,&unknown,&neutral,now);
        ac_pet_sample_t pose=ac_pet_player_sample(&ambient,&neutral,now);
        assert(pose.expression==AC_PET_UNKNOWN&&pose.frame_id==i);
        assert(pose.x==0&&pose.y==0&&pose.rotation==0&&pose.scale_x==256&&pose.scale_y==256);
    }
    assert(ac_pet_player_sample(&ambient,&neutral,4000).frame_id==0);
    unknown.animation_enabled=false;ac_pet_player_set(&ambient,&unknown,&neutral,4100);
    assert(ac_pet_player_sample(&ambient,&neutral,9000).frame_id==0);
    ac_agent_t before={.health=AC_OBSERVATION_FRESH,.session_count=1},after={.health=AC_OBSERVATION_FRESH,.session_count=1};
    strcpy(before.sessions[0].id,"codex:one"); before.sessions[0].state=AC_STATE_RUNNING;
    after.sessions[0]=before.sessions[0]; after.sessions[0].state=AC_STATE_COMPLETED; after.sessions[0].quality=AC_QUALITY_CONFIRMED;
    after.sessions[0].completion_recent=true;
    strcpy(after.sessions[0].completion_id,"00000000-0000-5000-a000-000000000003");
    assert(ac_completion_transition(&before,&after)!=NULL);
    before=after; assert(ac_completion_transition(&before,&after)==NULL); // snapshot replay
    strcpy(after.sessions[0].completion_id,"00000000-0000-5000-a000-000000000004");
    assert(ac_completion_transition(&before,&after)!=NULL); // short turn completed between two polls
    after.sessions[0].state=AC_STATE_RUNNING; assert(ac_completion_transition(&before,&after)!=NULL); // next turn already began
    after.sessions[0].completion_recent=false; assert(ac_completion_transition(&before,&after)==NULL);
    after.sessions[0].completion_recent=true;
    before.sessions[0].state=AC_STATE_RUNNING; before.health=AC_OBSERVATION_STALE; assert(ac_completion_transition(&before,&after)==NULL);
    ac_metric_t quota={.available=true,.value=0.64};
    ac_quota_view_t q=ac_quota_view(quota,AC_OBSERVATION_FRESH);
    assert(q.available && fabs(q.remaining_ratio-0.36)<1e-9 && q.band==AC_QUOTA_YELLOW);
    quota.value=1.0/3.0; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).band==AC_QUOTA_GREEN);
    quota.value=2.0/3.0; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).band==AC_QUOTA_YELLOW);
    quota.value=0.667; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).band==AC_QUOTA_RED);
    quota.value=0; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).remaining_ratio==1);
    quota.value=1; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).remaining_ratio==0);
    quota.value=NAN; assert(!ac_quota_view(quota,AC_OBSERVATION_FRESH).available);
    quota.value=0.2; assert(!ac_quota_view(quota,AC_OBSERVATION_STALE).available);
    quota.available=false; assert(ac_quota_view(quota,AC_OBSERVATION_FRESH).band==AC_QUOTA_UNKNOWN);
    char reset[48];int64_t now=1800000000;
    ac_quota_reset_countdown(reset,sizeof(reset),now+2*86400+4*3600,now,true);assert(!strcmp(reset,"2d04h"));
    ac_quota_reset_countdown(reset,sizeof(reset),now+3660,now,true);assert(!strcmp(reset,"1h01m"));
    ac_quota_reset_countdown(reset,sizeof(reset),now+90,now,true);assert(!strcmp(reset,"1m"));
    ac_quota_reset_countdown(reset,sizeof(reset),now+59,now,true);assert(!strcmp(reset,"<1m"));
    ac_quota_reset_countdown(reset,sizeof(reset),now,now,true);assert(!strcmp(reset,"待确认"));
    ac_quota_reset_countdown(reset,sizeof(reset),now-10,now,true);assert(!strcmp(reset,"待确认"));
    ac_quota_reset_countdown(reset,sizeof(reset),now+90,now,false);assert(!strcmp(reset,"待更新"));
    ac_quota_reset_countdown(reset,sizeof(reset),0,now,true);assert(!reset[0]);
    ac_quota_reset_countdown(reset,sizeof(reset),now+90,0,true);assert(!reset[0]);
    ac_usage_stats_t stats={.day_count=30,.partial=true,.available={true,false,true}};
    for(int i=0;i<30;++i) { stats.days[i].tokens[0]=(ac_metric_t){.available=true,.value=10}; stats.days[i].tokens[2]=(ac_metric_t){.available=true,.value=20}; }
    ac_metric_t week=ac_usage_total(&stats,-1,7);
    assert(week.available && week.estimated && week.value==210);
    assert(ac_usage_total(&stats,-1,30).value==900);
    assert(ac_usage_total(&stats,0,7).value==70 && !ac_usage_total(&stats,0,7).estimated);
    assert(!ac_usage_total(&stats,1,7).available); // missing Claude is not a recorded zero
    assert(!ac_usage_total(&stats,3,7).available);
    stats.loading=true; assert(ac_usage_total(&stats,2,30).estimated);
    puts("PASS: status projection, phase preservation, bounded celebration, priority, replay, reduced motion, independent players");
    return 0;
}
