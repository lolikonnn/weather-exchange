#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓「点击做空天气」真正吃的那几个 Open-Meteo 变量，供 game.js 离线跑标定。

为什么要单独抓：
  指数里天气那一半（CAPE / 阵风 / 降水 / 天气码 / 露点）的统计特征决定了价格模型的输入。
  想量"游戏生成的行情和真实交易所差多少"，就必须喂**真实天气**，
  随便造一条随机序列的话量出来的东西没有意义（实测差 5 倍，就是假天气造成的）。

抓的就是 game.js 里 OpenMeteo.minutely() 请求的那一组，一字不差：
  minutely_15 = temperature_2m, wind_gusts_10m, precipitation, weather_code, cape, dew_point_2m
  past_days=92 & forecast_days=1 & timezone=Asia/Shanghai

用法：
    python tools\\fetch_weather.py                       # 默认广州（有国家站、华南对流活跃）
    python tools\\fetch_weather.py --lat 45.75 --lon 126.63 --name 哈尔滨
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "crypto")          # 和行情样本放一起，都是标定用的
sys.path.insert(0, os.path.join(ROOT, "server"))

import app as srv                                   # noqa: E402  复用仓库自己的抓取实现

VARS = "temperature_2m,wind_gusts_10m,precipitation,weather_code,cape,dew_point_2m"
AIR = "pm2_5"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, default=23.13, help="默认广州")
    ap.add_argument("--lon", type=float, default=113.26)
    ap.add_argument("--name", default="广州")
    ap.add_argument("--past-days", type=int, default=92)
    a = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    tz = "Asia%2FShanghai"

    mn_url = ("https://historical-forecast-api.open-meteo.com/v1/forecast"
              "?latitude=%s&longitude=%s&minutely_15=%s&past_days=%d&forecast_days=1&timezone=%s"
              % (a.lat, a.lon, VARS, a.past_days, tz))
    print("抓 15 分钟行情序列 …")
    mn = json.loads(srv.fetch_cached(mn_url, 600, ref=None, timeout=60).decode("utf-8"))
    m = mn.get("minutely_15") or {}
    print("  %d 个时刻，%s .. %s" % (len(m.get("time") or []),
                                     (m.get("time") or ["?"])[0], (m.get("time") or ["?"])[-1]))

    air_url = ("https://air-quality-api.open-meteo.com/v1/air-quality"
               "?latitude=%s&longitude=%s&hourly=%s&past_days=%d&forecast_days=1&timezone=%s"
               % (a.lat, a.lon, AIR, a.past_days, tz))
    print("抓 逐小时 PM2.5 …")
    air = json.loads(srv.fetch_cached(air_url, 600, ref=None, timeout=60).decode("utf-8"))
    h = air.get("hourly") or {}
    print("  %d 个小时" % len(h.get("time") or []))

    out = {
        "name": a.name, "lat": a.lat, "lon": a.lon, "past_days": a.past_days,
        "minutely": {k: m.get(k) or [] for k in
                     ("time", "temperature_2m", "wind_gusts_10m", "precipitation",
                      "weather_code", "cape", "dew_point_2m")},
        "air": {"time": h.get("time") or [], "pm25": h.get("pm2_5") or []},
    }
    # 有几个 null 也如实记下来 —— 后面算覆盖率要用
    for k in ("temperature_2m", "wind_gusts_10m", "cape", "dew_point_2m"):
        v = out["minutely"][k]
        out["minutely"][k + "_nonnull"] = sum(1 for x in v if x is not None)

    p = os.path.join(OUT, "weather_%s.json" % a.name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("-> %s  (%.1f MB)" % (p, os.path.getsize(p) / 1048576.0))
    for k in ("temperature_2m", "wind_gusts_10m", "cape", "dew_point_2m"):
        n, nn = len(out["minutely"][k]), out["minutely"][k + "_nonnull"]
        print("   %-18s 非空 %d/%d (%.1f%%)" % (k, nn, n, 100.0 * nn / max(1, n)))


if __name__ == "__main__":
    main()
