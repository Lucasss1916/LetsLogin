#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Apex Config Tool (Python 控制台版 v2.2.0)

集中管理 Apex Legends 本地配置: 灵敏度 / 键位 / 画质 全部键值一览,
字节级备份(指纹去重 + 轮转), 与 图形版/PowerShell 版 产物互通。

用法:
  python apex_cfg_tool.py            # 交互菜单
  python apex_cfg_tool.py show       # 显示明细(可加 -f 关键字筛选)
  python apex_cfg_tool.py backup -k 20
  python apex_cfg_tool.py list
  python apex_cfg_tool.py restore -z <zip>
  python apex_cfg_tool.py export -o <file.apexcfg> -t 标题 -n 备注
  python apex_cfg_tool.py import -s <file.apexcfg>
无需第三方依赖, Python 3.8+ 即可。
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zipfile

TOOL_VERSION = "2.2.0"
FORMAT_VERSION = 1
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_FILES = 64
BACKUP_PREFIX = "apex-backup-"
INCLUDE_SUFFIX = (".cfg", ".txt", ".ini")

RE_QUOTED = re.compile(r'"([^"\r\n]+)"\s+"([^"\r\n]*)"')
RE_BARE = re.compile(r"^\s*([A-Za-z0-9_.-]+)\s+(-?[A-Za-z0-9_.]+)\s*$")
RE_BIND_LINE = re.compile(r"^[ \t]*bind\b", re.MULTILINE)


# ─────────────────────────── 基础工具 ───────────────────────────

def pad2(number):
    return f"{number:02d}"


def stamp(moment=None):
    moment = moment or time.localtime()
    return (f"{moment.tm_year}{pad2(moment.tm_mon)}{pad2(moment.tm_mday)}"
            f"-{pad2(moment.tm_hour)}{pad2(moment.tm_min)}{pad2(moment.tm_sec)}")


def fmt_size(num):
    if num >= 1048576:
        return f"{num / 1048576:.1f}MB"
    if num >= 1024:
        return f"{num / 1024:.1f}KB"
    return f"{math_floor(num)}B"


def math_floor(num):
    return int(num)


def fmt_time(epoch):
    moment = time.localtime(epoch)
    return (f"{moment.tm_year}-{pad2(moment.tm_mon)}-{pad2(moment.tm_mday)} "
            f"{pad2(moment.tm_hour)}:{pad2(moment.tm_min)}:{pad2(moment.tm_sec)}")


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


def utf8_bytes(text):
    return text.encode("utf-8")


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def status(msg):
    print(f"» {msg}")


def pause():
    try:
        input("\n回车返回菜单…")
    except EOFError:
        pass


# ─────────────────────────── 目录定位 ───────────────────────────

def candidate_dirs():
    home = os.path.expanduser("~")
    documents = os.path.join(home, "Documents")
    onedrive = os.environ.get("OneDrive")
    options = [
        os.path.join(home, "Saved Games", "Respawn", "Apex", "local"),
        os.path.join(documents, "Respawn", "Apex", "local"),
        os.path.join(home, "OneDrive", "Documents", "Respawn", "Apex", "local"),
    ]
    if onedrive:
        options.append(os.path.join(onedrive, "Documents", "Respawn", "Apex", "local"))
    return options


def backups_dir(local_dir):
    return os.path.join(os.path.dirname(local_dir), "apex-backups")


def resolve_dir(explicit="", create=False):
    raw = (explicit or "").strip()
    if raw:
        full = raw
        if full == "~":
            full = os.path.expanduser("~")
        elif full.startswith(("~/", "~\\")):
            full = os.path.join(os.path.expanduser("~"), full[2:])
        full = os.path.abspath(full)
        if create:
            os.makedirs(full, exist_ok=True)
        if not os.path.isdir(full):
            raise FileNotFoundError(f"目录不存在: {full}")
        return full
    for option in candidate_dirs():
        if os.path.isdir(option):
            return option
    if create:
        made = candidate_dirs()[0]
        os.makedirs(made, exist_ok=True)
        return made
    raise FileNotFoundError("未找到 Apex 配置目录, 已尝试:\n  " + "\n  ".join(candidate_dirs())
                            + "\n请用 --dir 指定配置目录路径")


