#!/usr/bin/env bash
# 打包 Windows x64 免安装版: 产物 release/ApexConfigTool-win32-x64/, 并压缩为 zip
set -euo pipefail
cd "$(dirname "$0")"

APP_VERSION=$(node -p "require('./package.json').version")
ELECTRON_VERSION=$(npm view electron version)

echo "electron $ELECTRON_VERSION / app $APP_VERSION"
npx --yes @electron/packager . ApexConfigTool \
  --platform=win32 \
  --arch=x64 \
  --electron-version="$ELECTRON_VERSION" \
  --app-version="$APP_VERSION" \
  --app-bundle-id=com.yg.apexcfg \
  --out=release \
  --overwrite \
  --ignore="^/test($|/)" \
  --ignore="^/release($|/)" \
  --ignore="^/\\.git($|/)" \
  --ignore="^/build\\.sh$"

cd release
rm -f ApexConfigTool-win-x64.zip
zip -qr ApexConfigTool-win-x64.zip ApexConfigTool-win32-x64
echo "OK: $(pwd)/ApexConfigTool-win-x64.zip"
