# -*- coding: utf-8 -*-
"""
生成 APK 启动图标（纯标准库写 PNG，不依赖 Pillow）。

图案：深色底 + 三根红绿蜡烛 + 金色基准线 —— 与「天交所」的行情皮肤一致。
用法: python tools\\make_icon.py
"""
from __future__ import annotations

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android", "res")

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


def render(size: int) -> bytes:
    """返回 RGBA 行序列（PNG 用）"""
    rows = []
    for y in range(size):
        fy = y / float(size - 1)
        row = bytearray()
        for x in range(size):
            fx = x / float(size - 1)
            px = BG
            # 金色基准线（细，靠近 88% 高度）
            if abs(fy - 0.88) < 0.010:
                px = GOLD
            # 圆角外框：画一圈金色细边，看起来像个"行情卡片"
            edge = min(fx, fy, 1 - fx, 1 - fy)
            if edge < 0.045:
                px = BG if edge < 0.028 else GOLD
            for cx, wt, wb, bt, bb, col in CANDLES:
                dw = 0.075 * 0.22          # 影线半宽
                bw = 0.075 * 0.95          # 实体半宽
                if abs(fx - cx) < dw and wt <= fy <= wb:
                    px = col
                if abs(fx - cx) < bw and bt <= fy <= bb:
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


# 各密度对应的图标边长（launcher 用 48dp 基准）
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def main():
    for d, size in DENSITIES.items():
        out = os.path.join(RES, "mipmap-" + d)
        os.makedirs(out, exist_ok=True)
        p = os.path.join(out, "ic_launcher.png")
        with open(p, "wb") as f:
            f.write(render(size))
        print("%-46s %6d bytes" % (os.path.relpath(p, ROOT), os.path.getsize(p)))


if __name__ == "__main__":
    main()
