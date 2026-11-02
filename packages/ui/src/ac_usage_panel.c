#include "ac_usage_panel.h"
#include "ac_neon.h"
#include <stdio.h>
#include <string.h>

static const uint32_t colors[3]={0x00ffff,0xff00ff,0x009dff};
static const char *names[4]={"总体","CODEX","CLAUDE","DEEPSEEK"};
static lv_obj_t *root,*tabs[4],*ranges[2],*summary,*subtitle,*day_detail,*footnote,*empty;
static lv_obj_t *bars[AC_USAGE_DAYS],*segments[AC_USAGE_DAYS][3],*dates[AC_USAGE_DAYS],*axis[3];
static int filters[4]={-1,0,1,2},periods[2]={7,30},indices[AC_USAGE_DAYS];
static int filter=-1,selected_day=-1;
static unsigned period=7;
static ac_usage_stats_t current;
static void (*close_callback)(void);
static bool animate_bars;

static lv_obj_t *box(lv_obj_t *parent,int x,int y,int w,int h,uint32_t color)
{
    return ac_neon_box(parent,x,y,w,h,color);
}
static lv_obj_t *text(lv_obj_t *parent,int x,int y,const char *s,uint32_t color)
{
    return ac_neon_text(parent,x,y,s,color);
}
static void hide(lv_obj_t *o,bool hidden) { if(hidden) lv_obj_add_flag(o,LV_OBJ_FLAG_HIDDEN); else lv_obj_remove_flag(o,LV_OBJ_FLAG_HIDDEN); }
static void compact(char *out,size_t n,double value)
{
    if(value>=1e9) snprintf(out,n,"%.2fB",value/1e9);
    else if(value>=1e6) snprintf(out,n,"%.1fM",value/1e6);
    else if(value>=1e3) snprintf(out,n,"%.1fk",value/1e3);
    else snprintf(out,n,"%.0f",value);
}
static double day_total(size_t index)
{
    double total=0;
    for(int a=0;a<3;++a) if((filter<0 || filter==a) && current.days[index].tokens[a].available) total+=current.days[index].tokens[a].value;
    return total;
}
static void render(void)
{
    ac_metric_t total=ac_usage_total(&current,filter,period); char amount[32]; compact(amount,sizeof(amount),total.value);
    lv_label_set_text_fmt(summary,"近 %u 天  /  %s  /  %s%s TOKENS",period,names[filter+1],total.available?amount:"—",total.available && total.estimated?" *":"");
    int available=0; for(int a=0;a<3;++a) if(current.available[a]) ++available;
    if(current.loading) lv_label_set_text(subtitle,"正在导入历史记录，已有汇总会持续更新…");
    else if(!total.available) lv_label_set_text(subtitle,"该来源没有可读取的用量记录");
    else if(filter<0) lv_label_set_text_fmt(subtitle,"可用来源 %d/3   ·   输入（含缓存）+ 输出   ·   含今天",available);
    else lv_label_set_text(subtitle,"按请求发生日期汇总   ·   输入（含缓存）+ 输出   ·   含今天");
    for(int i=0;i<4;++i) {
        bool active=filters[i]==filter; lv_obj_set_style_bg_color(tabs[i],ac_color(active?0x00343e:0x0c1019),0);
        lv_obj_set_style_border_color(tabs[i],ac_color(active?(i?colors[i-1]:0x00ffff):0x006877),0);
        lv_obj_set_style_border_opa(tabs[i],active?LV_OPA_COVER:LV_OPA_40,0);
    }
    for(int i=0;i<2;++i) lv_obj_set_style_border_color(ranges[i],ac_color((unsigned)periods[i]==period?0x00ffff:0x006877),0);
    size_t count=current.day_count<period?current.day_count:period,start=current.day_count-count;
    double peak=0; for(size_t i=start;i<current.day_count;++i) { double value=day_total(i); if(value>peak) peak=value; }
    double scale=peak>0?peak:1;
    for(int i=0;i<3;++i) {
        char number[24]; double value=peak*(2-i)/2;
        if(value>=1e9) snprintf(number,sizeof(number),"%.1fB",value/1e9);
        else if(value>=1e6) snprintf(number,sizeof(number),"%.0fM",value/1e6);
        else if(value>=1e3) snprintf(number,sizeof(number),"%.0fk",value/1e3);
        else snprintf(number,sizeof(number),"%.0f",value);
        lv_label_set_text(axis[i],number);
    }
    for(size_t i=0;i<AC_USAGE_DAYS;++i) {
        bool visible=i>=start && i<current.day_count; hide(bars[i],!visible); hide(dates[i],true); if(!visible) continue;
        int slot=610/(int)count,x=52+(int)(i-start)*slot,width=slot-(count>7?5:18);
        if(width<4) width=4;
        lv_obj_set_pos(bars[i],x,183); lv_obj_set_size(bars[i],width,168);
        lv_obj_set_style_border_width(bars[i],(int)i==selected_day?1:0,0);
        lv_obj_set_style_border_color(bars[i],ac_color(0xb8faff),0);
        int bottom=166;
        for(int a=0;a<3;++a) {
            ac_metric_t v=current.days[i].tokens[a]; bool show=(filter<0 || filter==a) && v.available && v.value>0;
            int height=show?(int)(v.value/scale*158+0.5):0; if(show && height<1) height=1;
            if(height>bottom) height=bottom;
            hide(segments[i][a],!show || height<=0);
            if(show && height>0) { bottom-=height; lv_obj_set_x(segments[i][a],1); lv_obj_set_width(segments[i][a],width-2); ac_neon_bar_to(segments[i][a],bottom+height,height,animate_bars); }
        }
        bool label=count<=7 || (i-start)%5==0 || i==current.day_count-1;
        hide(dates[i],!label);
        lv_label_set_text(dates[i],current.days[i].date+5); lv_obj_set_pos(dates[i],x+(count<=7?width/2-20:-10),357);
    }
    hide(empty,total.available && (peak>0 || !current.loading));
    if(!total.available) lv_label_set_text(empty,current.loading?"正在读取历史用量…":filter==1?"等待 Claude Code 用量记录":"暂无可读取的用量记录");
    else if(current.loading && peak==0) lv_label_set_text(empty,"正在读取历史用量…");
    if(selected_day>=0 && (size_t)selected_day>=start && (size_t)selected_day<current.day_count && total.available) {
        const ac_usage_day_t *day=&current.days[selected_day]; double value=day_total((size_t)selected_day);
        char one[24],two[24],three[24];
        for(int a=0;a<3;++a) {
            char *dest=a==0?one:a==1?two:three;
            if(day->tokens[a].available) compact(dest,24,day->tokens[a].value); else snprintf(dest,24,"—");
        }
        if(filter<0) lv_label_set_text_fmt(day_detail,"%s   Codex %s  ·  Claude %s  ·  DeepSeek %s",day->date,one,two,three);
        else lv_label_set_text_fmt(day_detail,"%s   %s：%.0f TOKENS",day->date,names[filter+1],value);
    } else lv_label_set_text(day_detail,"点击柱形查看当日消耗；柱高按当前筛选自动缩放。");
    const char *zone=strcmp(current.timezone,"Asia/Shanghai")==0?"北京时间":current.timezone;
    lv_label_set_text_fmt(footnote,"本机记录 · %s%s%s",zone,total.estimated?" · * 部分来源或历史缺失":"",current.failed?" · 汇总暂未更新":"");
    animate_bars=false;
}
static void tab_clicked(lv_event_t *e)
{
    filter=*(int *)lv_event_get_user_data(e); selected_day=-1; animate_bars=true; render(); ac_neon_reveal(summary,1,0);
    printf("UI usage_filter=%s\n",names[filter+1]); fflush(stdout);
}
static void range_clicked(lv_event_t *e)
{
    period=(unsigned)*(int *)lv_event_get_user_data(e); selected_day=-1; animate_bars=true; render(); ac_neon_reveal(summary,1,0);
    printf("UI usage_period=%u\n",period); fflush(stdout);
}
static void day_clicked(lv_event_t *e)
{
    selected_day=*(int *)lv_event_get_user_data(e); render();
    printf("UI usage_day=%s\n",current.days[selected_day].date); fflush(stdout);
}
static void back_clicked(lv_event_t *e) { (void)e; if(close_callback) close_callback(); }
void ac_usage_panel_create(lv_obj_t *parent,void (*on_close)(void))
{
    close_callback=on_close; root=box(parent,324,60,688,442,0x0c1019); lv_obj_add_flag(root,LV_OBJ_FLAG_CLICKABLE);
    ac_neon_scanlines(root);
    lv_obj_t *title=text(root,16,14,"TOKEN // USAGE",0x00ffff); lv_obj_set_style_text_font(title,ac_theme_font(20),0); lv_obj_set_style_text_letter_space(title,ac_theme_tracking(),0);
    for(int i=0;i<2;++i) { ranges[i]=box(root,364+i*105,9,94,32,0x0c1019); lv_obj_add_flag(ranges[i],LV_OBJ_FLAG_CLICKABLE); ac_neon_interactive(ranges[i],AC_NEON_CYAN); text(ranges[i],15,5,i?"近 30 天":"近 7 天",0xb8faff); lv_obj_add_event_cb(ranges[i],range_clicked,LV_EVENT_CLICKED,&periods[i]); }
    lv_obj_t *back=box(root,594,9,78,32,0x002832); text(back,9,5,"‹ 返回",0x00ffff); lv_obj_add_flag(back,LV_OBJ_FLAG_CLICKABLE); lv_obj_add_event_cb(back,back_clicked,LV_EVENT_CLICKED,NULL);
    ac_neon_interactive(back,AC_NEON_CYAN);
    for(int i=0;i<4;++i) {
        tabs[i]=box(root,16+i*166,52,158,32,0x0c1019); lv_obj_add_flag(tabs[i],LV_OBJ_FLAG_CLICKABLE);
        ac_neon_interactive(tabs[i],i?colors[i-1]:AC_NEON_CYAN);
        text(tabs[i],i?43:58,5,names[i],i?colors[i-1]:0xe9ffff); lv_obj_add_event_cb(tabs[i],tab_clicked,LV_EVENT_CLICKED,&filters[i]);
    }
    lv_obj_t *card=box(root,16,98,656,67,0x0c1019); summary=text(card,14,8,"",0xe9ffff); subtitle=text(card,14,37,"",0x70d6e2);
    ac_neon_flat(card); lv_obj_set_style_text_font(subtitle,ac_theme_font(13),0); ac_neon_rule(root,16,165,656,AC_NEON_CYAN,LV_OPA_30);
    for(int i=0;i<3;++i) { lv_obj_t *line=box(root,52,187+i*81,610,1,0x006877); lv_obj_set_style_border_width(line,0,0); axis[i]=text(root,4,177+i*81,"",0x70d6e2); lv_obj_set_width(axis[i],44); lv_obj_set_style_text_align(axis[i],LV_TEXT_ALIGN_RIGHT,0); }
    for(int i=0;i<AC_USAGE_DAYS;++i) {
        indices[i]=i; bars[i]=box(root,52,183,18,168,0x0c1019); lv_obj_set_style_bg_opa(bars[i],LV_OPA_TRANSP,0); lv_obj_set_style_border_width(bars[i],0,0);
        lv_obj_add_flag(bars[i],LV_OBJ_FLAG_CLICKABLE); lv_obj_add_event_cb(bars[i],day_clicked,LV_EVENT_CLICKED,&indices[i]);
        for(int a=0;a<3;++a) { segments[i][a]=box(bars[i],0,0,16,1,colors[a]); lv_obj_set_style_border_width(segments[i][a],0,0); lv_obj_set_style_radius(segments[i][a],2,0); }
        dates[i]=text(root,52,357,"",0x70d6e2);
    }
    empty=text(root,164,242,"",0xb8faff);
    day_detail=text(root,16,389,"",0xb8faff); lv_obj_set_width(day_detail,656); lv_label_set_long_mode(day_detail,LV_LABEL_LONG_DOT); lv_obj_set_height(day_detail,20);
    lv_obj_set_style_text_font(day_detail,ac_theme_font(13),0);
    footnote=text(root,16,416,"",0x70d6e2); lv_obj_set_width(footnote,656); lv_label_set_long_mode(footnote,LV_LABEL_LONG_DOT); lv_obj_set_height(footnote,20);
    lv_obj_set_style_text_font(footnote,ac_theme_font(13),0);
    hide(root,true);
}
void ac_usage_panel_open(const ac_usage_stats_t *stats,unsigned days) { current=*stats; period=days==30?30:7; filter=-1; selected_day=-1; animate_bars=true; render(); hide(root,false); lv_obj_move_foreground(root); ac_neon_reveal(root,1,0); }
void ac_usage_panel_update(const ac_usage_stats_t *stats) { current=*stats; render(); }
void ac_usage_panel_filter(int agent) { if(agent>=-1 && agent<3) { filter=agent; selected_day=-1; animate_bars=true; render(); ac_neon_reveal(summary,1,0); } }
void ac_usage_panel_hide(void) { hide(root,true); }
