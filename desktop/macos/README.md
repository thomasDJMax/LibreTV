# LibreTV macOS 桌面窗口

使用 AppKit + WKWebView 打开本地 LibreTV，支持 Apple Silicon、macOS 14 及以上。窗口包含返回、首页、刷新、网页全屏、下载与文件选择，并可自动启动本地服务和恢复登录。使用与原安装版相同的 `cn.local.libretv.desktop` 标识及默认网站数据存储。

## 全屏黑屏修复

进入播放器的元素全屏时，WebKit 会将 WKWebView 移到专用全屏窗口。原来连接该视图和宿主的四条 Auto Layout 约束会令显示区域缩为 `0×0`，出现全屏黑屏。

`LibreTVApp.swift` 保留普通 NSView 宿主，将 WKWebView 设置为 `translatesAutoresizingMaskIntoConstraints = true`，使用 `.width/.height` 自动调整大小，并用宿主 bounds 初始化 frame。WKWebView 不再被原宿主的四边约束固定；加载遮罩继续使用 Auto Layout。此处理与 [WebKit 问题 313802 的规避方法](https://bugs.webkit.org/show_bug.cgi?id=313802)一致。

2026-10-24 的安装版实播记录已验证：进入全屏、退出后再次进入、暂停及继续播放，显示区域由异常的 `0×0` 恢复为 `2056×1285`，原播放进度和设置保留。发布整理时再次核对了安装版源码、二进制哈希和签名与该记录一致。该实播记录只覆盖当时的 Mac、屏幕与视频源，不代表其他显示器或系统版本已测试。

## 从源码构建

需要 Xcode Command Line Tools（提供 Swift 编译器及 macOS SDK）和 Node.js 20.18.1+。在仓库根目录运行：

```sh
npm ci
# 首次部署时从 .env.example 创建 .env.local，并设置自己的 PASSWORD。
# 已有 .env.local 时保留原文件。
npm run build
zsh desktop/macos/build-app.sh
```

生成 `.local/macos-build/LibreTV.app`。退出原 LibreTV 后，可将新应用复制到“应用程序”替换旧版；首次替换前保留旧应用备份。构建脚本本身不安装或启动应用，也不改动已有观看记录和设置。应用使用本机 ad-hoc 签名，构建时自动验证签名。

脚本根据当前仓库位置、Node 可执行文件路径与 `package.json` 版本生成应用内的 `LocalServer.json`。如果 Node 不在 PATH 中，可指定：

```sh
LIBRETV_NODE_EXECUTABLE=/path/to/node zsh desktop/macos/build-app.sh
```

应用依赖当前仓库的 `node_modules`、`.next` 和 `.env.local`，不是包含服务端的独立分发安装包。移动仓库或 Node 后需重新构建。服务绑定 `127.0.0.1:8080`，窗口访问 `http://localhost:8080`；已有同版本服务会直接复用。

密码仅在运行时从本机 `.env.local` 读取并提交到固定本地登录接口，不打包到应用。构建产物、生成的本机路径配置、日志和配置备份均位于忽略的 `.local/` 下。应用启动时也会创建该目录，支持干净仓库或清理运行日志后的首次启动。

## 回归验证

- 构建脚本通过 shell 语法检查；Swift 编译与严格签名验证通过。
- 保持 `WKWebView` 使用 frame/autoresizing；以后不要重新给它增加跨宿主四边约束。
- 在安装版播放器内进入全屏，确认真实画面与控制栏显示；退出后再次进入，并检查暂停、继续和播放进度。
- 窗口绿色全屏按钮与播放器的“全屏”是不同入口，复测应包含播放器元素全屏。

本目录沿用仓库的 AGPL-3.0-or-later 许可证，构建产物内包含 Swift 源码和许可证。