def pick_dir_interactive():
    options = candidate_dirs()
    print("\n可用候选目录:")
    for index, option in enumerate(options, 1):
        mark = "√ 有" if os.path.isdir(option) else "  无"
        print(f"  {index}. [{mark}] {option}")
    raw = input("回车自动检测 / 输入序号 / 直接粘贴目录路径: ").strip()
    if not raw:
        return resolve_dir(create=False)
    if raw.isdigit() and 1 <= int(raw) <= len(options):
        return resolve_dir(options[int(raw) - 1], create=False)
    return resolve_dir(raw, create=True)


# ─────────────────────────── 快照与清单 ───────────────────────────

def list_config_files(root_dir):
    found = []
    for current, _dirs, names in os.walk(root_dir):
        for name in names:
            if name.lower().endswith(INCLUDE_SUFFIX):
                found.append(os.path.join(current, name))
    found.sort()
    return found


def snapshot(local_dir):
    items = []
    warnings = []
    total = 0
    for file_path in list_config_files(local_dir):
        with open(file_path, "rb") as handle:
            data = handle.read()
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError(f"配置文件总体积超过上限 {fmt_size(MAX_TOTAL_BYTES)}")
        if len(data) > MAX_FILE_BYTES:
            warnings.append(f"警告: 跳过大文件({fmt_size(len(data))}): {os.path.basename(file_path)}")
            total -= len(data)
            continue
        rel = os.path.relpath(file_path, local_dir).replace(os.sep, "/")
        items.append({"name": rel, "data": data, "hex": sha256_hex(data)})
    return items, warnings


def fingerprint_of(items):
    lines = "\n".join(f"{it['name']}:{it['hex']}" for it in sorted(items, key=lambda it: it["name"]))
    return sha256_hex(utf8_bytes(lines))


def new_manifest(kind, items, fingerprint):
    return {
        "kind": kind,
        "tool_version": TOOL_VERSION,
        "created_at": iso_now(),
        "fingerprint": fingerprint,
        "files": [{"name": it["name"], "size": len(it["data"]), "sha256": it["hex"]} for it in items],
    }


def write_backup_zip(zip_path, items, manifest):
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        for item in items:
            zf.writestr("files/" + item["name"], item["data"])


def unique_dest(directory, base):
    dest = os.path.join(directory, base + ".zip")
    serial = 2
    while os.path.exists(dest):
        dest = os.path.join(directory, f"{base}-{serial}.zip")
        serial += 1
    return dest


