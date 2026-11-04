/* ESP-Hosted C6 station + authenticated WSS. Wi-Fi can be changed locally. */
#include "ac_network.h"
#include "ac_link_watch.h"
#include "ac_relay_url.h"
#include <stdatomic.h>
#include "esp_system.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_attr.h"
#include "esp_random.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include "lwip/inet.h"
#include <fcntl.h>
#include <unistd.h>
#define NET_IP BIT0
#define NET_WIFI_STARTED BIT1
#define NET_SCAN_DONE BIT2
#define MAX_PACKET (192*1024)
typedef struct {char ssid[33],password[65],url[160],token[65],request_id[40];int64_t clock;} legacy_config_t;
typedef struct {char ssid[33],password[65],url[160],token[65],request_id[40];int64_t clock;char lan_url[160],lan_token[65],lan_ca[2048],request_kind[16];} net_config_t;
static bool load(net_config_t *c);
static bool active_lan;
static QueueHandle_t configs,outgoing;
static QueueHandle_t joins;
static atomic_bool scan_requested;
static ac_wifi_status_t wifi_ui;
static uint64_t scan_started;
static EventGroupHandle_t bits;
static ac_network_receive_cb receive;
static esp_websocket_client_handle_t client;
static atomic_bool relay_up;
static portMUX_TYPE link_lock=portMUX_INITIALIZER_UNLOCKED;
static ac_link_watch_t watch;
static uint64_t progress_ms,probe_id,pong_id,packets,reconnects;
static int probe_result;
static bool reconnect_requested,mac_present;
static uint64_t now_ms(void){return esp_timer_get_time()/1000;}
static void progress(void){portENTER_CRITICAL(&link_lock);progress_ms=now_ms();portEXIT_CRITICAL(&link_lock);}
static const char *label="Wi-Fi 待配网";
static void status(const char *state,const char *screen,int code){portENTER_CRITICAL(&link_lock);label=screen;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"%s",screen);portEXIT_CRITICAL(&link_lock);printf("\nAC_NET {\"state\":\"%s\",\"code\":%d}\n",state,code);fflush(stdout);}
void ac_network_wifi_status(ac_wifi_status_t *out){if(!out)return;portENTER_CRITICAL(&link_lock);*out=wifi_ui;out->mac_connected=mac_present&&watch.connected&&now_ms()-watch.last_response_ms<20000;portEXIT_CRITICAL(&link_lock);}
bool ac_network_scan(void){if(!bits)return false;atomic_store(&scan_requested,true);portENTER_CRITICAL(&link_lock);wifi_ui.scanning=true;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"正在扫描附近网络…");portEXIT_CRITICAL(&link_lock);return true;}
bool ac_network_join_local(const ac_wifi_join_t *request){
    if(!joins||!ac_wifi_join_valid(request)||xQueueSend(joins,request,0)!=pdTRUE)return false;
    portENTER_CRITICAL(&link_lock);wifi_ui.connecting=true;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"正在提交 Wi-Fi 配置…");portEXIT_CRITICAL(&link_lock);return true;
}
const char *ac_network_label(void){
    portENTER_CRITICAL(&link_lock);bool live=watch.connected&&now_ms()-watch.last_response_ms<20000,mac=mac_present;const char *hint=label;portEXIT_CRITICAL(&link_lock);
    return live?(mac?"等待 Gateway 数据":"Mac Gateway 离线"):hint;
}
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data){
    (void)arg;
    if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP){xEventGroupSetBits(bits,NET_IP);portENTER_CRITICAL(&link_lock);wifi_ui.connected=true;wifi_ui.connecting=false;portEXIT_CRITICAL(&link_lock);status("wifi_connected","Wi-Fi 已连接",0);}
    else if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_START)xEventGroupSetBits(bits,NET_WIFI_STARTED);
    else if(base==WIFI_EVENT&&id==WIFI_EVENT_SCAN_DONE)xEventGroupSetBits(bits,NET_SCAN_DONE);
    else if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED){xEventGroupClearBits(bits,NET_IP);relay_up=false;portENTER_CRITICAL(&link_lock);ac_link_watch_start(&watch,now_ms());reconnect_requested=true;wifi_ui.connected=false;wifi_ui.connecting=false;bool scanning=wifi_ui.scanning;portEXIT_CRITICAL(&link_lock);const wifi_event_sta_disconnected_t *event=data;if(!scanning)status("wifi_disconnected",event&&event->reason==WIFI_REASON_AUTH_FAIL?"密码验证失败，请重新输入":event&&event->reason==WIFI_REASON_NO_AP_FOUND?"未找到已保存网络，请选择新的 Wi-Fi":"Wi-Fi 连接中断，正在重试",event?event->reason:0);}
}
static void wifi_saved(const net_config_t *config){portENTER_CRITICAL(&link_lock);snprintf(wifi_ui.ssid,sizeof(wifi_ui.ssid),"%s",config->ssid);wifi_ui.has_saved_password=config->password[0]!=0;wifi_ui.relay_configured=config->url[0]!=0;wifi_ui.lan_configured=config->lan_url[0]!=0;portEXIT_CRITICAL(&link_lock);}
static int stronger(const void *left,const void *right){return ((const wifi_ap_record_t *)right)->rssi-((const wifi_ap_record_t *)left)->rssi;}
static void scan_results(void){
    uint16_t count=0;esp_err_t error=esp_wifi_scan_get_ap_num(&count);if(count>32)count=32;
    wifi_ap_record_t *records=count?heap_caps_calloc(count,sizeof(*records),MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT):NULL;
    if(error==ESP_OK&&count)error=records?esp_wifi_scan_get_ap_records(&count,records):ESP_ERR_NO_MEM;
    ac_wifi_network_t rows[AC_WIFI_NETWORK_LIMIT]={0};size_t used=0;
    if(error==ESP_OK&&records){qsort(records,count,sizeof(*records),stronger);for(uint16_t i=0;i<count&&used<AC_WIFI_NETWORK_LIMIT;i++){
        records[i].ssid[32]=0;if(!records[i].ssid[0]||strpbrk((char *)records[i].ssid,"\r\n"))continue;bool duplicate=false;for(size_t j=0;j<used;j++)if(!strcmp(rows[j].ssid,(char *)records[i].ssid))duplicate=true;if(duplicate)continue;
        ac_wifi_network_t *row=&rows[used++];memcpy(row->ssid,records[i].ssid,32);row->ssid[32]=0;row->rssi=records[i].rssi;row->secured=records[i].authmode!=WIFI_AUTH_OPEN;
        row->supported=records[i].authmode==WIFI_AUTH_OPEN||records[i].authmode==WIFI_AUTH_WPA2_PSK||records[i].authmode==WIFI_AUTH_WPA_WPA2_PSK||records[i].authmode==WIFI_AUTH_WPA3_PSK||records[i].authmode==WIFI_AUTH_WPA2_WPA3_PSK;
    }}free(records);
    portENTER_CRITICAL(&link_lock);memcpy(wifi_ui.networks,rows,sizeof(rows));wifi_ui.count=used;wifi_ui.revision++;wifi_ui.scanning=false;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"%s",error!=ESP_OK?"扫描失败，请重试":used?"请选择网络并输入密码":"未发现网络，可手动输入名称");portEXIT_CRITICAL(&link_lock);scan_started=0;
    printf("\nAC_WIFI_SCAN {\"count\":%u,\"ok\":%s}\n",(unsigned)used,error==ESP_OK?"true":"false");fflush(stdout);
}
static char *rx;static size_t used,expected;static int64_t rx_started;
static void websocket(void *arg,esp_event_base_t base,int32_t id,void *event){
    (void)arg;(void)base;esp_websocket_event_data_t *e=event;
    if(id==WEBSOCKET_EVENT_CONNECTED){relay_up=true;portENTER_CRITICAL(&link_lock);ac_link_watch_open(&watch,now_ms());portEXIT_CRITICAL(&link_lock);status(active_lan?"lan_connected":"relay_connected",active_lan?"局域网已连接":"中转已连接",0);used=expected=0;}
    else if(id==WEBSOCKET_EVENT_DISCONNECTED||id==WEBSOCKET_EVENT_CLOSED){relay_up=false;used=expected=0;portENTER_CRITICAL(&link_lock);ac_link_watch_start(&watch,now_ms());reconnect_requested=true;portEXIT_CRITICAL(&link_lock);status(active_lan?"lan_disconnected":"relay_disconnected",active_lan?"局域网重连中":"中转重连中",e?e->close_status_code:0);}
    else if(id==WEBSOCKET_EVENT_ERROR){relay_up=false;portENTER_CRITICAL(&link_lock);reconnect_requested=true;portEXIT_CRITICAL(&link_lock);status(active_lan?"lan_error":"relay_error",active_lan?"局域网连接失败":"中转连接失败",e?(e->error_handle.esp_ws_handshake_status_code?e->error_handle.esp_ws_handshake_status_code:e->error_handle.esp_tls_last_esp_err):0);}
    else if(id==WEBSOCKET_EVENT_DATA&&e&&(e->op_code==1||e->op_code==0)){
        /* Server sends complete JSON messages; transport may deliver many buffer-sized events. */
        if(e->payload_offset==0&&e->op_code==1){used=0;expected=e->payload_len;rx_started=esp_timer_get_time();}
        if(!expected||expected>MAX_PACKET||esp_timer_get_time()-rx_started>5000000||e->data_len<0||used+(size_t)e->data_len>expected){used=expected=0;return;}
        if((size_t)e->payload_offset!=used){used=expected=0;return;}
        memcpy(rx+used,e->data_ptr,e->data_len);used+=e->data_len;
        if(used==expected&&e->fin){
            rx[used]=0;bool control=false;
            if(used<512){cJSON *o=cJSON_ParseWithLength(rx,used);const cJSON *kind=cJSON_GetObjectItemCaseSensitive(o,"kind");
                if(cJSON_IsString(kind)&&(!strcmp(kind->valuestring,"heartbeat")||!strcmp(kind->valuestring,"peer"))){
                    bool accepted=!strcmp(kind->valuestring,"peer");const cJSON *id=cJSON_GetObjectItemCaseSensitive(o,"id");
                    portENTER_CRITICAL(&link_lock);
                    if(!accepted&&cJSON_IsNumber(id)&&id->valuedouble>pong_id&&id->valuedouble<=probe_id){pong_id=(uint64_t)id->valuedouble;accepted=true;}
                    if(accepted){ac_link_watch_response(&watch,now_ms());mac_present=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o,"mac_connected"));packets++;}
                    portEXIT_CRITICAL(&link_lock);control=true;
                }cJSON_Delete(o);
            }
            if(!control){portENTER_CRITICAL(&link_lock);ac_link_watch_response(&watch,now_ms());packets++;portEXIT_CRITICAL(&link_lock);receive(rx,used,true);}
            used=expected=0;
        }
    }
}
void ac_network_send(const char *json){
    if(!relay_up||!outgoing||strlen(json)>=384)return;
    char message[384];snprintf(message,sizeof(message),"%s",json);xQueueSend(outgoing,message,0);
}
static bool valid_hex(const char *s){if(strlen(s)!=64)return false;for(int i=0;i<64;++i)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')||(s[i]>='A'&&s[i]<='F')))return false;return true;}
bool ac_network_provision(const cJSON *o){
    net_config_t c={0};load(&c);strcpy(c.request_kind,"wifi");const char *keys[]={"ssid","password","relay_url","device_token","request_id"};char *dest[]={c.ssid,c.password,c.url,c.token,c.request_id};size_t caps[]={sizeof(c.ssid),sizeof(c.password),sizeof(c.url),sizeof(c.token),sizeof(c.request_id)};
    for(int i=0;i<5;++i){const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,keys[i]);if(!cJSON_IsString(v)||strlen(v->valuestring)>=caps[i]||strpbrk(v->valuestring,"\r\n"))return false;strcpy(dest[i],v->valuestring);}
    const cJSON *clock=cJSON_GetObjectItemCaseSensitive(o,"sent_at");if(!cJSON_IsNumber(clock)||clock->valuedouble<1700000000||clock->valuedouble>4102444800)return false;c.clock=(int64_t)clock->valuedouble;
    size_t n=strlen(c.password);if(!c.ssid[0]||n<8||n>64||(n==64&&!valid_hex(c.password))||(c.url[0]?(!valid_hex(c.token)||!ac_relay_url_valid(c.url)):c.token[0]!=0)||strlen(c.request_id)!=36)return false;
    for(int i=0;i<36;++i)if(!((c.request_id[i]>='a'&&c.request_id[i]<='f')||(c.request_id[i]>='0'&&c.request_id[i]<='9')||c.request_id[i]=='-'))return false;
    if(!configs||xQueueSend(configs,&c,0)!=pdTRUE)return false;
    return true;
}
static bool lan_host(const char *url,char host[100]){
    int end=0;if(sscanf(url,"wss://%99[^:]:8737/v1/device%n",host,&end)!=1||end!=(int)strlen(url))return false;
    struct in_addr ip;if(inet_pton(AF_INET,host,&ip)==1){uint32_t n=ntohl(ip.s_addr);unsigned a=n>>24,b=(n>>16)&255;return a==10||(a==192&&b==168)||(a==172&&b>=16&&b<=31)||(a==169&&b==254);}
    size_t n=strlen(host);if(n<7||strcmp(host+n-6,".local"))return false;for(size_t i=0;i<n;i++)if(!((host[i]>='a'&&host[i]<='z')||(host[i]>='A'&&host[i]<='Z')||(host[i]>='0'&&host[i]<='9')||host[i]=='-'||host[i]=='.'))return false;return true;
}
bool ac_network_configure_link(const cJSON *o){
    net_config_t c={0};if(!load(&c))return false;const char *keys[]={"lan_url","lan_token","lan_ca","request_id"};char *dest[]={c.lan_url,c.lan_token,c.lan_ca,c.request_id};size_t caps[]={sizeof(c.lan_url),sizeof(c.lan_token),sizeof(c.lan_ca),sizeof(c.request_id)};
    for(int i=0;i<4;i++){const cJSON *v=cJSON_GetObjectItemCaseSensitive(o,keys[i]);if(!cJSON_IsString(v)||strlen(v->valuestring)>=caps[i])return false;strcpy(dest[i],v->valuestring);}
    char host[100];if(!lan_host(c.lan_url,host)||!valid_hex(c.lan_token)||strncmp(c.lan_ca,"-----BEGIN CERTIFICATE-----",27)||strlen(c.request_id)!=36)return false;
    const cJSON *clock=cJSON_GetObjectItemCaseSensitive(o,"sent_at");if(!cJSON_IsNumber(clock)||clock->valuedouble<1700000000||clock->valuedouble>4102444800)return false;c.clock=(int64_t)clock->valuedouble;strcpy(c.request_kind,"link");return configs&&xQueueSend(configs,&c,0)==pdTRUE;
}
static bool save(net_config_t *c){
    nvs_handle_t h;if(nvs_open("ac_network",NVS_READWRITE,&h)!=ESP_OK)return false;
    esp_err_t err=nvs_set_blob(h,"config_v2",c,sizeof(*c));if(err==ESP_OK)err=nvs_commit(h);nvs_close(h);return err==ESP_OK;
}
static bool load(net_config_t *c){
    nvs_handle_t h;if(nvs_open("ac_network",NVS_READONLY,&h)!=ESP_OK)return false;size_t n=sizeof(*c);esp_err_t e=nvs_get_blob(h,"config_v2",c,&n);
    if(e==ESP_ERR_NVS_NOT_FOUND){legacy_config_t old={0};n=sizeof(old);e=nvs_get_blob(h,"config",&old,&n);if(e==ESP_OK&&n==sizeof(old)){memset(c,0,sizeof(*c));memcpy(c,&old,sizeof(old));n=sizeof(*c);}}
    nvs_close(h);char host[100];return e==ESP_OK&&n==sizeof(*c)&&memchr(c->ssid,0,sizeof(c->ssid))&&memchr(c->password,0,sizeof(c->password))&&memchr(c->url,0,sizeof(c->url))&&memchr(c->token,0,sizeof(c->token))&&memchr(c->lan_url,0,sizeof(c->lan_url))&&memchr(c->lan_ca,0,sizeof(c->lan_ca))&&memchr(c->lan_token,0,sizeof(c->lan_token))&&(c->url[0]?(valid_hex(c->token)&&ac_relay_url_valid(c->url)):!c->token[0])&&(!c->lan_url[0]||(lan_host(c->lan_url,host)&&valid_hex(c->lan_token)));
}
static bool reachable(const char *url){
    char host[100];if(!lan_host(url,host))return false;struct addrinfo hints={.ai_family=AF_INET,.ai_socktype=SOCK_STREAM},*result=NULL;if(getaddrinfo(host,"8737",&hints,&result)||!result)return false;
    int fd=socket(AF_INET,SOCK_STREAM,0);bool ok=false;if(fd>=0){fcntl(fd,F_SETFL,O_NONBLOCK);int connected=connect(fd,result->ai_addr,result->ai_addrlen);if(connected==0)ok=true;else{fd_set write;FD_ZERO(&write);FD_SET(fd,&write);struct timeval wait={.tv_sec=1};if(select(fd+1,NULL,&write,NULL,&wait)>0){int error=-1;socklen_t len=sizeof(error);if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&error,&len)==0&&error==0)ok=true;}}close(fd);}freeaddrinfo(result);return ok;
}
static void run(void *unused){
    (void)unused;static EXT_RAM_BSS_ATTR net_config_t c,next;bool have=false,initialized=false,sntp=false,choose_transport=true;int64_t retry=0;uint64_t reconnect_after=0,report_at=0,lan_probe_after=0;
    progress();esp_err_t err=nvs_flash_init();if(err!=ESP_OK){status("nvs_error","配网存储异常",err);vTaskDelete(NULL);return;}
    have=load(&c);if(!have)memset(&c,0,sizeof(c));wifi_saved(&c);active_lan=have&&c.lan_url[0];
    for(;;){progress();memset(&next,0,sizeof(next));bool changed=xQueueReceive(configs,&next,pdMS_TO_TICKS(100))==pdTRUE;ac_wifi_join_t request={0};
        if(!changed&&xQueueReceive(joins,&request,0)==pdTRUE){
            next=c;changed=ac_wifi_apply_join(&request,next.ssid,next.password);ac_wifi_clear_secret(&request,sizeof(request));
            if(changed){strcpy(next.request_kind,"wifi_local");uint32_t a=esp_random(),b=esp_random(),d=esp_random(),f=esp_random();snprintf(next.request_id,sizeof(next.request_id),"%08lx-%04x-%04x-%04x-%04x%08lx",(unsigned long)a,(unsigned)(b>>16),(unsigned)(b&65535),(unsigned)(d>>16),(unsigned)(d&65535),(unsigned long)f);if(time(NULL)>1700000000)next.clock=time(NULL);}
            else{portENTER_CRITICAL(&link_lock);wifi_ui.connecting=false;portEXIT_CRITICAL(&link_lock);status("wifi_input_invalid","已保存密码不适用于该网络，请重新输入",0);}
        }
        if(changed){
            if(!save(&next)){portENTER_CRITICAL(&link_lock);wifi_ui.connecting=false;portEXIT_CRITICAL(&link_lock);status("save_failed","配网保存失败",0);continue;}
            wifi_saved(&next);portENTER_CRITICAL(&link_lock);wifi_ui.connecting=true;wifi_ui.connected=false;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"配置已保存，正在连接 Wi-Fi…");portEXIT_CRITICAL(&link_lock);
            /* Saving is acknowledged before network cleanup: a stalled old TLS
             * client must not cause repeated provisioning of committed data. */
            printf("\n%s {\"request_id\":\"%s\",\"state\":\"saved\"}\n",!strcmp(next.request_kind,"link")?"AC_LINK_CONFIG":"AC_PROVISION",next.request_id);fflush(stdout);
            if(client){esp_websocket_client_stop(client);esp_websocket_client_destroy(client);client=NULL;}relay_up=false;
            bool wifi_changed=strcmp(c.ssid,next.ssid)||strcmp(c.password,next.password);c=next;have=true;choose_transport=true;active_lan=c.lan_url[0];reconnect_after=now_ms()+250;lan_probe_after=now_ms()+30000;if(initialized&&wifi_changed){esp_wifi_disconnect();xEventGroupClearBits(bits,NET_IP);}
            bool still_connected=!wifi_changed&&(xEventGroupGetBits(bits)&NET_IP);portENTER_CRITICAL(&link_lock);wifi_ui.connected=still_connected;wifi_ui.connecting=!wifi_ui.connected;portEXIT_CRITICAL(&link_lock);
            retry=0;
            if(initialized&&wifi_changed){wifi_config_t w={0};memcpy(w.sta.ssid,c.ssid,strlen(c.ssid));memcpy(w.sta.password,c.password,strlen(c.password));w.sta.threshold.authmode=c.password[0]?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN;w.sta.pmf_cfg.capable=true;esp_wifi_set_config(WIFI_IF_STA,&w);}
        }
        if(time(NULL)<1700000000&&c.clock>1700000000){struct timeval tv={.tv_sec=c.clock};settimeofday(&tv,NULL);}
        if(!initialized&&(have||atomic_load(&scan_requested))){
            status("wifi_initializing","正在连接 Wi-Fi",0);
            err=esp_netif_init();if(err!=ESP_OK&&err!=ESP_ERR_INVALID_STATE)goto init_failed;
            err=esp_event_loop_create_default();if(err!=ESP_OK&&err!=ESP_ERR_INVALID_STATE)goto init_failed;
            if(!esp_netif_create_default_wifi_sta()){err=ESP_FAIL;goto init_failed;}
            wifi_init_config_t cfg=WIFI_INIT_CONFIG_DEFAULT();err=esp_wifi_init(&cfg);if(err!=ESP_OK)goto init_failed;
            esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL);esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL);
            esp_wifi_set_storage(WIFI_STORAGE_RAM);wifi_config_t w={0};memcpy(w.sta.ssid,c.ssid,strlen(c.ssid));memcpy(w.sta.password,c.password,strlen(c.password));w.sta.threshold.authmode=c.password[0]?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN;w.sta.pmf_cfg.capable=true;
            err=esp_wifi_set_mode(WIFI_MODE_STA);if(err!=ESP_OK)goto init_failed;if(have){err=esp_wifi_set_config(WIFI_IF_STA,&w);if(err!=ESP_OK)goto init_failed;}err=esp_wifi_start();if(err!=ESP_OK)goto init_failed;
            initialized=true;
        }
        if(!initialized)continue;
        if((xEventGroupGetBits(bits)&NET_WIFI_STARTED)&&atomic_exchange(&scan_requested,false)){
            if(!(xEventGroupGetBits(bits)&NET_IP)){esp_wifi_disconnect();vTaskDelay(pdMS_TO_TICKS(150));}
            xEventGroupClearBits(bits,NET_SCAN_DONE);wifi_scan_config_t scan={.show_hidden=false,.scan_type=WIFI_SCAN_TYPE_ACTIVE};
            esp_err_t result=esp_wifi_scan_start(&scan,false);scan_started=now_ms();retry=esp_timer_get_time()+20000000;
            if(result!=ESP_OK){scan_started=0;portENTER_CRITICAL(&link_lock);wifi_ui.scanning=false;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"暂时无法扫描，请重试");portEXIT_CRITICAL(&link_lock);}
        }
        if(scan_started&&(xEventGroupGetBits(bits)&NET_SCAN_DONE)){xEventGroupClearBits(bits,NET_SCAN_DONE);scan_results();retry=esp_timer_get_time()+1000000;}
        if(scan_started&&now_ms()-scan_started>15000){esp_wifi_scan_stop();scan_started=0;portENTER_CRITICAL(&link_lock);wifi_ui.scanning=false;snprintf(wifi_ui.message,sizeof(wifi_ui.message),"扫描超时，请重试");portEXIT_CRITICAL(&link_lock);}
        if(!have||scan_started)continue;
        if(!(xEventGroupGetBits(bits)&NET_IP)){
            choose_transport=true;
            if((xEventGroupGetBits(bits)&NET_WIFI_STARTED)&&esp_timer_get_time()>retry){esp_wifi_connect();retry=esp_timer_get_time()+10000000;}
            continue;
        }
        if(!sntp){esp_sntp_config_t cfg=ESP_NETIF_SNTP_DEFAULT_CONFIG("ntp.aliyun.com");if(esp_netif_sntp_init(&cfg)==ESP_OK)sntp=true;}
        if(client){
            portENTER_CRITICAL(&link_lock);ac_link_action_t action=ac_link_watch_tick(&watch,now_ms());bool requested=reconnect_requested;portEXIT_CRITICAL(&link_lock);
            bool upgrade=false;if(!active_lan&&c.lan_url[0]&&now_ms()>=lan_probe_after){lan_probe_after=now_ms()+30000;upgrade=reachable(c.lan_url);}
            if(requested||action==AC_LINK_RECONNECT||upgrade){
                relay_up=false;status(active_lan?"lan_reconnecting":"relay_reconnecting",active_lan?"局域网重连中":"中转重连中",action==AC_LINK_RECONNECT?408:0);
                esp_websocket_client_stop(client);esp_websocket_client_destroy(client);client=NULL;xQueueReset(outgoing);
                portENTER_CRITICAL(&link_lock);reconnect_requested=false;ac_link_watch_start(&watch,now_ms());reconnects++;portEXIT_CRITICAL(&link_lock);reconnect_after=now_ms()+5000;active_lan=upgrade||!c.url[0];lan_probe_after=now_ms()+30000;
            }else if(action==AC_LINK_PROBE){
                portENTER_CRITICAL(&link_lock);uint64_t id=++probe_id;portEXIT_CRITICAL(&link_lock);char beat[96];snprintf(beat,sizeof(beat),"{\"kind\":\"heartbeat\",\"id\":%llu}",(unsigned long long)id);
                /* A busy TX lock is not evidence of a dead peer. Transport errors
                 * raise an event; otherwise the response watchdog decides. */
                int result=esp_websocket_client_send_text(client,beat,strlen(beat),pdMS_TO_TICKS(1000));
                portENTER_CRITICAL(&link_lock);probe_result=result;portEXIT_CRITICAL(&link_lock);
            }
        }
        if(!client&&(c.lan_url[0]||c.url[0])&&now_ms()>=reconnect_after){
            if(choose_transport){active_lan=c.lan_url[0]&&(!c.url[0]||reachable(c.lan_url));choose_transport=false;}
            portENTER_CRITICAL(&link_lock);ac_link_watch_start(&watch,now_ms());probe_id=pong_id=0;mac_present=false;reconnect_requested=false;portEXIT_CRITICAL(&link_lock);
            char headers[100];snprintf(headers,sizeof(headers),"Authorization: Bearer %s\r\n",active_lan?c.lan_token:c.token);
            esp_websocket_client_config_t cfg={.uri=active_lan?c.lan_url:c.url,.headers=headers,.cert_pem=active_lan?c.lan_ca:NULL,.crt_bundle_attach=active_lan?NULL:esp_crt_bundle_attach,.skip_cert_common_name_check=false,.buffer_size=4096,.task_stack=8192,.network_timeout_ms=10000,.reconnect_timeout_ms=5000,.ping_interval_sec=15,.pingpong_timeout_sec=15,.disable_auto_reconnect=true,.enable_close_reconnect=false};
            client=esp_websocket_client_init(&cfg);if(client){esp_websocket_register_events(client,WEBSOCKET_EVENT_ANY,websocket,NULL);esp_websocket_client_start(client);status(active_lan?"connecting_lan":"connecting_relay",active_lan?"正在连接 Mac":"正在连接中转",0);}else status("relay_init_error","中转启动失败",0);
        }
        char message[384];if(client&&relay_up&&xQueueReceive(outgoing,message,0)==pdTRUE)esp_websocket_client_send_text(client,message,strlen(message),pdMS_TO_TICKS(1000));
        if(now_ms()-report_at>=10000){
            report_at=now_ms();portENTER_CRITICAL(&link_lock);uint64_t age=now_ms()-watch.last_response_ms,count=packets,retries=reconnects,probe=probe_id,pong=pong_id;int result=probe_result;bool live=watch.connected&&age<20000,mac=mac_present;portEXIT_CRITICAL(&link_lock);
            printf("\nAC_LINK {\"relay_connected\":%s,\"lan_connected\":%s,\"transport\":\"%s\",\"mac_connected\":%s,\"response_age_ms\":%llu,\"packets\":%llu,\"reconnects\":%llu,\"probe\":%llu,\"pong\":%llu,\"probe_result\":%d}\n",live&&!active_lan?"true":"false",live&&active_lan?"true":"false",active_lan?"wifi":"relay",mac?"true":"false",(unsigned long long)age,(unsigned long long)count,(unsigned long long)retries,(unsigned long long)probe,(unsigned long long)pong,result);
        }
        continue;
init_failed:
        status("wifi_init_error","Wi-Fi 初始化失败",err);vTaskDelete(NULL);return;
    }
}
static void supervise(void *unused){
    (void)unused;for(;;){vTaskDelay(pdMS_TO_TICKS(1000));portENTER_CRITICAL(&link_lock);uint64_t age=now_ms()-progress_ms;portEXIT_CRITICAL(&link_lock);if(age>45000){ESP_EARLY_LOGW("ac_network","network recovery task stalled; restarting with saved configuration");esp_restart();}}
}
void ac_network_init(ac_network_receive_cb callback){
    receive=callback;bits=xEventGroupCreate();configs=xQueueCreate(1,sizeof(net_config_t));joins=xQueueCreate(1,sizeof(ac_wifi_join_t));outgoing=xQueueCreate(16,384);rx=heap_caps_malloc(MAX_PACKET+1,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);assert(bits&&configs&&joins&&outgoing&&rx);progress();xTaskCreate(run,"ac_network",8192,NULL,3,NULL);xTaskCreate(supervise,"ac_net_watch",3072,NULL,3,NULL);
}
