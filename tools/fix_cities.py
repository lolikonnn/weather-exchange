# -*- coding: utf-8 -*-
"""
修补 web/data/cities.json 的空洞。

build_cities.py 的首轮全量构建受 toy1.weather.com.cn 限流影响,
43 个城市没拿到中国天气网 101 代码(深圳/苏州/贵阳/衡水/宜昌...),
23 个没拿到经纬度, 34 个没拿到气象局站号。

本脚本用三条独立路径补齐:
  1. toy1 重试 (带退避, 失败不写缓存)
  2. 官方省市索引 www.weather.com.cn/data/city3jdata/
       china.html          -> {"10101":"北京", ...}          省级前缀
       provshi/101{pp}.html -> {"01":"长春","03":"延边", ...} 省内城市
     代码规则: 101 + 省(2) + 省内序号(2) + "01"
     已用 衡水->101090801 与 宜昌->101200901 双向验证通过。
  3. 气象局 autocomplete 变体 + Open-Meteo geocoding 变体补经纬度

用法:
  python fix_cities.py --dry    # 只报告, 不写文件
  python fix_cities.py
"""
import urllib.request, urllib.parse, gzip, json, sys, os, time, re, argparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "data", "cities.json")
CACHE = os.path.join(HERE, ".cache2")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
PURE_ID = re.compile(r"^[0-9A-Z]{5}$")
PROV_NAME = re.compile(r"(省|自治区|特别行政区)$")


def fetch(url, ref=None, timeout=25):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if ref:
        h["Referer"] = ref
    r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)
    b = r.read()
    if r.headers.get("Content-Encoding") == "gzip":
        try:
            b = gzip.decompress(b)
        except Exception:
            pass
    return b


def cache_path(tag):
    os.makedirs(CACHE, exist_ok=True)
    return os.path.join(CACHE, re.sub(r"[^A-Za-z0-9]+", "_", tag)[:120] + ".json")


def cached_json(url, tag, ref=None, ttl=86400, tries=4):
    """成功才落盘; 失败/非 JSON 一律重试并退避。"""
    p = cache_path(tag)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < ttl:
        try:
            return json.loads(open(p, encoding="utf-8").read())
        except Exception:
            pass
    last = None
    for i in range(tries):
        try:
            t = fetch(url, ref).decode("utf-8", "replace").strip()
            if t[:1] == "(":
                t = t[1:]
            if t[-1:] == ")":
                t = t[:-1]
            v = json.loads(t)
            open(p, "w", encoding="utf-8").write(json.dumps(v, ensure_ascii=False))
            return v
        except Exception as e:
            last = e
            time.sleep(1.5 * (2 ** i))
    print("      ! 放弃 %s (%s)" % (tag, last))
    return None


def prov_base(p):
    p = p or ""
    for suf in ("维吾尔自治区", "壮族自治区", "回族自治区", "特别行政区", "自治区", "省", "市"):
        if p.endswith(suf):
            return p[: -len(suf)]
    return p


# ------------------------------------------------------------------ 1) 省市索引
def build_index():
    """-> (pp_by_prov, cities_by_prov)  cities_by_prov[prov] = {key: name}"""
    china = cached_json("http://www.weather.com.cn/data/city3jdata/china.html",
                        "cww_china", "http://www.weather.com.cn/")
    if not china:
        return {}, {}
    # china = {"10101":"北京", ...}  ->  pp = "01"
    pp_by_prov = {}
    for k, v in china.items():
        if re.fullmatch(r"101\d\d", k):
            pp_by_prov[prov_base(v)] = k[3:]
    print("省市索引: %d 个省" % len(pp_by_prov))
    cities_by_prov = {}
    for prov, pp in pp_by_prov.items():
        d = cached_json("http://www.weather.com.cn/data/city3jdata/provshi/101%s.html" % pp,
                        "cww_ps_%s" % pp, "http://www.weather.com.cn/")
        if isinstance(d, dict) and d:
            cities_by_prov[prov] = d
            print("  %-6s pp=%s  城市 %d 个" % (prov, pp, len(d)))
        time.sleep(0.35)
    return pp_by_prov, cities_by_prov


