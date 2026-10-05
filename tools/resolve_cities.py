# -*- coding: utf-8 -*-
"""以"名称必须对得上"为硬约束，重建 web/data/cities.json 的坐标与气象局站号。

背景（为什么需要这个脚本）：
  build_cities.py / fix_cities.py 判定气象局站号时只校验了**省份**在 location.path 里，
  于是"长治"被安上了山西随便一个站、"葫芦岛"被安上辽阳站、"肇庆"被安上广州站……
  实测 weather.cma.cn/api/autocomplete 对中文地级市名的索引极弱
  （长治/晋中/吕梁/山南/抚州/黔南/迪庆/海西 全部查不到，返回的是同名异地的外国城市），
  而 Open-Meteo geocoding 对中文短名同样糟糕（长治只返回广东/黑龙江同名村）。
  正确做法：名字核心词必须一致，拼音查询做补充，最后才用手工校对表兜底。

本脚本四层策略（前一层成功即不再往下）：
  1. 校验既有 cma：GET /api/weather/view -> path 末段核心词 == 城市核心词 且 省份相符，
     通过则用 station 的 lat/lon（最准），不通过则**清空**该 cma（宁可没有，也不能张冠李戴）。
  2. 重查 cma：autocomplete(城市名/驻地市名) -> 候选名核心词一致 + 中国 -> view -> 再校验。
  3. 补坐标：Open-Meteo geocoding（中文名 → 驻地市名 → 拼音），要求 admin1 命中省份
     且返回地名核心词一致。
  4. 兜底：COORD_FALLBACK 手工校对的地级市驻地坐标（注明理由）。

用法:
  python resolve_cities.py --dry         # 只体检+报告，不写文件
  python resolve_cities.py --audit-only  # 只做第 1 步校验
"""
import urllib.request, urllib.parse, gzip, json, sys, os, time, re, argparse, hashlib
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cn_names import core, same_place, prov_base, prov_in, path_last, path_prov  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "data", "cities.json")
CACHE = os.path.join(HERE, ".cache3")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
PURE_ID = re.compile(r"^[0-9A-Za-z_]{5,14}$")

# ---------------------------------------------- 第 0 层：中国天气网官方省市索引
# 代码规则: 101 + 省(2位) + 省内序号(2位) + 01，例如 10106 + 01 + 01 = 101060101(长春)
CWW_IDX = "http://www.weather.com.cn/data/city3jdata"
CWW_REF = "http://www.weather.com.cn/"
NAME9 = re.compile(r"^\d{9}$")
NAME_OK = re.compile(r"^[\u4e00-\u9fa5]{2,10}$")
SKIP_CITY_NAMES = {"市辖区", "县", "省直辖县级行政区划", "自治区直辖县级行政区划", "其他"}
PROV_LONG = {
    "北京": "北京市", "上海": "上海市", "天津": "天津市", "重庆": "重庆市",
    "河北": "河北省", "山西": "山西省", "内蒙古": "内蒙古自治区", "辽宁": "辽宁省",
    "吉林": "吉林省", "黑龙江": "黑龙江省", "江苏": "江苏省", "浙江": "浙江省",
    "安徽": "安徽省", "福建": "福建省", "江西": "江西省", "山东": "山东省",
    "河南": "河南省", "湖北": "湖北省", "湖南": "湖南省", "广东": "广东省",
    "广西": "广西壮族自治区", "海南": "海南省", "四川": "四川省", "贵州": "贵州省",
    "云南": "云南省", "西藏": "西藏自治区", "陕西": "陕西省", "甘肃": "甘肃省",
    "青海": "青海省", "宁夏": "宁夏回族自治区", "新疆": "新疆维吾尔自治区",
    "台湾": "台湾省", "香港": "香港特别行政区", "澳门": "澳门特别行政区",
}


