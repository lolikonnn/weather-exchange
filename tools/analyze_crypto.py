#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把欧易真实 K 线和「点击做空天气」生成的行情放在**同一套指标**下对拍。

为什么这么做：
  game.js 里那些系数是照着"单根中位涨跌 0.19%"这类自己定的目标凑出来的（拟合）。
  真实行情长什么样有客观答案，所以先量出来，再决定往哪边调、调多少。
  这个脚本只**报告**，不改任何东西。

四组指标（都是先标准化再比，否则不同周期、不同币根本没法比）：

  ① 波动水平     单根 |涨跌|% 的中位 / p90 / p99 / max
  ② 波动标度     同一段墙钟时间里，粗周期波动 ÷ 细周期波动。
                 **布朗运动应该是 √(周期比)**（15m/1m = √15 ≈ 3.87），
                 实测是不是这个数，决定了"1 分档该不该按线性插值展开"。
  ③ 形状         lag-1 自相关（"一段一段地推"）、峰度、偏度
  ④ 波动聚集     滚动窗口波动率的 p90/p50 比值 —— 大不大起大落
                 价格与成交量的关系（放量下跌 vs 缩量上涨）

用法：
    python tools\\analyze_crypto.py                       # 量 data/crypto/ 里所有文件
    python tools\\analyze_crypto.py --game                # 顺带把游戏模型跑出来对拍
    python tools\\analyze_crypto.py --json report.json
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import math
import os
import statistics
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "crypto")

BAR_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1H": 60, "4H": 240, "1D": 1440}


# ─────────────────────────── 统计小工具 ───────────────────────────
def pct(sorted_xs, p):
    if not sorted_xs:
        return float("nan")
    i = int(math.floor(p * (len(sorted_xs) - 1)))
    return sorted_xs[max(0, min(len(sorted_xs) - 1, i))]


def kurtosis(xs):
    """超额峰度（正态 = 0）。用总体矩，够用。"""
    n = len(xs)
    if n < 4:
        return float("nan")
    m = sum(xs) / n
    m2 = sum((x - m) ** 2 for x in xs) / n
    if m2 <= 0:
        return float("nan")
    m4 = sum((x - m) ** 4 for x in xs) / n
    return m4 / (m2 * m2) - 3.0


def skew(xs):
    n = len(xs)
    if n < 3:
        return float("nan")
    m = sum(xs) / n
    m2 = sum((x - m) ** 2 for x in xs) / n
    if m2 <= 0:
        return float("nan")
    m3 = sum((x - m) ** 3 for x in xs) / n
    return m3 / (m2 ** 1.5)


def autocorr1(xs):
    """lag-1 自相关。game.js 里量的就是这个 —— 独立随机点 ≈ 0，成段推进 ≈ 0.1~0.4。"""
    n = len(xs)
    if n < 10:
        return float("nan")
    m = sum(xs) / n
    d = sum((x - m) ** 2 for x in xs)
    if d <= 0:
        return float("nan")
    num = sum((xs[i] - m) * (xs[i - 1] - m) for i in range(1, n))
    return num / d


def vol_clustering(rets, win=96):
    """滚动窗口（默认 96 根 = 一天 15m）的波动率，返回 p90/p50 比值。
    真实行情的波动率是**成簇**的（GARCH 效应），这个比值明显 > 1；
    纯噪声的话大约是 1.1~1.2。

    用滚动和算，别每窗口重扫一遍 —— 35100 根 × 96 的朴素写法要跑几十秒，
    纯属浪费（实测把整轮分析从分钟级压到秒级）。"""
    if len(rets) < win * 3:
        return float("nan")
    s = 0.0
    s2 = 0.0
    vols = []
    for i, x in enumerate(rets):
        s += x
        s2 += x * x
        if i >= win:
            y = rets[i - win]
            s -= y
            s2 -= y * y
        if i >= win - 1:
            m = s / win
            v = s2 / win - m * m
            vols.append(math.sqrt(v) if v > 0 else 0.0)
    vols.sort()
    p50 = pct(vols, 0.5)
    return (pct(vols, 0.9) / p50) if p50 > 0 else float("nan")


def rets_of(c):
    """逐根涨跌幅。

    ⚠ **不要用 `(c[i]-c[i-1])/c[i-1]`**。游戏指数在 1000 附近，单根只动 0.02%，
      也就是第 15 位有效数字 —— 双精度下 `1000.0000002 - 1000.0000001` 的差会被
      舍入吃掉，剩下的**全是浮点噪声**。而白噪声的 lag-1 自相关恒为 ≈ −1/(n−1) 的
      负值，于是量出来一个漂亮的 −0.5，看着像"游戏行情在锯齿翻转"，
      其实是我的测量方法坏了（真实值是 +0.185）。
      改成 `diff / prev`：分子是真实（可精确表示的）差值，分母只是缩放，
      两种价格量级（指数 1000 / 币价 1e-5~1e5）都能算准。
    """
    out = []
    for i in range(1, len(c)):
        if c[i - 1]:
            out.append((c[i] - c[i - 1]) / c[i - 1])
    return out