def code_from_index(name, prov, pp_by_prov, cities_by_prov):
    pb = prov_base(prov)
    pp = pp_by_prov.get(pb)
    if not pp or pb not in cities_by_prov:
        return None, None
    best = None
    for key, cname in cities_by_prov[pb].items():
        cname = str(cname).strip()
        if not cname:
            continue
        if cname == name or name.startswith(cname) or cname.startswith(name):
            if best is None or len(cname) > len(best[1]):
                best = (key, cname)
    if not best:
        return None, None
    key = str(best[0]).zfill(2)
    if not re.fullmatch(r"\d{2}", key):
        return None, None
    return "101%s%s01" % (pp, key), best[1]


# ------------------------------------------------------------------ 2) toy1 重试
def toy1(name, tries=4):
    for i in range(tries):
        try:
            q = urllib.parse.quote(name)
            t = fetch("http://toy1.weather.com.cn/search?cityname=%s" % q,
                      "http://www.weather.com.cn/", timeout=20).decode("utf-8", "replace").strip()
            if t[:1] == "(":
                t = t[1:]
            if t[-1:] == ")":
                t = t[:-1]
            items = json.loads(t)
            for it in items:
                p = it.get("ref", "").split("~")
                if len(p) < 10:
                    continue
                if p[2] != name:
                    continue
                if re.fullmatch(r"\d{9}", p[0]):
                    return p[0], p[1]
            return None, None
        except Exception:
            time.sleep(1.5 * (2 ** i))
    return None, None


# ------------------------------------------------------------------ 3) 经纬度/站号
def cma_try(name, prov, variants, tries=2):
    pb = prov_base(prov)
    seen = set()
    for v in variants:
        for i in range(tries):
            try:
                b = fetch("https://weather.cma.cn/api/autocomplete?q=%s" % urllib.parse.quote(v),
                          timeout=20)
                items = json.loads(b.decode("utf-8")).get("data") or []
                break
            except Exception:
                items = []
                time.sleep(1.2 * (2 ** i))
        cands = []
        for it in items:
            p = it.split("|")
            if len(p) < 4 or p[3].strip() != "中国" or p[0] in seen:
                continue
            cands.append((p[0], p[1].strip()))
        cands.sort(key=lambda c: (0 if c[1] == name else 1, 0 if PURE_ID.match(c[0]) else 1))
        for cid, cn in cands[:6]:
            seen.add(cid)
            try:
                d = json.loads(fetch("https://weather.cma.cn/api/weather/view?stationid=%s" % cid,
                                     timeout=20).decode("utf-8"))
                loc = d["data"]["location"]
            except Exception:
                continue
            path = loc.get("path") or ""
            if pb and pb not in path:
                continue
            if loc.get("latitude") is None or loc.get("longitude") is None:
                continue
            return cid, loc["latitude"], loc["longitude"], path
        time.sleep(0.2)
    return None, None, None, None


def geo_try(name, prov, variants):
    pb = prov_base(prov)
    for v in variants:
        try:
            b = fetch("https://geocoding-api.open-meteo.com/v1/search?name=%s&count=100&language=zh&format=json"
                      % urllib.parse.quote(v), timeout=20)
            res = json.loads(b.decode("utf-8")).get("results") or []
        except Exception:
            time.sleep(0.8)
            continue
        cn = [r for r in res if r.get("country_code") == "CN"] or res
        hit = [r for r in cn if pb and pb in (r.get("admin1") or "")]
        for r in (hit or cn):
            if r.get("latitude") is not None:
                return r["latitude"], r["longitude"]
        time.sleep(0.15)
    return None, None