def read_manifest(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        if "manifest.json" not in zf.namelist():
            raise ValueError("备份包缺少 manifest.json, 不是本工具生成的包")
        return json.loads(zf.read("manifest.json").decode("utf-8"))


def newest_backup(backup_dir):
    if not os.path.isdir(backup_dir):
        return None
    candidates = [os.path.join(backup_dir, name) for name in os.listdir(backup_dir)
                  if name.lower().endswith(".zip") and name.startswith(BACKUP_PREFIX)]
    candidates.sort(key=os.path.getmtime, reverse=True)
    for path in candidates:
        try:
            manifest = read_manifest(path)
            return {"name": os.path.basename(path), "fingerprint": str(manifest.get("fingerprint", ""))}
        except Exception:
            return None
    return None


def rotate_backups(backup_dir, keep):
    if not os.path.isdir(backup_dir):
        return []
    all_zips = [os.path.join(backup_dir, n) for n in os.listdir(backup_dir) if n.lower().endswith(".zip")]
    all_zips.sort(key=os.path.getmtime, reverse=True)
    removed = []
    for path in all_zips[max(0, keep):]:
        try:
            os.remove(path)
            removed.append(os.path.basename(path))
        except OSError:
            pass
    return removed


# ─────────────────────────── 核心操作 ───────────────────────────

def op_backup(explicit_dir, keep=20, force=False):
    local_dir = resolve_dir(explicit_dir)
    target_dir = backups_dir(local_dir)
    os.makedirs(target_dir, exist_ok=True)
    items, warnings = snapshot(local_dir)
    for line in warnings:
        status(line)
    if not items:
        raise ValueError(f"目录中没有可识别的配置文件({'/'.join(INCLUDE_SUFFIX)}): {local_dir}")
    fingerprint = fingerprint_of(items)
    keep = max(1, int(keep or 20))
    newest = newest_backup(target_dir)
    if newest and newest["fingerprint"] == fingerprint and not force:
        rotate_backups(target_dir, keep)
        return {"ok": True, "skipped": True,
                "message": f"配置无变化, 跳过备份(与 {newest['name']} 相同)"}
    dest = unique_dest(target_dir, BACKUP_PREFIX + stamp())
    write_backup_zip(dest, items, new_manifest("backup", items, fingerprint))
    removed = rotate_backups(target_dir, keep)
    return {"ok": True, "skipped": False, "path": dest, "files": len(items),
            "fingerprint": fingerprint[:16], "removed": removed}


def op_list(explicit_dir):
    local_dir = resolve_dir(explicit_dir)
    target_dir = backups_dir(local_dir)
    rows = []
    if os.path.isdir(target_dir):
        for name in sorted(os.listdir(target_dir)):
            if not name.lower().endswith(".zip"):
                continue
            path = os.path.join(target_dir, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            kind, file_count, fingerprint = "备份包", "", ""
            try:
                manifest = read_manifest(path)
                raw_kind = str(manifest.get("kind", ""))
                kind = ("手动备份" if raw_kind == "backup"
                        else "安全包(自动)" if raw_kind.startswith("safety:")
                        else raw_kind or "未知")
                file_count = len(manifest.get("files", []))
                fingerprint = str(manifest.get("fingerprint", ""))[:16]
            except Exception:
                kind = "无法读取(损坏?)"
            rows.append((name, fmt_time(stat.st_mtime), file_count, kind, fingerprint, fmt_size(stat.st_size)))
    rows.sort(reverse=True)
    return local_dir, target_dir, rows


def valid_config_name(name):
    text = str(name or "")
    if not text.strip() or "\0" in text:
        return False
    if text.startswith("/") or text.startswith("\\"):
        return False
    parts = re.split(r"[\\/]", text)
    if len(parts) > 4:
        return False
    for part in parts:
        if not part or part in (".", ".."):
            return False
    dot = text.rfind(".")
    return dot > 0 and text[dot:].lower() in INCLUDE_SUFFIX


def write_verified(local_dir, entries):
    written, identical = [], []
    for entry in entries:
        target = os.path.join(local_dir, *entry["name"].split("/"))
        if os.path.exists(target):
            with open(target, "rb") as handle:
                if handle.read() == entry["data"]:
                    identical.append(entry["name"])
                    continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "wb") as handle:
            handle.write(entry["data"])
        os.replace(tmp, target)
        with open(target, "rb") as handle:
            if sha256_hex(handle.read()) != entry["hex"]:
                raise ValueError(f"写入后复检失败: {entry['name']}")
        written.append(entry["name"])
    return written, identical


def share_entries(share):
    names = list(share.get("files", {}).keys())
    if not names:
        raise ValueError("分享文件中没有包含任何配置文件")
    if len(names) > MAX_FILES:
        raise ValueError(f"文件数量超过上限 {MAX_FILES}")
    entries = []
    for name in names:
        if not valid_config_name(name):
            raise ValueError(f"非法文件名(路径穿越或后缀不在白名单): {name}")
        meta = share["files"][name]
        data = base64.b64decode(str(meta.get("b64", "")))
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"分享文件过大(>8.0MB): {name}")
        if sha256_hex(data) != str(meta.get("sha256", "")).lower():
            raise ValueError(f"文件 {name} 校验失败: hash 与内容不一致")
        entries.append({"name": name, "data": data, "hex": str(meta["sha256"]).lower()})
    return entries


def safety_backup(local_dir, tag):
    items, _warnings = snapshot(local_dir)
    if not items:
        return None
    target_dir = backups_dir(local_dir)
    os.makedirs(target_dir, exist_ok=True)
    dest = unique_dest(target_dir, f"{tag}-{stamp()}")
    write_backup_zip(dest, items, new_manifest(f"safety:{tag}", items, fingerprint_of(items)))
    return dest


