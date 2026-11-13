# Agent Companion contributor guidance

- Keep V1 incremental: shared LVGL card UI, macOS controller, local Bun Gateway and ESP32-P4 7B. V2 shared-room work is deferred.
- Read README.md and docs/SETUP.md first. Real Agent files are read-only; do not modify original sessions, schedules, account credentials or provider hooks.
- Use MOCK fixtures for tests and demos. Unknown source fields remain null/unknown, never fabricate live values.
- No keys, Wi-Fi credentials, private hosts, runtime databases, raw flash/NVS, certificates/private keys or real transcripts in Git, logs, screenshots or issue attachments. All public defaults must stay empty; AI inference is opt-in.
- Run ./scripts/dev check for relevant protocol/source changes. Mac build: ./scripts/dev mac. Firmware: ./scripts/device build rev3_x after checking actual chip revision. Never automatically flash or erase connected hardware; confirm backup, exact image/port and user intent first.
- Preserve local authenticated loopback management API and separate LAN/device/relay credentials. Do not expose management routes over the relay or disable TLS verification.
- Respect separate code and asset licenses. Do not remove character credits or imply commercial asset rights.
- Report compilation, simulator checks and hardware checks separately. One-way device voice playback is implemented; real-time voice conversation, full Letta integration and V2 remain pending.
