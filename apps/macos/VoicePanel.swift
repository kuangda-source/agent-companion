import SwiftUI

struct VoiceConfiguration: Codable {
    var enabled = false, muted = false, quiet_enabled = false
    var quiet_start = 1320, quiet_end = 480
    var provider = "system", voice = ""
}
struct VoiceNotice: Codable, Identifiable {
    var id: String, kind: String, text: String, state: String
    var priority: Int
    var label: String { switch state { case "queued":return "等待准备";case "preparing":return "正在生成音频";case "ready":return "音频已就绪 · 等待设备播放";case "playing":return "正在播放";case "played":return "已播报";case "cancelled":return "已取消";case "failed":return "音频生成失败";default:return "播放结果待确认"} }
}
struct VoiceFeed: Codable {
    var configuration: VoiceConfiguration
    var device_audio_ready: Bool
    var tts_available: Bool
    var notices: [VoiceNotice]
}
struct VoicePanel: View {
    @EnvironmentObject var model: CompanionModel
    @State private var feed: VoiceFeed?
    @State private var config = VoiceConfiguration()
    @State private var saving = false
    @State private var loaded = false
    @State private var notice = ""
    var body: some View {
        VStack(alignment:.leading,spacing:20) {
            card("语音播报") {
                Label("声音将从桌面监视器播放",systemImage:"hifispeaker.fill").font(.headline)
                Text("Mac 负责整理消息和生成音频。当前可先准备待播消息、测试音频生成；设备播放正在接入，接上扬声器后再验收声音。").foregroundStyle(model.theme.muted)
                Toggle("整理待播消息",isOn:$config.enabled).accessibilityIdentifier("voice-enabled")
                Toggle("静音",isOn:$config.muted).disabled(!config.enabled)
                Toggle("启用安静时段",isOn:$config.quiet_enabled).disabled(!config.enabled)
                if config.quiet_enabled {
                    HStack {
                        DatePicker("开始",selection:timeBinding(\.quiet_start),displayedComponents:.hourAndMinute)
                        DatePicker("结束",selection:timeBinding(\.quiet_end),displayedComponents:.hourAndMinute)
                    }
                }
                HStack {
                    Button("保存播报设置") { save() }.accessibilityIdentifier("voice-save")
                    Button("生成测试音频") { testAudio() }.disabled(!config.enabled || config.muted || feed?.tts_available != true).accessibilityIdentifier("voice-test")
                }
                Text("准备阶段使用 Mac 系统语音生成音频，无需新增 API Key。测试只生成音频，不会在 Mac 自动出声。").font(.caption).foregroundStyle(model.theme.muted)
                if !notice.isEmpty { Text(notice).foregroundStyle(model.theme.accent).accessibilityIdentifier("voice-notice") }
            }
            card("播报规则") {
                Label("优先提醒需要你回答、审批或处理的事项",systemImage:"exclamationmark.bubble")
                Label("其次播报本轮结束、重要结果和额度恢复",systemImage:"text.bubble")
                Label("重复错误合并；已回答、解决或过期的提醒取消",systemImage:"line.3.horizontal.decrease.circle")
            }
            card("最近待播消息") {
                if let feed, !feed.notices.isEmpty {
                    ForEach(Array(feed.notices.prefix(12))) { item in
                        VStack(alignment:.leading,spacing:6) {
                            Text(item.text).fixedSize(horizontal:false,vertical:true)
                            Text(item.label).font(.caption).foregroundStyle(item.priority == 0 ? model.theme.accent : model.theme.muted)
                        }.padding(.vertical,6)
                    }
                } else { Text("开启整理后，新的重要事件会出现在这里。").foregroundStyle(model.theme.muted) }
            }
        }.disabled(!model.online || !loaded || saving)
        .task(id:model.online) {
            guard model.online else { return }
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(nanoseconds:2_000_000_000) } catch { break }
            }
        }
    }
    private func card<Content:View>(_ title:String,@ViewBuilder content:()->Content)->some View {
        VStack(alignment:.leading,spacing:16){Text(title).font(.headline);content()}.padding(22).frame(maxWidth:.infinity,alignment:.leading).background(CompanionSurface(theme:model.theme))
    }
    private func timeBinding(_ key:WritableKeyPath<VoiceConfiguration,Int>)->Binding<Date> {
        Binding(get:{Calendar.current.startOfDay(for:Date()).addingTimeInterval(TimeInterval(config[keyPath:key]*60))},set:{let c=Calendar.current.dateComponents([.hour,.minute],from:$0);config[keyPath:key]=(c.hour ?? 0)*60+(c.minute ?? 0)})
    }
    private func refresh() async {
        do { let value=try JSONDecoder().decode(VoiceFeed.self,from:await model.configurationRequest("api/v1/voice"));feed=value;if !loaded { config=value.configuration;loaded=true } }
        catch { notice="暂时无法读取播报状态。" }
    }
    private func save() {
        saving=true
        Task { defer { saving=false };do {
            _=try await model.configurationRequest("api/v1/voice/config",body:["enabled":config.enabled,"muted":config.muted,"quiet_enabled":config.quiet_enabled,"quiet_start":config.quiet_start,"quiet_end":config.quiet_end])
            notice="播报设置已保存。";await refresh()
        } catch { notice="设置未保存，请稍后重试。" } }
    }
    private func testAudio() {
        saving=true
        Task { defer { saving=false };do {
            _=try await model.configurationRequest("api/v1/voice/test",body:[:],method:"POST")
            notice="正在生成测试音频，结果会显示在下方。";await refresh()
        } catch { notice="请先保存并开启整理；静音或安静时段内暂停生成。" } }
    }
}
