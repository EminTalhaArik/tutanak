// Tutanak yardımcısı: toplantı algılama, ekran/ses kaydı, ekran görüntüleri, döküm ve kare küçültme.
//
// Electron ScreenCaptureKit, CoreAudio ve Speech çerçevelerine doğrudan erişemediği için uygulama bu
// aracı çalıştırır. Tutanak.app içinden başlatıldığında macOS izinleri (ekran kaydı, mikrofon)
// Tutanak adına sorar. Tüm çıktılar stdout'a satır başına bir JSON nesnesidir.
//
//   tutanak-helper watch [--interval 1.5]          ses giriş/çıkışı kullanan süreçleri izler
//   tutanak-helper windows                          ekrandaki pencereler (sahip uygulama, başlık)
//   tutanak-helper permissions                      izin durumu
//   tutanak-helper request-screen | request-audio | request-mic   izin ister
//   tutanak-helper devices                          mikrofonlar ve ekranlar
//   tutanak-helper record --dir D --mode video|audio|shots [--mic default|none|<id>] [--system 1|0]
//                         [--fps 15] [--max-dim 1920] [--display auto|main|<id>] [--interval 30]
//                         [--shot-max-dim 1920] [--exclude b1,b2] [--focus b1,b2]
//                         stdin'e "stop" yazılınca ya da stdin kapanınca kaydı bitirir
//   tutanak-helper transcribe --input F [--locale tr-TR]
//   tutanak-helper shrink-images --dir D [--quality 0.5] [--max-dim 1600] [--dedupe 0.03]
//
// Derleme: npm run helper

import AVFoundation
import AppKit
import CoreAudio
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit
import Speech
import UniformTypeIdentifiers

// MARK: - çıktı ve argümanlar

