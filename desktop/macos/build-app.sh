#!/bin/zsh
set -euo pipefail

APP_SOURCE_DIR="${0:A:h}"
PROJECT_DIR="${APP_SOURCE_DIR:h:h}"
BUILD_DIR="${PROJECT_DIR}/.local/macos-build"
APP_BUNDLE="${BUILD_DIR}/LibreTV.app"
CONTENTS_DIR="${APP_BUNDLE}/Contents"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"

if [[ "$(/usr/bin/uname -m)" != "arm64" ]]; then
  print -u2 -- "当前桌面构建脚本支持 Apple Silicon Mac。"
  exit 1
fi
NODE_EXECUTABLE="${LIBRETV_NODE_EXECUTABLE:-$(command -v node || true)}"
if [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  print -u2 -- "找不到 Node.js；请安装 Node.js 20.18.1+，或设置 LIBRETV_NODE_EXECUTABLE 为其完整路径。"
  exit 1
fi
NODE_EXECUTABLE="${NODE_EXECUTABLE:A}"
for required_file in LibreTVApp.swift Info.plist AppIcon.icns; do
  if [[ ! -f "${APP_SOURCE_DIR}/${required_file}" ]]; then
    print -u2 -- "缺少构建文件：${APP_SOURCE_DIR}/${required_file}"
    exit 1
  fi
done
SDK_PATH="$(/usr/bin/xcrun --sdk macosx --show-sdk-path)"
SWIFTC_PATH="$(/usr/bin/xcrun --find swiftc)"
/usr/bin/plutil -lint "${APP_SOURCE_DIR}/Info.plist"
/bin/mkdir -p "${CONTENTS_DIR}/MacOS" "${RESOURCES_DIR}" "${BUILD_DIR}/module-cache"

# Generate machine-specific paths only inside ignored build output. No password
# or source configuration is read or copied into the application bundle.
"${NODE_EXECUTABLE}" - "${PROJECT_DIR}" "${RESOURCES_DIR}" "${NODE_EXECUTABLE}" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const [projectDirectory, resources, nodeExecutable] = process.argv.slice(2);
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && (minor < 18 || (minor === 18 && patch < 1)))) {
  throw new Error('需要 Node.js 20.18.1 或更新版本');
}
const { version } = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package.json'), 'utf8'));
const configuration = { projectDirectory, baseURL: 'http://localhost:8080', expectedVersion: version, nodeExecutable };
fs.writeFileSync(path.join(resources, 'LocalServer.json'), JSON.stringify(configuration, null, 2) + '\n');
JS

"${SWIFTC_PATH}" \
  -sdk "${SDK_PATH}" \
  -target arm64-apple-macos14.0 \
  -swift-version 5 \
  -parse-as-library \
  -O -whole-module-optimization \
  -module-cache-path "${BUILD_DIR}/module-cache" \
  -framework AppKit -framework WebKit \
  "${APP_SOURCE_DIR}/LibreTVApp.swift" \
  -o "${CONTENTS_DIR}/MacOS/LibreTV"

/bin/cp "${APP_SOURCE_DIR}/Info.plist" "${CONTENTS_DIR}/Info.plist"
/bin/cp "${APP_SOURCE_DIR}/AppIcon.icns" "${RESOURCES_DIR}/AppIcon.icns"
/bin/cp "${APP_SOURCE_DIR}/LibreTVApp.swift" "${RESOURCES_DIR}/LibreTVApp.swift"
/bin/cp "${PROJECT_DIR}/LICENSE" "${RESOURCES_DIR}/LICENSE"
/bin/chmod 755 "${CONTENTS_DIR}/MacOS/LibreTV"
/usr/bin/codesign --force --sign - "${APP_BUNDLE}"
/usr/bin/codesign --verify --deep --strict --verbose=2 "${APP_BUNDLE}"
print -- "构建完成：${APP_BUNDLE}"
print -- "运行前请在项目根目录完成 npm ci、配置 .env.local 并执行 npm run build。"