def analyze_rows(rows, bounds=None):
    """rows: [[ts, o, h, l, c, vol], ...] 按时间升序

    bounds: 可选，把 rows 切成若干**互不相干**的段（每段末尾的下标）。
            游戏那一份是 8 局随机窗口拼起来的，局与局之间价格水平不同，
            跨着算涨跌会得到一堆假跳变（实测自相关 −0.48，其实是导出方式造成的）。"""
    if len(rows) < 50:
        return None
    ts = [r[0] for r in rows]
    c = [r[4] for r in rows]
    hi = [r[2] for r in rows]
    lo = [r[3] for r in rows]
    vol = [r[5] for r in rows]

    # 分段算涨跌：段内正常算，段边界那一步直接丢掉
    if bounds:
        rets = []
        prev = 0
        for b in bounds:
            rets.extend(rets_of(c[prev:b]))
            prev = b
    else:
        rets = rets_of(c)
    arets = sorted(abs(r) for r in rets)
    # 单根振幅（高-低）/收 —— 对拍 game 的"单根振幅"
    rng = sorted((hi[i] - lo[i]) / c[i] for i in range(len(c)) if c[i] > 0)
    # 连续 3 根最大跌幅（NOTES 里用来衡量"突然拉到底"的指标）
    dd3 = []
    for i in range(3, len(c)):
        dd3.append((c[i - 3] - c[i]) / c[i - 3])
    dd3s = sorted(dd3)

    return {
        "n": len(rows),
        "from": ts[0], "to": ts[-1],
        "abs_med": pct(arets, 0.5) * 100,
        "abs_p90": pct(arets, 0.9) * 100,
        "abs_p99": pct(arets, 0.99) * 100,
        "abs_max": (arets[-1] if arets else float("nan")) * 100,
        "range_med": pct(rng, 0.5) * 100,
        "range_p90": pct(rng, 0.9) * 100,
        "dd3_med": pct(dd3s, 0.5) * 100,
        "dd3_p90": pct(dd3s, 0.9) * 100,
        "ac1": autocorr1(rets),
        "kurt": kurtosis(rets),
        "skew": skew(rets),
        "vc": vol_clustering(rets),
        "qvol_med": statistics.median(vol) if vol else 0.0,
        "qvol_mean": (sum(vol) / len(vol)) if vol else 0.0,
    }


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ─────────────────────────── 游戏模型 ───────────────────────────
def latest_game_files():
    """读 tools/export_game_series.js 导出的序列。

    ⚠ 不要在这里"复刻" game.js 的公式。我试过 —— 复刻版算出来单根 1.08%，
      而真代码是 0.19%，差 5 倍，因为复刻不出真实天气 sev 的分布。
      对拍必须用**真代码 + 真天气**：export_game_series.js 里 load 的就是
      web/js/game.js，调的是它导出的 Game._t.pickSeries。"""
    out = []
    for f in sorted(glob.glob(os.path.join(DATA, "_game_*_15m.json"))):
        try:
            out.append(load(f))
        except Exception:                                  # noqa: BLE001
            pass
    return out


def show_game(gfs, report=None):
    if not gfs:
        print("\n（没有 _game_*.json —— 先跑 node tools\\export_game_series.js）")
        return
    print("")
    print("=" * 108)
    print("游戏「点击做空天气」当前模型 —— 由真代码 game.js + 真天气跑出来（%d 个城市分层）"
          % len(gfs))
    print("=" * 108)
    print("  %-30s %7s %9s %8s %8s %8s %8s %7s %7s %6s"
          % ("城市分层", "权重", "|涨跌|中位", "p90", "p99", "max",
             "3根跌p90", "自相关", "峰度", "聚集"))
    for d in gfs:
        a = analyze_rows(d["rows"], d.get("bounds"))
        if not a:
            continue
        print("  %-30s %7.2f %8.4f%% %7.4f%% %7.4f%% %7.3f%% %7.3f%% %7.3f %7.1f %6.2f"
              % (d["desc"], d.get("cityWeight", 0), a["abs_med"], a["abs_p90"], a["abs_p99"],
                 a["abs_max"], a["dd3_p90"], a["ac1"], a["kurt"], a["vc"]))
        if report is not None:
            report["GAME/" + d["pair"]] = a
    print("")
    print("  权重与盘子的真实档位（用真 cities.json 算的）：")
    print("    3.0 → dishScale 0.533（4 个直辖市）｜ 2.2 → 只 3 城 ｜ "
          "1.6 → dishScale 1.000（305 城，含全部省会）｜ 0.6 → dishScale 2.600（40 区县）")
    print("    ⚠ 1.2 那一档（dishScale 1.333）**永远走不到**：cities.json 里每座城都有 path。")