let outLock = NSLock()

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    outLock.lock()
    defer { outLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func finish(_ object: [String: Any], code: Int32 = 0) -> Never {
    emit(object)
    exit(code)
}

func fail(_ message: String, kind: String = "error", code: Int32 = 2) -> Never {
    finish(["event": "error", "kind": kind, "error": message], code: code)
}

let args = CommandLine.arguments

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func number(_ name: String, _ fallback: Double) -> Double {
    option(name).flatMap(Double.init) ?? fallback
}

func list(_ name: String) -> [String] {
    (option(name) ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

/// stdin satırlarını okur; kapanınca nil ile çağrılır (ana süreç ölürse yardımcı da durur)
func onStdin(_ handler: @escaping (String?) -> Void) {
    Thread.detachNewThread {
        while let line = readLine() { handler(line.trimmingCharacters(in: .whitespaces)) }
        handler(nil)
    }
}

var signalSources: [DispatchSourceSignal] = []

func onSignals(_ handler: @escaping () -> Void) {
    for sig in [SIGINT, SIGTERM, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler(handler: handler)
        src.resume()
        signalSources.append(src)
    }
}

// MARK: - CoreAudio: ses kullanan süreçler

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readUInt32(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var addr = address(selector)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readPID(_ obj: AudioObjectID) -> pid_t? {
    var addr = address(kAudioProcessPropertyPID)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readString(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
    guard status == noErr, let v = value else { return nil }
    return v.takeRetainedValue() as String
}

func audioProcessObjects() -> [AudioObjectID] {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    let system = AudioObjectID(kAudioObjectSystemObject)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
}

func executablePath(_ pid: pid_t) -> String {
    var buffer = [CChar](repeating: 0, count: 4096)
    let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return n > 0 ? String(cString: buffer) : ""
}

var pathCache: [pid_t: String] = [:]

/// Mikrofonu ya da hoparlörü o anda kullanan süreçler
func activeAudioProcesses() -> [[String: Any]] {
    audioProcessObjects().compactMap { obj -> [String: Any]? in
        let input = (readUInt32(obj, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
        let output = (readUInt32(obj, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
        guard input || output else { return nil }
        let pid = readPID(obj) ?? -1
        var bundle = readString(obj, kAudioProcessPropertyBundleID) ?? ""
        if bundle.isEmpty, pid > 0 { bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "" }
        var path = ""
        if pid > 0 {
            path = pathCache[pid] ?? executablePath(pid)
            pathCache[pid] = path
        }
        return ["pid": Int(pid), "bundle": bundle, "path": path, "input": input, "output": output]
    }
}

func watch() -> Never {
    let interval = max(0.3, number("--interval", 1.5))
    onStdin { line in if line == nil { exit(0) } }
    var last = "-"
    while true {
        let procs = activeAudioProcesses()
        let key = procs.map { "\($0["pid"]!):\($0["input"]!):\($0["output"]!)" }.sorted().joined(separator: ",")
        if key != last {
            last = key
            emit(["event": "audio", "procs": procs])
        }
        Thread.sleep(forTimeInterval: interval)
    }
}

// MARK: - pencereler, izinler, aygıtlar

func windows() -> Never {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var bundles: [pid_t: String] = [:]
    let out = info.compactMap { w -> [String: Any]? in
        guard (w[kCGWindowLayer as String] as? Int) == 0 else { return nil }
        let pid = pid_t(w[kCGWindowOwnerPID as String] as? Int ?? 0)
        let bundle = bundles[pid] ?? NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        bundles[pid] = bundle
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return [
            "pid": Int(pid),
            "bundle": bundle,
            "owner": w[kCGWindowOwnerName as String] as? String ?? "",
            "title": w[kCGWindowName as String] as? String ?? "",
            "width": b["Width"] as? Double ?? 0,
            "height": b["Height"] as? Double ?? 0,
        ]
    }
    finish(["windows": out])
}

func micStatusName() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "izinli"
    case .denied: return "reddedildi"
    case .restricted: return "kisitli"
    case .notDetermined: return "belirsiz"
    @unknown default: return "bilinmiyor"
    }
}

// Sistem sesi kaydı (kTCCServiceAudioCapture) için genel bir API yok; macOS 26'da ekran kaydı
// izninden ayrı tutuluyor ve izin yoksa ses sessiz geliyor. TCC çerçevesinin kendi işlevleri kullanılır.
let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_NOW)

/// 0: izinli, 1: reddedildi, 2: belirsiz, -1: sorgulanamadı
func tccPreflight(_ service: String) -> Int {
    typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    guard let tcc, let sym = dlsym(tcc, "TCCAccessPreflight") else { return -1 }
    return unsafeBitCast(sym, to: Preflight.self)(service as CFString, nil)
}

func tccRequest(_ service: String) async -> Bool {
    typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
    guard let tcc, let sym = dlsym(tcc, "TCCAccessRequest") else { return false }
    return await withCheckedContinuation { c in
        unsafeBitCast(sym, to: Request.self)(service as CFString, nil) { granted in c.resume(returning: granted) }
    }
}

func audioStatusName() -> String {
    switch tccPreflight("kTCCServiceAudioCapture") {
    case 0: return "izinli"
    case 1: return "reddedildi"
    case 2: return "belirsiz"
    default: return "bilinmiyor"
    }
}

func permissions() -> Never {
    finish(["screen": CGPreflightScreenCaptureAccess(), "mic": micStatusName(), "audio": audioStatusName()])
}

func devices() -> Never {
    let session = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
    let defaultID = AVCaptureDevice.default(for: .audio)?.uniqueID
    let mics = session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName, "default": $0.uniqueID == defaultID] as [String: Any] }
    let screens = NSScreen.screens.map { s -> [String: Any] in
        let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        return [
            "id": Int(id),
            "name": s.localizedName,
            "width": Int(s.frame.width * s.backingScaleFactor),
            "height": Int(s.frame.height * s.backingScaleFactor),
            "main": id == CGMainDisplayID(),
        ]
    }
    finish(["mics": mics, "displays": screens])
}

// MARK: - görüntü yardımcıları

@discardableResult
func writeJPEG(_ image: CGImage, to url: URL, quality: Double) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dest)
}

func fileSize(_ url: URL) -> Int {
    (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
}

func even(_ v: CGFloat) -> Int { max(2, Int(v / 2) * 2) }

// MARK: - kayıt

/// Tek bir dosyaya yazan AVAssetWriter; oturum tüm izler için ortak başlangıç anında açılır.
final class Track {
    let name: String
    let url: URL
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    var started = false
    var sessionStart = CMTime.invalid
    var firstPTS = CMTime.invalid
    var lastEnd = CMTime.invalid
    var samples = 0
    var dropped = 0
    var failed = false

    init(name: String, url: URL, fileType: AVFileType, input: AVAssetWriterInput) throws {
        self.name = name
        self.url = url
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: fileType)
        // Parçalı yazım: uygulama çökse bile dosyanın büyük kısmı okunabilir kalır
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw NSError(domain: "tutanak", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(name) izi eklenemedi"]) }
        writer.add(input)
        self.input = input
    }

    func append(_ sample: CMSampleBuffer, origin: CMTime) {
        guard !failed else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts.isValid else { return }
        if !started {
            guard writer.startWriting() else {
                failed = true
                emit(["event": "warn", "message": "\(name) yazılamıyor: \(writer.error?.localizedDescription ?? "")"])
                return
            }
            // Örnekler aynı (host) saatteyse ortak başlangıç; değilse kendi ilk örneği
            let diff = CMTimeGetSeconds(pts) - CMTimeGetSeconds(origin)
            sessionStart = (diff > -1 && diff < 5) ? origin : pts
            writer.startSession(atSourceTime: sessionStart)
            firstPTS = pts
            started = true
        }
        guard pts >= sessionStart, writer.status == .writing else { return }
        guard input.isReadyForMoreMediaData else { dropped += 1; return }
        if input.append(sample) {
            samples += 1
            let duration = CMSampleBufferGetDuration(sample)
            lastEnd = duration.isValid ? pts + duration : pts
        } else if writer.status == .failed {
            failed = true
            emit(["event": "warn", "message": "\(name) yazımı durdu: \(writer.error?.localizedDescription ?? "")"])
        }
    }

    func finish(at end: CMTime, _ done: @escaping () -> Void) {
        guard started, writer.status == .writing else {
            if !started { try? FileManager.default.removeItem(at: url) }
            done()
            return
        }
        input.markAsFinished()
        var stop = end
        if lastEnd.isValid, lastEnd > stop { stop = lastEnd }
        if stop > sessionStart { writer.endSession(atSourceTime: stop) }
        writer.finishWriting { done() }
    }

    var summary: [String: Any] {
        var o: [String: Any] = ["file": url.lastPathComponent, "samples": samples, "dropped": dropped, "bytes": fileSize(url)]
        if started { o["offset"] = round2(CMTimeGetSeconds(firstPTS) - CMTimeGetSeconds(sessionStart)) }
        if failed { o["failed"] = true }
        return o
    }
}

func peakLevel(_ sample: CMSampleBuffer) -> Float {
    guard let fd = CMSampleBufferGetFormatDescription(sample),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
          let block = CMSampleBufferGetDataBuffer(sample) else { return 0 }
    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &length, totalLengthOut: nil, dataPointerOut: &pointer) == noErr,
          let p = pointer else { return 0 }
    var peak: Float = 0
    if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 {
        p.withMemoryRebound(to: Float.self, capacity: length / 4) { f in
            var i = 0
            while i < length / 4 { peak = max(peak, abs(f[i])); i += 3 }
        }
    } else if asbd.mBitsPerChannel == 16 {
        p.withMemoryRebound(to: Int16.self, capacity: length / 2) { f in
            var i = 0
            while i < length / 2 { peak = max(peak, Float(abs(Int32(f[i]))) / 32768); i += 3 }
        }
    }
    return min(1, peak)
}

// MARK: - sistem sesi (Core Audio process tap)

func check(_ status: OSStatus, _ message: String) throws {
    guard status == noErr else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "\(message) (\(status))"])
    }
}

