#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下载真实交易所 K 线，给「点击做空天气」的操盘手感做标定。

为什么需要：
  现在指数里那些系数（NOISE_A / JUMP_AT / JUMP_K / MICRO_K / DISH_K …）是**拟合**出来的 ——
  照着"单根中位涨跌 0.19%"这种自己定的目标去凑。但真实行情长什么样，是有客观答案的：
  把欧易（OKX）的公开 K 线拉下来量一遍，就知道差多少、该往哪边调。
  这一份脚本只负责**把数据拉下来**，统计与对拍在 tools/analyze_crypto.py。

合法性与边界：
  · 只读 **公开** 行情接口（/api/v5/market/history-candles），**免 key、免账号、不登录**；
  · 不碰任何交易 / 下单 / 账户类接口，不做任何需要 API key 的事；
  · 纯研究用途，产物落本地 data/crypto/（已在 .gitignore 里，不会提交）。

网络：本机直连解析不了 www.okx.com（getaddrinfo 直接失败），必须走系统代理
  （注册表里的 127.0.0.1:7897）。Python 的 urllib 不会自动读那个设置，所以下面
  setup_proxy() 会自己探一遍并设好 HTTP(S)_PROXY 环境变量，必须在任何请求**之前**调用。
  实测设完之后仓库原有的五个源（气象局 / Open-Meteo / d1 / 台风网 / USGS）照样通，
  代理是只加不减。

数据为什么长这样：
  · 单页**最多 300 根**（实测 limit 给 400/1000 也只回 300）；
  · 用 `after=<毫秒>` 往回翻页，返回是**新→旧**；
  · 1 分钟档能回溯约 2 年，各对的上币时间不同（WIF 到 2024-04、PEPE 到 2023-05）。
  · **默认 User-Agent 会被欧易回 403**，必须带浏览器 UA（实测 Python-urllib 403、Chrome UA 200）。

选出 9 个对，按**流动性从大到小**排（这个顺序就是后面映射到"大城市 ↔ 小城市"的依据）：
  主流币   BTC / ETH            —— 对应直辖市、省会这种"大盘股"
  人气币   SOL / DOGE           —— 对应有国家站的地级市
  二三线   SUI / APT            —— 对应普通地级市
  模因币   PEPE / WIF / BONK    —— 对应县城、区县（盘子小、容易被推着走）

用法：
    python tools\\fetch_crypto.py                    # 默认 15 分钟 × 365 天 × 9 个对
    python tools\\fetch_crypto.py --bars 1m --days 30
    python tools\\fetch_crypto.py --pairs BTC-USDT,ETH-USDT --bars 1H --days 2000
    python tools\\fetch_crypto.py --force            # 忽略已有文件重下
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import gzip
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "crypto")

API = "https://www.okx.com/api/v5/market/history-candles"
PAGE = 300                     # 实测上限就是 300，给大也没用
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) tjs-crypto-calib/1.0"

# 按流动性从大到小 —— 顺序有意义，别随手重排
PAIRS = [
    "BTC-USDT", "ETH-USDT",                    # 主流
    "SOL-USDT", "DOGE-USDT",                   # 人气
    "SUI-USDT", "APT-USDT",                    # 二三线
    "PEPE-USDT", "WIF-USDT", "BONK-USDT",      # 模因
]

# 毫秒 / 根
BAR_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
          "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000}

_lock = threading.Lock()
_req = [0]


def setup_proxy(explicit: str = "") -> str:
    """探出可用的 HTTP(S) 代理并设进环境变量，返回用了哪个（'' = 直连）。

    为什么必须显式做：本机直连解析不了 www.okx.com（getaddrinfo 直接失败），
    PowerShell 的 Invoke-WebRequest 会自动读注册表里的代理设置，Python 不会 ——
    不开代理时表现是 `URLError: [Errno 11004] getaddrinfo failed`，看着像网络不通，
    其实是"没走代理"。实测 urllib 的 ProxyHandler 在这台机器上也不生效，
    只有进程级环境变量可靠，所以这里直接设 env。
    """
    cand = explicit or os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
    if not cand and os.name == "nt":
        try:
            import winreg                                  # noqa: PLC0415
            k = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
            if winreg.QueryValueEx(k, "ProxyEnable")[0]:
                srv = winreg.QueryValueEx(k, "ProxyServer")[0]
                if srv and "=" not in srv:                 # 形如 127.0.0.1:7897
                    cand = "http://" + srv
        except Exception:                                  # noqa: BLE001
            cand = ""
    if not cand:
        return ""
    if "://" not in cand:
        cand = "http://" + cand
    os.environ["HTTP_PROXY"] = cand
    os.environ["HTTPS_PROXY"] = cand
    # 本地回环必须直连，否则会把 server/app.py 自己那套 /api/* 也绕出去
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost,::1")
    return cand


