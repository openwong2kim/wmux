// Window-only screenshots through ScreenCaptureKit, JPEG quality 80, scaled
// to the shared screenshot budget.

import ComputerUseCore
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
    static func window(_ windowID: CGWindowID) async throws -> JSON {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw HelperError("screenshot_failed", "could not list windows for capture: \((error as NSError).code)")
        }
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw HelperError("screenshot_failed", "the window is not capturable (minimized or off-screen)")
        }
        let size = window.frame.size
        let scale = screenshotScale(width: size.width, height: size.height)
        let config = SCStreamConfiguration()
        config.width = max(1, Int((size.width * scale).rounded()))
        config.height = max(1, Int((size.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.scalesToFit = true
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window),
                configuration: config
            )
        } catch {
            throw HelperError("screenshot_failed", "window capture failed: \((error as NSError).code)")
        }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw HelperError("screenshot_failed", "JPEG encoder unavailable")
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw HelperError("screenshot_failed", "JPEG encoding failed") }
        return [
            "mime": "image/jpeg",
            "data": (data as Data).base64EncodedString(),
            "width": image.width,
            "height": image.height,
            // Image pixels per window point, from what was actually captured.
            "scale": size.width > 0 ? Double(image.width) / size.width : scale,
        ]
    }
}
