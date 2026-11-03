import SwiftUI
import AppKit

struct Appearance: Codable, Equatable { var theme: Theme = .neon; var animations_enabled = true; var show_scheduled_tasks = true; var agent_ids = ["codex", "grok", "deepseek"] }
struct DeviceSettings: Codable, Equatable {
    var brightness = 75, volume = 50, sleep_after_seconds = 300
    var transport = "auto", relay_url = ""
    var follow_host_brightness = true, follow_host_sleep = true
}
struct Preferences: Codable, Equatable { var schema_version = 1, revision = 0; var appearance = Appearance(); var device = DeviceSettings() }
enum Section: String, CaseIterable, Identifiable {
    case overview = "概览", assistant = "AI 助手", appearance = "外观", agents = "Agent", device = "屏幕", connection = "连接", integrations = "API 设置"
    var id: String { rawValue }
    var symbol: String { switch self { case .overview: return "square.grid.2x2"; case .assistant: return "sparkles"; case .appearance: return "tshirt"; case .agents: return "person.3"; case .device: return "display"; case .connection: return "wifi"; case .integrations: return "key" } }
}

struct BoardNetwork: Codable, Equatable { var state: String; var code: Int? }
struct BoardProvision: Codable, Equatable { var state: String; var request_id: String? }
struct BoardUSB: Codable, Equatable { var port: String?; var mode: String?; var network: BoardNetwork?; var provision: BoardProvision?; var link_config: BoardProvision? }
struct LanEndpoint: Codable, Equatable { var interface: String; var host: String; var url: String }
struct LanConnectionStatus: Codable, Equatable { var enabled: Bool; var listening: Bool; var url: String; var endpoints: [LanEndpoint]; var device_connected: Bool; var data_fresh: Bool; var error: String? }
struct RemoteConnectionStatus: Codable, Equatable {
    var relay_url: String?; var configured: Bool; var relay_connected: Bool; var device_connected: Bool; var data_fresh: Bool
    var last_applied_at: String?; var error: String?; var usb: BoardUSB?; var provision_pending: Bool
    var lan: LanConnectionStatus?; var active_transport: String?; var relay_device_connected: Bool?; var link_pending: Bool?
}

