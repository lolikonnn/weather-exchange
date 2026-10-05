# -*- coding: utf-8 -*-
"""第三轮探测：把 CORS 判对（大小写不敏感），并挖出 台风 / 云图 / 雷达 / 生活指数 的真实接口。"""
import gzip
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
ORIGIN = "https://lolikonnn.github.io"


def get(url, ref=None, origin=None, timeout=20):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    if ref:
        req.add_header("Referer", ref)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                b = gzip.decompress(b)
            acao = r.headers.get("Access-Control-Allow-Origin")   # Message: 大小写不敏感
            for enc in ("utf-8", "gbk", "gb18030"):
                try:
                    return r.status, acao, b.decode(enc)
                except UnicodeDecodeError:
                    continue
            return r.status, acao, b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Access-Control-Allow-Origin") if e.headers else None, ""
    except Exception as e:                                        # noqa: BLE001
        return 0, None, "%s: %s" % (type(e).__name__, e)


print("=" * 78)
print("A. CORS 复测（用 Message.get，大小写不敏感；带 Origin 头）")
print("=" * 78)
for label, url in [
    ("open-meteo forecast", "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m"),
    ("open-meteo archive", "https://archive-api.open-meteo.com/v1/archive?latitude=39.9&longitude=116.4&start_date=2026-10-01&end_date=2026-10-02&hourly=temperature_2m"),
    ("open-meteo air-quality", "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=31.23&longitude=121.47&current=pm2_5,us_aqi"),
    ("open-meteo geocoding", "https://geocoding-api.open-meteo.com/v1/search?name=Shanghai&count=1"),
    ("image.nmc.cn 云图", "https://image.nmc.cn/product/2026/10/05/STFC/medium/SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_20261005120002400.JPG"),
    ("nmc rest weather", "http://www.nmc.cn/rest/weather?stationid=WwcJd"),
    ("weather.cma.cn api", "https://weather.cma.cn/api/hourly/54511"),
    ("typhoon.nmc.cn 页", "http://typhoon.nmc.cn/web.html"),
]:
    st, acao, body = get(url, origin=ORIGIN)
    print("[%s] %-24s ACAO=%s  len=%s" % (st, label, acao, len(body)))

print()
print("=" * 78)
print("B. 台风：直接取它自己的 JS 看数据从哪来")
print("=" * 78)
for u in [
    "http://typhoon.nmc.cn/js/typhoon/typhoon-web.js?v=20250924",
    "http://typhoon.nmc.cn/js/typhoon/typhoon-datas-inner.js?v=20220610",
    "http://typhoon.nmc.cn/js/typhoon/gis.js?v=2026070317",
]:
    st, acao, js = get(u, ref="http://typhoon.nmc.cn/web.html")
    print("\n[%s] %s  len=%s" % (st, u, len(js)))
    if st != 200:
        continue
    for pat in [r'["\']([^"\']*\.(?:json|txt|csv))["\']',
                r'(?:url|ajax|get|post)\s*[:(]\s*["\']([^"\']{6,120})["\']',
                r'["\'](/[a-zA-Z0-9_/\-\.]{4,80})["\']']:
        hits = sorted({h for h in re.findall(pat, js) if not h.endswith(('.js', '.css', '.png', '.gif'))})
        hits = [h for h in hits if any(k in h.lower() for k in ('typhoon', 'data', 'rest', 'json', 'list', 'track', 'path', 'api'))]
        if hits:
            print("   %s -> %r" % (pat[:26], hits[:18]))

print()
print("=" * 78)
print("C. imagePlayer.js 怎么拿到图片列表")
print("=" * 78)
st, acao, js = get("https://image.nmc.cn/assets/js/imagePlayer.js?v=20220615", ref="http://www.nmc.cn/")
print("[%s] imagePlayer.js len=%s" % (st, len(js)))
if st == 200:
    for pat in [r'["\']([^"\']*\.(?:json|txt))["\']', r'(?:url|href)\s*[:=]\s*["\']([^"\']{4,140})["\']',
                r'\$\.(?:get|post|ajax)\s*\(\s*["\']([^"\']+)["\']']:
        hits = sorted(set(re.findall(pat, js)))
        if hits:
            print("   %s -> %r" % (pat[:28], hits[:14]))

print()
print("=" * 78)
print("D. 雷达页里那 44 张图（全国/华东 拼图，可当雷达回波用）")
print("=" * 78)
st, acao, html = get("http://www.nmc.cn/publish/radar/huadong.html")
imgs = sorted(set(re.findall(r'(https?://image\.nmc\.cn/product/[^"\'\s<>]+\.(?:PNG|JPG|png|jpg))', html)))
print("共 %d 张：" % len(imgs))
for i in imgs[:10]:
    print("   " + i)
print("   ...")
for i in imgs[-4:]:
    print("   " + i)

print()
print("=" * 78)
print("E. 生活指数：weather.cma.cn 的 403 是不是缺 Referer")
print("=" * 78)
for u in ["https://weather.cma.cn/api/life/54511", "https://weather.cma.cn/api/index/54511",
          "https://weather.cma.cn/api/live/54511", "https://weather.cma.cn/api/lifeIndex/54511"]:
    for ref in [None, "https://weather.cma.cn/"]:
        st, acao, body = get(u, ref=ref)
        print("[%s] ref=%-26s %s  %r" % (st, ref, u, body[:90]))

print()
print("=" * 78)
print("F. nmc /rest/weather 里到底有什么（看有没有生活指数）")
print("=" * 78)
st, acao, body = get("http://www.nmc.cn/rest/weather?stationid=WwcJd")
if st == 200:
    import json
    try:
        d = json.loads(body)
        def walk(o, p="", depth=0):
            if depth > 3:
                return
            if isinstance(o, dict):
                for k, v in list(o.items())[:40]:
                    if isinstance(v, (dict, list)):
                        print("   %s%s: %s" % ("  " * depth, k, type(v).__name__))
                        walk(v, p + "." + k, depth + 1)
                    else:
                        print("   %s%s = %r" % ("  " * depth, k, str(v)[:60]))
            elif isinstance(o, list):
                print("   %s[%d 项] 首项:" % ("  " * depth, len(o)))
                if o:
                    walk(o[0], p, depth + 1)
        walk(d.get("data", d))
    except Exception as e:                                        # noqa: BLE001
        print("   解析失败:", e)
