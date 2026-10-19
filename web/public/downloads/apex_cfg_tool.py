#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# build: v1 (packaged by CI on windows-latest)
"""ApexCfgTool — Apex Legends 本地配置 备份/恢复/导出/导入 工具(单文件, 仅标准库)

命令:
  scan                      定位配置目录并列出文件
  show                      预览当前灵敏度/分辨率/键位等关键设置
  backup  [--dir D] [--out D] [--keep N] [--force]
                            备份当前配置(自动去重与轮转)
  list    [--dir D]         查看本地备份列表
  restore ZIP [--dir D] [--dry-run]
                            恢复备份(恢复前自动为当前状态做安全包)
  export  [-o FILE.apexcfg] [--label L] [--note N] [--dir D]
                            导出可分享的 .apexcfg 配置文件
  import  FILE.apexcfg [--dir D] [--dry-run]
                            应用他人分享的配置(应用前自动安全包)

典型用法(Windows PowerShell / macOS / Linux 通用):
  python apex_cfg_tool.py backup
  python apex_cfg_tool.py list
  python apex_cfg_tool.py restore apex-backup-20250101-120000.zip
  python apex_cfg_tool.py export -o 我的配置.apexcfg --note 微波炉灵敏度
  python apex_cfg_tool.py import 队友分享.apexcfg
"""
from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

TOOL_VERSION = "1.0.0"
FORMAT_VERSION = 1

CONFIG_SUFFIXES = (".cfg", ".txt", ".ini")
EXPORT_SUFFIX = ".apexcfg"
BACKUP_PREFIX = "apex-backup-"
SAFETY_PREFIXES = ("pre-restore-", "pre-import-")

MAX_FILE_BYTES = 8 * 1024 * 1024          # 单个配置文件上限(正常 < 100KB)
MAX_TOTAL_BYTES = 32 * 1024 * 1024        # 一次快照总体积上限
MAX_FILES = 64                            # 一次快照/导入文件数上限
BACKUP_KEEP_DEFAULT = 20                  # 备份轮转默认保留份数
HASH_CHUNK = 256 * 1024                   # 流式哈希切片大小

ZIPPED_ENTRY_PREFIX = "files/"
MANIFEST_NAME = "manifest.json"

PREVIEW_SENS_MAX = 12                     # 预览最多展示的灵敏度键
PREVIEW_VIDEO_MAX = 10                    # 预览最多展示的画质键


class ToolError(Exception):
    """带用户可读信息的业务错误, main 中统一转为退出码 1。"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def slug_now() -> str:
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def human_size(num: int) -> str:
    value = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f}{unit}" if unit != "B" else f"{int(value)}B"
        value /= 1024
    return f"{value:.1f}GB"


def print_header(title: str) -> None:
    print(f"\n== {title} " + "=" * max(0, 46 - len(title)))


def atomic_write_bytes(dest: Path, data: bytes) -> None:
    """临时文件 + 同目录原子替换, 避免半写损坏原文件。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".tmp-apex-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, dest)
    except BaseException:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise


# ---------------------------------------------------------------------------
# 配置目录定位与快照
# ---------------------------------------------------------------------------

def candidate_config_dirs() -> list[Path]:
    home = Path.home()
    return [
        home / "Saved Games" / "Respawn" / "Apex" / "local",
        home / "Documents" / "Respawn" / "Apex" / "local",
        home / "OneDrive" / "Documents" / "Respawn" / "Apex" / "local",
    ]


def resolve_config_dir(explicit: str | None, create: bool = False) -> Path:
    if explicit:
        cfg_dir = Path(explicit).expanduser().resolve()
        if create:
            cfg_dir.mkdir(parents=True, exist_ok=True)
        if not cfg_dir.is_dir():
            raise ToolError(f"目录不存在: {cfg_dir}")
        return cfg_dir

    found = [c for c in candidate_config_dirs() if c.is_dir()]
    if found:
        if len(found) > 1:
            print("提示: 检测到多个候选目录, 使用第一个(可加 --dir 指定):")
            for c in found:
                print(f"  - {c}")
        return found[0]

    if create:
        default = candidate_config_dirs()[0]
        default.mkdir(parents=True, exist_ok=True)
        print(f"未找到现有配置目录, 已新建: {default}")
        return default

    raise ToolError(
        "未找到 Apex 配置目录, 已尝试:\n  "
        + "\n  ".join(str(c) for c in candidate_config_dirs())
        + "\n请用 --dir 手动指定, 例如 --dir \"C:\\Users\\你\\Saved Games\\Respawn\\Apex\\local\""
    )


