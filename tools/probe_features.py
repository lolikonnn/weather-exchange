# -*- coding: utf-8 -*-
"""探测「天气网站该有的功能」对应数据源是否可用。

只为一次性调研，不参与构建。全部走标准库 urllib（本机 PowerShell 5.1 默认 TLS1.0，
https 会失败，所以网络请求一律用 Python）。
"""
import gzip
import io
import json
import re
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
CWW_REF = "http://www.weather.com.cn/"


def get(url, ref=None, timeout=15, raw=False):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "*/*")
    if ref:
        req.add_header("Referer", ref)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                b = gzip.decompress(b)
            if raw:
                return r.status, dict(r.headers), b
            for enc in ("utf-8", "gbk", "gb18030"):
                try:
                    return r.status, dict(r.headers), b.decode(enc)
                except UnicodeDecodeError:
                    continue
            return r.status, dict(r.headers), b.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), ""
    except Exception as e:                                        # noqa: BLE001
        return 0, {}, "%s: %s" % (type(e).__name__, e)


def show(label, url, ref=None, pat=None, limit=260):
    st, hd, body = get(url, ref)
    acao = hd.get("Access-Control-Allow-Origin", "-")
    print("\n[%s] %s" % (st, label))
    print("    " + url)
    print("    ACAO=%s  len=%s" % (acao, len(body)))
    if pat:
        hits = re.findall(pat, body)[:6]
        print("    匹配 %s -> %r" % (pat, hits))
    if limit and body:
        print("    " + repr(body[:limit]))
    return st, body


print("=" * 78)
print("A. 空气质量（Open-Meteo air-quality，CORS 开放、无 key）")
print("=" * 78)
show("air-quality forecast 上海",
     "https://air-quality-api.open-meteo.com/v1/air-quality"
     "?latitude=31.23&longitude=121.47"
     "&hourly=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone,"
     "european_aqi,us_aqi&timezone=Asia%2FShanghai&forecast_days=3", limit=700)
show("air-quality 北京 PM2.5 单值",
     "https://air-quality-api.open-meteo.com/v1/air-quality"
     "?latitude=39.9&longitude=116.4&current=pm2_5,pm10,us_aqi&timezone=Asia%2FShanghai",
     limit=400)

print()
print("=" * 78)
print("B. Open-Meteo 主 API 是否给降水概率 / 风向 / 云量 / 紫外线")
print("=" * 78)
show("forecast 全变量",
     "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4"
     "&hourly=precipitation_probability,precipitation,rain,showers,snowfall,"
     "wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cloud_cover_low,"
     "cloud_cover_mid,cloud_cover_high,uv_index,visibility,dew_point_2m,apparent_temperature"
     "&wind_speed_unit=ms&timezone=Asia%2FShanghai&forecast_days=2", limit=420)

print()
print("=" * 78)
print("C. 中国气象局 nmc.cn —— 台风 / 卫星云图 / 雷达 接口探测")
print("=" * 78)
for label, url, ref in [
    ("nmc 首页", "http://www.nmc.cn/", None),
    ("台风页", "http://typhoon.nmc.cn/web.html", None),
    ("台风 rest list", "http://typhoon.nmc.cn/rest/typhoon/list", None),
    ("台风 rest 2024", "http://typhoon.nmc.cn/rest/typhoon?year=2024", None),
    ("nmc rest typhoon", "http://www.nmc.cn/rest/typhoon/list", None),
    ("nmc 卫星页", "http://www.nmc.cn/publish/satellite/fy4b.htm", None),
    ("nmc rest satellite", "http://www.nmc.cn/rest/satellite/list", None),
    ("nmc 雷达页", "http://www.nmc.cn/publish/radar/huadong.html", None),
    ("nmc rest radar", "http://www.nmc.cn/rest/radar/list", None),
    ("nmc 生活指数", "http://www.nmc.cn/rest/weather?stationid=WwcJd", None),
]:
    st, body = show(label, url, ref, limit=200)
    if st == 200 and len(body) > 500:
        # 从页面里挖图片 / 接口线索
        imgs = re.findall(r'(?:src|href|url)\s*[=:]\s*["\']?(https?://[^"\'\s>]+\.(?:png|jpg|jpeg|gif))', body, re.I)[:6]
        apis = re.findall(r'["\'](/rest/[a-zA-Z0-9_/\-\.]+)["\']', body)[:10]
        if imgs:
            print("    图片线索: %r" % imgs)
        if apis:
            print("    接口线索: %r" % sorted(set(apis)))

print()
print("=" * 78)
print("D. weather.cma.cn 是否有 台风 / 卫星 / 生活指数 / 空气质量 接口")
print("=" * 78)
for label, url in [
    ("cma 首页", "https://weather.cma.cn/"),
    ("cma 台风", "https://weather.cma.cn/api/typhoon/list"),
    ("cma 卫星", "https://weather.cma.cn/api/satellite/list"),
    ("cma 生活指数", "https://weather.cma.cn/api/indices/54511"),
    ("cma 空气质量", "https://weather.cma.cn/api/aqi/54511"),
    ("cma 雷达", "https://weather.cma.cn/api/radar/list"),
    ("cma 预警", "https://weather.cma.cn/api/alarm/54511"),
    ("cma hourly(含云量)", "https://weather.cma.cn/api/hourly/54511"),
]:
    show(label, url, limit=230)

print()
print("=" * 78)
print("E. 中国天气网 d1 域：生活指数 / 空气质量趋势")
print("=" * 78)
for label, url in [
    ("li 生活指数", "http://d1.weather.com.cn/li/101010100.html"),
    ("index 生活指数", "http://d1.weather.com.cn/index/101010100.html"),
    ("aqi 空气", "http://d1.weather.com.cn/aqi/101010100.html"),
    ("air 空气", "http://d1.weather.com.cn/air/101010100.html"),
    ("weather_index", "http://d1.weather.com.cn/weather_index/101010100.html"),
]:
    show(label, url, CWW_REF, limit=300)
