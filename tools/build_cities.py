# -*- coding: utf-8 -*-
"""
构建城市数据集: web/data/cities.json

对每个中国地级市, 合并三套 ID:
  1. 中国天气网城市代码 (101xxxxxx)      <- toy1.weather.com.cn/search
  2. 中国气象局观测站号 + 经纬度 + 归属  <- weather.cma.cn/api/autocomplete + /api/weather/view
  3. 经纬度兜底                          <- geocoding-api.open-meteo.com

站号选择策略: autocomplete 给出候选, 用 /api/weather/view 的 location.path
(形如 "中国, 河北, 唐山") 校验省份, 取第一个通过校验的候选。

用法:
  python build_cities.py            # 全量(约340城, 5~10分钟)
  python build_cities.py --limit 20 # 抽样测试
"""
import urllib.request, urllib.parse, gzip, json, sys, os, time, re, argparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(ROOT, "web", "data", "cities.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

SKIP_CITY_NAMES = {"市辖区", "县", "省直辖县级行政区划", "自治区直辖县级行政区划"}
PURE_ID = re.compile(r"^[0-9A-Z]{5}$")          # 纯 WMO 站号, 排除 54517_tj / 53698-sjz


def _fetch(url, ref=None, timeout=25):
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


def cached(url, ref=None, tag=""):
    os.makedirs(CACHE, exist_ok=True)
    key = re.sub(r"[^A-Za-z0-9]+", "_", tag or url)[:120]
    path = os.path.join(CACHE, key + ".bin")
    if os.path.exists(path):
        return open(path, "rb").read()
    b = _fetch(url, ref)
    open(path, "wb").write(b)
    return b


def prov_base(p):
    """'河北省' -> '河北';  '内蒙古自治区' -> '内蒙古'"""
    p = p or ""
    for suf in ("维吾尔自治区", "壮族自治区", "回族自治区", "特别行政区", "自治区", "省", "市"):
        if p.endswith(suf):
            return p[: -len(suf)]
    return p


# ---------------------------------------------------------------- 中国天气网代码

def cww_code(name, retries=2):
    for attempt in range(retries + 1):
        try:
            q = urllib.parse.quote(name)
            b = cached("http://toy1.weather.com.cn/search?cityname=%s" % q,
                       "http://www.weather.com.cn/", tag="cww_%s" % q)
            t = b.decode("utf-8", "replace").strip()
            if t.startswith("("):
                t = t[1:]
            if t.endswith(")"):
                t = t[:-1]
            if not t.strip():
                return None, None
            for it in json.loads(t):
                parts = it.get("ref", "").split("~")
                if len(parts) < 10:
                    continue
                code, pinyin, cn = parts[0], parts[1], parts[2]
                if cn != name:
                    continue
                if not re.fullmatch(r"\d{9}", code):
                    continue  # 排除景点(A后缀) / 区县(12位)
                return code, pinyin
            return None, None
        except Exception:
            time.sleep(0.8 * (attempt + 1))
    return None, None


# ---------------------------------------------------------------- 中国气象局

def cma_candidates(name, retries=2):
    """返回 [(id, cn_name), ...]，精确同名优先, 纯站号优先"""
    for attempt in range(retries + 1):
        try:
            q = urllib.parse.quote(name)
            b = cached("https://weather.cma.cn/api/autocomplete?q=%s" % q, tag="cma_%s" % q)
            items = json.loads(b.decode("utf-8")).get("data") or []
            exact, loose = [], []
            for it in items:
                p = it.split("|")
                if len(p) < 4 or p[3].strip() != "中国":
                    continue
                (exact if p[1].strip() == name else loose).append((p[0], p[1].strip()))
            return exact + loose
        except Exception:
            time.sleep(0.8 * (attempt + 1))
    return []


def cma_view(stationid, retries=2):
    for attempt in range(retries + 1):
        try:
            b = cached("https://weather.cma.cn/api/weather/view?stationid=%s" % stationid,
                       tag="view_%s" % stationid)
            return json.loads(b.decode("utf-8"))["data"]["location"]
        except Exception:
            time.sleep(0.6 * (attempt + 1))
    return None


def cma_resolve(name, prov, retries=1):
    """选出一个 location.path 的省份能对上的站号"""
    pb = prov_base(prov)
    cands = cma_candidates(name)
    cands.sort(key=lambda c: (0 if PURE_ID.match(c[0]) else 1))
    for cid, cn in cands[:8]:
        loc = cma_view(cid)
        if not loc:
            continue
        path = loc.get("path", "")
        segs = [s.strip() for s in path.split(",")]
        if pb and pb not in path:
            continue
        if loc.get("latitude") is None:
            continue
        return cid, loc.get("latitude"), loc.get("longitude"), path
    return None, None, None, None


# ---------------------------------------------------------------- 经纬度兜底

def geo_fallback(name, prov, retries=1):
    for attempt in range(retries + 1):
        try:
            q = urllib.parse.quote(name)
            b = cached("https://geocoding-api.open-meteo.com/v1/search?name=%s&count=100&language=zh&format=json" % q,
                       tag="geo_%s" % q)
            res = json.loads(b.decode("utf-8")).get("results") or []
            cn = [r for r in res if r.get("country_code") == "CN"] or res
            pb = prov_base(prov)
            for r in cn:
                if pb and pb in (r.get("admin1") or ""):
                    return r["latitude"], r["longitude"]
            return None, None
        except Exception:
            time.sleep(0.8 * (attempt + 1))
    return None, None


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args()

    if args.no_cache:
        import shutil
        shutil.rmtree(CACHE, ignore_errors=True)

    provinces = {p["code"]: p["name"]
                 for p in json.loads(cached(
                     "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/provinces.json",
                     tag="provinces.json").decode("utf-8"))}
    cities = json.loads(cached(
        "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/cities.json",
        tag="cities.json").decode("utf-8"))
    print("原始地级行政区: %d" % len(cities))

    seen, uniq = set(), []
    for c in cities:
        prov = provinces.get(c["provinceCode"], "")
        full = c["name"]
        name = prov if full in SKIP_CITY_NAMES else full
        name = re.sub(r"(市|地区|自治州|盟|特别行政区)$", "", name) or name
        if (name, prov) in seen:
            continue
        seen.add((name, prov))
        uniq.append({"name": name, "full": full, "prov": prov})
    print("去重后待处理: %d" % len(uniq))
    if args.limit:
        uniq = uniq[: args.limit]

    out = []
    for i, j in enumerate(uniq, 1):
        code, py = cww_code(j["name"])
        cid, lat, lon, path = cma_resolve(j["name"], j["prov"])
        if lat is None:
            lat, lon = geo_fallback(j["name"], j["prov"])
        rec = {
            "id": code or "",
            "name": j["name"],
            "prov": j["prov"],
            "py": py or "",
            "lat": round(lat, 4) if lat is not None else None,
            "lon": round(lon, 4) if lon is not None else None,
            "cma": cid or "",
            "path": path or "",
        }
        out.append(rec)
        print("[%3d/%3d] %-9s %-10s id=%-10s cma=%-7s %8.3f,%8.3f  %s" % (
            i, len(uniq), rec["name"], rec["prov"], rec["id"] or "-", rec["cma"] or "-",
            rec["lat"] or 0, rec["lon"] or 0, rec["path"]))
        time.sleep(0.12)

    okc = [r for r in out if r["cma"] and r["lat"]]
    oki = [r for r in out if r["id"]]
    print("\n有站号+坐标: %d/%d    有天气网代码: %d/%d" % (len(okc), len(out), len(oki), len(out)))

    hot = ["北京", "上海", "广州", "深圳", "杭州", "成都", "重庆", "武汉", "西安", "南京",
           "天津", "苏州", "长沙", "郑州", "青岛", "厦门", "昆明", "哈尔滨", "乌鲁木齐", "海口"]
    doc = {
        "updated": time.strftime("%Y-%m-%d"),
        "source": "中国天气网 weather.com.cn / 中国气象局 weather.cma.cn / Open-Meteo",
        "count": len(out),
        "hot": hot,
        "cities": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出:", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