def cww_index():
    """抓中国天气网省市索引，返回 {101代码: (城市名, 省全称)}。

    这是唯一能**完整枚举**中国天气网城市代码的途径（toy1 搜索会限流且索引不全）。
    """
    def page(rel):
        def go():
            return fetch(CWW_IDX + rel, ref=CWW_REF)
        return cget("idx" + rel.replace("/", "_"), go)

    provs = json.loads(page("/china.html"))
    out = {}
    bad = []
    for p5, pname in provs.items():
        if not re.fullmatch(r"\d{5}", str(p5)):
            continue
        try:
            sub = json.loads(page("/provshi/%s.html" % p5))
        except Exception as e:  # noqa: BLE001
            bad.append("%s(%s): %s" % (p5, pname, e))
            continue
        plong = PROV_LONG.get(pname, pname)
        for nn, cname in (sub or {}).items():
            # 直辖市(省=市) 在 provshi 里只有一条 nn='00'，其真实代码是 p5+'01'+'00'
            # 例如 10101(北京) -> 101010100；而普通省份是 p5+nn+'01'，如 10106+01=101060101(长春)
            if nn == "00":
                code = "%s01%s" % (p5, "00")
            else:
                code = "%s%s01" % (p5, nn)
            cname = (cname or "").strip()
            if NAME9.fullmatch(code) and NAME_OK.match(cname) and cname not in SKIP_CITY_NAMES:
                out[code] = (cname, plong)
    if bad:
        print("  ! 省级索引失败 %d 个: %s" % (len(bad), "; ".join(bad)))
    return out


def sync_index(cs):
    """把官方索引里 cities.json 还没有的城市补进来（修掉"直辖市被误当省级占位删掉"的问题）。"""
    # 一次性清理：早期 cww_index 把直辖市的 nn='00' 直接拼成 p5+'00'+'01'，
    # 生成了 101010001/101020001/101030001/101040001 这 4 个不存在的代码。
    BAD_MUNI = {"101010001", "101020001", "101030001", "101040001"}
    nbad = sum(1 for c in cs if c.get("id") in BAD_MUNI)
    if nbad:
        cs = [c for c in cs if c.get("id") not in BAD_MUNI]
        print("  清理直辖市错误代码 %d 条" % nbad)

    # 历史遗留的截断名（"博尔塔拉蒙古" 等）对齐到官方索引里的短名，否则去重认不出是同一个地方
    nrn = 0
    for c in cs:
        new = RENAME.get(c["name"])
        if new:
            c["name"] = new
            nrn += 1
    if nrn:
        print("  规范化城市名 %d 条" % nrn)

    idx = cww_index()
    have = set(c.get("id") for c in cs)
    print("中国天气网官方索引: %d 城" % len(idx))

    # 给历史遗留的"没有 101 代码"的记录按名字补代码（同省内核心词一致即认）
    by_name = {}
    for code, (name, plong) in idx.items():
        by_name.setdefault((core(name), plong), code)
    fixed = 0
    for c in cs:
        if c.get("id"):
            continue
        k = (core(c["name"]), c.get("prov"))
        if k in by_name:
            c["id"] = by_name[k]
            have.add(c["id"])
            fixed += 1
    if fixed:
        print("  为 %d 条无代码记录补上 101 代码" % fixed)

    add = []
    for code, (name, plong) in sorted(idx.items()):
        if code in have:
            continue
        add.append({"id": code, "name": name, "prov": plong, "py": "",
                    "lat": None, "lon": None, "cma": "", "path": ""})
    extra = sorted(x for x in have if x)
    extra = [x for x in extra if x not in idx and NAME9.fullmatch(x)]
    if add:
        print("  补回缺失城市 %d 个: %s" % (len(add), "、".join(c["name"] for c in add[:40])))
    if extra:
        print("  索引外的既有代码 %d 个（保留）" % len(extra))

    # 去重：历史遗留记录与索引补回来的记录会撞车（同名同省，但 prov 长短写法可能不同），
    # 保留信息最全的一条并合并字段。
    merged, order = {}, []
    for c in cs + add:
        k = (core(c["name"]), c.get("prov") or "")
        if k not in merged:
            merged[k] = dict(c)
            order.append(k)
            continue
        a = merged[k]
        for f in ("id", "cma", "path", "py"):
            if not a.get(f) and c.get(f):
                a[f] = c[f]
        if a.get("lat") is None and c.get("lat") is not None:
            a["lat"], a["lon"] = c["lat"], c["lon"]
    out = [merged[k] for k in order]
    dropped = len(cs) + len(add) - len(out)
    if dropped:
        print("  合并重复城市 %d 条" % dropped)
    return out

