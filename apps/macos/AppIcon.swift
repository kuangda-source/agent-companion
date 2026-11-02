import AppKit
let output=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let pixels=size*scale
        let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
        let transform=NSAffineTransform();transform.scale(by:CGFloat(pixels)/1024);transform.concat()
        NSColor(srgbRed:0.035,green:0.055,blue:0.095,alpha:1).setFill();NSBezierPath(roundedRect:NSRect(x:32,y:32,width:960,height:960),xRadius:210,yRadius:210).fill()
        let ring=NSBezierPath();ring.move(to:NSPoint(x:180,y:340));ring.line(to:NSPoint(x:180,y:690));ring.line(to:NSPoint(x:512,y:840));ring.line(to:NSPoint(x:844,y:690));ring.line(to:NSPoint(x:844,y:340));ring.line(to:NSPoint(x:512,y:190));ring.close()
        NSColor(srgbRed:0,green:0.9,blue:0.95,alpha:0.8).setStroke();ring.lineWidth=19;ring.stroke()
        let word="AC" as NSString
        word.draw(at:NSPoint(x:280,y:365),withAttributes:[.font:NSFont.monospacedSystemFont(ofSize:280,weight:.bold),.foregroundColor:NSColor(srgbRed:0.65,green:1,blue:1,alpha:1)])
        let accent=NSBezierPath();accent.move(to:NSPoint(x:365,y:325));accent.line(to:NSPoint(x:650,y:325));accent.lineWidth=24;accent.lineCapStyle = .round
        NSColor(srgbRed:1,green:0.15,blue:0.72,alpha:1).setStroke();accent.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let name="icon_\(size)x\(size)"+(scale==2 ? "@2x" : "")+".png"
        try bitmap.representation(using:.png,properties:[:])!.write(to:output.appendingPathComponent(name))
    }
}
