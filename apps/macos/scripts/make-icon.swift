// Renders the Cadence app icon into an .iconset folder (then: iconutil -c icns <folder>).
// Usage: swift make-icon.swift <out.iconset>
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(size: Int) -> Data {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // macOS icon grid: 824/1024 body with soft shadow.
    let inset = s * 100 / 1024
    let body = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let radius = body.width * 0.225
    let path = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03,
                  color: NSColor.black.withAlphaComponent(0.3).cgColor)
    ctx.addPath(path)
    ctx.setFillColor(NSColor(red: 0.91, green: 0.35, blue: 0.05, alpha: 1).cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    // Warm gradient
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let colors = [
        NSColor(red: 1.0, green: 0.55, blue: 0.22, alpha: 1).cgColor,
        NSColor(red: 0.86, green: 0.27, blue: 0.04, alpha: 1).cgColor,
    ] as CFArray
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: body.minX, y: body.maxY),
                           end: CGPoint(x: body.maxX, y: body.minY), options: [])

    // Faint contour lines (terrain) behind the route.
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.10).cgColor)
    ctx.setLineWidth(max(1, s * 0.008))
    for i in 0..<5 {
        let r = body.width * (0.28 + CGFloat(i) * 0.13)
        ctx.strokeEllipse(in: CGRect(x: body.maxX - r * 0.7, y: body.minY - r * 0.55, width: r * 1.6, height: r * 1.3))
    }

    // The route: a rising zig-zag like the web logo.
    let u = body.width / 64
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: body.minX + x * u, y: body.minY + (64 - y) * u) }
    let route = CGMutablePath()
    route.move(to: p(14, 41))
    route.addLine(to: p(24, 25))
    route.addLine(to: p(32, 35))
    route.addLine(to: p(40, 19))
    route.addLine(to: p(50, 41))
    ctx.addPath(route)
    ctx.setStrokeColor(NSColor.white.cgColor)
    ctx.setLineWidth(6 * u)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.strokePath()

    // Start dot
    let d = 4.2 * u
    let start = p(14, 41)
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fillEllipse(in: CGRect(x: start.x - d, y: start.y - d, width: 2 * d, height: 2 * d))
    ctx.restoreGState()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, size) in sizes {
    try! render(size: size).write(to: out.appendingPathComponent("\(name).png"))
}
print("wrote \(out.path)")
