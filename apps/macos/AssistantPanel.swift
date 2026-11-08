import SwiftUI

struct AssistantConfiguration: Codable, Equatable {
    var enabled: Bool; var auto_refresh: Bool; var base_url: String; var model: String
    var refresh_seconds: Int; var max_sessions: Int; var recent_days: Int; var daily_request_limit: Int; var has_key: Bool
}
struct AssistantMessage: Codable, Equatable, Identifiable {
    var id: String; var role: String; var kind: String; var text: String; var created_at: String; var source_ids: [String]
}
struct AssistantCoverage: Codable, Equatable {
    var generated_at: String; var recent_days: Int; var discovered: Int; var selected: Int; var read: Int; var unavailable: Int; var partial: Bool; var note: String
}
struct AssistantUsage: Codable, Equatable { var requests: Int; var input_tokens: Int; var output_tokens: Int }
struct AssistantRecovery: Codable, Equatable { var consecutive_failures: Int; var last_error: String?; var last_failed_at: String?; var next_retry_at: String? }
struct AssistantRuntime: Codable, Equatable { var chat_engine: String; var briefing_engine: String; var memory_count: Int; var persona_revision: Int; var history_token_budget: Int? }
struct AssistantAutomation: Codable, Equatable { var engine: String; var scan_seconds: Int; var merge_seconds: Int; var max_wait_seconds: Int; var pending_events: Int; var queued_jobs: Int; var events_seen: Int; var suppressed_batches: Int; var last_scan_at: String?; var last_published_at: String?; var attention_open: Int }
struct AssistantAttention: Codable, Equatable, Identifiable { var id: String; var text: String; var source_ids: [String]; var updated_at: String }
struct AssistantPersona: Codable { var id: String; var revision: Int; var instructions: String }
struct AssistantSavedMemory: Codable, Identifiable { var id: String; var text: String; var updated_at: String }
struct AssistantMemoryState: Codable { var revision: Int; var persona: AssistantPersona; var items: [AssistantSavedMemory] }
struct AssistantHistoricalMemory: Codable, Equatable { var events: Int }
struct AssistantHistoricalEvent: Codable, Equatable, Identifiable {
    var id: String; var session_id: String; var project_id: String; var topic_key: String; var kind: String
    var title: String; var text: String; var stage: String; var status: String?; var source_at: String?; var recorded_at: String; var source_ids: [String]
}
struct AssistantHistoryResults: Codable { var items: [AssistantHistoricalEvent]; var total: Int; var has_more: Bool }
struct AssistantFeed: Codable, Equatable {
    var revision: Int; var status: String; var model: String; var last_error: String?
    var recovery: AssistantRecovery?
    var configuration: AssistantConfiguration; var usage: AssistantUsage; var messages: [AssistantMessage]; var coverage: AssistantCoverage?
    var runtime: AssistantRuntime?
    var automation: AssistantAutomation?
    var attention_items: [AssistantAttention]?
    var historical_memory: AssistantHistoricalMemory?
}
struct AssistantEvidence: Codable, Identifiable { var id: String; var session_id: String; var title: String; var role: String; var timestamp: String?; var text: String }

