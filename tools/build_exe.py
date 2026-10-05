# -*- coding: utf-8 -*-
"""
天交所 · 打包 Windows 单文件 EXE

用法（在 weather-exchange 目录下）:
    python tools\\build_exe.py

产物: dist\\天交所-天气行情终端.exe  （单文件，双击即用，无需装 Python）
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = "天交所-天气行情终端"
SEP = ";" if os.name == "nt" else ":"

# 不进 EXE 的东西：
#   official/  —— 2.7 MB 的 GitHub Pages 静态兜底快照，EXE 自带本地代理能实时抓，用不上
#   cities.full.json —— 352 城全量备份，只在离线重建数据集时用，前端从不读
SKIP_DIRS = {"official", "dist", "tmp", "__pycache__"}
SKIP_FILES = {"cities.full.json", "__net.html", "__net2.html"}


def stage_web():
    """把 web/ 过滤后拷到 build/web-stage/，PyInstaller 只打这一份。

    --add-data 是按目录整包拷贝的，没有排除选项，所以先自己筛一遍。
    """
    src = os.path.join(ROOT, "web")
    dst = os.path.join(ROOT, "build", "web-stage")
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    n = 0
    for base, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel = os.path.relpath(base, src)
        out = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(out, exist_ok=True)
        for f in files:
            if f in SKIP_FILES:
                continue
            shutil.copy2(os.path.join(base, f), os.path.join(out, f))
            n += 1
    print("web-stage: %d 个文件 -> %s" % (n, dst))
    return dst


def main():
    entry = os.path.join(ROOT, "desktop", "main.py")
    web = os.path.join(ROOT, "web")
    if not os.path.isdir(web):
        sys.exit("找不到 web 目录: %s" % web)

    # 只清自己的产物，别把 dist 整个删掉（APK 也在里面）
    work = os.path.join(ROOT, "build")
    if os.path.isdir(work):
        shutil.rmtree(work, ignore_errors=True)
    for f in (NAME + ".exe", NAME):
        p = os.path.join(ROOT, "dist", f)
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError as e:
                sys.exit("dist\\%s 被占用（是不是还在运行？先关掉它）：%s" % (f, e))

    staged = stage_web()

    args = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onefile",
        "--windowed",                      # 不弹控制台黑窗
        "--name", NAME,
        "--distpath", os.path.join(ROOT, "dist"),
        "--workpath", os.path.join(ROOT, "build"),
        "--specpath", os.path.join(ROOT, "build"),
        "--paths", os.path.join(ROOT, "server"),
        # 前端整目录打进去（server/app.py 会自动在 sys._MEIPASS 下找到它）
        "--add-data", staged + SEP + "web",
        # 桌面外壳只用 Edge/Chrome 的 --app 模式，不依赖 pywebview / pythonnet，
        # 所以这里显式排除掉，省体积也避免 PyInstaller 误打进 .NET 绑定：
        "--exclude-module", "webview",
        "--exclude-module", "clr",
        "--exclude-module", "clr_loader",
        "--exclude-module", "pythonnet",
        "--exclude-module", "tkinter",
        "--exclude-module", "numpy",
        "--exclude-module", "PIL",
        entry,
    ]
    print(" ".join(args))
    r = subprocess.call(args, cwd=ROOT)
    if r != 0:
        sys.exit("PyInstaller 失败，退出码 %d" % r)

    out = os.path.join(ROOT, "dist", NAME + (".exe" if os.name == "nt" else ""))
    print("\n完成: %s  (%.1f MB)" % (out, os.path.getsize(out) / 1048576.0))


if __name__ == "__main__":
    main()
