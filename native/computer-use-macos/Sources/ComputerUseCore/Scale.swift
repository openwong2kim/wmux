// Screenshot scale, the same formula as src/shared/computer/scale.ts:
// `min(1, 1280 / longEdge, sqrt(1.15e6 / (w·h)))` over the window's logical
// size, so the image is `scale` pixels per window point.

public let screenshotMaxLongEdge = 1280.0
public let screenshotMaxPixels = 1_150_000.0

public func screenshotScale(width: Double, height: Double) -> Double {
    guard width > 0, height > 0 else { return 1 }
    let longEdge = max(width, height)
    return min(1, screenshotMaxLongEdge / longEdge, (screenshotMaxPixels / (width * height)).squareRoot())
}
