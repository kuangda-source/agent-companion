#import <Foundation/Foundation.h>
#include "ac_gateway_client.h"
#include <assert.h>

static bool decode(NSDictionary *value,ac_snapshot_t *snapshot,bool mock)
{
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    return ac_gateway_decode(data.bytes,data.length,snapshot,mock);
}
int main(int argc,char **argv)
{
    @autoreleasepool {
        assert(argc==2);
        NSData *bytes=[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]];
        NSMutableDictionary *fixture=[NSJSONSerialization JSONObjectWithData:bytes options:NSJSONReadingMutableContainers error:NULL];
        NSISO8601DateFormatter *format=[NSISO8601DateFormatter new];
        format.formatOptions=NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
        fixture[@"generated_at"]=[format stringFromDate:NSDate.date];
        ac_snapshot_t snapshot;
        assert(decode(fixture,&snapshot,true));
        assert(snapshot.mock && snapshot.agents[0].session_count==5);assert(llabs(snapshot.generated_epoch-(int64_t)NSDate.date.timeIntervalSince1970)<=1);
        assert(snapshot.token_statistics.day_count==30 && ac_usage_total(&snapshot.token_statistics,-1,7).available);
        NSMutableDictionary *statistics=fixture[@"token_statistics"];
        NSMutableArray *days=statistics[@"days"];
        id previous=days[29][@"tokens"][@"codex"];
        days[29][@"tokens"][@"codex"]=@(-1); assert(!decode(fixture,&snapshot,true));
        days[29][@"tokens"][@"codex"]=previous;
        NSMutableDictionary *deepseek=fixture[@"agents"][2];
        deepseek[@"balance"]=@{@"health":@"fresh",@"observed_at":fixture[@"generated_at"],@"note":@"API balance",@"wallets":@[@{@"currency":@"CNY",@"total":@"25.13",@"granted":@"0.17",@"topped_up":@"24.96"}],@"budget":NSNull.null};
        assert(decode(fixture,&snapshot,true));
        assert(snapshot.agents[2].balance.available && snapshot.agents[2].balance.total==25.13 && snapshot.agents[2].balance.budget==0);
        NSMutableDictionary *codex=fixture[@"agents"][0];
        NSDictionary *short_window=@{@"window_minutes":@300,@"used_ratio":@{@"value":@0.1,@"quality":@"confirmed",@"source":@"test",@"observed_at":fixture[@"generated_at"]},@"resets_at":@"2027-01-15T08:01:30.000Z"};
        NSDictionary *week_window=@{@"window_minutes":@10080,@"used_ratio":@{@"value":@0.64,@"quality":@"confirmed",@"source":@"test",@"observed_at":fixture[@"generated_at"]},@"resets_at":@"2027-01-16T08:01:30.000Z"};
        codex[@"quota"]=@[short_window,week_window]; assert(decode(fixture,&snapshot,true));
        assert(snapshot.agents[0].quota_minutes==10080 && snapshot.agents[0].quota.value==0.64);assert(snapshot.agents[0].quota_reset_epoch==1800086490);
        codex[@"quota"]=@[week_window,short_window]; assert(decode(fixture,&snapshot,true));
        assert(snapshot.agents[0].quota_minutes==10080 && snapshot.agents[0].quota.value==0.64);assert(snapshot.agents[0].quota_reset_epoch==1800086490);
        NSMutableDictionary *unknown_reset=[week_window mutableCopy];unknown_reset[@"resets_at"]=NSNull.null;codex[@"quota"]=@[unknown_reset,short_window];assert(decode(fixture,&snapshot,true));assert(snapshot.agents[0].quota_reset_epoch==0);
        assert(ac_quota_view(snapshot.agents[0].quota,AC_OBSERVATION_FRESH).band==AC_QUOTA_YELLOW);
        codex[@"quota"]=@[[week_window mutableCopy]];((NSMutableDictionary *)codex[@"quota"][0])[@"health"]=@"stale";assert(decode(fixture,&snapshot,true));assert(snapshot.agents[0].quota_stale);
        codex[@"quota"]=@[week_window];assert(decode(fixture,&snapshot,true));assert(!snapshot.agents[0].quota_stale);

        assert(!decode(fixture,&snapshot,false)); // never mix synthetic records into LIVE
        fixture[@"schema_version"]=@2; assert(!decode(fixture,&snapshot,true)); fixture[@"schema_version"]=@1;
        fixture[@"seq"]=NSNull.null; assert(!decode(fixture,&snapshot,true));
        fixture[@"seq"]=@YES; assert(!decode(fixture,&snapshot,true)); fixture[@"seq"]=@1;
        NSMutableDictionary *claude=fixture[@"agents"][1];
        claude[@"id"]=@"codex"; assert(!decode(fixture,&snapshot,true)); claude[@"id"]=@"claude";
        claude[@"session_count"]=@[]; assert(!decode(fixture,&snapshot,true)); claude[@"session_count"]=@5;
        NSMutableDictionary *usage=fixture[@"sessions"][0][@"usage"];
        usage[@"input_tokens"]=[@{@"value":NSNull.null,@"quality":@"unavailable",@"source":@"test",@"observed_at":NSNull.null} mutableCopy];
        usage[@"context_ratio"]=[@{@"value":@1.2,@"quality":@"confirmed",@"source":@"test",@"observed_at":fixture[@"generated_at"]} mutableCopy];
        assert(decode(fixture,&snapshot,true));
        assert(!snapshot.agents[0].sessions[0].input.available && !snapshot.agents[0].sessions[0].context_ratio.available);
        fixture[@"generated_at"]=@"2001-01-01T00:00:00Z"; assert(!decode(fixture,&snapshot,true));
        assert(!ac_gateway_decode("{broken",7,&snapshot,true));
        /* One selected Grok is a distinct identity, not the old Claude slot. */
        fixture[@"generated_at"]=[format stringFromDate:NSDate.date];
        NSMutableDictionary *grok=[codex mutableCopy];grok[@"id"]=@"grok";
        fixture[@"agents"]=[NSMutableArray arrayWithObject:grok];fixture[@"sessions"]=[NSMutableArray array];
        NSMutableDictionary *botRecord=[@{@"id":@"bot-example",@"agent_id":@"grok",@"title":@"Example Bot",@"state":@"unknown",@"messages":@[@{@"role":@"assistant",@"text":@"Latest Bot update"}]} mutableCopy];
        [fixture[@"sessions"] addObject:botRecord];
        statistics[@"agents"]=[NSMutableArray arrayWithObject:[@{@"id":@"grok",@"available":@NO,@"partial":@NO,@"source":@"cache: unavailable"} mutableCopy]];
        for(NSMutableDictionary *day in days)day[@"tokens"][@"grok"]=NSNull.null;
        assert(decode(fixture,&snapshot,true));assert(snapshot.agent_count==1&&snapshot.agent_order[0]==AC_AGENT_GROK);
        assert(!strcmp(snapshot.agents[AC_AGENT_GROK].sessions[0].latest_message,"Latest Bot update"));assert(snapshot.agents[AC_AGENT_GROK].sessions[0].latest_message_assistant);
        assert(snapshot.agents[AC_AGENT_CLAUDE].state==AC_STATE_UNKNOWN);
        assert(!ac_usage_total(&snapshot.token_statistics,-1,7).available);
        fixture[@"agents"]=[NSMutableArray array];assert(!decode(fixture,&snapshot,true));
        fixture[@"agents"]=[NSMutableArray arrayWithObjects:grok,grok,nil];assert(!decode(fixture,&snapshot,true));
        fixture[@"agents"]=[NSMutableArray arrayWithObjects:grok,grok,grok,grok,nil];assert(!decode(fixture,&snapshot,true));
        NSMutableDictionary *assistant=[@{@"schema_version":@1,@"data_source":@"mock",@"revision":@1,@"status":@"ready",@"model":@"fixture",
            @"messages":@[@{@"id":@"message-1",@"role":@"assistant",@"kind":@"briefing",@"text":@"项目摘要",@"created_at":[format stringFromDate:NSDate.date],@"source_ids":@[]}]} mutableCopy];
        ac_assistant_feed_t feed;
        NSData *assistant_bytes=[NSJSONSerialization dataWithJSONObject:assistant options:0 error:NULL];
        assert(ac_gateway_decode_assistant(assistant_bytes.bytes,assistant_bytes.length,&feed,true));
        assert(feed.message_count==1 && feed.status==1);
        assert(!ac_gateway_decode_assistant(assistant_bytes.bytes,assistant_bytes.length,&feed,false));
        assistant[@"status"]=@"invented";assistant_bytes=[NSJSONSerialization dataWithJSONObject:assistant options:0 error:NULL];
        assert(!ac_gateway_decode_assistant(assistant_bytes.bytes,assistant_bytes.length,&feed,true));
        assert(!ac_gateway_client_start("http://127.0.0.1:8736@untrusted.invalid","",false));
        assert(!ac_gateway_client_start("http://127.0.0.1.evil.invalid:8736","",false));
        assert(!ac_gateway_client_start("https://127.0.0.1:8736","",false));
        puts("PASS: native protocol boundary, mock isolation, freshness, malformed types, null metrics");
    }
    return 0;
}