def backups_dir_for(cfg_dir: Path, override: str | None) -> Path:
    path = Path(override).expanduser() if override else cfg_dir.parent / "apex-backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def iter_config_files(cfg_dir: Path) -> list[Path]:
    """目录内按文件名排序的配置文件列表(白名单后缀 + 体积上限)。"""
    results: list[Path] = []
    for root, _dirs, files in os.walk(cfg_dir, followlinks=False):
        for name in sorted(files):
            path = Path(root) / name
            if path.suffix.lower() not in CONFIG_SUFFIXES:
                continue
            size = path.stat().st_size
            if size > MAX_FILE_BYTES:
                print(f"警告: 跳过过大文件({human_size(size)}): {path}")
                continue
            results.append(path)
    return results


def make_snapshot(cfg_dir: Path) -> list[dict]:
    """读取全部配置文件到内存(Apex 配置总量通常 < 100KB)。"""
    entries = []
    total = 0
    for path in iter_config_files(cfg_dir):
        rel = path.relative_to(cfg_dir).as_posix()
        data = path.read_bytes()
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ToolError(f"配置文件总体积超过上限 {human_size(MAX_TOTAL_BYTES)}, 请手动清理无关文件")
        entries.append({"name": rel, "data": data, "size": len(data), "sha256": sha256_bytes(data)})
    return entries


def snapshots_fingerprint(entries: list[dict]) -> str:
    joined = "\n".join(f"{e['name']}:{e['sha256']}" for e in sorted(entries, key=lambda x: x["name"]))
    return sha256_bytes(joined.encode("utf-8"))


# ---------------------------------------------------------------------------
# 宽容解析(仅用于预览展示; 备份/恢复为字节级, 不依赖解析结果)
# ---------------------------------------------------------------------------

QUOTED_PAIR_RE = re.compile(r'"([^"\n]+)"\s+"([^"\n]*)"')
BARE_PAIR_RE = re.compile(r'^\s*([A-Za-z0-9_.-]+)\s+(-?[A-Za-z0-9_.]+)\s*$', re.M)
BIND_LINE_RE = re.compile(r'(?im)^\s*bind\b')


def build_preview(entries: list[dict]) -> dict:
    sensitivity: dict[str, str] = {}
    video: dict[str, str] = {}
    binds_count = 0

    for entry in entries:
        text = entry["data"].decode("utf-8", errors="replace")
        pairs: dict[str, str] = {}
        for key, value in QUOTED_PAIR_RE.findall(text):
            pairs[key.strip()] = value.strip()
        for key, value in BARE_PAIR_RE.findall(text):
            pairs.setdefault(key.strip(), value.strip())
        binds_count += len(BIND_LINE_RE.findall(text))
        # 引号键值对风格(如 "binding_forward" "w")的键也计入
        binds_count += sum(1 for key in pairs if "bind" in key.lower())

        for key, value in pairs.items():
            low = key.lower()
            if "sens" in low and low not in sensitivity:
                try:
                    float(value)
                except ValueError:
                    continue
                sensitivity[low] = value
            elif ("defaultres" in low or low in ("setting.fullscreen", "aspectratiowithletterbox")) and low not in video:
                video[low] = value

    return {
        "sensitivity": dict(list(sensitivity.items())[:PREVIEW_SENS_MAX]),
        "video": dict(list(video.items())[:PREVIEW_VIDEO_MAX]),
        "binds_count": binds_count,
        "files": [e["name"] for e in entries],
    }


def print_preview_card(preview: dict) -> None:
    if preview.get("sensitivity"):
        print("灵敏度相关:")
        for key, value in preview["sensitivity"].items():
            print(f"  {key} = {value}")
    if preview.get("video"):
        print("画质/分辨率相关:")
        for key, value in preview["video"].items():
            print(f"  {key} = {value}")
    print(f"键位(binds)条目: {preview.get('binds_count', 0)}")


