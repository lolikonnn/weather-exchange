# -*- coding: utf-8 -*-
"""列出 Google SDK 仓库里可用的 build-tools / platform 包，并给出 Windows 归档 URL。
用法: python tools\\sdk_index.py [关键字]
"""
import gzip
import io
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

REPO = [
    "https://dl.google.com/android/repository/repository2-3.xml",
    "https://dl.google.com/android/repository/repository2-1.xml",
]
KEYS = sys.argv[1:] or ["build-tools", "platform"]


def get(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=90) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            b = gzip.decompress(b)
        return b.decode("utf-8", "replace")


txt = None
for u in REPO:
    try:
        txt = get(u)
        print("OK %s (%d bytes)" % (u, len(txt)))
        break
    except Exception as e:
        print("FAIL %s %s" % (u, e))
if not txt:
    sys.exit(1)

# 每个 remotePackage 块里找 path 与 windows 归档
for blk in re.findall(r"<remotePackage\b.*?</remotePackage>", txt, re.S):
    m = re.search(r'path="([^"]+)"', blk)
    if not m:
        continue
    path = m.group(1)
    if not any(k in path for k in KEYS):
        continue
    arch = re.search(r'<archive>\s*<complete>\s*<size>(\d+)</size>\s*'
                     r'<checksum[^>]*>([^<]*)</checksum>\s*'
                     r'<url>([^<]+)</url>', blk)
    if not arch:
        continue
    size, _sum, url = arch.groups()
    if "windows" not in url:
        continue
    print("%-28s %10.1f MB  %s" % (path, int(size) / 1048576.0, url))
