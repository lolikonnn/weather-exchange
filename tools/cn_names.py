# -*- coding: utf-8 -*-
"""中国行政区划名的核心词归一化 + 匹配工具。

用于把"名字不同但指同一个地方"的两边对齐，同时**拒绝**张冠李戴：
  core("延边朝鲜族自治州") == core("延边")   -> "延边"
  core("鄂尔多斯市")       == core("鄂尔多斯") -> "鄂尔多斯"
  core("鄂伦春自治旗")                      -> "鄂伦春"   (与"鄂尔多斯"不匹配)
"""
import re

# 民族/行政后缀，反复剥离直到稳定
_SUF = re.compile(
    r"(朝鲜族|蒙古族|藏族|彝族|苗族|侗族|布依族|回族|维吾尔族|哈尼族|傣族|白族|"
    r"景颇族|傈僳族|壮族|土家族|羌族|柯尔克孜|哈萨克族|哈萨克|蒙古|满族|瑶族|"
    r"畲族|黎族|佤族|纳西族|拉祜族|水族|东乡族|土族|达斡尔族|仫佬族|锡伯族|"
    r"自治旗|自治县|自治州|自治区|地区|林区|盟|省|市|县|旗|区)$"
)


def core(s):
    """剥掉民族名与行政级别后缀，得到可比较的核心地名。"""
    s = (s or "").strip()
    for _ in range(6):
        m = _SUF.search(s)
        if not m or m.start() == 0:
            break
        s = s[: m.start()]
    return s


def same_place(a, b):
    """两地名是否指同一个地方（按核心词比较，核心词至少 2 字）。"""
    ca, cb = core(a), core(b)
    if not ca or not cb or len(ca) < 2 or len(cb) < 2:
        return False
    return ca == cb


def prov_base(p):
    p = (p or "").strip()
    for suf in ("维吾尔自治区", "壮族自治区", "回族自治区", "特别行政区", "自治区", "省", "市"):
        if p.endswith(suf):
            return p[: -len(suf)]
    return p


def prov_in(text, prov):
    """省份是否出现在给定文本里。"""
    pb = prov_base(prov)
    if not pb:
        return False
    return pb in (text or "")


def path_last(path):
    """CMA location.path 形如 "中国, 河北, 唐山"，取最后一段（地级市）。"""
    parts = [x.strip() for x in (path or "").split(",") if x.strip()]
    return parts[-1] if parts else ""


def path_prov(path):
    """CMA location.path 的省段（倒数第二段）。"""
    parts = [x.strip() for x in (path or "").split(",") if x.strip()]
    return parts[-2] if len(parts) >= 2 else ""