# ---------------------------------------------------------------------------
# 备份 zip 读写
# ---------------------------------------------------------------------------

def build_manifest(kind: str, entries: list[dict], fingerprint: str) -> dict:
    return {
        "kind": kind,
        "tool_version": TOOL_VERSION,
        "created_at": utc_now_iso(),
        "fingerprint": fingerprint,
        "files": [{"name": e["name"], "size": e["size"], "sha256": e["sha256"]} for e in entries],
    }


def write_backup_zip(dest: Path, entries: list[dict], manifest: dict) -> None:
    fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".tmp-apex-")
    os.close(fd)
    try:
        now = datetime.datetime.now().timetuple()[:6]
        with zipfile.ZipFile(tmp_name, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            info = zipfile.ZipInfo(MANIFEST_NAME, date_time=now)
            zf.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2))
            for entry in entries:
                zf.writestr(zipfile.ZipInfo(ZIPPED_ENTRY_PREFIX + entry["name"], date_time=now), entry["data"])
        os.replace(tmp_name, dest)
    except BaseException:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise


def read_backup_manifest(zip_path: Path) -> dict:
    try:
        with zipfile.ZipFile(zip_path) as zf:
            raw = zf.read(MANIFEST_NAME)
        manifest = json.loads(raw)
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError) as err:
        raise ToolError(f"备份文件损坏或不是本工具生成的包: {err}") from err
    if not isinstance(manifest, dict) or "files" not in manifest:
        raise ToolError("manifest.json 缺少 files 字段, 备份可能来自其他工具")
    return manifest


# 同一秒内可能连续备份, 冲突时追加序号, 避免覆盖
def next_backup_path(backups: Path, slug: str) -> Path:
    dest = backups / f"{BACKUP_PREFIX}{slug}.zip"
    serial = 2
    while dest.exists():
        dest = backups / f"{BACKUP_PREFIX}{slug}-{serial}.zip"
        serial += 1
    return dest


def newest_backup(backups: Path) -> Path | None:
    zips = list(backups.glob(BACKUP_PREFIX + "*.zip"))
    if not zips:
        return None
    return max(zips, key=lambda p: (p.stat().st_mtime, p.name))


def rotate_backups(backups: Path, keep: int) -> int:
    zips = sorted(backups.glob(BACKUP_PREFIX + "*.zip"), key=lambda p: (p.stat().st_mtime, p.name))
    removed = 0
    for old in zips[:-keep] if keep > 0 else zips:
        old.unlink()
        removed += 1
    return removed


def create_safety_backup(cfg_dir: Path, backups: Path, tag: str) -> Path | None:
    """覆盖/导入前把当前状态打安全包; 目录为空则返回 None。"""
    entries = make_snapshot(cfg_dir)
    if not entries:
        return None
    dest = backups / f"{tag}-{slug_now()}.zip"
    manifest = build_manifest(f"safety:{tag}", entries, snapshots_fingerprint(entries))
    write_backup_zip(dest, entries, manifest)
    return dest


# ---------------------------------------------------------------------------
# 分享文件(.apexcfg)编解码与校验
# ---------------------------------------------------------------------------

def sanitize_rel_name(name: str) -> str:
    """净化包内相对路径, 拒绝穿越/反斜杠/空段。"""
    if not isinstance(name, str) or not name or "\x00" in name:
        raise ToolError(f"非法文件名: {name!r}")
    normalized = name.replace("\\", "/").lstrip("/")
    parts = normalized.split("/")
    if not normalized or any(part in ("", ".", "..") for part in parts):
        raise ToolError(f"非法文件名(疑似路径穿越): {name!r}")
    if len(parts) > 4:
        raise ToolError(f"文件名嵌套过深: {name!r}")
    return "/".join(parts)


