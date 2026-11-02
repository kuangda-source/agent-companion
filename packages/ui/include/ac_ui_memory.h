#pragma once
/* Large view caches have no DMA/ISR users; retain internal RAM for networking. */
#ifdef ESP_PLATFORM
#include "esp_attr.h"
#define AC_UI_LARGE_BSS EXT_RAM_BSS_ATTR
#else
#define AC_UI_LARGE_BSS
#endif
