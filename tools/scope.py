# -*- coding: utf-8 -*-
"""
城市范围裁剪 —— 只保留用户关心的城市。

范围（由用户 2026-10-05 指定）：
  ① 广东省珠三角 9 市
  ② 湖南 长株潭 + 娄底
  ③ 全国省会 / 直辖市 / 特别行政区 / 台北

被裁掉的城市不会从数据源消失 —— 官方省市索引随时可以把它们重新拉回来，
只是不写进 web/data/cities.json，让前端列表保持精简。
"""
from __future__ import annotations

try:
    from cn_names import core
except ImportError:                                    # 被当作包导入时
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from cn_names import core

# ① 广东珠三角
PRD = ["广州", "深圳", "珠海", "佛山", "惠州", "东莞", "中山", "江门", "肇庆"]

# ② 湖南长株潭 + 娄底
HUNAN = ["长沙", "株洲", "湘潭", "娄底"]

# ③ 省会 / 直辖市 / 特别行政区 / 台北
CAPITALS = [
    "北京", "天津", "上海", "重庆",
    "石家庄", "太原", "呼和浩特", "沈阳", "长春", "哈尔滨",
    "南京", "杭州", "合肥", "福州", "南昌", "济南", "郑州", "武汉", "长沙", "广州",
    "南宁", "海口", "成都", "贵阳", "昆明", "拉萨", "西安", "兰州", "西宁", "银川", "乌鲁木齐",
    "香港", "澳门", "台北",
]

# 列表顺序 = 前端展示顺序
ALL = PRD + HUNAN + CAPITALS
KEEP = set(core(x) for x in ALL)

# 热门（自选默认值 / 指数条），必须落在 KEEP 内
HOT = [
    "广州", "深圳", "北京", "上海", "长沙", "珠海",
    "佛山", "东莞", "中山", "杭州", "成都", "武汉",
    "南京", "西安", "重庆", "天津", "株洲", "湘潭", "娄底",
    "肇庆", "江门", "惠州",
]

_ORDER = {}
for _i, _n in enumerate(ALL):
    _ORDER.setdefault(core(_n), _i)   # 先出现的位置优先（广州/长沙在两处都出现，取珠三角/长株潭那一次）


def keep(name: str) -> bool:
    return core(name) in KEEP


def order_of(name: str) -> int:
    return _ORDER.get(core(name), 999)


def apply(doc: dict) -> dict:
    """就地裁剪 doc（cities.json 的解析结果），返回同一个 dict"""
    cs = [c for c in doc.get("cities", []) if keep(c.get("name", ""))]
    cs.sort(key=lambda c: (order_of(c["name"]), c["name"]))
    doc["cities"] = cs
    doc["count"] = len(cs)
    names = set(c["name"] for c in cs)
    doc["hot"] = [h for h in HOT if h in names]
    if len(doc["hot"]) < 10:                            # 兜底：HOT 里有缺失就补
        for c in cs:
            if c["name"] not in doc["hot"]:
                doc["hot"].append(c["name"])
            if len(doc["hot"]) >= 16:
                break
    return doc