def op_restore(zip_path, explicit_dir):
    if not os.path.exists(zip_path):
        raise FileNotFoundError(f"文件不存在: {zip_path}")
    local_dir = resolve_dir(explicit_dir, create=True)
    manifest = read_manifest(zip_path)
    kind = str(manifest.get("kind", ""))
    if kind != "backup" and not kind.startswith("safety:"):
        raise ValueError(f"不支持的备份包(kind={kind or '空'}), 可能不是本工具生成")
    metas = manifest.get("files", [])
    if not metas:
        raise ValueError("备份包内没有可恢复的配置文件")
    if len(metas) > MAX_FILES:
        raise ValueError(f"文件数量超过上限 {MAX_FILES}")
    entries = []
    with zipfile.ZipFile(zip_path) as zf:
        for meta in metas:
            if not valid_config_name(meta["name"]):
                raise ValueError(f"非法文件名(路径穿越或后缀不在白名单): {meta['name']}")
            arcname = "files/" + meta["name"]
            data = zf.read(arcname)
            if sha256_hex(data) != str(meta["sha256"]).lower():
                raise ValueError(f"文件 {meta['name']} 校验失败: hash 与内容不一致")
            entries.append({"name": meta["name"], "data": data, "hex": str(meta["sha256"]).lower()})
    safety = safety_backup(local_dir, "pre-restore")
    written, identical = write_verified(local_dir, entries)
    return {"from": os.path.basename(zip_path), "safety": safety,
            "written": written, "identical": identical}


# ─────────────────────────── 分享对象 ───────────────────────────

def parse_pairs_text(text):
    pairs = {}
    for match in RE_QUOTED.finditer(text):
        pairs[match.group(1).strip()] = match.group(2).strip()
    rows = [[key, value] for key, value in pairs.items()]
    for line in text.splitlines():
        bare = RE_BARE.match(line)
        if bare and bare.group(1).strip() not in pairs:
            rows.append([bare.group(1).strip(), bare.group(2).strip()])
    return rows


def build_preview(items):
    sensitivity, video = {}, {}
    binds = 0
    for item in items:
        text = item["data"].decode("utf-8", "replace")
        for key, value in parse_pairs_text(text):
            low = key.lower()
            if "bind" in low and low != "bind":
                binds += 1
            if "sens" in low:
                sensitivity[low] = value
            if "defaultres" in low or low in ("setting.fullscreen", "aspectratiowithletterbox"):
                video[low] = value
        binds += len(RE_BIND_LINE.findall(text))
    return {
        "sensitivity": sensitivity, "video": video, "binds_count": binds,
        "files": [it["name"] for it in items],
        "file_pairs": [{"name": it["name"], "rows": parse_pairs_text(it["data"].decode("utf-8", "replace"))[:800]} for it in items],
    }


def build_share_object(explicit_dir, label="", note=""):
    local_dir = resolve_dir(explicit_dir)
    items, warnings = snapshot(local_dir)
    if not items:
        raise ValueError(f"目录中没有可识别的配置文件({'/'.join(INCLUDE_SUFFIX)}): {local_dir}")
    files = {it["name"]: {"b64": base64.b64encode(it["data"]).decode("ascii"), "sha256": it["hex"]} for it in items}
    payload = {
        "kind": "apexcfg", "format": FORMAT_VERSION, "tool_version": TOOL_VERSION,
        "game": "Apex Legends", "created_at": iso_now(),
        "label": (label or "").strip() or f"Apex 配置 {stamp()}",
        "note": note or "", "preview": build_preview(items), "files": files,
    }
    return payload, warnings