/// Hoparlöre giden tüm sesi dinler. ScreenCaptureKit'in sistem sesi yalnızca pencereli uygulamaları
/// kapsıyor; Teams ise sesi penceresiz "Microsoft Teams ModuleHost" sürecinden çalıyor. Dinleyici
/// yalnızca kendisini içeren özel bir toplu aygıta bağlanır; çıkış aygıtına (ör. AirPods) dokunmaz.
final class SystemAudioTap {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "org.teinn.tutanak.tap", qos: .userInteractive)

    /// excludeBundlePrefixes: bu paket kimlikleriyle başlayan süreçlerin sesi alınmaz (Tutanak'ın kendi oynatması)
    func start(excludeBundlePrefixes: [String], handler: @escaping (CMSampleBuffer) -> Void) throws {
        let excluded = audioProcessObjects().filter { obj in
            let bundle = readString(obj, kAudioProcessPropertyBundleID) ?? ""
            return excludeBundlePrefixes.contains { !$0.isEmpty && bundle.hasPrefix($0) }
        }
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        desc.uuid = UUID()
        desc.name = "Tutanak"
        desc.muteBehavior = .unmuted
        desc.isPrivate = true
        try check(AudioHardwareCreateProcessTap(desc, &tap), "Sistem sesi dinleyicisi oluşturulamadı")

        var asbd = AudioStreamBasicDescription()
        var addr = address(kAudioTapPropertyFormat)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &asbd), "Sistem sesi biçimi okunamadı")
        var format: CMAudioFormatDescription?
        try check(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                                 magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format),
                  "Sistem sesi biçimi tanımlanamadı")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Tutanak sistem sesi",
            kAudioAggregateDeviceUIDKey: "org.teinn.tutanak.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "Sistem sesi aygıtı oluşturulamadı")

        guard let format else { throw NSError(domain: "tutanak", code: 4) }
        let bytesPerFrame = Int(asbd.mBytesPerFrame)
        let rate = CMTimeScale(asbd.mSampleRate)
        try check(AudioDeviceCreateIOProcIDWithBlock(&proc, device, ioQueue) { _, input, inputTime, _, _ in
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard bytesPerFrame > 0, let first = list.first, first.mDataByteSize > 0 else { return }
            let pts = inputTime.pointee.mFlags.contains(.hostTimeValid)
                ? CMClockMakeHostTimeFromSystemUnits(inputTime.pointee.mHostTime)
                : CMClockGetTime(CMClockGetHostTimeClock())
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: rate), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            // Veri kopyalanır: aygıtın arabelleği yalnızca bu çağrı süresince geçerli
            guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil,
                                       refcon: nil, formatDescription: format, sampleCount: Int(first.mDataByteSize) / bytesPerFrame,
                                       sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
                                       sampleSizeArray: nil, sampleBufferOut: &sample) == noErr,
                  let sample,
                  CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault,
                                                                 blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
                                                                 bufferList: input) == noErr else { return }
            handler(sample)
        }, "Sistem sesi okunamadı")
        try check(AudioDeviceStart(device, proc), "Sistem sesi dinlemesi başlatılamadı")
    }

    func stop() {
        if let proc {
            AudioDeviceStop(device, proc)
            AudioDeviceDestroyIOProcID(device, proc)
        }
        proc = nil
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device) }
        device = AudioObjectID(kAudioObjectUnknown)
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        tap = AudioObjectID(kAudioObjectUnknown)
    }
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let dir: URL
    let mode: String
    var micDevice: String?
    let captureSystem: Bool
    let fps: Int
    let maxDim: Int
    let displayOption: String
    let shotInterval: Double
    let shotMaxDim: Int
    let excludeBundles: [String]
    let focusBundles: [String]

    let queue = DispatchQueue(label: "org.teinn.tutanak.samples")
    var stream: SCStream?
    var filter: SCContentFilter?
    var shotConfig: SCStreamConfiguration?
    var videoTrack: Track?
    var systemTrack: Track?
    var systemTap: SystemAudioTap?
    var micTrack: Track?
    var origin = CMTime.invalid
    var stopAt = CMTime.invalid
    var startDate = Date()
    var timers: [DispatchSourceTimer] = []
    var shots = 0
    var peaks: [String: Float] = ["mic": 0, "system": 0]
    var stopping = false
    var onDone: ((Int32) -> Void)?

    init(dir: URL) {
        self.dir = dir
        mode = option("--mode") ?? "video"
        let mic = option("--mic") ?? "default"
        micDevice = mic == "none" ? nil : mic
        captureSystem = (option("--system") ?? "1") != "0"
        fps = Int(min(60, max(1, number("--fps", 15))))
        maxDim = Int(max(320, number("--max-dim", 1920)))
        displayOption = option("--display") ?? "auto"
        shotInterval = max(2, number("--interval", 30))
        shotMaxDim = Int(max(320, number("--shot-max-dim", 1920)))
        excludeBundles = list("--exclude")
        focusBundles = list("--focus")
    }

    func pickDisplay(_ content: SCShareableContent) -> SCDisplay? {
        let displays = content.displays
        if let id = UInt32(displayOption), let d = displays.first(where: { $0.displayID == id }) { return d }
        if displayOption == "auto", !focusBundles.isEmpty {
            let windows = content.windows.filter { w in
                let bundle = w.owningApplication?.bundleIdentifier ?? ""
                return w.isOnScreen && w.frame.width > 300 && focusBundles.contains { bundle.hasPrefix($0) }
            }
            if let big = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
                let center = CGPoint(x: big.frame.midX, y: big.frame.midY)
                if let d = displays.first(where: { $0.frame.contains(center) }) { return d }
            }
        }
        return displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays.first
    }

    func start() async throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = pickDisplay(content) else { throw NSError(domain: "tutanak", code: 2, userInfo: [NSLocalizedDescriptionKey: "Ekran bulunamadı"]) }
        let excluded = content.applications.filter { excludeBundles.contains($0.bundleIdentifier) }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        self.filter = filter

        let scale = CGFloat(filter.pointPixelScale)
        let pxW = CGFloat(display.width) * scale
        let pxH = CGFloat(display.height) * scale
        func fitted(_ limit: Int) -> (Int, Int) {
            let k = min(1, CGFloat(limit) / max(pxW, pxH))
            return (even(pxW * k), even(pxH * k))
        }

        let config = SCStreamConfiguration()
        var size = (0, 0)
        if mode == "video" {
            size = fitted(maxDim)
            config.width = size.0
            config.height = size.1
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
            config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
            config.queueDepth = 6
            config.showsCursor = true
            let bitrate = max(1_000_000, min(8_000_000, Int(Double(size.0 * size.1 * fps) * 0.1)))
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: size.0,
                AVVideoHeightKey: size.1,
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                ],
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: bitrate,
                    AVVideoExpectedSourceFrameRateKey: fps,
                    AVVideoMaxKeyFrameIntervalKey: fps * 4,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                    AVVideoAllowFrameReorderingKey: false,
                ],
            ]
            videoTrack = try Track(name: "ekran", url: dir.appendingPathComponent("ekran.mp4"), fileType: .mp4,
                                   input: AVAssetWriterInput(mediaType: .video, outputSettings: settings))
        } else {
            // Yalnızca ses için de bir görüntü akışı gerekir; olabildiğince küçük tutulur
            config.width = 16
            config.height = 16
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 3
            config.showsCursor = false
        }
        if mode == "shots" {
            let shot = SCStreamConfiguration()
            let s = fitted(shotMaxDim)
            shot.width = s.0
            shot.height = s.1
            shot.showsCursor = false
            shotConfig = shot
            size = s
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("kareler"), withIntermediateDirectories: true)
        }
        origin = CMClockGetTime(CMClockGetHostTimeClock())
        startDate = Date()
        // Sistem sesi Core Audio dinleyicisiyle; olmazsa ScreenCaptureKit'in (yalnızca pencereli uygulamalar) sesiyle
        var systemVia = "none"
        if captureSystem {
            let tap = SystemAudioTap()
            do {
                try tap.start(excludeBundlePrefixes: excludeBundles) { [weak self] sample in
                    self?.queue.async { self?.appendSystem(sample) }
                }
                systemTap = tap
                systemVia = "tap"
            } catch {
                tap.stop()
                emit(["event": "warn", "message": "Sistem sesi doğrudan dinlenemedi (\(error.localizedDescription)); yalnızca pencereli uygulamaların sesi alınacak."])
                config.capturesAudio = true
                config.sampleRate = 48000
                config.channelCount = 2
                config.excludesCurrentProcessAudio = true
                systemVia = "screencapturekit"
            }
        }
        if let mic = micDevice {
            config.captureMicrophone = true
            if mic != "default" { config.microphoneCaptureDeviceID = mic }
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if systemVia == "screencapturekit" { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if micDevice != nil { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
        self.stream = stream
        do {
            try await stream.startCapture()
        } catch {
            systemTap?.stop()
            throw error
        }

        emit([
            "event": "started",
            "mode": mode,
            "display": Int(display.displayID),
            "width": size.0,
            "height": size.1,
            "mic": micDevice ?? "none",
            "system": captureSystem,
            "system_via": systemVia,
        ])
        startTimers()
    }

    func startTimers() {
        let levels = DispatchSource.makeTimerSource(queue: queue)
        levels.schedule(deadline: .now() + 1, repeating: 1)
        levels.setEventHandler { [weak self] in
            guard let self, !self.stopping else { return }
            emit(["event": "level", "t": Int(Date().timeIntervalSince(self.startDate)),
                  "mic": round2(Double(self.peaks["mic"] ?? 0)), "system": round2(Double(self.peaks["system"] ?? 0))])
            self.peaks = ["mic": 0, "system": 0]
        }
        levels.resume()
        timers.append(levels)
        if shotConfig != nil {
            let shots = DispatchSource.makeTimerSource(queue: queue)
            shots.schedule(deadline: .now() + 1, repeating: shotInterval)
            shots.setEventHandler { [weak self] in self?.takeShot() }
            shots.resume()
            timers.append(shots)
        }
    }

    func takeShot() {
        guard !stopping, let filter, let shotConfig else { return }
        let seconds = Int(Date().timeIntervalSince(startDate).rounded())
        let name = String(format: "%06d.jpg", seconds)
        let url = dir.appendingPathComponent("kareler").appendingPathComponent(name)
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: shotConfig) { [weak self] image, error in
            guard let self else { return }
            guard let image else {
                emit(["event": "warn", "message": "Ekran görüntüsü alınamadı: \(error?.localizedDescription ?? "bilinmeyen hata")"])
                return
            }
            if writeJPEG(image, to: url, quality: 0.72) {
                self.queue.async { self.shots += 1 }
                emit(["event": "shot", "file": "kareler/\(name)", "t": seconds])
            }
        }
    }

    func audioTrack(name: String, file: String, sample: CMSampleBuffer) -> Track? {
        guard let fd = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee else { return nil }
        let channels = max(1, min(2, Int(asbd.mChannelsPerFrame)))
        let rate = min(48000, max(8000, asbd.mSampleRate))
        var settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels]
        let bitrate = (rate >= 44100 ? 64000 : rate >= 32000 ? 48000 : 32000) * channels
        let probe = try? AVAssetWriter(outputURL: dir.appendingPathComponent(".probe-\(file)"), fileType: .m4a)
        if probe?.canApply(outputSettings: settings.merging([AVEncoderBitRateKey: bitrate]) { $1 }, forMediaType: .audio) == true {
            settings[AVEncoderBitRateKey] = bitrate
        }
        do {
            return try Track(name: name, url: dir.appendingPathComponent(file), fileType: .m4a,
                             input: AVAssetWriterInput(mediaType: .audio, outputSettings: settings, sourceFormatHint: fd))
        } catch {
            emit(["event": "warn", "message": "\(name) dosyası açılamadı: \(error.localizedDescription)"])
            return nil
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sample.isValid, !stopping else { return }
        switch type {
        case .screen:
            guard let videoTrack,
                  let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: raw) == .complete else { return }
            videoTrack.append(sample, origin: origin)
        case .audio:
            appendSystem(sample)
        case .microphone:
            if micTrack == nil { micTrack = audioTrack(name: "mikrofon", file: "mikrofon.m4a", sample: sample) }
            micTrack?.append(sample, origin: origin)
            peaks["mic"] = max(peaks["mic"] ?? 0, peakLevel(sample))
        @unknown default:
            break
        }
    }

    /// queue üzerinde çağrılır
    func appendSystem(_ sample: CMSampleBuffer) {
        guard !stopping else { return }
        if systemTrack == nil { systemTrack = audioTrack(name: "sistem sesi", file: "sistem.m4a", sample: sample) }
        systemTrack?.append(sample, origin: origin)
        peaks["system"] = max(peaks["system"] ?? 0, peakLevel(sample))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "warn", "message": "Kayıt akışı durdu: \(error.localizedDescription)"])
        stop(code: 3)
    }

    func stop(code: Int32 = 0) {
        queue.async { [self] in
            guard !stopping else { return }
            stopping = true
            stopAt = CMClockGetTime(CMClockGetHostTimeClock())
            timers.forEach { $0.cancel() }
            Task {
                // Dinleyici örnek kuyruğunun dışında durdurulur (aygıt durdurma işi kuyruğa bırakılmış blokları bekleyebilir)
                self.systemTap?.stop()
                try? await self.stream?.stopCapture()
                self.queue.async { self.finalize(code: code) }
            }
        }
    }

    func finalize(code: Int32) {
        let tracks = [videoTrack, systemTrack, micTrack].compactMap { $0 }
        let group = DispatchGroup()
        for t in tracks {
            group.enter()
            t.finish(at: stopAt) { group.leave() }
        }
        group.notify(queue: queue) { [self] in
            for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
            where f.lastPathComponent.hasPrefix(".probe-") {
                try? FileManager.default.removeItem(at: f)
            }
            var files: [String: Any] = [:]
            if let videoTrack { files["video"] = videoTrack.summary }
            if let systemTrack { files["system"] = systemTrack.summary }
            if let micTrack { files["mic"] = micTrack.summary }
            emit([
                "event": "stopped",
                "duration": round2(CMTimeGetSeconds(stopAt) - CMTimeGetSeconds(origin)),
                "shots": shots,
                "files": files,
            ])
            onDone?(code)
        }
    }
}