def compare(gfs, files):
    """把游戏序列和真实币对并排 —— 这是这张表才是这次标定的结论。"""
    if not gfs or not files:
        return
    print("")
    print("=" * 108)
    print("对拍：真实交易所 vs 游戏模型（同一套指标，都是 15 分钟档）")
    print("=" * 108)
    okx = []
    for f in sorted(files):
        d = load(f)
        if d.get("bar") != "15m":
            continue
        a = analyze_rows(d["rows"], d.get("bounds"))
        if a:
            okx.append((d["pair"], a))
    # 按单根波动从大到小排，看清楚"大盘币 → 模因币"的阶梯
    okx.sort(key=lambda x: x[1]["abs_med"])
    print("  %-24s %9s %8s %8s %8s %7s %7s %6s"
          % ("标的", "|涨跌|中位", "p90", "p99", "3根跌p90", "自相关", "峰度", "聚集"))
    print("  " + "-" * 92)
    for p, a in okx:
        print("  %-24s %8.4f%% %7.4f%% %7.4f%% %7.3f%% %7.3f %7.1f %6.2f"
              % (p, a["abs_med"], a["abs_p90"], a["abs_p99"], a["dd3_p90"],
                 a["ac1"], a["kurt"], a["vc"]))
    print("  " + "-" * 92)
    for d in gfs:
        a = analyze_rows(d["rows"], d.get("bounds"))
        if not a:
            continue
        print("  %-24s %8.4f%% %7.4f%% %7.4f%% %7.3f%% %7.3f %7.1f %6.2f"
              % ("游戏/" + d["desc"].split(' ')[0], a["abs_med"], a["abs_p90"], a["abs_p99"],
                 a["dd3_p90"], a["ac1"], a["kurt"], a["vc"]))
    if okx:
        print("")
        print("  ── 关键比值 ──")
        real_lo, real_hi = okx[0][1], okx[-1][1]         # 最稳 / 最野 的真实币
        print("    真实「大盘币 → 模因币」单根波动放大倍数: %.2f×（%s %.4f%% → %s %.4f%%）"
              % (real_hi["abs_med"] / real_lo["abs_med"], okx[0][0], real_lo["abs_med"],
                 okx[-1][0], real_hi["abs_med"]))
        g_lo = min(gfs, key=lambda d: analyze_rows(d["rows"], d.get("bounds"))["abs_med"])
        g_hi = max(gfs, key=lambda d: analyze_rows(d["rows"], d.get("bounds"))["abs_med"])
        a_lo = analyze_rows(g_lo["rows"], g_lo.get("bounds"))
        a_hi = analyze_rows(g_hi["rows"], g_hi.get("bounds"))
        print("    游戏「大城市 → 小城市」单根波动放大倍数: %.2f×（%s %.4f%% → %s %.4f%%）"
              % (a_hi["abs_med"] / a_lo["abs_med"], g_lo["desc"], a_lo["abs_med"],
                 g_hi["desc"], a_hi["abs_med"]))
        print("    真实波动水平区间: %.4f%% ~ %.4f%%" % (real_lo["abs_med"], real_hi["abs_med"]))
        print("    游戏波动水平区间: %.4f%% ~ %.4f%%" % (a_lo["abs_med"], a_hi["abs_med"]))
        print("    真实自相关区间:   %.3f ~ %.3f" % (okx[0][1]["ac1"], okx[-1][1]["ac1"]))
        print("    游戏自相关区间:   %.3f ~ %.3f" % (a_lo["ac1"], a_hi["ac1"]))
        print("    真实峰度区间:     %.1f ~ %.1f" % (okx[0][1]["kurt"], okx[-1][1]["kurt"]))
        print("    游戏峰度区间:     %.1f ~ %.1f" % (a_lo["kurt"], a_hi["kurt"]))


