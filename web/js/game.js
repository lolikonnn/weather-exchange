/* ═══════════════════════════════════════════════════════════════
   game.js — 「天气操盘手」：用真实的历史天气当行情，做多做空、加杠杆
   ═══════════════════════════════════════════════════════════════

   设计要点（改之前先读）：

   ① **行情是真的**。开局时从当前城市已经取回来的逐小时气温序列里，
      随机截一段连续的 120 小时（5 天）**真实历史**（只用 `i0` 之前的部分，
      绝不碰预报段）。玩家不知道这段是哪年哪月 —— 界面上只显示「第 3 天 14:00」，
      否则一查历史就知道后面怎么走，游戏就没了。

   ② **价格就是气温**，单位 ℃。合约规格写死：1 手、气温每动 1℃ 盈亏 100 元。
      杠杆决定的是保证金，不是盈亏 ——
      满仓 + N 倍杠杆时，反向走 (1-维持率)/N 就爆仓。5 倍 ≈ 反向 18%，
      10 倍 ≈ 9%，20 倍 ≈ 4.5%。按 25℃ 算，20 倍天台档只要反向 1.1℃ 就没了。

   ③ **滚动揭示**。图只画已经走过的那一段，跟真行情一样。所以
      `render()` 每次都要用 `G.i` 把数据切短，不能一次把 120 个点全塞进去。

   ④ **爆仓是真爆**。权益跌破「占用保证金 × MAINTAIN」就强平，
      不是"亏光本金"那种假爆仓：5 倍满仓爆掉只剩 10%，20 倍同理，
      杠杆越高剩下的绝对金额越少 —— 这正是杠杆的教训。
*/
(function (global) {
  'use strict';
  const { $, el, storeGet, storeSet, toast } = U;

  /* ═══════════════ 合约与规则 ═══════════════ */
  const START_CASH  = 100000;   // 初始资金
  const LOT_MULT    = 100;      // 1 手 × 1℃ = 100 元
  const FEE_RATE    = 0.0004;   // 单边手续费，万分之四
  const MAINTAIN    = 0.10;     // 维持保证金率：权益 ≤ 占用保证金 × 10% 就强平
  const ROUND_HOURS = 120;      // 一局 120 个"小时" = 5 天
  const SPEEDS      = [1, 3, 8]; // 每个真实秒推进几个"小时"

  const LEVS = [
    { v: 1,  n: '1×',  t: '稳健', cls: '' },
    { v: 5,  n: '5×',  t: '激进', cls: '' },
    { v: 10, n: '10×', t: '疯狂', cls: 'lev-danger' },
    { v: 20, n: '20×', t: '天台', cls: 'lev-danger' }
  ];

  /* ═══════════════ 运行状态 ═══════════════ */
  const G = {
    open: false,
    running: false,
    ended: false,
    city: null,
    series: [],       // [{ t: 原始时间, v: 气温 }]，长度 ROUND_HOURS + 1
    i: 0,
    price: 0,
    cash: START_CASH,
    pos: 0,           // 净持仓手数，正 = 多
    avg: 0,           // 持仓均价（℃）
    lev: 5,
    pct: 30,          // 单次下单占可用购买力的百分比
    speedIdx: 1,
    timer: null,
    peak: START_CASH,
    maxDD: 0,
    trades: 0,
    hist: [],         // 权益曲线
    liqPrice: null,
    liqAt: 0,
    sound: true,
    main: null,       // ECharts 实例
    eqc: null
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
  const n2 = v => (isFinite(v) ? v : 0).toFixed(2);
  function money(v) {
    const neg = v < 0;
    return (neg ? '-' : '') + '¥' + n0(Math.abs(v));
  }
  function sgnMoney(v) { return (v >= 0 ? '+' : '-') + '¥' + n0(Math.abs(v)); }
  function colorOf(v) { return v > 0 ? THEME.up : v < 0 ? THEME.down : THEME.flat; }

  /* ═══════════════ 账户数学 ═══════════════ */
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

  /* ═══════════════ 成交 ═══════════════
     q > 0 买入开多，q < 0 卖出开空。同向加仓摊均价，反向先平后反手。 */
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
      G.cash += old * (p - G.avg) * LOT_MULT;  // 先把原仓平掉
      G.avg = p;                                // 剩下的按当前价开反向仓
    }
    G.cash -= fee;
    G.pos = old + q;
    if (!G.pos) G.avg = 0;
    G.trades++;
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

  /* ═══════════════ 行情取样 ═══════════════ */
  /** 从 hourly 里随机截一段连续的真实历史气温；取不到返回 null */
  function pickSeries(hourly) {
    const T = (hourly && hourly.time) || [], V = (hourly && hourly.temp) || [];
    if (T.length < 2 || V.length < 2) return null;
    // 只用"现在"之前的部分：预报段不能拿来当已发生的行情
    const end = Math.max(2, Math.min(V.length, hourly.i0 || 24));
    const need = ROUND_HOURS + 1;
    if (end < need + 1) return null;
    const maxStart = end - need;
    // 试几次，遇到缺测就换一段
    for (let k = 0; k < 24; k++) {
      const s = Math.floor(Math.random() * (maxStart + 1));
      const out = [];
      let ok = true;
      for (let i = 0; i < need; i++) {
        const v = V[s + i];
        if (v == null || !isFinite(v)) { ok = false; break; }
        out.push({ t: T[s + i], v: +v });
      }
      if (ok) return out;
    }
    return null;
  }

  function labelAt(i) {
    const day = Math.floor(i / 24) + 1, hr = i % 24;
    return hr === 0 ? ('第 ' + day + ' 天') : ('D' + day + ' ' + U.pad2(hr) + ':00');
  }

  /* ═══════════════ 音效（WebAudio，不引资源文件） ═══════════════ */
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
    } catch (e) { /* 没声音也要能玩 */ }
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

  function drawCharts() {
    if (!G.main || !G.eqc || !G.series.length) return;
    // G.i 正常不会越界（tick 开头有守卫），但状态可能被外部改过（调试/探针、
    // 或者开局那一下 beginRound 重入），夹一下总比崩在 series[i].v 上强。
    const n = Math.min(G.i + 1, G.series.length);
    // 横轴标签个数按容器宽度算：一个 "D1 08:00" 大概 52~58px，
    // 写死 8 个的话手机竖屏（绘图区才 ~290px）会挤成一团。
    const cw = (G.main.getWidth && G.main.getWidth()) || 800;
    const want = Math.max(3, Math.floor(cw / 62));
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) { xs.push(labelAt(i)); ys.push(G.series[i].v); }

    const up = G.pos >= 0 ? THEME.up : THEME.down;
    const marks = [];
    if (G.pos) {
      marks.push({ yAxis: G.avg, lineStyle: { color: THEME.ac, type: 'dashed', width: 1 }, label: { formatter: '持仓均价 ' + n2(G.avg), color: THEME.ac, fontSize: 10, position: 'insideStartTop' } });
      const lp = liqPriceOf();
      if (lp != null && isFinite(lp)) {
        marks.push({ yAxis: lp, lineStyle: { color: THEME.down, type: 'dotted', width: 1.2 }, label: { formatter: '强平价 ' + n2(lp), color: THEME.down, fontSize: 10, position: 'insideStartBottom' } });
      }
    }
    G.main.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 46, right: 54, top: 22, bottom: 22 },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)', borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 }, formatter: p => { const it = p[0]; return it ? labelAt(it.dataIndex) + '<br/>气温 <b>' + n2(it.value) + ' ℃</b>' : ''; } },
      xAxis: {
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: THEME.line } },
        axisLabel: { color: THEME.dim, fontSize: 10, hideOverlap: true, interval: Math.max(0, Math.ceil(xs.length / want) - 1) },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { color: THEME.dim, fontSize: 10, formatter: v => v.toFixed(1) },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } }
      },
      series: [{
        name: '气温', type: 'line', data: ys, showSymbol: false, z: 3,
        lineStyle: { width: 1.6, color: up },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: up + '4d' }, { offset: 1, color: up + '05' }]) },
        markLine: marks.length ? { silent: true, symbol: 'none', data: marks } : undefined,
        markPoint: G.i > 0 ? { symbol: 'circle', symbolSize: 7, data: [{ coord: [xs.length - 1, ys[ys.length - 1]], itemStyle: { color: up }, label: { show: true, formatter: n2(ys[ys.length - 1]), position: 'right', color: up, fontSize: 10 } }] } : undefined
      }]
    }, true);

    const e = G.hist.length ? G.hist : [G.cash];
    const base = START_CASH;
    const last = e[e.length - 1];
    const col = colorOf(last - base);
    G.eqc.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 46, right: 54, top: 8, bottom: 16 },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)', borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 }, formatter: p => { const it = p[0]; return it ? labelAt(it.dataIndex) + '<br/>权益 <b>' + money(it.value) + '</b>' : ''; } },
      xAxis: { type: 'category', data: xs.slice(0, e.length), boundaryGap: false, axisLine: { lineStyle: { color: THEME.line } }, axisLabel: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: THEME.dim, fontSize: 9, formatter: v => Math.round(v / 1000) + 'k' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } } },
      series: [{
        name: '权益', type: 'line', data: e, showSymbol: false,
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
      chgEl.textContent = sgnMoney(diff) + '  (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      chgEl.style.color = col;
    }

    const mu = marginUsed(), lp = liqPriceOf();
    const rows = [
      ['现价', G.pos || G.i ? n2(G.price) + ' ℃' : '—', 0],
      ['可用保证金', money(freeEq()), freeEq() < 0 ? -1 : 0],
      ['占用保证金', G.pos ? money(mu) : '—', 0],
      ['持仓', G.pos ? (G.pos > 0 ? '多 ' : '空 ') + Math.abs(G.pos) + ' 手' : '空仓', G.pos > 0 ? 1 : G.pos < 0 ? -1 : 0],
      ['持仓均价', G.pos ? n2(G.avg) + ' ℃' : '—', 0],
      ['浮动盈亏', G.pos ? sgnMoney(unreal()) : '—', G.pos ? Math.sign(unreal()) : 0],
      ['强平价', (G.pos && lp != null && isFinite(lp)) ? n2(lp) + ' ℃' : '—', 0]
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
      const when = G.series.length ? ('第 ' + (Math.floor(G.i / 24) + 1) + ' 天 ' + U.pad2(G.i % 24) + ':00　·　' + G.i + ' / ' + ROUND_HOURS + ' 小时') : '—';
      sub.textContent = G.city ? (G.city.name + ' 气温合约　·　' + when + '　·　' + G.lev + ' 倍杠杆') : when;
    }

    const lots = Math.floor(maxLots() * G.pct / 100);
    const lab = $('#ggLots');
    if (lab) lab.textContent = G.pct + '% ≈ ' + lots + ' 手' + (lots < 1 ? '（不够 1 手）' : '');
    const bl = $('#ggLong'), bs = $('#ggShort');
    if (bl) bl.disabled = bs.disabled = (G.ended || !G.running || lots < 1);
    const bc = $('#ggClosePos');
    if (bc) bc.disabled = !G.pos;

    // 危险态
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

  function floatText(txt, color) {
    const panel = $('.game-panel');
    if (!panel) return;
    const d = document.createElement('div');
    d.className = 'gg-float'; d.textContent = txt; d.style.color = color;
    d.style.left = (24 + Math.random() * 40) + '%';
    d.style.top = '44%';
    panel.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  /* ═══════════════ 主循环 ═══════════════ */
  function tick() {
    if (!G.running || G.ended) return;
    if (G.i >= G.series.length - 1) { endRound('timeup'); return; }

    const prev = equity();
    G.i++;
    G.price = G.series[G.i].v;

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

    // 里程碑音效：每翻过一万一档
    if (Math.floor(prev / 10000) !== Math.floor(e / 10000)) {
      beep(e > prev ? 880 : 320, .09, 'triangle', .035);
    }
    render();
  }
  function trackDD() { const e = equity(); if (G.peak > 0) G.maxDD = Math.max(G.maxDD, (G.peak - e) / G.peak); }

  function startTimer() {
    stopTimer();
    const per = 1000 / SPEEDS[G.speedIdx];
    G.timer = setInterval(tick, per);
  }
  function stopTimer() { if (G.timer) { clearInterval(G.timer); G.timer = null; } }

  /* ═══════════════ 一局的生命周期 ═══════════════ */
  function resetState() {
    G.i = 0;
    G.price = G.series.length ? G.series[0].v : 0;
    G.cash = START_CASH;
    G.pos = 0; G.avg = 0;
    G.peak = START_CASH; G.maxDD = 0; G.trades = 0;
    G.hist = [START_CASH];
    G.liqPrice = null; G.liqAt = 0;
    G.ended = false;
  }

  async function beginRound() {
    const cover = $('#ggCover');
    const app = global.__APP;
    const city = (app && app.S && app.S.cur) || null;
    if (!city) { toast('先选一个城市'); return; }

    let wx = (app.S.wx && app.S.wx.hourly) ? app.S.wx : null;
    if (!wx || !wx.temp || !wx.temp.length) {
      if (cover) cover.innerHTML = '<div class="gg-card"><h2>取行情中…</h2><p>正在取 <b>' + city.name + '</b> 的历史气温</p></div>';
      try { wx = await global.Weather.ensure(city); } catch (e) { wx = null; }
    }
    const series = wx && pickSeries(wx.hourly);
    if (!series) {
      if (cover) cover.innerHTML = '<div class="gg-card"><h2 class="lose">取不到行情</h2>' +
        '<p>这个城市的历史逐小时气温还没取回来（多半是 Open-Meteo 那边不通）。</p>' +
        '<p class="dim">等主图能正常显示 K 线了再回来玩。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggRetry">再试一次</button>' +
        '<button class="gg-short" id="ggQuit">退出</button></div></div>';
      bindCoverOnce();
      return;
    }

    G.city = city;
    G.series = series;
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
    else if (ret >= 3) gr = 'S';
    else if (ret >= 2) gr = 'A';
    else if (ret >= 1.5) gr = 'B';
    else if (ret >= 1.15) gr = 'C';
    else if (ret >= 1.0) gr = 'D';

    const verdict = liq
      ? (G.lev >= 20 ? '天台档 + 满仓，气象台都没你亏得快。' : G.lev >= 10 ? '十倍杠杆下，气温反向走一点点就清零了。' : '不是你方向错了，是你仓位太大了。')
      : profit > 0 ? '见好就收，也是一种本事。' : '没亏就是赢，天气这东西本来就不好赌。';

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
        '<div class="gg-row"><span>标的</span><span>' + (G.city ? G.city.name : '—') + ' 气温合约</span></div>' +
        '<div class="gg-row"><span>杠杆</span><span>' + G.lev + ' 倍</span></div>' +
        '<div class="gg-row"><span>爆仓时点</span><span>' + (liq ? ('第 ' + (Math.floor(G.liqAt / 24) + 1) + ' 天 ' + U.pad2(G.liqAt % 24) + ':00　@ ' + n2(G.liqPrice) + ' ℃') : '—') + '</span></div>' +
        '<div class="gg-row"><span>最大回撤</span><span>' + (G.maxDD * 100).toFixed(1) + '%</span></div>' +
        '<div class="gg-row"><span>下单次数</span><span>' + G.trades + '</span></div>' +
        '<div class="gg-row"><span>本机最佳</span><span>' + sgnMoney(best) + '</span></div>' +
        '</div>' +
        '<p class="dim" style="font-size:12px">' + verdict + '</p>' +
        btns +
        '</div>';
      cover.hidden = false;
    }
    if (liq) { floatText('爆 仓', '#ff4d4f'); beep(90, .7, 'sawtooth', .1); }
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
    // 开场说明
    const cover = $('#ggCover');
    if (cover) {
      const app = global.__APP;
      const cityName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
      cover.hidden = false;
      cover.innerHTML =
        '<div class="gg-card">' +
        '<h2 style="font-size:22px;letter-spacing:2px">🎮 天气操盘手</h2>' +
        '<p>用 <b>' + cityName + '</b> 的<b>真实历史气温</b>当行情，做多做空、加杠杆。<br>你不知道这段是哪年哪月 —— 只能靠盘感。</p>' +
        '<ul class="gg-rules">' +
        '<li>本金 <b>¥100,000</b>，一局 <b>5 天</b>（120 个"小时"）。</li>' +
        '<li>合约：气温每动 <code>1℃</code>，每手盈亏 <code>¥100</code>。</li>' +
        '<li>杠杆决定保证金：满仓时反向走 <code>(1−10%)÷杠杆</code> 就<u>爆仓</u>。5 倍约 18%，10 倍约 9%，20 倍约 4.5%。</li>' +
        '<li>手续费万分之四，开平都收。</li>' +
        '<li>界面右上角随时看到<b>强平价</b> —— 价格碰到它，这一局就结束了。</li>' +
        '</ul>' +
        '<p class="dim" style="font-size:12px">纯娱乐，和真实气象服务无关，也别拿这套路去真赌天气。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggAgain">开始操盘</button>' +
        '<button class="gg-short" id="ggQuit">算了</button></div>' +
        '</div>';
      bindCoverOnce();
    }
    // 面板尺寸有了以后才能 init 图表
    setTimeout(() => {
      ensureCharts();
      readTheme();
      setSeg('#ggLev .gg-li', 'lev', G.lev);
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

    // 面板开着时按 Esc 退出
    global.addEventListener('keydown', e => { if (e.key === 'Escape' && G.open) close(); });
    // 面板开着时窗口变化要重排图表
    global.addEventListener('resize', U.debounce(() => { if (G.open) { if (G.main) G.main.resize(); if (G.eqc) G.eqc.resize(); } }, 120));
  }

  global.Game = {
    open, close, G, bind,
    _t: { pickSeries, applyFill, equity, marginUsed, liqPriceOf, maxLots, beginRound, endRound, tick, beep }
  };

  bind();

  // ?game=1 直接开局（和 ?help=1 / ?welcome=1 一个路子）：方便分享链接，也方便无头截图自查。
  try { if (/[?&]game=1\b/.test(global.location.search)) setTimeout(open, 500); } catch (e) { }
})(window);