def read_share(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        share = json.loads(raw.decode("utf-8"))
    except Exception as err:
        raise ValueError(f"分享文件不是有效 JSON: {err}")
    if not isinstance(share, dict) or share.get("kind") != "apexcfg" or share.get("format") != FORMAT_VERSION:
        raise ValueError("不支持的分享格式(kind/format 不符), 请让对方更新工具后重新导出")
    return share


def op_export(explicit_dir, out_path, label, note):
    if not out_path:
        raise ValueError("请用 -o 指定导出位置")
    payload, warnings = build_share_object(explicit_dir, label, note)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return {"path": out_path, "label": payload["label"], "files": len(payload["files"]),
            "preview": payload["preview"], "warnings": warnings}


def op_import(share_path, explicit_dir):
    if not os.path.exists(share_path):
        raise FileNotFoundError(f"文件不存在: {share_path}")
    share = read_share(share_path)
    entries = share_entries(share)
    local_dir = resolve_dir(explicit_dir, create=True)
    safety = safety_backup(local_dir, "pre-import")
    written, identical = write_verified(local_dir, entries)
    return {"label": share.get("label", ""), "safety": safety, "written": written, "identical": identical}


# ─────────────────────────── 展示 ───────────────────────────

def op_show(explicit_dir, keyword=""):
    local_dir = resolve_dir(explicit_dir)
    items, warnings = snapshot(local_dir)
    print(f"配置目录: {local_dir}")
    for line in warnings:
        status(line)
    if not items:
        print(f"目录内没有 {INCLUDE_SUFFIX} 配置文件")
        return
    total = 0
    for item in items:
        rows = parse_pairs_text(item["data"].decode("utf-8", "replace"))
        hit = [r for r in rows if not keyword or keyword.lower() in r[0].lower() or keyword.lower() in str(r[1]).lower()]
        total += len(hit)
        print(f"\n◎ {item['name']}  ({len(hit)}/{len(rows)} 条)")
        for key, value in hit:
            print(f"  {key:<42} = {value}")
    print(f"\n共 {total} 条命中; 目录指纹 {fingerprint_of(items)[:16]}")


# ─────────────────────────── 交互菜单 ───────────────────────────

MENU_TEXT = """
╔══════════════════════════════════════════╗
║   Apex 配置工具 (Python 版 v{ver})   ║
╠══════════════════════════════════════════╣
║  1. 显示当前配置明细 (全部键值)          ║
║  2. 备份当前配置                          ║
║  3. 备份列表                              ║
║  4. 恢复备份                              ║
║  5. 导出 .apexcfg (发布规格)              ║
║  6. 导入 .apexcfg (先自动生成安全包)      ║
║  7. 打开配置目录                          ║
║  0. 退出                                  ║
╚══════════════════════════════════════════╝"""


def open_in_explorer(target):
    try:
        if os.name == "nt":
            os.startfile(target)  # noqa: S606 Windows 专用 API
        elif sys.platform == "darwin":
            subprocess.run(["open", target], check=False)
        else:
            subprocess.run(["xdg-open", target], check=False)
    except Exception as err:
        status(f"打开失败: {err}")


def menu_once(choice, cfg_dir_holder):
    if choice == "1":
        keyword = input("筛选关键字(可空, 回车全量): ").strip()
        op_show(cfg_dir_holder["dir"], keyword)
    elif choice == "2":
        result = op_backup(cfg_dir_holder["dir"], keep_input())
        status(result["message"] if result["skipped"] else
               f"已备份 {result['files']} 个文件 → {result['path']}; 指纹 {result['fingerprint']}; 清理 {len(result['removed'])} 份旧备份")
    elif choice == "3":
        _local, target_dir, rows = op_list(cfg_dir_holder["dir"])
        print(f"备份夹: {target_dir}")
        if not rows:
            print("  (还没有备份)")
        for name, when, count, kind, fingerprint, size in rows:
            print(f"  {name}  {when}  {kind}  {count}文件  {size}  {fingerprint}")
    elif choice == "4":
        _local, _target, rows = op_list(cfg_dir_holder["dir"])
        for index, row in enumerate(rows, 1):
            print(f"  {index}. {row[0]}  {row[1]}  {row[3]}")
        pick = input("输入要恢复的序号: ").strip()
        if pick.isdigit() and 1 <= int(pick) <= len(rows):
            path = os.path.join(_target, rows[int(pick) - 1][0])
            result = op_restore(path, cfg_dir_holder["dir"])
            status(f"已恢复: 写入 {len(result['written'])}, 已一致 {len(result['identical'])};"
                   f" 安全包: {os.path.basename(result['safety']) if result['safety'] else '无'}")
    elif choice == "5":
        label = input("标题(可空): ").strip()
        note = input("备注(可空): ").strip()
        out = input("导出到(回车=桌面 Apex-分享-<时间>.apexcfg): ").strip()
        if not out:
            desktop = os.path.join(os.path.expanduser("~"), "Desktop")
            out = os.path.join(desktop, f"Apex-分享-{stamp()}.apexcfg")
        result = op_export(cfg_dir_holder["dir"], out, label, note)
        status(f"已导出 {result['files']} 个配置 → {result['path']}")
    elif choice == "6":
        share_path = input(".apexcfg 文件路径: ").strip().strip('"')
        result = op_import(share_path, cfg_dir_holder["dir"])
        status(f"导入完成: 写入 {len(result['written'])}, 已一致 {len(result['identical'])};"
               f" 安全包: {os.path.basename(result['safety']) if result['safety'] else '无'}; 重启 Apex 生效")
    elif choice == "7":
        open_in_explorer(os.path.dirname(backups_dir(cfg_dir_holder["dir"])) or cfg_dir_holder["dir"])
    elif choice == "0":
        raise SystemExit(0)
    else:
        status("无效选项")


def keep_input():
    raw = input("保留份数(回车=20): ").strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else 20


def main():
    if os.name == "nt":
        os.system("")  # 启用 ANSI
        os.system("chcp 65001 >nul 2>&1")
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Apex 配置工具 (Python 控制台版)")
    parser.add_argument("command", nargs="?", default="",
                        choices=["", "show", "backup", "list", "restore", "export", "import"])
    parser.add_argument("-d", "--dir", default="", help="配置目录(默认自动检测)")
    parser.add_argument("-k", "--keep", type=int, default=20, help="备份保留份数(默认 20)")
    parser.add_argument("--force", action="store_true", help="备份: 配置无变化也强制生成")
    parser.add_argument("-f", "--filter", default="", help="show: 关键字筛选")
    parser.add_argument("-z", "--zip", default="", help="restore: 备份 zip 路径")
    parser.add_argument("-s", "--share", default="", help="import: .apexcfg 路径")
    parser.add_argument("-o", "--out", default="", help="export: 输出 .apexcfg 路径")
    parser.add_argument("-t", "--title", default="", help="export: 标题")
    parser.add_argument("-n", "--note", default="", help="export: 备注")
    args = parser.parse_args()

    holder = {"dir": args.dir}
    if not holder["dir"]:
        try:
            holder["dir"] = resolve_dir()
        except FileNotFoundError:
            holder["dir"] = pick_dir_interactive()
    if args.command:
        if args.command == "show":
            op_show(holder["dir"], args.filter)
        elif args.command == "backup":
            result = op_backup(holder["dir"], args.keep, args.force)
            status(result["message"] if result.get("skipped") else
                   f"已备份 {result['files']} 个文件 → {result['path']}")
        elif args.command == "list":
            _local, target_dir, rows = op_list(holder["dir"])
            print(f"备份夹: {target_dir}")
            for row in rows:
                print(f"  {row[0]}  {row[1]}  {row[3]}  {row[2]}文件  {row[5]}")
        elif args.command == "restore":
            result = op_restore(args.zip, holder["dir"])
            status(f"已恢复: 写入 {len(result['written'])}, 一致 {len(result['identical'])}")
        elif args.command == "export":
            result = op_export(holder["dir"], args.out, args.title, args.note)
            status(f"已导出 → {result['path']}")
        elif args.command == "import":
            result = op_import(args.share, holder["dir"])
            status(f"导入完成: 写入 {len(result['written'])}, 一致 {len(result['identical'])}")
        return
    while True:
        print(MENU_TEXT.format(ver=TOOL_VERSION))
        print(f"配置目录: {holder['dir']}")
        choice = input("请选择: ").strip()
        try:
            menu_once(choice, holder)
        except SystemExit:
            raise
        except Exception as err:
            print(f"× {err}")
        pause()


if __name__ == "__main__":
    main()