func record() async -> Never {
    guard let dirPath = option("--dir") else { fail("--dir gerekli") }
    if !CGPreflightScreenCaptureAccess() {
        fail("Ekran kaydı izni yok. Sistem Ayarları → Gizlilik ve Güvenlik → Ekran ve Sistem Sesi Kaydı'ndan Tutanak'a izin verin.", kind: "screen_permission")
    }
    let rec = Recorder(dir: URL(fileURLWithPath: dirPath))
    if rec.captureSystem {
        if tccPreflight("kTCCServiceAudioCapture") == 2 { _ = await tccRequest("kTCCServiceAudioCapture") }
        if tccPreflight("kTCCServiceAudioCapture") == 1 {
            emit(["event": "warn", "kind": "audio_permission",
                  "message": "Sistem sesi kaydı izni yok; karşı tarafın sesi sessiz kaydedilecek. Sistem Ayarları → Gizlilik ve Güvenlik → Ekran ve Sistem Sesi Kaydı."])
        }
    }
    if rec.micDevice != nil {
        var status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            status = AVCaptureDevice.authorizationStatus(for: .audio)
        }
        if status != .authorized {
            rec.micDevice = nil
            emit(["event": "warn", "kind": "mic_permission", "message": "Mikrofon izni yok; yalnızca karşı tarafın sesi kaydedilecek."])
        }
    }
    do {
        try await rec.start()
    } catch {
        let ns = error as NSError
        let kind = ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue ? "screen_permission" : "error"
        fail("Kayıt başlatılamadı: \(error.localizedDescription)", kind: kind)
    }
    onStdin { line in if line == nil || line == "stop" { rec.stop() } }
    onSignals { rec.stop() }
    let code = await withCheckedContinuation { (c: CheckedContinuation<Int32, Never>) in rec.onDone = { c.resume(returning: $0) } }
    exit(code)
}


