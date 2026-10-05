# -*- coding: utf-8 -*-
"""
天气战士 · 本地服务 (桌面版内核 / 本地调试)

为什么需要它:
  中国天气网 d1.weather.com.cn 的接口强制校验 Referer 必须是 weather.com.cn,
  浏览器从 127.0.0.1 或 github.io 直接 fetch 一律 403。
  本服务在服务端补上 Referer 并解析 GBK 文本, 再以 JSON 形式交给前端。

同时它也是静态文件服务器, 把 ../web 目录挂到 /。

接口:
  GET /api/health
  GET /api/cn/snapshot?code=101010100        实况 (sk_2d)
  GET /api/cn/forecast?code=101010100        今日预报 + 预警 (dingzhi)
  GET /api/cn/calendar?code=&ym=YYYYMM       月度逐日历史/预报 (calendar_new)
  GET /api/cn/full?code=101010100            以上合并 (前端一次拿全)
  GET /api/cn/search?q=杭州                   中国天气网城市搜索 (toy1)
  GET /api/om/<path>                         Open-Meteo 透传 (可选, 便于统一缓存)

用法:
  python app.py                 # 127.0.0.1, 自动找空闲端口
  python app.py --port 8080
  python app.py --open          # 启动后自动打开浏览器 (桌面版由 pywebview 接管)
"""
from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
import os
import re
import socket
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_WEB_CANDIDATES = [os.path.join(ROOT, "web"), os.path.join(HERE, "web")]
WEB = next((p for p in _WEB_CANDIDATES if os.path.isdir(p)), _WEB_CANDIDATES[0])

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
CWW_REF = "http://www.weather.com.cn/"
D1 = "http://d1.weather.com.cn"
OM = "https://api.open-meteo.com"
OM_A = "https://archive-api.open-meteo.com"
OM_AIR = "https://air-quality-api.open-meteo.com"
# 中国气象局台风/预警服务。注意前缀 /weatherservice 不能省，
# 省掉之后所有 /typhoon/jsons/* 都会 404（这是官方前端 typhoon-datas-inner.js 里写死的）。
NMC = "https://typhoon.nmc.cn/weatherservice"
NMC_IMG = "https://image.nmc.cn"

CODE_RE = re.compile(r"^\d{9}$")
# 气象局站号: 54511 / 59493 / V3006 / P5599 / M1068 ...
CMA_ST_RE = re.compile(r"^[0-9A-Za-z]{3,12}$")
CMA = "https://weather.cma.cn"

# ----------------------------------------------------------------- 抓取 + 缓存

_cache: dict[str, tuple[float, bytes]] = {}
_lock = threading.Lock()


def _fetch(url: str, ref: str | None = CWW_REF, timeout: int = 20) -> bytes:
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip"}
    if ref:
        h["Referer"] = ref
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            try:
                b = gzip.decompress(b)
            except Exception:
                pass
        return b


def fetch_cached(url: str, ttl: int, ref: str | None = CWW_REF, timeout: int = 20) -> bytes:
    now = time.time()
    with _lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    b = _fetch(url, ref, timeout)
    with _lock:
        _cache[url] = (now, b)
        if len(_cache) > 800:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:300]:
                _cache.pop(k, None)
    return b