# ─────────────────────────── 输出 ───────────────────────────
def show(files, do_game):
    groups = {}
    for f in sorted(files):
        d = load(f)
        groups.setdefault(d["bar"], []).append(d)

    report = {}
    for bar in sorted(groups, key=lambda b: BAR_MIN.get(b, 0)):
        ds = groups[bar]
        print("")
        print("=" * 108)
        print("周期 %s（%d 分钟）—— %d 个交易对" % (bar, BAR_MIN.get(bar, 0), len(ds)))
        print("=" * 108)
        print("  %-11s %7s %8s %8s %8s %8s %8s %8s %7s %7s %7s"
              % ("交易对", "根数", "|涨跌|中位", "p90", "p99", "max",
                 "振幅中位", "3根跌p90", "自相关", "峰度", "聚集"))
        rows = []
        for d in ds:
            a = analyze_rows(d["rows"], d.get("bounds"))
            if not a:
                continue
            rows.append((d["pair"], a))
            print("  %-11s %7d %7.4f%% %7.4f%% %7.4f%% %7.3f%% %7.3f%% %7.3f%% %7.3f %7.1f %7.2f"
                  % (d["pair"], a["n"], a["abs_med"], a["abs_p90"], a["abs_p99"], a["abs_max"],
                     a["range_med"], a["dd3_p90"], a["ac1"], a["kurt"], a["vc"]))
        report[bar] = {p: a for p, a in rows}

        if bar == "15m":
            print("")
            print("  ── 按流动性排序看趋势（上面到下面＝大盘币 → 模因币）──")
            for p, a in rows:
                bar_w = int(min(40, a["abs_med"] * 400))
                print("    %-11s %7.4f%%  %s" % (p, a["abs_med"], "█" * bar_w))

    # 波动标度：同一墙钟时间，粗/细周期之比
    if len(groups) > 1:
        print("")
        print("=" * 108)
        print("波动标度：粗周期 ÷ 细周期（布朗运动应为 √(周期比)）")
        print("=" * 108)
        base_bar = "1m" if "1m" in groups else sorted(groups, key=lambda b: BAR_MIN.get(b, 0))[0]
        base_map = {}
        for d in groups[base_bar]:
            a = analyze_rows(d["rows"], d.get("bounds"))
            if a:
                base_map[d["pair"]] = a["abs_med"]
        print("  %-11s %-8s %10s %10s %8s" % ("交易对", "周期", "实测比值", "√(周期比)", "偏差"))
        for bar in sorted(groups, key=lambda b: BAR_MIN.get(b, 0)):
            if bar == base_bar:
                continue
            ratio_want = math.sqrt(BAR_MIN[bar] / BAR_MIN[base_bar])
            for d in groups[bar]:
                a = analyze_rows(d["rows"], d.get("bounds"))
                if not a or d["pair"] not in base_map or base_map[d["pair"]] <= 0:
                    continue
                got = a["abs_med"] / base_map[d["pair"]]
                print("  %-11s %-8s %10.2f %10.2f %7.0f%%"
                      % (d["pair"], bar + "/" + base_bar, got, ratio_want,
                         (got / ratio_want - 1) * 100))

    if do_game:
        print("")
        print("=" * 108)
        print("游戏模型（复刻 game.js 当前系数）—— 同一套指标")
        print("=" * 108)
        print("  %-22s %8s %8s %8s %8s %8s %8s %7s %7s %7s"
              % ("配置", "根数", "|涨跌|中位", "p90", "p99", "max",
                 "3根跌p90", "自相关", "峰度", "聚集"))
        weights = [("直辖市 w=3.0 (BTC 类)", 3.0), ("省会 w=2.2", 2.2),
                   ("地级市 w=1.6 (ETH 类)", 1.6), ("区县 w=0.6 (模因币类)", 0.6)]
        for name, w in weights:
            c = game_series(city_weight=w)
            a = analyze_series(c)
            print("  %-22s %8d %7.4f%% %7.4f%% %7.4f%% %7.3f%% %7.3f%% %7.3f %7.1f %7.2f"
                  % (name, a["n"], a["abs_med"], a["abs_p90"], a["abs_p99"], a["abs_max"],
                     a["dd3_p90"], a["ac1"], a["kurt"], a["vc"]))

    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", action="store_true",
                    help="顺带读 tools/export_game_series.js 导出的真代码序列并对拍")
    ap.add_argument("--json", default="", help="把结果写成 JSON")
    ap.add_argument("--glob", default="*.json")
    a = ap.parse_args()

    files = [f for f in glob.glob(os.path.join(DATA, a.glob))
             if not os.path.basename(f).startswith("_")
             and not os.path.basename(f).startswith("weather_")]
    if not files:
        sys.exit("data/crypto/ 里没有行情数据。先跑 python tools\\fetch_crypto.py")
    print("真实行情样本 %d 个文件，来自 %s" % (len(files), DATA))
    report = show(files, False)

    if a.game:
        gfs = latest_game_files()
        show_game(gfs, report)
        compare(gfs, files)

    if a.json:
        def clean(o):
            if isinstance(o, float) and math.isnan(o):
                return None
            if isinstance(o, dict):
                return {k: clean(v) for k, v in o.items()}
            return o
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(clean(report), f, ensure_ascii=False, indent=1)
        print("\n已写出 %s" % a.json)


if __name__ == "__main__":
    main()
