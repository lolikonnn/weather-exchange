# -*- coding: utf-8 -*-
"""
用 GitHub REST API 把 weather-fighter 推上去。

为什么不用 git：本机没有装 git，也没有 gh CLI，而 GitHub 从 2021-08-13 起
不再接受用账号密码做 git push / API 调用，必须用 Personal Access Token。

Token 需要的权限（fine-grained）或 scope（classic）：
    classic : repo, workflow
    fine-grained: Contents=Read&write, Workflows=Read&write, Administration=Read&write,
                  Pages=Read&write（只在开启 Pages 时需要）

用法:
    set GH_TOKEN=ghp_xxx            &  python tools\\push_github.py
    python tools\\push_github.py --token ghp_xxx
    python tools\\push_github.py --token ghp_xxx --repo weather-fighter --message "update"

文件选择规则见 PICK / SKIP —— 与 .gitignore 保持一致，另外把 dist/ 里的
exe 与 apk 一并提交，方便直接从网页下载。
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import webfilter                                    # 哪些 web/ 文件不该发布，见该文件

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.github.com"
UA = "TJS-Weather-Push/1.0"

# 提交的顶层条目（目录递归，文件直接收）
# 注意：这里是个**白名单** —— 顶层新加的文件如果没写进来，push 会一声不响地跳过它。
# 2026-10-06 加了 CHANGELOG.md 才踩到：文件在本地、提交也"成功"了，仓库里就是没有。
PICK = [
    ".github", ".gitignore", "README.md", "CHANGELOG.md",
    "web", "server", "android", "tools", "docs",
]
# android/ 下只提交源码，SDK 与拷贝出来的前端不打进去
SKIP_DIRS = {
    "build", "tmp", "__pycache__", ".git", ".cache", ".cache2", ".cache3",
    ".sdk", "assets", "dist",
}
DIST = ["dist"]          # dist 只挑产物文件，不挑目录里其它东西
DIST_EXT = (".apk",)     # Windows EXE 已放弃（见 README「实现上的坑」）
SKIP_EXT = (".pyc", ".pyo", ".log", ".spec")


# ────────────────────────── HTTP ──────────────────────────
def req(method, path, token, data=None, tries=3):
    url = path if path.startswith("http") else API + path
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
    for attempt in range(tries):
        r = urllib.request.Request(url, data=body, method=method)
        r.add_header("User-Agent", UA)
        r.add_header("Accept", "application/vnd.github+json")
        r.add_header("X-GitHub-Api-Version", "2022-11-28")
        if token:
            r.add_header("Authorization", "Bearer " + token)
        if body:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=90) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                obj = json.loads(raw)
            except Exception:
                obj = {"raw": raw.decode("utf-8", "replace")[:400]}
            # GitHub 的 secondary rate limit 回的是 403/429 + 一段 "secondary rate limit"
            # 说明。它跟"权限不足的 403"长得一样，只能看 message 区分 —— 当成权限问题
            # 直接 sys.exit 的话，一次并发上传打到 320 个文件就会白白丢掉整轮结果。
            msg = json.dumps(obj, ensure_ascii=False).lower()
            throttled = e.code in (429, 502, 503, 504) or (
                e.code == 403 and ("secondary rate limit" in msg or "rate limit" in msg))
            if throttled and attempt < tries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return e.code, obj
        except Exception as e:                      # 网络抖动
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return 0, {"error": str(e)}
    return 0, {"error": "exhausted"}


# ────────────────────────── 文件收集 ──────────────────────────
def collect():
    files = {}          # 仓库内相对路径 -> 本地绝对路径

    def walk(base, rel=""):
        for name in sorted(os.listdir(base)):
            full = os.path.join(base, name)
            r = (rel + "/" + name) if rel else name
            if os.path.isdir(full):
                if name in SKIP_DIRS or name.startswith("."):
                    continue
                walk(full, r)
            else:
                if name.endswith(SKIP_EXT):
                    continue
                files[r] = full

    for top in PICK:
        full = os.path.join(ROOT, top)
        if os.path.isfile(full):
            files[top] = full
        elif os.path.isdir(full):
            walk(full, top)

    for d in DIST:
        full = os.path.join(ROOT, d)
        if os.path.isdir(full):
            for name in sorted(os.listdir(full)):
                if name.lower().endswith(DIST_EXT):
                    files[d + "/" + name] = os.path.join(full, name)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default=os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))
    ap.add_argument("--owner", default="lolikonnn")
    ap.add_argument("--repo", default="weather-fighter")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", default="")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--no-pages", action="store_true")
    a = ap.parse_args()

    files = collect()
    total = sum(os.path.getsize(p) for p in files.values())
    print("待提交 %d 个文件, 合计 %.1f MB" % (len(files), total / 1048576.0))
    big = sorted(files.items(), key=lambda kv: -os.path.getsize(kv[1]))[:6]
    for r, p in big:
        print("   %8.2f MB  %s" % (os.path.getsize(p) / 1048576.0, r))

    if a.dry:
        for r in sorted(files):
            print("   + %s" % r)
        print("\n(--dry 未提交)")
        return

    if not a.token:
        sys.exit("缺少 token：请设置环境变量 GH_TOKEN，或用 --token 传入 Personal Access Token\n"
                 "（GitHub 早已不接受账号密码，密码无法用于 API）")

    # 1) 身份确认
    st, me = req("GET", "/user", a.token)
    if st != 200:
        sys.exit("token 校验失败 (%s): %s" % (st, me))
    owner = a.owner or me["login"]
    print("已认证为 %s (%s)" % (me["login"], owner))
    if me["login"].lower() != owner.lower():
        print("  注意：token 属于 %s，目标 owner 是 %s —— 推送可能会 403。"
              % (me["login"], owner))

    # 2) 建仓库（已存在就跳过）
    st, repo = req("GET", "/repos/%s/%s" % (owner, a.repo), a.token)
    if st == 404:
        st2, repo = req("POST", "/user/repos", a.token, {
            "name": a.repo,
            "description": "天气战士 —— 用看股票的方式看天气（蜡烛图 / 分时 / 日周月K / 五档盘口）",
            "private": a.private,
            "has_issues": True, "has_wiki": False, "has_projects": False,
            "auto_init": False,
        })
        if st2 not in (200, 201):
            sys.exit("建仓库失败 (%s): %s" % (st2, repo))
        print("已创建仓库 %s/%s" % (owner, a.repo))
    elif st == 200:
        print("仓库已存在 %s/%s" % (owner, a.repo))
    else:
        sys.exit("查询仓库失败 (%s): %s" % (st, repo))

    # 3) 取父提交（空仓库 = 全新）
    st, ref = req("GET", "/repos/%s/%s/git/ref/heads/%s" % (owner, a.repo, a.branch), a.token)
    parent = ref["object"]["sha"] if st == 200 else None
    base_tree = None
    if parent:
        st, cm = req("GET", "/repos/%s/%s/git/commits/%s" % (owner, a.repo, parent), a.token)
        if st == 200:
            base_tree = cm["tree"]["sha"]
        print("父提交 %s" % parent[:10])
    else:
        print("空仓库，将创建首个提交")

    # 3.5) 空仓库必须先有一个提交，否则 GitHub 的 Git Data API 会一律回
    #      409 "Git Repository is empty" —— 连 POST /git/blobs 都不让。
    #      这里用 Contents API 种一个占位提交；随后建的 tree 故意不带 base_tree，
    #      所以占位文件不会出现在最终提交里。
    if parent is None:
        st, seed = req("PUT", "/repos/%s/%s/contents/.gitkeep" % (owner, a.repo), a.token, {
            "message": "chore: 初始化仓库",
            "content": base64.b64encode(b"\n").decode("ascii"),
            "branch": a.branch,
        })
        if st not in (200, 201):
            sys.exit("初始化空仓库失败 (%s): %s" % (st, seed))
        st, ref = req("GET", "/repos/%s/%s/git/ref/heads/%s" % (owner, a.repo, a.branch), a.token)
        if st != 200:
            sys.exit("初始化后仍取不到 %s 分支 (%s): %s" % (a.branch, st, ref))
        parent = ref["object"]["sha"]
        print("已用占位提交初始化仓库，父提交 %s（占位文件不进最终提交）" % parent[:10])

    # 4) 上传 blob
    #
    # 串行上传 360 个文件要几分钟，而这条链路（前台跑几分钟的命令）在这个环境里
    # 一定会被会话打断 —— 打断后 blobs 已在 GitHub 上、但没有 commit，
    # 于是"结果未知"，下一次只能从头再来。改成线程池并发：
    # 8 个 worker 把 360 次 HTTPS 往返压到 ~45 轮，几十秒就能跑完，
    # 前台跑得完，也就不用再赌后台作业能不能活过中断。
    # 注意：tree 的顺序在这里无所谓（GitHub 自己会排），但先按 rel 排序收集，
    # 保证同一份输入每次得到同一个 tree 顺序，便于对拍。
    order = sorted(files)
    results = {}

    # blob 缓存：GitHub 的 blob 是**内容寻址**的，同一份内容永远得到同一个 sha，
    # 所以本地按内容哈希记一份 (sha256 -> blob sha) 就能在重试时跳过已经传上去的文件。
    # 上传到一半被限流/被会话打断时，这一条能把下一轮从"重传 359 个"降到"只补剩下的"。
    cache_path = os.path.join(ROOT, "tmp", ".blobcache.json")
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except Exception:
        cache = {}
    cache_hits = [0]

    def upload_one(rel):
        full = files[rel]
        content = None
        if rel.startswith("web/"):
            wr = rel[4:]
            if webfilter.is_probe(os.path.basename(wr)) or webfilter.skip_rel(wr):
                return rel, "SKIP", None
            if wr == "index.html":
                # 把游戏相关的几行摘掉再传；web/index.html 源文件一个字节都不动
                html = open(full, encoding="utf-8").read()
                html, cut = webfilter.strip_game(html)
                if cut:
                    print("  推送时摘掉 index.html 里 %d 行游戏相关内容" % cut)
                content = html.encode("utf-8")
        if content is None:
            with open(full, "rb") as f:
                content = f.read()
        ck = hashlib.sha256(content).hexdigest()
        if cache.get(ck):
            cache_hits[0] += 1
            return rel, "OK", cache[ck]
        st, blob = req("POST", "/repos/%s/%s/git/blobs" % (owner, a.repo), a.token, {
            "content": base64.b64encode(content).decode("ascii"),
            "encoding": "base64",
        })
        if st not in (200, 201):
            return rel, "ERR", (st, blob)
        cache[ck] = blob["sha"]
        return rel, "OK", blob["sha"]

    workers = max(1, int(os.environ.get("PUSH_WORKERS") or 4))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(upload_one, rel): rel for rel in order}
        for done, fut in enumerate(concurrent.futures.as_completed(futs), 1):
            rel, status, payload = fut.result()
            if status == "SKIP":
                continue
            if status == "ERR":
                st, blob = payload
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(cache, f)
                sys.exit("上传 %s 失败 (%s): %s" % (rel, st, blob))
            results[rel] = payload
            if done % 40 == 0 or done == len(order):
                print("  已上传 %d/%d（缓存命中 %d）" % (done, len(order), cache_hits[0]))

    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache, f)

    tree = [{"path": rel, "mode": "100644", "type": "blob", "sha": results[rel]}
            for rel in order if rel in results]

    # 4.5) 删掉仓库里已经不该存在的文件
    #      用 base_tree 建树是"在旧树上打补丁"，本地删掉的文件不会跟着从仓库消失。
    #      真实踩到的坑：改名前的 天交所-天气行情终端.exe（9.25 MB）一直留在 dist/，
    #      而且它旁边还有旧名的 .apk，导致 CI 里 `cp -f dist/*.apk ...` 的 glob 一次
    #      匹配到两个 apk，cp 直接报错、又被 `|| echo` 吞掉 —— Pages 上的下载链接 404。
    #      Git Data API 里 sha=None 就是"删这个路径"，所以这里把「仓库有、本地没有」
    #      的全部删掉，让仓库严格等于本地要发布的文件集合。
    if base_tree:
        st, tinfo = req("GET", "/repos/%s/%s/git/trees/%s?recursive=1"
                        % (owner, a.repo, base_tree), a.token)
        if st == 200:
            remote = set(i["path"] for i in tinfo.get("tree", [])
                         if i.get("type") == "blob")
            stale = sorted(remote - set(files))
            for rel in stale:
                tree.append({"path": rel, "mode": "100644", "type": "blob", "sha": None})
            if stale:
                print("  删除仓库里多余的 %d 个文件" % len(stale))
                for rel in stale[:12]:
                    print("    - %s" % rel)
                if len(stale) > 12:
                    print("    … 以及另外 %d 个" % (len(stale) - 12))
        else:
            print("  ! 读取远端文件列表失败 (%s)，跳过清理" % st)

    # 5) 建 tree
    payload = {"tree": tree}
    if base_tree:
        payload["base_tree"] = base_tree
    st, newtree = req("POST", "/repos/%s/%s/git/trees" % (owner, a.repo), a.token, payload)
    if st not in (200, 201):
        sys.exit("建 tree 失败 (%s): %s" % (st, newtree))

    # 6) 建 commit
    msg = a.message or "天气战士: 同步前端 / 数据集 / 打包产物"
    cdata = {"message": msg, "tree": newtree["sha"]}
    if parent:
        cdata["parents"] = [parent]
    st, commit = req("POST", "/repos/%s/%s/git/commits" % (owner, a.repo), a.token, cdata)
    if st not in (200, 201):
        sys.exit("建 commit 失败 (%s): %s" % (st, commit))
    print("提交 %s" % commit["sha"][:10])

    # 7) 更新分支
    if parent:
        st, upd = req("PATCH", "/repos/%s/%s/git/refs/heads/%s" % (owner, a.repo, a.branch),
                      a.token, {"sha": commit["sha"], "force": False})
    else:
        st, upd = req("POST", "/repos/%s/%s/git/refs" % (owner, a.repo), a.token,
                      {"ref": "refs/heads/" + a.branch, "sha": commit["sha"]})
    if st not in (200, 201):
        sys.exit("更新分支失败 (%s): %s" % (st, upd))
    print("分支 %s 已更新" % a.branch)

    # 8) 开 Pages（Actions 方式）
    if not a.no_pages:
        st, pages = req("GET", "/repos/%s/%s/pages" % (owner, a.repo), a.token)
        if st == 200:
            print("Pages 已启用: %s" % (pages.get("html_url") or pages.get("url")))
        else:
            st2, p2 = req("POST", "/repos/%s/%s/pages" % (owner, a.repo), a.token,
                          {"build_type": "workflow"})
            if st2 in (200, 201):
                print("已启用 Pages (workflow 方式)")
            else:
                print("启用 Pages 失败 (%s): %s" % (st2, p2))
                print("  可以到 Settings -> Pages -> Build and deployment -> Source 选 'GitHub Actions'")

    print("\n仓库: https://github.com/%s/%s" % (owner, a.repo))
    print("站点: https://%s.github.io/%s/  （首次部署要等 Actions 跑完，约 1-2 分钟）"
          % (owner.lower(), a.repo))


if __name__ == "__main__":
    main()
