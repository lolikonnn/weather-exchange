# -*- coding: utf-8 -*-
"""第七轮（最终）：验证 /weatherservice 前缀下的台风与灾害天气接口。"""
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
BASE = "http://typhoon.nmc.cn/weatherservice"


def get(url, ref="http://typhoon.nmc.cn/web.html", origin=ORIGIN, timeout=25):
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
            return r.status, r.headers.get("Access-Control-Allow-Origin"), b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.headers.get("Access-Control-Allow-Origin") if e.headers else None), ""
    except Exception as e:                                        # noqa: BLE001
        return 0, None, "%s: %s" % (type(e).__name__, e)


print("=" * 78)
print("A. /weatherservice 下的台风接口")
print("=" * 78)
tid = None
for p in ["/typhoon/jsons/maxYear", "/typhoon/jsons/list_default", "/typhoon/jsons/list_2026",
          "/typhoon/jsons/list_2025", "/typhoon/jsons/forecastOrgs", "/typhoon/jsons/tip"]:
    st, acao, body = get(BASE + p)
    flag = "OK " if st == 200 and len(body) > 2 else "   "
    print("%s[%s] ACAO=%-4s len=%-8s %s" % (flag, st, acao, len(body), p))
    if st == 200 and len(body) > 2:
        print("       " + repr(body[:330]))
        if "list_" in p and not tid:
            try:
                d = json.loads(body)
                if isinstance(d, list) and d:
                    tid = d[-1].get("id") or d[-1].get("typhoonid")
                    print("       -> 取一个 id 试 view_: %r" % tid)
            except Exception:                                     # noqa: BLE001
                pass

print()
print("=" * 78)
print("B. view_{id} 详细路径（用 list 里拿到的 id）")
print("=" * 78)
for cand in ([tid] if tid else []) + ["2026", "2629", "202529"]:
    if not cand:
        continue
    st, acao, body = get("%s/typhoon/jsons/view_%s" % (BASE, cand))
    print("[%s] ACAO=%-4s len=%-8s view_%s" % (st, acao, len(body), cand))
    if st == 200 and len(body) > 2:
        print("       " + repr(body[:600]))
        break

print()
print("=" * 78)
print("C. 灾害天气 / 实况 图层接口")
print("=" * 78)
for p in ["/diamond14/rainfall/24.json", "/diamond14/disastrous/windAndTemperature.json",
          "/diamond14/fog/json", "/diamond14/haze/json", "/diamond1/view/json",
          "/fetch_json/warning/json"]:
    st, acao, body = get(BASE + p)
    print("[%s] ACAO=%-4s len=%-8s %s" % (st, acao, len(body), p))
    if st == 200 and len(body) > 2:
        print("       " + repr(body[:220]))

print()
print("=" * 78)
print("D. JMA 台风详情（备选源，确认结构）")
print("=" * 78)
st, acao, body = get("https://www.jma.go.jp/bosai/typhoon/data/targetTc.json",
                     ref=None, origin=ORIGIN)
print("[%s] ACAO=%s len=%s" % (st, acao, len(body)))
print("   " + repr(body[:400]))
try:
    arr = json.loads(body)
    tc = arr[0]["tropicalCyclone"]
    for suffix in ["spec", "forecast", "track"]:
        u = "https://www.jma.go.jp/bosai/typhoon/data/%s/%s.json" % (tc, suffix)
        st2, acao2, b2 = get(u, ref=None, origin=ORIGIN)
        print("   [%s] ACAO=%-4s len=%-8s %s" % (st2, acao2, len(b2), u))
        if st2 == 200 and len(b2) > 4:
            print("        " + repr(b2[:300]))
except Exception as e:                                            # noqa: BLE001
    print("   解析失败:", e)
