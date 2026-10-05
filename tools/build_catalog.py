# -*- coding: utf-8 -*-
"""把前端城市目录恢复成全量 352 城，同时给预抓任务留一份受控范围。

背景：`tools/scope_cities.py` 曾把 cities.json 从 352 城裁到 45 城（珠三角+长株潭娄底+省会），
原始版本备份为 cities.full.json。但裁剪后的副作用是**搜索框只能搜到那 45 个城市**，
用户在搜索栏里查别的城市一律查不到。

现在改成：
  * cities.json  = 全量 352 城（前端搜索/全部城市抽屉用）
  * hot          = 保留原来那 22 个热门城市（热门面板不变）
  * prefetch     = 保留原来那 45 个城市的 id（GitHub Actions 预抓官方数据的范围不变，避免仓库暴涨）
预抓范围单独列一份，是为了让「搜索能搜到 352 城」和「每 30 分钟只抓 45 城官方数据」两件事解耦。
"""
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "web", "data")
CUR = os.path.join(DATA, "cities.json")
FULL = os.path.join(DATA, "cities.full.json")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    cur = load(CUR)
    if os.path.exists(FULL):
        full = load(FULL)
        cities = full["cities"]
        src = "cities.full.json"
    else:
        cities = cur["cities"]
        src = "cities.json"

    if len(cities) < 100:
        print("✗ 全量目录只有 %d 城，看起来不是全量版本，中止" % len(cities))
        return 1

    hot = list(cur.get("hot") or [])
    prefetch = [c["id"] for c in cur["cities"] if c.get("id")]

    # 按省份聚合，省份之间用一个固定的常规顺序，省内的保持原顺序
    order = ["北京市", "天津市", "河北省", "山西省", "内蒙古自治区", "辽宁省", "吉林省",
             "黑龙江省", "上海市", "江苏省", "浙江省", "安徽省", "福建省", "江西省",
             "山东省", "河南省", "湖北省", "湖南省", "广东省", "广西壮族自治区", "海南省",
             "重庆市", "四川省", "贵州省", "云南省", "西藏自治区", "陕西省", "甘肃省",
             "青海省", "宁夏回族自治区", "新疆维吾尔自治区", "香港特别行政区",
             "澳门特别行政区", "台湾省"]
    rank = {p: i for i, p in enumerate(order)}
    cities.sort(key=lambda c: (rank.get(c.get("prov") or "", 999), c.get("id") or ""))

    cities = [c for c in cities if c.get("id")]
    names = {c["name"] for c in cities}
    hot = [h for h in hot if h in names]
    have = {c["id"] for c in cities}
    prefetch = [i for i in prefetch if i in have]

    doc = {
        "updated": cur.get("updated"),
        "source": cur.get("source"),
        "count": len(cities),
        "hot": hot,
        "prefetch": prefetch,
        "cities": cities,
    }
    b = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(CUR, "wb") as f:
        f.write(b)
    print("来源: %s" % src)
    print("已写出: %s" % CUR)
    print("  城市数: %d  热门: %d  预抓: %d  文件: %d bytes" % (len(cities), len(hot), len(prefetch), len(b)))
    print("  有气象局站号: %d  有坐标: %d" % (
        sum(1 for c in cities if c.get("cma")),
        sum(1 for c in cities if c.get("lat") is not None)))

    if os.path.exists(FULL):
        os.remove(FULL)
        print("已删除冗余备份: %s" % FULL)
    return 0


if __name__ == "__main__":
    sys.exit(main())
