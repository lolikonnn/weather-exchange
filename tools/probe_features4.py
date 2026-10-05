# -*- coding: utf-8 -*-
"""第四轮：确认 台风接口 / 中国底图 / 卫星云图产品名 / 雷达图页 CORS。"""
import gzip
import json
import re
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
ORIGIN = "https://lolikonnn.github.io"


def get(url, ref=None, origin=None, timeout=25):
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
            acao = r.headers.get("Access-Control-Allow-Origin")
            for enc in ("utf-8", "gbk", "gb18030"):
                try:
                    return r.status, acao, b.decode(enc)
                except UnicodeDecodeError:
                    continue
            return r.status, acao, b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get("Access-Control-Allow-Origin") if e.headers else None), ""
    except Exception as e:                                        # noqa: BLE001
        return 0, None, "%s: %s" % (type(e).__name__, e)


print("=" * 78)
print("A. 台风接口（从 typhoon-web.js 里挖出来的路径）")
print("=" * 78)
for u in [
    "http://typhoon.nmc.cn/typhoon/jsons/maxYear",
    "http://typhoon.nmc.cn/typhoon/jsons/list_default",
    "http://typhoon.nmc.cn/typhoon/jsons/list_2026",
    "http://typhoon.nmc.cn/typhoon/jsons/list_2025",
    "http://typhoon.nmc.cn/typhoon/jsons/forecastOrgs",
    "http://typhoon.nmc.cn/typhoon/jsons/tip",
]:
    st, acao, body = get(u, ref="http://typhoon.nmc.cn/web.html", origin=ORIGIN)
    print("\n[%s] ACAO=%s len=%s  %s" % (st, acao, len(body), u))
    print("    " + repr(body[:400]))

print()
print("=" * 78)
print("B. 中国底图 GeoJSON（ECharts map 用）")
print("=" * 78)
for u in [
    "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json",
    "https://geo.datav.aliyun.com/areas_v3/bound/100000.json",
]:
    st, acao, body = get(u, origin=ORIGIN)
    print("[%s] ACAO=%s len=%s  %s" % (st, acao, len(body), u))
    if st == 200:
        try:
            d = json.loads(body)
            feats = d.get("features", [])
            print("    type=%s features=%d" % (d.get("type"), len(feats)))
            if feats:
                p0 = feats[0]
                print("    首要素 properties=%r" % (list(p0.get("properties", {}).items())[:5],))
                geom = p0.get("geometry", {})
                print("    geometry.type=%s" % geom.get("type"))
        except Exception as e:                                    # noqa: BLE001
            print("    解析失败:", e)

print()
print("=" * 78)
print("C. 卫星云图：STFC 产品在不同时间的可达性（能否靠时间戳拼 URL）")
print("=" * 78)
for ts in ["20261005120002400", "20261005110002400", "20261005200002400",
           "20261005000002400", "20261005203002400"]:
    u = ("https://image.nmc.cn/product/2026/10/05/STFC/medium/"
         "SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_%s.JPG" % ts)
    st, acao, body = get(u, origin=ORIGIN)
    print("[%s] ACAO=%s len=%s  ts=%s" % (st, acao, len(body), ts))

print()
print("=" * 78)
print("D. 雷达图页能否被浏览器直接 fetch（拿到 20 帧图片列表）")
print("=" * 78)
for u in ["http://www.nmc.cn/publish/radar/huadong.html",
          "http://www.nmc.cn/publish/radar/china.html",
          "http://www.nmc.cn/publish/satellite/fy4b.htm"]:
    st, acao, body = get(u, origin=ORIGIN)
    imgs = sorted(set(re.findall(r'(https?://image\.nmc\.cn/product/[^"\'\s<>]+\.(?:PNG|JPG|png|jpg))', body)))
    print("[%s] ACAO=%s len=%s 图片 %d 张  %s" % (st, acao, len(body), len(imgs), u))
    for i in imgs[:2]:
        print("      " + i)
    if len(imgs) > 2:
        print("      ... 末帧 " + imgs[-1])

print()
print("=" * 78)
print("E. 雷达产品区域码探测（ACHN 全国 / AECN 华东 / 其他大区）")
print("=" * 78)
base = ("https://image.nmc.cn/product/2026/10/05/RDCP/"
        "SEVP_AOC_RDCP_SLDAS3_ECREF_%s_L88_PI_20261005114200000.PNG")
for reg in ["ACHN", "AECN", "ABCX", "ACCX", "AHBX", "AXBX", "ASWX", "ANBX", "AXJX", "ASNX"]:
    st, acao, body = get(base % reg, origin=ORIGIN)
    print("[%s] len=%-8s %s" % (st, len(body), reg))
