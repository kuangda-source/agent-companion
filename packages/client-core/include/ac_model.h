#ifndef AC_MODEL_H
#define AC_MODEL_H

#include "ac_pet_contract.h"
#include <stddef.h>

enum { AC_SESSION_LIMIT = 5, AC_MESSAGE_LIMIT = 12, AC_ID_CAPACITY = 160, AC_USAGE_DAYS = 30 };
enum { AC_SCHEDULE_LIMIT = 32 };
enum { AC_SCHEDULE_PLANNED,AC_SCHEDULE_RUNNING,AC_SCHEDULE_WAITING,AC_SCHEDULE_ERROR,AC_SCHEDULE_UNCONFIRMED };
typedef struct {char title[256],session_id[AC_ID_CAPACITY],thread_title[256];unsigned status,activity;bool heartbeat;int64_t next_epoch,last_epoch;} ac_schedule_t;
typedef struct {bool available,fresh;size_t count;ac_schedule_t tasks[AC_SCHEDULE_LIMIT];} ac_agent_schedule_t;
typedef struct {int64_t as_of_epoch;ac_agent_schedule_t agents[AC_AGENT_COUNT];} ac_schedules_t;
void ac_schedule_countdown(char *out,size_t capacity,const ac_schedule_t *task,int64_t now,bool fresh);
typedef enum { AC_STATE_RUNNING, AC_STATE_WAITING, AC_STATE_IDLE, AC_STATE_COMPLETED,
               AC_STATE_ERROR, AC_STATE_UNKNOWN, AC_STATE_DISCONNECTED } ac_state_t;
typedef struct { double value; bool available; bool estimated; } ac_metric_t;
typedef struct {
    bool available;
    ac_observation_health_t health;
    char currency[4], observed_at[32], note[128];
    double total, granted, topped_up, budget;
} ac_balance_t;
typedef struct { char date[11]; ac_metric_t tokens[AC_AGENT_COUNT]; } ac_usage_day_t;
typedef struct {
    bool loading, failed, partial;
    bool available[AC_AGENT_COUNT], agent_partial[AC_AGENT_COUNT];
    char timezone[64], observed_at[32];
    size_t day_count;
    ac_usage_day_t days[AC_USAGE_DAYS];
} ac_usage_stats_t;
/* agent=-1 sums available sources; missing sources remain marked estimated/partial. */
ac_metric_t ac_usage_total(const ac_usage_stats_t *stats, int agent, unsigned days);
typedef enum { AC_QUOTA_UNKNOWN, AC_QUOTA_GREEN, AC_QUOTA_YELLOW, AC_QUOTA_RED } ac_quota_band_t;
typedef struct { bool available; double remaining_ratio; ac_quota_band_t band; } ac_quota_view_t;
ac_quota_view_t ac_quota_view(ac_metric_t used, ac_observation_health_t health);
typedef struct {
    char id[96];
    bool assistant;
    char text[4096];
} ac_message_t;
typedef struct {
    char id[AC_ID_CAPACITY];
    char title[1024];
    char project[128];
    char model[96];
    char status_source[192];
    char completion_id[AC_PET_COMPLETION_ID_CAPACITY];
    char observed_at[32];
    char last_activity_at[32];
    bool completion_recent;
    ac_state_t state;
    ac_data_quality_t quality;
    ac_observation_health_t health;
    double duration_seconds;
    ac_metric_t input, output, cache_ratio, context_ratio;
} ac_session_t;
typedef struct {
    ac_state_t state;
    ac_data_quality_t quality;
    ac_observation_health_t health;
    unsigned total, running, waiting;
    char note[256];
    ac_metric_t quota;
    unsigned quota_minutes;
    ac_balance_t balance;
    ac_session_t sessions[AC_SESSION_LIMIT];
    size_t session_count;
} ac_agent_t;
typedef struct {bool scheduled;size_t index;} ac_activity_item_t;
size_t ac_activity_order(const ac_agent_t *agent,const ac_agent_schedule_t *tasks,ac_activity_item_t *items,size_t capacity);
typedef struct {
    uint64_t seq;
    bool mock;
    char generated_at[32];
    ac_agent_t agents[AC_AGENT_COUNT];
    ac_usage_stats_t token_statistics;
    ac_schedules_t schedules;
} ac_snapshot_t;
typedef struct {
    ac_session_t session;
    ac_message_t messages[AC_MESSAGE_LIMIT];
    size_t message_count;
    bool truncated;
} ac_session_detail_t;

/* Assistant feed is decoded separately from monitoring snapshots. */
typedef struct { char id[96],text[4096],time[24],source[128]; } ac_assistant_message_t;
typedef struct {
    bool mock; unsigned status; uint64_t revision;
    size_t message_count; ac_assistant_message_t messages[8];
} ac_assistant_feed_t;

ac_pet_expression_t ac_expression_for(ac_state_t state, ac_data_quality_t quality,
                                    ac_observation_health_t health);
const char *ac_state_label(ac_state_t state);
/* Full/reconnect snapshots do not call this; only a continuous observation does. */
const char *ac_completion_transition(const ac_agent_t *before, const ac_agent_t *after);

#endif