# ---------------------------------------------------------------- 手工校对层
# 自治州/盟/地区 的驻地在气象局与 Open-Meteo 里的名字；用驻地查比用州名可靠得多
SEAT = {
    # 直辖市的对外站名是"区"名（气象局 autocomplete 对"上海"/"重庆"两个词完全无结果）
    "上海": "徐家汇", "重庆": "沙坪坝",
    "延边": "延吉", "黔东南": "凯里", "黔南": "都匀", "黔西南": "兴义",
    "凉山": "西昌", "阿坝": "马尔康", "甘孜": "康定", "恩施": "恩施",
    "湘西": "吉首", "恩施土家族苗族": "恩施", "博尔塔拉": "博乐",
    "巴音郭楞": "库尔勒", "克孜勒苏": "阿图什", "伊犁": "伊宁",
    "大理": "大理", "德宏": "芒市", "怒江": "泸水", "迪庆": "香格里拉",
    "楚雄": "楚雄", "红河": "蒙自", "文山": "文山", "西双版纳": "景洪",
    "甘南": "合作", "临夏": "临夏", "海北": "海晏", "黄南": "同仁",
    "海南": "共和", "果洛": "玛沁", "海西": "德令哈", "海东": "乐都",
    "兴安": "乌兰浩特", "阿拉善": "巴彦浩特", "锡林郭勒": "锡林浩特",
    "呼伦贝尔": "海拉尔", "巴彦淖尔": "临河", "乌兰察布": "集宁",
    "黔东南苗族侗族": "凯里", "黔南布依族苗族": "都匀", "黔西南布依族苗族": "兴义",
    "凉山彝族": "西昌", "阿坝藏族羌族": "马尔康", "甘孜藏族": "康定",
    "湘西土家族苗族": "吉首", "延边朝鲜族": "延吉", "海北藏族": "海晏",
    "黄南藏族": "同仁", "海南藏族": "共和", "果洛藏族": "玛沁",
    "海西蒙古族藏族": "德令哈", "博尔塔拉蒙古": "博乐", "巴音郭楞蒙古": "库尔勒",
    "克孜勒苏柯尔克孜": "阿图什", "伊犁哈萨克": "伊宁", "迪庆藏族": "香格里拉",
    "德宏傣族景颇族": "芒市", "怒江傈僳族": "泸水", "红河哈尼族彝族": "蒙自",
    "文山壮族苗族": "文山", "西双版纳傣族": "景洪", "楚雄彝族": "楚雄",
    "大理白族": "大理", "临夏回族": "临夏", "甘南藏族": "合作",
    "恩施土家族苗族2": "恩施",
}