// MARK: - döküm (macOS 26 SpeechAnalyzer, cihaz üzerinde)

typealias Word = (start: Double, end: Double, text: String)

func words(of text: AttributedString, range: CMTimeRange) -> [Word] {
    var out: [Word] = []
    for run in text.runs {
        let s = String(text[run.range].characters)
        if let tr = run.audioTimeRange {
            out.append((CMTimeGetSeconds(tr.start), CMTimeGetSeconds(tr.end), s))
        } else if !out.isEmpty {
            out[out.count - 1].text += s
        } else {
            let t = CMTimeGetSeconds(range.start)
            out.append((t, t, s))
        }
    }
    // Baştaki sessizlikten sonra gelen ilk kelimeye bazen 0 anı veriliyor: sonraki kelimenin hemen önüne taşınır
    if out.count >= 2, out[0].start <= CMTimeGetSeconds(range.start) + 0.05, out[1].start - out[0].end > 1.5 {
        let length = min(1.0, max(0.3, out[0].end - out[0].start))
        out[0] = (out[1].start - length, out[1].start, out[0].text)
    }
    return out
}

/// Kelimeleri duraklamalara ve uzunluğa göre okunabilir parçalara böler
func segments(_ words: [Word]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    var cur: [Word] = []
    func flush() {
        guard let first = cur.first, let last = cur.last else { return }
        let text = cur.map(\.text).joined().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !text.isEmpty { out.append(["start": round2(first.start), "end": round2(last.end), "text": text]) }
        cur = []
    }
    for w in words {
        if let last = cur.last, let first = cur.first {
            let gap = w.start - last.end
            let span = w.end - first.start
            let sentenceEnd = last.text.trimmingCharacters(in: .whitespaces).last.map { ".?!…".contains($0) } ?? false
            if gap >= 0.9 || (gap >= 0.4 && cur.count >= 10) || (gap >= 0.2 && span >= 12) || (sentenceEnd && cur.count >= 5)
                || cur.count >= 32 || span >= 18 {
                flush()
            }
        }
        cur.append(w)
    }
    flush()
    return out
}

