# -*- coding: utf-8 -*-
"""web/ 里哪些东西不该发布 —— 打包 APK 与推送 GitHub 共用这一份规则。

挡下来的是两类：

1. **开发用探针页**：`web/__*.html`（历史上出现过 `__probe.html` / `__net.html` /
   `__net2.html` / `__g.html`）。这些是本地调试时临时写的页面，从来不该进 APK，
   也不该进网站。之前是靠一张写死的文件名表，漏一个就打包进去了 —— 改成按前缀判。

2. **「天气操盘手」小游戏**：`web/js/game.js` + `web/css/game.css` + `web/index.html`
   里那几行引用。这功能还在开发中，先不发布。那边收尾之后，把下面的
   `INCLUDE_GAME` 改成 True，打包和推送就会自动放行（index.html 也不再被摘）。
"""

import re

# ── 游戏已经收尾（下单/保证金/爆仓/结算四条链路都探针验过），放行发布 ──
INCLUDE_GAME = True

# 相对 web/ 的路径（POSIX 斜杠）
GAME_REL = ("js/game.js", "css/game.css")


def is_probe(name):
    """探针页一律以 __ 开头。"""
    return name.startswith("__")


def skip_rel(rel):
    """rel 是相对 web/ 的路径。"""
    if INCLUDE_GAME:
        return False
    return rel.replace("\\", "/") in GAME_REL


_RE_LINK = re.compile(r'^\s*<link[^>]*href="css/game\.css"[^>]*>\s*$')
_RE_SCRIPT = re.compile(r'^\s*<script[^>]*src="js/game\.js"[^>]*>\s*</script>\s*$')
_RE_COMMENT = re.compile(r'^\s*<!--')


def strip_game(html):
    """把 index.html 里游戏相关的几块摘干净，返回 (新文本, 摘掉的行数)。

    摘四块：css/game.css 的 <link>、顶栏的 #btnGame 按钮、整个 .game-mask 面板、
    末尾的 js/game.js <script>。认不出结构就原样返回（宁可多带一个按钮，
    也不要因为猜错把半个页面切掉）。
    """
    if INCLUDE_GAME:
        return html, 0
    lines = html.split("\n")
    out, i, n, cut = [], 0, len(lines), 0
    while i < n:
        line = lines[i]

        if _RE_LINK.match(line) or _RE_SCRIPT.match(line):
            i += 1
            cut += 1
            continue

        if 'id="btnGame"' in line:                        # 顶栏的 🎮 按钮
            j = i
            while j < n and "</button>" not in lines[j]:
                j += 1
            if j < n:
                cut += j - i + 1
                i = j + 1
                continue

        if "🎮" in line and _RE_COMMENT.match(line):       # 整个游戏面板
            j, seen, ok = i, False, False
            while j < n:
                s = lines[j]
                if 'class="game-mask"' in s:
                    seen = True
                if seen and s.startswith("</div>"):
                    ok = True
                    break
                j += 1
            if ok:
                cut += j - i + 1
                i = j + 1
                continue

        out.append(line)
        i += 1

    # 摘掉整块之后容易留下连续空行，压成一个（否则和线上那份差一个字节）
    text = "\n".join(out)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text, cut
