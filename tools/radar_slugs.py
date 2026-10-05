# -*- coding: utf-8 -*-
"""探测中央气象台的「单站雷达」页面，生成 web/data/radar-cities.json。

背景
----
中国气象局公开的雷达图有三层：
  * 全国拼图      /publish/radar/chinaall.html   -> RDCP/..._ACHN_...
  * 八个大区拼图  /publish/radar/{dongbei,huabei,huadong,huanan,huazhong,xibei,xinan}.html
                  -> RDCP/..._{ANEC,ANCN,AECN,ASCN,ACCN,ANWC,ASWC}_...
  * 单站雷达      /publish/radar/{省拼音}/{市拼音}.htm  -> RDCP/..._AZ####_...

第三层就是「精确到城市」的那一层。它**没有任何入口页**：chinaall.html 里
只链了全国 + 八个大区 + 北京大兴一个样例，其它城市页只能靠拼 slug 猜。
所以这个脚本干的事就是：拿 pypinyin 把 cities.json 里的城市拼成 slug，
逐个 HEAD/GET 试探，命中的写进 web/data/radar-cities.json 供前端用。

slug 规律（实测）
----------------
    广东省 + 广州  -> guang-dong/guang-zhou
    黑龙江省 + 哈尔滨 -> hei-long-jiang/ha-er-bin
    新疆维吾尔自治区 + 乌鲁木齐 -> xin-jiang/wu-lu-mu-qi
即：去掉「省/市/自治区/…」等后缀后**按字逐个拼音、用 - 连接**，全小写。
直辖市用「市名/市名」（tian-jin/tian-jin、chong-qing/chong-qing）。
个别城市两个拼音不同（西安 xi-an vs xian），所以候选里带上不带连字符的版本。

用法
----
    python tools/radar_slugs.py            # 探测并写 web/data/radar-cities.json
    python tools/radar_slugs.py --dry      # 只打印，不写文件
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CITIES = os.path.join(ROOT, "web", "data", "cities.json")
OUT = os.path.join(ROOT, "web", "data", "radar-cities.json")

BASE = "http://www.nmc.cn/publish/radar/"
UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"),
    "Referer": "http://www.nmc.cn/publish/radar/chinaall.html",
}

# 行政后缀，反复剥到不再变化（「新疆维吾尔自治区」-> 「新疆」）
SUF = re.compile(r"(省|市|自治区|特别行政区|回族|维吾尔|壮族|蒙古族|藏族|自治州|地区)$")

# 站名与城市名对不上的特例。
# 北京没有「bei-jing/bei-jing.htm」，它挂在郊区雷达站「大兴」下面。
SPECIAL = {
    "北京": "bei-jing/da-xing",
}

try:
    from pypinyin import lazy_pinyin
except ImportError:  # pragma: no cover
    sys.exit("需要 pypinyin：E:\\python\\python.exe -m pip install pypinyin")


def slug(name):
    """中文地名 -> NMC 用的拼音 slug（按字连字符）。"""
    n = name
    for _ in range(3):
        n2 = SUF.sub("", n)
        if n2 == n:
            break
        n = n2
    return "-".join(lazy_pinyin(n)).lower()


def hit(url, tries=2):
    """返回 (页面字节数, 站号列表)；页面存在但没有产品时返回 (len, [])。"""
    for k in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20)
            t = r.read().decode("utf-8", "ignore")
            az = sorted(set(re.findall(r"RDCP/[^\"']*?ECREF_([A-Z0-9]{4,8})_", t)))
            return len(t), az
        except Exception:
            if k + 1 < tries:
                time.sleep(1.0)
    return 0, []


def one(c):
    ps = slug(c["prov"])
    cs = slug(c["name"])
    # 特例优先；再试「省/市」，最后试去掉连字符的写法（西安 xi-an / xian）
    cands = []
    if c["name"] in SPECIAL:
        cands.append(tuple(SPECIAL[c["name"]].split("/", 1)))
    cands.append((ps, cs))
    if "-" in cs:
        cands.append((ps, cs.replace("-", "")))
    for a, b in cands:
        u = BASE + a + "/" + b + ".htm"
        ln, az = hit(u)
        if az:
            return {"id": c["id"], "name": c["name"], "prov": c["prov"],
                    "slug": a + "/" + b, "az": az[0],
                    "url": "https://image.nmc.cn/product/{Y}/{m}/{d}/RDCP/"
                           "{tier}SEVP_AOC_RDCP_SLDAS3_ECREF_" + az[0] + "_L88_PI_{ts}00000.PNG",
                    "page": u}
        time.sleep(0.15)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="只打印，不写文件")
    ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args()

    with open(CITIES, encoding="utf-8") as f:
        cities = json.load(f)["cities"]

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        rows = list(ex.map(one, cities))

    ok = [r for r in rows if r]
    miss = [c for c, r in zip(cities, rows) if not r]
    print("探测 %d 城：命中单站雷达 %d，无单站 %d" % (len(cities), len(ok), len(miss)))
    for r in ok:
        print("  ✓ %-10s %-8s %-28s %s" % (r["name"], r["prov"], r["slug"], r["az"]))
    if miss:
        print("  无单站（回落到所在大区）：" + " ".join(c["name"] for c in miss))

    if a.dry:
        return
    data = {
        "source": "中国气象局 · nmc.cn 单站雷达",
        "note": "只有这些城市有独立雷达站；其余城市请回落到所在大区的拼图。",
        "count": len(ok),
        "stations": {r["id"]: {"slug": r["slug"], "az": r["az"], "name": r["name"],
                               "prov": r["prov"]} for r in ok},
    }
    old = None
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            old = f.read()
    new = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    if old == new:
        print("radar-cities.json 无变化")
        return
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(new)
    print("已写 %s（%d 城）" % (os.path.relpath(OUT, ROOT), len(ok)))


if __name__ == "__main__":
    main()
