set(AC_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../..")
if(CONFIG_AC_BOARD_PROBE_ONLY)
    idf_component_register(SRCS "board_probe.c" INCLUDE_DIRS "."
        REQUIRES esp_psram esp_hw_support spi_flash waveshare__esp32_p4_wifi6_touch_lcd_7b)
else()
    file(GLOB AC_PETS "${AC_ROOT}/.build/device-pets/*.c")
    file(GLOB AC_FONTS "${AC_ROOT}/.build/device-fonts/*.c")
    if(NOT AC_FONTS)
        message(FATAL_ERROR "Run python3 tools/dev/build_device_fonts.py first")
    endif()
    file(GLOB AC_UI "${AC_ROOT}/packages/ui/src/*.c")
    idf_component_register(SRCS "app_main.c" "ac_device_decode.c" "ac_network.c" "ac_link_watch.c" "ac_relay_url.c" "ac_audio.c"
        ${AC_PETS} ${AC_FONTS} ${AC_UI}
        "${AC_ROOT}/packages/client-core/src/ac_model.c"
        "${AC_ROOT}/packages/client-core/src/ac_pet_player.c"
        "${AC_ROOT}/packages/client-core/src/ac_wifi.c"
        INCLUDE_DIRS "." "${AC_ROOT}/packages/client-core/include" "${AC_ROOT}/packages/ui/include"
        REQUIRES esp_psram esp_hw_support spi_flash esp_timer esp_driver_usb_serial_jtag esp_driver_ledc json nvs_flash esp_netif esp_event esp_wifi esp-tls espressif__esp_websocket_client
        waveshare__esp32_p4_wifi6_touch_lcd_7b espressif__esp_codec_dev mbedtls)
    target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error=misleading-indentation -Wno-error=format-truncation)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE LV_LVGL_H_INCLUDE_SIMPLE)
endif()
