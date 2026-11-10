#include "ac_ui_memory.h"
#include "ac_bootstrap_screen.h"
#include "ac_pet_widget.h"
#include "ac_pet_registry.h"
#include "ac_usage_panel.h"
#include "ac_assistant_panel.h"
#include "ac_wifi_panel.h"
#include "ac_neon.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <math.h>

static const uint32_t colors[AC_AGENT_COUNT] = {0x00ffff, 0xff00ff, 0x009dff, 0xffa84a};
static const char *names[AC_AGENT_COUNT] = {"CODEX", "CLAUDE", "DEEPSEEK", "GROK"};
static lv_obj_t *cards[AC_AGENT_COUNT], *card_status[AC_AGENT_COUNT], *card_counts[AC_AGENT_COUNT], *card_quota[AC_AGENT_COUNT];
static lv_obj_t *card_quota_reset[AC_AGENT_COUNT];
static lv_obj_t *quota_tracks[AC_AGENT_COUNT], *quota_fills[AC_AGENT_COUNT], *pet_slots[AC_AGENT_COUNT], *card_names[AC_AGENT_COUNT];
static ac_pet_widget_t *pets[AC_AGENT_COUNT];
static lv_obj_t *header_status, *header_clock, *panel_title, *notice, *panel;
static lv_obj_t *header_usage[2];
static lv_obj_t *theme_overlay, *theme_dialog, *theme_choices[AC_THEME_COUNT], *theme_choice_status[AC_THEME_COUNT];
static lv_group_t *theme_group, *screen_group;
static lv_obj_t *theme_previous_focus;
static int theme_ids[AC_THEME_COUNT]={AC_THEME_NEON,AC_THEME_COMIC,AC_THEME_NEUMORPHISM};
static ac_theme_request_fn request_theme;
static int usage_periods[2]={7,30};
static lv_obj_t *columns[5], *rows[5], *row_title[5], *row_state[5], *row_time[5], *row_tokens[5], *row_cache[5], *row_context[5], *context_bars[5];
static lv_obj_t *schedule_page;
static bool scheduled_tasks_visible=true;
static bool showing_schedules;static unsigned schedule_offset;
static AC_UI_LARGE_BSS ac_activity_item_t home_items[AC_SESSION_LIMIT+AC_SCHEDULE_LIMIT];static size_t home_count;
static lv_obj_t *empty, *detail_body, *back, *detail_meta, *detail_source;
static int agent_ids[AC_AGENT_COUNT] = {0,1,2,3}, row_ids[5] = {0,1,2,3,4};
static AC_UI_LARGE_BSS ac_snapshot_t current;
static bool has_snapshot, mock_mode, showing_detail, showing_statistics, continuous;
static bool animations_enabled=true;
static int selected;
static char selected_session[AC_ID_CAPACITY];
static uint64_t detail_checksum;
static uint64_t received_ms, clock_ms, toast_until, header_updated_ms;
static uint64_t glow_updated_ms,quota_updated_ms;
static ac_observation_health_t transport_health = AC_OBSERVATION_DISCONNECTED;
static ac_detail_request_fn detail_request;
uint32_t ac_bootstrap_screen_pet_frame_updates(unsigned agent){return agent<AC_AGENT_COUNT?ac_pet_widget_frame_updates(pets[agent]):0;}

