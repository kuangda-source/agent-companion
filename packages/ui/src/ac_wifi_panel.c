#include "ac_wifi_panel.h"
#include "ac_neon.h"
#include <stdio.h>
#include <string.h>
static lv_obj_t *overlay,*dialog,*networks,*ssid,*password,*keyboard,*summary,*notice,*saved_hint,*remote_hint,*scan_hint,*scan_button,*join_button,*open_network,*reveal_label,*previous_focus;
static lv_group_t *screen_group,*group;
static ac_wifi_scan_fn scan_handler;static ac_wifi_join_fn join_handler;
static ac_wifi_status_t current;static bool mock_mode,revealed;static uint32_t rendered_revision;
static lv_obj_t *label(lv_obj_t *parent,int x,int y,int width,const char *value,uint32_t color){
    lv_obj_t *obj=ac_neon_text(parent,x,y,value,color);lv_obj_set_width(obj,width);lv_obj_set_style_text_font(obj,ac_theme_font(16),0);lv_label_set_long_mode(obj,LV_LABEL_LONG_DOT);return obj;
}
static void key_group(lv_group_t *target){for(lv_indev_t *i=lv_indev_get_next(NULL);i;i=lv_indev_get_next(i))if(lv_indev_get_type(i)==LV_INDEV_TYPE_KEYPAD||lv_indev_get_type(i)==LV_INDEV_TYPE_ENCODER)lv_indev_set_group(i,target);}
bool ac_wifi_panel_visible(void){return overlay&&!lv_obj_has_flag(overlay,LV_OBJ_FLAG_HIDDEN);}
static void saved_message(void){
    if(!ssid||!saved_hint)return;
    bool saved=current.has_saved_password&&!strcmp(lv_textarea_get_text(ssid),current.ssid);
    lv_label_set_text(saved_hint,saved?"密码已保存，留空可重新连接":"选择网络后输入密码，支持英文、数字与符号");
}
static void field_event(lv_event_t *event){
    lv_obj_t *field=lv_event_get_target_obj(event);
    if(keyboard&&(lv_event_get_code(event)==LV_EVENT_FOCUSED||lv_event_get_code(event)==LV_EVENT_CLICKED)){lv_obj_remove_flag(keyboard,LV_OBJ_FLAG_HIDDEN);lv_keyboard_set_textarea(keyboard,field);}
    if(field==ssid&&lv_event_get_code(event)==LV_EVENT_VALUE_CHANGED)saved_message();
}
static void choose(lv_event_t *event){
    size_t index=(size_t)(uintptr_t)lv_event_get_user_data(event);if(index>=current.count)return;
    const ac_wifi_network_t *network=&current.networks[index];
    if(!network->supported){lv_textarea_set_text(ssid,"");lv_textarea_set_text(password,"");lv_label_set_text(notice,"该网络的认证方式暂不支持，请使用普通 Wi-Fi 或手机热点");return;}
    lv_textarea_set_text(ssid,network->ssid);lv_textarea_set_text(password,"");
    if(network->secured)lv_obj_remove_state(open_network,LV_STATE_CHECKED);else lv_obj_add_state(open_network,LV_STATE_CHECKED);
    lv_keyboard_set_textarea(keyboard,password);lv_group_focus_obj(password);saved_message();
}
static lv_obj_t *button(lv_obj_t *parent,int x,int y,int width,int height,const char *text,lv_event_cb_t action){
    lv_obj_t *obj=ac_neon_box(parent,x,y,width,height,AC_NEON_SURFACE);lv_obj_add_flag(obj,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(obj,AC_NEON_CYAN);
    label(obj,12,12,width-22,text,AC_NEON_TEXT);lv_obj_add_event_cb(obj,action,LV_EVENT_CLICKED,NULL);lv_group_add_obj(group,obj);return obj;
}
void ac_wifi_panel_update(const ac_wifi_status_t *status){
    if(!overlay||!status)return;
    current=*status;
    if(!ac_wifi_panel_visible())return;
    if(!current.available&&!mock_mode)lv_label_set_text(summary,"Wi-Fi：状态不可用，请在板端查看");
    else if(current.connected)lv_label_set_text_fmt(summary,"%sWi-Fi：已连接 · %s%s%s",mock_mode?"MOCK · ":"",current.ssid[0]?current.ssid:"当前网络",current.ip[0]?" · IP ":"",current.ip);
    else if(current.connecting)lv_label_set_text_fmt(summary,"%sWi-Fi：正在连接 · %s",mock_mode?"MOCK · ":"",current.ssid);
    else lv_label_set_text_fmt(summary,"%sWi-Fi：未连接%s%s%s%s",mock_mode?"MOCK · ":"",current.ssid[0]?" · 已保存 ":"，请选择网络",current.ssid,current.wifi_note[0]?" · ":"",current.wifi_note);
    lv_obj_set_style_text_color(summary,ac_color(!current.available&&!mock_mode?AC_NEON_MUTED:current.connected?AC_NEON_GREEN:current.connecting?AC_NEON_YELLOW:AC_NEON_MUTED),0);
    if(current.scanning)lv_label_set_text(scan_hint,"正在扫描附近网络…");
    else if(current.scan_failed)lv_label_set_text(scan_hint,"扫描失败，请重试");
    else if(current.count)lv_label_set_text_fmt(scan_hint,"已发现 %zu 个网络",current.count);
    else lv_label_set_text(scan_hint,"可扫描网络或手动输入");
    if(!current.available&&!mock_mode)lv_label_set_text(remote_hint,"此处仅作预览，请在板端查看连接状态");
    else if(current.link_connected)lv_label_set_text_fmt(remote_hint,"%s：已连接 · Mac：%s · %s",current.lan_active?"局域网":"中转",current.mac_connected?"在线":"离线",current.usb_active?"USB 优先":current.data_fresh?"数据已同步":"等待数据");
    else if(!current.connected)lv_label_set_text(remote_hint,"远程连接：等待 Wi-Fi 联网");
    else if(current.relay_configured||current.lan_configured)lv_label_set_text_fmt(remote_hint,"%s：%s%s",current.lan_active?"局域网":"中转",current.link_error_code==409?"等待旧连接释放，自动重试":current.link_error_code?"连接中断，正在重试":"连接中",current.usb_active?" · 数据：USB":"");
    else lv_label_set_text(remote_hint,"尚未配置中转，请先在 Mac 配置一次");
    lv_obj_set_style_text_color(remote_hint,ac_color((current.available||mock_mode)&&current.data_fresh?AC_NEON_GREEN:AC_NEON_MUTED),0);
    if(current.scanning||current.connecting||(!current.available&&!mock_mode)){lv_obj_add_state(scan_button,LV_STATE_DISABLED);lv_obj_add_state(join_button,LV_STATE_DISABLED);}else{lv_obj_remove_state(scan_button,LV_STATE_DISABLED);lv_obj_remove_state(join_button,LV_STATE_DISABLED);}
    if(rendered_revision!=current.revision){
        rendered_revision=current.revision;lv_obj_clean(networks);
        if(!current.count)label(networks,12,12,292,current.scanning?"正在扫描附近网络…":"未发现网络，可手动填写名称",AC_NEON_MUTED);
        for(size_t i=0;i<current.count&&i<AC_WIFI_NETWORK_LIMIT;i++){
            const ac_wifi_network_t *network=&current.networks[i];lv_obj_t *row=ac_neon_box(networks,4,4+(int)i*46,308,42,AC_NEON_SURFACE);lv_obj_add_flag(row,LV_OBJ_FLAG_CLICKABLE);ac_neon_interactive(row,AC_NEON_CYAN);
            label(row,8,3,220,network->ssid,AC_NEON_TEXT);lv_obj_t *details=label(row,8,23,285,"",AC_NEON_MUTED);lv_obj_set_style_text_font(details,ac_theme_font(13),0);lv_label_set_text_fmt(details,"%s  %d dBm",!network->supported?"暂不支持":network->secured?"加密":"开放",network->rssi);
            lv_obj_add_event_cb(row,choose,LV_EVENT_CLICKED,(void *)(uintptr_t)i);lv_group_add_obj(group,row);
        }
    }
    saved_message();
}
static void scan(lv_event_t *event){
    (void)event;lv_label_set_text(notice,"");
    if(mock_mode){current.count=3;current.revision++;strcpy(current.networks[0].ssid,"Example Wi-Fi");strcpy(current.networks[1].ssid,"Mobile Hotspot");strcpy(current.networks[2].ssid,"Guest Wi-Fi");for(size_t i=0;i<3;i++){current.networks[i].rssi=-35-(int)i*15;current.networks[i].secured=i!=2;current.networks[i].supported=true;}strcpy(current.message,"演示网络列表，不会连接真实 Wi-Fi");ac_wifi_panel_update(&current);}
    else if(!scan_handler||!scan_handler())lv_label_set_text(notice,"扫描暂不可用，请稍后重试（仅板端可连接真实网络）");
}
static void join(lv_event_t *event){
    (void)event;ac_wifi_join_t request={0};const char *name=lv_textarea_get_text(ssid),*secret=lv_textarea_get_text(password);
    if(strlen(name)>=sizeof(request.ssid)||strlen(secret)>=sizeof(request.password)){lv_label_set_text(notice,"网络名称或密码太长");return;}
    strcpy(request.ssid,name);strcpy(request.password,secret);request.open_network=lv_obj_has_state(open_network,LV_STATE_CHECKED);
    request.use_saved_password=!request.password[0]&&!request.open_network&&current.has_saved_password&&!strcmp(name,current.ssid);
    if(!ac_wifi_join_valid(&request)){lv_label_set_text(notice,"请选择网络并输入 8–63 位密码；无密码网络请勾选“开放网络”");ac_wifi_clear_secret(&request,sizeof(request));return;}
    bool accepted=mock_mode||(join_handler&&join_handler(&request));
    ac_wifi_clear_secret(&request,sizeof(request));
    if(accepted){lv_textarea_set_text(password,"");revealed=false;lv_textarea_set_password_mode(password,true);lv_label_set_text(reveal_label,"显示");lv_label_set_text(notice,mock_mode?"MOCK：仅演示提交，不保存或连接真实 Wi-Fi":"已提交，正在连接；服务器和配对信息保留");}
    else lv_label_set_text(notice,"暂时无法提交，请稍后重试");
}
static void reveal(lv_event_t *event){(void)event;revealed=!revealed;lv_textarea_set_password_mode(password,!revealed);lv_label_set_text(reveal_label,revealed?"隐藏":"显示");}
bool ac_wifi_panel_close(void){
    if(!ac_wifi_panel_visible())return false;
    lv_textarea_set_text(password,"");lv_textarea_set_password_mode(password,true);revealed=false;lv_label_set_text(reveal_label,"显示");lv_obj_add_flag(overlay,LV_OBJ_FLAG_HIDDEN);key_group(screen_group);
    if(previous_focus&&lv_obj_is_valid(previous_focus))lv_group_focus_obj(previous_focus);
    return true;
}
static void close_event(lv_event_t *event){(void)event;ac_wifi_panel_close();}
static void keyboard_event(lv_event_t *event){if(lv_event_get_code(event)==LV_EVENT_READY)join(event);else if(lv_event_get_code(event)==LV_EVENT_CANCEL)lv_obj_add_flag(keyboard,LV_OBJ_FLAG_HIDDEN);}
static void escape(lv_event_t *event){if(lv_event_get_key(event)==LV_KEY_ESC)ac_wifi_panel_close();}
static lv_obj_t *field(int x,int y,int width,bool secret){
    lv_obj_t *obj=lv_textarea_create(dialog);lv_obj_set_pos(obj,x,y);lv_obj_set_size(obj,width,46);lv_textarea_set_one_line(obj,true);lv_textarea_set_max_length(obj,secret?64:32);lv_textarea_set_password_mode(obj,secret);lv_textarea_set_password_show_time(obj,0);lv_obj_set_style_text_font(obj,ac_theme_font(16),0);lv_obj_set_style_text_color(obj,ac_color(AC_NEON_TEXT),0);lv_obj_set_style_bg_color(obj,ac_color(AC_NEON_BG),0);lv_obj_set_style_border_color(obj,ac_color(AC_NEON_MUTED),0);
    lv_obj_add_event_cb(obj,field_event,LV_EVENT_ALL,NULL);lv_group_add_obj(group,obj);return obj;
}
void ac_wifi_panel_create(lv_obj_t *screen,bool mock){
    mock_mode=mock;keyboard=NULL;ssid=NULL;saved_hint=NULL;memset(&current,0,sizeof(current));rendered_revision=UINT32_MAX;scan_handler=NULL;join_handler=NULL;screen_group=lv_group_get_default();group=lv_group_create();lv_group_set_wrap(group,true);
    overlay=ac_neon_box(screen,0,0,1024,600,AC_NEON_BG);lv_obj_set_style_bg_opa(overlay,LV_OPA_90,0);lv_obj_add_flag(overlay,LV_OBJ_FLAG_CLICKABLE);
    dialog=ac_neon_box(overlay,12,10,1000,580,AC_NEON_SURFACE);lv_obj_add_flag(dialog,LV_OBJ_FLAG_CLICKABLE);
    label(dialog,20,14,840,"Wi-Fi 与远程连接",AC_NEON_CYAN);button(dialog,930,5,50,40,"×",close_event);
    summary=label(dialog,20,52,950,"选择 Wi-Fi 网络；更换环境无需连接 Mac",AC_NEON_TEXT);
    networks=ac_neon_box(dialog,16,84,328,232,AC_NEON_BG);ac_neon_flat(networks);lv_obj_add_flag(networks,LV_OBJ_FLAG_SCROLLABLE);lv_obj_set_scroll_dir(networks,LV_DIR_VER);lv_obj_set_scrollbar_mode(networks,LV_SCROLLBAR_MODE_AUTO);
    scan_button=button(dialog,20,322,150,42,"扫描网络",scan);label(dialog,182,335,165,"支持 2.4GHz",AC_NEON_MUTED);
    label(dialog,370,85,550,"网络名称（可手动输入）",AC_NEON_MUTED);ssid=field(370,109,600,false);
    label(dialog,370,166,550,"Wi-Fi 密码",AC_NEON_MUTED);password=field(370,191,482,true);
    lv_obj_t *show=button(dialog,864,191,106,46,"",reveal);reveal_label=label(show,14,13,82,"显示",AC_NEON_TEXT);
    saved_hint=label(dialog,370,246,600,"选择网络后输入密码，支持英文、数字与符号",AC_NEON_MUTED);lv_obj_set_style_text_font(saved_hint,ac_theme_font(13),0);
    open_network=lv_checkbox_create(dialog);lv_obj_set_pos(open_network,370,280);lv_checkbox_set_text(open_network,"开放网络（无密码）");lv_obj_set_style_text_font(open_network,ac_theme_font(16),0);lv_obj_set_style_text_color(open_network,ac_color(AC_NEON_TEXT),0);lv_group_add_obj(group,open_network);
    join_button=button(dialog,730,274,240,44,"连接并保存",join);
    notice=label(dialog,370,327,600,"需要网页登录的网络暂不支持，可使用手机热点",AC_NEON_YELLOW);lv_obj_set_style_text_font(notice,ac_theme_font(13),0);
    scan_hint=label(dialog,20,370,328,"",AC_NEON_MUTED);lv_obj_set_style_text_font(scan_hint,ac_theme_font(13),0);
    remote_hint=label(dialog,370,366,600,"",AC_NEON_MUTED);lv_obj_set_style_text_font(remote_hint,ac_theme_font(13),0);
    keyboard=lv_keyboard_create(dialog);lv_obj_set_align(keyboard,LV_ALIGN_TOP_LEFT);lv_obj_set_pos(keyboard,16,396);lv_obj_set_size(keyboard,968,170);lv_keyboard_set_popovers(keyboard,false);lv_keyboard_set_textarea(keyboard,ssid);lv_obj_set_style_bg_color(keyboard,ac_color(AC_NEON_BG),0);lv_obj_set_style_bg_color(keyboard,ac_color(AC_NEON_SURFACE),LV_PART_ITEMS);lv_obj_set_style_text_color(keyboard,ac_color(AC_NEON_TEXT),LV_PART_ITEMS);lv_obj_set_style_text_font(keyboard,&lv_font_montserrat_14,LV_PART_ITEMS);lv_obj_add_event_cb(keyboard,keyboard_event,LV_EVENT_ALL,NULL);lv_group_add_obj(group,keyboard);
    for(uint32_t i=0;i<lv_group_get_obj_count(group);i++)lv_obj_add_event_cb(lv_group_get_obj_by_index(group,i),escape,LV_EVENT_KEY,NULL);
    lv_obj_add_flag(overlay,LV_OBJ_FLAG_HIDDEN);
}
void ac_wifi_panel_handlers(ac_wifi_scan_fn scan_fn,ac_wifi_join_fn join_fn){scan_handler=scan_fn;join_handler=join_fn;}
void ac_wifi_panel_open(void){if(!overlay)return;previous_focus=screen_group?lv_group_get_focused(screen_group):NULL;lv_obj_remove_flag(overlay,LV_OBJ_FLAG_HIDDEN);lv_obj_move_foreground(overlay);key_group(group);lv_group_focus_obj(ssid);rendered_revision=UINT32_MAX;ac_wifi_panel_update(&current);scan(NULL);}
bool ac_wifi_panel_scroll_at(int x,int y,int delta){if(!ac_wifi_panel_visible())return false;lv_area_t area;lv_obj_get_coords(networks,&area);if(x>=area.x1&&x<=area.x2&&y>=area.y1&&y<=area.y2)lv_obj_scroll_by(networks,0,delta,LV_ANIM_OFF);return true;}
void ac_wifi_panel_destroy(void){if(!overlay)return;ac_wifi_panel_close();lv_group_delete(group);group=NULL;overlay=NULL;scan_handler=NULL;join_handler=NULL;}
