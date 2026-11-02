#define SDL_MAIN_HANDLED
#include <SDL.h>
#include "lvgl.h"
#include "ac_bootstrap_screen.h"
#include "ac_gateway_client.h"
#include "ac_neon.h"
#include "ac_assistant_panel.h"
#include "ac_window_theme.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { WIDTH = 1024, HEIGHT = 600 };
static uint16_t framebuffer[WIDTH * HEIGHT];
static uint16_t draw_buffer[WIDTH * 60];
static SDL_Renderer *renderer;
static SDL_Texture *texture;
static lv_area_t dirty_area;
static bool texture_dirty;
static int mouse_x, mouse_y;
static bool mouse_pressed;
static uint32_t keyboard_key;
static bool keyboard_pressed;
static ac_gateway_result_t gateway_update;
static uint64_t presented,previous_present,first_present,performance_frequency;
static double present_intervals[20000];
static size_t interval_count;

static bool capture_frame(const char *path)
{
    SDL_Surface *surface=SDL_CreateRGBSurfaceWithFormatFrom(framebuffer,WIDTH,HEIGHT,16,WIDTH*2,SDL_PIXELFORMAT_RGB565);
    bool ok=surface && SDL_SaveBMP(surface,path)==0;
    SDL_FreeSurface(surface); return ok;
}

static void flush(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    size_t width = (size_t)(area->x2 - area->x1 + 1);
    for(int y = area->y1; y <= area->y2; ++y) {
        size_t offset = (size_t)(y - area->y1) * width;
        memcpy(&framebuffer[y * WIDTH + area->x1], pixels + offset * 2, width * 2);
    }
    // LVGL flushes a frame in strips. Upload their union once, so Metal does
    // not allocate a staging texture/command buffer for every strip.
    if(!texture_dirty) { dirty_area=*area; texture_dirty=true; }
    else {
        if(area->x1<dirty_area.x1) dirty_area.x1=area->x1;
        if(area->y1<dirty_area.y1) dirty_area.y1=area->y1;
        if(area->x2>dirty_area.x2) dirty_area.x2=area->x2;
        if(area->y2>dirty_area.y2) dirty_area.y2=area->y2;
    }
    if(lv_display_flush_is_last(display)) {
        SDL_Rect dirty={dirty_area.x1,dirty_area.y1,dirty_area.x2-dirty_area.x1+1,dirty_area.y2-dirty_area.y1+1};
        SDL_UpdateTexture(texture,&dirty,framebuffer+dirty_area.y1*WIDTH+dirty_area.x1,WIDTH*2);
        texture_dirty=false;
        SDL_RenderClear(renderer);
        SDL_RenderCopy(renderer, texture, NULL, NULL);
        SDL_RenderPresent(renderer);
        uint64_t at=SDL_GetPerformanceCounter();
        if(previous_present && interval_count<20000) present_intervals[interval_count++]=(double)(at-previous_present)*1000.0/(double)performance_frequency;
        if(!first_present) first_present=at;
        previous_present=at; ++presented;
    }
    lv_display_flush_ready(display);
}

static void read_mouse(lv_indev_t *input, lv_indev_data_t *data)
{
    (void)input;
    data->point.x = mouse_x;
    data->point.y = mouse_y;
    data->state = mouse_pressed ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}
static void read_keyboard(lv_indev_t *input,lv_indev_data_t *data)
{
    (void)input; data->key=keyboard_key; data->state=keyboard_pressed?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;
}

