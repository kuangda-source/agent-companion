cmake_minimum_required(VERSION 3.24)
project(agent_companion_simulator LANGUAGES C CXX OBJC)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT EXISTS "${CMAKE_SOURCE_DIR}/.deps/lvgl/CMakeLists.txt")
    message(FATAL_ERROR "Run ./scripts/dev setup before configuring the simulator")
endif()

find_package(SDL2 2.32.10 EXACT CONFIG REQUIRED
    PATHS "${CMAKE_SOURCE_DIR}/.tools/sdl2/lib/cmake/SDL2" NO_DEFAULT_PATH)
set(LV_BUILD_CONF_PATH "${CMAKE_SOURCE_DIR}/apps/simulator/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
add_subdirectory(.deps/lvgl EXCLUDE_FROM_ALL)
target_sources(lvgl PRIVATE "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_ui_16.c")
target_sources(lvgl PRIVATE "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_mono_13.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_mono_20.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_display_22.c")
target_sources(lvgl PRIVATE "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_sans_13.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_sans_16.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_sans_20.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_sans_22.c")
target_sources(lvgl PRIVATE "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_comic_13.c" "${CMAKE_SOURCE_DIR}/generated/fonts/ac_font_comic_16.c")

file(GLOB PET_RESOURCE_SOURCES CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/generated/pets/*.c")
add_library(agent_companion_core STATIC packages/client-core/src/ac_model.c packages/client-core/src/ac_pet_player.c)
target_include_directories(agent_companion_core PUBLIC packages/client-core/include)
target_compile_options(agent_companion_core PRIVATE -Wall -Wextra -Werror)
add_library(agent_companion_ui STATIC
    ${PET_RESOURCE_SOURCES}
    packages/ui/src/ac_pet_widget.c
    packages/ui/src/ac_usage_panel.c
    packages/ui/src/ac_assistant_panel.c
    packages/ui/src/ac_neon.c
    packages/ui/src/ac_theme.c
    packages/ui/src/ac_bootstrap_screen.c)
target_include_directories(agent_companion_ui PUBLIC
    packages/client-core/include packages/ui/include)
target_link_libraries(agent_companion_ui PUBLIC lvgl::lvgl agent_companion_core)
target_compile_options(agent_companion_ui PRIVATE -Wall -Wextra -Werror)

add_executable(agent_companion_sim apps/simulator/main.c apps/simulator/ac_gateway_client.m apps/simulator/ac_window_theme.m)
set_source_files_properties(apps/simulator/ac_window_theme.m PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
set_source_files_properties(apps/simulator/ac_gateway_client.m PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
target_link_libraries(agent_companion_sim PRIVATE agent_companion_ui SDL2::SDL2-static "-framework Foundation" "-framework AppKit")
target_compile_options(agent_companion_sim PRIVATE -Wall -Wextra -Werror)

enable_testing()
add_executable(test_client_core tests/test_client_core.c)
target_link_libraries(test_client_core PRIVATE agent_companion_core)
target_compile_options(test_client_core PRIVATE -Wall -Wextra -Werror)
add_test(NAME client_core COMMAND test_client_core)
add_executable(test_gateway_decode tests/test_gateway_decode.m apps/simulator/ac_gateway_client.m)
set_source_files_properties(tests/test_gateway_decode.m PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
target_include_directories(test_gateway_decode PRIVATE apps/simulator)
target_link_libraries(test_gateway_decode PRIVATE agent_companion_core "-framework Foundation")
target_compile_options(test_gateway_decode PRIVATE -Wall -Wextra -Werror)
add_test(NAME gateway_decode COMMAND test_gateway_decode "${CMAKE_SOURCE_DIR}/examples/state_mock.json")

add_executable(test_ui_input tests/test_ui_input.c)
target_link_libraries(test_ui_input PRIVATE agent_companion_ui)
target_compile_options(test_ui_input PRIVATE -Wall -Wextra -Werror)
add_test(NAME ui_input COMMAND test_ui_input)

add_executable(test_link_watch tests/test_link_watch.c apps/device/main/ac_link_watch.c)
target_include_directories(test_link_watch PRIVATE apps/device/main)
target_compile_options(test_link_watch PRIVATE -Wall -Wextra -Werror)
add_test(NAME link_watch COMMAND test_link_watch)

add_executable(test_ui_countdown tests/test_ui_countdown.c)
target_link_libraries(test_ui_countdown PRIVATE agent_companion_ui)
target_compile_options(test_ui_countdown PRIVATE -Wall -Wextra -Werror)
add_test(NAME ui_countdown COMMAND test_ui_countdown)

add_executable(test_relay_url tests/test_relay_url.c apps/device/main/ac_relay_url.c)
target_include_directories(test_relay_url PRIVATE apps/device/main)
target_compile_options(test_relay_url PRIVATE -Wall -Wextra -Werror)
add_test(NAME relay_url COMMAND test_relay_url)