# 拼音（Open-Meteo 用拉丁名查比中文名准得多，实测 Changzhi/Jinzhong 都能命中正确的省）
PINYIN = {
    "长治": "Changzhi", "晋中": "Jinzhong", "吕梁": "Luliang", "抚州": "Fuzhoujiangxi",
    "山南": "Shannan", "海西": "Haixi", "海南": "Hainan", "黔南": "Qiannan",
    "黔东南": "Qiandongnan", "黔西南": "Qianxinan", "阿拉善": "Alxa",
    "兴安": "Xingan", "鄂尔多斯": "Ordos", "黑河": "Heihe", "葫芦岛": "Huludao",
    "周口": "Zhoukou", "益阳": "Yiyang", "湘西": "Xiangxi", "肇庆": "Zhaoqing",
    "凉山": "Liangshan", "定西": "Dingxi", "陇南": "Longnan", "甘南": "Gannan",
    "海东": "Haidong", "果洛": "Golog", "海北": "Haibei", "黄南": "Huangnan",
    "博尔塔拉": "Bortala", "巴音郭楞": "Bayingolin", "克孜勒苏": "Kizilsu",
    "延边": "Yanbian", "迪庆": "Diqing", "普洱": "Puer", "阿坝": "Aba",
    "甘孜": "Garze", "恩施": "Enshi", "伊犁": "Ili", "昌吉": "Changji",
    "北京": "Beijing", "上海": "Shanghai", "天津": "Tianjin", "重庆": "Chongqing",
    "拉萨": "Lhasa", "银川": "Yinchuan", "西宁": "Xining", "乌鲁木齐": "Urumqi",
    "哈尔滨": "Harbin", "长春": "Changchun", "沈阳": "Shenyang", "石家庄": "Shijiazhuang",
    "太原": "Taiyuan", "呼和浩特": "Hohhot", "南宁": "Nanning", "海口": "Haikou",
    "贵阳": "Guiyang", "昆明": "Kunming", "兰州": "Lanzhou", "福州": "Fuzhou",
    "南昌": "Nanchang", "郑州": "Zhengzhou", "武汉": "Wuhan", "长沙": "Changsha",
    "西安": "Xian", "成都": "Chengdu", "杭州": "Hangzhou", "广州": "Guangzhou",
    "合肥": "Hefei", "南京": "Nanjing", "济南": "Jinan", "深圳": "Shenzhen",
    # 官方索引里有、但 Open-Meteo 中文名查不到的城市（必须靠拼音）
    "七台河": "Qitaihe", "朝阳": "Chaoyang", "乌兰察布": "Ulanqab",
    "巴彦淖尔": "Bayannur", "锡林郭勒": "Xilingol", "呼伦贝尔": "Hulunbuir",
    "承德": "Chengde", "雄安新区": "Xiongan", "咸阳": "Xianyang", "延安": "Yanan",
    "杨凌": "Yangling", "莱芜": "Laiwu", "石河子": "Shihezi", "格尔木": "Golmud",
    "济源": "Jiyuan", "神农架": "Shennongjia", "天门": "Tianmen", "仙桃": "Xiantao",
    "潜江": "Qianjiang", "六盘水": "Liupanshui", "佛山": "Foshan", "绍兴": "Shaoxing",
    "吉林": "Jilin", "巴州": "Bayingolin", "克州": "Kizilsu", "博州": "Bortala",
    "阿拉尔": "Aral", "香港": "Hong Kong", "澳门": "Macau", "台北": "Taipei",
    "高雄": "Kaohsiung", "台中": "Taichung",
}

# 历史遗留的截断/冗长城市名 → 官方索引短名
RENAME = {
    "博尔塔拉蒙古": "博州", "巴音郭楞蒙古": "巴州", "克孜勒苏柯尔克孜": "克州",
    "博尔塔拉蒙古自治州": "博州", "巴音郭楞蒙古自治州": "巴州",
    "克孜勒苏柯尔克孜自治州": "克州", "湘西土家族苗族": "湘西",
    "延边朝鲜族": "延边", "凉山彝族": "凉山", "黔东南苗族侗族": "黔东南",
    "黔南布依族苗族": "黔南", "黔西南布依族苗族": "黔西南",
    "西双版纳傣族": "西双版纳", "德宏傣族景颇族": "德宏",
    "怒江傈僳族": "怒江", "迪庆藏族": "迪庆", "甘南藏族": "甘南",
    "海北藏族": "海北", "黄南藏族": "黄南", "海南藏族": "海南",
    "果洛藏族": "果洛", "海西蒙古族藏族": "海西", "伊犁哈萨克": "伊犁",
    "内蒙古自治区兴安盟": "兴安盟", "兴安盟": "兴安盟",
}

