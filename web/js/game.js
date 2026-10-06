/* ═══════════════════════════════════════════════════════════════
   game.js — 「点击做空天气」：拿真实天气当行情，15 分钟一根 K 线
   ═══════════════════════════════════════════════════════════════

   设计要点（改之前先读）：

   ① **标的是「天气指数 WXI」，不是气温本身**。
      这里踩过一次坑：第一版直接拿气温当价格，结果被吐槽「太稳定了，没有
      什么感觉，只要稳住总会升 / 降的」—— 因为气温有昼夜循环和季节趋势，
      抱着不动就能赢，盘感无从谈起。
      气温一小时才挪一两度，做成 K 线就是一条几乎水平的线。
      真正有波动的是**对流**：CAPE（对流有效位能）能从 0 冲到 5000、
      阵风能从 2 m/s 冲到 60 m/s、降水绝大多数时刻是 0、打雷时才爆。
      所以指数由这几项加权而成，**打雷下雨 = 拉升，天气转好 = 回落**。

   ② **价格是「趋势 + 噪声 + 突发行情」的组合**，不是原始指数：
          trend = EMA(sev, 0.05)                       // 慢分量，给方向
          shock = (|Δsev| − 0.9) × 34,  仅当 |Δsev| > 0.9 // 单根剧烈变化 → 一记冲击
          carry = carry × 0.78 + shock                 // 冲击的余波，顺着惯性再走几根
          price = 1000 + (trend − median(trend)) × 50  // 趋势放大，走得出行情
                       + (sev − trend) × 16            // 快分量，给盘中抖动
                       + carry                         // 突发行情
      系数是拿真数据调出来的（广州 / 哈尔滨 92 天实测）：
      单根 15 分钟中位涨跌 0.17%、p99 约 5~6%、单日振幅中位 9~11%、
      连续 3 根的最大跌幅中位 7.8%（哈尔滨能到 15%）。既走得动，又不会变成纯随机数。

      **`shock` 不是随机数** —— 触发条件是真实观测到的剧烈变化（CAPE 炸了、
      阵风猛增、开始下暴雨）。没有真实天气过程的时候，盘面就是平静的；
      久留美里那种「蜡烛图突然拉到底」，背后是真有一次对流爆发。

   ③ **行情是真的，但只有「K 线实体」是真采样出来的**。
      数据是 Open-Meteo 的 minutely_15（15 分钟一个点，92 天历史）。
      开盘价 = 上一根收盘价，收盘价 = 本根指数，这两个都是真值；
      上下影线按 |本根涨跌| × 0.3 建模 —— 15 分钟粒度拿不到根内的真实最高最低，
      只能这样近似。README 里写明了，别对外说影线也是实测。

   ④ **只用「现在」之前的段**。`i0` 是当前时刻在数组里的下标，取样只在其前，
      绝不碰预报段。界面上只显示「第 3 天 14:15」，不给真实日期 —— 否则
      一查历史就知道后面怎么走。

   ⑤ **爆仓是真爆**。权益跌破「占用保证金 × MAINTAIN」就强平，不是"亏光本金"
      那种假爆仓。满仓 + N 倍杠杆时反向走 (1−10%)/N 就没了：5 倍约 18%、
      10 倍约 9%、20 倍约 4.5%、50 倍约 1.8%、100 倍约 0.9%。
      按指数 1000 点算，100 倍只要反向 9 个点。

   ⑥ **只画最近一屏**。一局 960 根（10 天），全塞进 1300px 的话一根才 1.3px，
      蜡烛会糊成一条线。所以按容器宽度算可视根数并跟着行情自动滑动 ——
      真实的操盘软件也是这么做的。
*/
(function (global) {
  'use strict';
  const { $, el, storeGet, storeSet, toast } = U;

  /* ═══════════════ 合约与规则 ═══════════════ */
  // 本金可以在开场卡片里改。注意它**不改变难度**：仓位是按百分比开的，
  // 本金翻 10 倍，手数也翻 10 倍，盈亏比例一模一样。
  // 真正变的是两件事：① 数字看着像那么回事了 ② 手数是整张开的，
  // 本金越小取整误差越大（1 万本金开 30% 仓只有 6 手，凑不出更细的仓位）。
  const DEF_CASH   = 300000;   // 默认本金（群里说"久留美都有三十万"，那就三十万）
  const CASH_MIN   = 1000;
  const CASH_MAX   = 100000000;
  const CASH_PRESETS = [100000, 300000, 1000000, 3000000, 10000000];
  const LOT_MULT   = 10;       // 1 手 × 指数每动 1 点 = 10 元
  const FEE_RATE   = 0.0005;   // 单边手续费，万分之五
  const MAINTAIN   = 0.10;     // 维持保证金率：权益 ≤ 占用保证金 × 10% 就强平
  const BASE       = 1000;     // 指数基准
  const TREND_K    = 50;       // 趋势分量放大倍数
  const NOISE_K    = 16;       // 快分量放大倍数
  const EMA_A      = 0.05;     // 趋势 EMA 系数（半衰期约 14 根 = 3.5 小时）
  const WICK_K     = 0.30;     // 影线 = |本根涨跌| × 这个系数
  // 突发行情：单根 15 分钟里 severity 变化超过 JUMP_AT 个稳健标准差才算"剧烈变化"，
  // 超出的部分乘 JUMP_K 变成冲击，再按 JUMP_DECAY 衰减出余波（见 pickSeries）。
  const JUMP_AT    = 0.9;
  const JUMP_K     = 34;
  const JUMP_DECAY = 0.78;
  const PER_DAY    = 96;       // 一天 96 根 15 分钟 K
  // 一局 960 根 = 10 天。原来是 480 根（5 天），但一局最长也就两分钟、
  // 行情一秒钟跑 24 根，看着像在放快进而不是在盯盘 —— 现在放慢到 1.5~6 根/秒，
  // 一局 2.7~10.7 分钟，一「天」大约 16~64 秒，节奏更像真的在看 15 分钟图。
  const ROUND_BARS = 960;
  const SPEEDS     = [1.5, 3, 6]; // 每个真实秒推进几根 K

  /* ── 复合标的：标的不是一个城市的天气，而是「大盘 + 本地 + 湿度 + 盘子扰动」 ──
     群里那位说得对：只炒一个城市的对流，盯久了就那点花样。真实市场里你炒的东西
     是被大盘推着走的，所以这里把 15 分钟粒度的**同省区域平均气温**也当成一股力。
     要注意哪几项是真的、哪几项是建模的（README 里也写了）：
       区域项  reg  真数据：Open-Meteo 一次请求同省 8 城 15 分钟气温，等权平均
       湿度项  dew  真数据：minutely_15 的 dew_point_2m（PM2.5 没有 15 分钟产品，不拿它充数）
       盘子项  dish **建模**：带衰减的随机游走，小地方振幅更大（见 cityWeight）
     每一项都是"那一项的异常值 × 一个系数"，异常值用中位数对齐，所以叠加后
     基准仍然是 BASE = 1000。 */
  const REG_K      = 6;        // 区域大盘带动
  const DEW_K      = 5;        // 露点（湿热）项
  const DISH_K     = 3;        // 盘子扰动的基准振幅（再乘 cityWeight 得到的倍率）
  const DISH_DECAY = 0.96;     // 盘子扰动衰减（半衰期约 17 根 ≈ 4 小时）

  const LEVS = [
    { v: 1,   n: '1×',   t: '稳健',   cls: '' },
    { v: 5,   n: '5×',   t: '激进',   cls: '' },
    { v: 10,  n: '10×',  t: '疯狂',   cls: 'lev-danger' },
    { v: 20,  n: '20×',  t: '天台',   cls: 'lev-danger' },
    { v: 50,  n: '50×',  t: '天台没护栏', cls: 'lev-danger' },
    { v: 100, n: '100×', t: '久留美', cls: 'lev-danger' }
  ];

  /* ═══════════════ 运行状态 ═══════════════ */
  const G = {
    open: false,
    running: false,
    ended: false,
    city: null,
    series: [],       // [{ t, o, h, l, c }]，长度 ROUND_BARS
    seeds: [],        // 每根的真实天气读数（CAPE / 阵风 / 降水 / 天气码 / 露点 / 盘子扰动）
    sev: null,        // 本局窗口的本地恶劣度序列（天气日历用）
    regLine: null,    // 区域大盘线（整段 92 天里本局窗口那 960 根）；拿不到大盘时为 null
    regFrom: 0,       // 上面那条线在原始 92 天序列里的起点下标
    regCities: null,  // 组成大盘的城市名
    i: 0,
    price: 0,
    cash0: DEF_CASH,  // 本局本金（开场卡片里可改，局中不可改）
    cash: DEF_CASH,
    pos: 0,           // 净持仓手数，正 = 多
    avg: 0,           // 持仓均价（指数点）
    lev: 10,
    pct: 30,
    speedIdx: 1,
    timer: null,
    peak: DEF_CASH,
    maxDD: 0,
    trades: 0,
    fills: [],        // 最近 5 笔成交，新的在前
    orders: [],       // 挂单：限价 { kind:'limit', dir, price, lots } / 止损止盈 { kind:'sl'|'tp', price }
    orderSeq: 0,
    sev: null,        // 本局的 severity 切片（天气日历要提前看"什么时候变天"）
    hist: [],
    liqPrice: null,
    liqAt: 0,
    sound: true,
    main: null,
    eqc: null,
    seeds: null,      // 这一局的原始天气分量（做闪报用）
    lastNews: ''
  };

  const THEME = { up: '#ff4d4f', down: '#00b578', flat: '#8b919e', ac: '#ffb74d', line: '#262b36', dim: '#8b919e', fg: '#e6e9ef' };
  function readTheme() {
    try {
      const s = getComputedStyle(document.body);
      const g = k => (s.getPropertyValue(k) || '').trim();
      if (g('--up')) THEME.up = g('--up');
      if (g('--down')) THEME.down = g('--down');
      if (g('--flat')) THEME.flat = g('--flat');
      if (g('--accent')) THEME.ac = g('--accent');
    } catch (e) { }
  }

  /* ═══════════════ 数字格式化 ═══════════════ */
  const n0 = v => (isFinite(v) ? Math.round(v) : 0).toLocaleString('en-US');
  const n1 = v => (isFinite(v) ? v : 0).toFixed(1);
  const n2 = v => (isFinite(v) ? v : 0).toFixed(2);
  function money(v) {
    const neg = v < 0;
    return (neg ? '-' : '') + '¥' + n0(Math.abs(v));
  }
  function sgnMoney(v) { return (v >= 0 ? '+' : '-') + '¥' + n0(Math.abs(v)); }
  function colorOf(v) { return v > 0 ? THEME.up : v < 0 ? THEME.down : THEME.flat; }

  /* ═══════════════ 账户数学 ═══════════════
     注意这里价格是「指数点」，不是摄氏度。合约规格：
     1 手 × 指数每动 1 点 = LOT_MULT 元。 */
  function marginUsed() { return G.pos ? Math.abs(G.pos) * G.avg * LOT_MULT / G.lev : 0; }
  function unreal() { return G.pos ? G.pos * (G.price - G.avg) * LOT_MULT : 0; }
  function equity() { return G.cash + unreal(); }
  /** 挂着的限价单锁掉的那部分保证金 —— 真券商就是这么算的，不然可以无限挂单把仓位吹到天上去 */
  function reservedMargin() {
    return G.orders.reduce((s, o) => s + (o.kind === 'limit' ? o.lots * o.price * LOT_MULT / G.lev : 0), 0);
  }
  function freeEq() { return equity() - marginUsed() - reservedMargin(); }
  function maxLots() { const m = G.price * LOT_MULT / G.lev; return m > 0 ? Math.floor(Math.max(0, freeEq()) / m) : 0; }
  /** 强平价：解 equity = marginUsed × MAINTAIN */
  function liqPriceOf() {
    if (!G.pos) return null;
    return G.avg + (Math.abs(G.pos) * G.avg * LOT_MULT / G.lev * MAINTAIN - G.cash) / (G.pos * LOT_MULT);
  }

  /**
   * 照现在的仓位比例下单的话，价格反向走多少就爆仓（百分数）。
   *
   * 这把「杠杆」和「仓位」两件事合成了一个数字 —— 这才是新手真正需要看的东西：
   * 满仓 20 倍是 4.5%，30% 仓位 20 倍是 16.2%，满仓 100 倍只有 0.9%。
   * 推导：开仓后现金 C、保证金 M = 手数·价·LOT/N，
   * 爆仓时 C + 手数·Δp·LOT = M·MAINTAIN  →  Δp = (M·MAINTAIN − C)/(手数·LOT)
   * 这个做法照 bilibili「FX 简单!」的下单卡搬的（它写「约可承受反向波动 4.00%」）。
   * 返回 null 表示连 1 手都开不出来。
   */
  function tolerablePct(pct) {
    if (!G.price) return null;
    const lots = Math.floor(maxLots() * pct / 100);
    if (lots < 1) return null;
    const M = lots * G.price * LOT_MULT / G.lev;
    const dp = (M * MAINTAIN - G.cash) / (lots * LOT_MULT);
    if (dp >= 0) return 0;                       // 开出来就已经在爆仓线下面了
    return Math.min(999, Math.abs(dp) / G.price * 100);
  }

  /* ═══════════════ 成交 ═══════════════ */
  /**
   * 按指定价成交。`p` 默认是最新价，但挂单必须按"挂的那个价"成交 —— 那正是挂单的意义。
   */
  function applyFillAt(q, p) {
    if (!q) return;
    p = (p > 0) ? p : G.price;
    const old = G.pos;
    const fee = Math.abs(q) * p * LOT_MULT * FEE_RATE;
    if (old === 0) {
      G.avg = p;
    } else if ((old > 0) === (q > 0)) {
      G.avg = (Math.abs(old) * G.avg + Math.abs(q) * p) / (Math.abs(old) + Math.abs(q));
    } else if (Math.abs(q) <= Math.abs(old)) {
      G.cash += -q * (p - G.avg) * LOT_MULT;
    } else {
      G.cash += old * (p - G.avg) * LOT_MULT;
      G.avg = p;
    }
    G.cash -= fee;
    G.pos = old + q;
    if (!G.pos) G.avg = 0;
    G.trades++;
    // 仓位平掉之后，挂在它上面的止损止盈就没意义了
    if (!G.pos) G.orders = G.orders.filter(o => o.kind === 'limit');
    // 成交记录（最近 5 笔，新的在上）
    const kind = old === 0 ? (q > 0 ? '开多' : '开空')
      : (G.pos === 0 ? '平仓'
        : ((old > 0) === (q > 0) ? (q > 0 ? '加多' : '加空') : (q > 0 ? '减空' : '减多')));
    G.fills.unshift({ at: G.i, kind: kind, lots: Math.abs(q), px: p, fee: fee });
    if (G.fills.length > 5) G.fills.length = 5;
  }
  function applyFill(q) { applyFillAt(q, G.price); }

  /* ═══════════════ 挂单 ═══════════════ */
  /**
   * 限价开仓单：价格碰到 `price` 就按**这个价**开仓（不是按最新价 —— 那才是挂单的意思）。
   * 下单时就把它要占的保证金锁掉，所以不能靠挂单把仓位吹到天上去。
   */
  function placeLimit(dir, price, lots) {
    price = +price; lots = Math.floor(+lots);
    if (!(price > 0)) return '价格没填';
    if (!(lots >= 1)) return '手数至少 1';
    const need = lots * price * LOT_MULT / G.lev;
    if (need > freeEq() + 1e-6) return '可用保证金不够（要 ' + money(need) + '）';
    G.orders.push({ id: ++G.orderSeq, kind: 'limit', dir: dir > 0 ? 1 : -1, price: price, lots: lots });
    return null;
  }

  /** 止损 / 止盈挂在当前持仓上，碰到就把整个仓位平掉（跟真券商一样，不记手数） */
  function setStop(kind, price) {
    price = +price;
    if (!(price > 0)) return '价格没填';
    if (!G.pos) return '现在没有持仓';
    G.orders = G.orders.filter(o => o.kind !== kind);
    G.orders.push({ id: ++G.orderSeq, kind: kind, price: price });
    return null;
  }

  function cancelOrder(id) { G.orders = G.orders.filter(o => o.id !== id); }

  /**
   * 这一根 K 线里哪些挂单被碰到了。
   *
   * 判定用「上一根收盘 → 本根收盘」这条线段，再加本根的上下影线 ——
   * 光看收盘价的话，插针把你止损扫掉的情形就永远模拟不出来。
   * 同一根里有好几个价位被碰到时，按「离上一根收盘的距离」排序逐个成交：
   * 价格是从上一根收盘一路走过来的，先碰到的先成交，这才符合直觉。
   */
  function processOrders(prevPx) {
    if (!G.orders.length || !G.series[G.i]) return;
    const bar = G.series[G.i];
    const lo = Math.min(prevPx, G.price, bar.l);
    const hi = Math.max(prevPx, G.price, bar.h);
    const hits = G.orders.filter(o => o.price >= lo && o.price <= hi);
    if (!hits.length) return;
    hits.sort((a, b) => Math.abs(a.price - prevPx) - Math.abs(b.price - prevPx));
    for (const o of hits) {
      if (G.orders.indexOf(o) < 0) continue;   // 前面的成交可能已经把它带走了
      if (o.kind === 'limit') {
        applyFillAt(o.dir * o.lots, o.price);
        floatText('限价成交 ' + (o.dir > 0 ? '多' : '空') + ' ' + o.lots + ' 手 @ ' + n1(o.price), o.dir > 0 ? THEME.up : THEME.down, 12);
        beep(o.dir > 0 ? 660 : 440, .08, 'triangle', .04);
      } else if (G.pos) {
        const q = -G.pos;
        applyFillAt(q, o.price);
        floatText((o.kind === 'sl' ? '止损触发 @ ' : '止盈触发 @ ') + n1(o.price), o.kind === 'sl' ? THEME.down : THEME.up, 13);
        beep(o.kind === 'sl' ? 300 : 900, .16, 'sine', .05);
      }
      G.orders = G.orders.filter(x => x.id !== o.id);
    }
  }

  function liquidate() {
    const p = G.price;
    G.liqPrice = p;
    G.liqAt = G.i;
    G.cash += G.pos * (p - G.avg) * LOT_MULT;
    G.cash = Math.max(0, G.cash);
    G.pos = 0; G.avg = 0;
    G.hist[G.hist.length - 1] = G.cash;
  }

  /* ═══════════════ 指数构造 ═══════════════ */
  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const h = b.length >> 1;
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  }
  /** 中位绝对偏差 → 稳健标准差。用 min/max 归一化的话，一次台风就把后面全压扁了。 */
  function robustScale(a, m) {
    const d = a.map(v => Math.abs(v - m));
    return (1.4826 * median(d)) || 1;
  }

  /** 当地"现在"的 'YYYY-MM-DDTHH:MM'，用来切出预报段 */
  function nowLocalStr() {
    const d = new Date();
    const u = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return u.toISOString().slice(0, 16);
  }

  /**
   * 这个城市有多"大"。用来定**盘子扰动**的振幅 —— 小地方筹码少，同样的资金进出
   * 更容易把价格打飞，这就是"庄家操盘"的观感来源。
   *
   * `cities.json` 里没有人口字段（只有 id/name/prov/py/lat/lon/cma/path），
   * 所以按**行政层级**分档，而不是假装知道人口：
   *   直辖市 3.0 / 省会 2.2 / 有国家站的地级市 1.6 / 有 path 的 1.2 / 区县 0.6
   * 再取 `1.6 / w` 当振幅倍率，并夹到 [0.35, 2.6] 免得极端值飞出画面。
   */
  function cityWeight(c) {
    if (!c) return 1;
    const p = String(c.prov || ''), nm = String(c.name || '');
    if (/^(北京市|上海市|天津市|重庆市)$/.test(p)) return 3.0;
    const core = p.replace(/(省|市|自治区|壮族|回族|维吾尔|特别行政区|自治州)/g, '');
    if (core && nm && (nm === core || nm.indexOf(core) === 0)) return 2.2;
    if (c.cma) return 1.6;
    if (c.path) return 1.2;
    return 0.6;
  }
  function dishScale(c) {
    const w = cityWeight(c);
    return Math.max(0.35, Math.min(2.6, 1.6 / w));
  }

  /** 把 minutely_15 的原始分量压成一条「天气恶劣度」序列 */
  function severity(mn) {
    const T = mn.temp.map(v => (v == null ? 0 : +v));
    const Gs = mn.gust.map(v => (v == null ? 0 : +v));
    const P = mn.precip.map(v => (v == null ? 0 : +v));
    const C = mn.cape.map(v => (v == null ? 0 : +v));
    const W = mn.wcode.map(v => (v == null ? 0 : +v));
    const mC = median(C), sC = robustScale(C, mC);
    const mG = median(Gs), sG = robustScale(Gs, mG);
    const mT = median(T), sT = robustScale(T, mT);
    const out = new Array(T.length);
    for (let i = 0; i < T.length; i++) {
      const wc = W[i];
      // 雷暴码权重最大 —— 它代表"此时此刻头上正在放电"，比任何数值都硬
      const storm = (wc === 95 || wc === 96 || wc === 99) ? 1.6
        : (wc === 80 || wc === 81 || wc === 82 || wc === 65 || wc === 63) ? 0.5 : 0;
      out[i] = (C[i] - mC) / sC * 1.00        // 对流有效位能
        + (Gs[i] - mG) / sG * 0.55            // 阵风
        + (T[i] - mT) / sT * 0.30             // 气温异常
        + Math.min(4, Math.sqrt(P[i])) * 0.45 // 实况降水
        + storm;
    }
    return out;
  }

  function ema(x, a) {
    const o = new Array(x.length);
    let v = x.length ? x[0] : 0;
    for (let i = 0; i < x.length; i++) { v = a * x[i] + (1 - a) * v; o[i] = v; }
    return o;
  }

  /** 从 minutely_15 里随机截一段真实历史，做成带 OHLC 的 K 线 */
  function pickSeries(mn, reg, city) {
    if (!mn || !mn.time || !mn.time.length) return null;
    const n = mn.time.length;
    let i0 = mn.time.findIndex(t => t >= nowLocalStr());
    if (i0 < 0) i0 = n;
    // 只用"现在"之前的：预报段不能拿来当已发生的行情
    const end = Math.max(2, Math.min(n, i0));
    const need = ROUND_BARS;
    if (end < need + 1) return null;

    const sev = severity(mn);
    const tr = ema(sev, EMA_A);
    const now = nowLocalStr();

    // ── 区域大盘：同一个时间轴（两边都是 past_days=92 & 同一时区），按时间串对齐 ──
    let regSev = null, regTr = null, regMap = null;
    if (reg && reg.time && reg.time.length) {
      regMap = {};
      for (let k = 0; k < reg.time.length; k++) regMap[reg.time[k]] = k;
      // 拿本地这一局的时间轴去取大盘值，拼成等长的"虚拟城市"再套同一套 severity()
      const rv = { time: [], temp: [], gust: [], precip: [], wcode: [], cape: [], dew: [] };
      for (let k = 0; k < n; k++) {
        const j = regMap[mn.time[k]];
        rv.time.push(mn.time[k]);
        rv.temp.push(j == null ? null : reg.temp[j]);
        rv.gust.push(j == null ? null : reg.gust[j]);
        rv.precip.push(j == null ? (0) : (reg.precip[j] == null ? 0 : reg.precip[j]));
        rv.wcode.push(j == null ? 0 : (reg.wcode[j] || 0));
        rv.cape.push(j == null ? null : reg.cape[j]);
      }
      // severity() 里对 null 是当 0 处理的，所以只有大盘真的对齐上了才算数
      let hit = 0;
      for (let k = 0; k < Math.min(200, n); k++) if (rv.cape[k] != null && rv.gust[k] != null) hit++;
      if (hit > 100) { regSev = severity(rv); regTr = ema(regSev, EMA_A); }
    }

    // ── 露点（湿热）项：真数据，15 分钟粒度 ──
    const D = (mn.dew && mn.dew.length ? mn.dew : []).map(v => (v == null ? null : +v));
    const dOk = D.filter(v => v != null);
    const mDew = dOk.length ? median(dOk) : 0, sDew = dOk.length ? robustScale(dOk, mDew) : 1;

    // ── 盘子扰动：带衰减的随机游走。小地方振幅更大（庄家操盘）──
    const dScale = dishScale(city) * DISH_K;

    for (let k = 0; k < 24; k++) {
      const s = Math.floor(Math.random() * (end - need));
      let ok = true;
      for (let j = 0; j < need; j++) {
        // 只认"现在"之前、而且确实有数的点
        if (mn.time[s + j] >= now || mn.gust[s + j] == null || mn.cape[s + j] == null) { ok = false; break; }
      }
      if (!ok) continue;

      const win = tr.slice(s, s + need);
      const m = median(win);
      const series = [];
      const seeds = [];
      const regLine = [];          // 画在副图上的"大盘"（跟主图同一根数）
      let carry = 0, dish = 0;
      for (let j = 0; j < need; j++) {
        const k2 = s + j;
        // 「突发行情」：某根 15 分钟里天气本身剧烈变化（CAPE 炸了、阵风猛增、开始下暴雨）时，
        // 除了常规的噪声项，再砸进去一记冲击 —— 这就是久留美里那种"蜡烛图突然拉到底"。
        //
        // shock 是「这一刻打多狠」，carry 是「余波还走多远」。只有 shock 的话就出一根长阴、
        // 下一根立刻回弹，不像崩盘；加上 carry（按 JUMP_DECAY 衰减的动量）才有连续几根
        // 顺势砸下去的样子。系数是拿广州/哈尔滨 92 天的真实 minutely_15 调出来的：
        // 单根中位涨跌仍是 0.167%（平时盘感不变），但每局会出现几次连续 3 根跌 8~15% 的段。
        // 注意它**不是随机数** —— 触发条件是真实观测到的剧烈变化。
        const dsev = k2 > 0 ? (sev[k2] - sev[k2 - 1]) : 0;
        const shock = Math.abs(dsev) > JUMP_AT
          ? (Math.abs(dsev) - JUMP_AT) * JUMP_K * (dsev > 0 ? 1 : -1)
          : 0;
        carry = carry * JUMP_DECAY + shock;

        // 大盘的快分量：本地天气是一城一地，大盘是整省的天气过程。
        // 只取"快分量"（减去自己的 EMA）是有意的 —— 趋势项已经由本地负责，
        // 大盘再贡献一遍慢趋势就成了同一个信号算两次。
        let regFast = 0;
        if (regSev) regFast = (regSev[k2] - regTr[k2]) * REG_K;

        const dnorm = D[k2] == null ? 0 : (D[k2] - mDew) / sDew;

        // 盘子扰动：AR(1)。用噪声当驱动、按 DISH_DECAY 衰减，
        // 所以它是一条"能看出有人在推"的平滑曲线，而不是每根乱跳的雪花点。
        dish = dish * DISH_DECAY + (Math.random() - 0.5) * 2 * dScale;

        const px = BASE + (tr[k2] - m) * TREND_K + (sev[k2] - tr[k2]) * NOISE_K + carry
          + regFast + dnorm * DEW_K + dish;
        series.push({ t: mn.time[k2], c: px });
        regLine.push(BASE + regFast * 3 + dish * 0.2);
        seeds.push({
          cape: mn.cape[k2] | 0,
          gust: +(+mn.gust[k2]).toFixed(1),
          precip: +(+(mn.precip[k2] || 0)).toFixed(1),
          wcode: mn.wcode[k2] | 0,
          dew: D[k2] == null ? null : +(+D[k2]).toFixed(1),
          dish: +dish.toFixed(1)
        });
      }
      // 补 OHLC：开 = 上一根收，收 = 本根指数（都是真采样）；
      // 影线按 |本根涨跌| × WICK_K 建模（15 分钟粒度拿不到根内极值）。
      for (let j = series.length - 1; j >= 0; j--) {
        const c = series[j].c;
        const o = j > 0 ? series[j - 1].c : c;
        const w = Math.abs(c - o) * WICK_K;
        series[j].o = o;
        series[j].h = Math.max(o, c) + w;
        series[j].l = Math.min(o, c) - w;
      }
      if (!series.every(b => isFinite(b.o) && isFinite(b.c))) continue;
      return {
        series, seeds, sevWin: sev.slice(s, s + need),
        regLine: regSev ? regLine : null,
        regFrom: s,
        regCities: (reg && reg.cities) || null
      };
    }
    return null;
  }

  function labelAt(i) {
    const day = Math.floor(i / PER_DAY) + 1, m = (i % PER_DAY) * 15;
    const hh = U.pad2(Math.floor(m / 60)), mm = U.pad2(m % 60);
    return (m === 0) ? ('第 ' + day + ' 天') : ('D' + day + ' ' + hh + ':' + mm);
  }

  /* ═══════════════ 天气日历 ═══════════════
     财经日历告诉你「20:30 有非农」，但不会告诉你数据是好是坏 —— 这个日历一样：
     它只标出**未来一天里天气什么时候会剧变**，一个字都不提往哪边。

     判定用的是 |Δseverity|，也就是"变化得多猛"。CAPE 炸上去和塌下来
     算出来是同一个数，所以强度条本身不泄露方向。
     触发门槛跟价格冲击用的同一个 JUMP_AT —— 日历上标了的，盘面上就真会动。 */
  function calendarAt(i, horizon) {
    if (!G.sev || !G.series.length) return [];
    const end = Math.min(G.series.length - 1, i + (horizon || PER_DAY));
    const raw = [];
    for (let k = Math.max(1, i + 1); k <= end; k++) {
      const d = Math.abs(G.sev[k] - G.sev[k - 1]);
      if (d > JUMP_AT) raw.push({ at: k, d: d });
    }
    // 同一场天气过程会连着好几根都在变，合并成一段
    const out = [];
    for (const e of raw) {
      const last = out[out.length - 1];
      if (last && e.at - last.to <= 3) { last.to = e.at; last.d = Math.max(last.d, e.d); }
      else out.push({ from: e.at, to: e.at, d: e.d });
    }
    return out;
  }

  /* ═══════════════ 新闻闪报（都用真实数值） ═══════════════ */
  /** 返回这一根 K 线上值得播报的天气事件，没有就返回 null */
  function newsAt(i) {
    const s = G.seeds && G.seeds[i];
    if (!s) return null;
    const wc = s.wcode;
    // 盘子扰动优先播 —— 它是"资金面"消息，比天气更能解释一根莫名的长阳/长阴
    if (s.dish != null) {
      if (s.dish >= DISH_K * 1.5) return { k: 'pump', t: '🏦 大单扫货', v: '盘子异动 +' + n1(s.dish) };
      if (s.dish <= -DISH_K * 1.5) return { k: 'dump', t: '📉 有人出货', v: '盘子异动 ' + n1(s.dish) };
    }
    if (wc === 95 || wc === 96 || wc === 99) return { k: 'storm', t: '⚡ 雷暴', v: 'CAPE ' + s.cape };
    if (s.gust >= 32) return { k: 'typhoon', t: '🌀 台风外围影响', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (s.cape >= 3000) return { k: 'cape', t: '🌩 对流爆发', v: 'CAPE ' + s.cape };
    if (s.gust >= 25) return { k: 'gust', t: '🌪 大风', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (s.precip >= 3) return { k: 'rain', t: '🌧 短时强降水', v: s.precip + ' mm' };
    if (s.cape <= 50 && s.gust <= 6) return { k: 'calm', t: '🌤 天气转好', v: 'CAPE ' + s.cape };
    return null;
  }

  function flashNews(ev) {
    if (!ev || ev.k === G.lastNews) return;
    G.lastNews = ev.k;
    const p = $('.game-panel');
    if (!p) return;
    const old = p.querySelector('.gg-news');
    if (old) old.remove();
    const d = document.createElement('div');
    d.className = 'gg-news';
    d.innerHTML = '<b>' + ev.t + '</b><span>' + ev.v + '</span>';
    p.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }

  /* ═══════════════ 音效 ═══════════════ */
  let AC = null;
  function beep(freq, dur, type, vol) {
    if (!G.sound) return;
    try {
      AC = AC || new (global.AudioContext || global.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol == null ? .05 : vol, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(); o.stop(AC.currentTime + dur);
    } catch (e) { }
  }

  /* ═══════════════ 图表 ═══════════════ */
  function ensureCharts() {
    if (!G.main) {
      G.main = echarts.init($('#ggChart'), null, { renderer: 'canvas' });
      // 绑定一次就够 —— setOption(..., true) 不会把 on() 挂的监听清掉。
      // params.axesInfo[0].value 是 x 轴的**类别名**，用 indexOf 反查下标。
      G.main.on('updateAxisPointer', ev => {
        try {
          const ai = ev && ev.axesInfo && ev.axesInfo[0];
          if (!ai) return;
          const cats = (G.main.getOption().xAxis[0] || {}).data || [];
          const k = cats.indexOf(ai.value);
          if (k >= 0) updateOhlc((G._from || 0) + k);
        } catch (e) { }
      });
      // 鼠标离开图表就回到最新一根
      G.main.getZr().on('globalout', () => updateOhlc(G.i));
    }
    if (!G.eqc) G.eqc = echarts.init($('#ggEqChart'), null, { renderer: 'canvas' });
  }
  function disposeCharts() {
    try { if (G.main) G.main.dispose(); } catch (e) { }
    try { if (G.eqc) G.eqc.dispose(); } catch (e) { }
    G.main = G.eqc = null;
  }

  /** 一屏能看清多少根：容器宽度 ÷ 每根 9px，两端都夹一下 */
  function visBars() {
    const cw = (G.main && G.main.getWidth && G.main.getWidth()) || 900;
    return Math.max(36, Math.min(ROUND_BARS, Math.floor(cw / 9)));
  }

  /** 简单移动平均。返回与 series 等长的数组，前 w−1 根是 null（线自然断开） */
  function movingAvg(src, w) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i].c;
      if (i >= w) sum -= src[i - w].c;
      out.push(i >= w - 1 ? +(sum / w).toFixed(2) : null);
    }
    return out;
  }
  const MA_DEF = [{ w: 5, color: '#f0b90b' }, { w: 20, color: '#7aa2f7' }];
  const REG_C = '#c792ea';   // 区域大盘线的颜色（紫），和 MA5 的黄 / MA20 的蓝分得开

  /**
   * 图表左上角那行读数 —— TradingView / MT4 的图例。
   * 不悬停时跟着最新一根走，鼠标在图上来回划就显示划到的那根。
   */
  function updateOhlc(gi) {
    const box = $('#ggOhlc'); if (!box || !G.series.length) return;
    const k = Math.max(0, Math.min(gi, G.series.length - 1));
    const b = G.series[k]; if (!b) return;
    const d = b.c - b.o, col = colorOf(d);
    let ma = '';
    if (G._ma) {
      ma = G._ma.map((a, j) => {
        const v = a[k];
        const m = MA_DEF[j];
        return '<span class="gg-ma' + m.w + '"><i style="background:' + m.color + '"></i>MA' + m.w +
          ' <b>' + (v == null ? '—' : n1(v)) + '</b></span>';
      }).join('&nbsp;&nbsp;');
    }
    box.innerHTML =
      '<em>' + labelAt(k) + '</em>' +
      '开<b style="color:' + col + '">' + n1(b.o) + '</b>' +
      '高<b style="color:' + col + '">' + n1(b.h) + '</b>' +
      '低<b style="color:' + col + '">' + n1(b.l) + '</b>' +
      '收<b style="color:' + col + '">' + n1(b.c) + '</b>' +
      (ma ? '&nbsp;&nbsp;' + ma : '');
  }

  function drawCharts() {
    if (!G.main || !G.eqc || !G.series.length) return;
    const n = Math.min(G.i + 1, G.series.length);
    const cw = (G.main.getWidth && G.main.getWidth()) || 800;
    const want = Math.max(3, Math.floor(cw / 76));
    const vis = visBars();
    const from = Math.max(0, n - vis);

    const xs = [], bars = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i < n; i++) {
      const b = G.series[i];
      xs.push(labelAt(i));
      bars.push([+b.o.toFixed(2), +b.c.toFixed(2), +b.l.toFixed(2), +b.h.toFixed(2)]);
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    // 均线：真实看盘软件都有，而且它让「现在处在什么位置」一眼可见。
    // 注意要拿**整段** series 算再切片 —— 只拿可视段算的话，每次窗口滑动
    // 均线都会整体跳一下，看着像在抽搐。
    const maAll = MA_DEF.map(d => movingAvg(G.series, d.w));
    G._ma = maAll;
    const maVis = maAll.map(a => a.slice(from, n));
    maVis.forEach(a => a.forEach(v => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    // 大盘线：不进 Y 轴范围计算 —— 它是参考指标，把它算进去会把蜡烛压扁。
    // 注意 regLine 已经是**本局窗口**那一截了（长度 = ROUND_BARS），不用再加 regFrom。
    const regVis = G.regLine ? G.regLine.slice(from, n) : null;
    // 把 Y 轴拉开到能容纳「持仓均价」—— 否则入场线落在可视范围外时，
    // ECharts 会把它贴到坐标轴边缘，看起来像"价格就在最底下"，是骗人的。
    // 强平价只在**离得够近**时才纳入：1 倍杠杆下它在 90% 以外、10 倍下也在 10% 以外，
    // 硬拉进来会把蜡烛压成上面一小撮（试过 0.9 倍跨度的阈值，10 倍杠杆就把图压掉一半）。
    if (G.pos && isFinite(lo) && isFinite(hi)) {
      lo = Math.min(lo, G.avg); hi = Math.max(hi, G.avg);
      const lp0 = liqPriceOf();
      if (lp0 != null && isFinite(lp0)) {
        const span = (hi - lo) || 1;
        if (lp0 > lo - span * 0.25 && lp0 < hi + span * 0.25) { lo = Math.min(lo, lp0); hi = Math.max(hi, lp0); }
      }
    }
    // 挂着的单子也拉进可视范围 —— 挂单挂在天边看不见的话，跟没挂一样没感觉。
    // 但也别把轴拉爆：离得太远的（超过可视跨度 1.5 倍）就不管它，右侧列表里还有。
    if (G.orders.length && isFinite(lo) && isFinite(hi)) {
      const span0 = (hi - lo) || 1;
      G.orders.forEach(o => {
        if (o.price > lo - span0 * 1.5 && o.price < hi + span0 * 1.5) {
          lo = Math.min(lo, o.price); hi = Math.max(hi, o.price);
        }
      });
    }
    const yPad = ((hi - lo) || 1) * 0.08;
    const yMin = isFinite(lo) ? +(lo - yPad).toFixed(2) : undefined;
    const yMax = isFinite(hi) ? +(hi + yPad).toFixed(2) : undefined;

    const marks = [];
    // 现价水平线：横贯整张图，眼睛不用去找最后一根 K 线在哪
    if (G.i) marks.push({ yAxis: G.price, lineStyle: { color: 'rgba(255,255,255,.20)', type: 'solid', width: 1 } });
    if (G.pos) {
      marks.push({
        yAxis: G.avg, lineStyle: { color: THEME.ac, type: 'dashed', width: 1 },
        label: { formatter: '持仓均价 ' + n1(G.avg), color: THEME.ac, fontSize: 10, position: 'insideEndTop' }
      });
      const lp = liqPriceOf();
      if (lp != null && isFinite(lp)) {
        marks.push({
          yAxis: lp, lineStyle: { color: THEME.down, type: 'dotted', width: 1.2 },
          label: { formatter: '强平价 ' + n1(lp), color: THEME.down, fontSize: 10, position: 'insideEndBottom' }
        });
      }
    }
    // 挂单：限价用青色点线、止损用绿、止盈用红
    const ORD_C = { limit: '#4fc3f7', sl: THEME.down, tp: THEME.up };
    G.orders.forEach(o => {
      const tag = o.kind === 'limit' ? (o.dir > 0 ? '挂多 ' : '挂空 ') : (o.kind === 'sl' ? '止损 ' : '止盈 ');
      marks.push({
        yAxis: o.price, lineStyle: { color: ORD_C[o.kind], type: 'dotted', width: 1, opacity: .9 },
        label: {
          formatter: tag + n1(o.price) + (o.kind === 'limit' ? ' ×' + o.lots : ''),
          color: ORD_C[o.kind], fontSize: 9, position: 'insideStartTop'
        }
      });
    });

    G.main.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 58, top: 24, bottom: 24 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        axisPointer: { type: 'cross', label: { backgroundColor: '#2a3140' } },
        formatter: p => {
          const it = p[0]; if (!it) return '';
          const gi = from + it.dataIndex;
          // 顺手把左上角读数也切到这一根。ECharts 的 updateAxisPointer 事件
          // 只在鼠标真实移动时触发，程序化 showTip 不会 —— 两边都挂才稳。
          updateOhlc(gi);
          const b = G.series[gi], s = G.seeds[gi] || {};
          const d = b.c - b.o, dp = b.o ? d / b.o * 100 : 0;
          return labelAt(gi) +
            '<br/>开 <b>' + n1(b.o) + '</b>　高 <b>' + n1(b.h) + '</b>' +
            '<br/>低 <b>' + n1(b.l) + '</b>　收 <b>' + n1(b.c) + '</b>' +
            '<br/>涨跌 <b style="color:' + colorOf(d) + '">' + (d >= 0 ? '+' : '') + n1(d) +
            '　' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%</b>' +
            '<br/><span style="opacity:.7">CAPE ' + (s.cape == null ? '—' : s.cape) +
            '　阵风 ' + (s.gust == null ? '—' : n1(s.gust)) + ' m/s　降水 ' +
            (s.precip == null ? '—' : s.precip) + ' mm</span>';
        }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: THEME.line } },
        axisLabel: { color: THEME.dim, fontSize: 10, hideOverlap: true, interval: Math.max(0, Math.ceil(xs.length / want) - 1) },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value', scale: true, min: yMin, max: yMax,
        axisLabel: { color: THEME.dim, fontSize: 10, formatter: v => v.toFixed(0) },
        // 十字光标的纵向读数：默认会给成 1,103.96 这种带千分位两位小数，太啰嗦
        axisPointer: { label: { formatter: p => (+p.value).toFixed(1), backgroundColor: '#2a3140' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } }
      },
      series: [{
        name: 'WXI', type: 'candlestick', data: bars, z: 3,
        barMaxWidth: 14,
        itemStyle: {
          color: THEME.up, color0: THEME.down,
          borderColor: THEME.up, borderColor0: THEME.down
        },
        markLine: marks.length ? { silent: true, symbol: 'none', data: marks } : undefined
      }].concat(MA_DEF.map((d, k) => ({
        name: 'MA' + d.w, type: 'line', data: maVis[k], z: 4,
        showSymbol: false, smooth: false, connectNulls: false, silent: true,
        lineStyle: { width: 1.1, color: d.color, opacity: .85 }
      }))).concat(G.regLine ? [{
        // 区域大盘：把同省 8 城的天气压成一条线，和本地标的画在一起看背离。
        // 它**不是可交易的合约**，只当参考指标（所以 silent + 不参与 tooltip 之外的计算）。
        name: '大盘', type: 'line', data: regVis, z: 2,
        showSymbol: false, smooth: true, connectNulls: false, silent: true,
        lineStyle: { width: 1.2, color: REG_C, opacity: .8, type: 'dashed' }
      }] : [])
    }, true);
    G._from = from;
    updateOhlc(G.i < 0 ? 0 : G.i);   // 没有悬停时，读数跟着最新一根走

    // 权益图的基准标签：本金可改，这个数字必须跟着走（原来写死在 HTML 里，改成 30 万后就不对了）
    const eqb = $('#ggEqBase');
    if (eqb) eqb.textContent = '¥' + G.cash0.toLocaleString('en-US');

    // ── 现价标签：贴在右侧价格轴上，就是 MT4 那条「当前价」──
    const tag = $('#ggLastTag');
    if (tag) {
      const last = G.series[Math.min(G.i, G.series.length - 1)];
      const c = (last && last.c >= last.o) ? THEME.up : THEME.down;
      tag.textContent = n1(G.price);
      tag.style.background = c;
      try {
        const py = G.main.convertToPixel({ yAxisIndex: 0 }, G.price);
        if (py != null && isFinite(py)) tag.style.top = Math.round(py) + 'px';
      } catch (e) { }
    }

    // 大单爆点：最后一根波动特别大就闪一下
    if (n > from + 1) {
      const b = G.series[n - 1], d = b.c - b.o;
      if (Math.abs(d) / Math.max(1, b.o) > 0.025) floatText((d > 0 ? '▲ +' : '▼ ') + n1(d), colorOf(d), 30);
    }

    const e = G.hist.length ? G.hist : [G.cash];
    const base = G.cash0;
    const col = colorOf(e[e.length - 1] - base);
    const eqFrom = Math.max(0, e.length - vis);
    G.eqc.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 58, top: 8, bottom: 16 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        formatter: p => { const it = p[0]; return it ? labelAt(eqFrom + it.dataIndex) + '<br/>权益 <b>' + money(it.value) + '</b>' : ''; }
      },
      xAxis: {
        type: 'category', data: xs.slice(0, Math.max(1, e.length - eqFrom)), boundaryGap: true,
        axisLine: { lineStyle: { color: THEME.line } }, axisLabel: { show: false }, axisTick: { show: false }
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: THEME.dim, fontSize: 9, formatter: v => Math.round(v / 1000) + 'k' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } } },
      series: [{
        name: '权益', type: 'line', data: e.slice(eqFrom), showSymbol: false,
        lineStyle: { width: 1.4, color: col },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: col + '40' }, { offset: 1, color: col + '00' }]) },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: base, lineStyle: { color: 'rgba(255,255,255,.22)', type: 'dashed', width: 1 }, label: { formatter: '本金', color: THEME.dim, fontSize: 9, position: 'insideEndTop' } }] }
      }]
    }, true);
  }

  /* ═══════════════ 面板渲染 ═══════════════ */
  function render() {
    const e = equity(), diff = e - G.cash0, pct = diff / G.cash0 * 100;
    const col = colorOf(diff);

    const eqEl = $('#ggEquity');
    if (eqEl) {
      if (eqEl.textContent !== n0(e)) {
        eqEl.classList.remove('gg-pop');
        void eqEl.offsetWidth;
        eqEl.classList.add('gg-pop');
      }
      eqEl.textContent = n0(e);
      eqEl.style.color = col;
    }
    const chgEl = $('#ggEqChg');
    if (chgEl) {
      chgEl.textContent = sgnMoney(diff) + '　(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      chgEl.style.color = col;
    }

    const mu = marginUsed(), lp = liqPriceOf();
    const rows = [
      ['WXI 现价', (G.pos || G.i) ? n1(G.price) : '—', 0],
      ['可用保证金', money(freeEq()), freeEq() < 0 ? -1 : 0],
      ['占用保证金', G.pos ? money(mu) : '—', 0],
      ['持仓', G.pos ? (G.pos > 0 ? '多 ' : '空 ') + Math.abs(G.pos) + ' 手' : '空仓', G.pos > 0 ? 1 : G.pos < 0 ? -1 : 0],
      ['持仓均价', G.pos ? n1(G.avg) : '—', 0],
      ['浮动盈亏', G.pos ? sgnMoney(unreal()) : '—', G.pos ? Math.sign(unreal()) : 0],
      ['强平价', (G.pos && lp != null && isFinite(lp)) ? n1(lp) : '—', 0],
      ['爆仓距离', (G.pos && lp != null && isFinite(lp) && G.price) ? (Math.abs(G.price - lp) / G.price * 100).toFixed(2) + '%' : '—', 0]
    ];
    const box = $('#ggStats');
    if (box) {
      box.innerHTML = rows.map(r =>
        '<div class="gg-row' + (r[2] < 0 ? ' gg-warn-row' : '') + '"><span>' + r[0] + '</span><span style="color:' +
        (r[2] ? colorOf(r[2]) : '') + '">' + r[1] + '</span></div>'
      ).join('');
    }

    const sub = $('#ggSub');
    if (sub) {
      const mm = (G.i % PER_DAY) * 15;
      const when = G.series.length
        ? ('第 ' + (Math.floor(G.i / PER_DAY) + 1) + ' 天 ' + U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60) +
          '　·　' + (G.i + 1) + ' / ' + ROUND_BARS + ' 根　·　' + G.lev + ' 倍杠杆')
        : '—';
      sub.textContent = G.city ? (G.city.name + ' WXI 天气指数　·　' + when) : when;
    }

    const lots = Math.floor(maxLots() * G.pct / 100);
    const lab = $('#ggLots');
    if (lab) lab.textContent = G.pct + '% ≈ ' + lots + ' 手' + (lots < 1 ? '（不够 1 手）' : '');

    // ── 下单预估：名义仓位 / 开仓手续费 / 可承受反向波动 ──
    const tPct = tolerablePct(G.pct);
    const calc = $('#ggCalc');
    if (calc) {
      const notional = lots * G.price * LOT_MULT;
      const openFee = notional * FEE_RATE;
      const keyCls = tPct == null ? '' : (tPct < 3 ? ' gg-danger' : (tPct > 12 ? ' gg-safe' : ''));
      calc.innerHTML =
        '<div class="gg-crow"><span>名义仓位</span><b>' + (lots ? money(notional) : '—') + '</b></div>' +
        '<div class="gg-crow"><span>开仓手续费</span><b>' +
        (lots ? '¥' + openFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—') +
        '</b></div>' +
        '<div class="gg-crow gg-key' + keyCls + '"><span>约可承受反向波动</span><b>' +
        (tPct == null ? '—' : tPct.toFixed(2) + '%') + '</b></div>';
    }

    // ── 成交记录 ──
    const fills = $('#ggFills'), tcount = $('#ggTrades');
    if (tcount) tcount.textContent = G.trades + ' 笔';
    if (fills) {
      if (!G.fills || !G.fills.length) fills.innerHTML = '<div class="gg-empty">还没下过单</div>';
      else fills.innerHTML = G.fills.map(f => {
        const col = f.kind.indexOf('多') >= 0 ? THEME.up : THEME.down;
        return '<div class="gg-f"><span>' + labelAt(f.at) + '</span>' +
          '<span style="color:' + col + '">' + f.kind + ' ' + f.lots + ' 手</span>' +
          '<span>' + n1(f.px) + '</span></div>';
      }).join('');
    }

    // ── 挂单列表 ──
    const ordBox = $('#ggOrders'), ordTip = $('#ggOrdTip');
    if (ordBox) {
      if (!G.orders.length) {
        ordBox.innerHTML = '<div class="gg-empty">没有挂单</div>';
      } else {
        ordBox.innerHTML = G.orders.map(o => {
          const isL = o.kind === 'limit';
          const col = isL ? '#4fc3f7' : (o.kind === 'sl' ? THEME.down : THEME.up);
          const name = isL ? (o.dir > 0 ? '限价多' : '限价空') : (o.kind === 'sl' ? '止损' : '止盈');
          const dist = G.price ? ((o.price - G.price) / G.price * 100) : 0;
          return '<div class="gg-o"><span style="color:' + col + '">' + name + '</span>' +
            '<span>' + (isL ? o.lots + ' 手' : '全平') + '</span>' +
            '<span>' + n1(o.price) + '</span>' +
            '<span class="dim">' + (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%</span>' +
            '<button class="gg-x" data-cancel="' + o.id + '" title="撤单">×</button></div>';
        }).join('');
      }
      if (ordTip) {
        const nL = G.orders.filter(o => o.kind === 'limit').length;
        const nS = G.orders.length - nL;
        ordTip.textContent = G.orders.length ? (nL + ' 个限价 · ' + nS + ' 个止损止盈') : '碰到价才成交';
      }
    }

    // ── 天气日历 ──
    // 注意别用 setT：它是在这个函数下面才 const 出来的，从这里调会踩 TDZ
    const calBox = $('#ggCal'), calTip = $('#ggCalTip');
    if (calBox) {
      const evs = calendarAt(G.i, PER_DAY);
      if (calTip) calTip.textContent = '未来 24 小时 · ' + (evs.length ? evs.length + ' 次变天' : '风平浪静');
      if (!evs.length) {
        calBox.innerHTML = '<div class="gg-empty">接下来一天没什么动静</div>';
      } else {
        calBox.innerHTML = evs.slice(0, 6).map(e => {
          // 强度档是按实测 |Δsev| 分布定的：整局中位 0.06、p99 约 1.7、max 约 2.5，
          // 门槛 JUMP_AT=0.9 之上才进日历。所以「剧烈」是真的少见。
          const bars = Math.min(4, Math.max(1, Math.ceil(e.d / 0.7)));
          const when = labelAt(e.from) + (e.to > e.from ? '–' + labelAt(e.to).replace(/^D\d+ /, '') : '');
          return '<div class="gg-c"><span>' + when + '</span>' +
            '<i class="t' + bars + '">' + '▮'.repeat(bars) + '</i>' +
            '<b>' + (e.d >= 2.0 ? '剧烈' : e.d >= 1.3 ? '明显' : '一般') + '</b></div>';
        }).join('');
      }
    }

    const bl = $('#ggLong'), bs = $('#ggShort');
    if (bl && bs) bl.disabled = bs.disabled = (G.ended || !G.running || lots < 1);
    const bc = $('#ggClosePos');
    if (bc) bc.disabled = !G.pos;

    // ── 终端行情条 + 大号下单键上的价格 ──
    // 学 MT4/MT5：买卖价直接印在按钮上，不用先去看报价再回来点。
    // 「点差」这里显示的是**真实成本**：一手开+平的两次手续费，
    // 既折算成指数点数也给出金额 —— 不是装样子的假数字。
    const px = (G.pos || G.i) ? G.price : 0;
    const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    if (px) {
      const costPts = px * FEE_RATE * 2;                       // 指数点
      const costYuan = px * LOT_MULT * FEE_RATE * 2;           // 每手 ¥
      setT('#ggTbSell', n1(px));
      setT('#ggTbBuy', n1(px));
      setT('#ggTbSpread', costPts.toFixed(1) + ' 点');
      setT('#ggSym', (G.city ? G.city.name : 'WXI') + ' WXI');
      // 把大盘是由哪几个城市平均出来的写进 title，鼠标停一下就能看到
      const symEl = $('#ggSym');
      if (symEl) symEl.title = G.regCities && G.regCities.length
        ? ('区域大盘 = ' + G.regCities.join(' / ') + ' 的等权平均（15 分钟，同省最多 8 城）')
        : '这台设备的区域大盘取不到，本局是纯本地行情';
      const mm = (G.i % PER_DAY) * 15;
      setT('#ggTbTime', '第 ' + (Math.floor(G.i / PER_DAY) + 1) + ' 天 ' +
        U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60));
      const cost = $('#ggTbSpread');
      if (cost) cost.title = '一手开+平的手续费，合计 ¥' + costYuan.toFixed(2);
      setT('#ggTbConn', G.ended ? '已收盘' : (G.running ? '行情推送中' : '已暂停'));
      // 「行情速度」那一行右边实时报一局大概要跑多久 —— 1.5×/3×/6× 光看数字没有体感
      const secs = ROUND_BARS / SPEEDS[G.speedIdx];
      setT('#ggSpeedTip', '一局约 ' + (secs >= 90 ? (secs / 60).toFixed(1) + ' 分钟' : Math.round(secs) + ' 秒'));
      const lp2 = $('#ggLongPx'), sp2 = $('#ggShortPx');
      if (lp2) lp2.textContent = n1(px);
      if (sp2) sp2.textContent = n1(px);
    } else {
      ['#ggTbSell', '#ggTbBuy', '#ggTbSpread', '#ggTbTime', '#ggLongPx', '#ggShortPx'].forEach(s => setT(s, '—'));
      setT('#ggTbConn', '未开局');
    }

    const panel = $('.game-panel');
    if (panel) {
      const ratio = mu > 0 ? e / mu : 9;
      panel.classList.toggle('danger2', mu > 0 && ratio < 1 + MAINTAIN * 3);
      panel.classList.toggle('danger', mu > 0 && ratio < 1 + MAINTAIN * 9 && ratio >= 1 + MAINTAIN * 3);
    }
    const live = $('#ggLive');
    if (live) {
      const hot = mu > 0 && e < mu * 2;
      live.textContent = G.ended ? '已收盘' : (G.running ? (hot ? '⚠ 保证金告急' : '做盘中') : '已暂停');
      live.className = 'gg-live' + (G.ended || !G.running ? ' off' : hot ? ' hot' : '');
    }

    drawCharts();
  }

  function floatText(txt, color, size) {
    const panel = $('.game-panel');
    if (!panel) return;
    const d = document.createElement('div');
    d.className = 'gg-float'; d.textContent = txt; d.style.color = color;
    if (size) d.style.fontSize = size + 'px';
    d.style.left = (16 + Math.random() * 44) + '%';
    d.style.top = '34%';
    panel.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  /* ═══════════════ 主循环 ═══════════════ */
  function tick() {
    if (!G.running || G.ended) return;
    if (G.i >= G.series.length - 1) { endRound('timeup'); return; }

    const prev = equity();
    const prevPx = G.price;
    G.i++;
    G.price = G.series[G.i].c;

    // 挂单 / 止损止盈先跑，再判爆仓 —— 顺序反了的话，止损单会因为
    // "这一根已经先爆仓了"而永远来不及救你。
    processOrders(prevPx);

    const mu = marginUsed();
    if (mu > 0 && equity() <= mu * MAINTAIN) {
      liquidate();
      G.hist.push(G.cash);
      G.peak = Math.max(G.peak, G.cash);
      trackDD();
      if (global.navigator && navigator.vibrate) { try { navigator.vibrate([80, 60, 220]); } catch (e) { } }
      beep(110, .5, 'sawtooth', .09);
      render();
      endRound('liquidated');
      return;
    }

    const e = equity();
    G.hist.push(e);
    G.peak = Math.max(G.peak, e);
    trackDD();

    // 天气事件闪报（数值全是真的）
    flashNews(newsAt(G.i));
    // 保证金告急的滴答声
    if (mu > 0 && e < mu * 1.6) beep(1180, .05, 'square', .022);
    // 里程碑音效
    if (Math.floor(prev / 10000) !== Math.floor(e / 10000)) beep(e > prev ? 880 : 320, .09, 'triangle', .035);
    render();
  }
  function trackDD() { const e = equity(); if (G.peak > 0) G.maxDD = Math.max(G.maxDD, (G.peak - e) / G.peak); }

  function startTimer() {
    stopTimer();
    G.timer = setInterval(tick, 1000 / SPEEDS[G.speedIdx]);
  }
  function stopTimer() { if (G.timer) { clearInterval(G.timer); G.timer = null; } }

  /* ═══════════════ 一局的生命周期 ═══════════════ */
  function resetState() {
    G.i = 0;
    G.price = G.series.length ? G.series[0].c : 0;
    G.cash = G.cash0;
    G.pos = 0; G.avg = 0;
    G.peak = G.cash0; G.maxDD = 0; G.trades = 0;
    G.fills = [];
    G.orders = []; G.orderSeq = 0;
    G.hist = [G.cash0];
    G.liqPrice = null; G.liqAt = 0; G.lastNews = '';
    G.ended = false;
  }

  async function beginRound() {
    const cover = $('#ggCover');
    const app = global.__APP;
    const city = (app && app.S && app.S.cur) || null;
    if (!city) { toast('先选一个城市'); return; }

    if (cover) cover.innerHTML = '<div class="gg-card"><h2>取行情中…</h2><p>正在取 <b>' + city.name + '</b> 的 15 分钟天气行情</p><p class="dim">本地 92 天的对流能量 / 阵风 / 降水，外加同省城市的大盘，第一次要几秒。</p></div>';

    // 本地行情与区域大盘并发取；大盘拿不到不算失败（退化成纯本地行情）
    let mn = null, reg = null;
    try {
      const both = await Promise.all([
        API.OpenMeteo.minutely(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.regionIndex(city).catch(() => null)
      ]);
      mn = both[0]; reg = both[1];
    } catch (e) { mn = null; reg = null; }

    const picked = mn && pickSeries(mn, reg, city);
    if (!picked) {
      if (cover) cover.innerHTML = '<div class="gg-card"><h2 class="lose">取不到行情</h2>' +
        '<p>15 分钟级天气数据没取回来（多半是 Open-Meteo 那边不通或额度用完了）。</p>' +
        '<p class="dim">过一会儿再试，或者换一个城市。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggRetry">再试一次</button>' +
        '<button class="gg-short" id="ggQuit">退出</button></div></div>';
      bindCoverOnce();
      return;
    }

    G.city = city;
    G.series = picked.series;
    G.seeds = picked.seeds;
    G.sev = picked.sevWin;
    G.regLine = picked.regLine;      // 大盘线（没有就是 null，图上也就不画）
    G.regFrom = picked.regFrom || 0;
    G.regCities = picked.regCities;  // 组成大盘的城市名，显示在副图标题上
    resetState();
    readTheme();
    ensureCharts();
    if (cover) cover.hidden = true;

    G.running = true;
    startTimer();
    render();
  }

  function endRound(why) {
    G.running = false;
    G.ended = true;
    stopTimer();

    const finalEq = (why === 'liquidated') ? G.cash : equity();
    const ret = finalEq / G.cash0;
    const profit = finalEq - G.cash0;
    const liq = why === 'liquidated';

    let gr = 'E';
    if (liq) gr = 'F';
    else if (ret >= 5) gr = 'SSS';
    else if (ret >= 3) gr = 'S';
    else if (ret >= 2) gr = 'A';
    else if (ret >= 1.5) gr = 'B';
    else if (ret >= 1.15) gr = 'C';
    else if (ret >= 1.0) gr = 'D';

    const verdict = liq
      ? (G.lev >= 50 ? '百倍杠杆，反向一两个点就没了 —— 这正是久留美的下场。'
        : G.lev >= 20 ? '天台档 + 满仓，气象台都没你亏得快。'
          : G.lev >= 10 ? '十倍杠杆下，天气反向走一点点就清零了。'
            : '不是你方向错了，是你仓位太大了。')
      : profit > 0 ? (ret >= 2 ? '这波对流被你吃干净了。' : '见好就收，也是一种本事。')
        : '没亏就是赢，天气这东西本来就不好赌。';

    // 最佳记录存**收益率**而不是金额 —— 本金能改了，拿「赚了多少万」比大小没意义
    // （本金 1000 万赚 5 万和本金 1 万赚 5 万完全不是一回事）。
    // 用新键，老的绝对金额记录自然失效，不用做迁移。
    const rPct = (ret - 1) * 100;
    const bestP = storeGet('wxgame_bestp', null);
    const isNewBest = bestP == null || rPct > +bestP;
    if (isNewBest) { storeSet('wxgame_bestp', rPct.toFixed(2)); storeSet('wxgame_bestc', G.cash0); }
    const bestShow = isNewBest ? rPct : +bestP;
    const bestCash = isNewBest ? G.cash0 : +(storeGet('wxgame_bestc', 0) || 0);

    const btns = '<div class="gg-btns"><button class="gg-long" id="ggAgain">再来一局</button>' +
      '<button class="gg-short" id="ggQuit">退出</button></div>';

    const cover = $('#ggCover');
    if (cover) {
      cover.innerHTML =
        '<div class="gg-card">' +
        (liq ? '<div class="gg-flash"></div>' : '') +
        '<h2 class="' + (profit >= 0 ? 'win' : 'lose') + '">' + (liq ? '爆 仓' : profit >= 0 ? '收 盘 盈 利' : '收 盘 亏 损') + '</h2>' +
        '<div class="gg-grade">' + gr + '</div>' +
        '<div class="gg-final" style="color:' + colorOf(profit) + '">' + money(finalEq) + '</div>' +
        '<p>' + (liq ? '权益跌破维持保证金，被强制平仓。' : '10 天走完，自动结算。') + '</p>' +
        '<p style="color:' + colorOf(profit) + '">' + sgnMoney(profit) + '　（' + (profit >= 0 ? '+' : '') + ((ret - 1) * 100).toFixed(2) + '%）</p>' +
        '<div class="gg-tbl">' +
        '<div class="gg-row"><span>标的</span><span>' + (G.city ? G.city.name : '—') + ' WXI 天气指数</span></div>' +
        '<div class="gg-row"><span>本金</span><span>' + money(G.cash0) + '</span></div>' +
        '<div class="gg-row"><span>杠杆</span><span>' + G.lev + ' 倍</span></div>' +
        '<div class="gg-row"><span>爆仓时点</span><span>' + (liq ? (labelAt(G.liqAt) + '　@ ' + n1(G.liqPrice)) : '—') + '</span></div>' +
        '<div class="gg-row"><span>最大回撤</span><span>' + (G.maxDD * 100).toFixed(1) + '%</span></div>' +
        '<div class="gg-row"><span>下单次数</span><span>' + G.trades + '</span></div>' +
        '<div class="gg-row"><span>本机最佳</span><span>' + (bestShow >= 0 ? '+' : '') + (+bestShow).toFixed(2) + '%' +
        '<span class="dim" style="font-weight:400">　（本金 ' + money(bestCash) + '）</span></span></div>' +
        '</div>' +
        '<p class="dim" style="font-size:12px">' + verdict + '</p>' +
        btns +
        '</div>';
      cover.hidden = false;
    }
    if (liq) { floatText('爆 仓', '#ff4d4f', 34); beep(90, .7, 'sawtooth', .1); }
    bindCoverOnce();
    render();
  }

  function bindCoverOnce() {
    const a = $('#ggAgain'), r = $('#ggRetry'), q = $('#ggQuit');
    if (a) a.onclick = () => beginRound();
    if (r) r.onclick = () => beginRound();
    if (q) q.onclick = () => close();
    // 本金选择器（只出现在开场卡片里）
    U.$$('.gg-cbtn').forEach(b => { b.onclick = () => setCash(+b.dataset.cash); });
    const inp = $('#ggCash');
    if (inp) {
      // 边打边改会一次次 clamp，光标乱跳，所以只在失焦/回车时落地
      inp.onchange = () => setCash(inp.value);
      inp.onkeydown = e => { if (e.key === 'Enter') { setCash(inp.value); inp.blur(); } };
    }
    cashTip();
  }

  /* ═══════════════ 交互 ═══════════════ */
  function trade(dir) {
    if (!G.running || G.ended) return;
    const lots = Math.floor(maxLots() * G.pct / 100);
    if (lots < 1) { toast('可用保证金不够开 1 手'); return; }
    applyFill(dir * lots);
    beep(dir > 0 ? 660 : 440, .07, 'square', .03);
    const r = $('.gg-right');
    if (r) { r.classList.remove('gg-pop'); void r.offsetWidth; r.classList.add('gg-pop'); }
    render();
  }

  function closeAll() {
    if (!G.running || G.ended || !G.pos) return;
    applyFill(-G.pos);
    beep(520, .08, 'square', .03);
    render();
  }

  function setSeg(sel, attr, val) {
    U.$$(sel).forEach(b => b.classList.toggle('on', b.dataset[attr] === String(val)));
  }

  /* 本金选择器（只在开场卡片里，局中不给改 —— 亏了再充值就不叫操盘了）。
     顺手算出「按基准 1000 点，这个本金在当前杠杆下满仓能开多少手」，
     好让人直观感到本金大小到底影响什么。 */
  function cashRowHTML() {
    const chips = CASH_PRESETS.map(v =>
      '<button type="button" class="gg-cbtn' + (v === G.cash0 ? ' on' : '') + '" data-cash="' + v + '">' +
      cashShort(v) + '</button>').join('');
    return '<div class="gg-cash">' +
      '<div class="gg-cash-head"><span>本金</span><b id="ggCashShow">' + money(G.cash0) + '</b></div>' +
      '<div class="gg-cash-row">' + chips +
      '<input class="gg-inp" id="ggCash" type="number" inputmode="numeric" step="1000" ' +
      'min="' + CASH_MIN + '" max="' + CASH_MAX + '" value="' + G.cash0 + '" title="自定义本金（' +
      n0(CASH_MIN) + ' ~ ' + n0(CASH_MAX) + '）"></div>' +
      '<p class="gg-cash-tip" id="ggCashTip"></p>' +
      '</div>';
  }
  function cashShort(v) {
    if (v >= 10000) { const w = v / 10000; return (w % 1 ? w.toFixed(1) : w) + ' 万'; }
    return n0(v);
  }
  // 本金能改，但**难度不变**：仓位按百分比开，本金翻 10 倍手数也翻 10 倍。
  // 真正变的是取整精度和数字观感 —— 这条必须写清楚，否则等于骗人。
  function cashTip() {
    const T = $('#ggCashTip');
    if (!T) return;
    const lots = Math.floor(G.cash0 / (BASE * LOT_MULT / G.lev));
    T.innerHTML = '按基准 <b>' + BASE + '</b> 点、当前 <b>' + G.lev + '×</b> 杠杆，满仓约 <b>' + n0(lots) +
      '</b> 手。<br>本金<b>不改变难度</b>：仓位按百分比开，本金翻 10 倍手数也翻 10 倍，盈亏比例一样。' +
      '变的只是取整精度 —— 本金越小越难开出想要的仓位。';
  }
  function setCash(v) {
    v = Math.round(+v);
    if (!isFinite(v) || v <= 0) v = DEF_CASH;
    v = Math.max(CASH_MIN, Math.min(CASH_MAX, v));
    G.cash0 = v;
    storeSet('wxgame_cash', v);
    const s = $('#ggCashShow'); if (s) s.textContent = money(v);
    const inp = $('#ggCash'); if (inp && +inp.value !== v) inp.value = v;
    U.$$('.gg-cbtn').forEach(b => b.classList.toggle('on', +b.dataset.cash === v));
    cashTip();
  }

  /* ═══════════════ 开关面板 ═══════════════ */
  function open() {
    readTheme();
    const mask = $('#game');
    if (!mask) return;
    mask.hidden = false;
    G.open = true;
    // 本金存的是"上次用过的"，第一次进来是默认值
    const saved = Math.round(+(storeGet('wxgame_cash', DEF_CASH) || DEF_CASH));
    G.cash0 = (isFinite(saved) && saved >= CASH_MIN && saved <= CASH_MAX) ? saved : DEF_CASH;
    const cover = $('#ggCover');
    if (cover) {
      const app = global.__APP;
      const cityName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
      cover.hidden = false;
      cover.innerHTML =
        '<div class="gg-card">' +
        '<h2 style="font-size:22px;letter-spacing:2px">🎮 点击做空天气</h2>' +
        '<p>标的：<b>WXI 复合天气指数</b> —— <b>' + cityName + '</b> 本地的对流能量 / 阵风 / 降水 / 露点，' +
        '<b>外加同省城市平均出来的「大盘」</b>，再叠一层盘子扰动。<br>' +
        '打雷下雨 = 拉升，天气转好 = 回落。你不知道这段是哪年哪月 —— 只能靠盘感。</p>' +
        cashRowHTML() +
        '<ul class="gg-rules">' +
        '<li>一局 <b>10 天</b>（960 根 15 分钟 K 线）。</li>' +
        '<li>图上那条<b style="color:#c792ea">紫色虚线就是大盘</b>（同省 8 城等权平均）。' +
        '本地跑赢大盘 = 自己这块地在出事；本地跟着大盘走 = 一场天气过程路过。</li>' +
        '<li>合约：指数每动 <code>1 点</code>，每手盈亏 <code>¥10</code>。</li>' +
        '<li>杠杆决定保证金：满仓时反向走 <code>(1−10%)÷杠杆</code> 就<u>爆仓</u>。' +
        '10 倍约 9%、20 倍约 4.5%、<b>100 倍只要 0.9%</b>。</li>' +
        '<li>手续费万分之五，开平都收。</li>' +
        '<li>右侧随时看得到<b>强平价</b>和<b>爆仓距离</b> —— 碰到就结束。</li>' +
        '<li>行情速度 <b>1.5× / 3× / 6×</b> 根每秒，一局约 <b>2.7 ~ 10.7 分钟</b>，随时能暂停。</li>' +
        '</ul>' +
        '<p class="dim" style="font-size:12px">纯娱乐，和真实气象服务无关，也别拿这套路去真赌天气。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggAgain">开始操盘</button>' +
        '<button class="gg-short" id="ggQuit">算了</button></div>' +
        '</div>';
      bindCoverOnce();
    }
    setTimeout(() => {
      ensureCharts();
      readTheme();
      setSeg('#ggLev button', 'lev', G.lev);
      setSeg('#ggPct button', 'pct', G.pct);
      setSeg('#ggSpeed button', 'sp', G.speedIdx);
      render();
    }, 30);
  }

  function close() {
    stopTimer();
    G.running = false; G.open = false;
    const mask = $('#game');
    if (mask) mask.hidden = true;
    disposeCharts();
  }

  /* ═══════════════ 接线 ═══════════════ */
  function bind() {
    const btn = $('#btnGame');
    if (btn) btn.addEventListener('click', open);
    const x = $('#ggExit');
    if (x) x.addEventListener('click', close);
    const mask = $('#game');
    if (mask) mask.addEventListener('click', e => { if (e.target === mask) close(); });

    const L = $('#ggLong'), S = $('#ggShort'), C = $('#ggClosePos');
    if (L) L.addEventListener('click', () => trade(1));
    if (S) S.addEventListener('click', () => trade(-1));
    if (C) C.addEventListener('click', closeAll);

    // ── 挂单 ──
    // 价格框空着就按现价预填：绝大多数时候你想挂的就是"现价上下一点点"，
    // 每次手打五位数字太反人类。
    const ordPx = $('#ggOrdPx'), ordLots = $('#ggOrdLots');
    function readPx() {
      const v = parseFloat(ordPx && ordPx.value);
      return (isFinite(v) && v > 0) ? v : G.price;
    }
    function readLots() {
      const v = Math.floor(parseFloat(ordLots && ordLots.value));
      if (isFinite(v) && v >= 1) return v;
      return Math.floor(maxLots() * G.pct / 100);
    }
    function ordFeedback(err) {
      if (err) { toast(err); beep(200, .12, 'square', .04); }
      else render();
    }
    const ob = $('#ggOrdBuy'), os = $('#ggOrdSell'), sl = $('#ggSetSl'), tp = $('#ggSetTp');
    if (ob) ob.addEventListener('click', () => ordFeedback(placeLimit(1, readPx(), readLots())));
    if (os) os.addEventListener('click', () => ordFeedback(placeLimit(-1, readPx(), readLots())));
    if (sl) sl.addEventListener('click', () => ordFeedback(setStop('sl', readPx())));
    if (tp) tp.addEventListener('click', () => ordFeedback(setStop('tp', readPx())));
    // 撤单用事件委托 —— 列表每次 render 都是重建的，逐个绑会漏
    const ordBox = $('#ggOrders');
    if (ordBox) ordBox.addEventListener('click', e => {
      const b = e.target.closest('[data-cancel]');
      if (!b) return;
      cancelOrder(+b.dataset.cancel);
      render();
    });

    U.$$('#ggLev button').forEach(b => b.addEventListener('click', () => {
      G.lev = +b.dataset.lev; setSeg('#ggLev button', 'lev', G.lev); render();
    }));
    U.$$('#ggPct button').forEach(b => b.addEventListener('click', () => {
      G.pct = +b.dataset.pct; setSeg('#ggPct button', 'pct', G.pct); render();
    }));
    U.$$('#ggSpeed button').forEach(b => b.addEventListener('click', () => {
      G.speedIdx = +b.dataset.sp; setSeg('#ggSpeed button', 'sp', G.speedIdx);
      if (G.running) startTimer();
    }));
    const snd = $('#ggSound');
    if (snd) snd.addEventListener('click', () => {
      G.sound = !G.sound; snd.textContent = G.sound ? '🔊' : '🔇';
      snd.title = G.sound ? '音效：开' : '音效：关';
    });

    // 键盘：↑/W 做多，↓/S 做空，空格平仓 —— 手速快才跟得上 24 根/秒
    global.addEventListener('keydown', e => {
      if (!G.open) return;
      if (e.key === 'Escape') { close(); return; }
      if (!G.running || G.ended) return;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { trade(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { trade(-1); e.preventDefault(); }
      else if (e.key === ' ') { closeAll(); e.preventDefault(); }
    });
    global.addEventListener('resize', U.debounce(() => { if (G.open) { if (G.main) G.main.resize(); if (G.eqc) G.eqc.resize(); } }, 120));
  }

  global.Game = {
    open, close, G, bind,
    _t: {
      pickSeries, severity, ema, median, robustScale, applyFill, applyFillAt, equity, marginUsed,
      liqPriceOf, maxLots, beginRound, endRound, tick, beep, labelAt, newsAt, visBars,
      tolerablePct, placeLimit, setStop, cancelOrder, processOrders, calendarAt, freeEq,
      reservedMargin, JUMP_AT, setCash, cashTip, cityWeight, dishScale,
      LEVS, ROUND_BARS, PER_DAY, LOT_MULT, MAINTAIN, FEE_RATE,
      BASE, DEF_CASH, CASH_MIN, CASH_MAX, CASH_PRESETS,
      REG_K, DEW_K, DISH_K, DISH_DECAY
    }
  };

  bind();

  // ?game=1 直接开局（和 ?help=1 / ?welcome=1 一个路子）
  try { if (/[?&]game=1\b/.test(global.location.search)) setTimeout(open, 500); } catch (e) { }
})(window);
