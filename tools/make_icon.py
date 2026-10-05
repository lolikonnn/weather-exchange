# -*- coding: utf-8 -*-
"""
生成品牌图标。

来源图：`tools/logo-src.png`（用户给的那张，正方形）。
产出：
  web/img/logo.png            128x128   顶栏左上角的品牌标记
  web/img/logo-32.png          32x32    浏览器标签页 favicon
  android/res/mipmap-*/ic_launcher.png  48/72/96/144/192 各密度启动图标

为什么源图放在 `tools/` 而不是 `web/`：`build_apk.py` 会把整个 `web/` 复制进
`android/assets/web/`，1.2 MB 的源图跟进去会把 APK 从 673 KB 撑到 1.9 MB。
真正要打包的是缩放后那几张几十 KB 的小图。

装了 Pillow 就用它做高质量 LANCZOS 缩放；没装（或找不到源图）就退回
原先那套纯标准库画的"红绿蜡烛"图标，保证打包流程不会因为少了张图而断掉。

用法: python tools\\make_icon.py
"""
from __future__ import annotations

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "res")
SRC = os.path.join(ROOT, "tools", "logo-src.png")
WEB_IMG = os.path.join(ROOT, "web", "img")

# ── 以下常量与 render() 只服务于"没有 Pillow"时的回退图标 ──
BG = (0x0E, 0x10, 0x15)
UP = (0xFF, 0x4D, 0x4F)
DOWN = (0x00, 0xB5, 0x78)
GOLD = (0xF0, 0xB9, 0x0B)

# (中心 x 比例, 影线 顶/底 比例, 实体 顶/底 比例, 颜色)
CANDLES = [
    (0.26, 0.20, 0.80, 0.38, 0.62, UP),
    (0.50, 0.28, 0.72, 0.44, 0.66, DOWN),
    (0.74, 0.24, 0.76, 0.34, 0.60, UP),
]

# 各密度对应的图标边长（launcher 用 48dp 基准）
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# web 上要用到的两种尺寸
WEB_SIZES = {"logo.png": 128, "logo-32.png": 32}


def render(size: int) -> bytes:
    """回退图标：纯标准库画的深色底 + 三根红绿蜡烛 + 金色基准线。"""
    rows = []
    for y in range(size):
        fy = y / float(size - 1)
        row = bytearray()
        for x in range(size):
            fx = x / float(size - 1)
            px = BG
            if abs(fy - 0.88) < 0.010:                      # 金色基准线
                px = GOLD
            edge = min(fx, fy, 1 - fx, 1 - fy)              # 圆角外框
            if edge < 0.045:
                px = BG if edge < 0.028 else GOLD
            for cx, wt, wb, bt, bb, col in CANDLES:
                if abs(fx - cx) < 0.075 * 0.22 and wt <= fy <= wb:
                    px = col
                if abs(fx - cx) < 0.075 * 0.95 and bt <= fy <= bb:
                    px = col
            row += bytes((px[0], px[1], px[2], 255))
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def square_source():
    """把源图读成正方形 PIL 图；不可用时返回 None。"""
    if not os.path.isfile(SRC):
        print("  ! 找不到 %s，回退到内置蜡烛图标" % os.path.relpath(SRC, ROOT))
        return None
    try:
        from PIL import Image
    except Exception as e:
        print("  ! 没有 Pillow（%s），回退到内置蜡烛图标" % e)
        return None
    im = Image.open(SRC)
    im = im.convert("RGB")
    w, h = im.size
    s = min(w, h)                                   # 居中裁成正方形
    im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    return im


def main():
    im = square_source()
    made = []

    # 1) 网站用的小图
    os.makedirs(WEB_IMG, exist_ok=True)
    for name, size in WEB_SIZES.items():
        p = os.path.join(WEB_IMG, name)
        if im is not None:
            from PIL import Image
            im.resize((size, size), Image.LANCZOS).save(p, "PNG", optimize=True)
        else:
            with open(p, "wb") as f:
                f.write(render(size))
        made.append(p)

    # 2) Android 各密度启动图标
    for d, size in DENSITIES.items():
        out = os.path.join(RES, "mipmap-" + d)
        os.makedirs(out, exist_ok=True)
        p = os.path.join(out, "ic_launcher.png")
        if im is not None:
            from PIL import Image
            im.resize((size, size), Image.LANCZOS).save(p, "PNG", optimize=True)
        else:
            with open(p, "wb") as f:
                f.write(render(size))
        made.append(p)

    for p in made:
        print("%-46s %7d bytes" % (os.path.relpath(p, ROOT), os.path.getsize(p)))
    print("来源: %s" % ("tools/logo-src.png" if im is not None else "内置蜡烛图标（回退）"))


if __name__ == "__main__":
    main()
