# -*- coding: utf-8 -*-
"""第五轮：台风数据源定案 + 雷达缩略图体积。"""
import gzip
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
print("A. typhoon-web.js 里这些 jsons 路径是怎么拼出来的")
print("=" * 78)
st, acao, js = get("http://typhoon.nmc.cn/js/typhoon/typhoon-web.js?v=20250924",
                   ref="http://typhoon.nmc.cn/web.html")
if st == 200:
    for m in re.finditer(r'.{170}jsons/(?:list_|view_|maxYear|forecastOrgs|tip).{90}', js):
        print("   ..." + m.group(0).replace("\n", " ") + "\n")
    # 找 base/root 变量
    for pat in [r'(?:var|let|const)\s+(\w*(?:base|root|host|url|domain)\w*)\s*=\s*["\']([^"\']{4,120})["\']',
                r'["\'](https?://[a-z0-9\.\-]*nmc\.cn[a-zA-Z0-9_/\-\.]*)["\']']:
        hits = re.findall(pat, js)
        if hits:
            print("   %s -> %r" % (pat[:34], hits[:12]))

print()
print("=" * 78)
print("B. 台风接口的各种拼法")
print("=" * 78)
cands = [
    "http://typhoon.nmc.cn/typhoon/jsons/list_2026.json",
    "http://typhoon.nmc.cn/typhoon/jsons/list_2026",
    "http://typhoon.nmc.cn/jsons/list_2026",
    "http://typhoon.nmc.cn/jsons/list_default",
    "http://typhoon.nmc.cn/data/typhoon/jsons/list_2026",
    "https://typhoon.nmc.cn/typhoon/jsons/list_2026",
    "http://www.nmc.cn/typhoon/jsons/list_2026",
    "http://typhoon.nmc.cn/typhoon/json/list_2026",
    "http://typhoon.nmc.cn/api/typhoon/list_2026",
    "http://typhoon.nmc.cn/rest/typhoon/list_2026",
]
for u in cands:
    st, acao, body = get(u, ref="http://typhoon.nmc.cn/web.html")
    flag = "OK " if st == 200 and len(body) > 2 else "   "
    print("%s[%s] len=%-8s %s" % (flag, st, len(body), u))
    if st == 200 and len(body) > 2:
        print("        " + repr(body[:300]))

print()
print("=" * 78)
print("C. weather.cma.cn/api/typhoon 带 Referer 再试；以及别的 cma 路径")
print("=" * 78)
for u in ["https://weather.cma.cn/api/typhoon",
          "https://weather.cma.cn/api/typhoon/list",
          "https://weather.cma.cn/api/typhoon/2026",
          "https://weather.cma.cn/api/map/typhoon",
          "https://weather.cma.cn/api/typhoonTrack"]:
    for ref in [None, "https://weather.cma.cn/"]:
        st, acao, body = get(u, ref=ref, origin=ORIGIN)
        if st == 200 or st == 403:
            print("[%s] ref=%s %s  %r" % (st, ref, u, body[:120]))

print()
print("=" * 78)
print("D. 雷达图：全国/华东，原图 vs medium，体积对比")
print("=" * 78)
for reg, sub in [("ACHN", ""), ("ACHN", "medium/"), ("AECN", ""), ("AECN", "medium/")]:
    u = ("https://image.nmc.cn/product/2026/10/05/RDCP/%s"
         "SEVP_AOC_RDCP_SLDAS3_ECREF_%s_L88_PI_20261005114200000.PNG" % (sub, reg))
    st, acao, body = get(u, origin=ORIGIN)
    print("[%s] %-7s %-8s len=%-9s ACAO=%s" % (st, reg, sub or "(原图)", len(body), acao))

print()
print("=" * 78)
print("E. 卫星云图产品：换后缀 / 换产品码试试")
print("=" * 78)
for prod, name in [("STFC", "SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_%s.JPG"),
                   ("STFC", "SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_%s.PNG"),
                   ("STFC", "SEVP_NMC_STFC_SFER_ER03_ACHN_L88_P9_%s.JPG")]:
    for ts in ["20261005120002400", "20261005120000000"]:
        u = "https://image.nmc.cn/product/2026/10/05/%s/medium/%s" % (prod, name % ts)
        st, acao, body = get(u, origin=ORIGIN)
        print("[%s] len=%-8s %s" % (st, len(body), u.split("/medium/")[-1]))
