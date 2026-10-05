# -*- coding: utf-8 -*-
"""抓取「省 / 地级市 / 区县」三级地名目录（含中心点经纬度），产出 web/data/places.json。

为什么需要它：web/data/cities.json 只有 352 个**地级市**（源自气象局站号表），
所以义乌、昆山、敦煌这类县级市在搜索框里搜不到。places.json 用阿里 DataV 的
行政区划边界数据补齐到区县级，每条都带 center 经纬度 —— 有了经纬度就能直接走
Open-Meteo 取天气，不需要气象局站号。

用法：
    E:\\python\\python.exe tools\\build_places.py            # 全量抓取并写盘
    E:\\python\\python.exe tools\\build_places.py --dry      # 只统计，不写盘
    E:\\python\\python.exe tools\\build_places.py --workers 12

数据源：https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json
返回 GeoJSON，features[].properties = {name, adcode, center:[lon,lat], level}
level ∈ {province, city, district}
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "data", "places.json")
BASE = "https://geo.datav.aliyun.com/areas_v3/bound/%s_full.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a)
        sys.stdout.flush()


def fetch(adcode, tries=3):
    """取一个 adcode 的下级区划；失败返回 []（调用方按空处理，不中断整轮）"""
    url = BASE % adcode
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45, context=CTX) as r:
                d = json.loads(r.read().decode("utf-8"))
            out = []
            for f in d.get("features") or []:
                p = f.get("properties") or {}
                c = p.get("center") or p.get("centroid")
                if not p.get("name") or not c or len(c) < 2:
                    continue
                out.append({
                    "adcode": str(p.get("adcode") or ""),
                    "name": p["name"],
                    "lon": round(float(c[0]), 4),
                    "lat": round(float(c[1]), 4),
                    "level": p.get("level") or "",
                })
            return out
        except Exception as e:  # noqa: BLE001 - 网络抖动就该重试
            last = e
            time.sleep(1.0 + i)
    log("  ! %s 失败: %s" % (adcode, last))
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="只统计，不写盘")
    ap.add_argument("--workers", type=int, default=10)
    a = ap.parse_args()

    log("1/3 抓省级 …")
    provs = [p for p in fetch("100000") if p["level"] == "province"]
    log("    省级 %d 个" % len(provs))

    # 港澳台等可能没有下级；省级自身也作为一条收录（搜「浙江」能落到杭州）
    places = {}
    for p in provs:
        places[p["adcode"]] = dict(p, prov=p["name"], city="")

    log("2/3 抓地级市 …")
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        city_lists = list(ex.map(lambda p: (p, fetch(p["adcode"])), provs))
    cities = []
    for p, lst in city_lists:
        got = [c for c in lst if c["level"] == "city" and c["adcode"] != p["adcode"]]
        # 直辖市 / 特别行政区：下级就是「区」，level=district，要按城市收
        if not got:
            got = [c for c in lst if c["adcode"] != p["adcode"]]
        for c in got:
            places[c["adcode"]] = dict(c, prov=p["name"], city="")
            cities.append((c, p["name"]))
        log("    %-12s %d" % (p["name"], len(got)))
    log("    地级市合计 %d" % len(cities))

    log("3/3 抓区县 …")
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        dist_lists = list(ex.map(lambda cp: (cp, fetch(cp[0]["adcode"])), cities))
    nd = 0
    for (c, pname), lst in dist_lists:
        for d0 in lst:
            if d0["level"] != "district" or d0["adcode"] == c["adcode"]:
                continue
            places[d0["adcode"]] = dict(d0, prov=pname, city=c["name"])
            nd += 1
    log("    区县合计 %d" % nd)

    # 紧凑数组格式：省体积
    order = {"province": 1, "city": 2, "district": 3}
    rows = []
    for a0, v in places.items():
        rows.append([v["adcode"], v["name"], v["lon"], v["lat"],
                     v["prov"], v["city"], order.get(v["level"], 9)])
    rows.sort(key=lambda r: r[0])

    doc = {"source": "https://geo.datav.aliyun.com/areas_v3/bound/",
           "note": "省/地级市/区县三级，含中心点经纬度；level 1=省 2=市 3=区县",
           "count": len(rows), "list": rows}

    log("总计 %d 条（省 %d / 市 %d / 区县 %d）"
        % (len(rows), len(provs), len(cities), nd))
    if a.dry:
        log("--dry：不写盘")
        return

    old = None
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:  # noqa: BLE001
            old = None
    if old and old.get("list") == rows:
        log("内容未变化，跳过写盘")
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    log("已写入 %s（%d B）" % (os.path.relpath(OUT, ROOT), os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
