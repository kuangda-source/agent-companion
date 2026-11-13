#include "ac_audio.h"
#include "ac_device_decode.h"
#include "ac_network.h"
#include "bsp/esp-bsp.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha256.h"
#include "nvs.h"
#include "nvs_flash.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#define MAX_PCM 960000
#define IDS 16
typedef struct {char id[81],sha[65];uint8_t *pcm;size_t bytes,offset;unsigned seq,volume;double expires;bool remote,diagnostic;} audio_job_t;
static audio_job_t *receiving;
static atomic_bool busy,cancelled,muted;
static atomic_uint volume=80;
static esp_codec_dev_handle_t speaker;
static char ledger[IDS][81],active_id[81];static unsigned ledger_next;
static const cJSON *get(const cJSON *o,const char *key){return cJSON_GetObjectItemCaseSensitive(o,key);}
static bool number(const cJSON *o,double min,double max){return cJSON_IsNumber(o)&&isfinite(o->valuedouble)&&o->valuedouble>=min&&o->valuedouble<=max&&floor(o->valuedouble)==o->valuedouble;}
static bool ascii_id(const cJSON *v){if(!cJSON_IsString(v)||!v->valuestring[0]||strlen(v->valuestring)>80)return false;for(const char *p=v->valuestring;*p;p++)if(!((*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||*p=='-'||*p=='_'))return false;return true;}
static bool hex(const cJSON *v){if(!cJSON_IsString(v)||strlen(v->valuestring)!=64)return false;for(unsigned i=0;i<64;i++)if(!((v->valuestring[i]>='a'&&v->valuestring[i]<='f')||(v->valuestring[i]>='0'&&v->valuestring[i]<='9')))return false;return true;}
static uint32_t crc(const uint8_t *data,size_t n){uint32_t c=~0u;for(size_t i=0;i<n;i++){c^=data[i];for(unsigned b=0;b<8;b++)c=(c>>1)^(0xedb88320u&-(c&1));}return ~c;}
static void reply(const char *id,const char *state,size_t offset,bool remote){char line[256];snprintf(line,sizeof(line),"{\"kind\":\"audio_reply\",\"delivery_id\":\"%s\",\"state\":\"%s\",\"next_offset\":%u}",id,state,(unsigned)offset);printf("\nAC_AUDIO_REPLY %s\n",line);fflush(stdout);if(remote)ac_network_send(line);}
static void diagnostic(const audio_job_t *job,const char *state,const char *reason,size_t bytes){printf("\nAC_AUDIO {\"id\":\"%s\",\"state\":\"%s\",\"reason\":\"%s\",\"bytes\":%u}\n",job->id,state,reason,(unsigned)bytes);fflush(stdout);}
void ac_audio_capability(void){printf("\nAC_AUDIO_CAP {\"audio_protocol\":1,\"volume\":%u,\"muted\":%s,\"max_bytes\":960000}\n",atomic_load(&volume),atomic_load(&muted)?"true":"false");fflush(stdout);}
void ac_audio_init(void){
 if(nvs_flash_init()==ESP_OK){nvs_handle_t h;if(nvs_open("ac_voice",NVS_READONLY,&h)==ESP_OK){uint8_t v=80,m=0;nvs_get_u8(h,"volume",&v);nvs_get_u8(h,"muted",&m);if(v<=100)atomic_store(&volume,v);atomic_store(&muted,m==1);size_t n=sizeof(ledger);if(nvs_get_blob(h,"started",ledger,&n)!=ESP_OK||n!=sizeof(ledger))memset(ledger,0,sizeof(ledger));for(unsigned i=0;i<IDS;i++)ledger[i][80]=0;uint32_t next=0;nvs_get_u32(h,"cursor",&next);ledger_next=next%IDS;nvs_close(h);}}
}
unsigned ac_audio_volume(void){return atomic_load(&volume);}
bool ac_audio_muted(void){return atomic_load(&muted);}
static void release_rx(void){if(receiving){free(receiving->pcm);free(receiving);receiving=NULL;}}
void ac_audio_stop(void){atomic_store(&cancelled,true);}
void ac_audio_settings(unsigned value,bool mute){
 if(value>100)return;atomic_store(&volume,value);atomic_store(&muted,mute);if(mute)ac_audio_stop();
 nvs_handle_t h;if(nvs_open("ac_voice",NVS_READWRITE,&h)==ESP_OK){nvs_set_u8(h,"volume",value);nvs_set_u8(h,"muted",mute);nvs_commit(h);nvs_close(h);}ac_audio_capability();
}
void ac_audio_tick(void){if(receiving&&(atomic_load(&cancelled)||(double)time(NULL)*1000>=receiving->expires))release_rx();}
static bool remember(const char *id){
 nvs_handle_t h;if(nvs_open("ac_voice",NVS_READWRITE,&h)!=ESP_OK)return false;
 char previous[81];memcpy(previous,ledger[ledger_next],81);snprintf(ledger[ledger_next],81,"%s",id);unsigned next=(ledger_next+1)%IDS;
 bool ok=nvs_set_blob(h,"started",ledger,sizeof(ledger))==ESP_OK&&nvs_set_u32(h,"cursor",next)==ESP_OK&&nvs_commit(h)==ESP_OK;nvs_close(h);
 if(ok)ledger_next=next;else memcpy(ledger[ledger_next],previous,81);return ok;
}
static void play(void *arg){
 audio_job_t *job=arg;const char *error=NULL;size_t written=0;bool opened=false;unsigned last_volume=UINT32_MAX;
 if(atomic_load(&cancelled)||atomic_load(&muted)){error="cancelled";goto done;}
 if(!job->diagnostic&&!remember(job->id)){error="ledger";goto done;}
 if(!speaker)speaker=bsp_audio_codec_speaker_init();if(!speaker){error="codec_init";goto done;}
 esp_codec_dev_sample_info_t format={.sample_rate=16000,.channel=1,.bits_per_sample=16};
 if(esp_codec_dev_open(speaker,&format)!=ESP_CODEC_DEV_OK){error="codec_open";goto done;}opened=true;
 if(job->diagnostic)diagnostic(job,"playing","",0);else reply(job->id,"playing",0,job->remote);
 while(written<job->bytes){
  if(atomic_load(&cancelled)||atomic_load(&muted)||(!job->diagnostic&&(double)time(NULL)*1000>=job->expires)){error="cancelled";goto done;}
  unsigned v=job->diagnostic?job->volume:atomic_load(&volume);if(v!=last_volume){if(esp_codec_dev_set_out_vol(speaker,v)!=ESP_CODEC_DEV_OK){error="codec_volume";goto done;}last_volume=v;}
  size_t size=job->bytes-written;if(size>1024)size=1024;if(esp_codec_dev_write(speaker,job->pcm+written,size)!=ESP_CODEC_DEV_OK){error="codec_write";goto done;}written+=size;
 }
 int16_t silence[512]={0};for(unsigned i=0;i<7;i++)if(esp_codec_dev_write(speaker,silence,sizeof(silence))!=ESP_CODEC_DEV_OK){error="codec_drain";goto done;}vTaskDelay(pdMS_TO_TICKS(200));
done:
 if(opened&&esp_codec_dev_close(speaker)!=ESP_CODEC_DEV_OK&&!error)error="codec_close";
 if(job->diagnostic)diagnostic(job,error?"error":"played",error?error:"",written);else reply(job->id,error?"rejected":"played",written,job->remote);
 free(job->pcm);free(job);atomic_store(&busy,false);vTaskDelete(NULL);
}
static void launch(audio_job_t *job){
 bool expected=false;if(!atomic_compare_exchange_strong(&busy,&expected,true)){if(!job->diagnostic)reply(job->id,"rejected",0,job->remote);free(job->pcm);free(job);return;}
 atomic_store(&cancelled,false);strcpy(active_id,job->id);
 if(xTaskCreate(play,"ac_speaker",6144,job,4,NULL)!=pdPASS){if(!job->diagnostic)reply(job->id,"rejected",0,job->remote);free(job->pcm);free(job);atomic_store(&busy,false);}
}
void ac_audio_submit(const cJSON *packet){
 ac_audio_command_t command;if(!ac_device_audio_command(packet,&command))return;
 audio_job_t *job=heap_caps_calloc(1,sizeof(*job),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);if(!job)return;
 job->pcm=heap_caps_malloc(command.bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);size_t decoded=0;
 if(!job->pcm||mbedtls_base64_decode(job->pcm,command.bytes,&decoded,(const unsigned char*)command.base64,strlen(command.base64))||decoded!=command.bytes){free(job->pcm);free(job);return;}
 strcpy(job->id,command.id);job->bytes=command.bytes;job->volume=command.volume;job->diagnostic=true;launch(job);
}
void ac_audio_packet(const cJSON *o,bool remote){
 const cJSON *id=get(o,"delivery_id"),*kind=get(o,"kind");if(!ascii_id(id)||!cJSON_IsString(kind))return;
 const char *delivery=id->valuestring,*k=kind->valuestring;
 if(!strcmp(k,"audio_cancel")){if(receiving&&!strcmp(receiving->id,delivery))release_rx();if(atomic_load(&busy)&&!strcmp(active_id,delivery))atomic_store(&cancelled,true);reply(delivery,"rejected",0,remote);return;}
 ac_audio_tick();
 if(!strcmp(k,"audio_start")){
  if(atomic_load(&busy)){reply(delivery,"rejected",0,remote);return;}for(unsigned i=0;i<IDS;i++)if(!strcmp(ledger[i],delivery)){reply(delivery,"rejected",0,remote);return;}
  const cJSON *a=get(o,"audio"),*bytes=get(a,"bytes"),*sha=get(a,"sha256"),*codec=get(a,"codec"),*expires=get(o,"expires_at");
  if(atomic_load(&busy)||receiving||atomic_load(&muted)||!number(get(o,"version"),1,1)||!number(bytes,2,MAX_PCM)||((unsigned)bytes->valuedouble%2)||!hex(sha)||!cJSON_IsString(codec)||strcmp(codec->valuestring,"pcm_s16le")||!number(get(a,"sample_rate"),16000,16000)||!number(get(a,"channels"),1,1)||!number(expires,(double)time(NULL)*1000+1,(double)time(NULL)*1000+900000)){reply(delivery,"rejected",0,remote);return;}
  receiving=heap_caps_calloc(1,sizeof(*receiving),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);if(!receiving){reply(delivery,"rejected",0,remote);return;}
  receiving->pcm=heap_caps_malloc((size_t)bytes->valuedouble,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);if(!receiving->pcm){release_rx();reply(delivery,"rejected",0,remote);return;}
  atomic_store(&cancelled,false);strcpy(receiving->id,delivery);strcpy(receiving->sha,sha->valuestring);receiving->bytes=(size_t)bytes->valuedouble;receiving->remote=remote;receiving->expires=expires->valuedouble;reply(delivery,"accepted",0,remote);return;
 }
 if(!receiving||strcmp(receiving->id,delivery)||receiving->remote!=remote){reply(delivery,"rejected",0,remote);return;}
 if((double)time(NULL)*1000>=receiving->expires){release_rx();reply(delivery,"rejected",0,remote);return;}
 if(!strcmp(k,"audio_chunk")){
  const cJSON *data=get(o,"data");size_t n=0;size_t capacity=receiving->bytes-receiving->offset;if(capacity>16384)capacity=16384;uint8_t *block=receiving->pcm+receiving->offset;
  if(!number(get(o,"seq"),receiving->seq,receiving->seq)||!number(get(o,"offset"),receiving->offset,receiving->offset)||!number(get(o,"crc32"),0,4294967295.0)||!cJSON_IsString(data)||strlen(data->valuestring)>21848||mbedtls_base64_decode(block,capacity,&n,(const unsigned char*)data->valuestring,strlen(data->valuestring))||!n||n%2||receiving->offset+n>receiving->bytes||crc(block,n)!=(uint32_t)get(o,"crc32")->valuedouble){release_rx();reply(delivery,"rejected",0,remote);return;}
  receiving->offset+=n;receiving->seq++;reply(delivery,"chunk",receiving->offset,remote);return;
 }
 if(!strcmp(k,"audio_end")){
  uint8_t hash[32];char actual[65];if(mbedtls_sha256(receiving->pcm,receiving->bytes,hash,0)){release_rx();reply(delivery,"rejected",0,remote);return;}for(unsigned i=0;i<32;i++)snprintf(actual+i*2,3,"%02x",hash[i]);
  if(receiving->offset!=receiving->bytes||strcmp(actual,receiving->sha)){release_rx();reply(delivery,"rejected",0,remote);return;}
  audio_job_t *job=receiving;receiving=NULL;launch(job);
 }
}