@available(macOS 26.0, *)
func ensureAssets(_ modules: [any SpeechModule]) async throws {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        emit(["event": "assets", "message": "Dil modeli hazırlanıyor…"])
        try await request.downloadAndInstall()
    }
}

@available(macOS 26.0, *)
func transcribe() async -> Never {
    guard let input = option("--input") else { fail("--input gerekli") }
    let locale = Locale(identifier: option("--locale") ?? "tr-TR")
    let tag = locale.identifier(.bcp47)
    do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: input))
        let duration = Double(file.length) / file.processingFormat.sampleRate
        var all: [Word] = []
        let progress = { (end: CMTime) in emit(["event": "progress", "t": round2(CMTimeGetSeconds(end)), "duration": round2(duration)]) }
        let engine: String
        if await SpeechTranscriber.supportedLocales.contains(where: { $0.identifier(.bcp47) == tag }) {
            engine = "apple-speech"
            let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
            try await ensureAssets([module])
            let analyzer = SpeechAnalyzer(modules: [module])
            let collector = Task { () -> [Word] in
                var w: [Word] = []
                for try await r in module.results where r.isFinal {
                    w += words(of: r.text, range: r.range)
                    progress(r.range.end)
                }
                return w
            }
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            all = try await collector.value
        } else if await DictationTranscriber.supportedLocales.contains(where: { $0.identifier(.bcp47) == tag }) {
            engine = "apple-dictation"
            let module = DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
                                              reportingOptions: [], attributeOptions: [.audioTimeRange])
            try await ensureAssets([module])
            let analyzer = SpeechAnalyzer(modules: [module])
            let collector = Task { () -> [Word] in
                var w: [Word] = []
                for try await r in module.results where r.isFinal {
                    w += words(of: r.text, range: r.range)
                    progress(r.range.end)
                }
                return w
            }
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            all = try await collector.value
        } else {
            fail("Bu dil cihaz üzerinde dökülemiyor: \(tag)", kind: "locale")
        }
        all.sort { $0.start < $1.start }
        finish(["event": "done", "engine": engine, "locale": tag, "duration": round2(duration), "segments": segments(all)])
    } catch {
        fail("Döküm başarısız: \(error.localizedDescription)")
    }
}