# 最后一层：手工校对的地级市驻地坐标（省级行政中心/地级市驻地，误差 < 0.1°）
COORD_FALLBACK = {
    "北京": (39.9042, 116.4074), "上海": (31.2304, 121.4737),
    "天津": (39.0842, 117.2009), "重庆": (29.5630, 106.5516),
    "长治": (36.1954, 113.1163), "晋中": (37.6870, 112.7528), "吕梁": (37.5184, 111.1444),
    "抚州": (27.9490, 116.3580), "山南": (29.2377, 91.7731), "阿里": (32.5000, 80.1050),
    "海北": (36.8960, 100.9010), "黄南": (35.5160, 102.0150), "海南": (36.2860, 100.6200),
    "果洛": (34.4740, 100.2450), "海西": (37.3700, 97.3700), "海东": (36.5030, 102.1040),
    # 官方索引里名字特殊 / Open-Meteo 查不到的最后兜底
    "雄安新区": (39.0433, 116.0027), "杨凌": (34.2716, 108.0841),
    "巴州": (41.7259, 86.1746), "克州": (39.7161, 76.1684), "博州": (44.8539, 82.0741),
    "神农架": (31.7449, 110.6758), "潜江": (30.4021, 112.8994), "台中": (24.1477, 120.6736),
    "大兴安岭": (50.4137, 124.1210), "巴彦淖尔": (40.7431, 107.3878), "锡林郭勒": (43.9330, 116.0860),
    "博尔塔拉": (44.8540, 82.0740), "巴音郭楞": (41.7680, 86.1740), "克孜勒苏": (39.7140, 76.1680),
    "昌吉": (44.0140, 87.3040), "伊犁": (43.9160, 81.3240), "阿拉善": (38.8510, 105.7280),
    "兴安": (46.0830, 122.0480), "鄂尔多斯": (39.6080, 109.7810), "黑河": (50.2450, 127.5290),
    "延边": (42.8910, 129.5090), "葫芦岛": (40.7110, 120.8370), "周口": (33.6200, 114.6500),
    "益阳": (28.5540, 112.3550), "湘西": (28.3140, 109.7400), "肇庆": (23.0470, 112.4650),
    "凉山": (27.8810, 102.2640), "阿坝": (31.8990, 102.2210), "甘孜": (30.0490, 101.9630),
    "黔东南": (26.5830, 107.9790), "黔南": (26.2590, 107.5170), "黔西南": (25.0880, 104.8950),
    "普洱": (22.8250, 100.9660), "迪庆": (27.8260, 99.7060), "楚雄": (25.0450, 101.5460),
    "红河": (23.3660, 103.3840), "文山": (23.3690, 104.2440), "西双版纳": (22.0010, 100.7980),
    "大理": (25.6060, 100.2680), "德宏": (24.4370, 98.5850), "怒江": (25.8530, 98.8560),
    "定西": (35.5790, 104.6260), "陇南": (33.4010, 104.9220), "甘南": (35.0000, 102.9110),
    "临夏": (35.6040, 103.2120), "恩施": (30.2720, 109.4880),
}


# ---------------------------------------------------------------- HTTP
def fetch(url, ref=None, timeout=25, tries=3):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    if ref:
        h["Referer"] = ref
    last = None
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                try:
                    b = gzip.decompress(b)
                except Exception:
                    pass
            return b.decode("utf-8", "replace")
        except Exception as e:
            last = e
            time.sleep(0.8 * (2 ** i))
    raise last


def cpath(tag):
    """用 tag 的 md5 当文件名。

    曾经的写法把非 ASCII 字符直接替换成下划线，导致"ac_北京"/"ac_上海"/"ac_天津"
    全都落成同一个 ac__.json —— 第一个跑到的查询会把结果污染给所有后续查询，
    这就是"气象局 autocomplete 对中文城市索引极差"的真正原因。
    """
    os.makedirs(CACHE, exist_ok=True)
    h = hashlib.md5(tag.encode("utf-8")).hexdigest()[:16]
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", tag)[:48]
    return os.path.join(CACHE, "%s-%s.json" % (safe, h))


def cget(tag, producer, ttl=604800):
    p = cpath(tag)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < ttl:
        try:
            return json.loads(open(p, encoding="utf-8").read())
        except Exception:
            pass
    v = producer()
    # 失败结果（None / 空列表 / 空字典）不落盘，否则一次网络抖动会被永久缓存
    if v:
        try:
            open(p, "w", encoding="utf-8").write(json.dumps(v, ensure_ascii=False))
        except Exception:
            pass
    return v


