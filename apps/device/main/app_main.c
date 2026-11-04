/* Shared V1 UI on 7B. USB carries framed app data; credentials stay on Mac. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <sys/time.h>
#include "esp_timer.h"
#include "esp_psram.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "driver/usb_serial_jtag.h"
#include "driver/ledc.h"
#include "bsp/esp-bsp.h"
#include "bsp/display.h"
#include "ac_bootstrap_screen.h"
#include "ac_assistant_panel.h"
#include "ac_device_decode.h"
#include "ac_theme.h"
#include "ac_network.h"
#include "freertos/queue.h"
#include <math.h>
#if !CONFIG_LV_USE_RLE || !CONFIG_LV_BIN_DECODER_RAM_LOAD || !CONFIG_LV_FONT_FMT_TXT_LARGE
#error "Complete V1 resources require RLE, RAM-load image decoder and large-font descriptors"
#endif

#define FRAME_LIMIT (192*1024)
static const char *TAG="ac_device";
static uint64_t last_received;
static bool connected,active_remote;
static uint64_t last_usb_received;
typedef struct {char *data;size_t length;bool remote;} input_packet_t;
static QueueHandle_t incoming;
static char last_boot[40];
static uint64_t last_wire;
static unsigned rendered,touches;
static ac_assistant_feed_t *last_feed;
static uint64_t millis(void){return esp_timer_get_time()/1000;}
static const cJSON *get(const cJSON *o,const char *k){return cJSON_GetObjectItemCaseSensitive(o,k);}
static void event(const char *kind,const char *key,const char *value){
    cJSON *o=cJSON_CreateObject();cJSON_AddStringToObject(o,"kind",kind);if(key)cJSON_AddStringToObject(o,key,value);char *s=cJSON_PrintUnformatted(o);
    if(s){printf("\nAC_EVT %s\n",s);fflush(stdout);if(active_remote)ac_network_send(s);free(s);}cJSON_Delete(o);
}
static ac_display_command_t applied_display;static bool have_display;
static bool apply_display(const cJSON *value){
    ac_display_command_t target;if(!ac_device_display_command(value,&target))return false;
    int percent=target.screen_on?(int)target.brightness_percent:0;
    if(!have_display||target.brightness_percent!=applied_display.brightness_percent||target.screen_on!=applied_display.screen_on){
        esp_err_t result=bsp_display_brightness_set(percent);if(result!=ESP_OK){ESP_LOGE(TAG,"backlight update failed: %d",result);return false;}
    }

    applied_display=target;have_display=true;return true;
}
static void report_display(void){
    static uint64_t revision;static uint32_t previous_duty=UINT32_MAX;
    uint32_t duty=ledc_get_duty(LEDC_LOW_SPEED_MODE,CONFIG_BSP_DISPLAY_BRIGHTNESS_LEDC_CH);
    if(applied_display.revision==revision&&duty==previous_duty)return;
    revision=applied_display.revision;previous_duty=duty;
    printf("\nAC_DISPLAY {\"revision\":%llu,\"brightness_percent\":%u,\"screen_on\":%s,\"backlight_duty\":%lu}\n",(unsigned long long)revision,applied_display.brightness_percent,applied_display.screen_on?"true":"false",(unsigned long)duty);fflush(stdout);
}
static void request_detail(const char *id){event("detail","id",id);}
static void request_theme(const char *theme){event("theme","value",theme);}
static void request_refresh(void){event("assistant_refresh",NULL,NULL);}
static void apply_feed(const ac_assistant_feed_t *f){
    ac_assistant_message_view_t messages[8];for(size_t i=0;i<f->message_count;++i)messages[i]=(ac_assistant_message_view_t){f->messages[i].id,f->messages[i].time,f->messages[i].text,f->messages[i].source};
    ac_assistant_feed_view_t view={(ac_assistant_status_t)f->status,false,messages,f->message_count};ac_assistant_panel_set_feed(&view);
}
static void tick(lv_timer_t *timer){
    (void)timer;uint64_t now=millis();ac_bootstrap_screen_tick(now);
    if(!connected)ac_bootstrap_screen_connection_hint(ac_network_label());
    if(connected&&now-last_received>8000){connected=false;ac_bootstrap_screen_connection_lost();last_feed->status=AC_ASSISTANT_OFFLINE;apply_feed(last_feed);event("disconnected",NULL,NULL);}
}
static void refreshed(lv_event_t *e){(void)e;rendered++;}
static void touch(lv_event_t *e){lv_point_t p;lv_indev_get_point(lv_event_get_target(e),&p);bool pressed=lv_event_get_code(e)==LV_EVENT_PRESSED;if(pressed)touches++;printf("\n%s %ld %ld\n",pressed?"AC_TOUCH":"AC_RELEASE",(long)p.x,(long)p.y);}
static uint32_t crc32(const uint8_t *data,size_t n){uint32_t c=~0u;for(size_t i=0;i<n;++i){c^=data[i];for(int j=0;j<8;++j)c=(c>>1)^(0xedb88320u&-(c&1));}return ~c;}
static void send_screen(lv_draw_buf_t *image){
    size_t size=(size_t)image->header.stride*image->header.h;
    char header[100];int n=snprintf(header,sizeof(header),"\nAC_SCREEN %lu %u %u %u %08lx\n",(unsigned long)size,image->header.w,image->header.h,image->header.stride,(unsigned long)crc32(image->data,size));
    flockfile(stdout);fflush(stdout);usb_serial_jtag_write_bytes(header,n,pdMS_TO_TICKS(1000));
    for(size_t i=0;i<size;){int sent=usb_serial_jtag_write_bytes(image->data+i,size-i>1024?1024:size-i,pdMS_TO_TICKS(2000));if(sent<=0)break;i+=sent;}
    usb_serial_jtag_write_bytes("\n",1,pdMS_TO_TICKS(1000));usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(2000));funlockfile(stdout);lv_draw_buf_destroy(image);
}
static void submit(const char *data,size_t length,bool remote){
    if(!incoming||length<1||length>FRAME_LIMIT)return;
    input_packet_t packet={.data=heap_caps_malloc(length+1,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT),.length=length,.remote=remote};if(!packet.data)return;
    memcpy(packet.data,data,length);packet.data[length]=0;if(xQueueSend(incoming,&packet,0)!=pdTRUE)free(packet.data);
}
static void apply_packet(input_packet_t packet,ac_snapshot_t *snapshot,ac_assistant_feed_t *feed,ac_session_detail_t *detail){
    char *body=packet.data;size_t length=packet.length;
            cJSON *o=cJSON_ParseWithLength(body,length);if(!o){event("frame_json_error",NULL,NULL);return;}
            const cJSON *kind=get(o,"kind");
            if(cJSON_IsString(kind)){
                if(!packet.remote&&!strcmp(kind->valuestring,"provision")){if(!ac_network_provision(o))event("provision_rejected",NULL,NULL);}
                else if(!packet.remote&&!strcmp(kind->valuestring,"link_config")){if(!ac_network_configure_link(o))event("provision_rejected",NULL,NULL);}
                else if(!packet.remote&&!strcmp(kind->valuestring,"capture")){lv_draw_buf_t *screen=NULL;if(bsp_display_lock(2000)){if(cJSON_IsTrue(get(o,"schedules")))ac_bootstrap_screen_show_schedules(true);screen=lv_snapshot_take(lv_screen_active(),LV_COLOR_FORMAT_RGB565);bsp_display_unlock();}if(screen)send_screen(screen);}
                cJSON_Delete(o);return;
            }
            const cJSON *clock=get(o,"sent_at"),*wire=get(o,"id");
            if(!cJSON_IsNumber(clock)||clock->valuedouble<1700000000||clock->valuedouble>4102444800||!cJSON_IsNumber(wire)){cJSON_Delete(o);return;}
            if(!isfinite(wire->valuedouble)||wire->valuedouble<1||wire->valuedouble>9007199254740991.0||floor(wire->valuedouble)!=wire->valuedouble){cJSON_Delete(o);return;}
            const cJSON *boot=get(o,"gateway_boot_id");
            if(packet.remote){
                if(millis()-last_usb_received<4000||!ac_device_remote_frame(o,last_boot,last_wire,time(NULL))){cJSON_Delete(o);return;}
            }else{struct timeval tv={.tv_sec=(time_t)clock->valuedouble};settimeofday(&tv,NULL);}
            const cJSON *state=get(o,"state"),*a=get(o,"assistant"),*d=get(o,"detail");
            ac_decode_info_t info;bool state_ok=ac_device_snapshot_checked(state,snapshot,&info),feed_ok=ac_device_assistant(a,feed),detail_ok=d&&ac_device_detail(d,detail);
            if(!state_ok){char note[128];snprintf(note,sizeof(note),"%s source_age_s=%lld wire_age_s=%lld",info.reason,(long long)info.source_age_seconds,(long long)(time(NULL)-(int64_t)clock->valuedouble));event("snapshot_rejected","reason",note);cJSON_Delete(o);return;}
            const cJSON *appearance=get(get(o,"settings"),"appearance"),*theme=get(appearance,"theme"),*motion=get(appearance,"animations_enabled");
            lv_draw_buf_t *screen=NULL;
            if(bsp_display_lock(2000)){
                if(cJSON_IsString(theme))ac_bootstrap_screen_set_theme(theme->valuestring);
                if(cJSON_IsBool(motion))ac_bootstrap_screen_set_animations(cJSON_IsTrue(motion));
                const cJSON *scheduled=get(appearance,"show_scheduled_tasks");
                if(cJSON_IsBool(scheduled))ac_bootstrap_screen_set_scheduled_tasks_visible(cJSON_IsTrue(scheduled));
                bool display_ok=apply_display(get(get(o,"settings"),"display"));
                ac_bootstrap_screen_apply(snapshot,millis());if(feed_ok){*last_feed=*feed;apply_feed(last_feed);}if(detail_ok)ac_bootstrap_screen_detail(detail);
                last_received=millis();connected=true;active_remote=packet.remote;
                if(packet.remote){strcpy(last_boot,boot->valuestring);last_wire=(uint64_t)wire->valuedouble;}else last_usb_received=millis();
                if(!packet.remote&&cJSON_IsTrue(get(o,"capture")))screen=lv_snapshot_take(lv_screen_active(),LV_COLOR_FORMAT_RGB565);
                bsp_display_unlock();
                if(display_ok)report_display();
                printf("\nAC_ACK %.0f seq=%llu sessions=%zu/%zu/%zu messages=%zu\n",wire->valuedouble,(unsigned long long)snapshot->seq,snapshot->agents[0].session_count,snapshot->agents[1].session_count,snapshot->agents[2].session_count,feed_ok?feed->message_count:0);fflush(stdout);
                if(packet.remote){char ack[512],display_ack[256]="";
                    if(display_ok)snprintf(display_ack,sizeof(display_ack),",\"display\":{\"revision\":%llu,\"brightness_percent\":%u,\"screen_on\":%s,\"backlight_duty\":%lu}",(unsigned long long)applied_display.revision,applied_display.brightness_percent,applied_display.screen_on?"true":"false",(unsigned long)ledc_get_duty(LEDC_LOW_SPEED_MODE,CONFIG_BSP_DISPLAY_BRIGHTNESS_LEDC_CH));
                    snprintf(ack,sizeof(ack),"{\"kind\":\"applied\",\"id\":%.0f,\"gateway_boot_id\":\"%s\"%s}",wire->valuedouble,last_boot,display_ack);ac_network_send(ack);}
            }if(screen)send_screen(screen);cJSON_Delete(o);
}
static void apply_task(void *unused){
    (void)unused;ac_snapshot_t *snapshot=heap_caps_calloc(1,sizeof(*snapshot),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    ac_assistant_feed_t *feed=heap_caps_calloc(1,sizeof(*feed),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);
    ac_session_detail_t *detail=heap_caps_calloc(1,sizeof(*detail),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);assert(snapshot&&feed&&detail);
    for(;;){input_packet_t packet;if(xQueueReceive(incoming,&packet,portMAX_DELAY)==pdTRUE){
        /* Remote packets are complete views. Keep the newest adjacent view,
         * preserving FIFO for USB provisioning/capture commands. */
        input_packet_t next;unsigned skipped=0;
        while(packet.remote&&xQueuePeek(incoming,&next,0)==pdTRUE&&next.remote){xQueueReceive(incoming,&next,0);free(packet.data);packet=next;skipped++;}
        if(skipped)ESP_LOGI(TAG,"coalesced %u queued remote views",skipped);
        apply_packet(packet,snapshot,feed,detail);free(packet.data);
    }}
}
static void receive_task(void *unused){
    (void)unused;char *body=heap_caps_malloc(FRAME_LIMIT+1,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);assert(body);
    char header[80];size_t hn=0,want=0,have=0;unsigned expected=0;uint64_t started=0;
    for(;;){uint8_t bytes[512];int n=usb_serial_jtag_read_bytes(bytes,sizeof(bytes),pdMS_TO_TICKS(100));
        if(want&&millis()-started>5000){want=have=0;hn=0;event("frame_timeout",NULL,NULL);}
        for(int j=0;j<n;++j){
            if(!want){if(bytes[j]=='\n'){header[hn]=0;unsigned size=0,checksum=0;if(sscanf(header,"AC1 %u %x",&size,&checksum)==2&&size>0&&size<=FRAME_LIMIT){want=size;expected=checksum;have=0;started=millis();}hn=0;}else if(hn<sizeof(header)-1)header[hn++]=bytes[j];else hn=0;continue;}
            body[have++]=bytes[j];if(have<want)continue;body[have]=0;size_t length=have;want=have=0;
            if(crc32((uint8_t*)body,length)!=expected){event("frame_crc_error",NULL,NULL);continue;}
            submit(body,length,false);
        }
    }
}
void app_main(void){
    setenv("TZ","CST-8",1);tzset();esp_chip_info_t chip;esp_chip_info(&chip);uint32_t flash=0;ESP_ERROR_CHECK(esp_flash_get_size(NULL,&flash));
    ESP_LOGI(TAG,"V1 shared UI revision=%u flash=%lu psram=%u",chip.revision,(unsigned long)flash,(unsigned)esp_psram_get_size());
    usb_serial_jtag_driver_config_t usb={.rx_buffer_size=32768,.tx_buffer_size=2048};if(!usb_serial_jtag_is_driver_installed())ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    /* UI objects and decoder scratch use PSRAM; DMA/ISR/RTOS retain explicit internal caps. */
    heap_caps_malloc_extmem_enable(0);
    bsp_display_cfg_t config={.lv_adapter_cfg=ESP_LV_ADAPTER_DEFAULT_CONFIG(),.rotation=ESP_LV_ADAPTER_ROTATE_180,.tear_avoid_mode=ESP_LV_ADAPTER_TEAR_AVOID_MODE_TRIPLE_PARTIAL,.touch_flags={.swap_xy=0,.mirror_x=0,.mirror_y=0}};
    lv_display_t *display=bsp_display_start_with_config(&config);ESP_ERROR_CHECK(display?ESP_OK:ESP_FAIL);
    last_feed=heap_caps_calloc(1,sizeof(*last_feed),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);assert(last_feed);last_feed->status=AC_ASSISTANT_OFFLINE;
    ESP_ERROR_CHECK(bsp_display_lock(-1)?ESP_OK:ESP_FAIL);lv_group_set_default(lv_group_create());
    ac_theme_set_pointer_hover(false);
    ac_bootstrap_screen_create(true,false,request_detail);ac_bootstrap_screen_theme_handler(request_theme);ac_assistant_panel_refresh_handler(request_refresh);apply_feed(last_feed);
    lv_timer_create(tick,16,NULL);lv_display_add_event_cb(display,refreshed,LV_EVENT_REFR_READY,NULL);
    lv_indev_t *input=NULL;while((input=lv_indev_get_next(input)))if(lv_indev_get_type(input)==LV_INDEV_TYPE_POINTER){lv_indev_add_event_cb(input,touch,LV_EVENT_PRESSED,NULL);lv_indev_add_event_cb(input,touch,LV_EVENT_RELEASED,NULL);}
    bsp_display_unlock();ESP_ERROR_CHECK(bsp_display_brightness_set(75));event("ready","version","V1-board-0.2.15");
    incoming=xQueueCreate(2,sizeof(input_packet_t));assert(incoming);
    xTaskCreate(apply_task,"ac_apply",12288,NULL,4,NULL);
    ac_network_init(submit);
    xTaskCreate(receive_task,"ac_usb_rx",4096,NULL,4,NULL);
    for(;;){vTaskDelay(pdMS_TO_TICKS(10000));unsigned frames[3]={0};if(bsp_display_lock(1000)){for(unsigned i=0;i<3;++i)frames[i]=ac_bootstrap_screen_pet_frame_updates(i);bsp_display_unlock();}ESP_LOGI(TAG,"health internal_free=%u internal_min=%u psram_free=%u psram_largest=%u lvgl_updates_10s=%u touches=%u connected=%d pet0=%u pet1=%u pet2=%u",(unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),(unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),(unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM),rendered,touches,connected,frames[0],frames[1],frames[2]);rendered=0;}
}
