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
  web/data/official/cma/{站号}.now.json     气象局实况（**兜底**，见下）
  web/data/official/cma/{站号}.view.json    气象局 7 日预报 + 逐 3 小时 + 气候均值
  web/data/official/cma/{站号}.hourly.json  气象局逐 3 小时

⚠ 两套范围是**故意分开**的（2026-10-08 改）:
  · d1 那一路（snapshot / fcst / cal）仍按 cities.json 的 `prefetch` 受控名单走 ——
    单个 cal 文件就 ~23 KB，352 城规模会暴涨（实测 90 个 cal 已经 1.97 MB）；
  · 而**气象局实况 `now` 覆盖所有有站城市**（310 座）。理由：`weather.cma.cn` 对**外站
    Referer 一律 403**（浏览器跨域 fetch 必然带本站 Referer，而 Referer 是禁止手写的头），
    直连一旦被挡，行情栏能显示气象局实况的**唯一**来源就是这份预抓文件。单个 now 只有
    ~364 B，310 座全量约 110 KB，代价可以忽略。用 `--no-cma-all` 可以关掉这个扩展。
    `view` / `hourly` **只给受控名单**：hourly 单个 ~19 KB，270 座就是 5.6 MB/轮，
    而工作流每 30 分钟提交一次，那个体积撑不住。

用法:
  python prefetch_official.py                # 全量（d1 按受控名单 + 气象局实况全站兜底）
  python prefetch_official.py --limit 20     # 抽样
  python prefetch_official.py --hot-only     # 只抓热门 20 城
  python prefetch_official.py --no-cal       # 跳过月度日历（体积最大的一部分）
  python prefetch_official.py --no-cma-all   # 气象局实况也只抓受控名单（旧行为）
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
    ap.add_argument("--all", action="store_true",
                    help="预抓全部城市（默认只抓 cities.json 里 prefetch 列出的受控名单）")
    ap.add_argument("--no-cal", action="store_true")
    ap.add_argument("--no-cma", action="store_true")
    ap.add_argument("--no-hourly", action="store_true")
    ap.add_argument("--no-cma-all", action="store_true",
                    help="气象局实况也只抓受控名单（默认是**所有有站城市**，见文件头说明）")
    ap.add_argument("--cma-now-limit", type=int, default=0,
                    help="只给前 N 座城市补 now（调试用，0=不限）")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()

    doc = json.loads(open(CITIES, encoding="utf-8").read())
    all_cities = doc["cities"]
    if a.hot_only:
        hot = set(doc.get("hot") or [])
        todo = [c for c in all_cities if c["name"] in hot or c.get("id") in hot]
    elif doc.get("prefetch") and not a.all:
        # 前端目录是全量 352 城（搜索要能搜到），但日历文件按 352 城规模会暴涨，
        # 所以预抓范围单独由 prefetch 列出（原来是 45 城）。要抓全量显式传 --all。
        ids = set(doc["prefetch"])
        todo = [c for c in all_cities if c.get("id") in ids]
    else:
        todo = [c for c in all_cities if c.get("id")]
    if a.limit:
        todo = todo[: a.limit]
    print("预抓 %d 城 (并发 %d)" % (len(todo), a.workers))

    # 气象局实况的兜底范围：**所有有站城市**，跟上面 d1 的受控名单故意分开（见文件头说明）。
    cma_all = [] if a.no_cma else [c for c in all_cities if c.get("cma")]
    if a.cma_now_limit:
        cma_all = cma_all[: a.cma_now_limit]
    todo_ids = set(c["id"] for c in todo)
    cma_now_extra = [c for c in cma_all if c["id"] not in todo_ids]
    print("气象局实况兜底范围: %d 座有站城市（受控名单已覆盖 %d 座，这里再补 %d 座）"
          % (len(cma_all), len(cma_all) - len(cma_now_extra), len(cma_now_extra)))

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

    # ★ 第二遍：给受控名单之外的**所有有站城市**补一份气象局实况。
    #   只抓 `now` —— 它是"直连被挡时行情栏唯一能显示的东西"，单文件 ~364 B；
    #   `view` / `hourly` 仍只给受控名单（hourly 单个 ~19 KB，270 座就是 5.6 MB/轮，
    #   而工作流每 30 分钟提交一次，那个体积撑不住）。`write()` 只在内容真变了才落盘，
    #   所以这里每轮产生的 git 变化只有"实况确实更新了"的那部分。
    n_now_extra = 0
    if cma_now_extra:
        t1 = time.time()
        with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
            for _ in ex.map(lambda c: cma_prefetch(c, ["now"]), cma_now_extra):
                n_now_extra += 1
        print("  补完 %d 座，用时 %ds" % (n_now_extra, int(time.time() - t1)))

    n = write(os.path.join(OUT, "snapshot.json"),
              {"updated": time.strftime("%Y-%m-%d %H:%M:%S"), "count": len(snaps), "cities": snaps})
    print("snapshot.json: %d 城, %d bytes" % (len(snaps), n))

    # 覆盖自检：落盘之后数一遍。不查的话，缺的那几座只能等使用者报障才发现
    # （2026-10-08 就是这么发现的：`cma/*.now.json` 只有 40 个，而带站号的城市有 310 座）。
    n_have, miss = 0, []
    for c in cma_all:
        p = os.path.join(OUT, "cma", "%s.now.json" % c["cma"])
        if os.path.exists(p):
            n_have += 1
        else:
            miss.append("%s(%s)" % (c["name"], c["cma"]))
    print("气象局实况兜底覆盖: %d/%d 座有站城市" % (n_have, len(cma_all)))
    if miss:
        print("  缺 %d 座: %s" % (len(miss), " ".join(miss[:24])))

    write(os.path.join(OUT, "meta.json"), {
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "count": len(ok), "failed": len(fail),
        "okCodes": [r["code"] for r in ok],
        "fail": fail[:80],
        "ym": [ym_now, ym_next],
        # 气象局实况兜底的覆盖情况：网页端「直连被挡时行情栏显示什么」全看这一项，
        # 所以写进 meta 里，出问题一眼能看出来是抓漏了还是上游挂了。
        "cmaNow": {"have": n_have, "total": len(cma_all),
                   "extraFetched": n_now_extra, "missing": miss[:60]},
        "source": "中国天气网 www.weather.com.cn / d1.weather.com.cn",
    })
    print("完成: ok=%d fail=%d 气象局文件=%d 用时 %ds" % (len(ok), len(fail), n_cma[0], int(time.time() - t0)))
    if fail:
        print("失败样例:", json.dumps(fail[:6], ensure_ascii=False))


if __name__ == "__main__":
    main()