# ---------------------------------------------------------------- 各层查询
def cma_view(cid):
    """-> (lat, lon, path) 或 None"""
    def go():
        try:
            d = json.loads(fetch("https://weather.cma.cn/api/weather/view?stationid=%s" % cid))
            loc = (d.get("data") or {}).get("location") or {}
            return {"lat": loc.get("latitude"), "lon": loc.get("longitude"), "path": loc.get("path") or ""}
        except Exception:
            return None
    return cget("view_" + cid, go)


def cma_verify(cid, name, prov):
    """校验站号确实属于这个城市：path 末段核心词一致 + 省份相符 + 有坐标。"""
    v = cma_view(cid)
    if not v or v.get("lat") is None or v.get("lon") is None:
        return None
    # 直辖市的对外站名是"区"名（上海 -> 徐家汇，重庆 -> 沙坪坝），所以 SEAT 也算数
    if not (same_place(path_last(v["path"]), name) or
            (SEAT.get(name) and same_place(path_last(v["path"]), SEAT[name]))):
        return None
    if prov and not prov_in(v["path"], prov):
        return None
    return v


def cma_autocomplete(q):
    def go():
        try:
            d = json.loads(fetch("https://weather.cma.cn/api/autocomplete?q=%s" % urllib.parse.quote(q)))
            return d.get("data") or []
        except Exception:
            return []
    return cget("ac_" + q, go)


def cma_find(name, prov):
    """严格按名字找气象局站号。返回 (cid, lat, lon, path) 或 None。"""
    qs, seen_q = [], set()
    for cand_name in [name, SEAT.get(name), SEAT.get(core(name))]:
        if cand_name and cand_name not in seen_q:
            seen_q.add(cand_name)
            qs.append(cand_name)
    for q in qs:
        items = cma_autocomplete(q)
        cands = []
        for it in items:
            p = str(it).split("|")
            if len(p) < 4 or p[3].strip() != "中国":
                continue
            cid, cn = p[0].strip(), p[1].strip()
            if not PURE_ID.match(cid):
                continue
            if same_place(cn, name) or (SEAT.get(name) and same_place(cn, SEAT[name])):
                cands.append(cid)
        for cid in cands[:4]:
            v = cma_verify(cid, name, prov)
            if v:
                return cid, v["lat"], v["lon"], v["path"]
        time.sleep(0.15)
    return None


def om_geo(q):
    def go():
        try:
            b = fetch("https://geocoding-api.open-meteo.com/v1/search?name=%s&count=100&language=zh&format=json"
                      % urllib.parse.quote(q))
            return json.loads(b).get("results") or []
        except Exception:
            return []
    return cget("geo_" + q, go, ttl=2592000)


