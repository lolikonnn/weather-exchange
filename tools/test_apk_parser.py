#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
APK 端解析器离线自检（不需要 adb / 设备 / 模拟器）。

APK 是三个交付物里唯一没法在本机跑起来的（没有 Android 设备、没有模拟器、没有 adb）。
但 APK 里最容易出错的一块 —— MainActivity 的 jsObj()，负责从中国天气网
`var dataSK={...};` / `var fc40=[...];` 这种页面里抠 JSON —— 是纯 static、只吃 String、
不碰任何 Android API 的。所以可以：

  1. 借 android.jar 在桌面 JVM 上用反射直接调它；
  2. 抓一份真实的 calendar_new 页面原文；
  3. 拿它和 server/app.py 里那套「已经过了 20/20 冒烟测试」的 js_obj() 做逐条对拍。

对拍通过 = APK 的解析逻辑与已验证的 Python 实现等价。

用法:
    python tools/test_apk_parser.py
退出码 0 = 全部通过。
"""
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

ANDROID_JAR = os.path.join(ROOT, "android", ".sdk", "platforms", "android-35", "android.jar")
MAIN_JAVA = os.path.join(ROOT, "android", "java", "com", "tjs", "weather", "MainActivity.java")
TEST_JAVA = os.path.join(ROOT, "android", "test", "TjsParseTest.java")
WORK = os.path.join(ROOT, "build", "aptest")
PAGE_URL = "http://d1.weather.com.cn/calendar_new/2026/101010100_202610.html"

JAVA_HOMES = [r"D:\Java", r"C:\Program Files\Java", os.environ.get("JAVA_HOME", "")]


def find_tool(name):
    for home in JAVA_HOMES:
        if not home:
            continue
        p = os.path.join(home, "bin", name + ".exe")
        if os.path.isfile(p):
            return p
    return name  # 交给 PATH


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", **kw)
    if r.returncode != 0:
        print("命令失败:", " ".join(str(c) for c in cmd))
        print(r.stdout[-2000:])
        print(r.stderr[-2000:])
        raise SystemExit(1)
    return r


def main():
    ok = True

    if not os.path.isfile(ANDROID_JAR):
        raise SystemExit("缺少 %s，先跑 python tools\\fetch_android_sdk.py" % ANDROID_JAR)

    os.makedirs(WORK, exist_ok=True)
    classes = os.path.join(WORK, "classes")
    os.makedirs(classes, exist_ok=True)
    javac, java = find_tool("javac"), find_tool("java")
    sep = ";" if os.name == "nt" else ":"

    print("1) 编译 MainActivity ...")
    run([javac, "--release", "8", "-nowarn", "-encoding", "UTF-8",
         "-cp", ANDROID_JAR, "-d", classes, MAIN_JAVA])

    print("2) 编译自检程序 ...")
    run([javac, "--release", "8", "-nowarn", "-encoding", "UTF-8",
         "-cp", ANDROID_JAR + sep + classes, "-d", classes, TEST_JAVA])

    print("3) 抓一份真实页面原文 ...")
    import app  # server/app.py
    raw = app.text_of(app._fetch(PAGE_URL, app.CWW_REF))
    raw_path = os.path.join(WORK, "raw_cal.html")
    io.open(raw_path, "w", encoding="utf-8").write(raw)
    print("   %d 字符" % len(raw))

    print("4) 在桌面 JVM 上跑 APK 的解析器 ...")
    out_path = os.path.join(WORK, "java_out.txt")
    run([java, "-cp", ANDROID_JAR + sep + classes, "TjsParseTest", raw_path, out_path])

    got = {}
    for line in io.open(out_path, encoding="utf-8").read().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            got[k] = v

    print("5) 与 Python 实现（已过冒烟测试）对拍 ...")

    def check(name, cond, detail=""):
        nonlocal ok
        mark = "  OK  " if cond else "  FAIL"
        print("%s %-26s %s" % (mark, name, detail if not cond else ""))
        if not cond:
            ok = False

    # —— 真实页面：35 条记录逐条比 ——
    java_txt = io.open(out_path + ".fc40", encoding="utf-8").read()
    py_obj = app.js_obj(raw, "fc40")
    try:
        java_obj = json.loads(java_txt)
    except Exception as e:
        check("fc40 能被解析", False, "Java 输出不是合法 JSON: %s" % e)
        java_obj = None
    if java_obj is not None:
        expect = app.js_obj(raw, "fc40")
        check("fc40 记录数一致", len(java_obj) == len(py_obj),
              "java=%d py=%d" % (len(java_obj), len(py_obj)))
        check("fc40 逐条完全一致", java_obj == py_obj)
        check("fc40 字段集合一致", set(java_obj[0]) == set(py_obj[0]))
        n_d15 = sum(1 for d in java_obj if d.get("cla") == "d15")
        check("fc40 含 d15 预报", n_d15 > 0, "%d 条" % n_d15)

    # —— sk_2d / dingzhi 片段 ——
    check("dataSK 抠取", json.loads(got["dataSK"])["cityname"] == "北京", got.get("dataSK", "")[:80])
    check("cityDZ 抠取", json.loads(got["cityDZ101010100"])["weatherinfo"]["temp"] == "23")
    check("不存在的变量返回 null", got["missing"] == "null", got.get("missing"))

    # —— 刁钻样本 ——
    check("字符串内藏 } ", json.loads(got["probe_x"])["a"] == "}")
    check("转义引号", json.loads(got["probe_y"])["a"] == 'say "hi"')
    check("数组抠取", [d["d"] for d in json.loads(got["probe_z"])] == ["2026-10-05", "2026-10-06"])
    check("字符串内藏 ] 与 }", json.loads(got["probe_w"]) == {"u": "a[b]c", "v": [1, 2, {"k": "}]"}]})

    # —— parseQuery ——
    for key, want in (("q_code", {"code": "101280101", "ym": "202610"}),
                      ("q_st", {"st": "54517_tj", "ttl": "60"}),
                      ("q_flag", {"flag": "1"}),
                      ("q_zh", {"q": "杭州"})):
        got_map = dict(re.findall(r"(\w+)=([^,}]*)", got.get(key, "")))
        check("parseQuery %s" % key, got_map == want, "got=%r want=%r" % (got_map, want))

    # —— isCode ——
    check("isCode 9 位数字", got["isCode_ok"] == "true")
    check("isCode 拒绝 7 位", got["isCode_short"] == "false")
    check("isCode 拒绝字母", got["isCode_alpha"] == "false")

    # —— mime ——
    want_mime = {"js/app.js": "application/javascript", "css/app.css": "text/css",
                 "vendor/echarts.min.js": "application/javascript", "index.html": "text/html",
                 "data/cities.json": "application/json", "res/ic_launcher.png": "image/png"}
    for path, want in want_mime.items():
        check("mime %s" % path, got.get("mime[%s]" % path) == want, got.get("mime[%s]" % path))

    # —— 与 Python 的 esc 对齐（Java 里叫 esc）——
    check("esc 转义", got.get("esc", "").startswith("a\\\"b"))

    print()
    print("=" * 60)
    print("APK 解析器自检：" + ("全部通过" if ok else "有失败项"))
    print("=" * 60)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
