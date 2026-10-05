# -*- coding: utf-8 -*-
"""
预抓中国天气网 (d1.weather.com.cn) 官方数据 -> web/data/official/*.json

为什么需要:
  d1.weather.com.cn 强制校验 Referer 必须是 weather.com.cn, 浏览器从 github.io
  直连一律 403。GitHub Pages 上没有后端, 所以由 GitHub Actions 定时在服务端抓取
  并 commit 进仓库, 静态站再读这些 JSON。

产出（路径与 web/js/api.js 的 Cn.* 完全对应）:
  web/data/official/meta.json              {updated, count, ok, fail, source}
  web/data/official/snapshot.json          {updated, cities: {code: dataSK}}
  web/data/official/fcst/{code}.json       {weatherinfo: {...}, alarm: [...]}
  web/data/official/cal/{code}_{ym}.json   [fc40 ...]

用法:
  python prefetch_official.py                # 全量（约 300 城，并发 6）
  python prefetch_official.py --limit 20     # 抽样
  python prefetch_official.py --hot-only     # 只抓热门 20 城
  python prefetch_official.py --no-cal       # 跳过月度日历（体积最大的一部分）
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import app as srv  # noqa: E402  (复用同一份抓取/解析实现)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DATA = os.path.join(ROOT, "web", "data")
OUT = os.path.join(DATA, "official")
CITIES = os.path.join(DATA, "cities.json")


def ym_shift(months: int, ts: float | None = None) -> str:
    t = time.localtime(ts if ts is not None else time.time())
    y, m = t.tm_year, t.tm_mon + months
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return "%04d%02d" % (y, m)


def write(path: str, obj) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    b = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    old = None
    if os.path.exists(path):
        old = open(path, "rb").read()
    if old != b:
        with open(path, "wb") as f:
            f.write(b)
    return len(b)


# ---------------------------------------------------------------- 气象局 (weather.cma.cn)
# 为什么也要预抓: 浏览器直连 weather.cma.cn 在部分网络/网关环境下会被 CORS 拦掉
# （实测无头 Chrome 里 fetch 直接 TypeError: Failed to fetch，而同源代理 200）。
# 静态站因此需要一份兜底数据。文件名 {站号}.{now|view|hourly}.json，与 api.js 的
# cmaRaw() 第三级路径一致。
CMA = "https://weather.cma.cn"
CMA_EP = {"now": "/api/now/%s",
          "view": "/api/weather/view?stationid=%s",
          "hourly": "/api/hourly/%s"}


def cma_prefetch(c, subs) -> int:
    st = c.get("cma")
    if not st:
        return 0
    got = 0
    for sub in subs:
        try:
            b = srv.fetch_cached(CMA + (CMA_EP[sub] % st), 600, ref=None, timeout=25)
            obj = json.loads(b)          # 不能解析就不落盘，免得把错误页写进仓库
            if not (obj.get("data") if isinstance(obj, dict) else None):
                continue
            write(os.path.join(OUT, "cma", "%s.%s.json" % (st, sub)), obj)
            got += 1
        except Exception:  # noqa: BLE001
            pass
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--hot-only", action="store_true")
    ap.add_argument("--no-cal", action="store_true")
    ap.add_argument("--no-cma", action="store_true")
    ap.add_argument("--no-hourly", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    doc = json.loads(open(CITIES, encoding="utf-8").read())
    all_cities = doc["cities"]
    if a.hot_only:
        hot = set(doc.get("hot") or [])
        todo = [c for c in all_cities if c["name"] in hot or c.get("id") in hot]
    else:
        todo = [c for c in all_cities if c.get("id")]
    if a.limit:
        todo = todo[: a.limit]
    print("预抓 %d 城 (并发 %d)" % (len(todo), a.workers))

    ym_now, ym_next = ym_shift(0), ym_shift(1)
    print("日历月份: %s, %s" % (ym_now, ym_next))

    snaps: dict[str, dict] = {}
    ok, fail = [], []
    n_cma = [0]
    lock = __import__("threading").Lock()
    cma_subs = ["now", "view"] + ([] if a.no_hourly else ["hourly"])

    def one(c):
        code = c["id"]
        try:
            s = srv.cn_snapshot(code)
            f = srv.cn_forecast(code)
            rec = {"code": code, "name": c["name"], "prov": c["prov"]}
            with lock:
                if s:
                    snaps[code] = s
                write(os.path.join(OUT, "fcst", "%s.json" % code), f)
                if not a.no_cal:
                    for ym in (ym_now, ym_next):
                        arr = srv.cn_calendar(code, ym)
                        if arr:
                            write(os.path.join(OUT, "cal", "%s_%s.json" % (code, ym)), arr)
                ok.append(rec)
            if not a.no_cma:
                n = cma_prefetch(c, cma_subs)
                with lock:
                    n_cma[0] += n
            return True
        except Exception as e:  # noqa: BLE001
            with lock:
                fail.append({"code": code, "name": c["name"], "error": "%s: %s" % (type(e).__name__, e)})
            return False

    t0 = time.time()
    done = 0
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for _ in ex.map(one, todo):
            done += 1
            if done % 25 == 0 or done == len(todo):
                print("  %3d/%3d  ok=%d fail=%d  %ds" % (done, len(todo), len(ok), len(fail),
                                                         int(time.time() - t0)))

    n = write(os.path.join(OUT, "snapshot.json"),
              {"updated": time.strftime("%Y-%m-%d %H:%M:%S"), "count": len(snaps), "cities": snaps})
    print("snapshot.json: %d 城, %d bytes" % (len(snaps), n))

    write(os.path.join(OUT, "meta.json"), {
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(ok), "failed": len(fail),
        "okCodes": [r["code"] for r in ok],
        "fail": fail[:80],
        "ym": [ym_now, ym_next],
        "source": "中国天气网 www.weather.com.cn / d1.weather.com.cn",
    })
    print("完成: ok=%d fail=%d 气象局文件=%d 用时 %ds" % (len(ok), len(fail), n_cma[0], int(time.time() - t0)))
    if fail:
        print("失败样例:", json.dumps(fail[:6], ensure_ascii=False))


if __name__ == "__main__":
    main()
