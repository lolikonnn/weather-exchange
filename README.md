<div align="center">

# 天气战士 · 老实看天气预报，很枯燥吧？

**用看股票的方式看天气**

蜡烛图 · 分时走势 · 日/周/月 K 线 · 五档盘口 · 成交明细 · 自选城市 · 行情刷新频率

网页版 · Android APK

[**lolikonnn.github.io/weather-fighter**](https://lolikonnn.github.io/weather-fighter/)

</div>

> **改名说明**：仓库原叫 `weather-exchange`，已改名为 **`weather-fighter`**。
> 旧网址 `https://lolikonnn.github.io/weather-exchange/` 现在是 **404** —— GitHub Pages
> 不会跟着仓库改名做路径跳转，请换用上面的新地址。

---

![界面预览](docs/screenshots/scope.png)

> 上图：分时走势（当日逐小时气温 + 均价线 + 昨收基准线），左侧自选/热门城市，右侧「未来 5 天高低温」与「每小时气温流水」。

### 界面预览

| 分时走势 | 日 K + 温差 |
| --- | --- |
| ![分时走势](docs/screenshots/shot.png) | ![日K](docs/screenshots/kday.png) |

| 降水副图（日 K · 按天聚合） | 风副图（周 K · 按周聚合） |
| --- | --- |
| ![降水副图](docs/screenshots/sub-precip.png) | ![风副图](docs/screenshots/sub-wind.png) |

| 空气副图（日 K · 按天聚合） | 雷达回波（八个大区） |
| --- | --- |
| ![空气副图](docs/screenshots/sub-air.png) | ![雷达回波](docs/screenshots/radar.png) |

| 卫星云图 | 降水预报 |
| --- | --- |
| ![卫星云图](docs/screenshots/sat.png) | ![降水预报](docs/screenshots/precip.png) |

| | |
| --- | --- |
| ![五日明暗带](docs/screenshots/bands.png) | ![副图叠加到主图](docs/screenshots/overlay.png) |

> 上左：五日图按自然日铺**明-暗交替**的底色（三明两暗，一眼看出一天一天的界限），紫色 PM2.5 线叠在主图上。
> 上右：日 K 上叠加**降水量线**（青色，走最右侧第 3 根 Y 轴）；副图口径随时可用「📈 叠到主图」按钮拉到主图。

| 台风路径 | 预警信号 |
| --- | --- |
| ![台风路径](docs/screenshots/ty.png) | ![预警信号](docs/screenshots/warn.png) |

| 术语对照表 | 手机竖屏 · 自选 |
| --- | --- |
| ![术语对照表](docs/screenshots/help.png) | ![手机自选](docs/screenshots/phone-main.png) |

| 手机竖屏 · 台风 | 手机竖屏 · 雷达（按省自动选中华南） |
| --- | --- |
| ![手机台风](docs/screenshots/phone-ty.png) | ![手机雷达](docs/screenshots/phone-radar.png) |

> 桌面截图 1600×1000。手机截图是 **390×844 的真实手机视口**，不是把桌面版缩小出来的。
> （注意：Windows 上无头 Chrome 会把 `--window-size=390,844` 悄悄夹到约 500px 宽，
> 然后只截左边 390px —— 那样得到的"手机截图"右侧是被裁掉的，不能用。要量真手机布局，
> 必须把页面装进一个 390px 宽的 iframe 里。）

## 这是什么

一个把**气温当成股价**来展示的天气软件。整个交互、配色、术语都照搬 A 股行情终端：

| 股票里的东西 | 这里对应什么 |
| --- | --- |
| 股票代码 | 城市代码（中国天气网的 `101010100` 这类 9 位码） |
| 最新价 / 涨跌幅 | 当前气温 / 相对昨日同一时次的变化 |
| 分时图 | 今天 00:00–23:00 的逐小时气温，含均价线、昨收虚线 |
| 日 K / 周 K / 月 K | 每天的开盘价 = 当日 00:00 气温，收盘价 = 当日 23:00 气温，最高/最低 = 当日极值 |
| 成交量（现在叫「温差」） | 日内最高温 − 最低温；底部副图页签可切到 **降水 / 风 / 云量 / 空气** |
| MA5 / MA10 / MA20 / MA60 | 最近 5 / 10 / 20 / 60 天的平均气温，看大方向 |
| MACD / KDJ / RSI / BOLL / WR | **已经删掉了** —— 这几个股票指标对看天气没用，换成了下面「天气功能」里的真东西 |
| 五档盘口（卖五~卖一 / 买一~买五） | 未来 5 天的**预报最高温**（卖盘，由高到低）与**预报最低温**（买盘，由低到高） |
| 成交明细 / 逐笔 | 最近 60 个逐小时观测，涨跌按对上一时次着色 |
| 自选股 | 自选城市，可增删、可按涨幅或名称排序 |
| 行情刷新频率 | 1s / 3s / 5s / 10s / 30s / 1m / 5m / 手动 |
| 涨跌配色 | 红涨绿跌（A 股）/ 绿涨红跌（美股）一键切换 |

## 天气功能

炒股软件的长相下面，装的是气象台真正会给的东西。顶栏那一排按钮就是入口：

| 按钮 | 打开什么 | 数据源 |
| --- | --- | --- |
| 🛰 雷达回波 | 雷达拼图，**三层可选**：全国 → 八大区（东北／华北／华东／华中／华南／西北／西南）→ **单站（精确到城市）**。打开时按当前城市自动定位（在广州就自动是「华南 · 广东 · 广州单站雷达」）。每 6 分钟一帧，可拖滑块也可自动播放，能回看约 30 小时 | `image.nmc.cn` 中央气象台雷达拼图 |
| ☁ 卫星云图 | 气象卫星云图，**两种产品可切**：**真彩云图**（风云四号 B 星，默认档，白天最好看）/ 红外云图（风云二号，每 30 分钟一张）。能回看一天 | `image.nmc.cn` 国家卫星气象中心 `WXBL` / `WXCL` |
| 🌧 降水预报 | 中央气象台全国降水量预报图，**两种产品可切**：**最近 1 小时实况**（默认档，每小时一张）/ 未来 24 小时预报（每 12 小时一张） | `image.nmc.cn` `STFC_SFER_ER1` / `STFC_SFER_ER24` |
| 🌀 台风路径 | 西北太平洋活动台风的实时路径 + 中央气象台 120 小时预报路径。底图是「亚洲–太平洋」，中国和台风同框，看得出台风往哪走 | `typhoon.nmc.cn` |
| ⚠ 预警信号 | 全国生效中的气象预警，按颜色分级，含发布单位与完整正文 | `typhoon.nmc.cn` 预警接口 |
| 📍 我附近 | 用浏览器定位找到最近的城市并切过去。**坐标换算全在本机做，不往任何服务器发位置** | 浏览器 Geolocation |

> **只有雷达能做到城市级**：气象局除了全国拼图和八大区拼图，还发布每个雷达站自己的产品
> （`image.nmc.cn/.../RDCP/..._ECREF_AZ####_...`，图上自带压字「雷达站名 / 数据范围 / 观测时间」）。
> 45 个城市里有 **30 个**能匹配到独立站（清单见 `web/data/radar-cities.json`），剩下的
> （珠海、佛山、惠州、东莞、中山、江门、株洲、湘潭、娄底、上海、呼和浩特、拉萨、香港、澳门、台北）
> 自动回落到所在大区拼图。
>
> **云图和降水预报官方只有全国版**，没有区域版，所以这两页是「全国图 + 按城市对齐时次」，
> 不能像雷达那样放大到城市。这也是把它们默认档改成「真彩云图 / 最近 1 小时实况」的原因 ——
> 既然放不大，就默认给最新最清晰的那张。
>
> 台风是路径图不是图片，点列表里任意台风就能看它的轨迹。

底部副图页签从股票的 MACD / KDJ / RSI / BOLL / WR 换成了五个天气口径，
而且**每个都跟着上面选的主图周期走**：

| 页签 | 画什么 |
| --- | --- |
| 温差 | 日内温差（最高 − 最低） |
| 降水 | 降水量柱（左轴 mm）+ 降水概率线（右轴 %） |
| 风 | 风速柱（按蒲福风级着色）+ 阵风虚线 + 顶部风向箭头 |
| 云量 | 低云 / 中云 / 高云堆叠面积 + 总云量线 |
| 空气 | PM2.5 柱 + AQI 线（含「良 100」参考线） |

副图右侧还有一个 **「📈 叠到主图」** 按钮：把当前副图的口径**拉一条线画到上面的主图**上
（降水 → 青色降水量线、风 → 绿色风速线、云量 → 灰蓝云量线、空气 → 紫色 PM2.5 线）。
这条线走主图**最右侧的第 3 根 Y 轴**（`offset:44`），不跟百分比轴抢刻度；按钮状态会记在
`localStorage` 里，副图切回「温差」时自动置灰。口径与主图对齐**统一按时间键查表**，不是按下标 ——
按下标会在「分时/五日」上整体错位（主图是「今天 24 小时 / 昨天→未来三天」，而聚合序列是
「从现在往前 2 小时起 24 小时」）。

> **日界明暗带**：五日 / 多日折线图按自然日铺**明-暗交替**的底色（5 天 = 三明两暗），
> 并在每条日界画竖虚线，一眼能看出一天一天的界限。单日分时（只有一天）不铺带。
> 带子挂在一条不画线的独立系列上（`z:1`），保证永远在气温线和均价线之下。

选**分时**就是今天的逐小时，选**五日**就是逐小时 120 个点，选**日 K** 就按天聚合最近 60 天，
选**周 K / 月 K** 就按周 / 按月，选**预报 K** 就是未来 16 天。聚合口径按物理量定：
降水量**求和**、降水概率取**最大**、风速阵风取**最大**、云量和 PM2.5/AQI 取**平均**；
风向不能平均，取「风最大的那一刻」的风向。

周期页签的「五日」口径是 **昨天 + 今天 + 未来三天**（共 120 个逐时点）——
天气预报最要紧的就是后面这三四天，所以窗口是往前压的，不是往回看。

> 雷达 / 云图 / 降水预报这三张是**图片**，文件名里的时次戳是 **UTC**（不是北京时间），
> 前端按 `floor(分钟/6)*6`（雷达）、`:15 / :45`（云图）、整点（降水实况）对齐到官方出图的
> 整点网格，再换算成本地时区显示。界面上的时次和图上自带的压字时间戳是对得上的 ——
> 这是这套时间换算正确的硬证据。

## 三个版本

| 形态 | 说明 | 需要什么 |
| --- | --- | --- |
| **网页版** | [lolikonnn.github.io/weather-fighter](https://lolikonnn.github.io/weather-fighter/) | 一个现代浏览器 |
| **Android APK** | `dist\天气战士.apk`，`minSdk 21` | Android 5.0+ |

两个版本界面**完全相同**，区别只在数据怎么取（见下）。

想在电脑上用，直接开网页版即可 —— 它是纯静态的，可以「添加到主屏幕 / 固定到任务栏」当应用用。
（曾经还有一个 Windows EXE，已经**放弃并删除**：PyInstaller 单文件版每次启动都要往 `%TEMP%` 解压，
在部分机器上被安全软件挡住就起不来，收益配不上这个维护成本。）

### 直接下载

网页版打开后，**右下角状态栏**会出现「下载客户端」按钮（只有在安装包真的存在时才显示，点了不会 404）：

| 平台 | 直链 |
| --- | --- |
| Android | <https://lolikonnn.github.io/weather-fighter/dist/weather-fighter-android.apk> |

> `web/dist/` 不提交进仓库。部署时 `.github/workflows/deploy.yml` 会把 `dist/` 里的安装包
> 拷成上面这个 **纯 ASCII 文件名**再发布 —— 中文文件名在 CDN 和各浏览器里的百分号编码
> 行为不一致，用别名能保证链接到处都点得通，下载下来的文件名也不会乱码。
> 仓库里的原始文件仍是 `dist\天气战士.apk`。

## 数据从哪来

本项目**不生产数据**，只是把公开的官方天气数据画成 K 线。

| 数据 | 来源 | 授权 |
| --- | --- | --- |
| 实况观测、7 天预报、15/40 天趋势、预警、历史同期气候均值 | **中国气象局 / 中国天气网**（`weather.cma.cn`、`d1.weather.com.cn`、`www.weather.com.cn`、`nmc.cn`） | 数据版权归中国气象局所有 |
| 历史逐小时气温（用来算真实 OHLC）、全球城市坐标、无官方站号城市的实况兜底 | **Open-Meteo**（ERA5 再分析） | CC-BY-4.0，非商业免费 |

### 为什么需要"三级取数"

`d1.weather.com.cn` 会**强制校验 `Referer` 必须是 `weather.com.cn`**，浏览器里补不了这个头；
`weather.cma.cn` 又会在非浏览器 UA 下返回 `406`。所以前端按下面的顺序依次尝试，谁通用谁：

```
① 本地代理（APK 自带 / 本地调试用）  →  服务端补 Referer / UA，最稳
② 浏览器直连                  →  网页版走这条；weather.cma.cn 有 CORS 头，d1 拿不到
③ 静态兜底 data/official/**   →  GitHub Actions 每 30 分钟预抓并提交的 JSON
```

网页版因此是 ② + ③：能直连的就直连，拿不到（比如 d1 的官方预报）就读仓库里 Actions 刚抓好的快照。

## 城市范围

当前收录 **45 个城市**（在 `tools/scope.py` 里定义，随时可改）：

- **广东珠三角 9 市**：广州、深圳、珠海、佛山、惠州、东莞、中山、江门、肇庆
- **湖南长株潭 + 娄底**：长沙、株洲、湘潭、娄底
- **省会 / 直辖市 / 特别行政区 / 台北**：北京、天津、上海、重庆、石家庄、太原、呼和浩特、沈阳、长春、哈尔滨、南京、杭州、合肥、福州、南昌、济南、郑州、武汉、南宁、海口、成都、贵阳、昆明、拉萨、西安、兰州、西宁、银川、乌鲁木齐、香港、澳门、台北

其中 40 个有中国气象局官方站号，5 个（佛山、惠州、江门、肇庆、香港）走 Open-Meteo 实况，界面上会标"无官方站号"。

想加城市：改 `tools/scope.py` 的列表，然后跑 `python tools\scope_cities.py --restore` 还原完整数据、再 `python tools\scope_cities.py` 重新裁剪。

## 快速开始

### 网页版

直接打开 <https://lolikonnn.github.io/weather-fighter/>。

本地跑：因为前端用 `fetch` 读 `data/cities.json`，**不能直接双击 `index.html`**（`file://` 会被同源策略拦），要起个静态服务：

```bash
cd weather-fighter
python server/app.py            # 打开 http://127.0.0.1:8765/
```

`server/app.py` 同时是本地代理，所以本地跑起来的数据最全（跟 APK 一样）。

只想起个本地服务、不开浏览器窗口：

```bash
python server/app.py --port 8765 --quiet
```

### Android APK

```
dist\天气战士.apk
```

传到手机上安装（需要允许"安装未知来源应用"）。APK 自带 Java 侧代理，
所以官方预报、预警这些必须带 Referer 的数据在手机上也拿得到。

## 自己构建

环境要求：**Python 3.10+**；打 APK 额外需要 **JDK 11+**（本项目用 `D:\Java`，JDK 23）。

```bash
cd weather-fighter

# 1) 重建城市数据集（联网，会用 tools/.cache3 缓存）
python tools\resolve_cities.py --workers 8
python tools\scope_cities.py                 # 裁剪到 45 城

# 2) 预抓中国天气网官方数据（供 Pages 静态兜底）
python tools\prefetch_official.py --workers 8

# 3) Android APK（无需 Gradle）
python tools\fetch_android_sdk.py            # 下载 build-tools 34 + platform 35
python tools\make_icon.py                    # 生成各密度启动图标
python tools\build_apk.py                    # -> dist\天气战士.apk

# 4) 冒烟测试 20 个端点
python tools\smoke.py
```

## 发布到自己的仓库

这台机器上通常没有装 `git`，而 GitHub 从 2021-08-13 起就不再接受账号密码做 API 调用，
所以推送走 **GitHub REST API（Git Data API）**，只需要一个 Personal Access Token：

1. <https://github.com/settings/tokens/new>
2. 勾 **`repo`**（必需）+ **`workflow`**（必需，否则 `.github/workflows/` 下的文件会被拒收）
3. 生成后：

```powershell
$env:GH_TOKEN = "ghp_xxxxxxxx"          # 也可以直接 --token 传
python tools\push_github.py --dry       # 先看要传什么（310 个文件 / 14.9 MB）
python tools\push_github.py             # 建仓库 -> 传文件 -> 提交 -> 开 Pages
```

推送完 Pages 会自动开始构建（`.github/workflows/deploy.yml` 首次由 `push` 事件触发）。
大约 1~2 分钟后站点在 `https://<你的用户名>.github.io/weather-fighter/`。

> **仓库必须是 public**：免费账号的 Pages 不支持私有仓库（私有仓库开 Pages 需要 GitHub Pro）。

## 数据自动更新

`.github/workflows/deploy.yml` 每 30 分钟跑一次：

1. `tools/prefetch_official.py` 带着正确的 `Referer` / `UA` 抓中国天气网与气象局的数据，写进 `web/data/official/`
2. 有变化就 `git commit && git push`
3. 把 `web/` 整个发布到 GitHub Pages

> 抓数据和部署**必须写在同一个 workflow 里** —— 用 `GITHUB_TOKEN` 推送产生的 commit
> 不会触发其它 workflow，拆成两个文件的话 Pages 永远不会更新。

## 验证过的行为

三条取数路径都实际跑过，不是"应该能跑"：

| 场景 | 怎么复现 | 结果 |
| --- | --- | --- |
| **本地代理**（APK / 本地调试） | `python server\app.py --port 8765` 然后 `python tools\smoke.py` | 20/20 端点 200 |
| **GitHub Pages**（无代理、浏览器直连） | 见下方"子路径复现" | 报价头部 / 日K / 未来 5 天高低温 / 逐时气温流水 / 自选全部正常；雷达、云图、降水预报、台风、预警、我附近六个功能页全部出图；`window.__errs` 为空。走**静态预抓**这一级 |
| **APK 里的 Java 解析器**（本机没有设备也能测） | `python tools\test_apk_parser.py` | 25 项断言全过，见下方"没有手机怎么测 APK" |

`?local=0` / `?local=1` 是专门为上面第二行加的开关 —— 在本地一条命令就能复现 Pages 的取数路径，
不用真的等部署。

**子路径复现（重要）**：Pages 上线后站点在 `https://<user>.github.io/weather-fighter/`，
是**带子路径**的，绝对路径 `/js/app.js` 这种写法会直接 404。所以 `web/` 里所有静态资源引用
（`data/cities.json`、`data/official/**`、`vendor/echarts.min.js`、`dist/weather-fighter-*.apk`）
**都是相对路径**，只有 `/api/*` 是绝对路径（那是本地代理专用，在 Pages 上注定 404 并被 catch 掉）。

这一条也实测过 —— 用目录联接把站点挂到 `/weather-fighter/` 下再跑无头浏览器：

```powershell
$root = "$PWD\tmp\pages-root"          # 用绝对路径：New-Item -ItemType Junction 会静默失败，必须用 mklink /J
cmd /c mklink /J "$root\weather-fighter" "$PWD\web"
python -m http.server 8767 --bind 127.0.0.1 --directory $root
# 浏览器打开 http://127.0.0.1:8767/weather-fighter/?local=0&city=101280101&p=day&ind=macd
```

> **坑**：目录联接只能用 `cmd /c mklink /J` 建 —— `New-Item -ItemType Junction` 在 PowerShell 5.1 下
> 对含中文/长路径的目标会**返回成功但什么都不建**，之后 `http.server` 就一直 404。

结果：`#qPrice 24.1`、`#qChange +1.2`、`#qPct +5.24%`、`#chartHint "MA5 21.9 …"`、
28 行预报、8 个 canvas、`window.__errs` 为 `[]`。

## 没有手机怎么测 APK

本机没有 `adb`、也没有连过任何安卓设备，所以"装到手机上"这一步没法自动化。
退一步，**把最容易出错的那部分单独拎出来在 PC 上跑**：APK 里真正容易被改坏的，是
`MainActivity` 里那些把中国天气网的文件解析成 JSON 的 Java 代码（正则、编码、`var` 前缀剥离）。

- `tools\test_apk_parser.py` 直接 `subprocess` 调 `D:\Java\bin\javac` / `java`，把
  `android\test\TjsParseTest.java` 编出来跑，喂进真实的抓取内容，**25 项断言**覆盖：
  `var cityDZ101010100 ={...}` 的 `var` 剥离、GBK 解码、`sk_2d` / `dingzhi` / `calendar_new`
  三种文件形态、`oot` 字段空缺、以及台风 JSONP 的双层括号。
- `android\test\` 只进仓库、**不进 APK**（`build_apk.py` 的 `SKIP_ASSET` / 编译清单都不含它）。

其余部分（WebView 装载、拦截器路由、签名）只能靠真机验证 —— 这一点在下面的
「已知限制」里如实写着。

## 目录结构

```
weather-fighter/
├── web/                     前端（纯静态，无构建步骤）
│   ├── index.html           同花顺风格的行情终端
│   ├── css/app.css          深色皮肤、配色令牌（body.us 一键翻转红绿）
│   ├── js/util.js           工具函数、格式化、配色、股市话术
│   ├── js/indicators.js     MA/EMA/MACD/KDJ/RSI/BOLL/WR + 周月聚合
│   ├── js/api.js            三级取数、缓存、城市索引
│   ├── js/chart.js          ECharts 主图/副图（十字光标联动）
│   ├── js/weather.js        雷达/云图/降水预报/台风/预警取数 + 时间网格对齐
│   ├── js/wxui.js           六个天气功能页的 UI（播放器、台风轨迹、预警列表）
│   ├── js/app.js            状态机、渲染、轮询、搜索、抽屉
│   ├── data/cities.json     45 城数据集（代码/坐标/站号/拼音）
│   ├── data/cities.full.json 未裁剪的 352 城全量（备份）
│   ├── data/china.json      省级底图（指数条 / 台风底图兜底）
│   ├── data/world.json      亚洲–太平洋裁剪底图，154 KB（台风页专用，首开才加载）
│   ├── data/official/       Actions 预抓的官方数据
│   ├── img/logo.png         站标（由 tools/logo-src.png 生成）
│   └── vendor/echarts.min.js
├── server/app.py            本地代理 + 静态服务（APK 用同一套解析逻辑）
├── android/                 Java 代理 + 清单 + 资源（不走 Gradle）
├── tools/                   数据集构建、预抓、打包脚本
│   ├── slim_world.py        把 echarts world.json 裁成 data/world.json
│   ├── make_icon.py         从 logo-src.png 生成站标与五种密度的 launcher 图标
│   ├── logo-src.png         站标源图（**故意不放在 web/ 下**，否则 1.2 MB 会被打进 APK）
│   ├── test_apk_parser.py   在 PC 上单测 APK 里的 Java 解析器
│   └── build_apk.py         手工 aapt2 + d8 + apksigner 打包
└── dist/                    产物
```

## 一些实现上的坑（给后来的人）

- **d8 崩在非静态内部类上**：`build-tools 34` 的 R8 8.2.2 处理"继承 `android.jar` 里某个类、
  且带合成 `this$0` 字段的嵌套类"时抛 `NullPointerException: Cannot invoke "String.length()"`。
  必须把 `WebViewClient` 子类写成 `private static class` 并持有外部引用。javac 也要用 `--release 8`
  （Java 9+ 的 `invokedynamic` 字符串拼接 R8 处理不了）。
- **`aapt2 link` 的资源包必须用位置参数**：写成 `-R res.zip` 会被当成 overlay，报
  `resource string/app_name does not override an existing resource`。
- **不再做 Windows EXE**：PyInstaller 单文件版每次启动都要往 `%TEMP%` 解压，在锁住临时目录的机器上直接起不来（`Could not create temporary directory!`）。相关产物与 `tools/build_exe.py`、`desktop/` 已删除，历史版本见 git 提交 `d6418f71dc`。
- **不要用 pywebview**：onefile 里必定挂在 `pythonnet` → `clr_loader`
  （`Failed to resolve Python.Runtime.Loader.Initialize`）。用浏览器的 `--app=` 模式更稳。
- **浏览器直连 `weather.cma.cn` 会失败**（`TypeError: Failed to fetch`），而
  `no-cors` 又是 opaque，Python `urllib` 带浏览器 UA 则正常 200。原因未明，所以必须有代理层。
- **气象局的图片文件名用 UTC，不是北京时间**：`image.nmc.cn` 上雷达 / 云图 / 降水预报的
  时次戳都是 UTC。按北京时间去拼文件名会 100% 404。显示时用本地 getter 自动变回北京时间，
  和图上自带的压字时间戳一致。
- **八个雷达大区里只有`ACHN`（全国）有 `small/` 和 `medium/` 档**：`image.nmc.cn/product/.../RDCP/`
  下 `small/` 只有全国拼图有（约 200 KB），东北 / 华北 / 华东 / 华中 / 华南 / 西北 / 西南
  七个大区**只有原图**（每帧 479–960 KB）。所以判定要写成"只有 `ACHN` 用 `small/`"，
  而且切到大区时每帧大得多，一次别取太多帧。
- **气象局的 JSONP 剥壳层次不统一**：`/typhoon/jsons/list_default` 是 `fname(({...}))`（两层括号），
  `/typhoon/jsons/view_{id}` 是 `fname({...})`，`/fetch_json/warning/json` 是 `fname([[...]])`。
  只剥一层会在 `JSON.parse` 上炸 `Unexpected token '('`。要逐个候选试解析，谁成功用谁。
- **无头 Chrome 会把窄窗口夹到约 500px 宽**：Windows 上传 `--window-size=390,844`，
  实际页面按 ~500px 排版，而截图只画左边 390px。看着像"手机版右侧被裁掉"，
  其实是**截图工具**的问题，不是 CSS。要验真手机布局，必须把页面塞进 390px 宽的 iframe 再量。
- **Open-Meteo 的 air-quality 接口不接受 `past_days` 与 `forecast_days` 同时出现**：
  两个都给直接 `400 Bad Request`。只给 `past_days=92` 时它自己会带上 92 天历史 + 5 天预报，
  足够画日 K / 周 K。气象主接口没这个限制，可以两个都给。
- **参数名写错会被默认值静默兜住，界面看起来"毫无变化"**：副图接周期时写成了 `S.p`，
  而状态里存的是 `S.period`，`undefined` 落进 `period = period || 'trend'` 又不报错，
  于是日 K / 周 K 的副图全都还是分时，白验一轮。这种失败模式只能靠**前后截图对比**发现，
  改完参数接线一定要重拍一张对比，不能只看"页面没报错"。
- **横排的 segmented 按钮要 `flex:none` + `white-space:nowrap`**：否则窄屏上按钮会被压扁，
  把「华南」这种两字标签折成两行，整条工具栏高度翻倍。
- **别用 `python -c "..."` 从 PowerShell 传含引号的脚本**：PS 会把内层双引号吃掉，
  Python 收到 `open(p,encoding=utf-8)` 这种残缺代码 → `SyntaxError`。
  改文件要么写成 `.py` 再跑，要么用 `[IO.File]::ReadAllText` + `.Replace()` + `WriteAllText`。
- **A 股配色反转必须靠 CSS 变量**：`body.us` 只是把 `--up` / `--down` 两个变量的值对调，
  所有图表和列表都读变量，就不用改 JS。
- **单站雷达没有任何入口页**：气象局的雷达产品有三层，全国拼图 `chinaall.html` 和八个大区
  都在导航里有链接，**独独第三层「单站雷达」没有入口** —— `chinaall.html` 里只链了全国、
  八个大区，外加北京大兴一个样例。其它城市的页面只能靠拼 slug 猜：
  `/publish/radar/{省拼音}/{市拼音}.htm`（`guang-dong/guang-zhou.htm`、`hei-long-jiang/ha-er-bin.htm`、
  直辖市是 `tian-jin/tian-jin.htm`）。所以有了 `tools/radar_slugs.py`：用 pypinyin 生成候选、
  逐个探测、把命中的写进 `web/data/radar-cities.json` 供前端读（45 城命中 30）。
  站号形如 `AZ9200`，图片是 `image.nmc.cn/product/{Y}/{m}/{d}/RDCP/{tier}SEVP_AOC_RDCP_SLDAS3_ECREF_AZ####_L88_PI_{ts}00000.PNG`。
- **`if (!x)` 改成 `if (x === undefined)` 是会出事的**：雷达抽屉的 `open()` 原来传
  `openRadar(this._radarReg)`，首次打开时 `_radarReg` 是 `null`；我把守卫从「假值判断」
  收窄成 `region === undefined` 之后，`null` 不再命中，于是跳过了「按城市自动选区」，
  直接拿 `region = null` 去拼 URL，每一帧都变成 `..._ECREF_null_...` 全 404，
  界面显示的是"中国气象局该时段没有发布"——**一个纯前端的逻辑错误伪装成了数据源故障**。
  教训：收窄相等性判断时，先想清楚所有"没有值"的表示（`undefined` / `null` / `''` / `0`）
  分别会走到哪。

## 免责声明

本项目仅用于学习与技术演示。天气数据来自中国气象局 / 中国天气网与 Open-Meteo，
版权归各自所有；本项目不保证数据准确性，**请勿用于任何生产或安全决策**。
"K 线""涨跌"等只是可视化隐喻，气温不是证券。
