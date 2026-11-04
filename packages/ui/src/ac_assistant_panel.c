#include "ac_ui_memory.h"
#include "ac_assistant_panel.h"
#include "ac_neon.h"
#include <stdio.h>
#include <string.h>

enum { MESSAGE_LIMIT=8 };
typedef struct {
    char id[96], time[40], text[4096], source[160];
    uint64_t hash;
    bool unread;
} cached_message_t;
typedef struct { char id[96]; uint64_t hash; bool unread; } message_revision_t;
typedef enum { CLOSED, MESSAGES, TOOLS } panel_kind_t;
static AC_UI_LARGE_BSS cached_message_t messages[MESSAGE_LIMIT];
static size_t message_count;
static ac_assistant_status_t status;
static bool mock_mode, rebuilding;
static panel_kind_t opened;
static lv_obj_t *compact, *compact_preview, *compact_status, *compact_time;
static lv_obj_t *overlay, *message_dialog, *tools_dialog, *body, *message_info, *latest_button, *latest_label;
static lv_obj_t *message_close, *tools_close, *tool_buttons[3];
static lv_obj_t *refresh_button;
static void (*request_refresh)(void);
static lv_group_t *screen_group, *modal_group;
static lv_obj_t *previous_focus;
static ac_tool_request_fn request_tool;
static ac_tool_id_t tool_ids[3]={AC_TOOL_WIFI,AC_TOOL_PELICAN,AC_TOOL_CONNECTIVITY};

