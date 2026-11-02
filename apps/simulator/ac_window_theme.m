#import <AppKit/AppKit.h>
#include <SDL_syswm.h>
#include "ac_window_theme.h"
#include "ac_theme.h"
#include <stdio.h>

void ac_window_theme(SDL_Window *window, bool dark)
{
    SDL_SysWMinfo info; SDL_VERSION(&info.version);
    if(!SDL_GetWindowWMInfo(window,&info) || info.subsystem!=SDL_SYSWM_COCOA) return;
    NSWindow *native=info.info.cocoa.window;
    native.appearance=[NSAppearance appearanceNamed:dark?NSAppearanceNameDarkAqua:NSAppearanceNameAqua];
    uint32_t background=ac_theme_color(0x0a0a0f);
    native.backgroundColor=[NSColor colorWithSRGBRed:((background>>16)&255)/255.0 green:((background>>8)&255)/255.0 blue:(background&255)/255.0 alpha:1];
    native.titlebarAppearsTransparent=YES;
    if(@available(macOS 11.0,*)) native.titlebarSeparatorStyle=NSTitlebarSeparatorStyleNone;
    printf("WINDOW theme=%s content=%.0fx%.0f\n",dark?"dark":"light",native.contentView.bounds.size.width,native.contentView.bounds.size.height); fflush(stdout);
}
