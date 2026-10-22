#!/usr/bin/env python3
"""
DSH 启动失败急救工具。

场景：某个插件让 DSH 起不来，应用弹窗只给了「禁用所有第三方插件」这一个选项。
那个选项会清空整个 dsh.profile.bundles（这次从 15 个变成 2 个），代价太大。
这个脚本让你在终端里精确停用出问题的那一个，其他插件全部保留。

用法（在终端里运行，不需要打开 DSH）：

    python3 scripts/recover.py                       # 看看最新崩溃日志和当前挂载的插件
    python3 scripts/recover.py disable ticklist-calendar
    python3 scripts/recover.py enable  ticklist-calendar

原理：往 profile 的 cordis.patch.yml 末尾追加一条
    - id: <插件id>
      disabled: true
即可把该行覆盖为停用；enable 时把这段删掉。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

LOG_DIR = Path.home() / "Library" / "Logs" / "DeepSeek Harness"


def resolve_profile_dir(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_dir():
            sys.exit(f"指定的 profile 目录不存在：{p}")
        return p

    env = os.environ.get("DSH_PROFILE_DIR")
    if env and Path(env).is_dir():
        return Path(env)

    default = Path.home() / ".dsh" / "profiles" / "desktop"
    if default.is_dir():
        return default

    root = Path.home() / ".dsh" / "profiles"
    if root.is_dir():
        dirs = [d for d in root.iterdir() if d.is_dir()]
        if len(dirs) == 1:
            return dirs[0]
        if dirs:
            sys.exit(
                "找到多个 profile，请用 --profile-dir 指定：\n"
                + "\n".join(f"  {d}" for d in sorted(dirs))
            )
    sys.exit("找不到 DSH profile 目录，请用 --profile-dir 指定")


def patch_path(profile: Path) -> Path:
    return profile / "cordis.patch.yml"


def backup(profile: Path, name: str) -> Path:
    src = patch_path(profile)
    dst = profile / f"{name}.bak-recover-{int(time.time() * 1000)}"
    shutil.copy2(src, dst)
    return dst


def read_patch(profile: Path) -> str:
    p = patch_path(profile)
    if not p.exists():
        sys.exit(f"找不到 {p}")
    return p.read_text(encoding="utf-8")


def disabled_block(plugin_id: str) -> str:
    return (
        "\n# 由 scripts/recover.py 追加：临时停用该插件，其余插件不受影响\n"
        f"- id: {plugin_id}\n"
        "  disabled: true\n"
    )


def is_disabled(text: str, plugin_id: str) -> bool:
    pattern = re.compile(
        r"^- id:\s*" + re.escape(plugin_id) + r"\s*$\s*^\s*disabled:\s*true\s*$",
        re.M,
    )
    return bool(pattern.search(text))


def cmd_status(profile: Path) -> int:
    print(f"profile: {profile}")

    pkg_path = profile / "package.json"
    bundles: list[str] = []
    if pkg_path.exists():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
            bundles = pkg.get("dsh", {}).get("profile", {}).get("bundles", []) or []
        except json.JSONDecodeError as error:
            print(f"  ⚠️  package.json 解析失败：{error}")
    print(f"\n已挂载 bundle：{len(bundles)} 个")
    for b in bundles:
        print(f"  - {b}")

    text = read_patch(profile) if patch_path(profile).exists() else ""
    overrides = re.findall(r"^- id:\s*(\S+)\s*\n\s*disabled:\s*true", text, re.M)
    if overrides:
        print("\n已被 patch 停用的条目：")
        for o in overrides:
            print(f"  - {o}")

    logs = sorted(LOG_DIR.glob("crash-*-web-boot.log"), key=lambda f: f.stat().st_mtime)
    if logs:
        newest = logs[-1]
        print(f"\n最近的崩溃日志：{newest}")
        print("-" * 60)
        try:
            print(newest.read_text(encoding="utf-8", errors="replace").strip())
        except OSError as error:
            print(f"（读取失败：{error}）")
        print("-" * 60)
        print("日志里 `xxx: import failed` 或 `duplicate factory registration for \"xxx\"`")
        print("里的 xxx 就是出问题的插件，用 disable 停用它。")
    else:
        print("\n没找到 web-boot 崩溃日志。")
    return 0


def cmd_disable(profile: Path, plugin_id: str) -> int:
    text = read_patch(profile)
    if is_disabled(text, plugin_id):
        print(f"插件 {plugin_id} 已经是停用状态，无需重复操作。")
        return 0

    saved = backup(profile, patch_path(profile).name)
    suffix = "" if text.endswith("\n") else "\n"
    patch_path(profile).write_text(text + suffix + disabled_block(plugin_id), encoding="utf-8")
    print(f"已停用 {plugin_id}")
    print(f"  备份：{saved}")
    print(f"  修改：{patch_path(profile)}")
    print("\n现在重新启动 DSH，其他插件不受影响。")
    print(f"要恢复这个插件：python3 scripts/recover.py enable {plugin_id}")
    return 0


def cmd_enable(profile: Path, plugin_id: str) -> int:
    text = read_patch(profile)
    if not is_disabled(text, plugin_id):
        print(f"插件 {plugin_id} 没有被本脚本停用，无需恢复。")
        return 0

    saved = backup(profile, patch_path(profile).name)
    # 连同上面那行说明注释一起删掉
    pattern = re.compile(
        r"\n# 由 scripts/recover\.py 追加：临时停用该插件，其余插件不受影响\n"
        + r"- id:\s*" + re.escape(plugin_id) + r"\s*\n"
        + r"\s*disabled:\s*true\n",
    )
    updated = pattern.sub("\n", text)
    patch_path(profile).write_text(updated, encoding="utf-8")
    print(f"已恢复 {plugin_id}")
    print(f"  备份：{saved}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="DSH 启动失败急救：精确停用 / 恢复单个插件",
    )
    parser.add_argument("--profile-dir", help="指定 profile 目录（默认自动探测）")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="查看当前挂载的插件与最新崩溃日志")

    for name, help_text in (("disable", "停用指定插件"), ("enable", "恢复指定插件")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("plugin_id", help="插件的包名，例如 ticklist-calendar")

    args = parser.parse_args()
    profile = resolve_profile_dir(args.profile_dir)

    if args.command == "disable":
        return cmd_disable(profile, args.plugin_id)
    if args.command == "enable":
        return cmd_enable(profile, args.plugin_id)
    return cmd_status(profile)


if __name__ == "__main__":
    sys.exit(main())
