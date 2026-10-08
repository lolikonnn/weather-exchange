"""bump_ver.py — 给 web/index.html 里的本地静态资源写「内容指纹」版本号。

用法：
    E:\\python\\python.exe tools\\bump_ver.py            # 按内容重算并写入 index.html
    E:\\python\\python.exe tools\\bump_ver.py --check    # 只比对，不一致就退出码 1（不写）

为什么要这个东西
================
起因（2026-10-08）：改完 api.js 推上线，用户在网页上「无论怎么刷气象局实况都不变」，
查到最后是 **GitHub Pages 对静态资源发 `Cache-Control: max-age=600`**，浏览器十分钟内
根本不来取新的 `js/api.js`；而 HTML 和 JS 的失效时钟是各自独立走的，所以还会出现
「HTML 已经是新的、但它引用的 JS 还是旧的」这种最坑的组合。

实测线上响应头（三份都是同一时刻、同样 600 秒）：
    /            Content-Length 42846  ETag "6ac6fa99-a75e"  Cache-Control: max-age=600
    /index.html  Content-Length 42846  ETag "6ac6fa99-a75e"  Cache-Control: max-age=600
    /js/app.js   Content-Length 112136 ETag "6ac6fa99-1b608" Cache-Control: max-age=600
    /css/app.css Content-Length 69498  ETag "6ac6fa99-10f7a" Cache-Control: max-age=600

Pages 不支持自定义响应头（没有 `_headers` 那种配置），所以只能从 URL 下手：
给引用加上 `?v=<指纹>`，改了内容的文件换个 URL 就必然重新下载。

为什么用「文件自己的 sha256 前 8 位」而不是手写 v1/v2
=====================================================
手写版本号要靠人记得改，漏一次就静默失效一整轮。用内容指纹则天然正确：
- 改过的文件 → 指纹变 → URL 变 → 立刻重取；
- 没改的文件 → 指纹不变 → URL 不变 → 继续吃缓存，不会白下载。
本仓库的 `web/vendor/echarts.min.js` 是 1,030,855 B，**故意不打版本号**：它几乎不变，
打上指纹反而会因为它所在行的改动而牵连全量重下。它自己靠 ETag 协商即可。

三个服务端都验证过能吃下带 `?v=` 的 URL（这点必须先确认，否则 APK 里会白屏）
=====================================================================
1. GitHub Pages：静态托管，查询串不影响文件解析。
2. Android WebView：`android/java/com/tjs/weather/MainActivity.java:274-277`
       String path = rest, query = "";
       int q = rest.indexOf('?');
       if (q >= 0) { path = rest.substring(0, q); query = rest.substring(q + 1); }
   —— 先把 `?` 后面的查询串切掉再 `URLDecoder.decode(path)`，
   `path.startsWith("/web/")` → `asset(path.substring(5))`，所以带版本号照样命中 assets。
   （顺带：`asset()` 里本来就写了 `Cache-Control: no-cache`，APK 侧原本就不缓存。）
3. 本地 Python 服务：`server/app.py:295` `u = urllib.parse.urlsplit(self.path)`，
   取的是 `u.path`，查询串被丢掉后才 `self.static(p)`。

前端侧也没有依赖脚本真实 URL 的地方：全仓库搜不到 `document.currentScript`、
`getElementsByTagName('script')`、`import(`、`new Worker`、`createElement('script')`，
所以给 `<script src>` 加查询串不会影响任何逻辑。

⚠ 这个工具**只解决 JS/CSS**。`index.html` 自己也是 `max-age=600`，而它没法给自己
打指纹 —— 想立刻看到新版本，入口 HTML 那一次仍然要硬刷新（Ctrl+F5；手机上重装 APK）。
好处是：HTML 一旦刷新，它引用的所有资源必定是配套的新版本，不会再出现「版本错位」。
"""
import hashlib
import os
import re
import sys

# Windows 控制台默认是 GBK，`✓ / → / ⚠` 这类字符会让 print 抛 UnicodeEncodeError
# （第一次跑就踩到了：文件其实已经写好，却因为最后一句 print 崩掉、退出码 1，
#  看起来像失败）。把不可编码的字符降级成 `?`，不让它影响退出码。
try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "web", "index.html")

# 要打指纹的资源（相对 web/ 的路径）。故意不含 vendor/echarts.min.js，理由见文件头。
TARGETS = [
    "css/app.css",
    "css/game.css",
    "img/logo-32.png",
    "js/util.js",
    "js/indicators.js",
    "js/api.js",
    "js/chart.js",
    "js/weather.js",
    "js/astro.js",
    "js/wxui.js",
    "js/app.js",
    "js/game.js",
]


def fingerprint(rel):
    """读 web/<rel> 的字节，返回 sha256 前 8 位；文件不存在返回 None。"""
    p = os.path.join(ROOT, "web", rel.replace("/", os.sep))
    if not os.path.isfile(p):
        return None
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


def rewrite(html, rel, fp):
    """把 html 里对 rel 的引用改成 rel?v=fp（已带旧版本号的就换掉）。

    只匹配 href="…" / src="…" 里正好等于该路径的（可带 `?v=<hex>`），
    避免误伤同名前缀的其它路径。
    """
    pat = re.compile(
        r'(?P<attr>\b(?:href|src)=")' + re.escape(rel) + r'(?:\?v=[0-9a-f]*)?(?P<end>")'
    )
    new, n = pat.subn(lambda m: m.group("attr") + rel + "?v=" + fp + m.group("end"), html)
    return new, n


def main():
    check = "--check" in sys.argv
    with open(INDEX, "r", encoding="utf-8") as f:
        html = f.read()
    orig = html

    missing, changed, same, counts = [], [], [], {}
    for rel in TARGETS:
        fp = fingerprint(rel)
        if fp is None:
            missing.append(rel)
            continue
        html, n = rewrite(html, rel, fp)
        counts[rel] = n
        if n == 0:
            missing.append(rel + " (index.html 里没有引用)")
            continue
        # 原来带的是不是这个指纹？用来报「有几个真的变了」
        was = re.search(
            r'\b(?:href|src)="' + re.escape(rel) + r'\?v=([0-9a-f]*)"', orig
        )
        if was and was.group(1) == fp:
            same.append(rel)
        else:
            changed.append(rel)
        print("  %-22s ?v=%s  %s" % (rel, fp, "未变" if (was and was.group(1) == fp) else "→ 新指纹"))

    if missing:
        print("\n⚠ 以下资源没找到或没有被引用：")
        for m in missing:
            print("   -", m)

    dirty = html != orig
    n_tags = sum(counts.values())
    print("\n共 %d 个引用被扫到；%d 个指纹变化，%d 个不变。" % (n_tags, len(changed), len(same)))

    if check:
        if dirty:
            print("✗ index.html 与磁盘内容不一致，请跑一次 `tools\\bump_ver.py`（不加 --check）。")
            return 1
        print("✓ index.html 的版本号与磁盘内容一致。")
        return 0

    if dirty:
        with open(INDEX, "w", encoding="utf-8", newline="") as f:
            f.write(html)
        print("✓ 已写入 %s（%d → %d B）" % (INDEX, len(orig.encode("utf-8")),
                                            len(html.encode("utf-8"))))
    else:
        print("✓ 无需改动（版本号已经是最新的）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
