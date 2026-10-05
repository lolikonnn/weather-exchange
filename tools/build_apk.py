# -*- coding: utf-8 -*-
"""
天气战士 · 打包 Android APK（不依赖 Gradle / Android Studio）

用到的工具全部来自 android/.sdk（已随仓库准备好或由本脚本下载）：
  build-tools/aapt2.exe  资源编译与链接（产出二进制 AndroidManifest + resources.arsc）
  build-tools/d8.bat     Java class -> dex
  build-tools/zipalign   4 字节对齐（Android 11+ 要求）
  build-tools/apksigner  签名
  平台 android.jar       编译期 API 桩

前端整包（web/）会被复制进 android/assets/web/，APK 完全离线可用；
中国天气网 / 中国气象局的跨域请求由 MainActivity 的 shouldInterceptRequest 代理，
详见 android/java/com/tjs/weather/MainActivity.java 顶部注释。

用法（在 weather-exchange 目录下）:
    python tools\\build_apk.py
    python tools\\build_apk.py --skip-assets     # 只改 Java 时跳过资源复制
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDK = os.path.join(ROOT, "android", ".sdk")
BT = os.path.join(SDK, "build-tools", "android-14")
ANDROID_JAR = os.path.join(SDK, "platforms", "android-35", "android.jar")
AAPT2 = os.path.join(BT, "aapt2.exe")
D8 = os.path.join(BT, "d8.bat")
ZIPALIGN = os.path.join(BT, "zipalign.exe")
APKSIGNER = os.path.join(BT, "apksigner.bat")

JAVA_HOME = r"D:\Java"
KEYSTORE = os.path.join(ROOT, "android", "debug.keystore")
KS_PASS = "android"
KS_ALIAS = "tjs"

BUILD = os.path.join(ROOT, "build", "apk")
ASSETS_WEB = os.path.join(ROOT, "android", "assets", "web")
NAME = "天气战士"

SKIP_ASSET = ("__probe.html", "__net.html", "__net2.html", "cities.full.json")


def run(cmd, **kw):
    print("$ " + " ".join(cmd))
    env = dict(os.environ)
    env["JAVA_HOME"] = JAVA_HOME
    env["PATH"] = os.path.join(JAVA_HOME, "bin") + os.pathsep + env.get("PATH", "")
    r = subprocess.call(cmd, env=env, **kw)
    if r != 0:
        sys.exit("命令失败(退出码 %d): %s" % (r, cmd[0]))


def sync_assets():
    """web/ -> android/assets/web/（去掉开发用探针页）"""
    if os.path.isdir(ASSETS_WEB):
        shutil.rmtree(ASSETS_WEB)
    os.makedirs(ASSETS_WEB)
    n = 0
    for base, dirs, files in os.walk(os.path.join(ROOT, "web")):
        # dist/ 是临时拷进来的安装包；official/ 是给 GitHub Pages 用的静态兜底快照（2.7 MB）——
        # APK 自带本地代理，装到手机上能实时抓中国天气网，不需要这份离线快照。
        dirs[:] = [d for d in dirs if d not in ("tmp", "dist", "official")]
        rel = os.path.relpath(base, os.path.join(ROOT, "web"))
        out = ASSETS_WEB if rel == "." else os.path.join(ASSETS_WEB, rel)
        os.makedirs(out, exist_ok=True)
        for f in files:
            if f in SKIP_ASSET:
                continue
            shutil.copy2(os.path.join(base, f), os.path.join(out, f))
            n += 1
    print("assets/web: %d 个文件 -> %s" % (n, ASSETS_WEB))


def ensure_keystore():
    if os.path.exists(KEYSTORE):
        return
    run([os.path.join(JAVA_HOME, "bin", "keytool.exe"), "-genkeypair",
         "-keystore", KEYSTORE, "-storepass", KS_PASS, "-keypass", KS_PASS,
         "-alias", KS_ALIAS, "-keyalg", "RSA", "-keysize", "2048",
         "-validity", "10000",
         "-dname", "CN=TianJiaoSuo, OU=Weather, O=TJS, L=Beijing, ST=Beijing, C=CN"])


def add_dex(apk_in, dex, apk_out):
    """把 classes.dex 塞进 aapt2 产出的 APK（aapt2 不管 dex）"""
    with zipfile.ZipFile(apk_in) as zin, zipfile.ZipFile(apk_out, "w", zipfile.ZIP_DEFLATED) as zout:
        for it in zin.infolist():
            zout.writestr(it, zin.read(it.filename))
        # classes.dex 必须是不压缩存放（Android 5+ 要求）
        zout.writestr(zipfile.ZipInfo("classes.dex"), open(dex, "rb").read(),
                      compress_type=zipfile.ZIP_DEFLATED)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-assets", action="store_true")
    a = ap.parse_args()

    for p in (AAPT2, D8, ZIPALIGN, APKSIGNER, ANDROID_JAR):
        if not os.path.exists(p):
            sys.exit("缺少 %s\n请先运行 tools\\fetch_android_sdk.py" % p)

    if not a.skip_assets:
        sync_assets()
    elif not os.path.isdir(ASSETS_WEB):
        sync_assets()

    for d in (BUILD,):
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)

    # 1) 资源编译
    res_zip = os.path.join(BUILD, "res.zip")
    run([AAPT2, "compile", "--dir", os.path.join(ROOT, "android", "res"), "-o", res_zip])

    # 2) 资源链接 -> 未签名 base apk（含二进制 manifest / resources.arsc / assets）
    base_apk = os.path.join(BUILD, "base.apk")
    # 注意: 编译产物要作为「位置参数」传入（主资源集）；
    # 用 -R 会当成 overlay，报 "resource string/app_name does not override an existing resource"。
    run([AAPT2, "link", "-o", base_apk,
         "-I", ANDROID_JAR,
         "--manifest", os.path.join(ROOT, "android", "AndroidManifest.xml"),
         "-A", os.path.join(ROOT, "android", "assets"),
         "--min-sdk-version", "21",
         "--target-sdk-version", "35",
         "--version-code", "1", "--version-name", "1.0.0",
         "--no-version-vectors",
         res_zip])

    # 3) 编译 Java
    #    必须 --release 8：Java 9+ 会把字符串拼接编译成 invokedynamic(StringConcatFactory)，
    #    而 R8 8.2.2 在缺少完整 JDK 运行时作 --lib 时会在这个 invokedynamic 上抛
    #    `NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null`。
    #    --release 8 退化成 StringBuilder 拼接，d8 就能正常处理（实测 trivial class 在
    #    JDK 23 下 d8 是好的，问题只出在 invokedynamic 上）。
    classes = os.path.join(BUILD, "classes")
    os.makedirs(classes)
    src = []
    jroot = os.path.join(ROOT, "android", "java")
    for b, _, fs in os.walk(jroot):
        src += [os.path.join(b, f) for f in fs if f.endswith(".java")]
    run([os.path.join(JAVA_HOME, "bin", "javac.exe"),
         "--release", "8", "-encoding", "UTF-8", "-nowarn",
         "-cp", ANDROID_JAR, "-d", classes] + src)

    # 4) dex
    dex_dir = os.path.join(BUILD, "dex")
    os.makedirs(dex_dir)
    cls = []
    for b, _, fs in os.walk(classes):
        cls += [os.path.join(b, f) for f in fs if f.endswith(".class")]
    run([D8, "--release", "--lib", ANDROID_JAR, "--min-api", "21",
         "--output", dex_dir] + cls)

    # 5) 合并 dex
    unsigned = os.path.join(BUILD, "unsigned.apk")
    add_dex(base_apk, os.path.join(dex_dir, "classes.dex"), unsigned)

    # 6) 对齐
    aligned = os.path.join(BUILD, "aligned.apk")
    run([ZIPALIGN, "-f", "-p", "4", unsigned, aligned])

    # 7) 签名
    ensure_keystore()
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, NAME + ".apk")
    if os.path.exists(out):
        os.remove(out)
    run([APKSIGNER, "sign",
         "--ks", KEYSTORE, "--ks-pass", "pass:" + KS_PASS,
         "--key-pass", "pass:" + KS_PASS, "--ks-key-alias", KS_ALIAS,
         "--v1-signing-enabled", "true", "--v2-signing-enabled", "true",
         # v4 会额外吐一个 .idsig 文件，只有增量安装才用得上，这里关掉保持 dist 干净
         "--v4-signing-enabled", "false",
         "--out", out, aligned])
    run([APKSIGNER, "verify", "--print-certs", out])
    for junk in (out + ".idsig",):
        if os.path.exists(junk):
            os.remove(junk)

    print("\n完成: %s  (%.1f MB)" % (out, os.path.getsize(out) / 1048576.0))


if __name__ == "__main__":
    main()
