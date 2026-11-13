import SwiftUI

struct VoiceConfiguration: Codable {
    var enabled = false, muted = false, quiet_enabled = false
    var quiet_start = 1320, quiet_end = 480
    var provider = "system", voice = ""
    var input = true, error = true, completed = true, milestone = true, quota = true
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
                Text("Mac 负责整理消息和生成音频。重要消息会按优先级播报；设备断开时保留未过期的消息，已经开始但未确认完成的播报不会自动重放。").foregroundStyle(model.theme.muted)
                Toggle("启用语音播报",isOn:$config.enabled).accessibilityIdentifier("voice-enabled")
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
                    Button("测试设备播报") { testAudio() }.disabled(!config.enabled || config.muted || feed?.tts_available != true).accessibilityIdentifier("voice-test")
                }
                Text("语音来源在“API 设置”中配置。语音生成关闭时只整理消息，不调用 TTS；音频不会在 Mac 自动播放。").font(.caption).foregroundStyle(model.theme.muted)
                if !notice.isEmpty { Text(notice).foregroundStyle(model.theme.accent).accessibilityIdentifier("voice-notice") }
            }
            card("播报内容") {
                Toggle("等待回答或审批",isOn:$config.input)
                Toggle("重复错误与需要处理的阻塞",isOn:$config.error)
                Toggle("对话本轮结束及简要结果",isOn:$config.completed)
                Toggle("重要实验进展与决定",isOn:$config.milestone)
                Toggle("额度恢复",isOn:$config.quota)
                Text(feed?.device_audio_ready == true ? "监视器音频通道已就绪。音量在屏幕右下角“工具 → 声音与音量”调节。" : "等待支持语音的监视器连接。设备支持音频不代表已检测到实体扬声器。").font(.caption).foregroundStyle(model.theme.muted)
                HStack { Button("停止播报") { control("stop") };Button("重播最近一条") { control("replay") }.disabled(!config.enabled || config.muted) }
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
        do { let value=try JSONDecoder().decode(VoiceFeed.self,from:await model.configurationRequest("api/v1/voice"));feed=value;if notice=="暂时无法读取播报状态。" { notice="" };if !loaded { config=value.configuration;loaded=true } }
        catch { notice="暂时无法读取播报状态。" }
    }
    private func save() {
        saving=true
        Task { defer { saving=false };do {
            _=try await model.configurationRequest("api/v1/voice/config",body:["enabled":config.enabled,"muted":config.muted,"quiet_enabled":config.quiet_enabled,"quiet_start":config.quiet_start,"quiet_end":config.quiet_end,"input":config.input,"error":config.error,"completed":config.completed,"milestone":config.milestone,"quota":config.quota])
            notice="播报设置已保存。";await refresh()
        } catch { notice="设置未保存，请稍后重试。" } }
    }
    private func control(_ action:String) {
        Task { do { _=try await model.configurationRequest("api/v1/voice/"+action,body:[:],method:"POST");await refresh() } catch { notice="操作未完成，请检查设备连接。" } }
    }
    private func testAudio() {
        saving=true
        Task { defer { saving=false };do {
            _=try await model.configurationRequest("api/v1/voice/test",body:[:],method:"POST")
            notice="正在生成并发送到监视器，播放回执会显示在下方。";await refresh()
        } catch { notice="请先保存并开启整理；静音或安静时段内暂停生成。" } }
    }
}
