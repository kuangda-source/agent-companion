#ifndef AC_GATEWAY_CLIENT_H
#define AC_GATEWAY_CLIENT_H
#include "ac_model.h"
typedef struct {
    bool online;
    bool has_detail;
    bool has_settings, animations_enabled;
    uint64_t settings_revision;
    char theme[16];
    ac_snapshot_t snapshot;
    ac_session_detail_t detail;
    bool has_assistant;
    ac_assistant_feed_t assistant;
} ac_gateway_result_t;
bool ac_gateway_client_start(const char *url, const char *token_path, bool allow_mock);
bool ac_gateway_client_take(ac_gateway_result_t *result);
void ac_gateway_client_request_detail(const char *id);
void ac_gateway_client_request_theme(const char *theme);
void ac_gateway_client_request_assistant_refresh(void);
void ac_gateway_client_stop(void);
/* Same boundary decoder used by the HTTP transport and its malformed-input tests. */
bool ac_gateway_decode(const void *bytes, size_t length, ac_snapshot_t *snapshot, bool allow_mock);
bool ac_gateway_decode_assistant(const void *bytes,size_t length,ac_assistant_feed_t *feed,bool allow_mock);
#endif