def om_find(name, prov, py=None):
    """Open-Meteo geocoding：必须省份命中且地名对得上。返回 (lat, lon) 或 None。

    中文短名在 Open-Meteo 里索引很差（长治只返回广东/黑龙江的同名村），
    所以拼音查询才是主力；但拼音查询返回的 name 是拉丁字母，没法直接跟中文比，
    因此这里对拼音查询改用"规范化后的拼音串"比较。
    港澳台在 Open-Meteo 里 country_code 不是 CN，单独放行。
    """
    pb = prov_base(prov)
    special = pb in ("香港", "澳门", "台湾")
    ok_cc = ("HK",) if pb == "香港" else ("MO",) if pb == "澳门" else ("TW",) if pb == "台湾" else ("CN",)

    seen, qs = set(), []
    for q in [name, SEAT.get(name), PINYIN.get(name), PINYIN.get(core(name)), py, name + "市"]:
        if q and q not in seen:
            seen.add(q)
            qs.append(q)

    for q in qs:
        q_norm = re.sub(r"[^a-z]", "", q.lower())
        is_pinyin = bool(re.fullmatch(r"[A-Za-z' ]{3,}", q))
        for r in om_geo(q):
            if (r.get("country_code") or "") not in ok_cc:
                continue
            rn = r.get("name") or ""
            a1 = r.get("admin1") or ""
            if not special and pb and pb not in a1 and a1 not in pb:
                continue
            good = same_place(rn, name)
            if not good and is_pinyin:
                rn_norm = re.sub(r"[^a-z]", "", rn.lower())
                if len(rn_norm) >= 4 and (rn_norm == q_norm or rn_norm.startswith(q_norm) or q_norm.startswith(rn_norm)):
                    good = True
            if not good:
                continue
            if r.get("latitude") is not None and r.get("longitude") is not None:
                return r["latitude"], r["longitude"]
    return None


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--audit-only", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--no-scope", action="store_true",
                    help="不做城市范围裁剪，写回全部解析到的城市")
    args = ap.parse_args()

    doc = json.loads(open(OUT, encoding="utf-8").read())
    cs = doc["cities"]
    print("载入 %d 城" % len(cs))

    # ---------- 0) 与官方索引对表，补回缺的城市（直辖市曾被误删）
    print("\n=== 0) 同步中国天气网官方省市索引 ===")
    cs = sync_index(cs)
    print("  现共 %d 城" % len(cs))

    # ---------- 0.5) 先算好拼音（第 3 步的 Open-Meteo 拼音查询要用它）
    print("\n=== 0.5) 补全拼音（离线 pypinyin）===")
    cs = fill_pinyin(cs)

    # ---------- 1) 校验既有站号，清掉张冠李戴的
    with_cma = [c for c in cs if c.get("cma")]
    print("\n=== 1) 校验 %d 个既有气象局站号 ===" % len(with_cma))
    dropped, kept, reloc = [], 0, 0

    def check(c):
        return c, cma_verify(c["cma"], c["name"], c["prov"])

    with ThreadPoolExecutor(args.workers) as ex:
        for c, v in ex.map(check, with_cma):
            if v is None:
                dropped.append(c)
            else:
                kept += 1
                if c.get("lat") is None or abs((c.get("lat") or 0) - v["lat"]) > 0.02:
                    reloc += 1
                c["lat"], c["lon"] = round(v["lat"], 4), round(v["lon"], 4)
                c["path"] = v["path"]
    for c in dropped:
        print("  ✗ 清除错误站号 %-14s %-10s %s  (%s)" % (c["name"], c["prov"], c["cma"], c.get("path") or ""))
        c.pop("cma", None)
        c["path"] = ""
        # 站号既然不是这个城市的，那它带来的坐标同样不可信（历史数据里"长治"被安上了
        # 广东的坐标、"晋中"被安上了辽宁的坐标）。一起清掉，让第 3/4 步重新解析。
        c["lat"], c["lon"] = None, None
        reloc += 1
    print("  保留 %d / 清除 %d（其中 %d 个坐标一并作废重解）" % (kept, len(dropped), reloc))

    # 没有站号的城市，坐标全部来自早期"只校验省份"的宽松匹配（长治被安上广东坐标、
    # 晋中安上辽宁坐标），一律作废，交给第 3/4 步用"名字必须对上"的严格规则重解。
    nocoord = [c for c in cs if not c.get("cma") and c.get("lat") is not None]
    for c in nocoord:
        c["lat"], c["lon"] = None, None
    print("  作废 %d 个无站号城市的可疑坐标，交由第 3/4 步重解" % len(nocoord))

    if args.audit_only:
        # 审计模式只报告不落盘：它跳过第 3/4 步，此刻所有无站号城市都是"缺坐标"状态，
        # 一旦写文件就会把它们整批删掉（曾经真的这么毁过一次数据）。
        args.dry = True
        return finish(doc, cs, args)

    # ---------- 2) 重查缺失站号
    miss = [c for c in cs if not c.get("cma")]
    print("\n=== 2) 重查 %d 个缺站号的城市（严格名字匹配）===" % len(miss))
    found = [0]

    def look(c):
        try:
            r = cma_find(c["name"], c["prov"])
        except Exception:
            r = None
        return c, r

    with ThreadPoolExecutor(args.workers) as ex:
        for c, r in ex.map(look, miss):
            if r:
                cid, lat, lon, path = r
                c["cma"], c["path"] = cid, path
                c["lat"], c["lon"] = round(lat, 4), round(lon, 4)
                found[0] += 1
                print("  ✓ %-14s %-10s -> %-7s %s" % (c["name"], c["prov"], cid, path))
            else:
                print("  · %-14s %-10s   无匹配站号" % (c["name"], c["prov"]))
    print("  新找到 %d / %d" % (found[0], len(miss)))

    # ---------- 3) 手工校对兜底先行（这批坐标是逐个人工核过的，比模糊地理编码准）
    left = [c for c in cs if c.get("lat") is None]
    if left:
        print("\n=== 3) 手工校对兜底 %d 城 ===" % len(left))
        for c in left:
            fb = COORD_FALLBACK.get(c["name"]) or COORD_FALLBACK.get(core(c["name"]))
            if fb:
                c["lat"], c["lon"] = fb[0], fb[1]
                print("  ✓ %-14s %-10s -> %.3f,%.3f  (人工校对)" % (c["name"], c["prov"], fb[0], fb[1]))

    # ---------- 4) Open-Meteo 补剩余坐标
    nog = [c for c in cs if c.get("lat") is None]
    print("\n=== 4) Open-Meteo 补 %d 个缺坐标的城市 ===" % len(nog))
    got = [0]

    def geo(c):
        try:
            return c, om_find(c["name"], c["prov"], c.get("py"))
        except Exception:
            return c, None

    with ThreadPoolExecutor(args.workers) as ex:
        for c, r in ex.map(geo, nog):
            if r:
                c["lat"], c["lon"] = round(r[0], 4), round(r[1], 4)
                got[0] += 1
                print("  ✓ %-14s %-10s -> %.3f,%.3f  (Open-Meteo)" % (c["name"], c["prov"], r[0], r[1]))
    print("  Open-Meteo 补到 %d / %d" % (got[0], len(nog)))

    return finish(doc, cs, args)


