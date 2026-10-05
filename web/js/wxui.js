/* ═══════════════════════════════════════════════════════════════
   wxui.js — 天气功能的渲染层

   两块东西：
     1) 中间那排副图（原来 MACD/KDJ/RSI/BOLL/WR 的位置）改成 降水 / 风 / 云量 / 空气
     2) 四个全屏功能页：雷达回波、卫星云图、台风路径、预警信号

   副图复用 chart.js 建好的那个 ECharts 实例（getInstanceByDom），
   所以不用碰 chart.js。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const W = global.Weather;
  const $ = s => document.querySelector(s);

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const fx1 = v => (v == null || isNaN(v)) ? '--' : (+v).toFixed(1);
  const hhmm = t => (t || '').slice(11, 16);
  const mdhm = t => (t || '').slice(5, 16).replace('T', ' ');

  /* ───────── 主题 ───────── */
  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      line: g('--line', '#232833'), txt: g('--txt', '#c9d1dd'),
      dim: g('--dim', '#7c8698'), accent: g('--accent', '#f0b90b'),
      up: '#ff5c5c', down: '#3fd68a',
      blue: '#4aa8ff', cyan: '#4ad9e4', violet: '#a97bff', grey: '#8fa4bd'
    };
  }

  function subEc() {
    const el = $('#subChart');
    if (!el || !global.echarts) return null;
    return echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' });
  }

  /* 副图统一的坐标轴外壳 */
  function base(TH, xs, yName) {
    return {
      animation: false,
      grid: { left: 46, right: 52, top: 16, bottom: 26, containLabel: false },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: '#39404e' } },
        backgroundColor: '#161a22', borderColor: '#2b323d',
        textStyle: { color: '#e9edf4', fontSize: 11 }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: TH.line } },
        axisLabel: { color: TH.dim, fontSize: 10, interval: 5 },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: yName || '', nameTextStyle: { color: TH.dim, fontSize: 10 },
        axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10 },
        splitLine: { lineStyle: { color: TH.line, type: 'dashed' } }
      }
    };
  }

  /* ═══════════════ 1. 副图 ═══════════════ */

  /** 降水：柱子＝降水量(mm)，黄线＝降水概率(%) */
  function optPrecip(w, TH) {
    const o = base(TH, w.label, 'mm');
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      return w.label[i] + '<br/>降水 ' + fx1(w.precip[i]) + ' mm' +
        '<br/>概率 ' + Math.round(w.prob[i] || 0) + '%' +
        '<br/>气温 ' + fx1(w.temp[i]) + '℃';
    };
    o.yAxis = [o.yAxis, {
      type: 'value', max: 100, min: 0, name: '%', nameTextStyle: { color: TH.dim, fontSize: 10 },
      axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10, formatter: '{value}' },
      splitLine: { show: false }
    }];
    const mx = Math.max(0.6, ...w.precip.map(v => v || 0));
    o.series = [
      {
        name: '降水量', type: 'bar', yAxisIndex: 0, barWidth: '62%',
        data: (w.precip || []).map(v => ({
          value: v == null ? 0 : v,
          itemStyle: { color: (v || 0) > 0 ? TH.blue : 'rgba(74,168,255,.22)' }
        }))
      },
      {
        name: '降水概率', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false,
        lineStyle: { width: 1.4, color: TH.accent }, itemStyle: { color: TH.accent },
        data: (w.prob || []).map(v => (v == null ? 0 : v))
      }
    ];
    o.yAxis[0].max = Math.ceil(mx * 10) / 10;
    return o;
  }

  /** 风：柱子＝风速，虚线＝阵风，箭头＝风向 */
  function optWind(w, TH) {
    const o = base(TH, w.label, 'm/s');
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      return w.label[i] + '<br/>风速 ' + fx1(w.wind[i]) + ' m/s（' + W.dirName(w.windDir[i]) + '）' +
        '<br/>阵风 ' + fx1(w.gust[i]) + ' m/s';
    };
    const mx = Math.max(2, ...(w.gust || []).map(v => v || 0), ...(w.wind || []).map(v => v || 0));
    // 风向箭头：气象上的"风向"指风吹来的方向，箭头要指风吹去的方向，所以 +180
    const arrows = (w.wind || []).map((v, i) => {
      const d = w.windDir[i];
      if (d == null || v == null) return null;
      return { value: [i, mx * 0.94], symbolRotate: ((d + 180) % 360) };
    });
    o.yAxis.max = Math.ceil(mx * 1.08);
    o.series = [
      {
        name: '风速', type: 'bar', barWidth: '58%',
        data: (w.wind || []).map(v => ({
          value: v == null ? 0 : v,
          itemStyle: { color: v >= 10.8 ? TH.up : (v >= 5.5 ? TH.accent : TH.cyan) }
        }))
      },
      {
        name: '阵风', type: 'line', smooth: true, showSymbol: false,
        lineStyle: { width: 1.2, type: 'dashed', color: TH.violet }, itemStyle: { color: TH.violet },
        data: (w.gust || []).map(v => (v == null ? 0 : v))
      },
      {
        name: '风向', type: 'scatter', symbol: 'arrow', symbolSize: 9,
        itemStyle: { color: '#e9edf4' }, silent: true,
        symbolRotate: (val, p) => (p.data && p.data.symbolRotate) || 0,
        data: arrows
      }
    ];
    return o;
  }

  /** 云量：低/中/高云堆叠，白线＝总云量 */
  function optCloud(w, TH) {
    const o = base(TH, w.label, '%');
    o.yAxis.max = 100;
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      return w.label[i] + '<br/>总云量 ' + Math.round(w.cloud[i] || 0) + '%' +
        '<br/>低云 ' + Math.round((w.cloudLow || [])[i] || 0) + '%' +
        '<br/>中云 ' + Math.round((w.cloudMid || [])[i] || 0) + '%' +
        '<br/>高云 ' + Math.round((w.cloudHigh || [])[i] || 0) + '%';
    };
    const area = (name, arr, color, op) => ({
      name: name, type: 'line', stack: 'cl', smooth: true, showSymbol: false,
      lineStyle: { width: 0 }, areaStyle: { color: color, opacity: op },
      itemStyle: { color: color }, data: (arr || []).map(v => (v == null ? 0 : v))
    });
    o.series = [
      area('低云', w.cloudLow, TH.grey, 0.55),
      area('中云', w.cloudMid, TH.blue, 0.45),
      area('高云', w.cloudHigh, TH.violet, 0.35),
      {
        name: '总云量', type: 'line', smooth: true, showSymbol: false,
        lineStyle: { width: 1.6, color: '#eef3fa' }, itemStyle: { color: '#eef3fa' },
        data: (w.cloud || []).map(v => (v == null ? 0 : v))
      }
    ];
    return o;
  }

  /** 空气：柱子＝PM2.5，线＝AQI */
  function optAir(air, TH) {
    if (!air || !air.time || !air.time.length) {
      return { title: { text: '空气质量数据暂不可用', left: 'center', top: 'middle', textStyle: { color: TH.dim, fontSize: 12 } } };
    }
    const now = Date.now() - 3600000;
    let i0 = 0;
    for (let i = 0; i < air.time.length; i++) {
      if (new Date(air.time[i].replace(' ', 'T') + ':00+08:00').getTime() >= now) { i0 = i; break; }
    }
    const e = i0 + 48;
    const xs = air.time.slice(i0, e).map(mdhm);
    const pm = air.pm25.slice(i0, e), aq = air.aqi.slice(i0, e);
    const o = base(TH, xs, 'AQI');
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      const lv = W.aqiLevel(aq[i]);
      return xs[i] + '<br/>AQI ' + (aq[i] == null ? '--' : Math.round(aq[i])) + '（' + lv.n + '）' +
        '<br/>PM2.5 ' + fx1(pm[i]) + ' μg/m³';
    };
    o.yAxis = [o.yAxis, {
      type: 'value', name: 'μg/m³', nameTextStyle: { color: TH.dim, fontSize: 10 },
      axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10 }, splitLine: { show: false }
    }];
    o.series = [
      {
        name: 'PM2.5', type: 'bar', yAxisIndex: 1, barWidth: '55%',
        data: (pm || []).map(v => ({ value: v == null ? 0 : v, itemStyle: { color: 'rgba(169,123,255,.55)' } }))
      },
      {
        name: 'AQI', type: 'line', yAxisIndex: 0, smooth: true, showSymbol: false,
        lineStyle: { width: 1.6, color: TH.accent }, itemStyle: { color: TH.accent },
        data: (aq || []).map(v => (v == null ? null : v)),
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: TH.dim, type: 'dashed', width: 1 },
          label: { color: TH.dim, fontSize: 9, formatter: '良 100' },
          data: [{ yAxis: 100 }]
        }
      }
    ];
    return o;
  }

  /* ═══════════════ 2. 全屏功能页 ═══════════════ */

  const WXUI = {
    /** 副图总入口：name ∈ precip|wind|cloud|air，其它名字返回 false 交回 chart.js */
    drawSub(name, wx, air) {
      if (!W.isWeatherSub(name) || name === 'range') return false;
      const ec = subEc();
      if (!ec) return false;
      const TH = theme();
      const w = wx && wx.hourly ? W.window(wx.hourly, name === 'air' ? 48 : 48) : null;
      let opt;
      if (name === 'precip') opt = w ? optPrecip(w, TH) : msg('暂无逐小时数据', TH);
      else if (name === 'wind') opt = w ? optWind(w, TH) : msg('暂无逐小时数据', TH);
      else if (name === 'cloud') opt = w ? optCloud(w, TH) : msg('暂无逐小时数据', TH);
      else opt = optAir(wx && wx.air, TH);
      ec.setOption(opt, true);
      return true;
    },

    /* ── 雷达 / 卫星播放器 ── */
    _play: null,

    async openRadar(region) {
      region = region || 'ACHN';
      const body = $('#wxRadarBody'), sub = $('#wxRadarSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在探测最近有货的雷达帧…</div>';
      // 华东只有原图档（每帧约 665 KB），少取几帧免得一次下十兆
      const want = region === 'AECN' ? 10 : 16;
      let frames;
      try {
        frames = await W.probeRadar(region, want, (got, total) => {
          if (sub) sub.textContent = '已找到 ' + got + ' 帧';
        });
      } catch (e) { body.innerHTML = '<div class="wx-load">雷达数据获取失败：' + esc(e.message) + '</div>'; return; }
      if (!frames.length) {
        body.innerHTML = '<div class="wx-load">暂时取不到雷达回波（中国气象局该时段没有发布，或本机网络不通）</div>';
        return;
      }
      renderPlayer(body, sub, frames, '雷达回波', {
        regions: [['ACHN', '全国'], ['AECN', '华东']], region: region,
        onRegion: r => WXUI.openRadar(r)
      });
    },

    async openSat() {
      const body = $('#wxSatBody'), sub = $('#wxSatSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在探测最近的卫星云图…</div>';
      let frames;
      try {
        frames = await W.probeSat(12, (got, total) => { if (sub) sub.textContent = '已找到 ' + got + ' 帧'; });
      } catch (e) { body.innerHTML = '<div class="wx-load">云图获取失败：' + esc(e.message) + '</div>'; return; }
      if (!frames.length) { body.innerHTML = '<div class="wx-load">暂时取不到卫星云图</div>'; return; }
      renderPlayer(body, sub, frames, '卫星云图', {});
    },

    /* ── 全国降水量预报图（中央气象台，每 12 小时一张） ── */
    async openPrecip() {
      const body = $('#wxPrecipBody'), sub = $('#wxPrecipSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在探测最新的降水预报图…</div>';
      let frames;
      try {
        frames = await W.probePrecip(6, (got, total) => { if (sub) sub.textContent = '已找到 ' + got + ' 张'; });
      } catch (e) { body.innerHTML = '<div class="wx-load">降水预报获取失败：' + esc(e.message) + '</div>'; return; }
      if (!frames.length) { body.innerHTML = '<div class="wx-load">暂时取不到降水预报图</div>'; return; }
      renderPlayer(body, sub, frames, '全国降水量预报图', {});
    },

    /* ── 台风 ── */
    _ty: null,
    async openTyphoon() {
      const body = $('#wxTyBody'), sub = $('#wxTySub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在拉取台风路径…</div>';
      let list;
      try { list = await W.typhoonList(); }
      catch (e) { body.innerHTML = '<div class="wx-load">台风数据获取失败：' + esc(e.message) + '</div>'; return; }
      if (!list.length) { body.innerHTML = '<div class="wx-load">今年还没有编号台风</div>'; return; }
      const live = list.filter(t => t.live);
      const show = (live.length ? live : list.slice(0, 6));
      const pick = (this._ty && show.some(t => t.id === this._ty)) ? this._ty : show[0].id;
      this._ty = pick;
      renderTyphoon(body, sub, list, show, pick);
    },

    async selectTyphoon(id) {
      this._ty = id;
      const body = $('#wxTyBody'), sub = $('#wxTySub');
      const list = await W.typhoonList().catch(() => []);
      const live = list.filter(t => t.live);
      const show = (live.length ? live : list.slice(0, 6));
      renderTyphoon(body, sub, list, show, id);
    },

    /* ── 预警 ── */
    async openWarn() {
      const body = $('#wxWarnBody'), sub = $('#wxWarnSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在拉取预警信号…</div>';
      let ws;
      try { ws = await W.warnings(); }
      catch (e) { body.innerHTML = '<div class="wx-load">预警数据获取失败：' + esc(e.message) + '</div>'; return; }
      if (sub) sub.textContent = ws.length ? ('全国生效中 ' + ws.length + ' 条') : '';
      if (!ws.length) { body.innerHTML = '<div class="wx-load">当前全国没有生效中的预警信号</div>'; return; }
      body.innerHTML = '<div class="wx-warn">' + ws.map(w => {
        const col = warnColor(w.title);
        return '<div class="wx-warn-item" style="border-left-color:' + col + '">' +
          '<div class="wx-warn-t"><span class="wx-warn-tag" style="background:' + col + '">' +
          esc(shortWarn(w.title)) + '</span>' + esc(w.title) + '</div>' +
          '<div class="wx-warn-time">' + esc(w.time) + '</div>' +
          '<div class="wx-warn-x">' + esc(w.text) + '</div></div>';
      }).join('') + '</div>';
    },

    /* 通用开关 */
    open(id) {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
      if (id === 'wxRadar') this.openRadar(this._radarReg || 'ACHN');
      if (id === 'wxSat') this.openSat();
      if (id === 'wxPrecip') this.openPrecip();
      if (id === 'wxTy') this.openTyphoon();
      if (id === 'wxWarn') this.openWarn();
    },
    close(id) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    /* ── 定位：在本地城市表里找离我最近的城市。
          坐标换算全部在本机完成，不往任何服务器发位置。 ── */
    locate() {
      const hint = $('#wxHint');
      const say = t => { if (hint) hint.textContent = t; };
      if (!navigator.geolocation) { say('这个浏览器不支持定位'); return; }
      say('正在定位…');
      navigator.geolocation.getCurrentPosition(pos => {
        const la = pos.coords.latitude, lo = pos.coords.longitude;
        const cities = (global.API && API.Cities && API.Cities.all) || [];
        if (!cities.length) { say('城市表还没加载好'); return; }
        let best = null, bd = Infinity;
        cities.forEach(c => {
          if (c.lat == null || c.lon == null) return;
          // 经度差按纬度收缩，否则高纬度会算歪
          const dy = c.lat - la, dx = (c.lon - lo) * Math.cos(la * Math.PI / 180);
          const d = dy * dy + dx * dx;
          if (d < bd) { bd = d; best = c; }
        });
        if (!best) { say('城市表里没有带坐标的城市'); return; }
        say('最近：' + best.name + '（直线约 ' + Math.round(Math.sqrt(bd) * 111) + ' 公里）');
        if (global.__APP && __APP.selectCity) __APP.selectCity(best.id);
      }, () => say('定位被拒绝或不可用'), { timeout: 9000, maximumAge: 600000 });
    },

    init() {
      // 顶栏功能按钮
      document.querySelectorAll('[data-wx]').forEach(b => {
        b.addEventListener('click', () => WXUI.open(b.dataset.wx));
      });
      // 点遮罩或 ✕ 关闭；点面板内部不关
      document.querySelectorAll('.wx-drawer').forEach(d => {
        d.addEventListener('click', e => {
          if (e.target.closest('[data-close]') || !e.target.closest('.drawer-panel')) WXUI.close(d.id);
        });
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') document.querySelectorAll('.wx-drawer').forEach(d => { d.hidden = true; });
      });
      const lb = document.getElementById('btnLocate');
      if (lb) lb.addEventListener('click', () => WXUI.locate());
    }
  };

  /* ───────── 渲染辅助 ───────── */
  function msg(text, TH) {
    return { title: { text: text, left: 'center', top: 'middle', textStyle: { color: (TH || theme()).dim, fontSize: 12 } } };
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function shortWarn(t) {
    const m = String(t).match(/(暴雨|暴雪|台风|大风|沙尘暴|雷电|冰雹|大雾|霾|寒潮|高温|干旱|道路结冰|森林火险|海上|霜冻|低温|强对流|雷雨大风|风暴潮|海浪|海啸|重污染|臭氧)/);
    return m ? m[1] : '预警';
  }
  function warnColor(t) {
    const s = String(t);
    if (/红色/.test(s)) return '#e74c3c';
    if (/橙色/.test(s)) return '#e67e22';
    if (/黄色/.test(s)) return '#f0c419';
    if (/蓝色/.test(s)) return '#3498db';
    return '#7f8c9a';
  }

  /* 图片播放器：雷达 / 卫星共用 */
  function renderPlayer(body, sub, frames, title, opt) {
    opt = opt || {};
    let i = 0;
    const seg = (opt.regions || []).map(r =>
      '<button class="wx-segbtn' + (r[0] === opt.region ? ' on' : '') + '" data-reg="' + r[0] + '">' + r[1] + '</button>'
    ).join('');
    body.innerHTML =
      '<div class="wx-player">' +
        '<div class="wx-pbar">' +
          (seg ? '<div class="wx-seg">' + seg + '</div>' : '') +
          '<span class="wx-pt"></span>' +
          '<button class="wx-btn" data-act="play">▶ 播放</button>' +
        '</div>' +
        '<div class="wx-stage"><img alt="' + esc(title) + '" /></div>' +
        '<input type="range" class="wx-range" min="0" max="' + (frames.length - 1) + '" value="0" />' +
        '<div class="wx-pfoot"><span class="wx-pidx"></span><span class="wx-pnote">数据来源：中国气象局 · image.nmc.cn</span></div>' +
      '</div>';

    const img = body.querySelector('.wx-stage img');
    const rng = body.querySelector('.wx-range');
    const pt = body.querySelector('.wx-pt');
    const idx = body.querySelector('.wx-pidx');

    // 全部预载，播放才不卡
    frames.forEach(f => { const im = new Image(); im.src = f.url; });

    function show(n) {
      i = Math.max(0, Math.min(frames.length - 1, n));
      const f = frames[i];
      img.src = f.url;
      rng.value = i;
      pt.textContent = f.t.getFullYear() + '-' + pad2(f.t.getMonth() + 1) + '-' + pad2(f.t.getDate()) +
        ' ' + pad2(f.t.getHours()) + ':' + pad2(f.t.getMinutes());
      idx.textContent = (i + 1) + ' / ' + frames.length;
      if (sub) sub.textContent = pt.textContent;
    }
    show(frames.length - 1);

    rng.addEventListener('input', e => show(+e.target.value));

    let timer = null;
    const btn = body.querySelector('[data-act="play"]');
    btn.addEventListener('click', () => {
      if (timer) { clearInterval(timer); timer = null; btn.textContent = '▶ 播放'; return; }
      btn.textContent = '⏸ 暂停';
      if (i >= frames.length - 1) show(0);
      timer = setInterval(() => {
        if (i >= frames.length - 1) { show(0); } else { show(i + 1); }
      }, 420);
    });
    body.querySelectorAll('.wx-segbtn').forEach(b => b.addEventListener('click', () => {
      if (timer) { clearInterval(timer); timer = null; }
      WXUI._radarReg = b.dataset.reg;
      if (opt.onRegion) opt.onRegion(b.dataset.reg);
    }));

    // 关闭时把定时器停掉，别在后台空转
    const drawer = body.closest('.wx-drawer');
    const obs = new MutationObserver(() => {
      if (drawer.hidden && timer) { clearInterval(timer); timer = null; btn.textContent = '▶ 播放'; }
    });
    obs.observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* 台风：左侧列表 + 右侧地图 */
  function renderTyphoon(body, sub, all, show, pick) {
    body.innerHTML =
      '<div class="wx-ty">' +
        '<div class="wx-tylist">' + show.map(t =>
          '<button class="wx-tyitem' + (t.id === pick ? ' on' : '') + '" data-id="' + t.id + '">' +
            '<span class="wx-tyno">' + esc(t.no || '') + '</span>' +
            '<span class="wx-tyname">' + esc(t.cn || t.en || '未命名') + '</span>' +
            (t.live ? '<span class="wx-tylive">进行中</span>' : '<span class="wx-tydead">已停编</span>') +
          '</button>').join('') + '</div>' +
        '<div class="wx-tymap"><div id="wxTyChart" class="wx-map"></div>' +
          '<div class="wx-tyinfo" id="wxTyInfo"></div></div>' +
      '</div>';

    body.querySelectorAll('.wx-tyitem').forEach(b => b.addEventListener('click', () => WXUI.selectTyphoon(+b.dataset.id)));

    W.typhoonView(pick).then(ty => {
      if (sub) sub.textContent = (ty.cn || ty.en) + ' · 第 ' + ty.no + ' 号' + (ty.meaning ? ' · 名字意思：' + ty.meaning : '');
      drawTyphoon(ty);
    }).catch(e => {
      const el = $('#wxTyChart');
      if (el) el.innerHTML = '<div class="wx-load">路径解析失败：' + esc(e.message) + '</div>';
    });
  }

  async function drawTyphoon(ty) {
    const el = document.getElementById('wxTyChart');
    if (!el || !global.echarts) return;
    // 用"亚洲-太平洋"底图而不是中国底图：台风常跑到 160°E 以东，
    // 那里中国底图一片空白，连海岸线都没有，看不出台风在哪。
    await W.worldMap();
    const ec = echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' });
    const TH = theme();

    const trk = ty.pts.map(p => [p.lon, p.lat]);
    const last = ty.pts[ty.pts.length - 1];
    const fc = (last && last.fcst) ? last.fcst : [];
    // 预报线从当前位置接着画
    const fcLine = fc.length ? [[last.lon, last.lat]].concat(fc.map(f => [f.lon, f.lat])) : [];
    const pts = ty.pts.map(p => ({
      value: [p.lon, p.lat],
      itemStyle: { color: W.catColor(p.cat) },
      _p: p
    }));
    const fcPts = fc.map(f => ({
      value: [f.lon, f.lat],
      itemStyle: { color: W.catColor(f.cat) },
      _f: f
    }));

    // 视野按这条路径的实际范围来定，并留出足够边距；
    // 台风常跑到西太平洋上去，固定视角要么把它挤出画面，要么把中国压成一条缝。
    const span = trk.concat(fcLine);
    const lons = span.map(p => p[0]), lats = span.map(p => p[1]);
    let w0 = Math.min.apply(null, lons), w1 = Math.max.apply(null, lons);
    let s0 = Math.min.apply(null, lats), s1 = Math.max.apply(null, lats);
    const padX = Math.max(7, (w1 - w0) * 0.30), padY = Math.max(5, (s1 - s0) * 0.30);
    w0 -= padX; w1 += padX; s0 -= padY; s1 += padY;
    // 台风图的老规矩是"中国 + 西太平洋"同框：视野至少盖住中国东南半壁，
    // 否则台风孤零零悬在洋面上，用户没有参照物。
    w0 = Math.min(w0, 103); w1 = Math.max(w1, 143);
    s0 = Math.min(s0, 4); s1 = Math.max(s1, 42);
    // 视野别小于 34°×26°，否则一个小台风会占满整屏显得很怪
    if (w1 - w0 < 34) { const c = (w0 + w1) / 2; w0 = c - 17; w1 = c + 17; }
    if (s1 - s0 < 26) { const c = (s0 + s1) / 2; s0 = c - 13; s1 = c + 13; }
    s0 = Math.max(-12, s0); s1 = Math.min(58, s1);

    ec.setOption({
      animation: false,
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: '#161a22', borderColor: '#2b323d', textStyle: { color: '#e9edf4', fontSize: 11 },
        formatter: p => {
          const d = p.data || {};
          if (d._f) {
            const f = d._f;
            return '预报 +' + f.h + 'h（' + esc(f.org) + '）<br/>' +
              '位置 ' + fx1(f.lon) + '°E, ' + fx1(f.lat) + '°N<br/>' +
              '中心气压 ' + (f.pres == null ? '--' : f.pres) + ' hPa<br/>' +
              '最大风速 ' + (f.wind == null ? '--' : f.wind) + ' m/s<br/>强度 ' + W.catName(f.cat);
          }
          if (d._p) {
            const a = d._p;
            return a.t.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:00') + '<br/>' +
              '位置 ' + fx1(a.lon) + '°E, ' + fx1(a.lat) + '°N<br/>' +
              '中心气压 ' + (a.pres == null ? '--' : a.pres) + ' hPa<br/>' +
              '最大风速 ' + (a.wind == null ? '--' : a.wind) + ' m/s<br/>' +
              '强度 ' + W.catName(a.cat) +
              (a.moveDir ? '<br/>移向 ' + esc(a.moveDir) + ' ' + (a.moveSpd == null ? '' : a.moveSpd + ' km/h') : '');
          }
          return '';
        }
      },
      geo: {
        map: 'wxWorld', roam: true, zoom: 1,
        boundingCoords: [[w0, s0], [w1, s1]],
        itemStyle: { areaColor: 'rgba(48,64,86,.55)', borderColor: 'rgba(120,150,190,.55)', borderWidth: .6 },
        emphasis: { itemStyle: { areaColor: 'rgba(70,95,130,.7)' }, label: { show: false } },
        label: { show: false }, silent: false
      },
      series: [
        {
          name: '路径', type: 'lines', coordinateSystem: 'geo', silent: true,
          polyline: false, data: [{ coords: trk }],
          lineStyle: { color: '#ffd166', width: 1.8, opacity: .95 }
        },
        {
          name: '预报路径', type: 'lines', coordinateSystem: 'geo', silent: true,
          data: fcLine.length > 1 ? [{ coords: fcLine }] : [],
          lineStyle: { color: '#ffd166', width: 1.5, type: 'dashed', opacity: .85 }
        },
        { name: '实况', type: 'scatter', coordinateSystem: 'geo', symbolSize: 9, data: pts, z: 5 },
        { name: '预报', type: 'scatter', coordinateSystem: 'geo', symbolSize: 7, symbol: 'diamond', data: fcPts, z: 5 },
        {
          name: '当前', type: 'effectScatter', coordinateSystem: 'geo', symbolSize: 14, z: 6,
          rippleEffect: { brushType: 'stroke', scale: 2.6 },
          itemStyle: { color: W.catColor(last && last.cat) },
          data: last ? [{ value: [last.lon, last.lat], _p: last }] : []
        }
      ]
    }, true);

    const info = document.getElementById('wxTyInfo');
    if (info && last) {
      info.innerHTML =
        '<div class="wx-tynow"><span class="wx-dot" style="background:' + W.catColor(last.cat) + '"></span>' +
        '<b>' + W.catName(last.cat) + '</b> ' + fx1(last.lon) + '°E ' + fx1(last.lat) + '°N</div>' +
        '<div class="wx-tygrid">' +
        row('中心气压', (last.pres == null ? '--' : last.pres) + ' hPa') +
        row('最大风速', (last.wind == null ? '--' : last.wind) + ' m/s（' + windScale(last.wind) + '）') +
        row('移向移速', (last.moveDir || '--') + (last.moveSpd == null ? '' : ' ' + last.moveSpd + ' km/h')) +
        row('最新时次', last.t.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:00')) +
        (fc.length ? row('中央气象台预报', '未来 ' + fc[fc.length - 1].h + ' 小时') : '') +
        '</div>';
    }
  }

  function windScale(ms) {
    if (ms == null) return '--';
    const t = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    let n = 0;
    for (let i = 0; i < t.length; i++) if (ms >= t[i]) n = i + 1;
    return n + ' 级';
  }
  function row(k, v) {
    return '<div class="wx-tyrow"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
  }

  global.WXUI = WXUI;
})(window);
