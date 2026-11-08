import SwiftUI

struct SpeechConfiguration: Codable {
    var enabled = false, provider = "system", base_url = "", model = "", voice = ""
    var has_key = false
    var requests_this_run = 0
}
struct CredentialStatus: Codable { var assistant: Bool; var deepseek: Bool }
struct IntegrationSettingsPanel: View {
    @EnvironmentObject var model: CompanionModel
    @State private var baseURL = ""
    @State private var modelName = ""
    @State private var assistantKey = ""
    @State private var deepseekKey = ""
    @State private var speech = SpeechConfiguration()
    @State private var speechKey = ""
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
            card("语音合成（TTS）") {
                Text("只将最终播报短文发送给语音服务；与助手整理分开开关。保存地址、模型和 Key 不会调用 TTS。").foregroundStyle(model.theme.muted)
                Picker("语音来源",selection:$speech.provider) {
                    Text("Mac 系统语音").tag("system")
                    Text("阿里云百炼").tag("bailian")
                }
                if speech.provider == "bailian" {
                    TextField("服务根地址，例如 https://dashscope.aliyuncs.com",text:$speech.base_url).textFieldStyle(.roundedBorder).accessibilityIdentifier("tts-api-url")
                    TextField("语音模型名称",text:$speech.model).textFieldStyle(.roundedBorder).accessibilityIdentifier("tts-api-model")
                    TextField("音色 ID，接上扬声器后再选择",text:$speech.voice).textFieldStyle(.roundedBorder).accessibilityIdentifier("tts-api-voice")
                    SecureField(speech.has_key ? "TTS Key 已保存，留空保留原值" : "TTS API Key",text:$speechKey).textFieldStyle(.roundedBorder).accessibilityIdentifier("tts-api-key")
                }
                Toggle("启用语音生成",isOn:$speech.enabled).accessibilityIdentifier("tts-enabled")
                HStack {
                    Button("保存语音设置") { saveSpeech() }.accessibilityIdentifier("tts-api-save")
                    if speech.has_key { Button("清除 TTS Key") { clearKey("tts") } }
                }
                Text(speech.enabled ? "语音生成已开启；待播消息可生成音频。" : "语音生成已关闭，不调用语音接口。接好扬声器后再开启测试。")
                    .font(.caption).foregroundStyle(model.theme.muted)
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
            speech=try JSONDecoder().decode(SpeechConfiguration.self,from:await model.configurationRequest("api/v1/voice/provider"))
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
                _=try await model.configurationRequest("api/v1/assistant/config",body:["enabled":false])
                if !assistantKey.isEmpty {
                    _=try await model.configurationRequest("api/v1/credentials",body:["service":"assistant","key":assistantKey]);hasAssistantKey=true;assistantKey=""
                }
                _=try await model.configurationRequest("api/v1/assistant/config",body:["enabled":enabled,"auto_refresh":autoRefresh,"base_url":address,"model":name,"daily_request_limit":dailyLimit,"recent_days":recentDays,"max_sessions":maxSessions])
                notice="助手设置已保存。"
            } catch { notice="未能保存完整设置。请检查地址和模型名称；若助手正在整理，请稍后重试。" }
        }
    }
    private func saveSpeech() {
        if speech.enabled && speech.provider == "bailian" && (speech.model.isEmpty || speech.voice.isEmpty || (!speech.has_key && speechKey.isEmpty)) { notice="请先填写语音模型、音色 ID 和 Key；也可保持关闭只保存配置。";return }
        saving=true
        Task { defer { saving=false };do {
            // Disable generation before key/provider edits to prevent cross-provider calls.
            _=try await model.configurationRequest("api/v1/voice/provider",body:["enabled":false])
            if !speechKey.isEmpty { _=try await model.configurationRequest("api/v1/credentials",body:["service":"tts","key":speechKey]);speechKey="" }
            let data=try await model.configurationRequest("api/v1/voice/provider",body:["enabled":speech.enabled,"provider":speech.provider,"base_url":speech.base_url,"model":speech.model,"voice":speech.voice])
            speech=try JSONDecoder().decode(SpeechConfiguration.self,from:data);notice="语音设置已保存，未执行测试。"
        } catch { notice="语音设置未全部保存，生成保持关闭；请检查地址和音色。";speech.enabled=false } }
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
                if service=="assistant" {hasAssistantKey=false;assistantKey=""} else if service=="tts" {speech.has_key=false;speechKey=""} else {hasDeepseekKey=false;deepseekKey=""}
                notice="Key 已清除。"
            } catch { notice="清除失败，请稍后重试。" }
        }
    }
}