def fill_pinyin(cs):
    """离线补全拼音（pypinyin 没装就跳过，不影响其余步骤）。"""
    try:
        from pypinyin import lazy_pinyin
    except Exception:
        print("  (未安装 pypinyin，跳过拼音补全)")
        return cs
    n = 0
    for c in cs:
        # 手工表优先：pypinyin 对多音字会出错（长治 -> zhangzhi，正确是 changzhi）
        py = PINYIN.get(c["name"]) or PINYIN.get(core(c["name"])) or ""
        if not py:
            try:
                py = "".join(lazy_pinyin(core(c["name"])))
            except Exception:
                py = ""
        if py:
            # 一律重算：历史数据里 py 存的是"省份拼音"（石家庄 -> hebei），是错的
            c["py"] = py.lower()
            n += 1
    print("  补全拼音 %d 条" % n)
    return cs


def finish(doc, cs, args):
    still = [c for c in cs if c.get("lat") is None]
    if still:
        print("\n仍无坐标 %d 城（将从数据集中移除，避免展示错数据）:" % len(still))
        print("  " + ", ".join("%s(%s)" % (c["name"], c["prov"]) for c in still))
    cs = [c for c in cs if c.get("lat") is not None]

    doc["cities"] = cs
    doc["count"] = len(cs)

    n_all = sum(1 for c in cs if c.get("id") and c.get("cma"))
    print("\n解析结果: %d 城 | 有101代码 %d | 有站号 %d | 代码+站号齐全 %d"
          % (len(cs), sum(1 for c in cs if c.get("id")),
             sum(1 for c in cs if c.get("cma")), n_all))
    print("横跨省份: %d 个" % len(set(c["prov"] for c in cs)))

    # 裁剪到用户指定的范围（珠三角 + 长株潭娄底 + 省会），见 tools/scope.py
    if not args.no_scope:
        import scope as _scope
        before = len(cs)
        _scope.apply(doc)
        print("范围裁剪: %d -> %d 城（珠三角 + 长株潭娄底 + 省会；--no-scope 可关闭）"
              % (before, doc["count"]))
        cs = doc["cities"]
    else:
        hot = doc.get("hot") or []
        doc["hot"] = [h for h in hot if any(c["name"] == h for c in cs)]

    if args.dry:
        print("(dry run, 未写文件)")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print("已写出:", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