def text_of(b: bytes) -> str:
    for enc in ("utf-8", "gbk", "gb18030"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", "replace")


def js_obj(txt: str, var: str):
    """从 'var xyz={...};' 里抠出第一个平衡的 JSON 对象/数组。"""
    m = re.search(r"\b" + re.escape(var) + r"\s*=\s*", txt)
    if not m:
        return None
    s = txt[m.end():].lstrip()
    if not s or s[0] not in "{[":
        return None
    op, cl = ("{", "}") if s[0] == "{" else ("[", "]")
    depth, instr, esc = 0, False, False
    for i, ch in enumerate(s):
        if instr:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = False
            continue
        if ch == '"':
            instr = True
        elif ch == op:
            depth += 1
        elif ch == cl:
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(s[: i + 1])
                except Exception:
                    return None
    return None


# ----------------------------------------------------------------- 中国天气网

def cn_snapshot(code: str) -> dict:
    """实况。d1.weather.com.cn/sk_2d/{code}.html"""
    t = text_of(fetch_cached("%s/sk_2d/%s.html" % (D1, code), 60))
    return js_obj(t, "dataSK") or {}


def cn_forecast(code: str) -> dict:
    """今日预报 + 预警。d1.weather.com.cn/dingzhi/{code}.html"""
    t = text_of(fetch_cached("%s/dingzhi/%s.html" % (D1, code), 600))
    dz = js_obj(t, "cityDZ" + code) or js_obj(t, "cityDZ") or {}
    al = js_obj(t, "alarmDZ" + code) or js_obj(t, "alarmDZ") or {}
    wi = (dz or {}).get("weatherinfo") or {}
    return {"weatherinfo": wi, "alarm": (al or {}).get("w") or []}


def cn_calendar(code: str, ym: str) -> list:
    """月度逐日历史/预报。d1.weather.com.cn/calendar_new/{year}/{code}_{ym}.html"""
    if not re.fullmatch(r"\d{6}", ym or ""):
        return []
    url = "%s/calendar_new/%s/%s_%s.html" % (D1, ym[:4], code, ym)
    t = text_of(fetch_cached(url, 1800))
    arr = js_obj(t, "fc40")
    return arr if isinstance(arr, list) else []


def cn_search(q: str) -> list:
    """toy1 城市搜索 -> [{code,name,pinyin,province}]，只保留 101xxxxxx 城市码。"""
    url = "http://toy1.weather.com.cn/search?cityname=" + urllib.parse.quote(q)
    t = text_of(fetch_cached(url, 86400)).strip()
    if t[:1] == "(":
        t = t[1:]
    if t[-1:] == ")":
        t = t[:-1]
    try:
        items = json.loads(t)
    except Exception:
        return []
    out = []
    for it in items:
        p = (it.get("ref") or "").split("~")
        if len(p) >= 4 and CODE_RE.match(p[0]):
            out.append({"code": p[0], "pinyin": p[1], "name": p[2], "province": p[-1]})
    return out


# ----------------------------------------------------------------- Open-Meteo 透传
OM_ALLOW = ("/v1/forecast", "/v1/archive", "/v1/air-quality")
# Open-Meteo 的免费额度按主机名分桶：api.open-meteo.com 被限流时
# historical-forecast-api.open-meteo.com 往往还是好的，参数与返回结构完全一致
# （连 past_days + forecast_days 的未来段都照给）。所以主站失败就换它重试一次。
OM_ALT = "https://historical-forecast-api.open-meteo.com"


def om_passthrough(path: str, query: str) -> bytes:
    if path not in OM_ALLOW:
        raise ValueError("path not allowed")
    if path.endswith("archive"):
        hosts = [OM_A]
    elif path.endswith("air-quality"):
        hosts = [OM_AIR]
    else:
        hosts = [OM, OM_ALT]
    last = None
    for host in hosts:
        url = host + path + ("?" + query if query else "")
        try:
            return fetch_cached(url, 900, ref=None, timeout=30)
        except Exception as e:      # 主站 429/超时 → 换备用站再试
            last = e
    raise last if last else RuntimeError("Open-Meteo 不可用")


# ----------------------------------------------------------------- 气象局台风/预警透传
# 白名单：台风列表与路径、预警信号、灾害图层。其余一律拒。
NMC_RE = re.compile(
    r"^("
    r"typhoon/jsons/[A-Za-z0-9_]+"
    r"|fetch_json/[A-Za-z0-9_/]+"
    r"|jsons/[A-Za-z0-9_]+"
    r"|diamond\d+/[A-Za-z0-9_/.-]+"
    r")$"
)


def nmc_passthrough(sub: str, query: str) -> bytes:
    sub = sub.lstrip("/")
    if not NMC_RE.match(sub):
        raise ValueError("path not allowed: %s" % sub)
    url = NMC + "/" + sub + ("?" + query if query else "")
    return fetch_cached(url, 240, ref=None, timeout=25)


# ----------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "TianJiaoSuo/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 工具
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None,
              length: int | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body) if length is None else length))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if getattr(self, "_head_only", False):
            return                      # HEAD 只发响应头，绝不写 body
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def log_message(self, fmt, *a):  # noqa: A003
        if os.environ.get("TJS_VERBOSE"):
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % a))

    # ---- 路由
    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        self._dispatch(head_only=False)

    def do_HEAD(self):  # noqa: N802
        # 前端的「下载客户端」按钮用 HEAD 探测 web/dist/ 里有没有安装包；
        # 不实现这个的话 BaseHTTPRequestHandler 会回 501，按钮就永远不出现。
        self._dispatch(head_only=True)

    def _dispatch(self, head_only: bool):
        u = urllib.parse.urlsplit(self.path)
        p, q = u.path, urllib.parse.parse_qs(u.query)
        self._head_only = head_only
        try:
            if p.startswith("/api/"):
                return self.api(p, q)
            return self.static(p)
        except urllib.error.HTTPError as e:
            self._json({"ok": False, "error": "upstream %s" % e.code, "url": getattr(e, "url", "")}, 502)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 502)

    # ---- API
    def api(self, p: str, q: dict):
        g = lambda k, d="": (q.get(k) or [d])[0]
        code = g("code")
        if p != "/api/health" and not CODE_RE.match(code) and p != "/api/cn/search" \
                and not p.startswith("/api/cma/") and not p.startswith("/api/om/") \
                and not p.startswith("/api/nmc/"):
            return self._json({"ok": False, "error": "bad code"}, 400)

        if p == "/api/health":
            return self._json({"ok": True, "local": True, "web": WEB,
                               "python": sys.version.split()[0], "time": int(time.time())})

        if p == "/api/cn/snapshot":
            return self._json({"ok": True, "code": code, "data": cn_snapshot(code)})

        if p == "/api/cn/forecast":
            return self._json({"ok": True, "code": code, "data": cn_forecast(code)})

        if p == "/api/cn/calendar":
            ym = g("ym", time.strftime("%Y%m"))
            return self._json({"ok": True, "code": code, "ym": ym, "data": cn_calendar(code, ym)})

        if p == "/api/cn/search":
            return self._json({"ok": True, "data": cn_search(g("q"))})

        if p == "/api/cn/full":
            now = time.localtime()
            ym, py = time.strftime("%Y%m"), time.strftime("%Y%m", time.localtime(time.time() - 32 * 86400))
            snap = cn_snapshot(code)
            fc = cn_forecast(code)
            cal = cn_calendar(code, ym)
            prev = cn_calendar(code, py)
            return self._json({"ok": True, "code": code, "ym": ym,
                               "snapshot": snap, "forecast": fc,
                               "calendar": cal, "calendarPrev": prev})

        if p.startswith("/api/cma/"):
            sub = p[len("/api/cma/"):]
            st = g("st")
            if not CMA_ST_RE.match(st):
                return self._json({"ok": False, "error": "bad station"}, 400)
            qs = {"now": "/api/now/" + st,
                  "view": "/api/weather/view?stationid=" + st,
                  "hourly": "/api/hourly/" + st,
                  "climate": "/api/climate?stationid=" + st}
            if sub not in qs:
                return self._json({"ok": False, "error": "no such api"}, 404)
            ttl = int(g("ttl", "120") or 120)
            body = fetch_cached(CMA + qs[sub], max(10, min(ttl, 86400)), ref=None)
            return self._send(200, body, "application/json; charset=utf-8")

        if p.startswith("/api/om/"):
            sub = "/" + p[len("/api/om/"):]
            return self._send(200, om_passthrough(sub, urllib.parse.urlsplit(self.path).query),
                              "application/json; charset=utf-8")

        if p.startswith("/api/nmc/"):
            # 气象局台风/预警：响应是 JSONP 包裹的，原样透传，由前端剥壳
            sub = p[len("/api/nmc/"):]
            body = nmc_passthrough(sub, urllib.parse.urlsplit(self.path).query)
            return self._send(200, body, "application/javascript; charset=utf-8")

        return self._json({"ok": False, "error": "no such api"}, 404)

    # ---- 静态文件
    def static(self, p: str):
        rel = urllib.parse.unquote(p).lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB + os.sep) and full != WEB:
            return self._send(403, b"forbidden", "text/plain; charset=utf-8")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._send(404, "404 Not Found: %s" % rel,
                              "text/plain; charset=utf-8")
        ctype, _ = mimetypes.guess_type(full)
        if ctype is None:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        if getattr(self, "_head_only", False):
            # HEAD 时不把文件读进内存，直接用磁盘大小做 Content-Length
            self._send(200, b"", ctype, length=os.path.getsize(full))
            return
        with open(full, "rb") as f:
            body = f.read()
        self._send(200, body, ctype)


def free_port(prefer: int = 8765) -> int:
    for p in [prefer] + list(range(prefer + 1, prefer + 40)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(port: int = 0, quiet: bool = False) -> tuple[ThreadingHTTPServer, str]:
    """启动服务, 返回 (server, url)。调用方负责 server.serve_forever()。"""
    if not port:
        port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    url = "http://127.0.0.1:%d/" % port
    if not quiet:
        print("天气战士 · 本地服务已启动")
        print("  界面:  %s" % url)
        print("  静态根: %s" % WEB)
        print("  按 Ctrl+C 退出")
    return srv, url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    srv, url = serve(a.port, a.quiet)
    if a.open:
        threading.Timer(0.6, lambda: __import__("webbrowser").open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
