# -*- coding: utf-8 -*-
"""
补 web/data/cities.json 的 py (城市拼音) 字段。

build_cities.py 取的是 toy1 结果里的 parts[1], 那是**省份拼音**, 不是城市拼音
(正确的字段是 parts[3], 例如 杭州 -> "Hangzhou")。本脚本按 101 代码逐城重取并修正。

用法: python fix_pinyin.py
"""
import urllib.request, urllib.parse, json, sys, os, time, re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "data", "cities.json")
CACHE = os.path.join(HERE, ".cache2")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")


def toy1(name, tries=3):
    key = os.path.join(CACHE, "py_" + re.sub(r"[^A-Za-z0-9]+", "_", name)[:80] + ".json")
    if os.path.exists(key):
        try:
            return json.loads(open(key, encoding="utf-8").read())
        except Exception:
            pass
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(
                "http://toy1.weather.com.cn/search?cityname=" + urllib.parse.quote(name),
                headers={"User-Agent": UA, "Referer": "http://www.weather.com.cn/"}), timeout=20)
            t = r.read().decode("utf-8", "replace").strip()
            if t[:1] == "(":
                t = t[1:]
            if t[-1:] == ")":
                t = t[:-1]
            items = json.loads(t)
            os.makedirs(CACHE, exist_ok=True)
            open(key, "w", encoding="utf-8").write(json.dumps(items, ensure_ascii=False))
            return items
        except Exception:
            time.sleep(1.2 * (2 ** i))
    return []


def main():
    doc = json.loads(open(OUT, encoding="utf-8").read())
    cs = doc["cities"]
    fixed = 0
    todo = [c for c in cs if c.get("id")]
    print("待修正拼音 %d 城" % len(todo))
    for i, c in enumerate(todo, 1):
        items = toy1(c["name"])
        py = ""
        for it in items:
            p = (it.get("ref") or "").split("~")
            if len(p) >= 4 and p[0] == c["id"] and p[3].strip():
                py = p[3].strip().lower()
                break
        if py and py != c.get("py"):
            c["py"] = py
            fixed += 1
        if i % 40 == 0 or i == len(todo):
            print("  [%3d/%3d] %-10s py=%s" % (i, len(todo), c["name"], c.get("py") or "-"))
        time.sleep(0.32)
    print("\n修正 %d 条" % fixed)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出:", OUT, os.path.getsize(OUT), "bytes")
    for nm in ("北京", "杭州", "石家庄", "重庆", "乌鲁木齐", "鄂尔多斯"):
        m = [x for x in cs if x["name"] == nm]
        if m:
            print("  样例 %-8s -> %s" % (nm, m[0].get("py")))


if __name__ == "__main__":
    main()
