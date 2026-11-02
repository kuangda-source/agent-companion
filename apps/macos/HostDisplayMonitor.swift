import AppKit
import CoreGraphics
import Darwin

struct HostDisplaySample: Codable, Equatable {
    var display_id: UInt32; var display_name: String; var brightness_ratio: Double?; var screen_awake: Bool; var observed_at: String
    var body: [String: Any] { ["display_id":display_id,"display_name":display_name,"brightness_ratio":brightness_ratio.map { $0 as Any } ?? NSNull(),"screen_awake":screen_awake,"observed_at":observed_at] }
}
struct DisplayTarget: Codable, Equatable { var revision: Int; var brightness_percent: Int; var screen_on: Bool }
struct DisplayApplied: Codable, Equatable { var revision: Int; var brightness_percent: Int; var screen_on: Bool; var backlight_duty: Int; var observed_at: String }
struct HostDisplayStatus: Codable, Equatable {
    var host: HostDisplaySample?; var host_fresh: Bool; var brightness_available: Bool; var target: DisplayTarget; var applied: DisplayApplied?; var in_sync: Bool
}

/// Reads the main screen; never changes host brightness or inhibits screen/system sleep.
@MainActor final class HostDisplayMonitor {
    private typealias ReadBrightness = @convention(c) (UInt32, UnsafeMutablePointer<Float>) -> Int32
    private let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY | RTLD_LOCAL)
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var forcedSleep = false
    private var lastKey = "", lastSend = Date.distantPast
    private let publish: (HostDisplaySample) -> Void
    init(publish: @escaping (HostDisplaySample) -> Void) {
        self.publish = publish
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification] {
            let token = workspace.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in
                MainActor.assumeIsolated { self?.forcedSleep = true; self?.sample(force:true) }
            }; observers.append((workspace,token))
        }
        for name in [NSWorkspace.screensDidWakeNotification, NSWorkspace.didWakeNotification] {
            let token = workspace.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in
                MainActor.assumeIsolated { self?.forcedSleep = false; self?.sample(force:true) }
            }; observers.append((workspace,token))
        }
        let center = NotificationCenter.default
        observers.append((center,center.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample(force:true) }
        }))
    }
    func sample(force: Bool = false) {
        let id = CGMainDisplayID()
        var ratio: Double?
        if let handle, let symbol = dlsym(handle,"DisplayServicesGetBrightness") {
            var value: Float = -1
            let result = unsafeBitCast(symbol,to:ReadBrightness.self)(id,&value)
            if result == 0 && value.isFinite && value >= 0 && value <= 1 { ratio = Double(value) }
        }
        let awake = !forcedSleep && id != 0 && CGDisplayIsAsleep(id) == 0
        let name = CGDisplayIsBuiltin(id) != 0 ? "Mac 内建主屏" : "Mac 主显示器"
        let key = "\(id):\(ratio.map { Int(($0 * 100).rounded()) } ?? -1):\(awake)"
        if !force && key == lastKey && Date().timeIntervalSince(lastSend) < 5 { return }
        lastKey = key; lastSend = Date()
        publish(HostDisplaySample(display_id:id,display_name:name,brightness_ratio:ratio,screen_awake:awake,observed_at:ISO8601DateFormatter().string(from:Date())))
    }
    func stop() { for (center,token) in observers { center.removeObserver(token) }; observers.removeAll() }
}