def decode_share_files(files_obj: dict) -> list[dict]:
    """校验并解码 .apexcfg 的 files 字段, 返回与 make_snapshot 同构的 items。"""
    if not isinstance(files_obj, dict) or not files_obj:
        raise ToolError("分享文件中没有任何配置文件内容")
    if len(files_obj) > MAX_FILES:
        raise ToolError(f"文件数量超过上限 {MAX_FILES}")

    entries, total = [], 0
    for rel, meta in files_obj.items():
        name = sanitize_rel_name(rel)
        if Path(name).suffix.lower() not in CONFIG_SUFFIXES:
            raise ToolError(f"文件后缀不在白名单({', '.join(CONFIG_SUFFIXES)}): {name}")
        if not isinstance(meta, dict) or not isinstance(meta.get("b64"), str):
            raise ToolError(f"文件 {name} 缺少 b64 内容")
        try:
            data = base64.b64decode(meta["b64"], validate=True)
        except (ValueError, TypeError) as err:
            raise ToolError(f"文件 {name} 的 base64 内容无效: {err}") from err
        if len(data) > MAX_FILE_BYTES:
            raise ToolError(f"文件 {name} 超过单文件上限 {human_size(MAX_FILE_BYTES)}")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ToolError(f"解压后总体积超过上限 {human_size(MAX_TOTAL_BYTES)}")
        expected_sha = meta.get("sha256")
        if isinstance(expected_sha, str) and expected_sha.lower() != sha256_bytes(data):
            raise ToolError(f"文件 {name} 校验失败: hash 与内容不一致")
        entries.append({"name": name, "data": data, "size": len(data), "sha256": sha256_bytes(data)})
    return entries


def parse_share_file(path: Path) -> dict:
    if not path.is_file():
        raise ToolError(f"文件不存在: {path}")
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ToolError("分享文件过大(>64MB), 疑似损坏")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        raise ToolError(f"分享文件不是有效 JSON: {err}") from err
    if payload.get("kind") != "apexcfg" or payload.get("format") != FORMAT_VERSION:
        raise ToolError("不支持的分享格式(缺少 kind=apexcfg 或 format 不匹配), 请让对方更新工具后重新导出")
    return payload


def write_entries_to(cfg_dir: Path, entries: list[dict]) -> tuple[list[str], list[str]]:
    """逐文件原子写入并复检哈希, 返回 (written, identical)。"""
    written, identical = [], []
    for entry in entries:
        dest = cfg_dir / Path(*entry["name"].split("/"))
        if dest.is_file() and dest.stat().st_size == entry["size"] and sha256_file(dest) == entry["sha256"]:
            identical.append(entry["name"])
            continue
        atomic_write_bytes(dest, entry["data"])
        if sha256_file(dest) != entry["sha256"]:
            raise ToolError(f"写入后校验失败, 文件可能异常: {dest}")
        written.append(entry["name"])
    return written, identical


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------

def cmd_scan(args: argparse.Namespace) -> None:
    print_header("候选配置目录")
    selected = None
    for cand in candidate_config_dirs():
        mark = "√" if cand.is_dir() else "×"
        print(f" [{mark}] {cand}")
        if cand.is_dir() and selected is None:
            selected = cand

    print_header("选择结果")
    if not selected and args.dir:
        selected = resolve_config_dir(args.dir)
    if not selected:
        print("未找到, 请用 --dir 指定")
        return

    entries = make_snapshot(selected)
    print(f"当前使用: {selected}")
    total = 0
    for entry in entries:
        print(f"  {entry['name']:<28} {human_size(entry['size'])}")
        total += entry["size"]
    print(f"合计 {len(entries)} 个文件, {human_size(total)}")


def cmd_show(args: argparse.Namespace) -> None:
    cfg_dir = resolve_config_dir(args.dir)
    entries = make_snapshot(cfg_dir)
    if not entries:
        raise ToolError(f"目录中没有可识别的配置文件({', '.join(CONFIG_SUFFIXES)}): {cfg_dir}")
    print_header(f"当前配置概览 {cfg_dir}")
    print_preview_card(build_preview(entries))


