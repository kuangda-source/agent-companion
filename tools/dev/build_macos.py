#!/usr/bin/env python3
"""Build the local Apple Silicon control app with embedded Gateway and LVGL preview.

No account credentials, user records or settings are copied into the application.
"""
from pathlib import Path
import plistlib
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
APP = Path.home() / "Applications/AgentCompanion.app"
if (APP / "Contents/Info.plist").is_file():
    with (APP / "Contents/Info.plist").open("rb") as source:
        if plistlib.load(source).get("CFBundleIdentifier") not in ("cloud.kuangda.agentcompanion", "org.agentcompanion.desktop"):
            raise RuntimeError("Refusing to replace an unrelated application")
subprocess.run([str(ROOT / "scripts/dev"), "build"], cwd=ROOT, check=True)
macos = APP / "Contents/MacOS"; resources = APP / "Contents/Resources"
macos.mkdir(parents=True, exist_ok=True); (resources / "bin").mkdir(parents=True, exist_ok=True)
controller_staged = macos / "AgentCompanion.installing"
subprocess.run(["swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-target", "arm64-apple-macos13.0", "-framework", "SwiftUI", "-framework", "AppKit", str(ROOT / "apps/macos/AgentCompanionApp.swift"),str(ROOT / "apps/macos/ThemeStyles.swift"),str(ROOT / "apps/macos/AssistantPanel.swift"),str(ROOT / "apps/macos/IntegrationSettingsPanel.swift"),str(ROOT / "apps/macos/ConnectionPanel.swift"),str(ROOT / "apps/macos/HostDisplayMonitor.swift"), "-o", str(controller_staged)], cwd=ROOT, check=True)
os.replace(controller_staged, macos / "AgentCompanion")
gateway_staged = resources / "bin/agent-companion-gateway.installing"
subprocess.run([str(ROOT / ".tools/bin/bun"), str(ROOT / "tools/dev/build_gateway.ts"), str(ROOT / "apps/gateway/src/main.ts"), str(gateway_staged)], cwd=ROOT, check=True)
os.replace(gateway_staged, resources / "bin/agent-companion-gateway")
# A running/previously executed Mach-O can have a cached code signature on its
# vnode. Never overwrite that inode: install a fresh file and rename it.
preview = resources / "bin/agent-companion-preview"
preview_staged = preview.with_suffix(".installing")
shutil.copy(ROOT / ".build/simulator/agent_companion_sim", preview_staged)
os.replace(preview_staged, preview)
for binary in (resources / "bin").iterdir():
    if binary.is_file(): subprocess.run(["codesign", "--force", "--sign", "-", str(binary)], check=True)
info = {"CFBundleIdentifier": "cloud.kuangda.agentcompanion", "CFBundleName": "AgentCompanion", "CFBundleDisplayName": "Agent Companion", "CFBundleExecutable": "AgentCompanion", "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.4.3", "CFBundleVersion": "25", "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True, "NSLocalNetworkUsageDescription": "连接同一局域网中的 Agent Companion 桌面屏幕。", "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
iconset=ROOT/".cache/macos/AppIcon.iconset"
subprocess.run(["swift",str(ROOT/"apps/macos/AppIcon.swift"),str(iconset)],check=True)
subprocess.run(["iconutil","--convert","icns",str(iconset),"--output",str(resources/"AppIcon.icns")],check=True)
info["CFBundleIconFile"]="AppIcon.icns"
with (APP / "Contents/Info.plist").open("wb") as output: plistlib.dump(info, output)
licenses = resources / "Licenses"; licenses.mkdir(exist_ok=True)
for file in (ROOT / "assets/fonts").glob("*-LICENSE.txt"): shutil.copy(file, licenses / file.name)
for pet in (ROOT / "assets/pets").iterdir():
    if pet.is_dir() and (pet / "license.md").is_file(): shutil.copy(pet / "license.md", licenses / (pet.name + ".md"))
for name, path in [("LVGL", ROOT / ".deps/lvgl/LICENCE.txt"), ("SDL2", ROOT / ".tools/sdl2/share/licenses/SDL2/LICENSE.txt")]:
    if path.is_file(): shutil.copy(path, licenses / (name + ".txt"))
shutil.copy(ROOT / "packages/dsh-superagent-core/LICENSE", licenses / "DeepSeek-Superagent-Core-MIT.txt")
shutil.copy(ROOT / "packages/dsh-superagent-core/UPSTREAM.json", licenses / "DeepSeek-Superagent-Core-UPSTREAM.json")
for package in (ROOT / "node_modules").iterdir():
    candidates = package.iterdir() if package.name.startswith("@") and package.is_dir() else [package]
    for dependency in candidates:
        if not dependency.is_dir(): continue
        for pattern in ("LICENSE*", "LICENCE*", "NOTICE*"):
            for file in dependency.glob(pattern):
                if file.is_file(): shutil.copy(file, licenses / (dependency.parent.name.lstrip("@") + "-" + dependency.name + "-" + file.name))
for attribute in ("com.apple.FinderInfo","com.apple.ResourceFork"):
    # The source tree is untouched; remove only signing-incompatible metadata
    # from our generated bundle. Quarantine and other attributes are retained.
    subprocess.run(["xattr","-rd",attribute,str(APP)],capture_output=True,check=False)
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(APP)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(APP)], check=True)
print(APP)
