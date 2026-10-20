#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""apex_cfg_tool.py 核心逻辑自测(不走 stdin 交互, 直接调用函数)"""
import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, "/Volumes/New/LetsLogin/web/public/downloads")
import apex_cfg_tool as tool

passed = []


def check(name, condition_func):
    value = condition_func()
    assert value, name
    passed.append(name)
    print(f"PASS  {name}")


root = tempfile.mkdtemp(prefix="apex-py-test-")
cfg = os.path.join(root, "Saved Games", "Respawn", "Apex", "local")
os.makedirs(cfg)
with open(os.path.join(cfg, "settings.cfg"), "w", encoding="utf-8") as f:
    f.write('"mouse_sensitivity" "1.8"\n"binding_jump" "space"\n')
with open(os.path.join(cfg, "videoconfig.txt"), "w", encoding="utf-8") as f:
    f.write('"setting.defaultres" "2560"\n"setting.fps_max" "240"\n')

check("明细读取", lambda: tool.op_show(cfg) is None)

check("备份 + 去重", lambda: tool.op_backup(cfg, keep=20)["skipped"] is False and
      tool.op_backup(cfg, keep=20)["skipped"] is True)

with open(os.path.join(cfg, "settings.cfg"), "w", encoding="utf-8") as f:
    f.write('"mouse_sensitivity" "2.4"\n"binding_jump" "space"\n')
tool.op_backup(cfg, keep=2)
with open(os.path.join(cfg, "settings.cfg"), "w", encoding="utf-8") as f:
    f.write('"mouse_sensitivity" "3.0"\n"binding_jump" "space"\n')
tool.op_backup(cfg, keep=2)
_local, _dir, rows = tool.op_list(cfg)
check("轮转 keep=2", lambda: len(rows) == 2)

oldest = rows[-1]
backup_path = os.path.join(_dir, oldest[0])
result = tool.op_restore(backup_path, cfg)
check("恢复 + 安全包", lambda: len(result["written"]) == 1 and len(result["identical"]) == 1
      and result["safety"] is not None
      and '"2.4"' in open(os.path.join(cfg, "settings.cfg"), encoding="utf-8").read())

out = os.path.join(root, "share.apexcfg")
export = tool.op_export(cfg, out, "测试 2.4", "py 自动化")
parsed = json.load(open(out, encoding="utf-8"))
check("导出格式互通", lambda: export["files"] == 2 and parsed["kind"] == "apexcfg"
      and parsed["format"] == 1 and parsed["preview"]["binds_count"] >= 1)

fresh = os.path.join(root, "out", "Respawn", "Apex", "local")
imported = tool.op_import(out, fresh)
check("导入新目录 + 字节一致", lambda: len(imported["written"]) == 2 and imported["safety"] is None
      and open(os.path.join(cfg, "settings.cfg"), "rb").read() == open(os.path.join(fresh, "settings.cfg"), "rb").read())

raw = json.load(open(out, encoding="utf-8"))
raw["files"]["settings.cfg"]["b64"] = base64.b64encode(b"broken").decode()
tampered = os.path.join(root, "tampered.apexcfg")
json.dump(raw, open(tampered, "w", encoding="utf-8"))


def tamper_raises():
    try:
        tool.op_import(tampered, cfg)
    except ValueError as err:
        return "校验失败" in str(err)
    return False


check("篡改拦截", tamper_raises)

evil = os.path.join(root, "evil.apexcfg")
data = b"evil"
json.dump({"kind": "apexcfg", "format": 1,
           "files": {"../evil.cfg": {"b64": base64.b64encode(data).decode(),
                                     "sha256": hashlib.sha256(data).hexdigest()}}},
          open(evil, "w", encoding="utf-8"))


def traversal_raises():
    try:
        tool.op_import(evil, cfg)
    except ValueError as err:
        return "非法文件名" in str(err)
    return False


check("路径穿越拦截", traversal_raises)

payload, _w = tool.build_share_object(cfg, "广场直发", "test")


def write_payload(payload, directory):
    path = os.path.join(directory, "plaza.apexcfg")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False))
    return path


fresh2 = os.path.join(root, "out2", "Respawn", "Apex", "local")
payload, _w = tool.build_share_object(cfg, "广场直发", "test")
imported2 = tool.op_import(write_payload(payload, root), fresh2)
check("build_share_object → 直导入", lambda: len(imported2["written"]) == 2
      and imported2["label"] == "广场直发"
      and '"2.4"' in open(os.path.join(fresh2, "settings.cfg"), encoding="utf-8").read())

files = {}
for index in range(65):
    blob = f"x{index}".encode()
    files[f"f{index}.cfg"] = {"b64": base64.b64encode(blob).decode(),
                              "sha256": hashlib.sha256(blob).hexdigest()}


def cap_raises():
    try:
        tool.share_entries({"kind": "apexcfg", "format": 1, "files": files})
    except ValueError as err:
        return "上限" in str(err)
    return False


check("64 上限拦截", cap_raises)

shutil.rmtree(root, ignore_errors=True)
print(f"\n全部自测通过 ✓ ({len(passed)} 项)")
