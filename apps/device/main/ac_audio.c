#include "ac_audio.h"
#include "ac_device_decode.h"
#include "bsp/esp-bsp.h"
#include "esp_codec_dev.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {ac_audio_command_t command;uint8_t *pcm;} audio_job_t;
static atomic_bool busy;
static esp_codec_dev_handle_t speaker;
static void report(const char *id,const char *state,const char *reason,size_t bytes){
    /* IDs have an ASCII allowlist; no speech text, credentials or PCM is logged. */
    printf("\nAC_AUDIO {\"id\":\"%s\",\"state\":\"%s\",\"reason\":\"%s\",\"bytes\":%u}\n",id,state,reason,(unsigned)bytes);fflush(stdout);
}
static void play(void *arg){
    audio_job_t *job=arg;const char *error=NULL;size_t written=0;bool opened=false;
    if(!speaker)speaker=bsp_audio_codec_speaker_init();
    if(!speaker){error="codec_init";goto done;}
    esp_codec_dev_sample_info_t format={.sample_rate=16000,.channel=1,.bits_per_sample=16};
    if(esp_codec_dev_open(speaker,&format)!=ESP_CODEC_DEV_OK){error="codec_open";goto done;}opened=true;
    if(esp_codec_dev_set_out_vol(speaker,job->command.volume)!=ESP_CODEC_DEV_OK){error="codec_volume";goto done;}
    report(job->command.id,"playing","",0);
    while(written<job->command.bytes){
        size_t size=job->command.bytes-written;if(size>1024)size=1024;
        if(esp_codec_dev_write(speaker,job->pcm+written,size)!=ESP_CODEC_DEV_OK){error="codec_write";goto done;}written+=size;
    }
    /* Drain DMA with silence before disabling the amplifier, preserving the tail. */
    int16_t silence[512]={0};for(unsigned i=0;i<7;++i)if(esp_codec_dev_write(speaker,silence,sizeof(silence))!=ESP_CODEC_DEV_OK){error="codec_drain";goto done;}
    vTaskDelay(pdMS_TO_TICKS(200));
done:
    if(opened&&esp_codec_dev_close(speaker)!=ESP_CODEC_DEV_OK&&!error)error="codec_close";
    report(job->command.id,error?"error":"played",error?error:"",written);
    free(job->pcm);free(job);atomic_store(&busy,false);vTaskDelete(NULL);
}
void ac_audio_submit(const cJSON *packet){
    ac_audio_command_t command;if(!ac_device_audio_command(packet,&command)){report("invalid","error","invalid_pcm",0);return;}
    bool expected=false;if(!atomic_compare_exchange_strong(&busy,&expected,true)){report(command.id,"error","busy",0);return;}
    audio_job_t *job=heap_caps_calloc(1,sizeof(*job),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    uint8_t *pcm=heap_caps_malloc(command.bytes,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);size_t decoded=0;
    if(!job||!pcm){free(job);free(pcm);atomic_store(&busy,false);report(command.id,"error","memory",0);return;}
    if(mbedtls_base64_decode(pcm,command.bytes,&decoded,(const unsigned char*)command.base64,strlen(command.base64))||decoded!=command.bytes){free(job);free(pcm);atomic_store(&busy,false);report(command.id,"error","invalid_base64",0);return;}
    job->command=command;job->command.base64=NULL;job->pcm=pcm;
    if(xTaskCreate(play,"ac_speaker",6144,job,4,NULL)!=pdPASS){free(job);free(pcm);atomic_store(&busy,false);report(command.id,"error","worker",0);}
}
