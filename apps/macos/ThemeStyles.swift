import SwiftUI

enum Theme: String, CaseIterable, Codable, Identifiable {
    case neon, comic, neumorphism
    var id: String { rawValue }
    var name: String { switch self { case .neon: return "赛博霓虹"; case .comic: return "漫画风格"; case .neumorphism: return "新拟物派" } }
    var note: String { switch self { case .neon: return "等宽字体 · 霓虹边缘 · 扫描线"; case .comic: return "粗墨线 · 半调网点 · 硬边阴影"; case .neumorphism: return "同色灰面 · 柔和双阴影 · 凹凸触感" } }
    var background: Color { Color(hex: self == .neon ? 0x0a0a0f : self == .comic ? 0xfffef0 : 0xe0e5ec) }
    var surface: Color { Color(hex: self == .neon ? 0x0c1019 : self == .comic ? 0xffffff : 0xe0e5ec) }
    var accent: Color { Color(hex: self == .neon ? 0x00ffff : self == .comic ? 0x3366ff : 0x6d5dfc) }
    var text: Color { Color(hex: self == .neon ? 0xe9ffff : self == .comic ? 0x202020 : 0x333333) }
    var muted: Color { Color(hex: self == .neon ? 0x9bacc4 : self == .comic ? 0x4a4a4a : 0x5b6472) }
    var success: Color { Color(hex: self == .neon ? 0x00ffad : self == .comic ? 0x238123 : 0x28664c) }
    var duration: Double { self == .comic ? 0.09 : self == .neumorphism ? 0.3 : 0.14 }
    init(from decoder: Decoder) throws {
        let box=try decoder.singleValueContainer();let raw=try box.decode(String.self)
        let upgraded=raw == "paper" ? "comic" : raw == "midnight" ? "neumorphism" : raw
        guard let value=Theme(rawValue:upgraded) else {throw DecodingError.dataCorruptedError(in:box,debugDescription:"Unknown theme")};self=value
    }
}
extension Color {
    init(hex: UInt32) { self.init(red: Double((hex >> 16) & 255)/255, green: Double((hex >> 8) & 255)/255, blue: Double(hex & 255)/255) }
}
struct Halftone: View {
    var body: some View {
        Canvas { context,size in
            for y in stride(from:0.0,to:size.height,by:8) {for x in stride(from:0.0,to:size.width,by:8) {
                context.fill(Path(ellipseIn:CGRect(x:x,y:y,width:1.5,height:1.5)),with:.color(Color(hex:0x1a1a1a).opacity(0.10)))
            }}
        }.allowsHitTesting(false)
    }
}
struct ThemeBackdrop: View {
    let theme: Theme
    var body: some View { ZStack {theme.background;if theme == .comic {Halftone()}} }
}
struct CompanionSurface: View {
    let theme: Theme
    var selected=false, pressed=false, hovered=false
    var insetDepth:Double=4
    var body: some View {
        switch theme {
        case .neon:
            RoundedRectangle(cornerRadius:4).fill(selected ? theme.accent.opacity(0.12) : theme.surface)
        case .comic:
            Rectangle().fill(selected || hovered ? Color(hex:0xffcc00) : theme.surface)
                .shadow(color:Color(hex:0x1a1a1a),radius:0,x:pressed ? 0 : 4,y:pressed ? 0 : 4)
                .overlay(Rectangle().strokeBorder(Color(hex:0x1a1a1a),lineWidth:4))
        case .neumorphism:
            let inset=selected || pressed
            let face: AnyShapeStyle = inset ? AnyShapeStyle(theme.surface.shadow(.inner(color:Color(hex:0xb8bcc2),radius:insetDepth*1.5,x:insetDepth,y:insetDepth)).shadow(.inner(color:.white.opacity(0.9),radius:insetDepth*1.5,x:-insetDepth,y:-insetDepth))) : AnyShapeStyle(theme.surface)
            RoundedRectangle(cornerRadius:18).fill(face)
                .shadow(color:inset ? .clear : .white.opacity(0.85),radius:hovered ? 8 : 16,x:hovered ? -4 : -8,y:hovered ? -4 : -8)
                .shadow(color:inset ? .clear : Color(hex:0xb8bcc2).opacity(0.75),radius:hovered ? 8 : 16,x:hovered ? 4 : 8,y:hovered ? 4 : 8)
        }
    }
}
struct CompanionButtonStyle: ButtonStyle {
    let theme: Theme
    let motion: Bool
    func makeBody(configuration:Configuration) -> some View { ActionLabel(label:configuration.label,theme:theme,pressed:configuration.isPressed,motion:motion) }
    private struct ActionLabel<Label:View>: View {
        let label:Label
        let theme:Theme
        let pressed:Bool
        let motion:Bool
        @State private var hovered=false
        @Environment(\.isEnabled) private var enabled
        private var content:some View {label.fontWeight(theme == .comic ? .black : .semibold).foregroundStyle(theme.text).padding(.horizontal,13).padding(.vertical,9).background(CompanionSurface(theme:theme,pressed:pressed,hovered:hovered))}
        var body:some View {
            Group {
                if theme == .comic {content.scaleEffect(hovered && motion ? 1.1 : 1).rotationEffect(.degrees(hovered && motion ? -3 : 0)).offset(x:pressed ? 2 : 0,y:pressed ? 2 : 0)}
                else {content}
            }.opacity(enabled ? 1 : 0.5).onHover {hovered=$0 && enabled}.animation(motion ? .easeInOut(duration:theme.duration) : nil,value:hovered).animation(motion ? .easeInOut(duration:theme.duration) : nil,value:pressed)
        }
    }
}
struct ThemeOptionCard: View {
    let theme:Theme, container:Theme, selected:Bool, motion:Bool
    @State private var hovered=false
    var body:some View {
        VStack(alignment:.leading,spacing:13) {
            ZStack(alignment:.topTrailing) {
                VStack(spacing:7) {
                    HStack {Text("AC //").font(.system(size:13,weight:theme == .comic ? .black : .semibold,design:theme == .neon ? .monospaced : .default)).foregroundStyle(theme.accent);Spacer();Circle().fill(theme.accent).frame(width:5,height:5)}
                    HStack {RoundedRectangle(cornerRadius:theme == .comic ? 0 : 9).fill(theme.accent.opacity(0.18)).frame(width:31,height:45);VStack(spacing:7) {ForEach(0..<3) {i in Capsule().fill(theme.accent.opacity(i == 0 ? 0.6 : 0.2)).frame(height:4)}}}
                }.padding(14).frame(height:96).background(ThemeBackdrop(theme:theme)).clipped()
                if theme == .comic && hovered {Text("换装!").font(.system(size:12,weight:.black)).foregroundStyle(Color(hex:0x1a1a1a)).padding(5).background(Color(hex:0xffcc00)).overlay(Rectangle().stroke(Color(hex:0x1a1a1a),lineWidth:2)).rotationEffect(.degrees(-8))}
            }.scaleEffect(container == .comic && hovered && motion ? 1.05 : 1).rotationEffect(.degrees(container == .comic && hovered && motion ? -3 : 0))
            HStack {Text(theme.name).fontWeight(container == .comic ? .black : .semibold);Spacer();if selected {Image(systemName:"checkmark.circle.fill").foregroundStyle(container.accent)}}
            Text(theme.note).font(.caption).foregroundStyle(container.muted).lineLimit(2).frame(height:32,alignment:.top)
        }.padding(15).frame(maxWidth:.infinity).background(CompanionSurface(theme:container,selected:selected,hovered:hovered))
            .onHover {hovered=$0}.animation(motion ? .easeInOut(duration:container.duration) : nil,value:hovered)
    }
}