def http_json(url: str, tries: int = 4) -> dict:
    for k in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "application/json",
                                                   "Accept-Encoding": "gzip"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    b = gzip.decompress(b)
                with _lock:
                    _req[0] += 1
                return json.loads(b.decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 429/5xx 是限流或抽风，退避重试；4xx 其它情况直接放弃
            if e.code in (429, 500, 502, 503, 504) and k < tries - 1:
                time.sleep(1.2 * (k + 1))
                continue
            raise
        except Exception:
            if k < tries - 1:
                time.sleep(0.8 * (k + 1))
                continue
            raise
    raise RuntimeError("重试用尽: " + url)


def fetch_one(pair: str, bar: str, days: int) -> dict:
    """把一个对的 [now-days, now] 全部拉下来。返回 {pair, bar, rows:[[ts,o,h,l,c,vol,...]]}"""
    step = BAR_MS[bar]
    now = int(time.time() * 1000)
    want_from = now - days * 86_400_000
    rows = {}
    cursor = now
    pages = 0
    while pages < 4000:
        url = "%s?instId=%s&bar=%s&after=%d&limit=%d" % (API, pair, bar, cursor, PAGE)
        d = http_json(url)
        if d.get("code") != "0":
            raise RuntimeError("%s 返回 %s: %s" % (pair, d.get("code"), d.get("msg")))
        data = d.get("data") or []
        if not data:
            break
        for r in data:
            rows[int(r[0])] = [int(r[0])] + [float(x) for x in r[1:6]] + [float(r[5])]
        oldest = int(data[-1][0])
        pages += 1
        if oldest <= want_from:
            break
        nxt = oldest - step          # 用步长往前挪，别用 -1（会漏边界）
        if nxt >= cursor:            # 保险：游标必须单调后退
            break
        cursor = nxt
        time.sleep(0.06)             # 温和限流，别把公开接口打爆
    ts = sorted(rows)
    out = [rows[t] for t in ts]
    # 连续性体检：15 分钟档不该有超过 1 个步长的空洞（交易所维护时会短暂停摆，允许少量）
    gaps = 0
    for i in range(1, len(ts)):
        if ts[i] - ts[i - 1] > step * 1.5:
            gaps += 1
    return {"pair": pair, "bar": bar, "days": days, "count": len(out),
            "from": ts[0] if ts else 0, "to": ts[-1] if ts else 0,
            "gaps": gaps, "rows": out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", default="", help="逗号分隔，默认用内置那 9 个")
    ap.add_argument("--bars", default="15m", help="1m/5m/15m/30m/1H/4H/1D（可逗号分隔）")
    ap.add_argument("--days", type=int, default=365, help="往回拉多少天")
    ap.add_argument("--workers", type=int, default=3, help="并发（公开接口，别开太大）")
    ap.add_argument("--force", action="store_true", help="忽略已存在的文件，重下")
    ap.add_argument("--proxy", default="", help="HTTP 代理，如 http://127.0.0.1:7897；默认自动探测")
    a = ap.parse_args()

    px = setup_proxy(a.proxy)
    print("代理: %s" % (px or "直连"))

    pairs = [p.strip() for p in (a.pairs or ",".join(PAIRS)).split(",") if p.strip()]
    bars = [b.strip() for b in a.bars.split(",") if b.strip()]
    for b in bars:
        if b not in BAR_MS:
            sys.exit("不认识的周期 %s，可选：%s" % (b, "/".join(BAR_MS)))

    os.makedirs(OUT, exist_ok=True)
    jobs = []
    for b in bars:
        for p in pairs:
            f = os.path.join(OUT, "%s_%s_%dd.json" % (p.replace("-", ""), b, a.days))
            jobs.append((p, b, f))

    todo = [j for j in jobs if a.force or not os.path.exists(j[2])]
    print("任务 %d 个（跳过已存在 %d 个），周期 %s，%d 天，并发 %d"
          % (len(todo), len(jobs) - len(todo), "/".join(bars), a.days, a.workers))
    if not todo:
        print("都下过了。要重下加 --force")
        return

    t0 = time.time()
    done = 0
    fails = []

    def work(job):
        p, b, f = job
        try:
            d = fetch_one(p, b, a.days)
            if not d["count"]:
                return (job, "空")
            tmp = f + ".part"
            with open(tmp, "w", encoding="utf-8") as fp:
                json.dump(d, fp, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, f)
            return (job, d)
        except Exception as e:                       # noqa: BLE001
            return (job, "ERR %s: %s" % (type(e).__name__, e))

    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for job, res in ex.map(work, todo):
            done += 1
            p, b, f = job
            if isinstance(res, dict):
                span = ""
                if res["from"]:
                    span = "%s .. %s" % (
                        time.strftime("%Y-%m-%d", time.localtime(res["from"] / 1000)),
                        time.strftime("%Y-%m-%d", time.localtime(res["to"] / 1000)))
                print("  %-11s %-4s %6d 根  %s  空洞 %d  (%.1f MB)"
                      % (p, b, res["count"], span, res["gaps"],
                         os.path.getsize(f) / 1048576.0))
            else:
                print("  %-11s %-4s 失败：%s" % (p, b, res))
                fails.append((p, b, res))
            if done % 5 == 0 or done == len(todo):
                print("    ... %d/%d  HTTP 请求 %d 次  %ds"
                      % (done, len(todo), _req[0], int(time.time() - t0)))

    print("\n完成 %d/%d，耗时 %ds，HTTP %d 次 -> %s"
          % (len(todo) - len(fails), len(todo), int(time.time() - t0), _req[0], OUT))
    if fails:
        print("失败 %d 个：" % len(fails))
        for p, b, r in fails[:10]:
            print("   %s %s  %s" % (p, b, r))
        sys.exit(1)


if __name__ == "__main__":
    main()