struct AssistantPanel: View {
    @EnvironmentObject var model: CompanionModel
    @State private var question = ""
    @State private var source: AssistantEvidence?
    @State private var showMemory = false
    @State private var showHistoricalEvents = false
    private var feed: AssistantFeed? { model.assistantFeed }
    private var busy: Bool { model.assistantSending || feed?.status == "updating" }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            block("项目管家") {
                HStack {
                    Label(status, systemImage: busy ? "hourglass" : "sparkles").foregroundStyle(model.theme.accent)
                    Spacer()
                    Button { showHistoricalEvents = true } label: { Label("历史事件", systemImage: "clock.arrow.circlepath") }.disabled(!model.online).accessibilityIdentifier("assistant-history-events")
                    Button("人格与记忆") { showMemory = true }.disabled(busy || !model.online).accessibilityIdentifier("assistant-memory")
                    Button("更新简报") { model.refreshAssistant() }.disabled(busy || (feed?.configuration.enabled != true || feed?.configuration.has_key != true)).accessibilityIdentifier("assistant-refresh")
                }
                if feed?.status == "unconfigured" {
                    Text("填写模型接口后，即可整理最近对话、查看关注事项和追问进展。").foregroundStyle(model.theme.muted)
                    Button("设置模型 API") { model.selected = .integrations }
                }
                if let feed {
                    HStack {
                        Toggle("自动整理新对话", isOn: Binding(get: { feed.configuration.auto_refresh }, set: { model.updateAssistant(["auto_refresh": $0]) })).disabled(busy)
                        Spacer()
                        Text("今日 \(feed.usage.requests)/\(feed.configuration.daily_request_limit) 次").font(.caption).foregroundStyle(model.theme.muted)
                    }
                    Text("有新对话时自动整理，关键进展会同步到小屏。").font(.caption).foregroundStyle(model.theme.muted)
                    if let coverage = feed.coverage {
                        Text("近 \(coverage.recent_days) 天 · 已读 \(coverage.read)/\(coverage.discovered) 个活跃会话 · 更新于 \(displayTime(coverage.generated_at))").font(.caption)
                        if coverage.partial { Text("本轮分析公开正文节选；长会话采用开头与近期片段，尚未覆盖完整历史。").font(.caption).foregroundStyle(model.theme.muted) }
                    }
                    if let code = feed.last_error { Text(errorText(code)).foregroundStyle(model.theme.accent) }
                    if feed.configuration.auto_refresh, let retry = feed.recovery?.next_retry_at {
                        Text("自动整理最早于 \(displayTime(retry)) 重试；也可点击“更新简报”立即重试。").font(.caption).foregroundStyle(model.theme.muted)
                    }
                } else { Text("正在读取助手状态…").foregroundStyle(model.theme.muted) }
            }
            if let items = feed?.attention_items, !items.isEmpty {
                block("需要关注") {
                    ForEach(items) { item in
                        HStack(alignment: .top) {
                            Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            if let id = item.source_ids.first { Button("来源") { Task { source = await model.assistantEvidence(id) } } }
                        }
                    }
                    Text("只在明确的新证据表明解决后关闭事项；来源中的Agent报告仍需区分实际验收。").font(.caption).foregroundStyle(model.theme.muted)
                }
            }
            block("与助手对话") {
                HStack(alignment: .bottom) {
                    TextField("例如：有哪些事项需要我关注？", text: $question, axis: .vertical).lineLimit(1...4).textFieldStyle(.plain).padding(10)
                        .background(CompanionSurface(theme: model.theme, selected: false, insetDepth: 3)).onSubmit(send).accessibilityIdentifier("assistant-question")
                    Button("发送", action: send).disabled(busy || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (feed?.configuration.enabled != true || feed?.configuration.has_key != true)).accessibilityIdentifier("assistant-send")
                }
                if busy { ProgressView("正在整理或回答…") }
                Text("可追问以前的实验结果、决策和失败原因，助手会查找相关历史来源；长期偏好在“人格与记忆”中保存。").font(.caption).foregroundStyle(model.theme.muted)
                if let historical = feed?.historical_memory { Text("已保存 \(historical.events) 条历史事件，可在“历史事件”中搜索。").font(.caption).foregroundStyle(model.theme.muted) }
            }
            if model.assistantMessages.isEmpty {
                block("还没有助手消息") { Text("点击“更新简报”读取最近对话；结果也会同步到桌面屏幕的底部消息区。").foregroundStyle(model.theme.muted) }
            }
            ForEach(model.assistantMessages.reversed()) { message in
                block(message.role == "user" ? "你" : message.kind == "briefing" ? "项目简报" : "助手回复") {
                    Text(displayTime(message.created_at)).font(.caption).foregroundStyle(model.theme.muted)
                    Text(message.text).textSelection(.enabled).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                    if !message.source_ids.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                ForEach(Array(message.source_ids.enumerated()), id: \.element) { index, id in
                                    Button("来源 \(index + 1)") { Task { source = await model.assistantEvidence(id) } }
                                        .accessibilityIdentifier("assistant-source-\(message.id)-\(id)")
                                }
                            }
                        }
                    }
                }
            }
            Button("加载最近 40 条消息") { model.loadAssistantHistory() }.disabled(!model.online).accessibilityIdentifier("assistant-history")
        }
        .sheet(item: $source) { item in
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text(item.title).font(.headline); Spacer(); Button("关闭") { source = nil } }
                Text("\(item.role == "user" ? "用户" : "Agent")公开正文节选 · \(displayTime(item.timestamp ?? ""))").font(.caption)
                ScrollView { Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).lineSpacing(5) }
            }.padding(24).frame(width: 700, height: 470)
        }
        .sheet(isPresented: $showMemory) { AssistantMemoryPanel().environmentObject(model) }
        .sheet(isPresented: $showHistoricalEvents) { AssistantHistoryPanel().environmentObject(model) }
    }
    private var status: String {
        switch feed?.status { case "ready": return "助手已连接"; case "updating": return "正在更新"; case "failed": return "本轮未完成，保留已有消息"; case "unconfigured": return "助手尚未启用"; default: return "连接中" }
    }
    private func send() {
        let value = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !busy else { return }; model.askAssistant(value); question = ""
    }
    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) { Text(title).font(.headline); content() }.padding(22).frame(maxWidth: .infinity, alignment: .leading).background(CompanionSurface(theme: model.theme))
    }
    private func displayTime(_ value: String) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    private func errorText(_ code: String) -> String {
        switch code {
        case "daily_request_limit": return "已达到今日调用上限，保留已有记录。"
        case "invalid_source_reference", "invalid_model_output": return "本次回答未通过来源检查，可稍后更新简报。"
        case "no_readable_sources": return "当前没有可读取的最近会话正文。"
        case "provider_http_401", "provider_http_403": return "模型接口鉴权失败，请检查本机助手凭据。"
        case "provider_no_accounts": return "模型服务暂时没有可用账号，请检查 API 服务端的账号状态；已有简报已保留。"
        case "provider_http_503": return "模型服务暂时不可用，稍后自动重试；已有简报已保留。"
        case "provider_http_429": return "模型服务请求受限，稍后自动重试。"
        case "provider_timeout": return "模型服务响应超时，稍后自动重试。"
        case "provider_network_error": return "暂时无法连接模型服务，请检查网络或 API 地址。"
        default: return "本轮请求未完成，已有简报仍可查看。"
        }
    }
}

