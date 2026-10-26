#!/bin/bash
# Install only the generated, signed bridge app to a stable nonsynced location.
# Does not request Calendar access or enable sync.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$ROOT/native/build.nosync/TicklistCalendarBridge.app.zip"
BASE="$HOME/Library/Application Support/TicklistCalendarBridge"
APP="$BASE/TicklistCalendarBridge.app"
[[ "$BASE" == "$HOME/Library/Application Support/TicklistCalendarBridge" ]] || exit 1
[[ -f "$ARCHIVE" ]] || { echo '请先运行 bash scripts/build-calendar-bridge.sh'; exit 1; }
mkdir -p "$BASE"
STAGING="$(mktemp -d "$BASE/install.XXXXXX")"
/usr/bin/ditto -x -k "$ARCHIVE" "$STAGING"
CANDIDATE="$STAGING/TicklistCalendarBridge.app"
[[ -f "$CANDIDATE/Contents/MacOS/calendar-bridge" ]] || { echo '压缩包缺少桥接程序'; exit 1; }
/usr/bin/codesign --verify --strict "$CANDIDATE"
ID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$CANDIDATE/Contents/Info.plist")
[[ "$ID" == 'com.ticklist.calendar-bridge' ]] || { echo '桥接程序标识不匹配'; exit 1; }
if [[ -d "$APP" ]]; then
  /bin/mv "$APP" "$BASE/TicklistCalendarBridge.previous.$(date +%s).app"
fi
/bin/mv "$CANDIDATE" "$APP"
/usr/bin/codesign --verify --strict "$APP"
printf '已安装（安装过程不会请求或重置日历权限）：%s\n' "$APP"
printf '%s\n' '请在插件内检查授权状态；直接运行可执行文件会使用不同的 macOS 权限归属。'
