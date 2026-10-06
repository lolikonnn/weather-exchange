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

   ⑥ **只画最近一屏**。一局 480 根（5 天），全塞进 1100px 的话一根才 2.3px，
      蜡烛会糊成一条线。所以按容器宽度算可视根数并跟着行情自动滑动 ——
      真实的操盘软件也是这么做的。
*/
(function (global) {
  'use strict';
  const { $, el, storeGet, storeSet, toast } = U;

  /* ═══════════════ 合约与规则 ═══════════════ */
  const START_CASH = 100000;   // 初始资金
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
  const ROUND_BARS = 480;      // 一局 480 根 = 5 天
  const SPEEDS     = [4, 10, 24]; // 每个真实秒推进几根 K

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
    series: [],       // [{ t, o, h, l, c }]，长度 ROUND_BARS + 1
    i: 0,
    price: 0,
    cash: START_CASH,
    pos: 0,           // 净持仓手数，正 = 多
    avg: 0,           // 持仓均价（指数点）
    lev: 10,
    pct: 30,
    speedIdx: 1,
    timer: null,
    peak: START_CASH,
    maxDD: 0,
    trades: 0,
    fills: [],        // 最近 5 笔成交，新的在前
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
  function freeEq() { return equity() - marginUsed(); }
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
  function applyFill(q) {
    if (!q) return;
    const p = G.price, old = G.pos;
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
    // 成交记录（最近 5 笔，新的在上）
    const kind = old === 0 ? (q > 0 ? '开多' : '开空')
      : (G.pos === 0 ? '平仓'
        : ((old > 0) === (q > 0) ? (q > 0 ? '加多' : '加空') : (q > 0 ? '减空' : '减多')));
    G.fills.unshift({ at: G.i, kind: kind, lots: Math.abs(q), px: p, fee: fee });
    if (G.fills.length > 5) G.fills.length = 5;
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
  function pickSeries(mn) {
    if (!mn || !mn.time || !mn.time.length) return null;
    const n = mn.time.length;
    let i0 = mn.time.findIndex(t => t >= nowLocalStr());
    if (i0 < 0) i0 = n;
    // 只用"现在"之前的：预报段不能拿来当已发生的行情
    const end = Math.max(2, Math.min(n, i0));
    const need = ROUND_BARS + 2;
    if (end < need + 1) return null;

    const sev = severity(mn);
    const tr = ema(sev, EMA_A);
    const now = nowLocalStr();

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
      let carry = 0;
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
        const px = BASE + (tr[k2] - m) * TREND_K + (sev[k2] - tr[k2]) * NOISE_K + carry;
        series.push({ t: mn.time[k2], c: px });
        seeds.push({
          cape: mn.cape[k2] | 0,
          gust: +(+mn.gust[k2]).toFixed(1),
          precip: +(+(mn.precip[k2] || 0)).toFixed(1),
          wcode: mn.wcode[k2] | 0
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
      return { series, seeds };
    }
    return null;
  }

  function labelAt(i) {
    const day = Math.floor(i / PER_DAY) + 1, m = (i % PER_DAY) * 15;
    const hh = U.pad2(Math.floor(m / 60)), mm = U.pad2(m % 60);
    return (m === 0) ? ('第 ' + day + ' 天') : ('D' + day + ' ' + hh + ':' + mm);
  }

  /* ═══════════════ 新闻闪报（都用真实数值） ═══════════════ */
  /** 返回这一根 K 线上值得播报的天气事件，没有就返回 null */
  function newsAt(i) {
    const s = G.seeds && G.seeds[i];
    if (!s) return null;
    const wc = s.wcode;
    if (wc === 95 || wc === 96 || wc === 99) return { k: 'storm', t: '⚡ 雷暴', v: 'CAPE ' + s.cape };
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
    if (!G.main) G.main = echarts.init($('#ggChart'), null, { renderer: 'canvas' });
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
      }]
    }, true);

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
    const base = START_CASH;
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
    const e = equity(), diff = e - START_CASH, pct = diff / START_CASH * 100;
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
          '　·　' + G.i + ' / ' + ROUND_BARS + ' 根　·　' + G.lev + ' 倍杠杆')
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
      const mm = (G.i % PER_DAY) * 15;
      setT('#ggTbTime', '第 ' + (Math.floor(G.i / PER_DAY) + 1) + ' 天 ' +
        U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60));
      const cost = $('#ggTbSpread');
      if (cost) cost.title = '一手开+平的手续费，合计 ¥' + costYuan.toFixed(2);
      setT('#ggTbConn', G.ended ? '已收盘' : (G.running ? '行情推送中' : '已暂停'));
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
    G.i++;
    G.price = G.series[G.i].c;

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
    G.cash = START_CASH;
    G.pos = 0; G.avg = 0;
    G.peak = START_CASH; G.maxDD = 0; G.trades = 0;
    G.fills = [];
    G.hist = [START_CASH];
    G.liqPrice = null; G.liqAt = 0; G.lastNews = '';
    G.ended = false;
  }

  async function beginRound() {
    const cover = $('#ggCover');
    const app = global.__APP;
    const city = (app && app.S && app.S.cur) || null;
    if (!city) { toast('先选一个城市'); return; }

    if (cover) cover.innerHTML = '<div class="gg-card"><h2>取行情中…</h2><p>正在取 <b>' + city.name + '</b> 的 15 分钟天气行情</p><p class="dim">92 天的对流能量 / 阵风 / 降水，第一次要几秒。</p></div>';

    let mn = null;
    try { mn = await API.OpenMeteo.minutely(city.lat, city.lon); } catch (e) { mn = null; }

    const picked = mn && pickSeries(mn);
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
    const ret = finalEq / START_CASH;
    const profit = finalEq - START_CASH;
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

    const best = Math.max(storeGet('wxgame_best', 0) || 0, profit);
    storeSet('wxgame_best', best);

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
        '<p>' + (liq ? '权益跌破维持保证金，被强制平仓。' : '5 天走完，自动结算。') + '</p>' +
        '<p style="color:' + colorOf(profit) + '">' + sgnMoney(profit) + '　（' + (profit >= 0 ? '+' : '') + ((ret - 1) * 100).toFixed(2) + '%）</p>' +
        '<div class="gg-tbl">' +
        '<div class="gg-row"><span>标的</span><span>' + (G.city ? G.city.name : '—') + ' WXI 天气指数</span></div>' +
        '<div class="gg-row"><span>杠杆</span><span>' + G.lev + ' 倍</span></div>' +
        '<div class="gg-row"><span>爆仓时点</span><span>' + (liq ? (labelAt(G.liqAt) + '　@ ' + n1(G.liqPrice)) : '—') + '</span></div>' +
        '<div class="gg-row"><span>最大回撤</span><span>' + (G.maxDD * 100).toFixed(1) + '%</span></div>' +
        '<div class="gg-row"><span>下单次数</span><span>' + G.trades + '</span></div>' +
        '<div class="gg-row"><span>本机最佳</span><span>' + sgnMoney(best) + '</span></div>' +
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

  /* ═══════════════ 开关面板 ═══════════════ */
  function open() {
    readTheme();
    const mask = $('#game');
    if (!mask) return;
    mask.hidden = false;
    G.open = true;
    const cover = $('#ggCover');
    if (cover) {
      const app = global.__APP;
      const cityName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
      cover.hidden = false;
      cover.innerHTML =
        '<div class="gg-card">' +
        '<h2 style="font-size:22px;letter-spacing:2px">🎮 点击做空天气</h2>' +
        '<p>标的：<b>WXI 天气指数</b>，用 <b>' + cityName + '</b> 的对流能量 / 阵风 / 降水 / 气温合成。<br>' +
        '打雷下雨 = 拉升，天气转好 = 回落。你不知道这段是哪年哪月 —— 只能靠盘感。</p>' +
        '<ul class="gg-rules">' +
        '<li>本金 <b>¥100,000</b>，一局 <b>5 天</b>（480 根 15 分钟 K 线）。</li>' +
        '<li>合约：指数每动 <code>1 点</code>，每手盈亏 <code>¥10</code>。</li>' +
        '<li>杠杆决定保证金：满仓时反向走 <code>(1−10%)÷杠杆</code> 就<u>爆仓</u>。' +
        '10 倍约 9%、20 倍约 4.5%、<b>100 倍只要 0.9%</b>。</li>' +
        '<li>手续费万分之五，开平都收。</li>' +
        '<li>右侧随时看得到<b>强平价</b>和<b>爆仓距离</b> —— 碰到就结束。</li>' +
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
      pickSeries, severity, ema, median, robustScale, applyFill, equity, marginUsed,
      liqPriceOf, maxLots, beginRound, endRound, tick, beep, labelAt, newsAt, visBars,
      tolerablePct,
      LEVS, ROUND_BARS, PER_DAY, LOT_MULT, MAINTAIN, START_CASH, FEE_RATE
    }
  };

  bind();

  // ?game=1 直接开局（和 ?help=1 / ?welcome=1 一个路子）
  try { if (/[?&]game=1\b/.test(global.location.search)) setTimeout(open, 500); } catch (e) { }
})(window);