def cmd_backup(args: argparse.Namespace) -> None:
    cfg_dir = resolve_config_dir(args.dir)
    entries = make_snapshot(cfg_dir)
    if not entries:
        raise ToolError(f"目录中没有可识别的配置文件: {cfg_dir}")

    backups = backups_dir_for(cfg_dir, args.out)
    fingerprint = snapshots_fingerprint(entries)

    newest = newest_backup(backups)
    if newest and not args.force:
        last = read_backup_manifest(newest)
        if last.get("fingerprint") == fingerprint:
            print(f"配置无变化, 跳过备份(与 {newest.name} 相同)! 需强制请加 --force")
            return

    dest = next_backup_path(backups, slug_now())
    write_backup_zip(dest, entries, build_manifest("backup", entries, fingerprint))
    removed = rotate_backups(backups, args.keep)

    print(f"✔ 备份完成: {dest}")
    print(f"  文件 {len(entries)} 个, 原始 {human_size(sum(e['size'] for e in entries))}")
    print(f"  指纹 {fingerprint[:12]}  轮转清理 {removed} 份旧备份")


def cmd_list(args: argparse.Namespace) -> None:
    cfg_dir = resolve_config_dir(args.dir)
    backups = backups_dir_for(cfg_dir, None)
    zips = sorted(backups.glob("*.zip"))
    if not zips:
        print(f"暂无备份: {backups}")
        return

    print_header(f"备份列表 {backups}")
    for idx, zp in enumerate(zips, 1):
        try:
            manifest = read_backup_manifest(zp)
            files = len(manifest.get("files", []))
            created = str(manifest.get("created_at", "-"))[:19].replace("T", " ")
            kind = str(manifest.get("kind", "?"))
        except ToolError as err:
            print(f" [{idx}] {zp.name}  <无法解析: {err}>")
            continue
        print(f" [{idx}] {zp.name}")
        print(f"      {created} UTC · {files} 个文件 · {human_size(zp.stat().st_size)} · {kind}")


def cmd_restore(args: argparse.Namespace) -> None:
    zip_path = Path(args.archive).expanduser()
    manifest = read_backup_manifest(zip_path)
    files = manifest.get("files", [])
    print_header(f"恢复预览 {zip_path.name}({len(files)} 个文件)")
    for f in files:
        print(f"  {f.get('name', '?'):<28} {human_size(int(f.get('size') or 0))}")
    if args.dry_run:
        print("(dry-run, 未写入任何文件)")
        return
    if not files:
        print("备份内容为空, 无需恢复")
        return

    cfg_dir = resolve_config_dir(args.dir, create=bool(args.dir))
    backups = backups_dir_for(cfg_dir, None)
    safety = create_safety_backup(cfg_dir, backups, "pre-restore")
    print(f"已生成安全包: {safety}" if safety else "当前目录为空, 无需安全包")

    with zipfile.ZipFile(zip_path) as zf:
        entries = decode_share_files(
            {
                f["name"]: {"b64": base64.b64encode(zf.read(ZIPPED_ENTRY_PREFIX + f["name"])).decode("ascii")}
                for f in files
            }
        )
    written, identical = write_entries_to(cfg_dir, entries)
    print(f"✔ 恢复完成: 覆盖 {len(written)} 个文件, 未变化 {len(identical)} 个")
    print("提示: 如需回滚, 用 list 找到刚才的安全包再执行 restore")


