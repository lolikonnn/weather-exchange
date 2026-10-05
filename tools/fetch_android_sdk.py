# -*- coding: utf-8 -*-
"""
下载打包 APK 所需的 Android SDK 组件（不装 Android Studio、不跑 sdkmanager）。

只需要两个 zip：
  build-tools_r34-windows.zip  -> android/.sdk/build-tools/android-14/
  platform-35_r01.zip          -> android/.sdk/platforms/android-35/

注意：不要用 sdkmanager —— 它要 JDK 版本兼容 + 交互式接受许可证；
直接下官方 zip 更快也更可复现。build-tools 35/36 没有 windows zip 的直链
（已实测 404，Google 改了命名规则），34 是能直链拿到的最新版。

用法: python tools\\fetch_android_sdk.py
"""
from __future__ import annotations

import io
import os
import sys
import time
import urllib.request
import zipfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.path.join(ROOT, "android", ".sdk")

# (归档文件名, 解压目标子目录)
PACKAGES = [
    ("build-tools_r34-windows.zip", "build-tools", "build-tools;34.0.0"),
    ("platform-35_r01.zip", "platforms", "platforms;android-35"),
]
BASE = "https://dl.google.com/android/repository/"


def download(name: str) -> str:
    os.makedirs(SDK, exist_ok=True)
    dst = os.path.join(SDK, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 1000000:
        print("已存在，跳过下载: %s" % name)
        return dst
    url = BASE + name
    t = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(dst, "wb") as f:
        n = 0
        while True:
            b = r.read(262144)
            if not b:
                break
            f.write(b)
            n += len(b)
    print("%-32s %7.1f MB  %4.0fs" % (name, n / 1048576.0, time.time() - t))
    return dst


def main():
    for name, sub, label in PACKAGES:
        z = download(name)
        out = os.path.join(SDK, sub)
        os.makedirs(out, exist_ok=True)
        with zipfile.ZipFile(z) as f:
            tops = sorted(set(n.split("/")[0] for n in f.namelist()))
            f.extractall(out)
        print("  %s -> %s  %s" % (label, os.path.relpath(out, ROOT), tops))

    # 自检
    need = [
        os.path.join(SDK, "build-tools", "android-14", "aapt2.exe"),
        os.path.join(SDK, "build-tools", "android-14", "d8.bat"),
        os.path.join(SDK, "build-tools", "android-14", "zipalign.exe"),
        os.path.join(SDK, "build-tools", "android-14", "apksigner.bat"),
        os.path.join(SDK, "platforms", "android-35", "android.jar"),
    ]
    print()
    ok = True
    for p in need:
        e = os.path.exists(p)
        ok = ok and e
        print("%s %s" % ("OK  " if e else "缺失", os.path.relpath(p, ROOT)))
    if not ok:
        sys.exit(1)
    print("\nSDK 就绪，可以运行 python tools\\build_apk.py")


if __name__ == "__main__":
    main()