int main(int argc, char **argv)
{
    int max_frames = 0;
    bool smoke_input = false;
    bool use_assets = true;
    int smoke_agent = 1;
    bool mock = false, smoke_detail = false, smoke_actions = false, smoke_scroll = false, reduced_motion = false;
    int smoke_usage=0,smoke_usage_filter=-1;
    bool smoke_usage_switch=false,smoke_usage_back=false;
    bool smoke_keyboard=false, smoke_parallax=false, smoke_theme=false, smoke_theme_dismiss=false, smoke_theme_open=false;
    bool smoke_assistant=false, smoke_tools=false, smoke_assistant_update=false, smoke_assistant_scroll=false, smoke_assistant_escape=false;
    bool smoke_assistant_long=false;
    const char *forced_theme=NULL;
    uint64_t settings_revision=UINT64_MAX;
    const char *capture = NULL;
    const char *capture_prefix = NULL;
    const char *performance_path=NULL;
    const char *gateway = "http://127.0.0.1:8736";
    const char *token_path = ".runtime/gateway.token";
    int capture_every = 10;
    for(int i = 1; i < argc; ++i) {
        if(strcmp(argv[i], "--frames") == 0 && i + 1 < argc) max_frames = atoi(argv[++i]);
        else if(strcmp(argv[i], "--capture") == 0 && i + 1 < argc) capture = argv[++i];
        else if(strcmp(argv[i], "--perf-report") == 0 && i+1<argc) performance_path=argv[++i];
        else if(strcmp(argv[i], "--smoke-input") == 0) smoke_input = true;
        else if(strcmp(argv[i], "--placeholders") == 0) use_assets = false;
        else if(strcmp(argv[i], "--mock") == 0) mock = true;
        else if(strcmp(argv[i], "--smoke-detail") == 0) smoke_detail = true;
        else if(strcmp(argv[i], "--smoke-actions") == 0) smoke_actions = true;
        else if(strcmp(argv[i], "--smoke-assistant") == 0) smoke_assistant=true;
        else if(strcmp(argv[i], "--smoke-tools") == 0) smoke_tools=true;
        else if(strcmp(argv[i], "--smoke-assistant-update") == 0) smoke_assistant_update=true;
        else if(strcmp(argv[i], "--smoke-assistant-scroll") == 0) {smoke_assistant_scroll=true;smoke_assistant=true;}
        else if(strcmp(argv[i], "--smoke-assistant-escape") == 0) {smoke_assistant_escape=true;smoke_assistant=true;}
        else if(strcmp(argv[i], "--smoke-assistant-long") == 0) {smoke_assistant_long=true;smoke_assistant=true;}
        else if(strcmp(argv[i], "--smoke-scroll") == 0) smoke_scroll = true;
        else if(strcmp(argv[i], "--smoke-usage") == 0 && i+1<argc) { smoke_usage=atoi(argv[++i]); if(smoke_usage!=7 && smoke_usage!=30) return 2; }
        else if(strcmp(argv[i], "--smoke-usage-filter") == 0 && i+1<argc) {
            const char *agent=argv[++i];
            if(strcmp(agent,"codex")==0) smoke_usage_filter=0;
            else if(strcmp(agent,"claude")==0) smoke_usage_filter=1;
            else if(strcmp(agent,"deepseek")==0) smoke_usage_filter=2;
            else if(strcmp(agent,"all")!=0) return 2;
        }
        else if(strcmp(argv[i], "--smoke-usage-switch") == 0) smoke_usage_switch=true;
        else if(strcmp(argv[i], "--smoke-usage-back") == 0) smoke_usage_back=true;
        else if(strcmp(argv[i], "--smoke-keyboard") == 0) smoke_keyboard=true;
        else if(strcmp(argv[i], "--smoke-parallax") == 0) smoke_parallax=true;
        else if(strcmp(argv[i], "--smoke-theme") == 0) smoke_theme=true;
        else if(strcmp(argv[i], "--smoke-theme-dismiss") == 0) smoke_theme_dismiss=true;
        else if(strcmp(argv[i], "--smoke-theme-open") == 0) smoke_theme_open=true;
        else if(strcmp(argv[i], "--theme") == 0 && i+1<argc) {forced_theme=argv[++i];ac_theme_id_t id;if(!ac_theme_parse(forced_theme,&id)) return 2;}
        else if(strcmp(argv[i], "--reduced-motion") == 0) reduced_motion = true;
        else if(strcmp(argv[i], "--smoke-agent") == 0 && i+1<argc) {
            const char *agent=argv[++i]; smoke_input=true;
            if(strcmp(agent,"codex")==0) smoke_agent=0;
            else if(strcmp(agent,"claude")==0) smoke_agent=1;
            else if(strcmp(agent,"deepseek")==0) smoke_agent=2;
            else return 2;
        }
        else if(strcmp(argv[i], "--gateway") == 0 && i+1<argc) gateway=argv[++i];
        else if(strcmp(argv[i], "--token-file") == 0 && i+1<argc) token_path=argv[++i];
        else if(strcmp(argv[i], "--capture-prefix") == 0 && i+1<argc) capture_prefix=argv[++i];
        else if(strcmp(argv[i], "--capture-every") == 0 && i+1<argc) capture_every=atoi(argv[++i]);
        else { fprintf(stderr, "Usage: %s [--mock] [--gateway URL] [--frames N] [--capture output.bmp] [--capture-prefix PATH]\n", argv[0]); return 2; }
    }
    SDL_SetMainReady();
    if(SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0) {
        fprintf(stderr, "SDL_Init: %s\n", SDL_GetError()); return 1;
    }
    SDL_Window *window = SDL_CreateWindow(mock ? "Agent Companion / MOCK" : "Agent Companion / LIVE",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, WIDTH, HEIGHT, SDL_WINDOW_SHOWN);
    if(window == NULL) { fprintf(stderr, "SDL window: %s\n", SDL_GetError()); SDL_Quit(); return 1; }
    ac_window_theme(window, !forced_theme || strcmp(forced_theme,"neon")==0);
    renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED);
    if(!renderer) renderer=SDL_CreateRenderer(window,-1,SDL_RENDERER_SOFTWARE);
    if(renderer == NULL) { fprintf(stderr, "SDL renderer: %s\n", SDL_GetError()); SDL_DestroyWindow(window); SDL_Quit(); return 1; }
    texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGB565, SDL_TEXTUREACCESS_STREAMING, WIDTH, HEIGHT);
    if(texture == NULL) { fprintf(stderr, "SDL texture: %s\n", SDL_GetError()); SDL_DestroyRenderer(renderer); SDL_DestroyWindow(window); SDL_Quit(); return 1; }
    performance_frequency=SDL_GetPerformanceFrequency();

    lv_init();
    lv_tick_set_cb(SDL_GetTicks);
    lv_display_t *display = lv_display_create(WIDTH, HEIGHT);
    /* The SDL loop already caps redraws at 60Hz. Leave room for timer jitter so
     * a slightly early frame does not miss a 16ms refresh and wait another tick. */
    lv_timer_set_period(lv_display_get_refr_timer(display),12);
    lv_display_set_color_format(display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(display, draw_buffer, NULL, sizeof(draw_buffer), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(display, flush);
    lv_indev_t *input = lv_indev_create();
    lv_indev_set_type(input, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(input, read_mouse);
    lv_group_t *group=lv_group_create(); lv_group_set_default(group); lv_indev_set_group(input,group);
    lv_indev_t *keyboard=lv_indev_create(); lv_indev_set_type(keyboard,LV_INDEV_TYPE_KEYPAD); lv_indev_set_read_cb(keyboard,read_keyboard); lv_indev_set_group(keyboard,group);
    ac_neon_animations(!reduced_motion);
    if(forced_theme) {ac_theme_id_t id;ac_theme_parse(forced_theme,&id);ac_theme_apply(lv_screen_active(),id);}
    if(forced_theme) ac_window_theme(window,ac_theme_dark());
    ac_bootstrap_screen_create(use_assets,mock,ac_gateway_client_request_detail);
    if(!mock)ac_assistant_panel_refresh_handler(ac_gateway_client_request_assistant_refresh);
    ac_bootstrap_screen_theme_handler(forced_theme?NULL:ac_gateway_client_request_theme);
    ac_bootstrap_screen_set_animations(!reduced_motion);
    if(!ac_gateway_client_start(gateway,token_path,mock)) { fprintf(stderr,"Cannot start local gateway client\n"); return 1; }
    bool running = true;
    int frames = 0;
    uint64_t loop_started=SDL_GetPerformanceCounter(),deadline=loop_started;
    while(running && (max_frames == 0 || frames < max_frames)) {
        if((smoke_theme_open && (frames==90 || frames==94)) || (smoke_theme_dismiss && (frames==90 || frames==94 || frames==130 || frames==134 || frames==180 || frames==184 || frames==220 || frames==224 || frames==270 || frames==274 || frames==360 || frames==364 || frames==400 || frames==404))) {
            int phase=frames%90;bool close=phase>=40;bool down=phase==0 || phase==40;SDL_Event click={0};click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
            click.button.button=SDL_BUTTON_LEFT;click.button.state=down?SDL_PRESSED:SDL_RELEASED;
            click.button.x=!close?982:frames<180?824:frames<270?150:286;click.button.y=!close?30:frames<180?172:frames<270?280:350;SDL_PushEvent(&click);
        }
        if(smoke_theme_dismiss && (frames==310 || frames==314)) {SDL_Event key={0};key.type=frames==310?SDL_KEYDOWN:SDL_KEYUP;key.key.keysym.sym=SDLK_ESCAPE;SDL_PushEvent(&key);}
        if(smoke_theme && (frames==90 || frames==94 || frames==130 || frames==134 || frames==180 || frames==184 || frames==220 || frames==224 || frames==270 || frames==274 || frames==310 || frames==314)) {
            int phase=frames%90;bool choose=phase>=40;SDL_Event click={0};bool down=phase==0 || phase==40;click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
            click.button.button=SDL_BUTTON_LEFT;click.button.state=down?SDL_PRESSED:SDL_RELEASED;
            click.button.x=choose?286+224*((frames/90)%AC_THEME_COUNT):982;click.button.y=choose?350:30;SDL_PushEvent(&click);
        }
        if(smoke_parallax && (frames==32 || frames==64 || frames==96)) {
            SDL_Event motion={0}; motion.type=SDL_MOUSEMOTION;
            motion.motion.x=frames==32?28:frames==64?124:600;
            motion.motion.y=frames<96?132:300; SDL_PushEvent(&motion);
            printf("UI depth_pointer=%s\n",frames==32?"left":frames==64?"right":"outside"); fflush(stdout);
        }
        if(smoke_keyboard && (frames==20 || frames==24 || frames==40 || frames==44)) {
            SDL_Event key={0}; key.type=frames==20 || frames==40?SDL_KEYDOWN:SDL_KEYUP;
            key.key.keysym.sym=frames<30?SDLK_TAB:SDLK_RETURN; SDL_PushEvent(&key);
        }
        if(smoke_usage && (frames==120 || frames==124 || (smoke_usage_filter>=0 && (frames==160 || frames==164)) || (smoke_usage_switch && (frames==200 || frames==204)) || frames==240 || frames==244 || (smoke_usage_back && (frames==280 || frames==284)))) {
            bool down=frames==120 || frames==160 || frames==200 || frames==240 || frames==280;
            SDL_Event click={0}; click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
            click.button.button=SDL_BUTTON_LEFT; click.button.state=down?SDL_PRESSED:SDL_RELEASED;
            if(frames<140) { click.button.x=smoke_usage==7?400:545; click.button.y=30; }
            else if(frames<180) { click.button.x=420+(smoke_usage_filter+1)*166; click.button.y=128; }
            else if(frames<220) { click.button.x=smoke_usage==7?835:720; click.button.y=84; }
            else if(frames<260) { click.button.x=944; click.button.y=360; }
            else { click.button.x=955; click.button.y=84; }
            SDL_PushEvent(&click);
        }
        if(smoke_input && (frames == 8 || frames == 12)) {
            SDL_Event click = {0};
            click.type = frames == 8 ? SDL_MOUSEBUTTONDOWN : SDL_MOUSEBUTTONUP;
            click.button.button = SDL_BUTTON_LEFT;
            click.button.state = frames == 8 ? SDL_PRESSED : SDL_RELEASED;
            /* Hit the pet's foreground platform, exercising event pass-through. */
            click.button.x = 75; click.button.y = 180+150*smoke_agent;
            SDL_PushEvent(&click);
        }
        if(smoke_detail && (frames==120 || frames==124)) {
            SDL_Event click={0}; bool down=frames==120;
            click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP; click.button.button=SDL_BUTTON_LEFT;
            click.button.state=down?SDL_PRESSED:SDL_RELEASED;
            click.button.x=450;click.button.y=168;SDL_PushEvent(&click);
        }
        if((smoke_assistant || smoke_tools) && (frames==30 || frames==34)) {
            SDL_Event click={0};bool down=frames==30;click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
            click.button.button=SDL_BUTTON_LEFT;click.button.state=down?SDL_PRESSED:SDL_RELEASED;
            click.button.x=smoke_tools?976:450;click.button.y=550;SDL_PushEvent(&click);
        }
        if(smoke_assistant_scroll && frames==60) ac_bootstrap_screen_scroll_at(500,350,500);
        if(smoke_assistant_escape && frames==100) {
            SDL_Event key={0};key.type=SDL_KEYDOWN;key.key.keysym.sym=SDLK_ESCAPE;SDL_PushEvent(&key);
        }
        if(smoke_assistant_update && frames==90) {
            static const ac_assistant_message_view_t updates[]={
                {"demo-1","09:36","示例项目 A：本轮修改已报告完成，等待验收。","演示 · 项目进展"},
                {"demo-2","09:38","示例项目 B：需要确认接口方案，可回到原会话继续处理。","演示 · 关注事项"},
                {"demo-3","09:40","项目简报会保留关键决定与来源，后续修改会替代旧方案。","演示 · 助手回复"},
                {"demo-4","09:42","示例项目 B 需要确认方案；示例项目 A 的修改等待验收。","演示 · 最新消息"},
                {"demo-5","09:45","新的演示消息已到达；阅读旧消息时，列表保留当前位置。","演示 · 新消息"}
            };
            ac_assistant_feed_view_t feed={AC_ASSISTANT_READY,true,updates,sizeof(updates)/sizeof(updates[0])};
            bool accepted=ac_assistant_panel_set_feed(&feed);bool repeated=ac_assistant_panel_set_feed(&feed);
            feed.mock=false;bool wrong_source=ac_assistant_panel_set_feed(&feed);
            printf("UI assistant_feed_accept=%d repeat=%d wrong_source=%d\n",accepted,repeated,wrong_source);fflush(stdout);
        }
        if(smoke_assistant_long && frames==90) {
            char long_text[8192]="";
            for(int i=0;i<60;++i) strcat(long_text,"长消息演示：确认内容可滚动，消息缓存有界，截短会给出提示。");
            ac_assistant_message_view_t message={"long-demo","09:46",long_text,"演示 · 长消息"};
            ac_assistant_feed_view_t feed={AC_ASSISTANT_READY,true,&message,1};
            ac_assistant_panel_set_feed(&feed);
        }
        if(smoke_actions) {
            const int at[]={180,210,240,270,300,330};const int xs[]={450,100,976,800,976,800};const int ys[]={550,100,550,340,550,400};
            for(size_t i=0;i<sizeof(at)/sizeof(at[0]);++i) if(frames==at[i] || frames==at[i]+4) {
                SDL_Event click={0};bool down=frames==at[i];click.type=down?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
                click.button.button=SDL_BUTTON_LEFT;click.button.state=down?SDL_PRESSED:SDL_RELEASED;
                click.button.x=xs[i];click.button.y=ys[i];SDL_PushEvent(&click);
            }
        }
        if(smoke_scroll && frames==170) printf("UI scroll_before=%d\n",(int)ac_bootstrap_screen_detail_scroll_y());
        if(smoke_scroll && (frames==185 || frames==210)) {
            SDL_Event touch={0}; touch.type=frames==185?SDL_MOUSEBUTTONDOWN:SDL_MOUSEBUTTONUP;
            touch.button.button=SDL_BUTTON_LEFT; touch.button.state=frames==185?SDL_PRESSED:SDL_RELEASED;
            touch.button.x=650; touch.button.y=frames==185?220:440; SDL_PushEvent(&touch);
        }
        if(smoke_scroll && frames>185 && frames<=205) {
            SDL_Event motion={0}; motion.type=SDL_MOUSEMOTION; motion.motion.x=650; motion.motion.y=220+(frames-185)*11; SDL_PushEvent(&motion);
        }
        if(smoke_scroll && frames==265) { printf("UI scroll_after=%d\n",(int)ac_bootstrap_screen_detail_scroll_y()); fflush(stdout); }
        SDL_Event event;
        while(SDL_PollEvent(&event)) {
            if(event.type == SDL_QUIT) running = false;
            else if(event.type == SDL_MOUSEMOTION) { mouse_x = event.motion.x; mouse_y = event.motion.y; }
            // A valid point outside all pet hit areas clears parallax without
            // LVGL allocating/printing two out-of-range warnings every tick.
            else if(event.type == SDL_WINDOWEVENT && event.window.event==SDL_WINDOWEVENT_LEAVE) { mouse_x=WIDTH-1; mouse_y=HEIGHT-1; mouse_pressed=false; }
            else if(event.type == SDL_MOUSEWHEEL) ac_bootstrap_screen_scroll_at(mouse_x,mouse_y,event.wheel.y*48);
            else if(event.type == SDL_MOUSEBUTTONDOWN || event.type == SDL_MOUSEBUTTONUP) {
                mouse_x = event.button.x; mouse_y = event.button.y;
                mouse_pressed = event.type == SDL_MOUSEBUTTONDOWN;
            }
            else if(event.type == SDL_KEYDOWN || event.type==SDL_KEYUP) {
                SDL_Keycode code=event.key.keysym.sym;
                if(code==SDLK_ESCAPE && event.type==SDL_KEYDOWN && !ac_bootstrap_screen_close_overlay()) running=false;
                if(code==SDLK_TAB || code==SDLK_RETURN || code==SDLK_SPACE || code==SDLK_RIGHT || code==SDLK_LEFT) {
                    keyboard_key=code==SDLK_TAB?((event.key.keysym.mod & KMOD_SHIFT)?LV_KEY_PREV:LV_KEY_NEXT):code==SDLK_RIGHT?LV_KEY_NEXT:code==SDLK_LEFT?LV_KEY_PREV:LV_KEY_ENTER;
                    keyboard_pressed=event.type==SDL_KEYDOWN;
                }
            }
        }
        if(ac_gateway_client_take(&gateway_update)) {
            if(gateway_update.has_assistant) {
                ac_assistant_message_view_t messages[8];const ac_assistant_feed_t *feed=&gateway_update.assistant;
                for(size_t i=0;i<feed->message_count;++i)messages[i]=(ac_assistant_message_view_t){feed->messages[i].id,feed->messages[i].time,feed->messages[i].text,feed->messages[i].source};
                ac_assistant_feed_view_t view={(ac_assistant_status_t)feed->status,feed->mock,messages,feed->message_count};ac_assistant_panel_set_feed(&view);
            }
            if(gateway_update.online) {
                if(gateway_update.has_settings && gateway_update.settings_revision!=settings_revision) {
                    ac_theme_id_t old=ac_theme_current();
                    if(!forced_theme) ac_bootstrap_screen_set_theme(gateway_update.theme);
                    if(old!=ac_theme_current()) ac_window_theme(window,ac_theme_dark());
                    if(!reduced_motion) ac_bootstrap_screen_set_animations(gateway_update.animations_enabled);
                    settings_revision=gateway_update.settings_revision;
                }
                ac_bootstrap_screen_apply(&gateway_update.snapshot,SDL_GetTicks64());
                if(gateway_update.has_detail) ac_bootstrap_screen_detail(&gateway_update.detail);
            } else ac_bootstrap_screen_connection_lost();
        }
        ac_bootstrap_screen_tick(SDL_GetTicks64());
        lv_timer_handler();
        if(capture_prefix && capture_every>0 && frames%capture_every==0) {
            char path[1024]; snprintf(path,sizeof(path),"%s-%04d.bmp",capture_prefix,frames);
            if(!capture_frame(path)) { fprintf(stderr,"Frame capture failed\n"); running=false; }
            printf("CAPTURE frame=%d tick_ms=%llu\n",frames,(unsigned long long)SDL_GetTicks64()); fflush(stdout);
        }
        ++frames;
        deadline+=performance_frequency/60;
        uint64_t at=SDL_GetPerformanceCounter();
        if(at<deadline) {
            double ms=(double)(deadline-at)*1000.0/(double)performance_frequency;
            if(ms>=1) SDL_Delay((uint32_t)ms);
            while(SDL_GetPerformanceCounter()<deadline) SDL_Delay(0);
        } else if(at-deadline>performance_frequency/12) deadline=at;
    }
    int result = 0;
    if(performance_path) {
        for(size_t i=1;i<interval_count;++i) { double value=present_intervals[i]; size_t j=i; while(j && present_intervals[j-1]>value) {present_intervals[j]=present_intervals[j-1]; --j;} present_intervals[j]=value; }
        SDL_RendererInfo info; SDL_GetRendererInfo(renderer,&info);
        double elapsed=(double)(SDL_GetPerformanceCounter()-loop_started)*1000.0/(double)performance_frequency;
        double span=(double)(previous_present-first_present)*1000.0/(double)performance_frequency;
        FILE *out=fopen(performance_path,"w");
        if(!out) result=1;
        else {
            fprintf(out,"{\"target_fps\":60,\"renderer\":\"%s\",\"loop_frames\":%d,\"elapsed_ms\":%.2f,\"loop_fps\":%.2f,\"presented_frames\":%llu,\"present_fps\":%.2f,\"present_interval_p50_ms\":%.2f,\"present_interval_p95_ms\":%.2f,\"present_interval_max_ms\":%.2f}\n",info.name,frames,elapsed,elapsed>0?frames*1000.0/elapsed:0,(unsigned long long)presented,span>0?(presented-1)*1000.0/span:0,interval_count?present_intervals[interval_count/2]:0,interval_count?present_intervals[interval_count*95/100]:0,interval_count?present_intervals[interval_count-1]:0);
            fclose(out);
        }
    }
    if(capture != NULL) {
        if(!capture_frame(capture)) {
            fprintf(stderr, "Capture failed: %s\n", SDL_GetError()); result = 1;
        }
    }
    ac_gateway_client_stop();
    ac_bootstrap_screen_destroy();
    lv_group_set_default(NULL); lv_group_delete(group);
    lv_deinit();
    SDL_DestroyTexture(texture);
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return result;
}
