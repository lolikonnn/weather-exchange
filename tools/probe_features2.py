# -*- coding: utf-8 -*-
"""第二轮探测：卫星云图 / 雷达回波 / 台风路径 / 生活指数 的真实接口。

方法：抓页面 -> 提取它加载的 JS -> 从 JS 里正则挖出接口路径与图片 URL 模板。
"""
import gzip
import io
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CWW_REF = "http://www.weather.com.cn/"


def get(url, ref=None, origin=None, timeout=18):
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
            for enc in ("utf-8", "gbk", "gb18030"):
                try:
                    return r.status, dict(r.headers), b.decode(enc)
                except UnicodeDecodeError:
                    continue
            return r.status, dict(r.headers), b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), ""
    except Exception as e:                                    # noqa: BLE001
        return 0, {}, "%s: %s" % (type(e).__name__, e)


print("=" * 78)
print("A. CORS 真相：带上 Origin 头再看 ACAO（不带 Origin 服务器通常就不发这个头）")
print("=" * 78)
for label, url in [
    ("open-meteo forecast", "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m"),
    ("open-meteo archive", "https://archive-api.open-meteo.com/v1/archive?latitude=39.9&longitude=116.4&start_date=2026-10-01&end_date=2026-10-02&hourly=temperature_2m"),
    ("open-meteo air-quality", "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=31.23&longitude=121.47&current=pm2_5,us_aqi"),
    ("open-meteo geocoding", "https://geocoding-api.open-meteo.com/v1/search?name=Shanghai&count=1"),
    ("image.nmc.cn 云图", "https://image.nmc.cn/product/2026/10/05/STFC/medium/SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_20261005120002400.JPG"),
]:
    st, hd, body = get(url, origin="https://lolikonnn.github.io")
    print("[%s] %-24s ACAO=%s  len=%s" % (st, label, hd.get("Access-Control-Allow-Origin", "-"), len(body)))

print()
print("=" * 78)
print("B. 从页面 JS 里挖接口路径")
print("=" * 78)


def mine(label, page_url, base):
    st, hd, html = get(page_url)
    print("\n--- %s   [%s] len=%s" % (label, st, len(html)))
    if st != 200:
        return
    scripts = re.findall(r'<script[^>]+src\s*=\s*["\']([^"\']+)["\']', html, re.I)
    inline = re.findall(r'<(?:script|div)[^>]*>.*?</(?:script|div)>', html, re.I)
    # 页面内联文本里的线索
    paths = set(re.findall(r'["\'](/rest/[a-zA-Z0-9_/\-\.{}]+)["\']', html))
    paths |= set(re.findall(r'["\'](/api/[a-zA-Z0-9_/\-\.{}]+)["\']', html))
    if paths:
        print("  页面内联接口: %r" % sorted(paths))
    imgs = set(re.findall(r'(https?://[^"\'\s<>]+\.(?:png|jpg|jpeg|gif|JPG|PNG))', html))
    if imgs:
        print("  页面内联图片 (%d): %r" % (len(imgs), sorted(imgs)[:5]))
    print("  外部脚本 (%d): %r" % (len(scripts), scripts[:12]))
    found = set()
    for s in scripts[:14]:
        u = urllib.parse.urljoin(base, s)
        st2, _, js = get(u, ref=page_url)
        if st2 != 200 or len(js) < 40:
            continue
        for m in re.findall(r'["\'](/rest/[a-zA-Z0-9_/\-\.]+)["\']', js):
            found.add(m)
        for m in re.findall(r'["\'](/api/[a-zA-Z0-9_/\-\.]+)["\']', js):
            found.add(m)
        for m in re.findall(r'(https?://image\.nmc\.cn/[a-zA-Z0-9_/\-\.%{}]+)', js):
            found.add(m)
        for m in re.findall(r'["\']([a-zA-Z0-9_/\-\.]*product[a-zA-Z0-9_/\-\.]*)["\']', js):
            found.add("product:" + m)
    print("  JS 挖出的线索 (%d):" % len(found))
    for f in sorted(found)[:40]:
        print("     " + f)


mine("nmc 卫星云图页", "http://www.nmc.cn/publish/satellite/fy4b.htm", "http://www.nmc.cn/")
mine("nmc 雷达页", "http://www.nmc.cn/publish/radar/huadong.html", "http://www.nmc.cn/")
mine("nmc 台风页", "http://typhoon.nmc.cn/web.html", "http://typhoon.nmc.cn/")

print()
print("=" * 78)
print("C. 直接猜台风接口")
print("=" * 78)
for u in [
    "http://typhoon.nmc.cn/rest/typhoonList",
    "http://typhoon.nmc.cn/rest/list",
    "http://typhoon.nmc.cn/rest/getTyphoonList",
    "http://typhoon.nmc.cn/rest/typhoon/list?year=2026",
    "http://typhoon.nmc.cn/data/typhoonList.json",
    "http://typhoon.nmc.cn/data/typhoon.json",
    "http://typhoon.nmc.cn/data/list.json",
    "http://www.nmc.cn/rest/typhoon/list?year=2026",
    "http://www.nmc.cn/rest/findTyphoon",
    "https://weather.cma.cn/api/typhoon",
]:
    st, hd, body = get(u, ref="http://typhoon.nmc.cn/web.html")
    print("[%s] %-56s len=%s %r" % (st, u, len(body), body[:110]))

print()
print("=" * 78)
print("D. 生活指数")
print("=" * 78)
for u in [
    "http://www.nmc.cn/rest/liveIndex?stationid=WwcJd",
    "http://www.nmc.cn/rest/lifeIndex?stationid=WwcJd",
    "http://www.nmc.cn/rest/index?stationid=WwcJd",
    "http://www.nmc.cn/rest/weatherIndex?stationid=WwcJd",
    "http://d1.weather.com.cn/dingzhi/101010100.html",
    "http://www.weather.com.cn/weather_index/101010100.html",
    "https://weather.cma.cn/api/life/54511",
    "https://weather.cma.cn/api/index/54511",
]:
    st, hd, body = get(u, ref=CWW_REF)
    print("[%s] %-52s len=%s %r" % (st, u, len(body), body[:110]))
