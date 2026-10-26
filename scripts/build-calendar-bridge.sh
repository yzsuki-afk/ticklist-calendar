#!/bin/bash
set -euo pipefail
# Build only. Never install, register, launch, authorize, or alter calendar data.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# Keep generated output separate. Some File Providers ignore .nosync; see native/README.md.
APP="$ROOT/native/build.nosync/TicklistCalendarBridge.app"
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/MacOS"
/usr/bin/ditto "$ROOT/native/Info.plist" "$CONTENTS/Info.plist"
/usr/bin/plutil -lint "$CONTENTS/Info.plist"
/usr/bin/xcrun swiftc -O -whole-module-optimization -swift-version 5 \
  -target "$(uname -m)-apple-macos13.0" \
  -framework Foundation -framework EventKit -framework AppKit \
  "$ROOT/native/CalendarBridge.swift" -o "$CONTENTS/MacOS/calendar-bridge"
# File-provider workspaces may stamp FinderInfo on a newly created .app; codesign rejects it.
# Clear only this generated bundle's FinderInfo, never source/user data or other attributes.
if /usr/bin/xattr -p com.apple.FinderInfo "$APP" >/dev/null 2>&1; then
  /usr/bin/xattr -d com.apple.FinderInfo "$APP"
fi
# Fixed identifier + explicit designated requirement avoid a changing cdhash requirement.
# Ad-hoc signing is local-only, not Developer ID distribution/notarization.
/usr/bin/codesign --force --sign - --identifier com.ticklist.calendar-bridge \
  --requirements '=designated => identifier "com.ticklist.calendar-bridge"' "$APP"
/usr/bin/codesign --verify --strict --verbose=2 "$APP"
# Preserve the signed bundle without workspace-added xattrs for later explicit installation.
ARCHIVE="$ROOT/native/build.nosync/TicklistCalendarBridge.app.zip"
/usr/bin/ditto --noextattr --norsrc -c -k --keepParent "$APP" "$ARCHIVE"
printf '%s\n' "$APP" "$ARCHIVE"
