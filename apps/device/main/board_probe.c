/* Bring-up firmware only. No Gateway pairing, credentials or device acknowledgements.
 * Display configuration follows Waveshare's BSP 3.0.1 / LVGL 9.5.0 example.
 */
#include <inttypes.h>
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bsp/esp-bsp.h"
#include "bsp/display.h"
#include "lvgl.h"

static const char *TAG="ac_board_probe";
static unsigned touches;
static void touch_probe(lv_event_t *event)
{
    lv_indev_t *input=lv_event_get_indev(event);
    if(!input) return;
    lv_point_t point; lv_indev_get_point(input,&point);
    ESP_LOGI(TAG,"touch=%u x=%ld y=%ld",++touches,(long)point.x,(long)point.y);
}
void app_main(void)
{
    esp_chip_info_t chip; esp_chip_info(&chip);
    uint32_t flash=0; ESP_ERROR_CHECK(esp_flash_get_size(NULL,&flash));
    ESP_LOGI(TAG,"IDF=%s chip_revision=%u cores=%u flash_bytes=%" PRIu32 " psram_bytes=%u",
             esp_get_idf_version(),chip.revision,chip.cores,flash,(unsigned)esp_psram_get_size());
    bsp_display_cfg_t config={
        .lv_adapter_cfg=ESP_LV_ADAPTER_DEFAULT_CONFIG(),
        .rotation=ESP_LV_ADAPTER_ROTATE_180,
        .tear_avoid_mode=ESP_LV_ADAPTER_TEAR_AVOID_MODE_TRIPLE_PARTIAL,
        .touch_flags={.swap_xy=0,.mirror_x=1,.mirror_y=1},
    };
    lv_display_t *display=bsp_display_start_with_config(&config);
    ESP_ERROR_CHECK(display ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(bsp_display_lock(-1) ? ESP_OK : ESP_ERR_TIMEOUT);
    lv_obj_t *screen=lv_screen_active();
    lv_obj_set_style_bg_color(screen,lv_color_hex(0x08121c),0);
    lv_obj_set_style_text_color(screen,lv_color_hex(0x00ffff),0);
    lv_obj_set_style_text_font(screen,&lv_font_montserrat_20,0);
    lv_obj_add_event_cb(screen,touch_probe,LV_EVENT_PRESSED,NULL);
    lv_obj_t *label=lv_label_create(screen);
    lv_label_set_text(label,"AGENT COMPANION / BOARD CHECK\n\n1024 x 600 / RGB565\nTouch the four corners; inspect serial coordinates.\n\nGATEWAY: NOT CONNECTED\nHardware acceptance pending.");
    lv_obj_center(label); bsp_display_unlock();
    ESP_ERROR_CHECK(bsp_display_backlight_on());
    while(true) {
        ESP_LOGI(TAG,"internal_free=%u internal_min=%u psram_free=%u psram_largest=%u",
            (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
            (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT),
            (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
            (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