@MainActor final class CompanionModel: ObservableObject {
    @Published var hostDisplayStatus: HostDisplayStatus?
    private var displayMonitor: HostDisplayMonitor?
    private var displayPostTask: Task<Void,Never>?
    private var queuedDisplay: HostDisplaySample?
        @Published var connectionStatus: RemoteConnectionStatus?
    @Published var networkSaving = false
    @Published var networkMessage = ""
    @Published var preferences = Preferences()
    @Published var online = false
    @Published var starting = true
    @Published var saving = false
    @Published var assistantFeed: AssistantFeed?
    @Published var assistantMessages: [AssistantMessage] = []
    @Published var assistantSending = false
    @Published private(set) var previewRunning = false
    @Published var message = "正在启动本机服务…"
    @Published var error: String?
    @Published var selected: Section = .overview
    private var gateway: Process?, preview: Process?, logHandle: FileHandle?
    private var pollTask: Task<Void, Never>?
    private var gatewayRestartAfter = Date.distantPast
    private var gatewayStartedAt = Date.distantPast
    private var gatewayRestartFailures = 0
    let runtime: URL
    private let base = URL(string: "http://127.0.0.1:8736")!
    private let session: URLSession
    init() {
        let fallback = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AgentCompanion", isDirectory: true)
        runtime = URL(fileURLWithPath: ProcessInfo.processInfo.environment["AGENT_COMPANION_RUNTIME"] ?? Bundle.main.object(forInfoDictionaryKey: "ACRuntimeDirectory") as? String ?? fallback.path, isDirectory: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.connectionProxyDictionary = [:]; configuration.timeoutIntervalForRequest = 2
        session = URLSession(configuration: configuration)
    }
    var theme: Theme { preferences.appearance.theme }
    private func resource(_ name: String) throws -> URL {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("bin/" + name), FileManager.default.isExecutableFile(atPath: url.path) else { throw NSError(domain: "AgentCompanion", code: 1, userInfo: [NSLocalizedDescriptionKey: "应用组件缺失，请重新构建应用。"] ) }
        return url
    }
    private func fetch(_ path: String, patch: [String: Any]? = nil, authenticated: Bool = true, method: String = "PATCH") async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path)); request.cachePolicy = .reloadIgnoringLocalCacheData
        if authenticated {
            let token = try String(contentsOf: runtime.appendingPathComponent("gateway.token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        if method == "DELETE" { request.httpMethod = method }
        if let patch { request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: patch) }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, [200,202].contains(response.statusCode) else { throw NSError(domain: "AgentCompanion", code: 2, userInfo: [NSLocalizedDescriptionKey: "本机操作未完成，请稍后重试。"] ) }
        return data
    }
    private func serviceIdentity() async -> Bool {
        guard let data = try? await fetch("api/v1/health", authenticated: false), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        guard object["service"] as? String == "agent-companion", object["data_source"] as? String == "live" else { return false }
        return (try? await fetch("api/v1/settings")) != nil
    }
    private func gatewayEvent(_ event: String, process: Process? = nil) {
        let file = runtime.appendingPathComponent("gateway-lifecycle.log")
        if !FileManager.default.fileExists(atPath:file.path) { FileManager.default.createFile(atPath:file.path,contents:nil,attributes:[.posixPermissions:0o600]) }
        let pid = process.map { String($0.processIdentifier) } ?? "-"
        let line = "\(ISO8601DateFormatter().string(from:Date())) \(event) pid=\(pid)\n"
        if let handle = try? FileHandle(forWritingTo:file) { try? handle.seekToEnd(); try? handle.write(contentsOf:Data(line.utf8)); try? handle.close() }
    }
    private func launchGateway() async throws {
        try Task.checkCancellation()
        guard gateway?.isRunning != true else { return }
        let child = Process(); child.executableURL = try resource("agent-companion-gateway")
        child.environment = ProcessInfo.processInfo.environment.merging(["PORT":"8736","AGENT_COMPANION_RUNTIME":runtime.path]) { _,new in new }
        if logHandle == nil {
            let log = runtime.appendingPathComponent("mac-app.log")
            if !FileManager.default.fileExists(atPath:log.path) { FileManager.default.createFile(atPath:log.path,contents:nil,attributes:[.posixPermissions:0o600]) }
            logHandle = try FileHandle(forWritingTo:log); try logHandle?.seekToEnd()
        }
        child.standardOutput = logHandle; child.standardError = logHandle
        try child.run(); gateway = child; gatewayStartedAt = Date(); gatewayEvent("started",process:child)
        for _ in 0..<60 {
            try Task.checkCancellation()
            if await serviceIdentity() { gatewayEvent("ready",process:child); return }
            if !child.isRunning { gatewayEvent("startup_exit status=\(child.terminationStatus)",process:child); throw NSError(domain:"AgentCompanion",code:3,userInfo:[NSLocalizedDescriptionKey:"本机服务启动失败，请检查服务日志。"] ) }
            try await Task.sleep(nanoseconds:250_000_000)
        }
        throw NSError(domain:"AgentCompanion",code:4,userInfo:[NSLocalizedDescriptionKey:"本机服务启动超时。"] )
    }
    private func recoverExitedGateway() async {
        guard !Task.isCancelled, gateway?.isRunning != true, Date() >= gatewayRestartAfter else { return }
        if await serviceIdentity() { return }
        guard !Task.isCancelled else { return }
        if Date().timeIntervalSince(gatewayStartedAt) >= 60 { gatewayRestartFailures = 0 }
        let delay = min(30.0,pow(2.0,Double(min(gatewayRestartFailures,5))))
        gatewayRestartFailures += 1; gatewayRestartAfter = Date().addingTimeInterval(delay)
        if let child = gateway { gatewayEvent("unexpected_exit status=\(child.terminationStatus) retry=\(gatewayRestartFailures)",process:child) }
        message = "本机服务已退出，正在自动恢复…"
        do { try await launchGateway() }
        catch is CancellationError { }
        catch { self.error = error.localizedDescription; gatewayEvent("restart_failed") }
    }
    private func publishDisplay(_ value: HostDisplaySample) {
        guard online else { return }; queuedDisplay = value
        guard displayPostTask == nil else { return }
        displayPostTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, let next = queuedDisplay {
                queuedDisplay = nil
                if let data = try? await fetch("api/v1/host-display",patch:next.body,method:"POST"),let status = try? JSONDecoder().decode(HostDisplayStatus.self,from:data) { hostDisplayStatus = status }
            }
            displayPostTask = nil
        }
    }
    private func refreshQuotaAfterWake() {
        guard online else { return }
        Task { _ = try? await fetch("api/v1/quotas/refresh",patch:["reason":"wake"],method:"POST") }
    }
    func start() {
        guard pollTask == nil else { return }
        displayMonitor = HostDisplayMonitor(publish: { [weak self] value in self?.publishDisplay(value) }, wake: { [weak self] in self?.refreshQuotaAfterWake() })
        pollTask = Task { [weak self] in
            guard let self else { return }
            do {
                try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                if !(await serviceIdentity()) {
                    try await launchGateway()
                }
                guard await serviceIdentity() else { throw NSError(domain: "AgentCompanion", code: 4, userInfo: [NSLocalizedDescriptionKey: "本机服务启动超时。"] ) }
                starting = false
                while !Task.isCancelled {
                    do {
                        let data = try await fetch("api/v1/settings")
                        if !saving {
                            let received = try JSONDecoder().decode(Preferences.self, from: data)
                            if received != preferences { preferences = received }
                        }
                        if !online { online = true; displayMonitor?.sample(force:true); refreshQuotaAfterWake() }
                        displayMonitor?.sample()
                        if selected == .device,let data = try? await fetch("api/v1/host-display"),let status = try? JSONDecoder().decode(HostDisplayStatus.self,from:data) { hostDisplayStatus = status }
                        if message != "本机服务已连接" { message = "本机服务已连接" }
                        if selected == .assistant { await pollAssistant() }
                        if selected == .connection || selected == .overview { await pollConnection() }
                    } catch {
                        if online { online = false }
                        if message != "本机服务连接中断，正在重试…" { message = "本机服务连接中断，正在重试…" }
                        await recoverExitedGateway()
                    }
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
            } catch is CancellationError { }
            catch { starting = false; online = false; self.error = error.localizedDescription; message = "本机服务未连接" }
        }
    }
    func update(_ patch: [String: Any]) {
        guard online, !saving else { return }; saving = true
        Task {
            defer { saving = false }
            do { preferences = try JSONDecoder().decode(Preferences.self, from: await fetch("api/v1/settings", patch: patch)); message = "设置已保存" }
            catch { self.error = error.localizedDescription }
        }
    }
    func configurationRequest(_ path:String, body:[String:Any]?=nil, method:String="PATCH") async throws -> Data {
        try await fetch(path,patch:body,method:method)
    }
    func pollConnection() async {
        guard let data = try? await fetch("api/v1/connection"), let value = try? JSONDecoder().decode(RemoteConnectionStatus.self, from: data) else { return }
        if value != connectionStatus { connectionStatus = value }
    }
    func provisionLAN(host: String, transport: String) {
        guard online, !networkSaving else { return }; networkSaving = true; networkMessage = "正在通过 USB 配对局域网主机…"
        Task {
            defer { networkSaving = false }
            do {
                _ = try await fetch("api/v1/settings", patch: ["device":["transport":transport == "auto" ? "auto" : "wifi"]])
                _ = try await fetch("api/v1/connection/lan", patch: ["host":host],method:"POST")
                networkMessage = "配对信息已提交，等待板子保存。"; await pollConnection()
            } catch { networkMessage = "配对未完成：请确认 USB 桥接正在运行，并选择本机的局域网地址。" }
        }
    }
    func provisionWiFi(ssid: String, password: String) {
        guard online, !networkSaving else { return }; networkSaving = true; networkMessage = "正在通过 USB 配网…"
        Task { defer { networkSaving = false }
            do {
                _ = try await fetch("api/v1/connection/wifi", patch: ["ssid":ssid,"password":password], method:"POST")
                networkMessage = "已提交，请等待板子保存并连接热点。"; await pollConnection()
            } catch { networkMessage = "配网未提交：请确认 USB 配网桥接正在运行、热点密码至少 8 位。" }
        }
    }
    func openPreview() {
        if let preview, preview.isRunning { NSRunningApplication(processIdentifier: preview.processIdentifier)?.activate(options: [.activateIgnoringOtherApps]); return }
        do {
            let child = Process(); child.executableURL = try resource("agent-companion-preview")
            child.arguments = ["--gateway", base.absoluteString, "--token-file", runtime.appendingPathComponent("gateway.token").path]
            child.standardOutput = logHandle; child.standardError = logHandle
            child.terminationHandler = { [weak self] child in
                Task { @MainActor [weak self] in
                    guard let self, self.preview?.processIdentifier == child.processIdentifier else { return }
                    self.preview = nil; self.previewRunning = false
                    if child.terminationReason == .uncaughtSignal && child.terminationStatus != 15 {
                        self.error = "屏幕预览被系统终止（信号 \(child.terminationStatus)），请重新构建或安装应用。"
                    }
                }
            }
            try child.run(); preview = child; previewRunning = true
        } catch { self.error = error.localizedDescription }
    }
    private func pollAssistant() async {
        guard let bytes = try? await fetch("api/v1/assistant"), let value = try? JSONDecoder().decode(AssistantFeed.self, from: bytes) else { return }
        if value != assistantFeed { assistantFeed = value }
        var updated = assistantMessages
        for item in value.messages {
            if let index = updated.firstIndex(where: { $0.id == item.id }) { updated[index] = item } else { updated.append(item) }
        }
        updated = Array(updated.suffix(40))
        if updated != assistantMessages { assistantMessages = updated }
    }
    private func assistantAction(_ path: String, body: [String: Any], method: String = "POST") {
        guard online, !assistantSending else { return }; assistantSending = true
        Task { defer { assistantSending = false }
            do { _ = try await fetch(path, patch: body, method: method); await pollAssistant() }
            catch { self.error = error.localizedDescription }
        }
    }
    func refreshAssistant() { assistantAction("api/v1/assistant/refresh", body: [:]) }
    func askAssistant(_ question: String) { assistantAction("api/v1/assistant/chat", body: ["text": question]) }
    func updateAssistant(_ patch: [String: Any]) { assistantAction("api/v1/assistant/config", body: patch, method: "PATCH") }
    func readAssistantMemory() async throws -> AssistantMemoryState {
        try JSONDecoder().decode(AssistantMemoryState.self, from: await fetch("api/v1/assistant/memory"))
    }
    func editAssistantMemory(_ path: String, _ body: [String: Any], _ method: String) async throws -> AssistantMemoryState {
        let data = try await fetch("api/v1/assistant/" + path, patch: body, method: method)
        let value = try JSONDecoder().decode(AssistantMemoryState.self, from: data)
        await pollAssistant(); return value
    }
    func assistantEvidence(_ id: String) async -> AssistantEvidence? {
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),let bytes = try? await fetch("api/v1/assistant/evidence/" + encoded) else { return nil }
        return try? JSONDecoder().decode(AssistantEvidence.self, from: bytes)
    }
    func loadAssistantHistory() {
        Task { guard let bytes = try? await fetch("api/v1/assistant/messages"),let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],let messages = data["messages"],let encoded = try? JSONSerialization.data(withJSONObject: messages),let history = try? JSONDecoder().decode([AssistantMessage].self, from: encoded) else { return }; assistantMessages = history }
    }
    func closePreview() {
        if preview?.isRunning == true { preview?.terminate() }
    }
    func stop() {
        displayMonitor?.stop(); displayMonitor = nil
        displayPostTask?.cancel(); displayPostTask = nil; queuedDisplay = nil
        pollTask?.cancel(); pollTask = nil
        if preview?.isRunning == true { preview?.terminate() }
        if gateway?.isRunning == true { gateway?.terminate() }
        try? logHandle?.close(); logHandle = nil
    }
}
final class AppDelegate: NSObject, NSApplicationDelegate {
    var model: CompanionModel?
    func applicationWillTerminate(_ notification: Notification) { MainActor.assumeIsolated { model?.stop() } }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct ControlPanel: View {
    @EnvironmentObject var model: CompanionModel
    @State private var brightness = 75.0
    private var section: Section { model.selected }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: model.theme == .neumorphism ? 16 : 8) {
                HStack { Image(systemName: "sparkles.tv").font(.title2); Text("COMPANION").font(.headline) }.foregroundStyle(model.theme.accent).padding(.bottom, 22)
                ForEach(Section.allCases) { item in
                    Button { model.selected = item } label: {
                        Label(item.rawValue, systemImage: item.symbol).frame(maxWidth: .infinity, alignment: .leading).padding(11)
                            .background { if model.theme != .neon || section == item { CompanionSurface(theme:model.theme, selected:section == item) } }
                    }.buttonStyle(.plain).accessibilityIdentifier("nav-" + item.id)
                }
                Spacer()
                Label(model.online ? "本机服务已连接" : "本机服务未连接", systemImage: "circle.fill").font(.caption).foregroundStyle(model.online ? model.theme.success : model.theme.muted)
                Text("Mac 控制端 · 开发版 " + (Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "")).font(.caption2).foregroundStyle(model.theme.muted)
            }.padding(20).frame(width: 190).background(model.theme.surface)
            if model.theme == .comic {Color(hex:0x1a1a1a).frame(width:4)} else if model.theme == .neon {Divider()}
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack { VStack(alignment: .leading, spacing: 7) { Text(section.rawValue).font(.system(size: 28, weight: model.theme == .comic ? .black : .semibold)); Text(subtitle).foregroundStyle(model.theme.muted) }; Spacer()
                        if model.previewRunning {
                            Button("关闭屏幕预览") { model.closePreview() }.accessibilityIdentifier("close-preview")
                        }
                        Button(model.previewRunning ? "显示屏幕预览" : "打开屏幕预览") { model.openPreview() }.disabled(!model.online).accessibilityIdentifier("open-preview")
                    }
                    if model.starting { ProgressView("正在启动本机服务…") }
                    switch section {
                    case .overview: overview
                    case .assistant: AssistantPanel()
                    case .integrations: IntegrationSettingsPanel()
                    case .appearance: appearance
                    case .agents: agentSelection
                    case .device: device
                    case .connection: ConnectionPanel()
                    }
                    Spacer(minLength: 12)
                    Text(model.saving ? "正在保存…" : model.message).font(.caption).foregroundStyle(model.theme.muted)
                }.padding(32).frame(maxWidth: 900, alignment: .leading)
            }.frame(maxWidth: .infinity).background(ThemeBackdrop(theme:model.theme))
        }.frame(minWidth: 960, minHeight: 650)
            .font(.system(size: 13, weight: model.theme == .comic ? .bold : .regular, design: model.theme == .neon ? .monospaced : .default))
            .foregroundStyle(model.theme.text).buttonStyle(CompanionButtonStyle(theme:model.theme, motion:model.preferences.appearance.animations_enabled))
            .tint(model.theme.accent).preferredColorScheme(model.theme == .neon ? .dark : .light)
            .onAppear { refreshDraft(); model.start() }
            .onChange(of: model.preferences.device) { _ in refreshDraft() }
            .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("好") { model.error = nil } } message: { Text(model.error ?? "") }
    }
    private var subtitle: String {
        switch section { case .overview: return "本机采集、屏幕预览与设备连接"; case .assistant: return "汇总最近对话，查看项目进展与关注事项"; case .appearance: return "选择屏幕风格，设置会自动保存并同步至预览"; case .agents: return "选择 1–3 个 Agent，自动保存并同步到屏幕"; case .device: return "调整亮度，设置跟随 Mac 熄屏与唤醒"; case .connection: return "给屏幕配网，选择局域网或异地连接"; case .integrations: return "连接你的模型服务，按需启用余额查询" }
    }
    private func panel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 18) { Text(title).font(.headline); content() }.padding(22).frame(maxWidth: .infinity, alignment: .leading).background(CompanionSurface(theme:model.theme))
    }
    private var overview: some View {
        VStack(spacing: 20) {
            panel("本机服务") { Label(model.message, systemImage: model.online ? "checkmark.circle.fill" : "circle.dotted").foregroundStyle(model.online ? model.theme.success : model.theme.muted); Text("只读查看本机的 Codex、Grok Bot、DeepSeek Harness 和 Claude Code 记录；没有记录的来源会显示为未发现。").foregroundStyle(model.theme.muted) }
            panel("开始使用") { Text("先打开屏幕预览体验界面；连接硬件时，在“连接”中配网。AI 助手与余额查询可在“API 设置”中按需开启。").foregroundStyle(model.theme.muted); Button("配置 API") { model.selected = .integrations } }
            panel("桌面屏幕") { Label(model.connectionStatus?.data_fresh == true ? (model.connectionStatus?.active_transport == "wifi" ? "已通过局域网直连" : "已通过云中转连接") : "等待设备连接", systemImage: "display"); Text("同一 Wi-Fi 可直连 Mac，异地可用自建中转；支持跟随主屏亮度与熄屏。").foregroundStyle(model.theme.muted); Button("配置连接") { model.selected = .connection } }
        }
    }
    private var agentSelection: some View {
        panel("监控的 Agent · \(model.preferences.appearance.agent_ids.count)/3") {
            ForEach(["codex", "grok", "deepseek", "claude"], id: \.self) { id in
                let enabled = model.preferences.appearance.agent_ids.contains(id)
                Toggle(isOn: Binding(get: { enabled }, set: { on in
                    var ids = model.preferences.appearance.agent_ids
                    if on { ids.append(id) } else { ids.removeAll { $0 == id } }
                    model.update(["appearance": ["agent_ids": ids]])
                })) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(["codex": "Codex", "grok": "Grok", "deepseek": "DeepSeek", "claude": "Claude Code"][id] ?? id)
                        Text(["codex": "本机会话、用量与订阅额度", "grok": "Bot 名称与公开消息；展示 Bot 状态与最近消息；额度每5分钟读取。实时工作状态暂不可读，桌宠素材待接入", "deepseek": "Harness 会话与用量，余额可按需配置", "claude": "本机 Claude Code 记录，有真实记录后显示"][id] ?? "").font(.caption).foregroundStyle(model.theme.muted)
                    }
                }.disabled(!model.online || model.saving || (enabled ? model.preferences.appearance.agent_ids.count <= 1 : model.preferences.appearance.agent_ids.count >= 3))
                    .accessibilityIdentifier("agent-" + id)
            }
            Text("至少保留 1 个，最多选择 3 个。所选 Agent 会显示在小屏、Token 统计中，并纳入 AI 助手整理。取消选择不会停止原软件的任务。").font(.caption).foregroundStyle(model.theme.muted)
        }
    }
    private var appearance: some View {
        VStack(spacing: 22) {
            HStack(spacing: 14) {
                ForEach(Theme.allCases) { theme in
                    Button { model.update(["appearance": ["theme": theme.rawValue]]) } label: {
                        ThemeOptionCard(theme:theme, container:model.theme, selected:model.theme == theme, motion:model.preferences.appearance.animations_enabled)
                    }.buttonStyle(.plain).disabled(!model.online || model.saving).accessibilityIdentifier("theme-" + theme.rawValue)
                }
            }
            panel("动态效果") {
                Toggle("桌宠动作与界面过渡", isOn: Binding(get: { model.preferences.appearance.animations_enabled }, set: { model.update(["appearance": ["animations_enabled": $0]]) })).disabled(!model.online || model.saving)
                Text("关闭后保留状态与静态底座，停止动画和鼠标视差。").foregroundStyle(model.theme.muted)
            }
        }
    }
    private var device: some View {
        VStack(spacing: 20) {
            panel("会话显示") {
                Toggle("显示定时任务",isOn:Binding(get:{model.preferences.appearance.show_scheduled_tasks},set:{model.update(["appearance":["show_scheduled_tasks":$0]])})).disabled(!model.online || model.saving).accessibilityIdentifier("show-scheduled-tasks")
                Text("将启用的定时计划合并到小屏会话列表。关闭后保留真实会话，不会暂停或修改原任务。").font(.caption).foregroundStyle(model.theme.muted)
            }
            panel("跟随 Mac 显示器") {
                Toggle("同步主显示器亮度",isOn:Binding(get:{model.preferences.device.follow_host_brightness},set:{model.update(["device":["follow_host_brightness":$0]])})).disabled(!model.online || model.saving)
                Toggle("主显示器熄屏时，小屏同步熄屏",isOn:Binding(get:{model.preferences.device.follow_host_sleep},set:{model.update(["device":["follow_host_sleep":$0]])})).disabled(!model.online || model.saving)
                Text("主显示器唤醒后自动恢复小屏。只关闭背光，网络保持连接。").foregroundStyle(model.theme.muted)
                if let status = model.hostDisplayStatus {
                    Text(status.host?.display_name ?? "正在读取主显示器")
                    Text(status.brightness_available ? "主屏亮度 \(Int(((status.host?.brightness_ratio ?? 0)*100).rounded()))%" : "主屏亮度暂不可读，使用手动亮度").foregroundStyle(model.theme.muted)
                    Text(status.in_sync ? "板端已同步 · \(status.target.screen_on ? "亮度 \(status.target.brightness_percent)%" : "已熄屏")" : "等待板端同步回执").foregroundStyle(status.in_sync ? model.theme.accent : model.theme.muted)
                }
            }
            panel("手动亮度") {
                HStack { Text("屏幕亮度"); Spacer(); Text("\(Int(brightness))%") }
                Slider(value:$brightness,in:5...100,step:1).disabled(model.preferences.device.follow_host_brightness)
                Text("关闭主屏亮度同步后生效；主屏亮度不可读时，也会使用此设置。").font(.caption).foregroundStyle(model.theme.muted)
                Button("保存亮度") { model.update(["device":["brightness":Int(brightness)]]) }.disabled(!model.online || model.saving)
            }
        }
    }
    private func refreshDraft() { brightness = Double(model.preferences.device.brightness) }
}

@main struct AgentCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = CompanionModel()
    var body: some Scene {
        WindowGroup("Agent Companion") { ControlPanel().environmentObject(model).onAppear { delegate.model = model;styleWindow(); NSApp.activate(ignoringOtherApps: true) }.onChange(of:model.theme) {_ in styleWindow()} }
            .defaultSize(width: 1040, height: 700)
            .commands { CommandGroup(replacing: .newItem) {}; CommandGroup(after: .appInfo) { Button("打开屏幕预览") { model.openPreview() }.disabled(!model.online) } }
    }
    @MainActor private func styleWindow() {
        if let window=NSApp.windows.first(where:{$0.title == "Agent Companion"}) {
            window.titlebarAppearsTransparent=true;window.titlebarSeparatorStyle = .none;window.backgroundColor=NSColor(model.theme.background)
        }
    }
}
