"""把 echarts 的世界底图瘦身成"亚洲-太平洋"区域，给台风页做海陆背景。

原图 1.0 MB / 217 个国家，台风只可能出现在西北太平洋，
所以按包围盒裁掉美洲、非洲、欧洲大部，坐标降到 2 位小数，
输出 web/data/world.json。
"""
import json
import os
import urllib.request

SRC = "https://cdn.jsdelivr.net/npm/echarts@4.9.0/map/json/world.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tmp", "world-raw.json")
OUT = os.path.join(ROOT, "web", "data", "world.json")

# 台风活动范围 + 一点余量：东经 55~205、南纬 25~北纬 65
LON0, LON1, LAT0, LAT1 = 55.0, 205.0, -25.0, 65.0


def bbox(geom):
    """返回几何体的经纬度包围盒，顺便兼容 Polygon / MultiPolygon"""
    xs, ys = [], []
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def round_geom(geom):
    """坐标降到 2 位小数，并丢掉点数不足的环"""
    def r(ring):
        out = [[round(p[0], 2), round(p[1], 2)] for p in ring]
        # 去掉连续重复点
        ded = [out[0]] if out else []
        for p in out[1:]:
            if p != ded[-1]:
                ded.append(p)
        return ded

    if geom["type"] == "MultiPolygon":
        polys = []
        for poly in geom["coordinates"]:
            rings = [q for q in (r(ring) for ring in poly) if len(q) >= 5]
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None

    rings = [q for q in (r(ring) for ring in geom["coordinates"]) if len(q) >= 5]
    return {"type": "Polygon", "coordinates": rings} if rings else None


def main():
    if os.path.isfile(CACHE):
        raw = open(CACHE, "rb").read()
        print("用缓存 %s (%d B)" % (CACHE, len(raw)))
    else:
        print("下载 %s" % SRC)
        req = urllib.request.Request(SRC, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        open(CACHE, "wb").write(raw)
        print("  拿到 %d B" % len(raw))

    src = json.loads(raw.decode("utf-8"))
    print("原始 features = %d" % len(src["features"]))

    feats, dropped, kept = [], [], []
    for f in src["features"]:
        name = (f.get("properties") or {}).get("name") or "?"
        b = bbox(f["geometry"])
        if not b:
            dropped.append(name + "(空)")
            continue
        x0, y0, x1, y1 = b
        # 包围盒与目标窗口无交集就整块丢掉
        if x1 < LON0 or x0 > LON1 or y1 < LAT0 or y0 > LAT1:
            dropped.append(name)
            continue
        g = round_geom(f["geometry"])
        if not g:
            dropped.append(name + "(太碎)")
            continue
        feats.append({"type": "Feature", "properties": {"name": name}, "geometry": g})
        kept.append(name)

    out = {"type": "FeatureCollection", "features": feats}
    txt = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "w", encoding="utf-8").write(txt)

    print()
    print("保留 %d 个：%s" % (len(kept), "、".join(kept)))
    print("丢弃 %d 个" % len(dropped))
    print()
    print("输出 %s" % OUT)
    print("  %d B → %d B  (%.1f%%)" % (len(raw), len(txt.encode("utf-8")),
                                       100.0 * len(txt.encode("utf-8")) / len(raw)))


if __name__ == "__main__":
    main()
