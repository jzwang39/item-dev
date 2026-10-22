import AppKit
import Foundation
import PDFKit
import Vision

struct Result: Codable {
  let text: String
  let usedOcr: Bool
}

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("缺少 PDF 文件路径。".utf8))
  exit(1)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard let document = PDFDocument(url: url) else {
  FileHandle.standardError.write(Data("无法打开 PDF 文件。".utf8))
  exit(1)
}

let nativeText = (0..<document.pageCount)
  .compactMap { document.page(at: $0)?.string }
  .joined(separator: "\n")
  .trimmingCharacters(in: .whitespacesAndNewlines)

var extractedText = nativeText
var usedOcr = false

if nativeText.count < 80 {
  usedOcr = true
  var pages: [String] = []

  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let image = page.thumbnail(of: CGSize(width: 2200, height: 2800), for: .mediaBox)
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { continue }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let pageText = (request.results ?? [])
      .compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: "\n")
    pages.append(pageText)
  }

  extractedText = pages.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

guard !extractedText.isEmpty else {
  FileHandle.standardError.write(Data("文件不含可用文字，OCR 未能识别出内容。".utf8))
  exit(2)
}

let output = try JSONEncoder().encode(Result(text: extractedText, usedOcr: usedOcr))
FileHandle.standardOutput.write(output)