static lv_obj_t *box(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color)
{
    return ac_neon_box(parent,x,y,w,h,color);
}
static lv_obj_t *text(lv_obj_t *parent,int x,int y,const char *value,uint32_t color)
{
    return ac_neon_text(parent,x,y,value,color);
}
static void hide(lv_obj_t *obj,bool hidden) { if(hidden) lv_obj_add_flag(obj,LV_OBJ_FLAG_HIDDEN); else lv_obj_remove_flag(obj,LV_OBJ_FLAG_HIDDEN); }
static void show_notice(const char *message,uint64_t duration)
{
    lv_obj_set_style_radius(notice,ac_theme_current()==AC_THEME_COMIC?0:ac_theme_current()==AC_THEME_NEUMORPHISM?12:2,0);
    lv_obj_set_style_border_width(notice,ac_theme_current()==AC_THEME_COMIC?3:ac_theme_current()==AC_THEME_NEUMORPHISM?0:1,0);
    lv_label_set_text(notice,message); toast_until=clock_ms+duration;
    hide(notice,false); lv_obj_move_foreground(notice); ac_neon_reveal(notice,1,0);
    if(theme_overlay && !lv_obj_has_flag(theme_overlay,LV_OBJ_FLAG_HIDDEN)) lv_obj_move_foreground(theme_overlay);
}
static void ellipsis(lv_obj_t *label,int width) { lv_obj_set_width(label,width); lv_label_set_long_mode(label,LV_LABEL_LONG_DOT); lv_obj_set_height(label,20); }
static uint32_t state_color(ac_state_t state)
{
    if(state==AC_STATE_RUNNING) return 0x00ffad;
    if(state==AC_STATE_WAITING) return 0xffe600;
    if(state==AC_STATE_ERROR) return 0xff3973;
    return 0xb8faff;
}
static void metric_text(char *out,size_t size,ac_metric_t value)
{
    if(!value.available) snprintf(out,size,"—");
    else if(value.value>=1000000000) snprintf(out,size,"%.2fB",value.value/1000000000);
    else if(value.value>=1000000) snprintf(out,size,"%.1fM",value.value/1000000);
    else if(value.value>=1000) snprintf(out,size,"%.1fk",value.value/1000);
    else snprintf(out,size,"%.0f",value.value);
}
static void duration_text(char *out,size_t size,double seconds)
{
    if(seconds<0) snprintf(out,size,"—");
    else if(seconds>=3600) snprintf(out,size,"%.1fh",seconds/3600);
    else if(seconds>=60) snprintf(out,size,"%.0fm",seconds/60);
    else snprintf(out,size,"%.0fs",seconds);
}
static uint32_t schedule_color(const ac_schedule_t *t){return t->activity==AC_SCHEDULE_RUNNING?0x00ffad:t->activity==AC_SCHEDULE_ERROR?0xff3973:t->activity==AC_SCHEDULE_UNCONFIRMED?0x70d6e2:0xffe600;}
static const char *schedule_activity(const ac_schedule_t *t){return t->activity==AC_SCHEDULE_RUNNING?"运行中":t->activity==AC_SCHEDULE_WAITING?"等待操作":t->activity==AC_SCHEDULE_ERROR?"异常":"运行状态待确认";}
static void schedule_time(char *out,size_t size,int64_t epoch){if(epoch<=0){snprintf(out,size,"—");return;}time_t value=epoch;struct tm local;localtime_r(&value,&local);strftime(out,size,"%m-%d %H:%M",&local);}
static void render_schedule_list(void){
    const ac_agent_schedule_t *a=&current.schedules.agents[selected];unsigned pages=(a->count+4)/5;if(!pages)pages=1;if(schedule_offset>=a->count)schedule_offset=0;hide(schedule_page,showing_detail||pages<=1);
    lv_label_set_text_fmt(panel_title,"%s / 定时 %zu",names[selected],a->count);lv_label_set_text_fmt(lv_obj_get_child(schedule_page,0),"%u/%u ›",schedule_offset/5+1,pages);
    lv_label_set_text(columns[0],"任务 / 关联会话");lv_label_set_text(columns[1],"倒计时 / 计划时间");lv_obj_set_x(columns[1],420);
    for(int i=0;i<5;i++)hide(columns[i],showing_detail||i>1);
    bool fresh=transport_health==AC_OBSERVATION_FRESH&&a->fresh&&a->available&&current.schedules.as_of_epoch>0;
    int64_t now=current.schedules.as_of_epoch+(clock_ms>=received_ms?(clock_ms-received_ms)/1000:0);
    for(unsigned i=0;i<5;i++){
        size_t index=schedule_offset+i;hide(rows[i],showing_detail||index>=a->count);if(index>=a->count)continue;const ac_schedule_t *t=&a->tasks[index];
        hide(row_time[i],false);lv_label_set_text(row_title[i],t->activity&&t->thread_title[0]?t->thread_title:t->title);ellipsis(row_title[i],380);lv_obj_set_style_text_color(row_title[i],ac_color(schedule_color(t)),0);lv_obj_set_style_text_color(row_time[i],ac_color(schedule_color(t)),0);lv_obj_set_style_text_color(row_tokens[i],ac_color(schedule_color(t)),0);
        if(t->activity)lv_label_set_text_fmt(row_state[i],"%s%s · 定时对话",fresh?"":"上次：",schedule_activity(t));else lv_label_set_text_fmt(row_state[i],"%s%s · %s",fresh?"":"上次：",t->status==1?"已启用":t->status==2?"已暂停":"状态未知",t->thread_title[0]?t->thread_title:t->heartbeat?"跟进对话":"定时任务");ellipsis(row_state[i],380);
        lv_obj_set_style_text_color(row_state[i],ac_color(schedule_color(t)),0);
        char value[96];ac_schedule_countdown(value,sizeof(value),t,now,fresh);lv_label_set_text(row_time[i],value);lv_obj_set_pos(row_time[i],408,8);ellipsis(row_time[i],226);
        schedule_time(value,sizeof(value),t->status==2?t->last_epoch:t->next_epoch);lv_label_set_text_fmt(row_tokens[i],"%s%s",t->status==2?"上次 ":"",value);lv_obj_set_pos(row_tokens[i],408,36);ellipsis(row_tokens[i],226);
        hide(row_tokens[i],t->activity!=AC_SCHEDULE_PLANNED);hide(row_cache[i],true);hide(row_context[i],true);hide(context_bars[i],true);
    }
    hide(empty,showing_detail||a->count>0);if(!a->count)lv_label_set_text(empty,a->available?"当前没有本机定时任务":"尚无可验收的本地定时来源\n\n目前支持读取 Codex 本机调度记录。\n不会从普通对话内容推测或创建定时任务。");
    hide(back,!showing_detail);hide(detail_body,!showing_detail);hide(detail_meta,!showing_detail);hide(detail_source,!showing_detail);
}
static bool schedules_fresh(void){return transport_health==AC_OBSERVATION_FRESH&&current.schedules.agents[selected].fresh&&current.schedules.agents[selected].available&&current.schedules.as_of_epoch>0;}
static void task_eta(char *value,size_t capacity,const ac_schedule_t *task,bool compact){
    char remaining[96],date[32];int64_t now=current.schedules.as_of_epoch+(clock_ms>=received_ms?(clock_ms-received_ms)/1000:0);
    ac_schedule_countdown(remaining,sizeof(remaining),task,now,schedules_fresh());schedule_time(date,sizeof(date),task->next_epoch);
    if(compact&&!task->activity)snprintf(value,capacity,"%s · %s",remaining,date);else snprintf(value,capacity,"%s",remaining);
}
static void refresh_countdowns(void){
    const ac_agent_schedule_t *a=&current.schedules.agents[selected];
    for(size_t i=0;i<5;i++){size_t at=schedule_offset+i;const ac_schedule_t *task=NULL;
        if(showing_schedules){if(at<a->count)task=&a->tasks[at];}
        else if(at<home_count&&home_items[at].scheduled)task=&a->tasks[home_items[at].index];
        if(task){char value[160];task_eta(value,sizeof(value),task,!showing_schedules);if(strcmp(lv_label_get_text(row_time[i]),value))lv_label_set_text(row_time[i],value);}
    }
}
static void render_list(void)
{
    hide(schedule_page,showing_detail);lv_obj_set_pos(panel_title,16,14);ellipsis(panel_title,520);
    if(showing_schedules){render_schedule_list();return;}
    const ac_agent_t *a=&current.agents[selected];const ac_agent_schedule_t *tasks=&current.schedules.agents[selected];
    home_count=ac_activity_order(a,scheduled_tasks_visible?tasks:NULL,home_items,AC_SESSION_LIMIT+AC_SCHEDULE_LIMIT);if(schedule_offset>=home_count)schedule_offset=0;
    size_t pages=(home_count+4)/5;if(!pages)pages=1;hide(schedule_page,showing_detail||pages<=1);lv_label_set_text_fmt(lv_obj_get_child(schedule_page,0),"%u/%zu ›",schedule_offset/5+1,pages);
    if(scheduled_tasks_visible&&tasks->count)lv_label_set_text_fmt(panel_title,"%s / 会话与定时",names[selected]);else lv_label_set_text_fmt(panel_title,selected==AC_AGENT_GROK?"%s / 最近 %zu 个 Bot":"%s / 最近 %zu 个会话",names[selected],a->session_count);
    bool grok=selected==AC_AGENT_GROK;
    const char *headings[]={grok?"BOT / 状态":"会话 / 状态",grok?"最近消息":"TIME","IN / OUT","CACHE","CTX"};int colx[]={18,grok?248:266,354,474,572};for(int i=0;i<5;i++){lv_label_set_text(columns[i],headings[i]);lv_obj_set_x(columns[i],colx[i]);hide(columns[i],showing_detail||(grok&&i>=2));}
    for(size_t i=0;i<5;++i){
        size_t at=schedule_offset+i;hide(rows[i],showing_detail||at>=home_count);if(at>=home_count)continue;
        hide(row_time[i],false);ellipsis(row_title[i],232);ellipsis(row_state[i],230);
        if(home_items[at].scheduled){
            const ac_schedule_t *t=&tasks->tasks[home_items[at].index];lv_label_set_text(row_title[i],t->thread_title[0]?t->thread_title:t->title);
            if(t->activity)lv_label_set_text_fmt(row_state[i],"%s%s · 定时对话",schedules_fresh()?"":"上次：",schedule_activity(t));else lv_label_set_text_fmt(row_state[i],"%s定时 · %s",schedules_fresh()?"":"上次：",t->title);
            for(int j=0;j<2;j++)lv_obj_set_style_text_color(j?row_state[i]:row_title[i],ac_color(schedule_color(t)),0);
            char value[160];task_eta(value,sizeof(value),t,true);lv_label_set_text(row_time[i],value);lv_obj_set_pos(row_time[i],253,22);ellipsis(row_time[i],376);lv_obj_set_style_text_color(row_time[i],ac_color(schedule_color(t)),0);
            hide(row_tokens[i],true);hide(row_cache[i],true);hide(row_context[i],true);hide(context_bars[i],true);lv_obj_set_style_border_color(rows[i],ac_color(0x7f6e00),0);continue;
        }
        const ac_session_t *session=&a->sessions[home_items[at].index];hide(row_tokens[i],false);hide(row_cache[i],false);hide(row_context[i],false);
        if(grok){
            bool fresh=transport_health==AC_OBSERVATION_FRESH&&session->health==AC_OBSERVATION_FRESH;
            lv_label_set_text(row_title[i],session->title);ellipsis(row_title[i],210);lv_obj_set_style_text_color(row_title[i],ac_color(0xe9ffff),0);
            lv_label_set_text_fmt(row_state[i],"%s%s",fresh?"":"上次：",ac_state_label(session->state));lv_obj_set_style_text_color(row_state[i],ac_color(fresh?state_color(session->state):0xb8faff),0);ellipsis(row_state[i],210);
            lv_obj_set_pos(row_tokens[i],235,9);lv_obj_set_size(row_tokens[i],395,46);lv_label_set_long_mode(row_tokens[i],LV_LABEL_LONG_DOT);
            if(session->latest_message[0])lv_label_set_text_fmt(row_tokens[i],"%s%s",session->latest_message_assistant?"Bot：":"你：",session->latest_message);else lv_label_set_text(row_tokens[i],"暂无消息");
            lv_obj_set_style_text_color(row_tokens[i],ac_color(0xb8faff),0);lv_obj_set_style_border_color(rows[i],ac_color(0x006877),0);
            hide(row_time[i],true);hide(row_cache[i],true);hide(row_context[i],true);hide(context_bars[i],true);continue;
        }
        hide(row_time[i],false);lv_label_set_long_mode(row_tokens[i],LV_LABEL_LONG_WRAP);
        lv_obj_set_pos(row_time[i],253,22);lv_obj_set_width(row_time[i],80);lv_obj_set_height(row_time[i],20);lv_obj_set_pos(row_tokens[i],342,9);lv_obj_set_width(row_tokens[i],116);lv_obj_set_height(row_tokens[i],45);
        lv_obj_set_style_text_color(row_title[i],ac_color(0xe9ffff),0);lv_obj_set_style_text_color(row_time[i],ac_color(0xb8faff),0);lv_obj_set_style_text_color(row_tokens[i],ac_color(0xe9ffff),0);
        lv_label_set_text(row_title[i],session->title);bool fresh=transport_health==AC_OBSERVATION_FRESH&&session->health==AC_OBSERVATION_FRESH;
        lv_label_set_text_fmt(row_state[i],"%s%s · %s",fresh?"":"上次：",ac_state_label(session->state),session->project[0]?session->project:"本地会话");lv_obj_set_style_text_color(row_state[i],ac_color(fresh?state_color(session->state):0xb8faff),0);
        char value[48],in[24],out[24];duration_text(value,sizeof(value),session->duration_seconds);lv_label_set_text(row_time[i],value);metric_text(in,sizeof(in),session->input);metric_text(out,sizeof(out),session->output);lv_label_set_text_fmt(row_tokens[i],"%s\n%s",in,out);
        if(session->cache_ratio.available)snprintf(value,sizeof(value),"%.0f%%",session->cache_ratio.value*100);else snprintf(value,sizeof(value),"—");lv_label_set_text(row_cache[i],value);
        if(session->context_ratio.available)snprintf(value,sizeof(value),"%s%.0f%%",session->context_ratio.estimated?"~":"",session->context_ratio.value*100);else snprintf(value,sizeof(value),"—");lv_label_set_text(row_context[i],value);hide(context_bars[i],!session->context_ratio.available);lv_obj_set_width(context_bars[i],session->context_ratio.available?(int)(session->context_ratio.value*55)+1:1);lv_obj_set_style_bg_color(context_bars[i],ac_color(colors[selected]),0);lv_obj_set_style_border_color(rows[i],ac_color(0x006877),0);
    }
    hide(empty,showing_detail||home_count>0);if(!home_count)lv_label_set_text(empty,selected==AC_AGENT_CLAUDE?"等待 Claude Code 会话\n\n当前没有可读取的本地 Code 会话记录。":"暂无可发现的本地会话\n\nGateway 会自动刷新可用记录。");
    hide(back,!showing_detail);hide(detail_body,!showing_detail);hide(detail_meta,!showing_detail);hide(detail_source,!showing_detail);
}
static bool agent_visible(int id) {
    for(size_t i=0;i<current.agent_count;++i)if(current.agent_order[i]==(ac_agent_id_t)id)return true;
    return false;
}
static void layout_cards(void) {
    size_t count=current.agent_count; if(count<1||count>AC_VISIBLE_AGENT_LIMIT)return;
    int height=(408-8*((int)count-1))/(int)count;
    for(int i=0;i<AC_AGENT_COUNT;++i)hide(cards[i],!agent_visible(i));
    for(size_t slot=0;slot<count;++slot){
        int id=current.agent_order[slot],center=(height-112)/2;
        lv_obj_set_pos(cards[id],12,60+(height+8)*(int)slot);lv_obj_set_height(cards[id],height);
        lv_obj_set_y(pet_slots[id],center);lv_obj_set_y(card_names[id],center);
        lv_obj_set_y(card_status[id],center+39);lv_obj_set_y(card_counts[id],center+66);lv_obj_set_y(card_quota[id],center+93);
        lv_obj_set_y(card_quota_reset[id],center+93);
        lv_obj_set_height(quota_tracks[id],height-34);
    }
}
static void render_quota(int i)
{
    const ac_agent_t *a=&current.agents[i];
    ac_observation_health_t h=transport_health==AC_OBSERVATION_FRESH?a->health:transport_health;
    const ac_balance_t *balance=&a->balance;
    ac_quota_view_t quota=ac_quota_view(a->quota,AC_OBSERVATION_FRESH);
    bool quota_old=i==AC_AGENT_GROK?transport_health!=AC_OBSERVATION_FRESH:a->quota_stale||h!=AC_OBSERVATION_FRESH;
    bool money=balance->available;
    bool money_fresh=money&&balance->health==AC_OBSERVATION_FRESH&&transport_health==AC_OBSERVATION_FRESH;
    if(money){
        double used=balance->budget>0?1-balance->total/balance->budget:0;
        if(used<0)used=0;if(used>1)used=1;
        quota=ac_quota_view((ac_metric_t){.available=balance->budget>0,.value=used},money_fresh?AC_OBSERVATION_FRESH:AC_OBSERVATION_STALE);
    }
    static const uint32_t quota_colors[]={0x006877,0x00ffad,0xffe600,0xff3973};
    uint32_t quota_color=quota_colors[quota.band];
    bool reset_visible=!money&&quota.available&&a->quota_reset_epoch>0&&current.generated_epoch>0;
    hide(card_quota_reset[i],!reset_visible);
    lv_obj_set_style_text_font(card_quota[i],ac_theme_font(reset_visible?13:16),0);ellipsis(card_quota[i],reset_visible?70:146);
    lv_obj_set_style_text_letter_space(card_quota[i],reset_visible?-1:0,0);
    if(money){
        const char *currency=strcmp(balance->currency,"CNY")==0?"¥":"$";
        lv_label_set_text_fmt(card_quota[i],"%s %s%.2f",money_fresh?"余额":"上次",currency,balance->total);
    }else if(quota.available){
        char window[24];unsigned mins=a->quota_minutes;
        if(mins%1440==0)snprintf(window,sizeof(window),"%ud",mins/1440);
        else if(mins%60==0)snprintf(window,sizeof(window),"%uh",mins/60);
        else snprintf(window,sizeof(window),"%um",mins);
        if(reset_visible)lv_label_set_text_fmt(card_quota[i],quota_old?"上次%s%.0f%%":"%s余%.0f%%",window,quota.remaining_ratio*100);
        else lv_label_set_text_fmt(card_quota[i],"%s%s 剩余 %.0f%%",quota_old?"上次 ":"",window,quota.remaining_ratio*100);
    }else lv_label_set_text(card_quota[i],i==AC_AGENT_DEEPSEEK?"余额 —":"额度 —");
    if(reset_visible){
        int64_t now=current.generated_epoch+(clock_ms>=received_ms?(int64_t)((clock_ms-received_ms)/1000):0);
        char value[48];ac_quota_reset_countdown(value,sizeof(value),a->quota_reset_epoch,now,!quota_old);
        /* 到期只显示待确认，不推定额度已重置；过期观测显示待更新。 */
        lv_label_set_text_fmt(card_quota_reset[i],"%s%s",value,quota_old||a->quota_reset_epoch<=now?"":"重置");
        lv_obj_set_style_text_font(card_quota_reset[i],ac_theme_font(13),0);
        lv_obj_set_style_text_color(card_quota_reset[i],ac_color(0x70d6e2),0);
    }
    uint32_t text_color=money?(money_fresh?(balance->total>0?0x00ffad:0xff3973):0x70d6e2):quota.available?quota_color:0x70d6e2;
    lv_obj_set_style_text_color(card_quota[i],ac_color(text_color),0);
    int track_height=lv_obj_get_height(quota_tracks[i]);
    int fill_height=quota.available?(int)(quota.remaining_ratio*track_height+0.5):0;
    if(quota.available&&quota.remaining_ratio>0&&fill_height==0)fill_height=1;
    hide(quota_fills[i],fill_height==0);
    lv_obj_set_size(quota_fills[i],6,fill_height>0?fill_height:1);
    lv_obj_set_pos(quota_fills[i],0,track_height-fill_height);
    lv_obj_set_style_bg_color(quota_fills[i],ac_color(quota_color),0);
}
static void render_cards(const char *completions[AC_AGENT_COUNT])
{
    layout_cards();
    for(int i=0;i<AC_AGENT_COUNT;++i) {
        if(!agent_visible(i))continue;
        const ac_agent_t *a=&current.agents[i];
        ac_observation_health_t h=transport_health==AC_OBSERVATION_FRESH?a->health:transport_health;
        const char *status=h==AC_OBSERVATION_STALE?"观测已过期":h==AC_OBSERVATION_DISCONNECTED?"Gateway 未连接":ac_state_label(a->state);
        lv_label_set_text(card_status[i],status); lv_obj_set_style_text_color(card_status[i],ac_color(h==AC_OBSERVATION_FRESH?state_color(a->state):0xb8faff),0);
        if(!has_snapshot) lv_label_set_text(card_counts[i],"会话 —");
        else if(!a->total) lv_label_set_text(card_counts[i],i==AC_AGENT_CLAUDE?"未发现 Code 记录":"未发现会话");
        else if(a->running || a->waiting) lv_label_set_text_fmt(card_counts[i],"%u 运行 · %u 等待",a->running,a->waiting);
        else lv_label_set_text_fmt(card_counts[i],i==AC_AGENT_GROK?"%u 个 Bot":"%u 个本地会话",a->total);
        render_quota(i);
        lv_obj_set_style_border_color(cards[i],ac_color(i==selected?colors[i]:0x006877),0);
        lv_obj_set_style_border_width(cards[i],1,0);
        lv_obj_set_style_border_opa(cards[i],ac_theme_current()==AC_THEME_NEON?(i==selected?LV_OPA_COVER:LV_OPA_30):0,0);
        lv_obj_set_style_shadow_color(cards[i],ac_color(colors[i]),0);
        lv_obj_set_style_shadow_width(cards[i],ac_theme_current()==AC_THEME_NEUMORPHISM?16:i==selected && ac_theme_current()==AC_THEME_NEON?18:0,0);lv_obj_set_style_shadow_opa(cards[i],ac_theme_current()==AC_THEME_NEON?LV_OPA_30:0,0);
        ac_theme_selected(cards[i],i==selected);
        ac_pet_view_t v={.agent_id=(ac_agent_id_t)i,.base_expression=ac_expression_for(a->state,a->quality,h),.status_quality=a->quality,
            .observation_health=h,.selected=i==selected,.animation_enabled=animations_enabled,.completion_event_id=completions?completions[i]:NULL};
        ac_pet_widget_set_view(pets[i],&v);
    }
}
static void select_agent(int agent)
{
    bool changed=selected!=agent || showing_detail;
    if(selected!=agent)schedule_offset=0;
    if(!agent_visible(agent))return;
    selected=agent; showing_detail=false; selected_session[0]=0;
    if(detail_request) detail_request("");
    printf("%s selected_agent=%s\n",mock_mode?"MOCK":"LIVE",names[agent]); fflush(stdout);
    if(showing_statistics) ac_usage_panel_filter(agent); else render_list();
    render_cards(NULL);
    if(changed && !showing_statistics) ac_neon_reveal(panel,1,0);
}
static void statistics_closed(void)
{
    showing_statistics=false; ac_usage_panel_hide(); hide(panel,false); select_agent(selected);
    ac_neon_reveal(panel,-1,0);
    printf("UI usage_closed\n"); fflush(stdout);
}
static void statistics_clicked(lv_event_t *e)
{
    int days=*(int *)lv_event_get_user_data(e);
    showing_statistics=true; showing_detail=false; selected_session[0]=0;
    if(detail_request) detail_request("");
    hide(panel,true); ac_usage_panel_open(&current.token_statistics,(unsigned)days);
    printf("UI usage_opened period=%d\n",days); fflush(stdout);
}
static void render_header_usage(void)
{
    for(int i=0;i<2;++i) {
        ac_metric_t total=ac_usage_total(&current.token_statistics,-1,(unsigned)usage_periods[i]); char value[24]; metric_text(value,sizeof(value),total);
        lv_label_set_text_fmt(header_usage[i],"%d天 %s%s ›",usage_periods[i],total.available && total.estimated?"~":"",value);
    }
}
static void agent_clicked(lv_event_t *e) { select_agent(*(int *)lv_event_get_user_data(e)); }
static void back_clicked(lv_event_t *e) { (void)e; select_agent(selected); }
void ac_bootstrap_screen_show_schedules(bool enabled){showing_schedules=enabled&&scheduled_tasks_visible;showing_detail=false;schedule_offset=0;if(detail_request)detail_request("");render_list();}
void ac_bootstrap_screen_set_scheduled_tasks_visible(bool visible){
    if(scheduled_tasks_visible==visible)return;
    scheduled_tasks_visible=visible;showing_schedules=false;schedule_offset=0;
    if(panel)render_list();
}
static void schedule_next(lv_event_t *e){(void)e;size_t count=showing_schedules?current.schedules.agents[selected].count:home_count;schedule_offset=schedule_offset+5<count?schedule_offset+5:0;render_list();}
static void row_clicked(lv_event_t *e)
{
    int index=*(int *)lv_event_get_user_data(e);
    size_t at=schedule_offset+index;const ac_schedule_t *task=NULL;
    if(showing_schedules){const ac_agent_schedule_t *a=&current.schedules.agents[selected];if(at>=a->count)return;task=&a->tasks[at];}
    else{if(at>=home_count)return;if(home_items[at].scheduled)task=&current.schedules.agents[selected].tasks[home_items[at].index];else index=home_items[at].index;}
    if(task){const ac_schedule_t *t=task;
        if(!t->session_id[0]){show_notice("该定时任务暂无已采集的关联会话",2500);return;}
        strcpy(selected_session,t->session_id);showing_detail=true;detail_checksum=0;lv_obj_clean(detail_body);text(detail_body,18,18,"正在读取关联对话…",0xb8faff);render_list();lv_obj_set_pos(panel_title,100,14);ellipsis(panel_title,558);lv_label_set_text(panel_title,t->title);lv_label_set_text(detail_meta,t->status==1?"定时已启用；实际运行由原 Agent 调度器负责":"定时任务已暂停");lv_label_set_text(detail_source,"来源：本机定时调度记录 · 只读");if(detail_request)detail_request(selected_session);return;
    }
    if((size_t)index>=current.agents[selected].session_count) return;
    const ac_session_t *s=&current.agents[selected].sessions[index];
    strcpy(selected_session,s->id); showing_detail=true; detail_checksum=0;
    lv_obj_clean(detail_body); text(detail_body,18,18,"正在读取公开对话…",0xb8faff);
    render_list(); lv_obj_set_pos(panel_title,100,14); ellipsis(panel_title,558); lv_label_set_text(panel_title,s->title);
    ac_neon_reveal(detail_body,1,0);
    lv_label_set_text_fmt(detail_meta,"%s  ·  %s",ac_state_label(s->state),s->model[0]?s->model:"模型 —");
    lv_label_set_text(detail_source,"只读对话 / 等待数据");
    if(detail_request) detail_request(selected_session);
    printf("%s detail_opened\n",mock_mode?"MOCK":"LIVE"); fflush(stdout);
}
static void tool_requested(ac_tool_id_t tool)
{
    if(tool==AC_TOOL_WIFI){ac_wifi_panel_open();return;}
    show_notice(tool==AC_TOOL_PELICAN?"鹈鹕测试 · 测试服务待接入":"连通性检测 · 检测服务待接入",2200);
    printf("UI tool_unavailable=%s\n",tool==AC_TOOL_PELICAN?"pelican":"connectivity");fflush(stdout);
}
void ac_bootstrap_screen_theme_handler(ac_theme_request_fn handler) {request_theme=handler;}
static void theme_choices_refresh(void)
{
    for(int i=0;i<AC_THEME_COUNT;++i) {
        bool active=i==(int)ac_theme_current();
        ac_theme_selected(theme_choices[i],active);
        lv_label_set_text(theme_choice_status[i],active?"✓ 当前使用":"点击使用");
        lv_obj_set_style_text_color(theme_choice_status[i],ac_color(active?AC_NEON_GREEN:AC_NEON_MUTED),0);
    }
}
static void theme_keyboard_group(lv_group_t *group)
{
    for(lv_indev_t *input=lv_indev_get_next(NULL);input;input=lv_indev_get_next(input))
        if(lv_indev_get_type(input)==LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input)==LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input,group);
}
bool ac_bootstrap_screen_close_theme_picker(void)
{
    if(!theme_overlay || lv_obj_has_flag(theme_overlay,LV_OBJ_FLAG_HIDDEN)) return false;
    hide(theme_overlay,true);theme_keyboard_group(screen_group);
    if(theme_previous_focus) lv_group_focus_obj(theme_previous_focus);
    printf("UI theme_picker=closed\n");fflush(stdout);return true;
}
bool ac_bootstrap_screen_close_overlay(void)
{
    return ac_assistant_panel_close() || ac_bootstrap_screen_close_theme_picker();
}
static void theme_dismissed(lv_event_t *e)
{
    if(lv_event_get_current_target_obj(e)!=theme_overlay || lv_event_get_target_obj(e)==theme_overlay) ac_bootstrap_screen_close_theme_picker();
}
static void theme_key(lv_event_t *e)
{
    if(lv_event_get_key(e)==LV_KEY_ESC) ac_bootstrap_screen_close_theme_picker();
}
static void theme_chosen(lv_event_t *e)
{
    ac_theme_id_t choice=(ac_theme_id_t)*(int *)lv_event_get_user_data(e);
    ac_bootstrap_screen_close_theme_picker();
    if(choice==ac_theme_current()) return;
    if(request_theme) request_theme(ac_theme_slug(choice));
    else ac_bootstrap_screen_set_theme(ac_theme_slug(choice));
}
void ac_bootstrap_screen_set_theme(const char *slug)
{
    ac_theme_id_t theme;
    if(!ac_theme_parse(slug,&theme) || theme==ac_theme_current()) return;
    ac_theme_apply(lv_screen_active(),theme);
    ac_neon_animations(animations_enabled);
    if(theme_overlay) theme_choices_refresh();
    if(has_snapshot) render_cards(NULL);
    if(has_snapshot) {char message[80];snprintf(message,sizeof(message),"外观 · %s",ac_theme_name(theme));show_notice(message,1200);}
    printf("UI theme=%s\n",slug);fflush(stdout);
}
static void theme_clicked(lv_event_t *e)
{
    (void)e;
    ac_assistant_panel_close();
    theme_previous_focus=screen_group?lv_group_get_focused(screen_group):NULL;
    theme_choices_refresh();hide(notice,true);hide(theme_overlay,false);lv_obj_move_foreground(theme_overlay);
    theme_keyboard_group(theme_group);lv_group_focus_obj(theme_choices[ac_theme_current()]);
    ac_neon_reveal(theme_dialog,1,0);
    printf("UI theme_picker=opened current=%s\n",ac_theme_slug(ac_theme_current()));fflush(stdout);
}
static void theme_preview_draw(lv_event_t *e)
{
    int id=*(int *)lv_event_get_user_data(e);lv_area_t card;lv_obj_get_coords(lv_event_get_current_target_obj(e),&card);
    lv_area_t area={card.x1+14,card.y1+14,card.x2-14,card.y1+86};lv_layer_t *layer=lv_event_get_layer(e);
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.bg_opa=255;
    d.bg_color=lv_color_hex(id==AC_THEME_NEON?0x0a0a0f:id==AC_THEME_COMIC?0xfffef0:0xe0e5ec);
    d.radius=id==AC_THEME_NEUMORPHISM?12:0;
    if(id==AC_THEME_NEUMORPHISM) {
        d.shadow_color=lv_color_hex(0xb8bcc2);d.shadow_opa=180;d.shadow_width=12;d.shadow_offset_x=4;d.shadow_offset_y=4;lv_draw_rect(layer,&d,&area);
        d.shadow_color=lv_color_hex(0xffffff);d.shadow_offset_x=-4;d.shadow_offset_y=-4;lv_draw_rect(layer,&d,&area);d.shadow_width=0;
    } else {
        d.border_width=id==AC_THEME_COMIC?3:1;d.border_opa=255;d.border_color=lv_color_hex(id==AC_THEME_COMIC?0x1a1a1a:0x00ffff);
        if(id==AC_THEME_COMIC) {d.shadow_width=0;d.shadow_spread=0;d.shadow_color=lv_color_hex(0x1a1a1a);d.shadow_opa=255;d.shadow_offset_x=4;d.shadow_offset_y=4;lv_draw_rect(layer,&d,&area);d.shadow_opa=0;}
    }
    lv_draw_rect(layer,&d,&area);
    if(id==AC_THEME_COMIC) ac_theme_dots(layer,&area,32);
    static const uint32_t accents[AC_THEME_COUNT][3]={{0x00ffff,0xff00ff,0x009dff},{0x3366ff,0xff3333,0xffcc00},{0x7965db,0xa39cbd,0xb9bdcb}};
    for(size_t i=0;i<sizeof(accents[0])/sizeof(accents[0][0]);++i) {
        lv_draw_rect_dsc_init(&d);d.bg_opa=255;d.bg_color=lv_color_hex(accents[id][i]);d.radius=id==AC_THEME_NEUMORPHISM?4:0;
        lv_area_t bar={area.x1+18,area.y1+16+i*16,area.x2-18-i*16,area.y1+22+i*16};lv_draw_rect(layer,&d,&bar);
    }
}
static void theme_picker_create(lv_obj_t *screen)
{
    screen_group=lv_group_get_default();theme_group=lv_group_create();lv_group_set_wrap(theme_group,true);
    theme_overlay=lv_obj_create(screen);lv_obj_remove_style_all(theme_overlay);lv_obj_set_size(theme_overlay,1024,600);
    lv_obj_set_style_bg_color(theme_overlay,lv_color_hex(0x000000),0);lv_obj_set_style_bg_opa(theme_overlay,LV_OPA_60,0);
    lv_obj_remove_flag(theme_overlay,LV_OBJ_FLAG_SCROLLABLE);lv_obj_add_flag(theme_overlay,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(theme_overlay,theme_dismissed,LV_EVENT_CLICKED,NULL);
    theme_dialog=box(theme_overlay,162,140,700,320,0x0c1019);lv_obj_remove_flag(theme_dialog,LV_OBJ_FLAG_EVENT_BUBBLE);lv_obj_add_flag(theme_dialog,LV_OBJ_FLAG_CLICKABLE);
    lv_obj_t *title=text(theme_dialog,20,18,"选择主题",AC_NEON_TEXT);lv_obj_set_style_text_font(title,ac_theme_font(22),0);
    lv_obj_t *hint=text(theme_dialog,20,53,"选择喜欢的界面风格",AC_NEON_MUTED);lv_obj_set_style_text_font(hint,ac_theme_font(13),0);
    static const char *notes[AC_THEME_COUNT]={"霓虹边缘 · 等宽字体","粗墨线 · 网点 · 硬阴影","柔和双阴影 · 灰色曲面"};
    for(int i=0;i<AC_THEME_COUNT;++i) {
        theme_choices[i]=box(theme_dialog,20+i*224,92,208,180,0x001d25);lv_obj_add_flag(theme_choices[i],LV_OBJ_FLAG_CLICKABLE);
        lv_obj_remove_flag(theme_choices[i],LV_OBJ_FLAG_EVENT_BUBBLE);ac_neon_interactive(theme_choices[i],AC_NEON_CYAN);lv_group_add_obj(theme_group,theme_choices[i]);
        lv_obj_add_event_cb(theme_choices[i],theme_chosen,LV_EVENT_CLICKED,&theme_ids[i]);lv_obj_add_event_cb(theme_choices[i],theme_key,LV_EVENT_KEY,NULL);
        lv_obj_add_event_cb(theme_choices[i],theme_preview_draw,LV_EVENT_DRAW_MAIN_END,&theme_ids[i]);
        lv_obj_t *name=text(theme_choices[i],14,102,ac_theme_name((ac_theme_id_t)i),AC_NEON_TEXT);lv_obj_set_style_text_font(name,ac_theme_font(20),0);
        lv_obj_t *note=text(theme_choices[i],14,135,notes[i],AC_NEON_MUTED);lv_obj_set_style_text_font(note,ac_theme_font(13),0);
        theme_choice_status[i]=text(theme_choices[i],14,157,"",AC_NEON_MUTED);lv_obj_set_style_text_font(theme_choice_status[i],ac_theme_font(13),0);
    }
    lv_obj_t *close=box(theme_dialog,644,16,36,32,0x001d25);lv_obj_add_flag(close,LV_OBJ_FLAG_CLICKABLE);lv_obj_remove_flag(close,LV_OBJ_FLAG_EVENT_BUBBLE);
    ac_neon_interactive(close,AC_NEON_CYAN);lv_group_add_obj(theme_group,close);lv_obj_add_event_cb(close,theme_dismissed,LV_EVENT_CLICKED,NULL);lv_obj_add_event_cb(close,theme_key,LV_EVENT_KEY,NULL);
    text(close,10,5,"×",AC_NEON_TEXT);
    lv_obj_t *footer=text(theme_dialog,20,289,"点击主题立即应用 · 点击空白处关闭",AC_NEON_MUTED);lv_obj_set_style_text_font(footer,ac_theme_font(13),0);
    theme_choices_refresh();hide(theme_overlay,true);
}
static void shirt_draw(lv_event_t *e)
{
    static const lv_point_t outline[]={{7,2},{10,4},{14,4},{17,2},{23,6},{20,12},{17,10},{17,23},{7,23},{7,10},{4,12},{1,6},{7,2}};
    lv_area_t area;lv_obj_get_coords(lv_event_get_current_target_obj(e),&area);
    lv_draw_line_dsc_t d;lv_draw_line_dsc_init(&d);d.color=ac_color(0xe9ffff);d.opa=255;d.width=2;
    for(unsigned i=0;i+1<sizeof(outline)/sizeof(outline[0]);++i) {d.p1=(lv_point_precise_t){area.x1+6+outline[i].x,area.y1+3+outline[i].y};d.p2=(lv_point_precise_t){area.x1+6+outline[i+1].x,area.y1+3+outline[i+1].y};lv_draw_line(lv_event_get_layer(e),&d);}
}
static void status_bubble(lv_event_t *e)
{
    if(ac_theme_current()!=AC_THEME_COMIC) return;
    if(lv_event_get_code(e)==LV_EVENT_REFR_EXT_DRAW_SIZE) {lv_event_set_ext_draw_size(e,8);return;}
    lv_area_t area;lv_obj_get_coords(lv_event_get_current_target_obj(e),&area);area.x1-=6;area.x2+=6;area.y1-=3;
    lv_layer_t *layer=lv_event_get_layer(e);lv_draw_triangle_dsc_t tail;lv_draw_triangle_dsc_init(&tail);tail.color=lv_color_hex(0x1a1a1a);tail.opa=255;
    tail.p[0]=(lv_point_precise_t){area.x1+7,area.y2-1};tail.p[1]=(lv_point_precise_t){area.x1+17,area.y2-1};tail.p[2]=(lv_point_precise_t){area.x1+8,area.y2+6};lv_draw_triangle(layer,&tail);
    lv_draw_rect_dsc_t d;lv_draw_rect_dsc_init(&d);d.radius=8;d.bg_color=lv_color_hex(0xffcc00);d.bg_opa=255;d.border_color=lv_color_hex(0x1a1a1a);d.border_width=3;d.border_opa=255;lv_draw_rect(layer,&d,&area);
    tail.color=lv_color_hex(0xffcc00);tail.p[0]=(lv_point_precise_t){area.x1+10,area.y2-3};tail.p[1]=(lv_point_precise_t){area.x1+14,area.y2-3};tail.p[2]=(lv_point_precise_t){area.x1+10,area.y2+1};lv_draw_triangle(layer,&tail);
}
void ac_bootstrap_screen_create(bool use_assets,bool mock,ac_detail_request_fn request_detail)
{
    scheduled_tasks_visible=true;showing_schedules=false;schedule_offset=0;
    mock_mode=mock; detail_request=request_detail; selected=0; showing_detail=false; showing_statistics=false; has_snapshot=false;
    transport_health=AC_OBSERVATION_DISCONNECTED; memset(&current,0,sizeof(current));
    for(int i=0;i<AC_AGENT_COUNT;++i) { current.agents[i].state=AC_STATE_UNKNOWN; current.agents[i].quality=AC_QUALITY_UNKNOWN; }
    current.agent_count=3;current.agent_order[0]=AC_AGENT_CODEX;current.agent_order[1]=AC_AGENT_GROK;current.agent_order[2]=AC_AGENT_DEEPSEEK;
    lv_obj_t *screen=lv_screen_active(); lv_obj_set_style_bg_color(screen,ac_color(0x0a0a0f),0); lv_obj_remove_flag(screen,LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_text_font(screen,ac_theme_font(16),0); ac_neon_grid(screen);
    lv_obj_t *header=box(screen,12,10,1000,42,0x0c1019);
    lv_obj_t *brand=text(header,16,9,"AGENT // COMPANION",0x00ffff); lv_obj_set_style_text_font(brand,ac_theme_font(20),0); lv_obj_set_style_text_letter_space(brand,ac_theme_tracking(),0); ac_neon_glow_text(brand);
    for(int i=0;i<2;++i) {
        lv_obj_t *usage=box(header,260+i*166,5,150,32,0x001d25); lv_obj_add_flag(usage,LV_OBJ_FLAG_CLICKABLE);
        ac_neon_interactive(usage,AC_NEON_CYAN);
        lv_obj_add_event_cb(usage,statistics_clicked,LV_EVENT_CLICKED,&usage_periods[i]);
        header_usage[i]=text(usage,8,5,i?"30天 — ›":"7天 — ›",0xb8faff);
    }
    lv_obj_t *theme_button=box(header,952,5,36,32,0x001d25);lv_obj_add_flag(theme_button,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(theme_button,AC_NEON_CYAN);
    lv_obj_add_event_cb(theme_button,theme_clicked,LV_EVENT_CLICKED,NULL);
    lv_obj_add_event_cb(theme_button,shirt_draw,LV_EVENT_DRAW_MAIN_END,NULL);
    header_clock=text(header,650,13,"--:--:--",0xb8faff);lv_obj_set_style_text_font(header_clock,ac_theme_font(13),0);
    header_status=text(header,780,12,mock?"MOCK · 连接中":"LIVE · 连接中",0xffe600);
    for(int i=0;i<AC_AGENT_COUNT;++i) {
        cards[i]=box(screen,12,60+i*150,300,142,0x0c1019); lv_obj_add_flag(cards[i],LV_OBJ_FLAG_CLICKABLE);
        ac_neon_interactive(cards[i],colors[i]);
        ac_neon_scanlines(cards[i]);
        lv_obj_add_event_cb(cards[i],agent_clicked,LV_EVENT_CLICKED,&agent_ids[i]);
        lv_obj_t *slot=box(cards[i],8,15,112,112,0x0c1019); ac_neon_flat(slot);
        pet_slots[i]=slot;
        pets[i]=ac_pet_widget_create(slot,use_assets?ac_pet_assets_for_agent((ac_agent_id_t)i):NULL);
        lv_obj_t *name=text(cards[i],128,15,names[i],colors[i]);card_names[i]=name; lv_obj_set_style_text_font(name,ac_theme_font(20),0); lv_obj_set_style_text_letter_space(name,ac_theme_tracking(),0);
        card_status[i]=text(cards[i],128,54,"连接中",0xb8faff);
        lv_obj_add_event_cb(card_status[i],status_bubble,LV_EVENT_DRAW_MAIN_BEGIN,NULL);lv_obj_add_event_cb(card_status[i],status_bubble,LV_EVENT_REFR_EXT_DRAW_SIZE,NULL);lv_obj_refresh_ext_draw_size(card_status[i]);
        card_counts[i]=text(cards[i],128,81,"会话 —",0xb8faff); ellipsis(card_counts[i],146);
        card_quota[i]=text(cards[i],128,108,"额度 —",0x70d6e2); ellipsis(card_quota[i],146);
        card_quota_reset[i]=text(cards[i],202,108,"",0x70d6e2);ellipsis(card_quota_reset[i],72);lv_obj_set_style_text_letter_space(card_quota_reset[i],-1,0);lv_obj_set_style_text_align(card_quota_reset[i],LV_TEXT_ALIGN_RIGHT,0);hide(card_quota_reset[i],true);
        quota_tracks[i]=box(cards[i],282,17,6,108,0x006877); lv_obj_set_style_border_width(quota_tracks[i],0,0); lv_obj_set_style_radius(quota_tracks[i],3,0); lv_obj_set_style_clip_corner(quota_tracks[i],true,0);
        quota_fills[i]=box(quota_tracks[i],0,0,6,108,0x006877); lv_obj_set_style_border_width(quota_fills[i],0,0); lv_obj_set_style_radius(quota_fills[i],3,0);
    }
    panel=box(screen,324,60,688,408,0x0c1019); panel_title=text(panel,16,14,"",0xe9ffff);
    schedule_page=box(panel,564,8,106,30,0x002832);lv_obj_add_flag(schedule_page,LV_OBJ_FLAG_CLICKABLE);text(schedule_page,12,4,"1/1 ›",0x00ffff);ac_neon_interactive(schedule_page,AC_NEON_CYAN);lv_obj_add_event_cb(schedule_page,schedule_next,LV_EVENT_CLICKED,NULL);
    lv_obj_set_style_border_opa(panel,LV_OPA_50,0); ac_neon_rule(panel,14,41,658,AC_NEON_CYAN,LV_OPA_30);
    ac_neon_scanlines(panel);
    const char *headings[]={"会话 / 状态","TIME","IN / OUT","CACHE","CTX"}; int colx[]={18,266,354,474,572};
    for(int i=0;i<5;++i) { columns[i]=text(panel,colx[i],52,headings[i],0x70d6e2); lv_obj_set_style_text_font(columns[i],ac_theme_font(13),0); lv_obj_set_style_text_letter_space(columns[i],ac_theme_tracking(),0); }
    for(int i=0;i<5;++i) {
        rows[i]=box(panel,12,78+64*i,664,60,0x0c1019); lv_obj_add_flag(rows[i],LV_OBJ_FLAG_CLICKABLE);
        ac_neon_flat(rows[i]); lv_obj_set_style_border_width(rows[i],1,0); lv_obj_set_style_border_side(rows[i],LV_BORDER_SIDE_BOTTOM,0); ac_neon_interactive(rows[i],AC_NEON_CYAN);
        lv_obj_add_event_cb(rows[i],row_clicked,LV_EVENT_CLICKED,&row_ids[i]);
        row_title[i]=text(rows[i],13,8,"",0xe9ffff); ellipsis(row_title[i],232);
        row_state[i]=text(rows[i],13,36,"",0xb8faff); ellipsis(row_state[i],230);
        row_time[i]=text(rows[i],253,22,"—",0xb8faff);
        row_tokens[i]=text(rows[i],342,9,"—\n—",0xe9ffff); lv_obj_set_style_text_line_space(row_tokens[i],5,0);
        row_cache[i]=text(rows[i],465,22,"—",0xb8faff); row_context[i]=text(rows[i],563,13,"—",0xb8faff);
        context_bars[i]=box(rows[i],561,43,1,3,colors[selected]); lv_obj_set_style_border_width(context_bars[i],0,0);
        text(rows[i],640,21,">",0x70d6e2);
    }
    empty=text(panel,28,153,"",0xb8faff); lv_obj_set_width(empty,624); lv_obj_set_style_text_line_space(empty,7,0);
    back=box(panel,12,9,76,32,0x002832); lv_obj_add_flag(back,LV_OBJ_FLAG_CLICKABLE); text(back,9,5,"‹ 返回",0x00ffff); lv_obj_add_event_cb(back,back_clicked,LV_EVENT_CLICKED,NULL);
    ac_neon_interactive(back,AC_NEON_CYAN);
    detail_meta=text(panel,16,49,"",0xb8faff); ellipsis(detail_meta,650);
    detail_source=text(panel,16,75,"",0x70d6e2); ellipsis(detail_source,650);
    detail_body=box(panel,12,104,664,286,0x0a0a0f); lv_obj_add_flag(detail_body,LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE); lv_obj_set_scroll_dir(detail_body,LV_DIR_VER); lv_obj_set_scrollbar_mode(detail_body,LV_SCROLLBAR_MODE_AUTO);
    ac_neon_flat(detail_body); lv_obj_set_style_anim_duration(detail_body,140,0);
    lv_obj_set_style_bg_color(detail_body,ac_color(0x70d6e2),LV_PART_SCROLLBAR); lv_obj_set_style_bg_opa(detail_body,LV_OPA_50,LV_PART_SCROLLBAR); lv_obj_set_style_width(detail_body,3,LV_PART_SCROLLBAR);
    ac_assistant_panel_create(screen,mock,tool_requested);
    ac_wifi_panel_create(screen,mock);
    if(mock) {
        static const ac_assistant_message_view_t demo[]={
            {"demo-1","09:36","示例项目 A：本轮修改已报告完成，等待验收。","演示 · 项目进展"},
            {"demo-2","09:38","示例项目 B：需要确认接口方案，可回到原会话继续处理。","演示 · 关注事项"},
            {"demo-3","09:40","项目简报会保留关键决定与来源，后续修改会替代旧方案。","演示 · 助手回复"},
            {"demo-4","09:42","示例项目 B：需要确认接口方案，可回到原会话继续处理。示例项目 A：本轮修改已报告完成，等待验收；后续修改会替代旧方案，并保留关键决定与来源。","演示 · 最新消息"}
        };
        ac_assistant_feed_view_t feed={AC_ASSISTANT_READY,true,demo,sizeof(demo)/sizeof(demo[0])};
        ac_assistant_panel_set_feed(&feed);
    }
    notice=text(screen,348,424,"",0x70d6e2); ellipsis(notice,640); lv_obj_set_height(notice,28);
    lv_obj_set_style_text_font(notice,ac_theme_font(13),0); lv_obj_set_style_pad_left(notice,10,0); lv_obj_set_style_pad_top(notice,5,0);
    lv_obj_set_style_bg_color(notice,ac_color(AC_NEON_BG),0); lv_obj_set_style_bg_opa(notice,LV_OPA_COVER,0);
    lv_obj_set_style_border_color(notice,ac_color(AC_NEON_CYAN),0); lv_obj_set_style_border_width(notice,1,0); lv_obj_set_style_border_opa(notice,LV_OPA_60,0);
    hide(notice,true);
    ac_usage_panel_create(screen,statistics_closed);
    theme_picker_create(screen);
    select_agent(0);
}
void ac_bootstrap_screen_apply(const ac_snapshot_t *snapshot,uint64_t now)
{
    const char *events[AC_AGENT_COUNT]={0};
    if(has_snapshot && continuous && transport_health==AC_OBSERVATION_FRESH && now-received_ms<6000 && snapshot->seq>current.seq && snapshot->seq-current.seq<=2)
        for(int i=0;i<AC_AGENT_COUNT;++i) events[i]=ac_completion_transition(&current.agents[i],&snapshot->agents[i]);
    // Event pointers belong to the incoming snapshot and are copied synchronously by PetWidget.
    if(transport_health!=AC_OBSERVATION_FRESH) { printf("UI transport=fresh at_ms=%llu\n",(unsigned long long)now); fflush(stdout); hide(notice,true); toast_until=0; }
    current=*snapshot; has_snapshot=true; continuous=true; clock_ms=now; received_ms=now; transport_health=AC_OBSERVATION_FRESH;
    if(!current.agent_count){current.agent_count=3;for(int i=0;i<3;++i)current.agent_order[i]=(ac_agent_id_t)i;}
    if(!agent_visible(selected))select_agent(current.agent_order[0]);
    render_cards(events);
    render_header_usage();
    if(showing_statistics) ac_usage_panel_update(&current.token_statistics);
    else if(!showing_detail) render_list();
}
void ac_bootstrap_screen_connection_lost(void) { continuous=false; }
void ac_bootstrap_screen_set_animations(bool enabled) { animations_enabled=enabled; ac_neon_animations(enabled); render_cards(NULL); }
int32_t ac_bootstrap_screen_detail_scroll_y(void) { return showing_detail?lv_obj_get_scroll_y(detail_body):0; }
void ac_bootstrap_screen_scroll_at(int x,int y,int delta)
{
    if(ac_wifi_panel_scroll_at(x,y,delta))return;
    if(theme_overlay && !lv_obj_has_flag(theme_overlay,LV_OBJ_FLAG_HIDDEN)) return;
    if(ac_assistant_panel_scroll_at(x,y,delta)) return;
    if(showing_detail && x>=336 && x<1000 && y>=165 && y<485) lv_obj_scroll_by(detail_body,0,delta,LV_ANIM_ON);
}
static uint64_t text_hash(uint64_t hash,const char *value)
{
    do { hash^=(unsigned char)*value; hash*=UINT64_C(1099511628211); } while(*value++);
    return hash;
}
void ac_bootstrap_screen_detail(const ac_session_detail_t *detail)
{
    if(!showing_detail || strcmp(detail->session.id,selected_session)!=0) return;
    const ac_session_t *s=&detail->session;
    lv_label_set_text_fmt(detail_meta,"%s  ·  %s  ·  %zu 条公开消息",ac_state_label(s->state),s->model[0]?s->model:"模型 —",detail->message_count);
    const char *source=strstr(s->status_source,"live_writer_fd")?"任务事件 + 本机运行进程":strstr(s->status_source,"task_complete")?"任务完成事件":strstr(s->status_source,"dsh.turn/end")?"Harness 任务结束事件":"本机会话记录";
    lv_label_set_text_fmt(detail_source,"依据：%s · %.8sZ",source,strlen(s->observed_at)>=19?s->observed_at+11:"—");
    if(selected==AC_AGENT_GROK){lv_label_set_text_fmt(detail_meta,"%s  ·  %zu 条公开消息",ac_state_label(s->state),detail->message_count);lv_label_set_text(detail_source,"Grok Bot · 最近消息");}
    lv_label_set_text(panel_title,s->title);
    uint64_t checksum=text_hash(UINT64_C(14695981039346656037),s->title);
    if(detail->truncated) checksum^=1;
    for(size_t i=0;i<detail->message_count;++i) { checksum=text_hash(checksum,detail->messages[i].id); checksum=text_hash(checksum,detail->messages[i].text); }
    if(checksum==detail_checksum) return;
    bool first=detail_checksum==0; int32_t scroll=lv_obj_get_scroll_y(detail_body); bool bottom=lv_obj_get_scroll_bottom(detail_body)<24;
    lv_obj_clean(detail_body); int y=12;
    lv_obj_t *full_title=text(detail_body,16,y,s->title,0xb8faff); lv_obj_set_width(full_title,620); lv_label_set_long_mode(full_title,LV_LABEL_LONG_WRAP);
    lv_obj_update_layout(full_title); y+=(int)lv_obj_get_height(full_title)+18;
    if(!detail->message_count) text(detail_body,18,18,"此来源暂时没有可读取的公开对话。",0xb8faff);
    for(size_t i=0;i<detail->message_count;++i) {
        const ac_message_t *m=&detail->messages[i];
        lv_obj_t *bubble=box(detail_body,m->assistant?10:28,y,m->assistant?620:602,48,m->assistant?0x0c1019:0x001d25);
        ac_neon_flat(bubble); lv_obj_set_style_border_width(bubble,1,0); lv_obj_set_style_border_side(bubble,LV_BORDER_SIDE_BOTTOM,0);
        lv_obj_set_style_border_color(bubble,ac_color(m->assistant?0x006877:0x006877),0);
        text(bubble,12,8,m->assistant?"助手":"你",m->assistant?colors[selected]:0xb8faff);
        lv_obj_t *content=text(bubble,12,33,m->text,0xe9ffff); lv_obj_set_width(content,m->assistant?596:578); lv_label_set_long_mode(content,LV_LABEL_LONG_WRAP); lv_obj_set_style_text_line_space(content,4,0);
        lv_obj_update_layout(content); int height=(int)lv_obj_get_height(content)+48; lv_obj_set_height(bubble,height); y+=height+12;
    }
    if(detail->truncated) { text(detail_body,16,y,"以上为最近消息节选，长内容已截短。",0x70d6e2); y+=32; }
    detail_checksum=checksum;
    lv_obj_update_layout(detail_body);
    if(first || bottom) lv_obj_scroll_to_y(detail_body,lv_obj_get_scroll_y(detail_body)+lv_obj_get_scroll_bottom(detail_body),LV_ANIM_OFF);
    else lv_obj_scroll_to_y(detail_body,scroll,LV_ANIM_OFF);
}
void ac_bootstrap_screen_tick(uint64_t now)
{
    clock_ms=now;
    ac_observation_health_t health=!has_snapshot || now-received_ms>30000?AC_OBSERVATION_DISCONNECTED:now-received_ms>6000?AC_OBSERVATION_STALE:AC_OBSERVATION_FRESH;
    if(health!=transport_health) {
        printf("UI transport=%s at_ms=%llu\n",health==AC_OBSERVATION_STALE?"stale":health==AC_OBSERVATION_DISCONNECTED?"disconnected":"fresh",(unsigned long long)now); fflush(stdout);
        transport_health=health; render_cards(NULL); if(!showing_detail) render_list();
        if(has_snapshot && health!=AC_OBSERVATION_FRESH) show_notice("连接中断 · 保留最后记录，状态动作已降级",2200);
    }
    for(int i=0;i<AC_AGENT_COUNT;++i) if(agent_visible(i))ac_pet_widget_tick(pets[i],now);
    if(now-quota_updated_ms>=1000){quota_updated_ms=now;for(int i=0;i<AC_AGENT_COUNT;++i)if(agent_visible(i))render_quota(i);}
    if(animations_enabled && ac_theme_current()==AC_THEME_NEON && now-glow_updated_ms>=80) {
        glow_updated_ms=now;
        lv_opa_t glow=(lv_opa_t)(45+25*(sin((double)(now%2800)*6.283185307179586/2800)+1)/2);
        lv_obj_set_style_shadow_opa(cards[selected],glow,0);
    }
    if(now-header_updated_ms>=250) {
        header_updated_ms=now;
        if(!showing_detail&&!showing_statistics)refresh_countdowns();
        lv_label_set_text_fmt(header_status,"%s · %s",mock_mode?"MOCK":"LIVE",health==AC_OBSERVATION_FRESH?"已连接":health==AC_OBSERVATION_STALE?"重连中":"未连接");
        lv_obj_set_style_text_color(header_status,ac_color(mock_mode?0xffe600:health==AC_OBSERVATION_FRESH?0x00ffad:0xffe600),0);
        time_t wall=time(NULL); struct tm local; localtime_r(&wall,&local); char clock[16]; strftime(clock,sizeof(clock),"%H:%M:%S",&local); lv_label_set_text(header_clock,clock);
        if(now>=toast_until) hide(notice,true);
    }
}
void ac_bootstrap_screen_destroy(void)
{
    ac_bootstrap_screen_close_theme_picker();lv_group_delete(theme_group);theme_group=NULL;
    ac_wifi_panel_destroy();ac_assistant_panel_destroy();
    for(int i=0;i<AC_AGENT_COUNT;++i) ac_pet_widget_destroy(pets[i]);
    lv_obj_clean(lv_screen_active());
    theme_overlay=NULL;
}

void ac_bootstrap_screen_connection_hint(const char *text) { if(header_status&&text)lv_label_set_text(header_status,text); }
