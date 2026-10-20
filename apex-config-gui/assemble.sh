#!/usr/bin/env bash
# 手工组装 Windows x64 免安装版:
# 1) 解压官方 electron-v<EV>-win32-x64.zip  2) 注入 resources/app  3) 压缩 zip
# 用法: ELECTRON_ZIP=/path/to/electron-vX-win32-x64.zip bash assemble.sh
set -euo pipefail
cd "$(dirname "$0")"

ELECTRON_ZIP=${ELECTRON_ZIP:?请通过 ELECTRON_ZIP 环境变量指定下载好的官方运行时 zip}
EV=${ELECTRON_VERSION:?请指定 ELECTRON_VERSION, 例如 44.9.0}
OUT="release/ApexConfigTool-win32-x64"

rm -rf release "$OUT"
mkdir -p release
unzip -q "$ELECTRON_ZIP" -d "$OUT"
# 默认入口换成我们的应用: 重命名 exe 并注入 resources/app
mv "$OUT/electron.exe" "$OUT/ApexConfigTool.exe"
rm -f "$OUT/resources/default_app.asar"
mkdir -p "$OUT/resources/app/renderer"
cp main.js backend.js preload.js plaza.js package.json "$OUT/resources/app/"
cp renderer/index.html renderer/style.css renderer/app.js "$OUT/resources/app/renderer/"
mkdir -p "$OUT/resources/app/node_modules"
cp -R node_modules/adm-zip "$OUT/resources/app/node_modules/"

cd release
rm -f ApexConfigTool-win-x64.zip
zip -qr ApexConfigTool-win-x64.zip ApexConfigTool-win32-x64
echo "OK: $(pwd)/ApexConfigTool-win-x64.zip"
ls -la ApexConfigTool-win-x64.zip
