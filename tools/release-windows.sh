#!/usr/bin/env bash
# 将 Windows 三件套发布到 GitHub Releases:
#   1. ApexConfigTool-win-x64.zip  完整 exe 图形版 (Neutralino + WebView2, ~1.2MB)
#   2. ApexCfgTool-win.zip         控制台版 (Start.bat → PowerShell)
#   3. apex_cfg_tool.py            Python 单文件脚本
# 前置: 安装并登录 gh (brew install gh && gh auth login)
# 用法: ./tools/release-windows.sh v1.2.0 ["更新说明"]
set -euo pipefail

VERSION="${1:?用法: ./tools/release-windows.sh v1.2.0 [说明]}"
NOTES="${2:-Windows 工具三件套更新 (exe 图形版 / bat 控制台 / python 脚本)}"
REPO="Lucasss1916/LetsLogin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS=(
  "$ROOT/web/public/downloads/ApexConfigTool-win-x64.zip"
  "$ROOT/web/public/downloads/ApexCfgTool-win.zip"
  "$ROOT/web/public/downloads/apex_cfg_tool.py"
)

for asset in "${ASSETS[@]}"; do
  [[ -f "$asset" ]] || { echo "缺少发布物: $asset"; exit 1; }
done

if gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$VERSION" --repo "$REPO" --clobber "${ASSETS[@]}"
  echo "已更新既有发布 $VERSION 的三件套。"
else
  gh release create "$VERSION" --repo "$REPO" --title "$VERSION Windows 工具包" --notes "$NOTES" "${ASSETS[@]}"
  echo "已创建发布 $VERSION 并上传三件套。"
fi

echo
echo "下载直链 (页面已指向这些地址):"
echo "  https://github.com/$REPO/releases/latest/download/ApexConfigTool-win-x64.zip"
echo "  https://github.com/$REPO/releases/latest/download/ApexCfgTool-win.zip"
echo "  https://github.com/$REPO/releases/latest/download/apex_cfg_tool.py"
