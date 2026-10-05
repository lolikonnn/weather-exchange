# -*- coding: utf-8 -*-
"""
把 web/data/cities.json 裁剪到 tools/scope.py 定义的范围（珠三角 + 长株潭娄底 + 省会）。

不需要联网 —— 只是过滤既有数据，所以随时可以改进 scope.py 再跑一次。
原始未裁剪版本会备份成 web/data/cities.full.json（只在第一次备份）。

用法:
    python tools\\scope_cities.py            # 写入
    python tools\\scope_cities.py --dry      # 只预览
    python tools\\scope_cities.py --restore  # 从 cities.full.json 还原
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scope  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "web", "data")
CUR = os.path.join(DATA, "cities.json")
FULL = os.path.join(DATA, "cities.full.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--restore", action="store_true")
    a = ap.parse_args()

    if a.restore:
        if not os.path.exists(FULL):
            sys.exit("没有 %s 可还原" % FULL)
        shutil.copy2(FULL, CUR)
        d = json.load(open(CUR, encoding="utf-8"))
        print("已还原: %d 城" % d["count"])
        return

    doc = json.load(open(CUR, encoding="utf-8"))
    before = doc["count"]

    # 保留一份完整数据：scope.py 后续调整时不用重新联网抓
    if not os.path.exists(FULL):
        shutil.copy2(CUR, FULL)
        print("已备份完整数据 -> %s (%d 城)" % (os.path.relpath(FULL, ROOT), before))

    scope.apply(doc)

    print("裁剪: %d -> %d 城" % (before, doc["count"]))
    print("热门: %s" % "、".join(doc["hot"]))
    by_prov = {}
    for c in doc["cities"]:
        by_prov.setdefault(c["prov"], []).append(c["name"])
    for p in sorted(by_prov, key=lambda k: -len(by_prov[k])):
        print("  %-10s %2d  %s" % (p, len(by_prov[p]), "、".join(by_prov[p])))

    miss = [c["name"] for c in doc["cities"] if not c.get("cma")]
    print("无气象局站号 %d 个: %s" % (len(miss), "、".join(miss)))

    if a.dry:
        print("\n(--dry 未写入)")
        return
    with open(CUR, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("\n已写入 %s (%d bytes)" % (os.path.relpath(CUR, ROOT), os.path.getsize(CUR)))


if __name__ == "__main__":
    main()
