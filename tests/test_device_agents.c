#include "ac_device_decode.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
int main(int argc,char **argv){
    assert(argc==2);FILE *file=fopen(argv[1],"rb");assert(file);fseek(file,0,SEEK_END);long size=ftell(file);rewind(file);char *bytes=calloc((size_t)size+1,1);assert(bytes&&fread(bytes,1,(size_t)size,file)==(size_t)size);fclose(file);
    cJSON *fixture=cJSON_Parse(bytes);free(bytes);assert(fixture);
    time_t now=time(NULL);struct tm tm;gmtime_r(&now,&tm);char at[32];strftime(at,sizeof(at),"%Y-%m-%dT%H:%M:%SZ",&tm);
    cJSON_ReplaceItemInObject(fixture,"data_source",cJSON_CreateString("live"));cJSON_ReplaceItemInObject(fixture,"generated_at",cJSON_CreateString(at));
    cJSON *agent=cJSON_Duplicate(cJSON_GetArrayItem(cJSON_GetObjectItem(fixture,"agents"),0),true),*statistics=cJSON_GetObjectItem(fixture,"token_statistics"),*source=cJSON_Duplicate(cJSON_GetArrayItem(cJSON_GetObjectItem(statistics,"agents"),0),true);
    cJSON_ReplaceItemInObject(fixture,"sessions",cJSON_CreateArray());ac_snapshot_t *snapshot=calloc(1,sizeof(*snapshot));assert(snapshot);
    const char *ids[]={"grok","codex","claude"};const ac_agent_id_t order[]={AC_AGENT_GROK,AC_AGENT_CODEX,AC_AGENT_CLAUDE};
    for(int count=1;count<=3;++count){
        cJSON *agents=cJSON_CreateArray(),*sources=cJSON_CreateArray();
        for(int i=0;i<count;++i){cJSON *a=cJSON_Duplicate(agent,true),*s=cJSON_Duplicate(source,true);cJSON_ReplaceItemInObject(a,"id",cJSON_CreateString(ids[i]));cJSON_ReplaceItemInObject(s,"id",cJSON_CreateString(ids[i]));cJSON_AddItemToArray(agents,a);cJSON_AddItemToArray(sources,s);}
        cJSON_ReplaceItemInObject(fixture,"agents",agents);cJSON_ReplaceItemInObject(statistics,"agents",sources);
        assert(ac_device_snapshot(fixture,snapshot));assert(snapshot->agent_count==(size_t)count);for(int i=0;i<count;++i)assert(snapshot->agent_order[i]==order[i]);
    }
    cJSON_ReplaceItemInObject(fixture,"agents",cJSON_CreateArray());assert(!ac_device_snapshot(fixture,snapshot));
    cJSON *duplicates=cJSON_CreateArray();cJSON_AddItemToArray(duplicates,cJSON_Duplicate(agent,true));cJSON_AddItemToArray(duplicates,cJSON_Duplicate(agent,true));cJSON_ReplaceItemInObject(fixture,"agents",duplicates);assert(!ac_device_snapshot(fixture,snapshot));
    cJSON_AddItemToArray(duplicates,cJSON_Duplicate(agent,true));cJSON_AddItemToArray(duplicates,cJSON_Duplicate(agent,true));assert(!ac_device_snapshot(fixture,snapshot));
    cJSON_Delete(agent);cJSON_Delete(source);cJSON_Delete(fixture);free(snapshot);puts("PASS: device decoder accepts 1-3 distinct agents including Grok, rejects empty/duplicate/4 selections");
}
