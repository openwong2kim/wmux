// OCR helper for frame-check.sh: prints "<file>\t<line>" for every text line Vision finds.
// Korean is enabled on purpose, so Hangul in a frame is read back and flagged.
import Foundation
import Vision
import AppKit

for file in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: file),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("\(file)\t<unreadable>")
    continue
  }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  req.recognitionLanguages = ["en-US", "ko-KR"]
  try? VNImageRequestHandler(cgImage: cg).perform([req])
  for obs in req.results ?? [] {
    if let s = obs.topCandidates(1).first?.string { print("\(file)\t\(s)") }
  }
}