def cmd_export(args: argparse.Namespace) -> None:
    cfg_dir = resolve_config_dir(args.dir)
    entries = make_snapshot(cfg_dir)
    if not entries:
        raise ToolError(f"目录中没有可识别的配置文件: {cfg_dir}")

    payload = {
        "kind": "apexcfg",
        "format": FORMAT_VERSION,
        "tool_version": TOOL_VERSION,
        "game": "Apex Legends",
        "created_at": utc_now_iso(),
        "label": args.label or f"Apex 配置 {slug_now()}",
        "note": args.note or "",
        "preview": build_preview(entries),
        "files": {
            e["name"]: {"b64": base64.b64encode(e["data"]).decode("ascii"), "sha256": e["sha256"]}
            for e in entries
        },
    }
    out = Path(args.output).expanduser() if args.output else Path(f"apex-export-{slug_now()}{EXPORT_SUFFIX}")

    atomic_write_bytes(
        out,
        (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    print_header("导出完成")
    print(f"✔ {out.resolve()}  ({human_size(out.stat().st_size)})")
    print(f"  标签: {payload['label']}")
    print_preview_card(payload["preview"])
    print("分享方式: 直接把该文件发给朋友, 或在网页「Apex 配置」面板发布到分享广场")


def cmd_import(args: argparse.Namespace) -> None:
    share = parse_share_file(Path(args.file).expanduser())
    entries = decode_share_files(share.get("files", {}))

    print_header(f"导入预览 {Path(args.file).name}")
    print(f"标签: {share.get('label', '-')}  来源时间: {share.get('created_at', '-')}")
    if share.get("note"):
        print(f"备注: {share['note']}")
    print_preview_card(share.get("preview") or build_preview(entries))
    if args.dry_run:
        print("(dry-run, 未写入任何文件)")
        return

    cfg_dir = resolve_config_dir(args.dir, create=True)
    backups = backups_dir_for(cfg_dir, None)
    safety = create_safety_backup(cfg_dir, backups, "pre-import")
    print(f"已生成安全包: {safety}" if safety else "原目录为空, 无需安全包")

    written, identical = write_entries_to(cfg_dir, entries)
    print(f"✔ 应用完成: 写入 {len(written)} 个文件, 已一致 {len(identical)} 个")
    print("提示: 重启 Apex 生效; 回滚请用 list 找到上面的安全包执行 restore")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def add_dir_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument("--dir", help="手动指定 Apex local 配置目录(默认自动检测)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="apex_cfg_tool",
        description="Apex Legends 本地配置 备份/恢复/导出/导入 工具",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_scan = sub.add_parser("scan", help="定位配置目录并列出文件")
    add_dir_arg(p_scan)
    p_scan.set_defaults(func=cmd_scan)

    p_show = sub.add_parser("show", help="预览当前关键设置")
    add_dir_arg(p_show)
    p_show.set_defaults(func=cmd_show)

    p_backup = sub.add_parser("backup", help="备份当前配置")
    add_dir_arg(p_backup)
    p_backup.add_argument("--out", help="备份输出目录(默认 Apex 目录同级 apex-backups/)")
    p_backup.add_argument("--keep", type=int, default=BACKUP_KEEP_DEFAULT, help=f"保留的备份份数(默认 {BACKUP_KEEP_DEFAULT})")
    p_backup.add_argument("--force", action="store_true", help="即使配置无变化也强制生成")
    p_backup.set_defaults(func=cmd_backup)

    p_list = sub.add_parser("list", help="查看本地备份")
    add_dir_arg(p_list)
    p_list.set_defaults(func=cmd_list)

    p_restore = sub.add_parser("restore", help="恢复备份")
    p_restore.add_argument("archive", help="备份 zip 路径")
    add_dir_arg(p_restore)
    p_restore.add_argument("--dry-run", action="store_true", help="仅预览, 不写入")
    p_restore.set_defaults(func=cmd_restore)

    p_export = sub.add_parser("export", help="导出可分享的 .apexcfg")
    add_dir_arg(p_export)
    p_export.add_argument("-o", "--output", help=f"输出文件(默认 apex-export-时间戳{EXPORT_SUFFIX})")
    p_export.add_argument("--label", help="配置标签/标题")
    p_export.add_argument("--note", help="备注(如灵敏度说明)")
    p_export.set_defaults(func=cmd_export)

    p_import = sub.add_parser("import", help="应用分享的 .apexcfg")
    p_import.add_argument("file", help=".apexcfg 文件路径")
    add_dir_arg(p_import)
    p_import.add_argument("--dry-run", action="store_true", help="仅预览, 不写入")
    p_import.set_defaults(func=cmd_import)

    return parser


def _ensure_utf8_output() -> None:
    """Windows 管道/重定向场景 stdout 默认走 cp1252,中文帮助会 UnicodeEncodeError 崩溃;
    console 附着时底层本就是 UTF-16 API,reconfigure 失败则静默跳过,双端都不受影响。"""
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


if sys.platform == 'win32':
    _ensure_utf8_output()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except ToolError as err:
        print(f"错误: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n已取消")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
