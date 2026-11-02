import SwiftUI

struct CredentialStatus: Codable { var assistant: Bool; var deepseek: Bool }
struct IntegrationSettingsPanel: View {
    @EnvironmentObject var model: CompanionModel
    @State private var baseURL = ""
    @State private var modelName = ""
    @State private var assistantKey = ""
    @State private var deepseekKey = ""
    @State private var enabled = false
    @State private var autoRefresh = true
    @State private var saving = false
    @State private var loaded = false
    @State private var hasAssistantKey = false
    @State private var hasDeepseekKey = false
    @State private var dailyLimit = 48
    @State private var recentDays = 7
    @State private var maxSessions = 8
    @State private var notice = ""
    var body: some View {
        VStack(alignment:.leading,spacing:20) {
            card("AI 助手") {
                Text("支持 OpenAI 兼容的 Chat Completions 接口。开启后，会将最近对话的正文节选发送到你选择的模型服务。").foregroundStyle(model.theme.muted)
                TextField("API 地址，例如 https://api.example.com/v1",text:$baseURL).textFieldStyle(.roundedBorder).accessibilityIdentifier("assistant-api-url")
                TextField("模型名称（按服务商提供的名称填写）",text:$modelName).textFieldStyle(.roundedBorder).accessibilityIdentifier("assistant-api-model")
                SecureField(hasAssistantKey ? "API Key 已保存，留空保留原值" : "API Key",text:$assistantKey).textFieldStyle(.roundedBorder).accessibilityIdentifier("assistant-api-key")
                Toggle("启用 AI 助手",isOn:$enabled)
                Toggle("自动整理新对话",isOn:$autoRefresh).disabled(!enabled)
                DisclosureGroup("整理范围与用量上限") {
                    VStack(alignment:.leading,spacing:12) {
                        Stepper("最近 \(recentDays) 天",value:$recentDays,in:1...30)
                        Stepper("每次最多 \(maxSessions) 个会话",value:$maxSessions,in:1...16)
                        Stepper("每日最多 \(dailyLimit) 次模型请求",value:$dailyLimit,in:1...200)
                        Text("对话和自动简报共用此上限；达到上限后保留已有消息。").font(.caption).foregroundStyle(model.theme.muted)
                    }.padding(.top,10)
                }
                HStack {
                    Button("保存助手设置") { saveAssistant() }.accessibilityIdentifier("assistant-api-save")
                    if hasAssistantKey { Button("清除 Key") { clearKey("assistant") } }
                }
            }
            card("DeepSeek 余额") {
                Text("仅用于查询 DeepSeek 官方 API 账户余额。会话监控不需要 Key；余额也不代表订阅额度。").foregroundStyle(model.theme.muted)
                SecureField(hasDeepseekKey ? "Key 已保存，输入新 Key 可替换" : "DeepSeek API Key",text:$deepseekKey).textFieldStyle(.roundedBorder).accessibilityIdentifier("deepseek-api-key")
                HStack {
                    Button("保存余额查询 Key") { saveDeepseek() }.disabled(deepseekKey.isEmpty).accessibilityIdentifier("deepseek-api-save")
                    if hasDeepseekKey { Button("清除 Key") { clearKey("deepseek") } }
                    Text(hasDeepseekKey ? "已配置 · 每分钟更新余额" : "未配置").font(.caption).foregroundStyle(model.theme.muted)
                }
            }
            Label("密钥仅保存在当前 Mac 的私有配置目录，不会同步到板子或中转服务器。",systemImage:"lock.shield").font(.caption).foregroundStyle(model.theme.muted)
            if !notice.isEmpty { Text(notice).foregroundStyle(model.theme.accent).accessibilityIdentifier("integration-notice") }
        }.disabled(saving || !model.online || !loaded).task(id:model.online) { if model.online { await load() } }
    }
    private func card<Content:View>(_ title:String,@ViewBuilder content:()->Content)->some View {
        VStack(alignment:.leading,spacing:16){Text(title).font(.headline);content()}.padding(22).frame(maxWidth:.infinity,alignment:.leading).background(CompanionSurface(theme:model.theme))
    }
    private func load() async {
        do {
            let config=try JSONDecoder().decode(AssistantConfiguration.self,from:await model.configurationRequest("api/v1/assistant/config"))
            let keys=try JSONDecoder().decode(CredentialStatus.self,from:await model.configurationRequest("api/v1/credentials"))
            baseURL=config.base_url;modelName=config.model;enabled=config.enabled;autoRefresh=config.auto_refresh
            dailyLimit=config.daily_request_limit;recentDays=config.recent_days;maxSessions=config.max_sessions
            hasAssistantKey=keys.assistant;hasDeepseekKey=keys.deepseek;loaded=true
        } catch { notice="设置暂时不可用，请确认本机服务已连接。" }
    }
    private func saveAssistant() {
        let address=baseURL.trimmingCharacters(in:.whitespacesAndNewlines),name=modelName.trimmingCharacters(in:.whitespacesAndNewlines)
        if enabled && (name.isEmpty || URL(string:address)?.scheme != "https" || (!hasAssistantKey && assistantKey.isEmpty)) { notice="请填写 HTTPS API 地址、模型名称和 API Key。";return }
        saving=true
        Task { defer { saving=false }
            do {
                if !assistantKey.isEmpty {
                    _=try await model.configurationRequest("api/v1/credentials",body:["service":"assistant","key":assistantKey]);hasAssistantKey=true;assistantKey=""
                }
                _=try await model.configurationRequest("api/v1/assistant/config",body:["enabled":enabled,"auto_refresh":autoRefresh,"base_url":address,"model":name,"daily_request_limit":dailyLimit,"recent_days":recentDays,"max_sessions":maxSessions])
                notice="助手设置已保存。"
            } catch { notice="未能保存完整设置。请检查地址和模型名称；若助手正在整理，请稍后重试。" }
        }
    }
    private func saveDeepseek() {
        saving=true
        Task { defer { saving=false }
            do {
                _=try await model.configurationRequest("api/v1/credentials",body:["service":"deepseek","key":deepseekKey]);hasDeepseekKey=true;deepseekKey="";notice="Key 已保存，余额将在下一次采集中更新。"
            } catch { notice="保存失败，请检查 DeepSeek API Key 的格式。" }
        }
    }
    private func clearKey(_ service:String) {
        saving=true
        Task { defer { saving=false }
            do {
                _=try await model.configurationRequest("api/v1/credentials",body:["service":service,"key":NSNull()])
                if service=="assistant" {hasAssistantKey=false;assistantKey=""} else {hasDeepseekKey=false;deepseekKey=""}
                notice="Key 已清除。"
            } catch { notice="清除失败，请稍后重试。" }
        }
    }
}
