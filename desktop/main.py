# -*- coding: utf-8 -*-
"""
天交所 · 天气行情终端 (Windows 桌面版)

为什么桌面版要自带一个本地 HTTP 服务：
  1) 中国天气网 d1.weather.com.cn 强制校验 Referer 必须是 weather.com.cn，
     浏览器页面里补不了 Referer，只能由本地服务在服务端补。
  2) 直接 file:// 打开会被浏览器的 CORS / 本地文件策略拦死。
  所以：本地起 http://127.0.0.1:<空闲端口>，再用一个「应用窗口」加载它。

为什么不用 pywebview：
  试过 pywebview（gui="edgechromium" / winforms），在 PyInstaller 单文件里必定挂在
  pythonnet → clr_loader 上：
      RuntimeError: Failed to resolve Python.Runtime.Loader.Initialize
                          from ...\\pythonnet\\runtime\\Python.Runtime.dll
  这是 pythonnet 打不进 PyInstaller onefile 的老问题（需要 .NET 运行时探测 + 原生 dll
  目录布局同时成立），代价高且脆。
  改用 Edge/Chromium 的 `--app=<url>` 模式：开出来的是没有地址栏/标签页的独立窗口，
  外观与原生应用无异，而 Win10/11 自带 Edge，零额外依赖、零 Python 侧 .NET 绑定。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import tempfile
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (os.path.join(ROOT, "server"), ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

import app as server_app  # noqa: E402  (server/app.py)

APP_TITLE = "天交所 · 天气行情终端"

# 应用窗口的浏览器配置目录：独立于用户日常浏览器，避免动到他的书签/插件/登录态
PROFILE_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "TJSWeather", "browser"
)

WINDOW_W, WINDOW_H = 1560, 980

# 优先 Edge（Win10/11 必装），再 Chrome
REG_PATHS = [
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
]
EXE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def _writable(d):
    """确认目录真的能写（有的机器 %LOCALAPPDATA% 被策略锁了，makedirs 成功也写不进）"""
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".write-probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("1")
        os.remove(probe)
        return True
    except OSError:
        return False


def profile_dir():
    """挑一个可写的浏览器配置目录；都不行就返回 None（那就用浏览器自己的默认配置）"""
    for d in (PROFILE_DIR, os.path.join(tempfile.gettempdir(), "TJSWeather-browser")):
        if _writable(d):
            return d
    return None


def find_browser():
    """返回可用于 --app 模式的浏览器可执行文件路径，找不到返回 None"""
    try:
        import winreg
        for key in REG_PATHS:
            for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(hive, key) as k:
                        p = winreg.QueryValueEx(k, "")[0]
                    if p and os.path.isfile(p):
                        return p
                except OSError:
                    pass
    except Exception:
        pass
    for p in EXE_PATHS:
        if os.path.isfile(p):
            return p
    return None


def open_app_window(url, mode="app"):
    """开应用窗口。返回 subprocess.Popen 或 None（None = 已交给系统默认浏览器）"""
    if mode == "browser":
        webbrowser.open(url)
        return None

    exe = find_browser()
    if not exe:
        webbrowser.open(url)
        return None

    args = [
        exe,
        "--app=" + url,
        "--window-size=%d,%d" % (WINDOW_W, WINDOW_H),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,MediaRouter",
        "--disable-background-networking",
    ]
    prof = profile_dir()
    if prof:
        args.append("--user-data-dir=" + prof)
    # DETACHED_PROCESS：浏览器窗口活在自己进程组里，父进程退出不连带它
    flags = 0
    if hasattr(subprocess, "DETACHED_PROCESS"):
        flags |= subprocess.DETACHED_PROCESS
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        flags |= subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        return subprocess.Popen(args, creationflags=flags, close_fds=True)
    except OSError as e:
        print("  启动 %s 失败 (%s)，改用系统默认浏览器。" % (os.path.basename(exe), e))
        webbrowser.open(url)
        return None


def _start_server(port=0):
    srv, url = server_app.serve(port=port, quiet=True)
    t = threading.Thread(target=srv.serve_forever, name="tjs-http", daemon=True)
    t.start()
    return srv, url


def _hold(srv):
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            srv.shutdown()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(prog="tjs", add_help=True)
    ap.add_argument("--port", type=int, default=0, help="固定端口（0=自动找空闲）")
    ap.add_argument("--serve-only", action="store_true",
                    help="只起本地服务，不开窗口（自检 / 当本地代理用）")
    ap.add_argument("--browser", action="store_true",
                    help="用系统默认浏览器打开（默认用 Edge/Chrome 的应用窗口）")
    ap.add_argument("--no-wait", action="store_true",
                    help="开完窗口就退出，让浏览器窗口自己跑")
    a = ap.parse_args()

    port = a.port or int(os.environ.get("TJS_PORT") or 0)
    srv, url = _start_server(port)
    # flush=True：--windowed 打包后 stdout 是块缓冲的，不加就会丢掉诊断信息
    print(APP_TITLE)
    print("  界面地址: %s" % url)
    print("  静态根:   %s" % server_app.WEB, flush=True)

    if a.serve_only:
        print("READY %s" % url, flush=True)
        _hold(srv)
        return

    try:
        proc = open_app_window(url, "browser" if a.browser else "app")
    except Exception as e:                     # 外壳失败也不能让服务跟着死
        import traceback
        traceback.print_exc()
        print("  开窗口失败 (%s)，改用系统默认浏览器。" % e, flush=True)
        webbrowser.open(url)
        proc = None

    if proc is None or a.no_wait:
        if proc is None:
            print("  已在默认浏览器中打开（关掉本窗口即停止服务）。", flush=True)
        _hold(srv)
        return

    print("  应用窗口已启动 (pid %d)。关闭该窗口即退出。" % proc.pid, flush=True)
    try:
        while proc.poll() is None:
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            srv.shutdown()
        except Exception:
            pass
        if proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass


if __name__ == "__main__":
    main()
