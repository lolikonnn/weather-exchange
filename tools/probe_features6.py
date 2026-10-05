# -*- coding: utf-8 -*-
"""第六轮：把 typhoon-web.js 里所有含 json 的字符串字面量全挖出来；JMA 作为备选。"""
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
            return r.status, acao, b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get("Access-Control-Allow-Origin") if e.headers else None), ""
    except Exception as e:                                        # noqa: BLE001
        return 0, None, "%s: %s" % (type(e).__name__, e)


print("=" * 78)
print("A. typhoon-web.js 中所有含 'json' 的字符串字面量（含上下文）")
print("=" * 78)
st, acao, js = get("http://typhoon.nmc.cn/js/typhoon/typhoon-web.js?v=20250924",
                   ref="http://typhoon.nmc.cn/web.html")
print("[%s] len=%s" % (st, len(js)))
if st == 200:
    lits = sorted(set(re.findall(r'["\']([^"\']*json[^"\']*)["\']', js, re.I)))
    for l in lits[:40]:
        print("   %r" % l)
    print("   ---- 每个字面量前后 150 字符 ----")
    for l in lits[:8]:
        i = js.find('"' + l + '"')
        if i < 0:
            i = js.find("'" + l + "'")
        if i >= 0:
            print("   >> %r" % l)
            print("      %r" % js[max(0, i - 150):i + len(l) + 60])

print()
print("=" * 78)
print("B. typhoon-datas-inner.js 全文（只有 7.5KB，直接看）")
print("=" * 78)
st, acao, js2 = get("http://typhoon.nmc.cn/js/typhoon/typhoon-datas-inner.js?v=20220610",
                    ref="http://typhoon.nmc.cn/web.html")
print("[%s] len=%s" % (st, len(js2)))
print(repr(js2[:1500]))

print()
print("=" * 78)
print("C. 顺着挖到的 path 再试，以及 typhoon 目录枚举")
print("=" * 78)
for u in ["http://typhoon.nmc.cn/typhoon/jsons/maxYear",
          "http://typhoon.nmc.cn/typhoon/jsons/maxYear.json",
          "http://typhoon.nmc.cn/typhoon/jsons/tip",
          "http://typhoon.nmc.cn/typhoon/jsons/forecastOrgs",
          "http://typhoon.nmc.cn/typhoon/jsons/list_2024",
          "http://typhoon.nmc.cn/typhoon/jsons/list_default",
          "http://typhoon.nmc.cn/typhoon/jsons/",
          "http://typhoon.nmc.cn/typhoon/",
          ]:
    st, acao, body = get(u, ref="http://typhoon.nmc.cn/web.html")
    print("[%s] len=%-8s %s   %r" % (st, len(body), u, body[:80]))

print()
print("=" * 78)
print("D. JMA（日本气象厅）公开台风 API 作为备选")
print("=" * 78)
for u in ["https://www.jma.go.jp/bosai/typhoon/data/targetTc.json",
          "https://www.jma.go.jp/bosai/typhoon/data/targetTcSpec.json",
          "https://www.jma.go.jp/bosai/typhoon/data/trouble.json"]:
    st, acao, body = get(u, origin=ORIGIN)
    print("[%s] ACAO=%s len=%-8s %s" % (st, acao, len(body), u))
    if st == 200:
        print("     " + repr(body[:260]))

print()
print("=" * 78)
print("E. 雷达图是否还有更小的档（small/ 之类）")
print("=" * 78)
for sub in ["", "medium/", "small/", "thumb/", "large/"]:
    u = ("https://image.nmc.cn/product/2026/10/05/RDCP/%s"
         "SEVP_AOC_RDCP_SLDAS3_ECREF_ACHN_L88_PI_20261005114200000.PNG" % sub)
    st, acao, body = get(u, origin=ORIGIN)
    print("[%s] %-9s len=%-9s" % (st, sub or "(原图)", len(body)))