// MARK: - kareleri küçültme ve tekrarları ayıklama

/// 48×48 gri küçük resim; menü çubuğu (saat) karşılaştırmaya girmesin diye üst satırlar atlanır
func signature(_ image: CGImage) -> [UInt8] {
    let side = 48
    var pixels = [UInt8](repeating: 0, count: side * side)
    pixels.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    }
    return pixels
}

/// 6×6 piksellik hücrelerdeki ortalama mutlak farkın en büyüğü (0…1)
func maxCellDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
    let side = 48, cell = 6
    var worst = 0.0
    for cy in stride(from: cell, to: side, by: cell) {
        for cx in stride(from: 0, to: side, by: cell) {
            var sum = 0
            for y in cy..<(cy + cell) {
                for x in cx..<(cx + cell) { sum += abs(Int(a[y * side + x]) - Int(b[y * side + x])) }
            }
            worst = max(worst, Double(sum) / Double(cell * cell * 255))
        }
    }
    return worst
}

func shrinkImages() -> Never {
    guard let dirPath = option("--dir") else { fail("--dir gerekli") }
    let quality = min(0.95, max(0.2, number("--quality", 0.5)))
    let maxDim = Int(max(320, number("--max-dim", 1600)))
    let dedupe = max(0, number("--dedupe", 0.03))
    let dir = URL(fileURLWithPath: dirPath)
    let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
        .filter { $0.pathExtension.lowercased() == "jpg" }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    var before = 0, after = 0, removed = 0
    var previous: [UInt8]?
    let options = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxDim,
    ] as CFDictionary
    for file in files {
        let size = fileSize(file)
        before += size
        guard let src = CGImageSourceCreateWithURL(file as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(src, 0, options) else { after += size; continue }
        let sig = signature(image)
        if dedupe > 0, let previous, maxCellDiff(previous, sig) < dedupe {
            try? FileManager.default.removeItem(at: file)
            removed += 1
            continue
        }
        previous = sig
        let tmp = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).tmp")
        if writeJPEG(image, to: tmp, quality: quality), fileSize(tmp) > 0, fileSize(tmp) < size {
            _ = try? FileManager.default.replaceItemAt(file, withItemAt: tmp)
        } else {
            try? FileManager.default.removeItem(at: tmp)
        }
        after += fileSize(file)
    }
    finish(["event": "done", "before": before, "after": after, "removed": removed, "kept": files.count - removed])
}

// MARK: - giriş

@main
struct Main {
    static func main() async {
        guard args.count >= 2 else { fail("Kullanım: tutanak-helper watch|windows|permissions|devices|record|transcribe|shrink-images") }
        switch args[1] {
        case "watch": watch()
        case "windows": windows()
        case "permissions": permissions()
        case "request-screen": finish(["screen": CGRequestScreenCaptureAccess()])
        case "request-audio":
            let ok = await tccRequest("kTCCServiceAudioCapture")
            finish(["audio": ok, "status": audioStatusName()])
        case "request-mic":
            let ok = await AVCaptureDevice.requestAccess(for: .audio)
            finish(["mic": ok, "status": micStatusName()])
        case "devices": devices()
        case "record": await record()
        case "transcribe":
            if #available(macOS 26.0, *) { await transcribe() }
            fail("Döküm için macOS 26 gerekir", kind: "os")
        case "shrink-images": shrinkImages()
        default: fail("Bilinmeyen komut: \(args[1])")
        }
    }
}