def variants_of(name, prov, full=None):
    v = [name]
    if full and full != name:
        v.append(full)
    v += [name + "市", name + "地区", name + "自治州", name + "盟", name + "自治县"]
    if prov_base(prov) not in v:
        v.append(prov_base(prov))
    out, seen = [], set()
    for x in v:
        x = (x or "").strip()
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--only-id", action="store_true", help="只补 101 代码")
    args = ap.parse_args()

    doc = json.loads(open(OUT, encoding="utf-8").read())
    cs = doc["cities"]
    print("载入 %d 城" % len(cs))

    # 丢掉省一级的占位记录 (名字就是省名的)
    junk = [c for c in cs if PROV_NAME.search(c["name"]) or c["name"] == prov_base(c["prov"])]
    if junk:
        print("剔除省级占位 %d 条: %s" % (len(junk), [c["name"] for c in junk]))
        cs = [c for c in cs if c not in junk]

    pp_by_prov, cities_by_prov = build_index()

    need_id = [c for c in cs if not c.get("id")]
    need_geo = [c for c in cs if c.get("lat") is None]
    need_cma = [c for c in cs if not c.get("cma")]
    print("\n待补 101代码 %d / 坐标 %d / 站号 %d" % (len(need_id), len(need_geo), len(need_cma)))

    # --- 101 代码
    print("\n=== 补中国天气网代码 ===")
    for c in need_id:
        code, py = toy1(c["name"])
        via = "toy1"
        if not code:
            code, matched = code_from_index(c["name"], c["prov"], pp_by_prov, cities_by_prov)
            via = "索引(%s)" % matched if code else "失败"
            if code:
                py = c.get("py") or ""
        if code:
            c["id"] = code
            if py and not c.get("py"):
                c["py"] = py
        print("  %-16s %-8s -> %-10s %s" % (c["name"], c["prov"], c["id"] or "-", via))
        time.sleep(0.55)

    if not args.only_id:
        # --- 站号
        print("\n=== 补气象局站号 ===")
        for c in [x for x in cs if not x.get("cma")]:
            vs = variants_of(c["name"], c["prov"])
            cid, lat, lon, path = cma_try(c["name"], c["prov"], vs)
            if cid:
                c["cma"], c["path"] = cid, path or ""
                if c.get("lat") is None and lat is not None:
                    c["lat"], c["lon"] = round(lat, 4), round(lon, 4)
            print("  %-16s %-8s -> %-8s %s" % (c["name"], c["prov"], c["cma"] or "-", path or ""))
            time.sleep(0.4)

        # --- 坐标
        print("\n=== 补经纬度 ===")
        for c in [x for x in cs if x.get("lat") is None]:
            vs = variants_of(c["name"], c["prov"])
            lat, lon = geo_try(c["name"], c["prov"], vs)
            if lat is not None and lat != 0:
                c["lat"], c["lon"] = round(lat, 4), round(lon, 4)
            print("  %-16s %-8s -> %s" % (c["name"], c["prov"],
                  ("%.3f,%.3f" % (c["lat"], c["lon"])) if c.get("lat") is not None else "失败"))
            time.sleep(0.3)

    bad = [c for c in cs if c.get("lat") is None and not c.get("id")]
    if bad:
        cs = [c for c in cs if c not in bad]

    doc["cities"] = cs
    doc["count"] = len(cs)
    hot = doc.get("hot") or []
    doc["hot"] = [h for h in hot if any(c["name"] == h for c in cs)]

    n_id = sum(1 for c in cs if c.get("id"))
    n_cma = sum(1 for c in cs if c.get("cma"))
    n_geo = sum(1 for c in cs if c.get("lat") is not None)
    n_all = sum(1 for c in cs if c.get("id") and c.get("cma") and c.get("lat") is not None)
    print("\n结果: %d 城 | 有101代码 %d | 有站号 %d | 有坐标 %d | 三者齐全 %d | 剔除 %d"
          % (len(cs), n_id, n_cma, n_geo, n_all, len(bad) + len(junk)))

    if args.dry:
        print("(dry run, 未写文件)")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出:", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
