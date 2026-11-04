import SwiftUI
struct RelayConfiguration: Codable {var enabled:Bool;var url:String;var has_mac_token:Bool;var has_device_token:Bool}
struct ConnectionPanel: View {
    @EnvironmentObject var model:CompanionModel
    @State private var ssid=""
    @State private var password=""
    @State private var host=""
    @State private var relayURL=""
    @State private var macToken=""
    @State private var deviceToken=""
    @State private var relayEnabled=false
    @State private var relayConfigured=false
    @State private var saving=false
    @State private var loaded=false
    @State private var notice=""
    private var status:RemoteConnectionStatus? {model.connectionStatus}
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            card("连接屏幕") {
                Label(status?.connectionLabel ?? "等待屏幕连接",systemImage:status?.data_fresh == true ? "checkmark.circle.fill" : "display").foregroundStyle(status?.data_fresh == true ? model.theme.success : model.theme.muted)
                Picker("连接方式",selection:Binding(get:{model.preferences.device.transport},set:{model.update(["device":["transport":$0]])})) {
                    Text("USB（默认）").tag("usb");Text("自动（优先 USB）").tag("auto");Text("仅局域网").tag("wifi");Text("仅云中转").tag("relay")
                }
                Text("接上 USB 后自动同步，无需配网。局域网和云中转可按需切换；自动模式会优先使用 USB。").font(.caption).foregroundStyle(model.theme.muted)
            }
            card("1 · 给屏幕连接 Wi-Fi") {
                TextField("Wi-Fi 名称（2.4GHz）",text:$ssid).textFieldStyle(.roundedBorder)
                SecureField("Wi-Fi 密码",text:$password).textFieldStyle(.roundedBorder)
                Button(model.networkSaving ? "正在提交…" : "通过 USB 配网") {model.provisionWiFi(ssid:ssid,password:password);password=""}.disabled(status?.usb == nil || ssid.isEmpty || password.utf8.count<8 || model.networkSaving)
                if status?.usb == nil {Text("请用数据线连接屏幕的 P4 USB 接口，应用会自动检测。").font(.caption).foregroundStyle(model.theme.muted)}
                Text("密码只通过 USB 下发，保存在板子本机。").font(.caption).foregroundStyle(model.theme.muted)
            }
            card("2 · 局域网配对") {
                Text("Mac 和屏幕连接同一网络后，选择本机地址并通过 USB 配对一次。").foregroundStyle(model.theme.muted)
                if let lan=status?.lan {
                    ForEach(lan.endpoints,id:\.host){endpoint in
                        HStack {Text(endpoint.host).font(.system(.body,design:.monospaced));Spacer();Button("使用此地址"){host=endpoint.host}}
                    }
                }
                TextField("Mac 局域网 IP 或 .local 主机名",text:$host).textFieldStyle(.roundedBorder)
                Button("通过 USB 配对主机") {model.provisionLAN(host:host,transport:model.preferences.device.transport)}.disabled(host.isEmpty || status?.usb == nil || model.networkSaving)
                Text("仅使用局域网时，无需填写下面的服务器配置。").font(.caption).foregroundStyle(model.theme.muted)
            }
            card("异地连接 · 可选") {
                Toggle("启用自建中转服务器",isOn:$relayEnabled)
                TextField("wss://你的域名/v1/link",text:$relayURL).textFieldStyle(.roundedBorder).accessibilityIdentifier("relay-url")
                SecureField(relayConfigured ? "Mac 令牌已保存，留空保留" : "Mac 角色令牌（64 位十六进制）",text:$macToken).textFieldStyle(.roundedBorder)
                SecureField(relayConfigured ? "屏幕令牌已保存，留空保留" : "屏幕角色令牌（与 Mac 不同）",text:$deviceToken).textFieldStyle(.roundedBorder)
                Text("先按仓库文档部署中转、配置域名与 HTTPS，再填入服务端生成的两枚令牌。更换服务器地址时，请重新填写两枚令牌。").font(.caption).foregroundStyle(model.theme.muted)
                Button("保存中转设置") {saveRelay()}.disabled(!loaded).accessibilityIdentifier("relay-save")
                Text("修改中转后，再点击上方“通过 USB 配网”，把新配置同步到屏幕。").font(.caption).foregroundStyle(model.theme.muted)
            }
            if !model.networkMessage.isEmpty {Text(model.networkMessage).foregroundStyle(model.theme.accent)}
            if !notice.isEmpty {Text(notice).foregroundStyle(model.theme.accent)}
            DisclosureGroup("连接详情") {
                VStack(alignment:.leading,spacing:8) {
                    Text("本机服务："+(model.online ? "已连接" : "未连接"))
                    Text("中转服务器："+(status?.configured != true ? "未配置" : status?.relay_connected == true ? "已连接" : "等待连接"))
                    Text("局域网屏幕："+(status?.lan?.device_connected == true ? "已连接" : "等待连接"))
                    Text("数据回执："+(status?.data_fresh == true ? "实时" : "等待屏幕确认"))
                    if let state=status?.usb?.provision?.state {Text(state=="saved" ? "Wi-Fi 配置已保存到屏幕" : "Wi-Fi 配网："+state)}
                    if let state=status?.usb?.link_config?.state {Text(state=="saved" ? "主机配对已保存到屏幕" : "主机配对："+state)}
                }.padding(.top,10).font(.caption).foregroundStyle(model.theme.muted)
            }
        }.disabled(!model.online || saving).task(id:model.online) {if model.online {await load()}}
    }
    private func card<Content:View>(_ title:String,@ViewBuilder content:()->Content)->some View {
        VStack(alignment:.leading,spacing:16){Text(title).font(.headline);content()}.padding(22).frame(maxWidth:.infinity,alignment:.leading).background(CompanionSurface(theme:model.theme))
    }
    private func load() async {
        await model.pollConnection()
        host=status?.lan?.endpoints.first?.host ?? ""
        do {
            let config=try JSONDecoder().decode(RelayConfiguration.self,from:await model.configurationRequest("api/v1/connection/relay"))
            relayURL=config.url;relayEnabled=config.enabled;relayConfigured=config.has_mac_token&&config.has_device_token;loaded=true
        } catch {notice="中转配置暂时不可用，请稍后重新打开连接页。"}
    }
    private func saveRelay() {
        saving=true
        Task {defer {saving=false}
            do {
                if !relayEnabled && relayURL.isEmpty {
                    _=try await model.configurationRequest("api/v1/connection/relay",method:"DELETE")
                } else {
                    _=try await model.configurationRequest("api/v1/connection/relay",body:["enabled":relayEnabled,"url":relayURL.trimmingCharacters(in:.whitespacesAndNewlines),"mac_token":macToken,"device_token":deviceToken])
                }
                macToken="";deviceToken="";notice="中转设置已保存。";await load()
            } catch {notice="保存失败。请检查 WSS 地址和两枚不同的 64 位令牌；更换服务器必须重新填写令牌。"}
        }
    }
}