struct AssistantHistoryPanel: View {
    @EnvironmentObject var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var kind = ""
    @State private var items: [AssistantHistoricalEvent] = []
    @State private var total = 0
    @State private var hasMore = false
    @State private var loading = false
    @State private var searched = false
    @State private var requestID = 0
    @State private var appliedQuery = ""
    @State private var appliedKind = ""
    @State private var selectedID: String?
    @State private var detail: AssistantHistoricalEvent?
    @State private var source: AssistantEvidence?
    @State private var error: String?
    private let kinds = [("", "全部"), ("result", "实验与结果"), ("decision", "决策"), ("failure", "失败与阻塞"), ("resolution", "解决记录"), ("milestone", "里程碑"), ("summary", "历史摘要")]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Text("历史事件").font(.title2.bold()); Spacer(); Button("完成") { dismiss() } }
            Text("查找过去的实验结果、决策和失败原因。搜索不消耗 API Token；记录来自已整理的公开对话，未覆盖全部历史。").font(.caption).foregroundStyle(model.theme.muted)
            HStack {
                TextField("关键词，例如实验编号、显存不足、方案选择", text: $query).textFieldStyle(.roundedBorder).onSubmit { Task { await search() } }.accessibilityIdentifier("assistant-events-query")
                Picker("类型", selection: $kind) { ForEach(kinds, id: \.0) { value in Text(value.1).tag(value.0) } }.frame(width: 175).accessibilityIdentifier("assistant-events-kind")
                Button("搜索") { Task { await search() } }.disabled(loading).accessibilityIdentifier("assistant-events-search")
            }
            HStack {
                Text("\(total) 条匹配记录").font(.caption).foregroundStyle(model.theme.muted)
                if loading { ProgressView().controlSize(.small) }
                if let error { Text(error).font(.caption).foregroundStyle(model.theme.accent) }
            }
            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if searched && items.isEmpty { Text("没有找到相关记录，可换关键词或事件类型。").foregroundStyle(model.theme.muted).padding(12) }
                        ForEach(items) { item in
                            Button { select(item) } label: {
                                VStack(alignment: .leading, spacing: 7) {
                                    HStack { Text(kindName(item.kind)).font(.caption.bold()); Spacer(); Text(time(item.source_at)).font(.caption2) }
                                    Text(item.title).font(.caption).foregroundStyle(model.theme.muted).lineLimit(1)
                                    Text(item.text).lineLimit(4).frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(12).background(CompanionSurface(theme: model.theme, selected: selectedID == item.id))
                            }.buttonStyle(.plain).accessibilityIdentifier("assistant-event-\(item.id)")
                        }
                        if hasMore { Button("加载更多") { Task { await search(append: true) } }.disabled(loading) }
                    }.padding(.trailing, 8)
                }.frame(minWidth: 275, idealWidth: 320)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let item = detail {
                            Text(item.title).font(.headline)
                            Text("\(kindName(item.kind)) · \(time(item.source_at))").font(.caption).foregroundStyle(model.theme.muted)
                            Text(stageName(item.stage) + (item.status == "open" ? " · 当时待处理" : item.status == "resolved" ? " · 当时已解决" : "")).font(.caption)
                            Text(item.text).textSelection(.enabled).lineSpacing(5)
                            Text("这是历史记录，当前状态应以较新的对话和验收为准。").font(.caption).foregroundStyle(model.theme.muted)
                            ForEach(Array(item.source_ids.enumerated()), id: \.element) { index, id in
                                Button("查看来源 \(index + 1)") { Task { source = await model.assistantEvidence(id) } }
                            }
                        } else { Text(selectedID == nil ? "选择一条记录查看详情和来源。" : "正在读取详情…").foregroundStyle(model.theme.muted) }
                    }.padding(.leading, 14).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 300)
            }
        }.padding(24).frame(width: 860, height: 650)
        .task { await search() }
        .onChange(of: kind) { _ in Task { await search() } }
        .sheet(item: $source) { item in
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text(item.title).font(.headline); Spacer(); Button("关闭") { source = nil } }
                Text("\(item.role == "user" ? "用户" : "Agent")公开正文节选 · \(time(item.timestamp))").font(.caption)
                ScrollView { Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding(24).frame(width: 700, height: 470)
        }
    }
    private func search(append: Bool = false) async {
        requestID += 1; let active = requestID
        let extending = append && query == appliedQuery && kind == appliedKind
        let searchingQuery = query, searchingKind = kind
        loading = true; error = nil
        defer { if requestID == active { loading = false } }
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "query", value: query), URLQueryItem(name: "limit", value: "20"), URLQueryItem(name: "offset", value: extending ? String(items.count) : "0")]
        if !kind.isEmpty { components.queryItems?.append(URLQueryItem(name: "kind", value: kind)) }
        do {
            let data = try await model.configurationRequest("api/v1/assistant/history?" + (components.percentEncodedQuery ?? ""), method: "GET")
            let result = try JSONDecoder().decode(AssistantHistoryResults.self, from: data)
            guard requestID == active else { return }
            items = extending ? items + result.items : result.items; total = result.total; hasMore = result.has_more; searched = true
            appliedQuery = searchingQuery; appliedKind = searchingKind
            if !extending { selectedID = nil; detail = nil }
        } catch { if requestID == active { self.error = "查询失败，请确认本机服务已连接，关键词不超过 300 字。" } }
    }
    private func select(_ item: AssistantHistoricalEvent) {
        selectedID = item.id; detail = nil; error = nil
        Task {
            do {
                let data = try await model.configurationRequest("api/v1/assistant/history/" + item.id, method: "GET")
                let event = try JSONDecoder().decode(AssistantHistoricalEvent.self, from: data)
                if selectedID == item.id { detail = event }
            } catch { if selectedID == item.id { self.error = "读取事件详情失败。" } }
        }
    }
    private func kindName(_ value: String) -> String { kinds.first(where: { $0.0 == value })?.1 ?? value }
    private func stageName(_ value: String) -> String { ["planned": "计划", "reported": "来源报告", "verified": "来源标记已验证", "accepted": "来源标记已验收"][value] ?? value }
    private func time(_ value: String?) -> String {
        guard let value else { return "来源时间不明" }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

struct AssistantMemoryPanel: View {
    @EnvironmentObject var model: CompanionModel
    @Environment(\.dismiss) private var dismiss
    @State private var state: AssistantMemoryState?
    @State private var persona = ""
    @State private var preference = ""
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("人格与记忆").font(.title2.bold()); Spacer(); Button("完成") { dismiss() }.disabled(saving) }
            Text("设置助手的语气和明确的长期偏好；监控中的项目资料单独处理。").font(.caption).foregroundStyle(model.theme.muted)
            Text("人格与语气").font(.headline)
            TextEditor(text: $persona).font(.body).frame(height: 90).padding(7).background(CompanionSurface(theme: model.theme)).accessibilityIdentifier("assistant-persona-text")
            HStack { Text("最多 1,200 字；保存后下次回答生效。").font(.caption).foregroundStyle(model.theme.muted); Spacer(); Button("保存人格") { edit("persona", ["instructions": persona], "PATCH") }.disabled(saving || persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state == nil).accessibilityIdentifier("assistant-persona-save") }
            Divider()
            Text("长期偏好（\(state?.items.count ?? 0)/64）").font(.headline)
            HStack {
                TextField("例如：称呼我为小高，回答先给结论。", text: $preference).textFieldStyle(.roundedBorder).accessibilityIdentifier("assistant-memory-text")
                Button("记住") { edit("memory", ["text": preference], "POST") }.disabled(saving || preference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state == nil).accessibilityIdentifier("assistant-memory-add")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if state?.items.isEmpty == true { Text("还没有保存的偏好。").foregroundStyle(model.theme.muted) }
                    ForEach(state?.items ?? []) { item in
                        HStack(alignment: .top) {
                            Text(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            Button("删除") { edit("memory", ["id": item.id], "DELETE") }.disabled(saving).accessibilityIdentifier("assistant-memory-delete-\(item.id)")
                        }.padding(12).background(CompanionSurface(theme: model.theme))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(minHeight: 100)
            Text("删除后将停止向模型提供该偏好，并重置近期对话上下文以避免重新带入；原始消息仍可在历史中查看。此处不保存密钥。").font(.caption).foregroundStyle(model.theme.muted)
            if saving { ProgressView("正在保存…") }
            if let error { Text(error).font(.caption).foregroundStyle(model.theme.accent) }
        }.padding(24).frame(width: 660, height: 620)
        .task {
            do { let value = try await model.readAssistantMemory(); state = value; persona = value.persona.instructions }
            catch { self.error = "读取记忆失败，请确认助手已连接。" }
        }
    }
    private func edit(_ path: String, _ body: [String: Any], _ method: String) {
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                state = try await model.editAssistantMemory(path, body, method)
                if path == "memory" && method == "POST" { preference = "" }
            } catch { self.error = "未保存。请检查字数、连接状态，且不要填写密钥；助手忙时请稍后重试。" }
        }
    }
}
