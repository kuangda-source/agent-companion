#import <Foundation/Foundation.h>
#include "ac_gateway_client.h"
#include <pthread.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>
#include <time.h>

static pthread_t worker;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static bool stopping, started, dirty, allow_mock_data;
static char gateway_url[256], token_file[1024], detail_id[AC_ID_CAPACITY];
static char pending_theme[16];
static bool pending_assistant_refresh;
static ac_assistant_feed_t previous_assistant;
static bool have_assistant;
static ac_gateway_result_t latest;
static NSDictionary *obj(id value) { return [value isKindOfClass:NSDictionary.class] ? value : @{}; }
static NSArray *arr(id value) { return [value isKindOfClass:NSArray.class] ? value : @[]; }
static NSString *str(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static double numeric(id value)
{
    if(![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value)==CFBooleanGetTypeID()) return -1;
    double n=[value doubleValue]; return isfinite(n) && n>=0 ? n : -1;
}
static NSDate *date_from(id value)
{
    NSISO8601DateFormatter *formatter=[NSISO8601DateFormatter new];
    formatter.formatOptions=NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    NSDate *date=[formatter dateFromString:str(value)];
    if(!date) { formatter.formatOptions=NSISO8601DateFormatWithInternetDateTime; date=[formatter dateFromString:str(value)]; }
    return date;
}
static void copy_text(char *dest, size_t capacity, id value)
{
    const char *source = str(value).UTF8String;
    size_t size = strlen(source);
    if(size >= capacity) { size = capacity - 1; while(size > 0 && ((unsigned char)source[size] & 0xc0) == 0x80) --size; }
    memcpy(dest, source, size); dest[size] = 0;
}
static int index_of(id value, NSArray<NSString *> *values, int fallback)
{
    NSUInteger index = [values indexOfObject:str(value)]; return index == NSNotFound ? fallback : (int)index;
}
static ac_metric_t metric(id value)
{
    NSDictionary *m = obj(value); id v = m[@"value"];
    bool valid = numeric(v)>=0 && ([m[@"quality"] isEqual:@"confirmed"] || [m[@"quality"] isEqual:@"estimated"]);
    return (ac_metric_t){.available=valid, .value=valid ? [v doubleValue] : 0, .estimated=[m[@"quality"] isEqual:@"estimated"]};
}
static ac_data_quality_t quality(id v) { return (ac_data_quality_t)index_of(v, @[@"confirmed", @"estimated", @"unavailable", @"unknown"], AC_QUALITY_UNKNOWN); }
static ac_observation_health_t health(id v) { return (ac_observation_health_t)index_of(v, @[@"fresh", @"stale", @"disconnected", @"unknown"], AC_OBSERVATION_UNKNOWN); }
static ac_state_t state(id v) { return (ac_state_t)index_of(v, @[@"running", @"waiting_user", @"idle", @"completed", @"error", @"unknown", @"disconnected"], AC_STATE_UNKNOWN); }
static bool balance_decimal(id value,double *out)
{
    if(![value isKindOfClass:NSString.class] || ![value length] || [value length]>40) return false;
    const char *raw=[value UTF8String]; char *end=NULL;
    double n=strtod(raw,&end);
    if(!isfinite(n) || end==raw || *end!=0) return false;
    *out=n; return true;
}
static void balance_decode(ac_balance_t *dest,id value)
{
    NSDictionary *b=obj(value); dest->health=health(b[@"health"]);
    copy_text(dest->note,sizeof(dest->note),b[@"note"]);
    NSDictionary *wallet=nil;
    for(id candidate in arr(b[@"wallets"])) {
        NSDictionary *w=obj(candidate);
        if([w[@"currency"] isEqual:@"CNY"] || (!wallet && [w[@"currency"] isEqual:@"USD"])) wallet=w;
    }
    if(!wallet || !balance_decimal(wallet[@"total"],&dest->total) || !balance_decimal(wallet[@"granted"],&dest->granted) || !balance_decimal(wallet[@"topped_up"],&dest->topped_up)) return;
    NSDate *date=date_from(b[@"observed_at"]); if(!date || date.timeIntervalSinceNow>120) return;
    dest->available=true;
    if(date.timeIntervalSinceNow < -300) dest->health=AC_OBSERVATION_STALE;
    copy_text(dest->currency,sizeof(dest->currency),wallet[@"currency"]);
    copy_text(dest->observed_at,sizeof(dest->observed_at),b[@"observed_at"]);
    NSDictionary *budget=obj(b[@"budget"]);
    if([budget[@"currency"] isEqual:wallet[@"currency"]] && numeric(budget[@"amount"])>0) dest->budget=[budget[@"amount"] doubleValue];
}
static bool statistics_decode(ac_usage_stats_t *dest,id value)
{
    NSDictionary *s=obj(value); NSArray *agents=arr(s[@"agents"]), *days=arr(s[@"days"]);
    int status=index_of(s[@"status"],@[@"loading",@"ready",@"partial",@"failed"],-1);
    if(status<0 || agents.count!=AC_AGENT_COUNT || days.count!=AC_USAGE_DAYS) return false;
    dest->loading=status==0; dest->partial=status==2; dest->failed=status==3;
    copy_text(dest->timezone,sizeof(dest->timezone),s[@"timezone"]);
    copy_text(dest->observed_at,sizeof(dest->observed_at),s[@"generated_at"]);
    NSArray *ids=@[@"codex",@"claude",@"deepseek"]; unsigned seen=0;
    for(id v in agents) {
        NSDictionary *a=obj(v); int i=index_of(a[@"id"],ids,-1);
        if(i<0 || (seen & (1u<<i)) || ![a[@"available"] isKindOfClass:NSNumber.class] || ![a[@"partial"] isKindOfClass:NSNumber.class]) return false;
        seen |= 1u<<i; dest->available[i]=[a[@"available"] boolValue]; dest->agent_partial[i]=[a[@"partial"] boolValue];
    }
    NSString *previous=@"";
    for(id v in days) {
        NSDictionary *d=obj(v); NSString *date=str(d[@"date"]);
        if(date.length!=10 || [date compare:previous]!=NSOrderedDescending || !date_from([date stringByAppendingString:@"T00:00:00Z"])) return false;
        ac_usage_day_t *day=&dest->days[dest->day_count++]; copy_text(day->date,sizeof(day->date),date); previous=date;
        NSDictionary *counts=obj(d[@"tokens"]);
        for(int i=0;i<AC_AGENT_COUNT;++i) {
            id value=counts[ids[i]];
            if(value==NSNull.null) continue;
            double n=numeric(value);
            if(n<0 || n>9007199254740991.0 || floor(n)!=n) return false;
            day->tokens[i]=(ac_metric_t){.available=dest->available[i],.value=n,.estimated=dest->agent_partial[i]};
        }
    }
    return true;
}
static void session_decode(ac_session_t *dest, NSDictionary *s)
{
    memset(dest, 0, sizeof(*dest));
    copy_text(dest->id, sizeof(dest->id), s[@"id"]); copy_text(dest->title, sizeof(dest->title), s[@"title"]);
    copy_text(dest->project, sizeof(dest->project), s[@"project_name"]); copy_text(dest->model, sizeof(dest->model), s[@"model"]);
    copy_text(dest->status_source, sizeof(dest->status_source), s[@"status_source"]);
    copy_text(dest->observed_at, sizeof(dest->observed_at), s[@"status_observed_at"]);
    copy_text(dest->last_activity_at, sizeof(dest->last_activity_at), s[@"last_activity_at"]);
    copy_text(dest->completion_id, sizeof(dest->completion_id), s[@"completion_event_id"]);
    NSDate *observed=date_from(s[@"completion_event_at"]);
    dest->completion_recent=observed && observed.timeIntervalSinceNow>=-15 && observed.timeIntervalSinceNow<=2;
    dest->state=state(s[@"state"]); dest->quality=quality(s[@"status_quality"]); dest->health=health(s[@"observation_health"]);
    dest->duration_seconds = numeric(s[@"run_duration_seconds"]);
    NSDictionary *u=obj(s[@"usage"]);
    dest->input=metric(u[@"input_tokens"]); dest->output=metric(u[@"output_tokens"]);
    dest->cache_ratio=metric(u[@"cache_ratio"]); dest->context_ratio=metric(u[@"context_ratio"]);
    if(dest->cache_ratio.value>1) dest->cache_ratio.available=false;
    if(dest->context_ratio.value>1) dest->context_ratio.available=false;
}
static bool snapshot_decode(ac_snapshot_t *dest, NSDictionary *s, bool allow_mock)
{
    if(![s[@"schema_version"] isEqual:@1]) return false;
    bool mock=[s[@"data_source"] isEqual:@"mock"];
    if(!mock && ![s[@"data_source"] isEqual:@"live"]) return false;
    if(mock!=allow_mock || arr(s[@"agents"]).count!=AC_AGENT_COUNT) return false;
    double seq=numeric(s[@"seq"]);
    if(seq<1 || seq>9007199254740991.0 || floor(seq)!=seq || ![s[@"sessions"] isKindOfClass:NSArray.class] || arr(s[@"sessions"]).count>15) return false;
    memset(dest, 0, sizeof(*dest)); dest->mock=mock;
    dest->seq=(uint64_t)seq; copy_text(dest->generated_at, sizeof(dest->generated_at), s[@"generated_at"]);
    NSDate *date=date_from(s[@"generated_at"]);
    if(!date || fabs(date.timeIntervalSinceNow)>10) return false;
    if(!statistics_decode(&dest->token_statistics,s[@"token_statistics"])) return false;
    NSArray *ids=@[@"codex", @"claude", @"deepseek"]; unsigned seen=0;
    for(id value in arr(s[@"agents"])) {
        NSDictionary *a=obj(value); int index=index_of(a[@"id"], ids, -1);
        if(index<0 || (seen & (1u<<index))) return false; seen|=1u<<index;
        if(numeric(a[@"session_count"])<0 || numeric(a[@"session_count"])>1000000 || numeric(a[@"running_count"])<0 || numeric(a[@"running_count"])>1000000 || numeric(a[@"waiting_count"])<0 || numeric(a[@"waiting_count"])>1000000) return false;
        ac_agent_t *agent=&dest->agents[index];
        agent->state=state(a[@"state"]); agent->quality=quality(a[@"status_quality"]); agent->health=health(a[@"observation_health"]);
        agent->total=[a[@"session_count"] unsignedIntValue]; agent->running=[a[@"running_count"] unsignedIntValue]; agent->waiting=[a[@"waiting_count"] unsignedIntValue];
        copy_text(agent->note, sizeof(agent->note), a[@"note"]);
        balance_decode(&agent->balance,a[@"balance"]);
        // Show the tightest valid window; neither array order nor primary/secondary implies duration.
        for(id value in arr(a[@"quota"])) {
            NSDictionary *q=obj(value); ac_metric_t used=metric(q[@"used_ratio"]);
            double minutes=numeric(q[@"window_minutes"]);
            if(!used.available || used.value>1 || minutes<=0 || minutes>1000000 || floor(minutes)!=minutes) continue;
            if(!agent->quota.available || used.value>agent->quota.value || (used.value==agent->quota.value && minutes<agent->quota_minutes)) {
                agent->quota=used; agent->quota_minutes=(unsigned)minutes;
            }
        }
    }
    for(id value in arr(s[@"sessions"])) {
        NSDictionary *srow=obj(value); int index=index_of(srow[@"agent_id"], ids, -1);
        if(index<0 || !str(srow[@"id"]).length || !str(srow[@"title"]).length) return false;
        if(index<0 || dest->agents[index].session_count>=AC_SESSION_LIMIT) continue;
        ac_agent_t *agent=&dest->agents[index]; session_decode(&agent->sessions[agent->session_count++], srow);
    }
    NSDictionary *scheduled=obj(s[@"scheduled_tasks"]);double epoch=numeric(scheduled[@"as_of_epoch"]);if(epoch>=1700000000&&epoch<=4102444800)dest->schedules.as_of_epoch=epoch;
    for(id value in arr(scheduled[@"sources"])) {NSDictionary *entry=obj(value);int i=index_of(entry[@"agent_id"],ids,-1);if(i>=0){dest->schedules.agents[i].available=[entry[@"quality"] isEqual:@"confirmed"];dest->schedules.agents[i].fresh=[scheduled[@"status"] isEqual:@"ready"];}}
    for(id value in arr(scheduled[@"tasks"])) {NSDictionary *entry=obj(value);if(![entry[@"status"] isEqual:@"active"])continue;int i=index_of(entry[@"agent_id"],ids,-1);if(i<0||dest->schedules.agents[i].count>=AC_SCHEDULE_LIMIT)continue;ac_schedule_t *t=&dest->schedules.agents[i].tasks[dest->schedules.agents[i].count++];copy_text(t->title,sizeof(t->title),entry[@"title"]);copy_text(t->session_id,sizeof(t->session_id),entry[@"session_id"]);copy_text(t->thread_title,sizeof(t->thread_title),entry[@"thread_title"]);t->status=[entry[@"status"] isEqual:@"active"]?1:[entry[@"status"] isEqual:@"paused"]?2:0;t->activity=[entry[@"conversation_state"] isEqual:@"running"]?AC_SCHEDULE_RUNNING:[entry[@"conversation_state"] isEqual:@"waiting_user"]?AC_SCHEDULE_WAITING:[entry[@"conversation_state"] isEqual:@"error"]?AC_SCHEDULE_ERROR:[entry[@"conversation_state"] isEqual:@"unknown"]?AC_SCHEDULE_UNCONFIRMED:AC_SCHEDULE_PLANNED;t->heartbeat=[entry[@"kind"] isEqual:@"heartbeat"];t->next_epoch=[date_from(entry[@"next_run_at"]) timeIntervalSince1970];t->last_epoch=[date_from(entry[@"last_run_at"]) timeIntervalSince1970];}
    return true;
}
bool ac_gateway_decode(const void *bytes,size_t length,ac_snapshot_t *snapshot,bool allow_mock)
{
    @autoreleasepool {
        if(!bytes || length>2*1024*1024) return false;
        id value=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:length] options:0 error:NULL];
        return snapshot_decode(snapshot,obj(value),allow_mock);
    }
}
static bool assistant_decode(ac_assistant_feed_t *dest,NSDictionary *data,bool allow_mock)
{
    if(![data[@"schema_version"] isEqual:@1] || ![data[@"messages"] isKindOfClass:NSArray.class])return false;
    bool mock=[data[@"data_source"] isEqual:@"mock"];
    if((!mock && ![data[@"data_source"] isEqual:@"live"]) || mock!=allow_mock)return false;
    int status=index_of(data[@"status"],@[@"unconfigured",@"ready",@"updating",@"failed",@"offline"],-1);
    double revision=numeric(data[@"revision"]);NSArray *messages=arr(data[@"messages"]);
    if(status<0 || revision<0 || floor(revision)!=revision || revision>9007199254740991.0 || messages.count>8)return false;
    memset(dest,0,sizeof(*dest));dest->mock=mock;dest->status=(unsigned)status;dest->revision=(uint64_t)revision;
    NSDateFormatter *format=[NSDateFormatter new];format.dateFormat=@"HH:mm";
    for(id value in messages) {
        NSDictionary *message=obj(value);NSString *identifier=str(message[@"id"]),*content=str(message[@"text"]);
        int role=index_of(message[@"role"],@[@"user",@"assistant"],-1),kind=index_of(message[@"kind"],@[@"briefing",@"chat"],-1);NSDate *at=date_from(message[@"created_at"]);
        if(!identifier.length || [identifier lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>=96 || !content.length || role<0 || kind<0 || !at)return false;
        ac_assistant_message_t *m=&dest->messages[dest->message_count++];copy_text(m->id,sizeof(m->id),identifier);copy_text(m->text,sizeof(m->text),content);
        if([content lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>=sizeof(m->text)) {copy_text(m->text,sizeof(m->text)-64,content);strlcat(m->text,"\n…（长消息已截短）",sizeof(m->text));}
        copy_text(m->time,sizeof(m->time),[format stringFromDate:at]);
        copy_text(m->source,sizeof(m->source),role==0?@"你":kind==0?@"AI 助手 · 项目简报":@"AI 助手 · 对话回复");
    }
    return true;
}
bool ac_gateway_decode_assistant(const void *bytes,size_t length,ac_assistant_feed_t *feed,bool allow_mock)
{
    @autoreleasepool {if(!bytes||length>512*1024)return false;return assistant_decode(feed,obj([NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:length] options:0 error:NULL]),allow_mock);}
}
static NSDictionary *request_method(NSURLSession *network, NSString *path, NSString *token, NSDictionary *patch,NSString *method)
{
    NSURL *url=[NSURL URLWithString:[NSString stringWithFormat:@"%s%@", gateway_url, path]];
    NSMutableURLRequest *request=[NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:2.5];
    if(token.length) [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
    if(patch) {request.HTTPMethod=method;[request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];request.HTTPBody=[NSJSONSerialization dataWithJSONObject:patch options:0 error:NULL];}
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSData *bytes; __block NSInteger status=0;
    NSURLSessionDataTask *task=[network dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if(!error && data.length<=2*1024*1024) { bytes=data; status=[(NSHTTPURLResponse *)response statusCode]; }
        dispatch_semaphore_signal(done);
    }];
    [task resume];
    if(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3*NSEC_PER_SEC))!=0) { [task cancel]; return nil; }
    if((status!=200 && status!=202) || !bytes) return nil;
    return obj([NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL]);
}
static NSDictionary *request_json(NSURLSession *network,NSString *path,NSString *token,NSDictionary *patch) {return request_method(network,path,token,patch,@"PATCH");}
static NSDictionary *fetch_json(NSURLSession *network, NSString *path, NSString *token) {return request_json(network,path,token,nil);}
static void *run(void *unused)
{
    (void)unused;
    @autoreleasepool {
        NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.HTTPShouldSetCookies=NO; config.URLCredentialStorage=nil; config.HTTPCookieStorage=nil; config.connectionProxyDictionary=@{};
        config.URLCache=nil;
        NSURLSession *network=[NSURLSession sessionWithConfiguration:config];
        while(true) {
            pthread_mutex_lock(&lock); bool stop=stopping;
            char requested[AC_ID_CAPACITY], theme[16];bool refresh_assistant=pending_assistant_refresh;pending_assistant_refresh=false;
            memcpy(requested, detail_id, sizeof(requested));memcpy(theme,pending_theme,sizeof(theme)); pthread_mutex_unlock(&lock);
            if(stop) break;
            @autoreleasepool {
                NSString *token=allow_mock_data?@"":[NSString stringWithContentsOfFile:[NSString stringWithUTF8String:token_file] encoding:NSUTF8StringEncoding error:NULL] ?: @"";
                if(refresh_assistant && !allow_mock_data)request_method(network,@"/api/v1/assistant/refresh",token,@{},@"POST");
                if(theme[0] && request_json(network,@"/api/v1/settings",token,@{@"appearance":@{@"theme":[NSString stringWithUTF8String:theme]}})) {
                    pthread_mutex_lock(&lock);if(strcmp(theme,pending_theme)==0) pending_theme[0]=0;pthread_mutex_unlock(&lock);
                }
                NSDictionary *data=fetch_json(network, @"/api/v1/state", token);
                ac_gateway_result_t *result=calloc(1, sizeof(*result));
                result->online=data && snapshot_decode(&result->snapshot, data, allow_mock_data);
                if(!allow_mock_data) {
                    NSDictionary *feed=result->online?fetch_json(network,@"/api/v1/assistant",token):nil;
                    if(feed && assistant_decode(&result->assistant,feed,false)){result->has_assistant=true;previous_assistant=result->assistant;have_assistant=true;}
                    else if(have_assistant){result->has_assistant=true;result->assistant=previous_assistant;result->assistant.status=4;}
                }
                if(result->online) {
                    NSDictionary *settings=fetch_json(network,@"/api/v1/settings",token), *appearance=obj(settings[@"appearance"]);
                    NSString *theme_name=str(appearance[@"theme"]);id motion=appearance[@"animations_enabled"];
                    double revision=numeric(settings[@"revision"]);
                    if([@[@"neon",@"comic",@"neumorphism"] containsObject:theme_name] && [motion isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)motion)==CFBooleanGetTypeID() && revision>=0 && floor(revision)==revision && revision<=9007199254740991.0) {
                        result->has_settings=true;result->settings_revision=(uint64_t)revision;result->animations_enabled=[motion boolValue];copy_text(result->theme,sizeof(result->theme),theme_name);
                    }
                }
                if(result->online && requested[0]) {
                    NSString *encoded=[[NSString stringWithUTF8String:requested] stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet];
                    NSDictionary *detail=fetch_json(network, [@"/api/v1/sessions/" stringByAppendingString:encoded], token);
                    if(detail && [str(detail[@"id"]) isEqualToString:[NSString stringWithUTF8String:requested]]) {
                        result->has_detail=true; session_decode(&result->detail.session, detail); result->detail.truncated=[detail[@"transcript_truncated"] boolValue];
                        for(id value in arr(detail[@"messages"])) {
                            if(result->detail.message_count>=AC_MESSAGE_LIMIT) break;
                            NSDictionary *message=obj(value);
                            if(![message[@"role"] isEqual:@"user"] && ![message[@"role"] isEqual:@"assistant"]) continue;
                            ac_message_t *m=&result->detail.messages[result->detail.message_count++]; m->assistant=[message[@"role"] isEqual:@"assistant"];
                            copy_text(m->id, sizeof(m->id), message[@"id"]); copy_text(m->text, sizeof(m->text), message[@"text"]);
                            if([str(message[@"text"]) lengthOfBytesUsingEncoding:NSUTF8StringEncoding]>=sizeof(m->text)) result->detail.truncated=true;
                        }
                    }
                }
                pthread_mutex_lock(&lock); latest=*result; dirty=true; pthread_mutex_unlock(&lock); free(result);
            }
            pthread_mutex_lock(&lock);
            if(!stopping) { struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec+=1; pthread_cond_timedwait(&wake, &lock, &until); }
            pthread_mutex_unlock(&lock);
        }
        [network invalidateAndCancel];
    }
    return NULL;
}
bool ac_gateway_client_start(const char *url, const char *token_path, bool allow_mock)
{
    if(started || strlen(url)>=sizeof(gateway_url) || strlen(token_path)>=sizeof(token_file)) return false;
    @autoreleasepool {
        NSURL *address=[NSURL URLWithString:[NSString stringWithUTF8String:url]];
        if(![address.scheme isEqual:@"http"] || ![address.host isEqual:@"127.0.0.1"] || address.port.integerValue<1 || address.port.integerValue>65535 || address.user || address.password || address.query || address.fragment || (address.path.length && ![address.path isEqual:@"/"])) return false;
    }
    strcpy(gateway_url, url); strcpy(token_file, token_path); allow_mock_data=allow_mock;
    if(gateway_url[strlen(gateway_url)-1]=='/') gateway_url[strlen(gateway_url)-1]=0;
    stopping=false; started=pthread_create(&worker, NULL, run, NULL)==0; return started;
}
bool ac_gateway_client_take(ac_gateway_result_t *result)
{
    pthread_mutex_lock(&lock); bool available=dirty; if(available) { *result=latest; dirty=false; }
    pthread_mutex_unlock(&lock); return available;
}
void ac_gateway_client_request_detail(const char *id)
{
    pthread_mutex_lock(&lock); if(strlen(id)<sizeof(detail_id)) strcpy(detail_id, id);
    pthread_cond_signal(&wake); pthread_mutex_unlock(&lock);
}
void ac_gateway_client_request_theme(const char *theme)
{
    if(strcmp(theme,"neon") && strcmp(theme,"comic") && strcmp(theme,"neumorphism")) return;
    pthread_mutex_lock(&lock);strcpy(pending_theme,theme);pthread_cond_signal(&wake);pthread_mutex_unlock(&lock);
}
void ac_gateway_client_stop(void)
{
    if(!started) return;
    pthread_mutex_lock(&lock); stopping=true; pthread_cond_signal(&wake); pthread_mutex_unlock(&lock);
    pthread_join(worker, NULL); started=false;
}
void ac_gateway_client_request_assistant_refresh(void)
{
    pthread_mutex_lock(&lock);pending_assistant_refresh=true;pthread_cond_signal(&wake);pthread_mutex_unlock(&lock);
}
