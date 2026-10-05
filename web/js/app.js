/* ═══════════════════════════════════════════════════════════════
   app.js — 终端主逻辑
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const { $, el, fx, sgn, cls, storeGet, storeSet, toast, debounce, marketPhase } = U;
  const DEFAULT_WATCH = ['101010100', '101020100', '101280601', '101280101', '101270101', '101210101'];

  const IDX_DEFS = [
    { key: 'sh', name: '沪市气温', id: '101020100', nm: '上海' },
    { key: 'sz', name: '深市气温', id: '101280601', nm: '深圳' },
    { key: 'bj', name: '京市气温', id: '101010100', nm: '北京' },
    { key: 'gz', name: '穗市气温', id: '101280101', nm: '广州' },
    { key: 'cs', name: '湘市气温', id: '101250101', nm: '长沙' },
    { key: 'all', name: '自选均温', computed: true }
  ];

  const S = {
    period: 'trend', ind: 'vol', metric: 'range',
    refreshMs: 3000, sortMode: 0,
    watch: [], cur: null, data: null, wx: null,
    quotes: {}, briefs: {}, idxQ: {}, idxB: {}, briefAt: 0,
    loading: false, timer: null, lastQuoteAt: 0, lastFullAt: 0, tick: 0
  };

  /* ═══════════ 行情计算 ═══════════ */
  function quoteOf(id) {
    const q = S.quotes[id], b = S.briefs[id];
    const temp = (q && q.temp != null) ? q.temp : (b ? b.now : null);
    const prev = b ? b.prevClose : null;
    const chg = (temp != null && prev != null) ? temp - prev : null;
    const pct = (chg != null && prev) ? chg / prev * 100 : null;
    return { temp, prev, chg, pct, q, b };
  }

  /* ═══════════ 指数条 ═══════════ */
  function renderIndexes() {
    const box = $('#indexList');
    const allTemps = S.watch.map(id => quoteOf(id).temp).filter(v => v != null);
    box.innerHTML = '';
    IDX_DEFS.forEach(def => {
      let temp, prev, spark, code;
      if (def.computed) {
        temp = allTemps.length ? allTemps.reduce((a, b) => a + b, 0) / allTemps.length : null;
        const prevs = S.watch.map(id => { const b = S.briefs[id]; return b ? b.prevClose : null; }).filter(v => v != null);
        prev = prevs.length === allTemps.length && prevs.length ? prevs.reduce((a, b) => a + b, 0) / prevs.length : null;
        spark = S.watch.map(id => S.briefs[id]).filter(Boolean).map(b => b.now);
        code = 'WX.ALL';
      } else {
        const q = S.idxQ[def.key], b = S.idxB[def.key];
        temp = (q && q.temp != null) ? q.temp : (b ? b.now : null);
        prev = b ? b.prevClose : null;
        spark = b ? b.sparkPts : null;
        code = def.id;
      }
      const chg = (temp != null && prev != null) ? temp - prev : null;
      const pct = (chg != null && prev) ? chg / prev * 100 : null;
      const col = U.trendColor(chg);

      const cv = el('canvas', { width: 56, height: 18 });
      const item = el('div', {
        class: 'strip-item' + (S.cur && def.id === S.cur.id ? ' on' : ''),
        title: code,
        onclick: () => def.computed ? null : selectCity(def.id)
      }, [
        el('span', { class: 'si-name', text: def.name }),
        el('span', { class: 'si-val', text: temp == null ? '--' : fx(temp, 1) }),
        el('span', { class: 'si-chg', style: { color: col }, text: chg == null ? '--' : sgn(chg, 2) + ' ' + sgn(pct, 2) + '%' }),
        cv
      ]);
      box.appendChild(item);
      drawSpark(cv, spark, col);
    });
  }

  function drawSpark(cv, vals, col) {
    if (!vals || vals.length < 2) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.lineJoin = 'round';
    const d = U.sparkPath(vals, cv.width, cv.height, 2);
    const dm = new Path2D(d);
    ctx.stroke(dm);
    // 面积
    ctx.lineTo(cv.width - 2, cv.height - 1); ctx.lineTo(2, cv.height - 1); ctx.closePath();
    ctx.fillStyle = col + '22'; ctx.fill();
  }

  /* ═══════════ 自选列表 ═══════════ */
  function renderWatchlist() {
    const box = $('#watchlist');
    box.innerHTML = '';
    if (!S.watch.length) { box.appendChild(el('div', { class: 'sr-empty', text: '自选为空，点搜索添加城市' })); return; }
    let ids = S.watch.slice();
    if (S.sortMode === 1) ids.sort((a, b) => (quoteOf(b).pct || -1e9) - (quoteOf(a).pct || -1e9));
    else if (S.sortMode === 2) {
      ids.sort((a, b) => {
        const ca = API.Cities.get(a), cb = API.Cities.get(b);
        return (ca ? ca.name : '').localeCompare(cb ? cb.name : '', 'zh');
      });
    }
    ids.forEach(id => {
      const c = API.Cities.get(id); if (!c) return;
      const q = quoteOf(id);
      const col = U.trendColor(q.chg);
      const row = el('div', {
        class: 'stock-row' + (S.cur && S.cur.id === id ? ' on' : ''),
        onclick: (e) => { if (e.target.classList.contains('sw-del')) return; selectCity(id); }
      }, [
        el('div', {}, [
          el('div', { class: 'sw-name', text: c.name }),
          el('div', { class: 'sw-sub', text: c.id + ' · ' + (c.prov || '') })
        ]),
        el('div', { class: 'sw-price', style: { color: col }, text: q.temp == null ? '--' : fx(q.temp, 1) }),
        el('div', { class: 'sw-pct ' + (q.chg == null ? 'p-flat' : (q.chg > 0 ? 'p-up' : q.chg < 0 ? 'p-down' : 'p-flat')), text: q.pct == null ? '--' : sgn(q.pct, 2) + '%' })
      ]);
      row.appendChild(el('span', { class: 'sw-del', text: '✕', title: '从自选移除', onclick: (e) => { e.stopPropagation(); removeWatch(id); } }));
      box.appendChild(row);
    });
  }

  function renderHotlist() {
    const box = $('#hotlist');
    box.innerHTML = '';
    API.Cities.hot.forEach(c => {
      const q = quoteOf(c.id);
      const col = U.trendColor(q.chg);
      const starred = S.watch.indexOf(c.id) >= 0;
      const row = el('div', {
        class: 'stock-row' + (S.cur && S.cur.id === c.id ? ' on' : ''),
        onclick: (e) => {
          if (e.target.classList.contains('sw-add') || e.target.classList.contains('sw-del')) return;
          selectCity(c.id);
        }
      }, [
        el('div', {}, [
          el('div', { class: 'sw-name', text: c.name }),
          el('div', { class: 'sw-sub', text: c.id + ' · ' + (c.prov || '') })
        ]),
        el('div', { class: 'sw-price', style: { color: col }, text: q.temp == null ? '--' : fx(q.temp, 1) }),
        el('div', { class: 'sw-pct ' + (q.chg == null ? 'p-flat' : (q.chg > 0 ? 'p-up' : q.chg < 0 ? 'p-down' : 'p-flat')), text: q.pct == null ? '--' : sgn(q.pct, 2) + '%' })
      ]);
      // 热门列表原来【没有】加自选的入口，导致除了搜索框 Ctrl+Enter 之外
      // 用户根本没办法把城市加进自选。这里补一个 ＋ / ✕。
      row.appendChild(el('span', {
        class: starred ? 'sw-del' : 'sw-add',
        text: starred ? '✕' : '＋',
        title: starred ? '从自选移除' : '加入自选',
        onclick: (e) => {
          e.stopPropagation();
          if (starred) removeWatch(c.id); else addWatch(c.id);
          renderHotlist(); buildDrawer();
        }
      }));
      box.appendChild(row);
    });
  }

  function addWatch(id) {
    if (S.watch.indexOf(id) >= 0) { toast('已在自选中'); return; }
    S.watch.push(id); storeSet('watch', S.watch);
    renderWatchlist(); warmQuotes(); toast('已加入自选：' + (API.Cities.get(id) || {}).name);
  }
  function removeWatch(id) {
    S.watch = S.watch.filter(x => x !== id); storeSet('watch', S.watch);
    renderWatchlist(); renderIndexes(); toast('已移出自选');
  }

  /* ═══════════ 行情头 ═══════════ */
  function renderQuoteHead() {
    const c = S.cur, d = S.data;
    if (!c || !d) return;
    const q = quoteOf(c.id);
    const ti = d.todayIndex;
    const curBar = ti >= 0 ? d.daily[ti] : null;
    const prevBar = ti > 0 ? d.daily[ti - 1] : null;
    const base = d.base;
    const chg = q.chg, pct = q.pct;
    const col = U.trendColor(chg);

    $('#qName').textContent = c.name;
    $('#qCode').textContent = (c.cma ? c.cma + ' · ' : '') + c.id + (c.prov ? ' · ' + c.prov : '');
    $('#qPrice').textContent = q.temp == null ? '--' : fx(q.temp, 1);
    $('#qPrice').style.color = col;
    $('#qChange').textContent = chg == null ? '--' : sgn(chg, 1);
    $('#qChange').style.color = col;
    $('#qPct').textContent = pct == null ? '--' : sgn(pct, 2) + '%';
    $('#qPct').style.color = col;

    // 标签
    const tags = $('#qTags'); tags.innerHTML = '';
    const wtxt = d.now && d.now.temp != null ? (d.fcst && d.fcst.daily && d.fcst.daily[0] ? d.fcst.daily[0].dayText : '') :
      (curBar && curBar.wcode != null ? API.wmoText(curBar.wcode) : '');
    if (wtxt) tags.appendChild(el('span', { class: 'tag tag-info', text: U.wxIcon(wtxt) + ' ' + wtxt }));
    if (d.now) tags.appendChild(el('span', { class: 'tag tag-src', text: '中国气象局实况 ' + String(d.now.time || '').slice(11, 16) }));
    else tags.appendChild(el('span', { class: 'tag tag-mute', text: '实况不可用' }));
    if (!c.cma) tags.appendChild(el('span', { class: 'tag tag-mute', text: '无官方站号' }));
    if (API.LOCAL) tags.appendChild(el('span', { class: 'tag tag-src', text: '中国天气网代理已连接' }));
    const phase = marketPhase();
    tags.appendChild(el('span', {
      class: 'tag ' + (phase === 'open' ? 'tag-warn' : 'tag-mute'),
      text: phase === 'open' ? '盘中' : phase === 'break' ? '午间休市' : '休市'
    }));

    // 统计格
    const n = d.now || {};
    const om = d.omDaily[curBar ? curBar.d : ''] || {};
    const items = [
      // 标签刻意用天气话写，不用"今开/昨收"这类炒股词 —— 保留炒股软件的"长相"就够了，
      // 不该要求用户会炒股才能看懂（用户反馈："那些炒股软件术语我不炒股看不懂"）。
      ['今日 0 点', curBar ? fx(curBar.o, 1) : '--', curBar && base != null ? U.trendColor(curBar.o - base) : null],
      ['今日最高', curBar ? fx(curBar.h, 1) : '--', U.upColor()],
      ['今日最低', curBar ? fx(curBar.l, 1) : '--', U.downColor()],
      ['昨日 23 点', base == null ? '--' : fx(base, 1), null],
      ['全天波动', curBar ? fx(curBar.h - curBar.l, 1) + ' ℃' : '--', null],
      ['降水量', curBar ? fx(curBar.v, 1) + ' mm' : '--', null],
      ['降水时数', curBar ? (curBar.rainHours || 0) + ' h' : '--', null],
      ['湿度', n.humidity == null ? (curBar && curBar.humAvg != null ? curBar.humAvg + '%' : '--') : n.humidity + '%', null],
      ['风速', n.windSpeed == null ? (curBar && curBar.windAvg != null ? fx(curBar.windAvg, 1) + ' m/s' : '--') : fx(n.windSpeed, 1) + ' m/s ' + U.windLevel(n.windSpeed), null],
      ['气压', n.pressure == null ? '--' : fx(n.pressure, 0) + ' hPa', null],
      ['体感', n.feels == null ? '--' : fx(n.feels, 1) + ' ℃', null],
      ['风向', n.windDir || '--', null],
      ['平均风速', curBar && curBar.windAvg != null ? fx(curBar.windAvg, 1) + ' m/s' : '--', null],
      ['日出', om.sunrise ? String(om.sunrise).slice(11, 16) : '--', null],
      ['日落', om.sunset ? String(om.sunset).slice(11, 16) : '--', null],
      // 标签写短一点：统计格只有 ~107px 宽，"历史今日" + "32.7 / 22.9" 会被省略号截掉
      ['同期', prevBar ? fx(prevBar.h, 1) + '/' + fx(prevBar.l, 1) : '--', null],
      ['观测点', curBar ? curBar.n + ' 个' : '--', null]
    ];
    const box = $('#qStats'); box.innerHTML = '';
    items.forEach(([k, v, c2]) => box.appendChild(el('div', { class: 'qs' }, [
      el('b', { text: k }), el('span', { style: c2 ? { color: c2 } : null, text: String(v) })
    ])));
  }

  /* ═══════════ 五档盘口（未来 5 日预报） ═══════════ */
  /** 统一成 [{date, high, low, dayText, nightText, dayWind, precip, src}]，官方预报优先，缺失时回退 Open-Meteo 16 日预报 */
  function obList() {
    const d = S.data; if (!d || !d.daily || !d.daily.length) return null;
    const out = [];
    const fd = d.fcst && d.fcst.daily;
    if (fd && fd.length > 1) {
      fd.slice(0, 6).forEach(x => {
        const iso = String(x.date).replace(/\//g, '-');
        const om = (d.omDaily && d.omDaily[iso]) || {};
        out.push({
          date: iso, high: x.high, low: x.low,
          dayText: x.dayText, nightText: x.nightText, dayWind: x.dayWind,
          precip: om.precip, src: 'cma'
        });
      });
      return out;
    }
    const ti = d.todayIndex;
    if (ti == null || ti < 0) return null;
    for (let i = ti; i < d.daily.length && out.length < 6; i++) {
      const b = d.daily[i], om = (d.omDaily && d.omDaily[b.d]) || {};
      out.push({
        date: b.d,
        high: b.omHigh != null ? b.omHigh : b.h,
        low: b.omLow != null ? b.omLow : b.l,
        dayText: om.code != null ? API.wmoText(om.code) : '', nightText: '',
        dayWind: '',
        precip: om.precip != null ? om.precip : b.v,
        src: 'om'
      });
    }
    return out.length > 1 ? out : null;
  }

  function renderOrderbook() {
    const box = $('#orderbook');
    box.innerHTML = '';
    const list = obList();
    if (!list || list.length < 2) {
      box.appendChild(el('div', { class: 'sr-empty', text: '暂无预报数据' }));
      return;
    }
    const q = quoteOf(S.cur.id);
    const cur = q.temp;
    const src = list[0].src;
    box.appendChild(el('div', { class: 'ob-src', text: src === 'cma' ? '中国气象局预报 · 未来 5 日' : 'Open-Meteo 预报 · 未来 5 日（官方源不可用）' }));
    // 排布仍照股票盘口的习惯（上高下低、单调排列），但标签换成天气话：
    // 原来的"卖五/买一"对不炒股的人等于天书。
    const md = s => String(s || '').slice(5);   // 'YYYY-MM-DD' → 'MM-DD'
    const fut = list.slice(1, 6);
    const asks = fut.slice().sort((a, b) => a.high - b.high);
    const bids = fut.slice().sort((a, b) => a.low - b.low);
    for (let i = asks.length; i >= 1; i--) {
      const f = asks[i - 1];
      box.appendChild(makeObRow(md(f.date) + ' 最高', f.high, f, cur, 'ask'));
    }
    box.appendChild(el('div', { class: 'ob-mid' }, [
      el('span', { text: '现在 ' + (cur == null ? '--' : fx(cur, 1)) + '℃' }),
      el('b', { style: { color: U.trendColor(q.chg) }, text: q.pct == null ? '--' : '比昨天 ' + sgn(q.pct, 2) + '%' }),
      el('span', { text: '5 天落差 ' + spread(list) })
    ]));
    for (let i = 1; i <= bids.length; i++) {
      const f = bids[i - 1];
      box.appendChild(makeObRow(md(f.date) + ' 最低', f.low, f, cur, 'bid'));
    }
  }

  function spread(list) {
    const fut = list.slice(1, 6);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < fut.length; i++) { if (fut[i].high > mx) mx = fut[i].high; if (fut[i].low < mn) mn = fut[i].low; }
    return (mx === -Infinity || mn === Infinity) ? '--' : fx(mx - mn, 1) + '℃';
  }

  function makeObRow(label, val, f, cur, side) {
    const om = (S.data.omDaily && S.data.omDaily[f.date]) || {};
    const amount = f.precip != null ? f.precip : (om.precip == null ? 0 : om.precip);
    const maxA = 20;
    const w = U.clamp(amount / maxA * 100, 3, 100);
    const col = side === 'ask' ? U.upColor() : U.downColor();
    const tip = f.date + ' ' + (f.dayText || '') + (f.nightText ? '/' + f.nightText : '') + (f.dayWind ? ' 风 ' + f.dayWind : '');
    return el('div', { class: 'ob-row', title: tip }, [
      el('span', { class: 'ob-label', text: label }),
      el('span', { class: 'ob-price', style: { color: col }, text: fx(val, 1) }),
      el('span', { class: 'ob-val', text: fx(amount, 1) + 'mm' }),
      (() => { const b = el('div', { class: 'ob-bar' }); b.appendChild(el('i', { style: { width: w + '%', background: col } })); return b; })()
    ]);
  }

  /* ═══════════ 逐时成交（最近观测） ═══════════ */
  function renderTape() {
    const box = $('#tape'); box.innerHTML = '';
    const d = S.data; if (!d) return;
    const { time, temp, precip, wcode } = d.hourly;
    const out = [];
    for (let i = time.length - 1; i >= 1 && out.length < 60; i--) {
      if (String(time[i]).slice(0, 10) > d.today) continue;
      if (temp[i] == null) continue;
      out.push(i);
    }
    out.forEach(i => {
      const prev = temp[i - 1];
      const chg = prev == null ? 0 : temp[i] - prev;
      const t = String(time[i]);
      const amt = precip[i] || 0;
      box.appendChild(el('div', { class: 'tape-row', title: (wcode[i] != null ? API.wmoText(wcode[i]) : '') }, [
        el('span', { class: 't-time', text: t.slice(5, 10) + ' ' + t.slice(11, 16) }),
        el('span', { class: 't-temp', style: { color: U.trendColor(chg) }, text: fx(temp[i], 1) }),
        el('span', { class: 't-amt', text: amt > 0 ? fx(amt, 1) : '—' })
      ]));
    });
    if (!out.length) box.appendChild(el('div', { class: 'sr-empty', text: '暂无观测' }));
  }

  /* ═══════════ 图表 ═══════════ */
  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
  function barKeyOf(mode, dateStr) {
    if (mode === 'month') return dateStr.slice(0, 7);
    if (mode === 'week') {
      const dt = U.parseDate(dateStr);
      const wd = (dt.getDay() + 6) % 7;
      return U.fmtDate(new Date(dt.getTime() - wd * 86400000));
    }
    return dateStr;
  }

  function seriesFor(period) {
    const d = S.data; if (!d) return null;
    const today = d.today;
    let bars, mode = 'day';
    if (period === 'week') { bars = d.week; mode = 'week'; }
    else if (period === 'month') { bars = d.month; mode = 'month'; }
    else if (period === 'fcst') { bars = d.daily.filter(b => b.d >= U.fmtDate(new Date(Date.now() - 45 * 86400000))); mode = 'day'; }
    else bars = d.daily;
    if (!bars || !bars.length) return null;
    const ind = IND.computeAll(bars);
    const tk = barKeyOf(mode, today);
    let ti = -1;
    for (let i = 0; i < bars.length; i++) if (bars[i].d <= tk) ti = i;
    const base = ti > 0 ? bars[ti - 1].c : null;
    const view = period === 'day' || period === 'fcst' ? 90 : period === 'week' ? 80 : 60;
    return {
      bars, ind, mode, base, today: tk, view,
      monthMode: mode === 'month',
      title: ({ trend: '分时', '5day': '五日分时', day: '日K', week: '周K', month: '月K', fcst: '预报K' })[period] + ' · ' + bars.length + ' 根'
    };
  }

  /* ═══════════ 天气副图（降水 / 风 / 云量 / 空气） ═══════════ */
  /** S.ind 是不是天气副图口径 */
  function isWxInd() {
    return !!(window.WXUI && window.Weather && Weather.isWeatherSub(S.ind) && S.ind !== 'range');
  }
  /** 画天气副图；不是天气口径就返回 false，交回 chart.js 画温差柱 */
  function renderWxSub() {
    if (!isWxInd()) return false;
    const wx = S.wx;
    return WXUI.drawSub(S.ind, wx, wx && wx.air);
  }
  /** 拉当前城市的逐小时预报 + 空气质量，成功后重绘副图 */
  async function loadWx(cityId) {
    if (!window.Weather) return;
    const c = API.Cities.get(cityId); if (!c) return;
    S.wx = null;
    if (isWxInd()) renderChart();
    const hint = $('#wxHint');
    try {
      const wx = await Weather.ensure(c);
      if (!S.cur || S.cur.id !== cityId) return;   // 这期间用户已经切到别的城市
      S.wx = wx;
      if (isWxInd()) renderChart();
      if (hint) hint.textContent = (wx && wx.err) ? ('逐小时数据暂不可用：' + wx.err) : '';
    } catch (e) {
      if (isWxInd()) renderChart();
      if (hint) hint.textContent = '逐小时数据暂不可用';
    }
  }

  function renderChart() {
    const d = S.data; if (!d) return;
    const p = S.period;
    if (p === 'trend' || p === '5day') {
      const pts = p === 'trend' ? d.intraday : d.five;
      const qp = quoteOf(S.cur.id);
      Chart.renderMain({
        mode: p, points: pts, base: d.base,
        precips: pts.map(x => x.v),
        hours: pts.map(x => U.sessionLabel(Number(String(x.t).slice(11, 13)))),
        title: (p === 'trend' ? '分时' : '五日分时') + ' · ' + (p === 'trend' ? d.today : '近 5 日')
      });
      if (!renderWxSub()) {
        Chart.renderSub({ indName: 'vol', bars: d.daily, ind: d.indicators, metric: S.metric, view: 90 });
      }
      $('#chartHint').textContent = '昨收 ' + (d.base == null ? '--' : fx(d.base, 1)) + ' ℃　最新 ' + (qp.temp == null ? '--' : fx(qp.temp, 1)) + ' ℃　逐时点 ' + pts.length;
    } else {
      const s = seriesFor(p);
      if (!s) { Chart.renderEmpty('暂无K线数据'); return; }
      Chart.renderMain({
        mode: 'kline', bars: s.bars, ind: s.ind, base: s.base, today: s.today,
        metric: S.metric, view: s.view, monthMode: s.monthMode, title: s.title,
        showBoll: S.ind === 'boll'
      });
      if (!renderWxSub()) {
        Chart.renderSub({ indName: S.ind, bars: s.bars, ind: s.ind, metric: S.metric, view: s.view });
      }
      const i = s.bars.length - 1;
      const g = k => (s.ind[k] && s.ind[k][i] != null) ? fx(s.ind[k][i], 1) : '--';
      $('#chartHint').textContent = S.ind === 'boll'
        ? 'BOLL ' + g('lower') + ' / ' + g('mid') + ' / ' + g('upper')
        : 'MA5 ' + g('ma5') + '　MA10 ' + g('ma10') + '　MA20 ' + g('ma20') + '　MA60 ' + g('ma60');
    }
  }

  /* ═══════════ 状态栏 ═══════════ */
  function renderStatus(msg) {
    if (msg) $('#statusLeft').textContent = msg;
    const srcs = [];
    if (S.data && S.data.now) srcs.push('中国气象局 weather.cma.cn');
    if (S.data) srcs.push('Open-Meteo 逐小时');
    if (S.data && S.data.official) srcs.push('中国天气网 d1');
    if (API.LOCAL) srcs.push('本地代理');
    $('#statusSrc').textContent = srcs.join(' + ') || '—';
  }

  /* ═══════════ 选中城市 ═══════════ */
  async function selectCity(id) {
    const c = API.Cities.get(id);
    if (!c) { toast('未找到城市 ' + id); return; }
    if (S.loading) return;
    S.loading = true;
    S.cur = c;
    S.data = null;
    S.wx = null;
    storeSet('last', id);
    renderWatchlist(); renderHotlist(); renderIndexes();
    $('#qName').textContent = c.name;
    Chart.showLoading('正在拉取 ' + c.name + ' 行情…');
    $('#statusLeft').textContent = '加载 ' + c.name + ' …';
    try {
      const d = await API.Store.loadCity(c, (m) => { $('#statusLeft').textContent = m; Chart.showLoading(m); });
      S.data = d;
      S.lastFullAt = Date.now();
      if (!S.briefs[id] || !S.briefs[id].prevClose) {
        try { S.briefs[id] = await API.OpenMeteo.brief(c.lat, c.lon, 600000); } catch (e) { }
      }
      Chart.hideLoading();
      renderQuoteHead(); renderOrderbook(); renderTape(); renderChart();
      renderStatus();
      renderWatchlist(); renderIndexes();
      loadWx(c.id);   // 逐小时/空气是副图才要，异步补上，不挡主流程
      $('#statusLeft').textContent = '已加载 ' + c.name + '（' + d.daily.length + ' 根日K / ' + d.hourly.time.length + ' 个时次）';
      toast('已切换到 ' + c.name + ' ' + c.id);
    } catch (e) {
      Chart.hideLoading();
      Chart.renderEmpty('加载失败：' + e.message);
      $('#statusLeft').textContent = '加载失败：' + e.message;
    } finally {
      S.loading = false;
    }
  }

  /* ═══════════ 行情轮询 ═══════════ */
  /** 带并发上限的小工具：把一批任务分片跑完 */
  async function runLimited(items, limit, fn) {
    const arr = items.slice();
    const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
      while (arr.length) { const it = arr.shift(); try { await fn(it); } catch (e) { } }
    });
    await Promise.all(workers);
  }

  function watchHotIds() {
    return Array.from(new Set(S.watch.concat(API.Cities.hot.slice(0, 16).map(c => c.id))));
  }

  async function warmQuotes() {
    const ids = watchHotIds();
    const ttl = Math.max(S.refreshMs, 30000);
    const cities = ids.map(i => API.Cities.get(i)).filter(Boolean);
    const qs = await API.Store.quotes(cities, 6);
    Object.assign(S.quotes, qs);

    // 昨收/迷你走势（Open-Meteo brief）：自选 + 热门，10 分钟一轮，避免频繁请求
    if (Date.now() - (S.briefAt || 0) > 600000) {
      S.briefAt = Date.now();
      const need = ids.filter(i => API.Cities.get(i));
      await runLimited(need, 4, async i => {
        const c = API.Cities.get(i);
        try { const b = await API.OpenMeteo.brief(c.lat, c.lon, 600000); if (b) S.briefs[i] = b; } catch (e) { }
      });
    }
    renderWatchlist(); renderHotlist(); renderIndexes();
    if (S.cur) { renderQuoteHead(); renderOrderbook(); renderTape(); }
  }

  async function warmIndexes() {
    const defs = IDX_DEFS.filter(d => !d.computed);
    await Promise.all(defs.map(async def => {
      const c = API.Cities.get(def.id) || API.Cities.all.find(x => x.name === def.nm);
      if (!c) return;
      if (!S.idxB[def.key]) { try { const b = await API.OpenMeteo.brief(c.lat, c.lon, 600000); if (b) S.idxB[def.key] = b; } catch (e) { } }
      try { const q = await API.Cma.now(c, Math.max(S.refreshMs, 60000)); if (q) S.idxQ[def.key] = q; } catch (e) { }
    }));
    renderIndexes();
  }

  function scheduleRefresh() {
    clearInterval(S.timer);
    if (!S.refreshMs) { $('#statusNext').textContent = '手动刷新'; return; }
    S.timer = setInterval(async () => {
      S.tick++;
      try {
        await warmQuotes();
        // 每 30 tick 或自选城市实况过期时更新指数
        if (S.tick % 20 === 1) warmIndexes();
        // 全量重载：30 分钟一次
        if (S.cur && Date.now() - S.lastFullAt > 1800000 && !S.loading) {
          const id = S.cur.id; S.loading = false; selectCity(id);
        }
        $('#statusNext').textContent = '下次刷新 ' + (S.refreshMs / 1000) + 's';
      } catch (e) { /* 静默 */ }
    }, S.refreshMs);
    $('#statusNext').textContent = '下次刷新 ' + (S.refreshMs / 1000) + 's';
  }

  /* ═══════════ 搜索 ═══════════ */
  let srList = [], srSel = -1;
  const doSearch = debounce(function () {
    const q = $('#search').value.trim();
    const box = $('#searchResults');
    if (!q) { box.hidden = true; box.innerHTML = ''; srList = []; return; }
    srList = API.Cities.search(q, 40);
    srSel = srList.length ? 0 : -1;
    box.innerHTML = '';
    if (!srList.length) { box.appendChild(el('div', { class: 'sr-empty', text: '未找到匹配城市' })); box.hidden = false; return; }
    srList.forEach((c, i) => {
      const starred = S.watch.indexOf(c.id) >= 0;
      const row = el('div', {
        class: 'sr-item' + (i === srSel ? ' sel' : ''),
        onclick: (e) => {
          if (e.target.classList.contains('sr-star')) return;
          $('#search').value = ''; box.hidden = true; selectCity(c.id);
        }
      }, [
        el('span', { class: 'sr-name', text: c.name }),
        el('span', { class: 'sr-prov', text: (c.prov || '') + (c.cma ? ' · ' + c.cma : '') }),
        el('span', { class: 'sr-code', text: c.id })
      ]);
      row.appendChild(el('span', {
        class: 'sr-star' + (starred ? ' on' : ''),
        text: starred ? '★' : '☆',
        title: starred ? '从自选移除' : '加入自选（也可按 Ctrl+Enter）',
        onclick: (e) => {
          e.stopPropagation();
          if (S.watch.indexOf(c.id) >= 0) removeWatch(c.id); else addWatch(c.id);
          doSearch(); renderHotlist(); buildDrawer();
        }
      }));
      box.appendChild(row);
    });
    box.hidden = false;
  }, 130);

  function searchKey(e) {
    const box = $('#searchResults');
    if (e.key === 'Escape') { box.hidden = true; $('#search').blur(); return; }
    if (!srList.length || box.hidden) {
      if (e.key === 'Enter') { const c = API.Cities.search($('#search').value.trim(), 1)[0]; if (c) { $('#search').value = ''; box.hidden = true; selectCity(c.id); } }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      srSel = (srSel + (e.key === 'ArrowDown' ? 1 : -1) + srList.length) % srList.length;
      Array.from(box.children).forEach((n, i) => n.classList.toggle('sel', i === srSel));
      const n = box.children[srSel]; if (n) n.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = srList[srSel];
      if (c) {
        if (e.ctrlKey || e.metaKey) addWatch(c.id);
        else selectCity(c.id);
        $('#search').value = ''; box.hidden = true;
      }
    }
  }

  /* ═══════════ 全城市抽屉 ═══════════ */
  function buildDrawer() {
    const body = $('#drawerBody');
    const groups = {};
    API.Cities.all.forEach(c => { (groups[c.prov || '其他'] = groups[c.prov || '其他'] || []).push(c); });
    body.innerHTML = '';
    Object.keys(groups).forEach(p => {
      body.appendChild(el('div', { class: 'dw-prov', text: p + '（' + groups[p].length + '）' }));
      const g = el('div', { class: 'dw-grid' });
      groups[p].forEach(c => {
        const star = S.watch.indexOf(c.id) >= 0;
        g.appendChild(el('div', {
          class: 'dw-city' + (star ? ' on' : ''),
          dataset: { id: c.id },
          title: c.id + (c.cma ? ' · ' + c.cma : ''),
          onclick: (e) => {
            // ★/☆ 只负责自选增删；点别处才是切换城市。
            // 注意：星号必须【永远】渲染出来 —— 以前只在已自选时才画，
            // 于是没自选的城市根本没有星可点，也就永远加不进自选。
            if (e.target.classList.contains('star')) {
              e.stopPropagation();
              if (S.watch.indexOf(c.id) >= 0) removeWatch(c.id); else addWatch(c.id);
              buildDrawer(); renderHotlist();
              return;
            }
            selectCity(c.id); $('#cityDrawer').hidden = true;
          }
        }, [
          el('span', { text: c.name }),
          el('span', {
            class: 'star' + (star ? ' on' : ''),
            text: star ? '★' : '☆',
            title: star ? '从自选移除' : '加入自选'
          }),
          el('i', { text: c.id.slice(-3) })
        ]));
      });
      body.appendChild(g);
    });
  }

  /* ═══════════ 交互绑定 ═══════════ */
  function bind() {
    $('#periodTabs').addEventListener('click', e => {
      const t = e.target.closest('.tab[data-period]'); if (!t) return;
      U.$$('#periodTabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      S.period = t.dataset.period;
      renderChart();
    });
    U.$$('.tabbar.sub .tab').forEach(t => t.addEventListener('click', () => {
      U.$$('.tabbar.sub .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      S.ind = t.dataset.ind;
      // 天气口径（降水/风/云量/空气）和主图的K线周期没关系，不要因此把用户踢出分时
      if (!isWxInd() && (S.period === 'trend' || S.period === '5day')) S.period = 'day';
      U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
      renderChart();
      if (isWxInd() && !S.wx && S.cur) loadWx(S.cur.id);
    }));
    $('#refreshRate').addEventListener('change', e => {
      S.refreshMs = Number(e.target.value); storeSet('refresh', S.refreshMs);
      scheduleRefresh(); toast('行情刷新频率：' + (S.refreshMs ? (S.refreshMs / 1000) + ' 秒' : '手动'));
    });
    $('#colorMode').addEventListener('change', e => {
      document.body.classList.toggle('us', e.target.value === 'us');
      storeSet('color', e.target.value);
      Chart.setTheme(); renderWatchlist(); renderHotlist(); renderQuoteHead(); renderIndexes(); renderChart(); renderOrderbook();
    });
    $('#volumeMetric').addEventListener('change', e => {
      S.metric = e.target.value; storeSet('metric', S.metric); renderChart();
      toast('量能指标：' + Chart.METRICS[S.metric].label);
    });
    $('#btnManual').addEventListener('click', async () => { await warmQuotes(); await warmIndexes(); if (S.cur) { S.lastFullAt = 0; } toast('已刷新'); });
    $('#btnSortWatch').addEventListener('click', () => {
      S.sortMode = (S.sortMode + 1) % 3; renderWatchlist();
      toast(['默认排序', '按涨幅排序', '按名称排序'][S.sortMode]);
    });
    $('#btnZoomReset').addEventListener('click', () => { renderChart(); toast('视图已重置'); });
    $('#search').addEventListener('input', doSearch);
    $('#search').addEventListener('keydown', searchKey);
    $('#search').addEventListener('focus', () => { if ($('#search').value.trim()) doSearch(); });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrap')) $('#searchResults').hidden = true;
    });
    $('#btnAllCities').addEventListener('click', () => { buildDrawer(); $('#cityDrawer').hidden = false; });
    $('#drawerClose').addEventListener('click', () => { $('#cityDrawer').hidden = true; });
    $('#cityDrawer').addEventListener('click', e => { if (e.target.id === 'cityDrawer') $('#cityDrawer').hidden = true; });
    // 术语对照表：炒股词全都用天气话讲了一遍，不炒股也看得懂
    $('#btnHelp').addEventListener('click', () => { $('#helpDrawer').hidden = false; });
    $('#helpClose').addEventListener('click', () => { $('#helpDrawer').hidden = true; });
    $('#helpDrawer').addEventListener('click', e => { if (e.target.id === 'helpDrawer') $('#helpDrawer').hidden = true; });
    $('#drawerFilter').addEventListener('input', debounce(e => {
      const q = e.target.value.trim().toLowerCase();
      U.$$('#drawerBody .dw-city').forEach(n => {
        const c = API.Cities.get(n.dataset.id || '');
        n.style.display = (!q || n.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
    }, 120));
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const map = { 1: 'trend', 2: '5day', 3: 'day', 4: 'week', 5: 'month', 6: 'fcst' };
      if (map[e.key]) {
        S.period = map[e.key];
        U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
        renderChart();
      }
      if (e.key === 'r' || e.key === 'R') $('#btnManual').click();
    });
  }

  function tickClock() {
    const d = new Date();
    $('#clock').textContent = U.fmtTime(d);
    $('#clockDate').textContent = U.fmtDate(d) + ' ' + U.weekday(d);
  }

  /* ═══════════ 启动 ═══════════ */
  /**
   * 手机竖屏的页签：宽屏下三栏并排，竖屏一次只放得下一栏，所以拆成
   * 自选(0) / 行情(1) / 盘口(2) / 明细(3) 四页，由 body[data-mtab] 决定显示哪栏。
   * 切到行情页时要 resize 图表 —— 隐藏期间 ECharts 量到的是 0 宽。
   */
  function setMTab(i) {
    document.body.dataset.mtab = String(i);
    U.$$('#mtabs .mtab').forEach(b => b.classList.toggle('active', b.dataset.mtab === String(i)));
    if (String(i) === '1') setTimeout(() => { try { Chart.resize(); } catch (e) {} }, 60);
  }
  function isNarrow() { return window.matchMedia('(max-width:860px)').matches; }
  function syncMTabs() {
    const nav = U.$('#mtabs');
    if (!nav) return;
    const narrow = isNarrow();
    nav.hidden = !narrow;
    if (narrow) {
      if (!document.body.dataset.mtab) setMTab(1);   // 手机上默认直接看行情
    } else {
      delete document.body.dataset.mtab;             // 宽屏恢复三栏并排
      setTimeout(() => { try { Chart.resize(); } catch (e) {} }, 60);
    }
  }

  async function boot() {
    tickClock(); setInterval(tickClock, 1000);
    try {
      await API.Cities.load();
    } catch (e) {
      Chart.renderEmpty('城市数据集加载失败：' + e.message + '（请通过 http 服务访问，不要直接双击打开）');
      $('#statusLeft').textContent = '城市数据集加载失败：' + e.message;
      return;
    }
    $('#statusLeft').textContent = '已载入 ' + API.Cities.all.length + ' 个城市／地区';

    S.watch = storeGet('watch', null) || DEFAULT_WATCH.slice();
    S.watch = S.watch.filter(i => API.Cities.get(i));
    if (!S.watch.length) S.watch = DEFAULT_WATCH.slice();
    S.refreshMs = storeGet('refresh', 3000);
    S.metric = storeGet('metric', 'range');
    const cm = storeGet('color', 'cn');
    document.body.classList.toggle('us', cm === 'us');
    $('#refreshRate').value = String(S.refreshMs);
    $('#volumeMetric').value = S.metric;
    $('#colorMode').value = cm;

    Chart.init($('#mainChart'), $('#subChart'));
    bind();
    if (window.WXUI) WXUI.init();
    renderWatchlist(); renderHotlist(); renderIndexes();
    scheduleRefresh();

    const lastId = storeGet('last', null);
    const q = urlParams();
    syncTabs();
    // ?help=1 直接展开术语对照表（可分享的链接，也方便截图自查）
    if (q.help) $('#helpDrawer').hidden = false;
    // ?wx=wxRadar|wxSat|wxTy|wxWarn 直接打开某个天气功能页（同样方便截图自查）
    if (q.wx && window.WXUI) setTimeout(() => WXUI.open(q.wx), 500);
    // ?mtab=0..3 可深链到手机页签；宽屏下忽略
    syncMTabs();
    if (q.mtab != null && isNarrow()) setMTab(q.mtab);
    let rt;
    const onViewport = () => { clearTimeout(rt); rt = setTimeout(syncMTabs, 120); };
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    const first = (q.city && API.Cities.get(q.city)) ? q.city
      : (lastId && API.Cities.get(lastId)) ? lastId : S.watch[0];
    selectCity(first);

    warmIndexes();
    warmQuotes();
    checkDownloads();
    const h = await API.Cn.health();
    if (h && h.local) $('#statusSrc').textContent = '中国天气网本地代理 ' + (h.version || '');
  }

  /**
   * 状态栏的「下载客户端」只在真的能下到时才出现 —— 本地 http.server / 打包版都没有
   * dist/ 目录，HEAD 探测失败就把链接摘掉，避免摆一个点了 404 的按钮。
   */
  function checkDownloads() {
    const box = U.$('#dlBox');
    if (!box) return;
    const links = U.$$('#dlBox .dl');
    if (!links.length) return;
    Promise.all(links.map(a => fetch(a.getAttribute('href'), { method: 'HEAD' })
      .then(r => { if (r.ok) return null; throw new Error('' + r.status); })
      .catch(() => a)))
      .then(dead => {
        dead.filter(Boolean).forEach(a => a.remove());
        if (U.$$('#dlBox .dl').length) box.hidden = false;
      })
      .catch(() => {});
  }

  /** 支持 ?city=101010100&p=day&ind=wind&color=us&m=precip&wx=wxRadar&help=1 深链与分享（也方便无头截图） */
  const PERIODS = ['trend', '5day', 'day', 'week', 'month', 'fcst'];
  const INDS = ['vol', 'precip', 'wind', 'cloud', 'air'];

  function urlParams() {
    const o = {};
    const qs = String(location.search || '').replace(/^\?/, '');
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      o[k] = v;
    });
    if (o.p && PERIODS.indexOf(o.p) >= 0) S.period = o.p;
    if (o.ind && INDS.indexOf(o.ind) >= 0) S.ind = o.ind;
    if (o.m && Chart.METRICS[o.m]) S.metric = o.m;
    if (o.color === 'us' || o.color === 'cn') {
      document.body.classList.toggle('us', o.color === 'us');
      const sel = $('#colorMode'); if (sel) sel.value = o.color;
    }
    return o;
  }

  /** 让 tab 高亮与 S.period / S.ind 保持一致（深链与快捷键都要用） */
  function syncTabs() {
    U.$$('#periodTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.period === S.period));
    U.$$('.tabbar.sub .tab').forEach(x => x.classList.toggle('active', x.dataset.ind === S.ind));
    const vm = $('#volumeMetric'); if (vm) vm.value = S.metric;
  }

  document.addEventListener('DOMContentLoaded', boot);
  window.__APP = { S, selectCity, addWatch, removeWatch, renderChart };
})();
