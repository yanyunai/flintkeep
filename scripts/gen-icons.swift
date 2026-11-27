/**
 * 生成应用图标（macOS 自带 Swift + AppKit，无第三方依赖）：
 *   electron/trayTemplate.png     16×16  菜单栏「密」字模板图（黑 + 透明，setTemplateImage 自动适配深浅菜单栏）
 *   electron/trayTemplate@2x.png  32×32  Retina 版
 *   electron/app-icon.png        512×512 客户端 Dock / 窗口图标
 *
 * 运行：swift scripts/gen-icons.swift
 * 注意：必须用 NSBitmapImageRep 按像素渲染；NSImage.lockFocus() 在 Retina 屏上会自动按 2x 输出，
 *       托盘图会变成 32×32 而被菜单栏放大显示。
 */
import AppKit
import Foundation

let outDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("..").appendingPathComponent("electron").standardizedFileURL

func chineseFont(_ size: CGFloat) -> NSFont {
    NSFont(name: "PingFangSC-Semibold", size: size)
        ?? NSFont(name: "PingFangSC-Medium", size: size)
        ?? NSFont(name: "HiraginoSansGB-W6", size: size)
        ?? NSFont.boldSystemFont(ofSize: size)
}

/// 1 point = 1 pixel 的离屏绘制，输出精确像素尺寸
func pngData(pixels: Int, draw: (CGFloat) -> Void) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)!
    draw(CGFloat(pixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func save(_ data: Data, _ name: String) throws {
    try data.write(to: outDir.appendingPathComponent(name))
    print("生成 \(name)")
}

/// 菜单栏模板图：只用黑色 + alpha，系统按 alpha 染色
let trayDraw: (CGFloat) -> Void = { side in
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: side, height: side).fill()
    let attrs: [NSAttributedString.Key: Any] = [
        .font: chineseFont(side * 0.84),
        .foregroundColor: NSColor.black,
    ]
    let text = "密" as NSString
    let box = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (side - box.width) / 2, y: (side - box.height) / 2), withAttributes: attrs)
}

/// 客户端图标：蓝紫渐变圆角底 + 白色「密」字
let appDraw: (CGFloat) -> Void = { side in
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: side, height: side).fill()

    let inset = side * 0.055
    let rect = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    let shape = NSBezierPath(roundedRect: rect, xRadius: side * 0.225, yRadius: side * 0.225)
    let gradient = NSGradient(
        starting: NSColor(calibratedRed: 0.09, green: 0.38, blue: 0.93, alpha: 1),
        ending: NSColor(calibratedRed: 0.43, green: 0.21, blue: 0.82, alpha: 1)
    )!
    gradient.draw(in: shape, angle: -55)

    NSColor(calibratedWhite: 1, alpha: 0.20).setStroke()
    shape.lineWidth = side * 0.013
    shape.stroke()

    let attrs: [NSAttributedString.Key: Any] = [
        .font: chineseFont(side * 0.55),
        .foregroundColor: NSColor.white,
    ]
    let text = "密" as NSString
    let box = text.size(withAttributes: attrs)
    text.draw(at: NSPoint(x: (side - box.width) / 2, y: (side - box.height) / 2), withAttributes: attrs)
}

try save(pngData(pixels: 16, draw: trayDraw), "trayTemplate.png")
try save(pngData(pixels: 32, draw: trayDraw), "trayTemplate@2x.png")
try save(pngData(pixels: 512, draw: appDraw), "app-icon.png")