static void hide(lv_obj_t *obj,bool hidden)
{
    if(hidden) lv_obj_add_flag(obj,LV_OBJ_FLAG_HIDDEN); else lv_obj_remove_flag(obj,LV_OBJ_FLAG_HIDDEN);
}
static void copy_text(char *out,size_t capacity,const char *text)
{
    if(!text) text="";
    size_t length=strlen(text);
    if(length>=capacity) {
        length=capacity-1;
        while(length && (((unsigned char)text[length]&0xc0)==0x80)) --length;
    }
    memcpy(out,text,length); out[length]=0;
}
static uint64_t hash_text(uint64_t value,const char *text)
{
    if(!text) return value;
    while(*text) {value^=(unsigned char)*text++;value*=UINT64_C(1099511628211);}
    return value;
}
static unsigned unread_count(void)
{
    unsigned count=0;for(size_t i=0;i<message_count;++i) if(messages[i].unread) ++count;return count;
}
static void keyboard_group(lv_group_t *group)
{
    for(lv_indev_t *input=lv_indev_get_next(NULL);input;input=lv_indev_get_next(input))
        if(lv_indev_get_type(input)==LV_INDEV_TYPE_KEYPAD || lv_indev_get_type(input)==LV_INDEV_TYPE_ENCODER) lv_indev_set_group(input,group);
}
static lv_obj_t *label(lv_obj_t *parent,int x,int y,const char *value,uint32_t color,int width,unsigned size)
{
    lv_obj_t *obj=ac_neon_text(parent,x,y,value,color);lv_obj_set_style_text_font(obj,ac_theme_font(size),0);
    lv_obj_set_width(obj,width);lv_label_set_long_mode(obj,LV_LABEL_LONG_DOT);return obj;
}
static void refresh_compact(void)
{
    if(refresh_button) {
        if(mock_mode||!request_refresh||status==AC_ASSISTANT_UNCONFIGURED||status==AC_ASSISTANT_UPDATING)lv_obj_add_state(refresh_button,LV_STATE_DISABLED);
        else lv_obj_remove_state(refresh_button,LV_STATE_DISABLED);
    }
    unsigned unread=unread_count();
    if(mock_mode) lv_label_set_text_fmt(compact_status,unread?"MOCK · %u 条未读":"MOCK · 演示消息",unread);
    else if(status==AC_ASSISTANT_UNCONFIGURED) lv_label_set_text(compact_status,"待接入");
    else if(status==AC_ASSISTANT_UPDATING) lv_label_set_text(compact_status,"正在整理");
    else if(status==AC_ASSISTANT_FAILED) lv_label_set_text(compact_status,"更新失败");
    else if(status==AC_ASSISTANT_OFFLINE) lv_label_set_text(compact_status,"消息已离线");
    else if(unread) lv_label_set_text_fmt(compact_status,"%u 条未读",unread);
    else lv_label_set_text(compact_status,"暂无未读");
    lv_obj_set_style_text_color(compact_status,ac_color(mock_mode?AC_NEON_YELLOW:unread?AC_NEON_GREEN:AC_NEON_MUTED),0);
    lv_obj_set_style_border_opa(compact,unread?LV_OPA_80:LV_OPA_50,0);
    const char *preview=message_count?messages[message_count-1].text:NULL;
    if(preview && strncmp(preview,"项目简报",strlen("项目简报"))==0) {
        const char *attention=strstr(preview,"\n\n需要关注\n\n"),*first=strstr(preview,"\n\n");
        if(attention)preview=attention+strlen("\n\n需要关注\n\n");else if(first)preview=first+2;
    }
    lv_label_set_text(compact_preview,preview?preview:
        status==AC_ASSISTANT_UNCONFIGURED?"接入模型后，这里显示最新消息；点击展开消息记录。":
        status==AC_ASSISTANT_FAILED?"暂时无法更新消息，保留已有记录。":
        status==AC_ASSISTANT_OFFLINE?"暂时无法连接助手，恢复连接后继续更新。":"项目简报、关注事项和助手回复会显示在这里。");
    lv_label_set_text(compact_time,message_count?messages[message_count-1].time:"");
    lv_label_set_text_fmt(message_info,"%s · 最近 %zu 条消息%s",mock_mode?"MOCK 演示":
        status==AC_ASSISTANT_UNCONFIGURED?"模型未接入":status==AC_ASSISTANT_UPDATING?"正在更新":
        status==AC_ASSISTANT_FAILED?"更新失败，保留记录":status==AC_ASSISTANT_OFFLINE?"离线记录":"AI 助手",message_count,unread?" · 有未读":"");
    lv_label_set_text_fmt(latest_label,unread?"查看最新 · %u":"查看最新",unread);
}
static void mark_read(void)
{
    for(size_t i=0;i<message_count;++i) messages[i].unread=false;
    refresh_compact();
}
static void render_messages(bool follow)
{
    int32_t scroll=lv_obj_get_scroll_y(body);
    rebuilding=true;lv_obj_clean(body);int y=12;
    if(!message_count) {
        label(body,20,24,status==AC_ASSISTANT_UNCONFIGURED?"AI 助手尚未接入模型":"暂时没有助手消息",AC_NEON_TEXT,910,20);
        lv_obj_t *note=label(body,20,70,"接入 API 后，这里会显示项目简报、关注事项和对话消息。\n点击底部消息条只打开记录，不会自动开始录音。",AC_NEON_MUTED,910,16);
        lv_label_set_long_mode(note,LV_LABEL_LONG_WRAP);lv_obj_set_style_text_line_space(note,8,0);
    }
    for(size_t i=0;i<message_count;++i) {
        const cached_message_t *m=&messages[i];
        lv_obj_t *card=ac_neon_box(body,12,y,940,72,AC_NEON_SURFACE);ac_neon_flat(card);
        label(card,12,6,m->source[0]?m->source:"AI 助手",AC_NEON_MUTED,710,13);
        label(card,796,6,m->time,AC_NEON_MUTED,130,13);
        lv_obj_t *content=label(card,12,30,m->text,AC_NEON_TEXT,912,16);
        lv_label_set_long_mode(content,LV_LABEL_LONG_WRAP);lv_obj_set_style_text_line_space(content,4,0);
        lv_obj_update_layout(content);int height=(int)lv_obj_get_height(content)+48;lv_obj_set_height(card,height);
        ac_neon_rule(card,12,height-1,912,AC_NEON_CYAN,LV_OPA_20);y+=height+8;
    }
    lv_obj_update_layout(body);
    lv_obj_scroll_to_y(body,follow?LV_COORD_MAX:scroll,LV_ANIM_OFF);rebuilding=false;
}
bool ac_assistant_panel_set_feed(const ac_assistant_feed_view_t *feed)
{
    if(!overlay || !feed || feed->mock!=mock_mode || (feed->message_count && !feed->messages) ||
       feed->status<AC_ASSISTANT_UNCONFIGURED || feed->status>AC_ASSISTANT_OFFLINE) return false;
    message_revision_t previous[MESSAGE_LIMIT];size_t previous_count=message_count;
    for(size_t i=0;i<previous_count;++i) {
        copy_text(previous[i].id,sizeof(previous[i].id),messages[i].id);
        previous[i].hash=messages[i].hash;previous[i].unread=messages[i].unread;
    }
    bool follow=opened==MESSAGES && lv_obj_get_scroll_bottom(body)<12;
    size_t start=feed->message_count>MESSAGE_LIMIT?feed->message_count-MESSAGE_LIMIT:0;
    bool changed=status!=feed->status || message_count!=feed->message_count-start;
    message_count=0;status=feed->status;
    for(size_t i=start;i<feed->message_count;++i) {
        const ac_assistant_message_view_t *input=&feed->messages[i];
        if(!input->id || !input->id[0] || strlen(input->id)>=sizeof(messages[0].id) || !input->text) continue;
        bool duplicate=false;for(size_t j=0;j<message_count;++j) if(strcmp(messages[j].id,input->id)==0) duplicate=true;
        if(duplicate) continue;
        cached_message_t *m=&messages[message_count++];
        copy_text(m->id,sizeof(m->id),input->id);copy_text(m->text,sizeof(m->text),input->text);
        if(strlen(input->text)>=sizeof(m->text)) {
            static const char suffix[]="\n…（长消息已截短）";
            copy_text(m->text,sizeof(m->text)-sizeof(suffix),input->text);strcat(m->text,suffix);
        }
        copy_text(m->source,sizeof(m->source),input->source);copy_text(m->time,sizeof(m->time),input->time);
        m->hash=hash_text(hash_text(hash_text(UINT64_C(14695981039346656037),m->text),m->source),m->time);
        m->unread=true;bool found=false;
        for(size_t j=0;j<previous_count;++j) if(strcmp(previous[j].id,m->id)==0 && previous[j].hash==m->hash) {
            m->unread=previous[j].unread;found=true;break;
        }
        if(!found || message_count>previous_count || strcmp(previous[message_count-1].id,m->id)!=0) changed=true;
        if(follow) m->unread=false;
    }
    if(previous_count!=message_count) changed=true;
    refresh_compact();
    if(changed && opened==MESSAGES) render_messages(follow);
    if(changed) {printf("UI assistant_feed count=%zu unread=%u source=%s\n",message_count,unread_count(),mock_mode?"mock":"live");fflush(stdout);}
    return true;
}
bool ac_assistant_panel_close(void)
{
    if(opened==CLOSED) return false;
    printf("UI %s=closed\n",opened==MESSAGES?"assistant_messages":"tools_drawer");fflush(stdout);
    opened=CLOSED;hide(overlay,true);keyboard_group(screen_group);
    if(previous_focus && lv_obj_is_valid(previous_focus)) lv_group_focus_obj(previous_focus);
    return true;
}
static void closed(lv_event_t *e) {(void)e;ac_assistant_panel_close();}
static void backdrop(lv_event_t *e) {if(lv_event_get_target_obj(e)==overlay) ac_assistant_panel_close();}
static void modal_key(lv_event_t *e) {if(lv_event_get_key(e)==LV_KEY_ESC) ac_assistant_panel_close();}
static void opened_panel(lv_event_t *e)
{
    panel_kind_t kind=(panel_kind_t)(uintptr_t)lv_event_get_user_data(e);
    previous_focus=screen_group?lv_group_get_focused(screen_group):NULL;opened=kind;
    hide(message_dialog,kind!=MESSAGES);hide(tools_dialog,kind!=TOOLS);hide(overlay,false);lv_obj_move_foreground(overlay);
    keyboard_group(modal_group);lv_group_focus_obj(kind==MESSAGES?message_close:tool_buttons[0]);
    if(kind==MESSAGES) {render_messages(true);mark_read();}
    ac_neon_reveal(kind==MESSAGES?message_dialog:tools_dialog,1,0);
    printf("UI %s=opened\n",kind==MESSAGES?"assistant_messages":"tools_drawer");fflush(stdout);
}
static void latest(lv_event_t *e)
{
    (void)e;lv_obj_scroll_to_y(body,LV_COORD_MAX,LV_ANIM_OFF);mark_read();
}
static void refresh_requested(lv_event_t *e) {(void)e;if(request_refresh)request_refresh();}
void ac_assistant_panel_refresh_handler(void (*handler)(void)) {request_refresh=handler;refresh_compact();}
static void body_scrolled(lv_event_t *e)
{
    (void)e;if(!rebuilding && opened==MESSAGES && unread_count() && lv_obj_get_scroll_bottom(body)<12) mark_read();
}
static void tool_clicked(lv_event_t *e)
{
    ac_tool_id_t tool=*(ac_tool_id_t *)lv_event_get_user_data(e);
    ac_assistant_panel_close();if(request_tool) request_tool(tool);
}
static void icon_draw(lv_event_t *e)
{
    bool tool=(uintptr_t)lv_event_get_user_data(e)!=0;
    lv_area_t bounds;lv_obj_get_coords(lv_event_get_current_target_obj(e),&bounds);
    lv_draw_line_dsc_t line;lv_draw_line_dsc_init(&line);line.color=ac_color(AC_NEON_CYAN);line.width=2;line.opa=255;line.round_start=true;line.round_end=true;
    static const lv_point_t wrench[]={{18,2},{14,3},{11,7},{12,12},{3,21},{3,25},{7,25},{17,15},{21,16},{25,13},{26,8},{22,12},{18,8},{18,2}};
    static const lv_point_t star[]={{14,0},{18,10},{28,14},{18,18},{14,28},{10,18},{0,14},{10,10},{14,0}};
    const lv_point_t *points=tool?wrench:star;size_t count=tool?sizeof(wrench)/sizeof(wrench[0]):sizeof(star)/sizeof(star[0]);
    int x=bounds.x1+(tool?21:20),y=bounds.y1+(tool?9:23);
    for(size_t i=0;i+1<count;++i) {
        line.p1=(lv_point_precise_t){x+points[i].x,y+points[i].y};line.p2=(lv_point_precise_t){x+points[i+1].x,y+points[i+1].y};lv_draw_line(lv_event_get_layer(e),&line);
    }
}
static lv_obj_t *button(lv_obj_t *parent,int x,int y,int w,int h,uint32_t accent)
{
    lv_obj_t *obj=ac_neon_box(parent,x,y,w,h,AC_NEON_SURFACE);lv_obj_add_flag(obj,LV_OBJ_FLAG_CLICKABLE);
    ac_neon_interactive(obj,accent);return obj;
}
void ac_assistant_panel_create(lv_obj_t *screen,bool mock,ac_tool_request_fn tool_request)
{
    mock_mode=mock;request_tool=tool_request;opened=CLOSED;message_count=0;status=AC_ASSISTANT_UNCONFIGURED;previous_focus=NULL;rebuilding=false;
    screen_group=lv_group_get_default();modal_group=lv_group_create();lv_group_set_wrap(modal_group,true);
    compact=button(screen,12,514,916,74,AC_NEON_CYAN);
    lv_obj_add_event_cb(compact,opened_panel,LV_EVENT_CLICKED,(void *)(uintptr_t)MESSAGES);lv_obj_add_event_cb(compact,icon_draw,LV_EVENT_DRAW_MAIN_END,NULL);
    label(compact,66,11,"AI 助手",AC_NEON_CYAN,82,16);
    compact_status=label(compact,158,14,"",AC_NEON_MUTED,252,13);
    compact_time=label(compact,746,14,"",AC_NEON_MUTED,120,13);
    compact_preview=label(compact,66,40,"",AC_NEON_TEXT,800,16);lv_obj_set_height(compact_preview,20);
    label(compact,884,27,"›",AC_NEON_CYAN,20,20);
    lv_obj_t *tool=button(screen,940,514,72,74,AC_NEON_CYAN);lv_obj_add_event_cb(tool,icon_draw,LV_EVENT_DRAW_MAIN_END,(void *)(uintptr_t)1);
    lv_obj_add_event_cb(tool,opened_panel,LV_EVENT_CLICKED,(void *)(uintptr_t)TOOLS);
    label(tool,22,47,"工具",AC_NEON_MUTED,40,13);
    overlay=lv_obj_create(screen);lv_obj_remove_style_all(overlay);lv_obj_set_size(overlay,1024,600);
    lv_obj_set_style_bg_color(overlay,lv_color_hex(0x000000),0);lv_obj_set_style_bg_opa(overlay,LV_OPA_50,0);
    lv_obj_remove_flag(overlay,LV_OBJ_FLAG_SCROLLABLE);lv_obj_add_flag(overlay,LV_OBJ_FLAG_CLICKABLE);lv_obj_add_event_cb(overlay,backdrop,LV_EVENT_CLICKED,NULL);
    message_dialog=ac_neon_box(overlay,12,172,1000,416,AC_NEON_SURFACE);lv_obj_add_flag(message_dialog,LV_OBJ_FLAG_CLICKABLE);
    label(message_dialog,22,16,"AI 助手 / 消息",AC_NEON_CYAN,600,20);
    message_info=label(message_dialog,22,48,"",AC_NEON_MUTED,900,13);
    message_close=button(message_dialog,942,14,36,32,AC_NEON_CYAN);label(message_close,10,4,"×",AC_NEON_TEXT,24,16);lv_obj_add_event_cb(message_close,closed,LV_EVENT_CLICKED,NULL);
    body=ac_neon_box(message_dialog,12,78,976,258,AC_NEON_BG);ac_neon_flat(body);
    lv_obj_add_flag(body,LV_OBJ_FLAG_SCROLLABLE|LV_OBJ_FLAG_CLICKABLE);lv_obj_set_scroll_dir(body,LV_DIR_VER);lv_obj_set_scrollbar_mode(body,LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_width(body,3,LV_PART_SCROLLBAR);lv_obj_set_style_bg_color(body,ac_color(AC_NEON_MUTED),LV_PART_SCROLLBAR);lv_obj_set_style_bg_opa(body,LV_OPA_50,LV_PART_SCROLLBAR);
    lv_obj_add_event_cb(body,body_scrolled,LV_EVENT_SCROLL,NULL);
    ac_neon_rule(message_dialog,22,346,956,AC_NEON_CYAN,LV_OPA_30);
    label(message_dialog,22,366,"语音功能待接入",AC_NEON_MUTED,550,13);
    refresh_button=button(message_dialog,650,356,162,40,AC_NEON_CYAN);label(refresh_button,14,10,"更新简报",AC_NEON_CYAN,134,13);lv_obj_add_event_cb(refresh_button,refresh_requested,LV_EVENT_CLICKED,NULL);
    lv_obj_set_style_opa(refresh_button,LV_OPA_40,LV_STATE_DISABLED);
    latest_button=button(message_dialog,824,356,154,40,AC_NEON_CYAN);latest_label=label(latest_button,12,10,"查看最新",AC_NEON_CYAN,134,13);lv_obj_add_event_cb(latest_button,latest,LV_EVENT_CLICKED,NULL);
    tools_dialog=ac_neon_box(overlay,676,236,336,266,AC_NEON_SURFACE);lv_obj_add_flag(tools_dialog,LV_OBJ_FLAG_CLICKABLE);
    label(tools_dialog,18,14,"工具",AC_NEON_CYAN,250,20);
    tools_close=button(tools_dialog,286,10,32,32,AC_NEON_CYAN);label(tools_close,9,4,"×",AC_NEON_TEXT,24,16);lv_obj_add_event_cb(tools_close,closed,LV_EVENT_CLICKED,NULL);
    const char *titles[]={"Wi-Fi 网络","鹈鹕测试","连通性检测"};
    for(int i=0;i<3;++i) {
        tool_buttons[i]=button(tools_dialog,14,58+62*i,308,54,i?AC_NEON_CYAN:AC_NEON_MAGENTA);
        label(tool_buttons[i],14,7,titles[i],AC_NEON_TEXT,190,16);label(tool_buttons[i],14,31,i?"服务待接入":"在屏幕上联网，无需连接 Mac",AC_NEON_MUTED,280,13);
        label(tool_buttons[i],278,16,"›",AC_NEON_MUTED,20,16);lv_obj_add_event_cb(tool_buttons[i],tool_clicked,LV_EVENT_CLICKED,&tool_ids[i]);
    }
    lv_obj_t *modal_controls[]={message_close,latest_button,refresh_button,tools_close,tool_buttons[0],tool_buttons[1],tool_buttons[2]};
    for(size_t i=0;i<sizeof(modal_controls)/sizeof(modal_controls[0]);++i) {lv_group_add_obj(modal_group,modal_controls[i]);lv_obj_add_event_cb(modal_controls[i],modal_key,LV_EVENT_KEY,NULL);}
    hide(message_dialog,true);hide(tools_dialog,true);hide(overlay,true);refresh_compact();
}
bool ac_assistant_panel_scroll_at(int x,int y,int delta)
{
    if(opened==CLOSED) return false;
    if(opened==MESSAGES) {
        lv_area_t bounds;lv_obj_get_coords(body,&bounds);
        if(x>=bounds.x1 && x<=bounds.x2 && y>=bounds.y1 && y<=bounds.y2) lv_obj_scroll_by(body,0,delta,LV_ANIM_ON);
    }
    return true;
}
void ac_assistant_panel_destroy(void)
{
    ac_assistant_panel_close();lv_group_delete(modal_group);modal_group=NULL;overlay=NULL;refresh_button=NULL;request_refresh=NULL;
}
