import AppKit
import WebKit

struct LocalServerConfiguration: Decodable {
    let projectDirectory: String
    let baseURL: URL
    let expectedVersion: String
    let nodeExecutable: String
}

struct AppFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class LibreTVAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSToolbarDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var overlay: NSView!
    private var statusLabel: NSTextField!
    private var spinner: NSProgressIndicator!
    private var retryButton: NSButton!
    private var configuration: LocalServerConfiguration!
    private var startupTask: Task<Void, Never>?
    private var serverProcess: Process?
    private var lastLocalURL: URL?
    private var downloadDestinations: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    private let networkDelegate = NoRedirectDelegate()
    private lazy var session: URLSession = {
        let settings = URLSessionConfiguration.ephemeral
        settings.httpCookieStorage = nil
        settings.httpShouldSetCookies = false
        settings.urlCache = nil
        settings.timeoutIntervalForRequest = 3
        return URLSession(configuration: settings, delegate: networkDelegate, delegateQueue: nil)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let location = Bundle.main.url(forResource: "LocalServer", withExtension: "json") else {
                throw AppFailure(message: "应用缺少本地服务配置。")
            }
            configuration = try JSONDecoder().decode(LocalServerConfiguration.self, from: Data(contentsOf: location))
            guard configuration.baseURL.scheme == "http", configuration.baseURL.host == "localhost",
                  configuration.baseURL.port == 8080 else {
                throw AppFailure(message: "本地服务地址配置无效。")
            }
            // A fresh checkout does not contain the ignored local runtime directory.
            let runtimeDirectory = URL(fileURLWithPath: configuration.projectDirectory, isDirectory: true)
                .appendingPathComponent(".local", isDirectory: true)
            try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
            buildMenu()
            buildWindow()
            startApplication()
        } catch {
            let alert = NSAlert()
            alert.messageText = "LibreTV 无法启动"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    private func buildMenu() {
        let main = NSMenu()
        let application = NSMenuItem()
        main.addItem(application)
        let appMenu = NSMenu(title: "LibreTV")
        appMenu.addItem(withTitle: "关于 LibreTV", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 LibreTV", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 LibreTV", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = appMenu

        let edit = NSMenuItem()
        main.addItem(edit)
        let editMenu = NSMenu(title: "编辑")
        for (title, selector, shortcut) in [
            ("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
            ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")
        ] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: shortcut)
        }
        edit.submenu = editMenu

        let view = NSMenuItem()
        main.addItem(view)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "首页", action: #selector(goHome), keyEquivalent: "1")
        viewMenu.addItem(withTitle: "刷新", action: #selector(reloadPage), keyEquivalent: "r")
        let fullscreen = viewMenu.addItem(withTitle: "切换全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.control, .command]
        view.submenu = viewMenu

        let windows = NSMenuItem()
        main.addItem(windows)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windows.submenu = windowMenu
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }

    private func buildWindow() {
        let webSettings = WKWebViewConfiguration()
        webSettings.websiteDataStore = .default()
        webSettings.mediaTypesRequiringUserActionForPlayback = []
        webSettings.allowsAirPlayForMediaPlayback = true
        webSettings.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: webSettings)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // WebKit reparents this view into its own window for element fullscreen.
        // Auto Layout constraints to the original host can collapse that viewport
        // to zero (WebKit bug 313802). Keep the web view frame-based so it can move.
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "LibreTV"
        window.minSize = NSSize(width: 900, height: 620)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("LibreTVMainWindow")
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.appearance = NSAppearance(named: .darkAqua)
        let toolbar = NSToolbar(identifier: "LibreTVToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact

        let content = NSView()
        window.contentView = content
        webView.frame = content.bounds
        content.addSubview(webView)

        overlay = NSView()
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        overlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: content.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .regular
        statusLabel = NSTextField(wrappingLabelWithString: "正在打开 LibreTV…")
        statusLabel.alignment = .center
        statusLabel.font = .systemFont(ofSize: 16)
        retryButton = NSButton(title: "重试", target: self, action: #selector(retryStartup))
        retryButton.isHidden = true
        let stack = NSStackView(views: [spinner, statusLabel, retryButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.widthAnchor.constraint(equalToConstant: 580)
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.init("back"), .init("home"), .init("reload"), .flexibleSpace]
    }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.init("back"), .init("home"), .init("reload"), .flexibleSpace]
    }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let choices: [String: (String, String, Selector)] = [
            "back": ("返回", "chevron.left", #selector(goBack)),
            "home": ("首页", "house", #selector(goHome)),
            "reload": ("刷新", "arrow.clockwise", #selector(reloadPage))
        ]
        guard let (label, symbol, action) = choices[identifier.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier)
        item.label = label
        item.toolTip = label
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        item.target = self
        item.action = action
        return item
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "LibreTV",
            .applicationVersion: "2.16.12 · 本地应用版",
            .credits: NSAttributedString(string: "LibreSpark / LibreTV\n使用本机已部署的服务与影视源。\nAGPL-3.0-or-later")
        ])
    }
    @objc private func goBack() { if webView.canGoBack { webView.goBack() } }
    @objc private func goHome() { lastLocalURL = configuration.baseURL; webView.load(URLRequest(url: configuration.baseURL)) }
    @objc private func reloadPage() { if overlay.isHidden { webView.reload() } else { startApplication() } }
    @objc private func retryStartup() { startApplication() }

    private func showStatus(_ message: String, failed: Bool = false) {
        writeStatusLog(message, failed: failed)
        overlay.isHidden = false
        statusLabel.stringValue = message
        retryButton.isHidden = !failed
        if failed { spinner.stopAnimation(nil) } else { spinner.startAnimation(nil) }
    }

    private func writeStatusLog(_ message: String, failed: Bool = false) {
        if let configuration {
            let logURL = URL(fileURLWithPath: configuration.projectDirectory).appendingPathComponent(".local/mac-app-status.log")
            let entry = "\(Date().ISO8601Format()) \(failed ? "ERROR" : "INFO") \(message)\n"
            if let data = entry.data(using: .utf8) {
                if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
                if let log = try? FileHandle(forWritingTo: logURL) { try? log.seekToEnd(); try? log.write(contentsOf: data); try? log.close() }
            }
        }
    }

    private func startApplication() {
        startupTask?.cancel()
        showStatus("正在连接本地 LibreTV…")
        startupTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await ensureServer()
                try Task.checkCancellation()
                showStatus("正在恢复登录状态…")
                try await authenticate()
                try Task.checkCancellation()
                showStatus("正在载入 LibreTV…")
                webView.load(URLRequest(url: lastLocalURL ?? configuration.baseURL))
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                showStatus(error.localizedDescription + "\n\n本地日志：" + configuration.projectDirectory + "/.local/server.log", failed: true)
            }
        }
    }

    private func localRequest(_ path: String, timeout: TimeInterval = 3) -> URLRequest {
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path))
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    private func serverReady() async throws -> Bool {
        let response: (Data, URLResponse)
        do { response = try await session.data(for: localRequest("api/status", timeout: 1)) }
        catch let error as URLError where [.cannotConnectToHost, .networkConnectionLost, .timedOut, .notConnectedToInternet].contains(error.code) {
            return false
        }
        guard let http = response.1 as? HTTPURLResponse, http.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: response.0) as? [String: Any],
              body["version"] as? String == configuration.expectedVersion,
              body["passwordRequired"] is Bool, body["defaultSources"] is [[String: Any]] else {
            throw AppFailure(message: "8080 端口上的服务不是此版本的 LibreTV，请先检查端口占用。")
        }
        return true
    }

    private func ensureServer() async throws {
        if try await serverReady() { return }
        try Task.checkCancellation()
        showStatus("正在启动本地 LibreTV 服务…")
        let root = URL(fileURLWithPath: configuration.projectDirectory, isDirectory: true)
        let node = URL(fileURLWithPath: configuration.nodeExecutable)
        let entryPoint = root.appendingPathComponent("node_modules/next/dist/bin/next")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.isReadableFile(atPath: entryPoint.path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent(".next/BUILD_ID").path) else {
            throw AppFailure(message: "找不到已部署的 LibreTV。请保留项目目录：\n" + root.path)
        }
        let process: Process
        if let existing = serverProcess, existing.isRunning {
            process = existing
        } else {
            if let previous = serverProcess { clearOwnedPID(previous, root: root) }
            try Task.checkCancellation()
            let logURL = root.appendingPathComponent(".local/server.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            defer { try? log.close() }
            process = Process()
            process.executableURL = node
            process.arguments = [entryPoint.path, "start", "--hostname", "127.0.0.1", "--port", "8080"]
            process.currentDirectoryURL = root
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            environment["NODE_ENV"] = "production"
            environment["NEXT_TELEMETRY_DISABLED"] = "1"
            process.environment = environment
            process.standardOutput = log
            process.standardError = log
            process.standardInput = FileHandle.nullDevice
            try process.run()
            serverProcess = process
            try "\(process.processIdentifier)\n".write(to: root.appendingPathComponent(".local/server.pid"), atomically: true, encoding: .utf8)
        }
        for _ in 0..<80 {
            try Task.checkCancellation()
            if try await serverReady() { return }
            if !process.isRunning {
                clearOwnedPID(process, root: root)
                throw AppFailure(message: "本地服务启动失败，请检查日志后重试。")
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        if process.isRunning { process.terminate() }
        clearOwnedPID(process, root: root)
        throw AppFailure(message: "启动本地服务超时，请检查日志后重试。")
    }

    private func clearOwnedPID(_ process: Process, root: URL) {
        let pidURL = root.appendingPathComponent(".local/server.pid")
        if let pid = try? String(contentsOf: pidURL, encoding: .utf8),
           pid.trimmingCharacters(in: .whitespacesAndNewlines) == String(process.processIdentifier) {
            try? FileManager.default.removeItem(at: pidURL)
        }
        if serverProcess === process { serverProcess = nil }
    }

    private func authenticate() async throws {
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let cookies = await withCheckedContinuation { continuation in
            store.getAllCookies { continuation.resume(returning: $0) }
        }
        let localCookies = cookies.filter { $0.name == "ltv_session" && $0.domain == "localhost" && ($0.expiresDate ?? .distantPast) > Date() }
        if !localCookies.isEmpty {
            var check = localRequest("api/auth")
            for (key, value) in HTTPCookie.requestHeaderFields(with: localCookies) { check.setValue(value, forHTTPHeaderField: key) }
            let (data, response) = try await session.data(for: check)
            if (response as? HTTPURLResponse)?.statusCode == 200,
               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], body["verified"] as? Bool == true {
                writeStatusLog("已恢复应用登录状态。")
                return
            }
        }
        let envURL = URL(fileURLWithPath: configuration.projectDirectory).appendingPathComponent(".env.local")
        let env = try String(contentsOf: envURL, encoding: .utf8)
        guard let line = env.components(separatedBy: .newlines).first(where: { $0.hasPrefix("PASSWORD=") }) else {
            throw AppFailure(message: "本地配置中缺少访问密码。")
        }
        var password = String(line.dropFirst("PASSWORD=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        if (password.hasPrefix("\"") && password.hasSuffix("\"")) || (password.hasPrefix("'") && password.hasSuffix("'")) {
            password = String(password.dropFirst().dropLast())
        }
        guard !password.isEmpty else { throw AppFailure(message: "本地访问密码为空。") }
        var login = localRequest("api/auth")
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONSerialization.data(withJSONObject: ["password": password])
        let (_, response) = try await session.data(for: login)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw AppFailure(message: "自动登录失败，请检查本地密码配置。")
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields { headers[String(describing: key)] = String(describing: value) }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: configuration.baseURL)
            .first(where: { $0.name == "ltv_session" && $0.domain == "localhost" && $0.isHTTPOnly }) else {
            throw AppFailure(message: "服务没有返回有效的登录凭据。")
        }
        await withCheckedContinuation { continuation in store.setCookie(cookie) { continuation.resume() } }
        writeStatusLog("本地自动登录完成。")
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == configuration.baseURL.scheme && url.host == configuration.baseURL.host &&
        url.port == configuration.baseURL.port && url.user == nil && url.password == nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload && (isLocal(url) || (url.scheme == "blob" && webView.url.map(isLocal) == true)) {
            decisionHandler(.download)
        } else if action.targetFrame?.isMainFrame == false {
            decisionHandler(["http", "https", "blob", "about"].contains(url.scheme ?? "") ? .allow : .cancel)
        } else if isLocal(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            if action.navigationType == .linkActivated && ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = webView.url, isLocal(url) { lastLocalURL = url }
        writeStatusLog("本地页面载入完成。")
        overlay.isHidden = true
        spinner.stopAnimation(nil)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { handleNavigationFailure(error) }
    private func handleNavigationFailure(_ error: Error) {
        let failure = error as NSError
        if failure.code == NSURLErrorCancelled || (failure.domain == "WebKitErrorDomain" && failure.code == 102) { return }
        showStatus("页面载入失败，可点击重试自动连接服务。\n" + error.localizedDescription, failed: true)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { startApplication() }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, isLocal(url) { webView.load(action.request) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "LibreTV"; alert.informativeText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "LibreTV"; alert.informativeText = message
        alert.addButton(withTitle: "继续"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "LibreTV"; alert.informativeText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24); alert.accessoryView = field
        alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let destination = panel.url, let self else { completionHandler(nil); return }
            let temporary = destination.deletingLastPathComponent().appendingPathComponent(".libretv-" + UUID().uuidString)
            self.downloadDestinations[ObjectIdentifier(download)] = (temporary, destination)
            completionHandler(temporary)
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let files = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do {
            if FileManager.default.fileExists(atPath: files.destination.path) {
                _ = try FileManager.default.replaceItemAt(files.destination, withItemAt: files.temporary)
            } else { try FileManager.default.moveItem(at: files.temporary, to: files.destination) }
        } catch { presentError("保存下载失败", error.localizedDescription) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let files = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: files.temporary) }
        if (error as NSError).code != NSURLErrorCancelled { presentError("下载失败", error.localizedDescription) }
    }
    private func presentError(_ title: String, _ detail: String) {
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }
    func applicationWillTerminate(_ notification: Notification) { startupTask?.cancel(); webView?.stopLoading(); session.invalidateAndCancel() }
}

@main
struct LibreTVLauncher {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = LibreTVAppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
