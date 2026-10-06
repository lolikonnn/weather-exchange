/* ═══════════════════════════════════════════════════════════════
   chart.js — ECharts 行情图（分时 / 五日 / 日K / 周K / 月K / 预报K + 副图）
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { fx, sgn, parseDate, weekday } = U;

  const METRICS = {
    range: { label: '日内温差', unit: '℃', get: b => b.range },
    precip: { label: '降水量', unit: 'mm', get: b => b.v },
    wind: { label: '平均风速', unit: 'm/s', get: b => b.windAvg },
    humid: { label: '平均湿度', unit: '%', get: b => b.humAvg }
  };

  /** K 线 tooltip 的标题。
      日K / 周K 的键是完整日期（周K 是那一周的周一），所以能带上星期几；
      月K 的键只有 'YYYY-MM'，拼不出星期几 —— 别硬拼，改成 "2025 年 11 月"。 */
  function tipTitle(d) {
    const w = weekday(d);
    if (w) return d + ' ' + w;
    const m = /^(\d{4})-(\d{2})$/.exec(String(d));
    return m ? m[1] + ' 年 ' + (+m[2]) + ' 月' : String(d);
  }

  const C = {
    bg: 'transparent',
    axis: '#39404e',
    split: '#1e232d',
    label: '#7b8291',
    labelHi: '#c9cdd6',
    ma: ['#e9edf4', '#ffd666', '#d16dff', '#2bd6a0', '#4d9bff'],
    maName: ['MA5', 'MA10', 'MA20', 'MA30', 'MA60'],
    up: '#ff4d4f', down: '#00b578',
    // 平盘（开盘 == 收盘，气温没升没降）。既不算涨也不算跌，用中性灰。
    flat: '#8b919e',
    boll: ['#ffb74d', '#7f8fa6', '#4fc3f7'],
    dif: '#e9edf4', dea: '#ffd666',
    k: '#e9edf4', d: '#ffd666', j: '#d16dff',
    wr: ['#e9edf4', '#ffd666'],
    avg: '#ffd666',
    base: '#6b7280',
    // 多日分时图的"日界"明暗带：第 1/3/5 天亮、第 2/4 天暗。
    // 原来的 .022 白几乎看不见，等于没画；这里拉到肉眼可辨的程度。
    bandLight: 'rgba(148,178,232,.075)',
    bandDark: 'rgba(0,0,0,.28)'
  };

  function readTheme() {
    const s = getComputedStyle(document.body);
    const up = s.getPropertyValue('--up').trim(), dn = s.getPropertyValue('--down').trim();
    const fl = s.getPropertyValue('--flat').trim();
    const accent = s.getPropertyValue('--accent').trim();
    if (up) C.up = up;
    if (dn) C.down = dn;
    if (fl) C.flat = fl;
    if (accent) C.avg = C.dea = C.d = accent;
    // 窄屏（手机竖屏）上 K 线 tooltip 有十几行、能到 215px 高，比主图容器本身
    // （窄屏 min-height 只有 170px）还高。confine 只能把它按在容器左上角，
    // 仍然会冒出去一截。所以跟着屏幕宽度把字号和内边距收紧，让它尽量塞得下。
    const narrow = global.innerWidth <= 660;
    tooltipBase.padding = narrow ? [4, 7] : [7, 10];
    tooltipBase.textStyle.fontSize = narrow ? 11 : 12;
    tooltipBase.extraCssText = narrow ? 'line-height:1.35;' : '';
  }

  /** 给主题色套一个透明度，用于面积渐变。
      必须由 C.up 推导，不能写死字面量 —— 否则切到 body.us 时色板翻转，
      C.up 变成绿的而渐变色还是红的，线绿、底红。 */
  function withAlpha(col, a) {
    const c = String(col || '').trim();
    const h = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
    if (/^#[0-9a-f]{6}$/i.test(c)) return c + h;
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] + h;
    return c;
  }

  const axisCommon = {
    axisLine: { lineStyle: { color: C.axis } },
    axisTick: { show: false },
    axisLabel: { color: C.label, fontSize: 10.5, fontFamily: 'Consolas,monospace' },
    splitLine: { show: true, lineStyle: { color: C.split, type: 'dashed' } }
  };
  const splitNone = { show: false };

  const tooltipBase = {
    trigger: 'axis',
    // 必须 confine —— ECharts 默认允许 tooltip 画到容器外面。手机竖屏时主图很窄，
    // 触发点靠左就会算出负的 left，整个信息框被屏幕边缘切掉一截（用户报的
    // "信息窗格在某些位置会被遮挡无法看到全貌"）。confine 把它按在容器内。
    confine: true,
    backgroundColor: 'rgba(24,28,36,.96)',
    borderColor: '#3a4252',
    borderWidth: 1,
    padding: [7, 10],
    textStyle: { color: '#c9cdd6', fontSize: 12 },
    axisPointer: {
      type: 'cross',
      lineStyle: { color: '#5a6478', type: 'dashed', width: 1 },
      crossStyle: { color: '#5a6478' },
      label: { backgroundColor: '#39404e', color: '#e9edf4', fontSize: 11 }
    }
  };

  function mkChart(el) {
    const c = echarts.init(el, null, { renderer: 'canvas' });
    c.group = 'tjs';
    return c;
  }

  /** 让 ECharts 跟着容器尺寸走。
      只挂 window.resize 不够 —— 安卓 APP 启动时系统栏的 inset 是在 WebView
      建好之后才补到根布局上的，容器会"先高后矮"，而页面不一定收到 window.resize。
      于是 ECharts 一直按旧高度画，画布就溢出到下面副图的页签行上（用户报的
      "主图曲线溢出到副图选单"）。
      这里三管齐下：ResizeObserver + 启动后头几秒轮询对账 + init 里的 window.resize。
      为什么不能只靠 ResizeObserver：headless Chrome 里实测它压根不派发 —— 自己建
      一个 observer 盯着一个尺寸确实变了的容器，触发 0 次。手机端应该没问题，但
      既然验证不了，就不能把正确性押在它身上。
      容器被隐藏时 rect 是 0，这时候绝不能 resize —— 会把 ECharts 设成 0×0，
      再显示回来就是一片空白（app.js 里那几处 setTimeout resize 就是为这个加的）。 */
  function follow(el, get) {
    let last = '';
    const apply = () => {
      const c = get();
      if (!c) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const key = Math.round(r.width) + 'x' + Math.round(r.height);
      if (key === last) return;
      last = key;
      c.resize();
    };
    if (global.ResizeObserver) {
      const ro = new ResizeObserver(U.debounce(apply, 60));
      ro.observe(el);
    }
    // 启动后头 4 秒每 250ms 对一次账，之后交给上面那些事件
    const t0 = Date.now();
    const tm = setInterval(() => {
      if (Date.now() - t0 > 4000) { clearInterval(tm); return; }
      apply();
    }, 250);
  }

  let main = null, sub = null;

  /* ───────── 通用 grid ───────── */
  function grid(l, r, t, b) {
    return { left: l, right: r, top: t, bottom: b, containLabel: false };
  }

  /* ───────── 主图 / 副图共用的横轴契约 ─────────
     同一个时刻要在上下两块图里落在**同一个 x 像素**上，取决于三件事：
       ① 左右留白一样（否则绘图区宽度和起点都不同）
       ② boundaryGap 一样（false 是"点落在轴上"，true 是"点落在格子中间"，两者逐点渐偏）
       ③ 刻度函数一样（否则同一根刻度线上下写的是不同的字）
     再加一条：K 线主图有 dataZoom、副图没有的话，可见区间根本不是同一段。
     所以这四样收成一份，主图和副图都从这里取，谁也别自己定。 */
  const PAD_L = 52, PAD_R = 56;

  /** 某一周期的横轴刻度参数（interval + formatter）。n = 类别数。
      hourly（趋势/五日）的类别是原始时间键 `YYYY-MM-DDTHH:MM`，K 线是日期（月K 是 `YYYY-MM`）。 */
  function axisOf(period, n) {
    const nKey = Number(n) || 0;
    if (period === '5day') {
      return {
        interval: 0,
        formatter: v => {
          const d = String(v).slice(0, 10), h = String(v).slice(11, 16);
          return h === '00:00' ? d.slice(5) : (h === '12:00' ? h : '');
        }
      };
    }
    if (period === 'trend') {
      return { interval: Math.max(1, Math.round(nKey / 14)), formatter: v => String(v).slice(11, 16) };
    }
    if (period === 'month') return { interval: 'auto', formatter: v => String(v) };
    return { interval: 'auto', formatter: v => String(v).slice(5) };
  }

  /** 主图 dataZoom 的起点百分比。副图必须用同一个值，否则两块图显示的区间不同。 */
  function zoomStart(n, view) { return n > view ? (1 - view / n) * 100 : 0; }

  /* ═══════════════ 主图 ═══════════════ */

  /** 分时 / 五日 */
  function optTrend(S) {
    const pts = S.points || [];
    if (!pts.length) return emptyOpt('暂无分时数据');
    const base = S.base;
    // 右侧百分数轴：气温的比值必须走绝对温标，见 U.pctOf 的注释。
    // base 为空时返回 undefined，让 ECharts 自己定轴范围（原来的写法会算出 NaN）。
    const basePct = v => (base == null ? undefined : +U.pctOf(v, base).toFixed(2));
    const xs = pts.map(p => p.t);
    const ys = pts.map(p => p.p);
    const vals = ys.filter(v => v != null);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = Math.max(hi - lo, 1);
    lo -= span * 0.18; hi += span * 0.18;
    if (base != null) { lo = Math.min(lo, base - span * 0.05); hi = Math.max(hi, base + span * 0.05); }

    // 均价线（累计均价，同花顺的黄色均线）
    const avg = []; let acc = 0;
    for (let i = 0; i < ys.length; i++) { acc += ys[i]; avg.push(+(acc / (i + 1)).toFixed(2)); }

    // 自然日分界：算出每天第一根柱子的小标，用来给多日分时图铺"明暗相间"的底色带。
    const dayBoundary = [];
    let prevDay = null;
    xs.forEach((t, i) => {
      const d = String(t).slice(0, 10);
      if (prevDay && d !== prevDay) dayBoundary.push({ xAxis: i });
      prevDay = d;
    });

    // 明暗带：从第 1 天开始交替（第 1/3/5 天亮、第 2/4 天暗 —— 五日就是"三明两暗"）。
    // 第一天也要参与，所以起始边界是 0；单日分时没有分界，就不铺带子。
    const bands = [];
    if (dayBoundary.length) {
      const bounds = [0].concat(dayBoundary.map(b => b.xAxis)).concat([xs.length]);
      for (let i = 0; i + 1 < bounds.length; i++) {
        bands.push([
          { xAxis: bounds[i] - 0.5, itemStyle: { color: i % 2 ? C.bandDark : C.bandLight } },
          { xAxis: bounds[i + 1] - 0.5 }
        ]);
      }
    }

    // 主图叠加：把当前副图的口径画成一条线贴在主图上（"单独给降水空气这些拉一条线"）。
    // ov.byKey 是「时间键 -> 数值」，这里按横轴的时间戳逐个查表，查不到留 null，线自然断开。
    const ov = S.ov;
    const od = ov && ov.byKey ? xs.map(k => (ov.byKey[k] == null ? null : ov.byKey[k])) : null;
    const ovOk = !!(od && od.some(v => v != null));
    const ovAxis = ovOk ? {
      type: 'value', position: 'right', offset: 44, scale: true,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: Object.assign({}, axisCommon.axisLabel, { color: ov.color, fontSize: 10 }),
      splitLine: splitNone
    } : null;

    const ax = axisOf(S.mode, xs.length);
    const axisLbl = ax.formatter;

    return {
      animation: false,
      backgroundColor: C.bg,
      grid: grid(PAD_L, PAD_R, 14, 22),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => {
          const i = ps[0].dataIndex, t = xs[i], p = ys[i];
          const chg = base != null ? p - base : null;
          const pct = U.pctOf(p, base);
          const w = S.hours ? S.hours[i] : null;
          let html = '<div style="font-weight:700;color:#e9edf4">' + String(t).replace('T', ' ').slice(0, 16) + ' ' + (w ? w : '') + '</div>';
          html += row('气温', fx(p, 1) + ' ℃', U.trendColor(chg));
          if (base != null) html += row('较昨收', sgn(chg, 1) + ' ℃  ' + sgn(pct, 2) + '%', U.trendColor(chg));
          html += row('均价', fx(avg[i], 1) + ' ℃', C.avg);
          if (S.precips) html += row('降水', fx(S.precips[i], 1) + ' mm', '#4fc3f7');
          if (ovOk) html += row(ov.name, (od[i] == null ? '—' : fx(od[i], ov.unit === '%' ? 0 : 1) + ' ' + ov.unit), ov.color);
          return html;
        }
      }),
      xAxis: [{
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        // 刻度规则来自共用的 axisOf()：副图用同一份，上下两块图的刻度才会对齐。
        // interval:0 让每个时刻都参与排版；五日图靠 formatter 只在 00:00 写日期、12:00 写"12:00"，
        // 其余返回空串。这样每天都能落下一个日期标签，不会像按固定步长抽稀时那样正好跳过日界。
        axisLabel: Object.assign({}, axisCommon.axisLabel, { interval: ax.interval, formatter: axisLbl, hideOverlap: true }),
        splitLine: splitNone
      }],
      yAxis: [
        {
          type: 'value', min: +lo.toFixed(1), max: +hi.toFixed(1), scale: true,
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, { formatter: v => v.toFixed(1), color: C.labelHi }),
          splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
        },
        {
          type: 'value', min: basePct(lo), max: basePct(hi),
          position: 'right', axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, {
            formatter: v => sgn(v, 2) + '%',
            color: (v) => v > 0 ? C.up : v < 0 ? C.down : C.label
          }),
          splitLine: splitNone
        }
      ].concat(ovOk ? [ovAxis] : []),
      series: [
        // 日界背景带单独挂在一个不画线的系列上：z 最低，保证明暗带在气温/均价下面，
        // 顺便在每条分界线上画一根竖虚线，即使被面积渐变盖住也还能看出"一天到这儿结束"。
        bands.length ? {
          name: '_days', type: 'line', data: [], silent: true, z: 1, showSymbol: false,
          markArea: { silent: true, data: bands },
          markLine: {
            silent: true, symbol: 'none', label: { show: false }, animation: false,
            lineStyle: { color: 'rgba(255,255,255,.16)', type: 'dashed', width: 1 },
            data: dayBoundary.map(b => ({ xAxis: b.xAxis - 0.5 }))
          }
        } : null,
        {
          name: '气温', type: 'line', data: ys, showSymbol: false, symbol: 'circle', symbolSize: 5,
          lineStyle: { width: 1.5, color: C.up }, z: 5,
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: withAlpha(C.up, .30) }, { offset: 1, color: withAlpha(C.up, .02) }
            ])
          },
          markLine: base != null ? {
            silent: true, symbol: 'none', label: { show: false },
            lineStyle: { color: C.base, type: 'dashed', width: 1 },
            data: [{ yAxis: +base.toFixed(1) }]
          } : undefined
        },
        {
          name: '均价', type: 'line', data: avg, showSymbol: false,
          lineStyle: { width: 1, color: C.avg }, z: 4
        },
        // 叠加线：挂在第 3 根 Y 轴上（右轴再往外 offset 44px），不跟百分比轴抢刻度
        ovOk ? {
          name: ov.name, type: 'line', yAxisIndex: 2, data: od, showSymbol: false,
          connectNulls: false, z: 6,
          lineStyle: { width: 1.3, color: ov.color }, itemStyle: { color: ov.color }
        } : null
      ].filter(Boolean)
    };
  }

  /** K 线（含 MA / BOLL 叠加） */
  function optKline(S) {
    const bars = S.bars || [];
    if (!bars.length) return emptyOpt('暂无K线数据');
    const ind = S.ind, showBoll = S.showBoll;
    const xs = bars.map(b => b.d);
    // 平盘日（开盘 == 收盘，气温一天下来没升没降）既不算涨也不算跌，涂中性灰。
    // ECharts 内部对"收 == 开"走的是严格 close > open 的 else 分支，会套用
    // 跌的 color0/borderColor0（实测确认），所以只能给这几根单独挂 itemStyle。
    // 数组式和 {value, itemStyle} 对象式可以混用；markPoint 的
    // valueDim('highest'/'lowest') 在对象式数据下实测仍然生效。
    const candle = bars.map(b => (b.c === b.o
      ? { value: [b.o, b.c, b.l, b.h], itemStyle: { color: C.flat, color0: C.flat, borderColor: C.flat, borderColor0: C.flat } }
      : [b.o, b.c, b.l, b.h]));
    const metric = METRICS[S.metric] || METRICS.range;

    const view = S.view == null ? 90 : S.view;
    const start = zoomStart(bars.length, view);

    const series = [{
      name: 'K线', type: 'candlestick', data: candle, z: 3,
      // 涨空心、跌实心（A 股习惯）：color 是"实心填充"色，color0 是跌的填充色。
      // 涨的填充给 transparent 就只剩描边，即空心；影线走 borderColor，所以仍是涨色。
      // 空心的好处是数目多、K 线密集时不再糊成一片色块，实体边界一眼可辨。
      itemStyle: {
        color: 'transparent', color0: C.down,
        borderColor: C.up, borderColor0: C.down, borderWidth: 1.2
      },
      markLine: S.base != null ? {
        silent: true, symbol: 'none', label: { show: false },
        lineStyle: { color: C.base, type: 'dotted', width: 1 },
        data: [{ yAxis: +S.base.toFixed(1) }]
      } : undefined,
      markPoint: {
        symbolSize: 0, silent: true,
        label: { fontSize: 10, color: '#fff', backgroundColor: 'rgba(0,0,0,.45)', padding: [1, 3], borderRadius: 2 },
        data: [
          { type: 'max', name: '最高', valueDim: 'highest', label: { formatter: p => '高 ' + fx(p.value, 1) }, itemStyle: { color: C.up } },
          { type: 'min', name: '最低', valueDim: 'lowest', label: { formatter: p => '低 ' + fx(p.value, 1) }, itemStyle: { color: C.down } }
        ]
      }
    }];

    if (showBoll) {
      [['upper', 'BOLL上轨', C.boll[0]], ['mid', 'BOLL中轨', C.boll[1]], ['lower', 'BOLL下轨', C.boll[2]]].forEach(([k, nm, col]) => {
        series.push({
          name: nm, type: 'line', data: ind[k], showSymbol: false, smooth: true,
          lineStyle: { width: 1.1, color: col }, itemStyle: { color: col }, z: 2
        });
      });
    } else {
      [['ma5', 'MA5'], ['ma10', 'MA10'], ['ma20', 'MA20'], ['ma30', 'MA30'], ['ma60', 'MA60']].forEach(([k, nm], i) => {
        series.push({
          name: nm, type: 'line', data: ind[k], showSymbol: false, smooth: true, connectNulls: false,
          lineStyle: { width: 1.1, color: C.ma[i] }, itemStyle: { color: C.ma[i] }, z: 2
        });
      });
    }

    // 预报部分高亮分隔
    const futureIdx = bars.findIndex(b => b.d > S.today);
    const markArea = futureIdx > 0 ? {
      silent: true,
      itemStyle: { color: 'rgba(79,195,247,.055)' },
      label: { show: true, position: 'insideTop', color: '#4fc3f7', fontSize: 10, formatter: '预报区 →' },
      data: [[{ xAxis: futureIdx - 0.5 }, { xAxis: xs.length - 0.5 }]]
    } : undefined;

    // 主图叠加：K 线的横轴就是分桶键（日 'YYYY-MM-DD' / 周 周一 / 月 'YYYY-MM'），
    // 和 Weather.series() 的分桶键完全一致，所以按键查表一定对得上。
    const ov = S.ov;
    const od = ov && ov.byKey ? xs.map(k => (ov.byKey[k] == null ? null : ov.byKey[k])) : null;
    const ovOk = !!(od && od.some(v => v != null));
    const ovAxis = ovOk ? {
      type: 'value', scale: true, position: 'right', offset: 44,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: Object.assign({}, axisCommon.axisLabel, { color: ov.color, fontSize: 10 }),
      splitLine: splitNone
    } : null;
    if (ovOk) {
      series.push({
        name: ov.name, type: 'line', yAxisIndex: 2, data: od, showSymbol: false,
        connectNulls: false, z: 6,
        lineStyle: { width: 1.3, color: ov.color }, itemStyle: { color: ov.color }
      });
    }

    return {
      animation: false,
      backgroundColor: C.bg,
      // bottom 从 34 放到 46：下面还有一条 height:15/bottom:5 的 dataZoom 滑块，
      // 原来的 34 让 x 轴日期正好压在滑块上（用户截图里"日期被遮挡显示不完全"）。
      // 轴标签从 grid 底边再往下约 8~20px，滑块顶边在 H-19，留出 6px 余量。
      grid: grid(PAD_L, PAD_R, 16, 46),
      tooltip: Object.assign({}, tooltipBase, { formatter: klineTip(bars, xs, S, metric) }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel,
          { hideOverlap: true, interval: axisOf(S.period, xs.length).interval, formatter: axisOf(S.period, xs.length).formatter }),
        splitLine: splitNone
      }],
      yAxis: [
        {
          type: 'value', scale: true, position: 'left',
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, { formatter: v => v.toFixed(1), color: C.labelHi }),
          splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
        },
        {
          type: 'value', scale: true, position: 'right',
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: Object.assign({}, axisCommon.axisLabel, {
            formatter: v => S.base != null ? sgn(U.pctOf(v, S.base), 1) + '%' : v.toFixed(0)
          }),
          splitLine: splitNone
        }
      ].concat(ovOk ? [ovAxis] : []),
      dataZoom: [
        { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
        {
          type: 'slider', xAxisIndex: [0], start: start, end: 100, height: 15, bottom: 5,
          borderColor: '#2a303c', backgroundColor: '#161a22', fillerColor: 'rgba(240,185,11,.10)',
          handleStyle: { color: '#5a6478', borderColor: '#5a6478' },
          moveHandleStyle: { color: '#5a6478' },
          textStyle: { color: C.label, fontSize: 10 },
          dataBackground: { lineStyle: { color: '#3a4252' }, areaStyle: { color: 'rgba(90,100,120,.22)' } },
          brushSelect: false
        }
      ],
      series: series,
      graphic: S.title ? [{
        type: 'text', left: 58, top: 3,
        style: { text: S.title, fill: '#8b919e', fontSize: 11, fontFamily: 'Consolas,monospace' }
      }] : undefined
    };
  }

  function klineTip(bars, xs, S, metric) {
    return (ps) => {
      const i = ps[0].dataIndex, b = bars[i];
      if (!b) return '';
      const prev = bars[i - 1];
      const base = prev ? prev.c : b.o;
      const chg = b.c - base, pct = U.pctOf(b.c, base);
      let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + tipTitle(b.d) +
        (b.wcode != null ? ' <span style="color:#4fc3f7">' + API.wmoText(b.wcode) + '</span>' : '') + '</div>';
      h += row('开', fx(b.o, 1) + ' ℃', U.trendColor(b.o - base));
      h += row('高', fx(b.h, 1) + ' ℃', C.up);
      h += row('低', fx(b.l, 1) + ' ℃', C.down);
      h += row('收', fx(b.c, 1) + ' ℃', U.trendColor(chg));
      h += row('涨跌', sgn(chg, 1) + ' ℃ ' + sgn(pct, 2) + '%', U.trendColor(chg));
      // 副图口径选的是「日内温差」时，振幅跟它算出来是同一个数（都是 最高-最低），
      // 显示两遍没意义。窄屏上少一行，tooltip 也更容易整个塞进主图。
      if (metric.label !== '日内温差') h += row('振幅', fx(b.h - b.l, 1) + ' ℃', C.labelHi);
      // 周K / 月K 是聚合出来的，bar 上只有 {d,o,h,l,c,v,n,raw}，没有 range / windAvg / humAvg
      // （副图在月K 下本来就是隐藏的）。取不到就别显示一个 "-- ℃" 占位行。
      const mv = metric.get(b);
      if (mv != null) h += row(metric.label, fx(mv, metric.unit === '%' ? 0 : 1) + metric.unit, '#4fc3f7');
      if (S.ov && S.ov.byKey) {
        const v = S.ov.byKey[b.d];
        h += row(S.ov.name, (v == null ? '—' : fx(v, S.ov.unit === '%' ? 0 : 1) + ' ' + S.ov.unit), S.ov.color);
      }
      if (S.showBoll) {
        const g = k => (S.ind[k] && S.ind[k][i] != null) ? fx(S.ind[k][i], 1) : '--';
        h += row('BOLL', g('lower') + ' / ' + g('mid') + ' / ' + g('upper'), C.boll[0]);
      } else {
        const g = k => (S.ind[k] && S.ind[k][i] != null) ? fx(S.ind[k][i], 1) : '--';
        h += row('MA5/10/20', g('ma5') + ' / ' + g('ma10') + ' / ' + g('ma20'), C.ma[1]);
        h += row('MA30/60', g('ma30') + ' / ' + g('ma60'), C.ma[3]);
      }
      return h;
    };
  }

  function row(k, v, color) {
    return '<div style="display:flex;gap:14px;justify-content:space-between;line-height:1.65">' +
      '<span style="color:#7b8291">' + k + '</span>' +
      '<span style="color:' + (color || '#e9edf4') + ';font-family:Consolas,monospace">' + v + '</span></div>';
  }

  function emptyOpt(msg) {
    return {
      backgroundColor: C.bg,
      graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: msg, fill: '#575e6d', fontSize: 13 } }],
      xAxis: { show: false }, yAxis: { show: false }, series: []
    };
  }

  /* ═══════════════ 副图 ═══════════════ */
  function optSub(S) {
    const bars = S.bars || [], ind = S.ind || {}, xs = bars.map(b => b.d);
    if (!bars.length) return emptyOpt('');
    const view = S.view == null ? 90 : S.view;
    const start = zoomStart(bars.length, view);
    const zoom = [
      { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      { type: 'slider', xAxisIndex: [0], start: start, end: 100, show: false }
    ];
    const baseOpt = {
      animation: false, backgroundColor: C.bg,
      grid: grid(PAD_L, PAD_R, 12, 26),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => subTip(ps, S, xs)
      }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        // 和主图同一套刻度规则，否则上下两排日期长得不一样
        axisLabel: Object.assign({}, axisCommon.axisLabel,
          { hideOverlap: true, interval: axisOf(S.period, xs.length).interval, formatter: axisOf(S.period, xs.length).formatter }),
        splitLine: splitNone
      }],
      yAxis: [{
        type: 'value', scale: true, position: 'left',
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel, { color: C.label }),
        splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
      }],
      dataZoom: zoom
    };

    const metric = METRICS[S.metric] || METRICS.range;
    if (S.indName === 'vol') {
      const d = bars.map(b => metric.get(b));
      baseOpt.yAxis[0].axisLabel.formatter = v => metric.unit === '%' ? v.toFixed(0) : v.toFixed(1);
      baseOpt.series = [
        {
          name: metric.label, type: 'bar', data: d.map((v, i) => ({
            // 判涨跌必须跟上面蜡烛图用同一个算子。ECharts 的 candlestick 是严格
            // 的 close > open 才算阳线（平盘归阴线，用 color0/borderColor0），
            // 这里原先写的是 >=，于是"收盘==开盘"的那天会出现
            // 「上面一根绿 K 线、下面一根红量柱」——实测 576 天里有 19 天（3.3%）
            // 是这种平盘日。现在平盘统一走中性灰，跟蜡烛的 itemStyle 保持一致。
            value: v,
            itemStyle: {
              color: (bars[i].c === bars[i].o ? C.flat : (bars[i].c > bars[i].o ? C.up : C.down)),
              opacity: .78
            }
          })), barWidth: '62%'
        },
        { name: 'MA5', type: 'line', data: ind.volMa5, showSymbol: false, lineStyle: { width: 1, color: C.ma[1] }, itemStyle: { color: C.ma[1] } },
        { name: 'MA10', type: 'line', data: ind.volMa10, showSymbol: false, lineStyle: { width: 1, color: C.ma[2] }, itemStyle: { color: C.ma[2] } }
      ];
    } else if (S.indName === 'macd') {
      baseOpt.series = [
        {
          name: 'MACD', type: 'bar', barWidth: '55%',
          data: (ind.macd || []).map(v => ({ value: v, itemStyle: { color: v >= 0 ? C.up : C.down, opacity: .8 } }))
        },
        { name: 'DIF', type: 'line', data: ind.dif, showSymbol: false, lineStyle: { width: 1.2, color: C.dif }, itemStyle: { color: C.dif } },
        { name: 'DEA', type: 'line', data: ind.dea, showSymbol: false, lineStyle: { width: 1.2, color: C.dea }, itemStyle: { color: C.dea } }
      ];
    } else if (S.indName === 'kdj') {
      baseOpt.yAxis[0].min = 0; baseOpt.yAxis[0].max = 100;
      baseOpt.series = [
        lineS('K', ind.k, C.k), lineS('D', ind.d, C.d), lineS('J', ind.j, C.j),
        refLine([20, 80])
      ];
    } else if (S.indName === 'rsi') {
      baseOpt.series = [
        lineS('RSI6', ind.rsi6, C.k), lineS('RSI12', ind.rsi12, C.d), lineS('RSI24', ind.rsi24, C.j),
        refLine([30, 70])
      ];
    } else if (S.indName === 'wr') {
      baseOpt.yAxis[0].min = 0; baseOpt.yAxis[0].max = 100; baseOpt.yAxis[0].inverse = true;
      baseOpt.series = [lineS('WR6', ind.wr6, C.wr[0]), lineS('WR14', ind.wr14, C.wr[1]), refLine([20, 80])];
    } else if (S.indName === 'boll') {
      baseOpt.yAxis[0].axisLabel.formatter = v => v.toFixed(0) + '%';
      baseOpt.series = [
        { name: '带宽', type: 'line', data: ind.width, showSymbol: false, smooth: true, lineStyle: { width: 1.3, color: C.boll[0] }, itemStyle: { color: C.boll[0] },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,183,77,.22)' }, { offset: 1, color: 'rgba(255,183,77,0)' }]) } }
      ];
    }
    return baseOpt;
  }

  function lineS(name, data, color) {
    return { name, type: 'line', data, showSymbol: false, smooth: false, lineStyle: { width: 1.1, color }, itemStyle: { color } };
  }
  function refLine(ys) {
    return {
      name: '参考', type: 'line', data: [], silent: true, showSymbol: false,
      markLine: {
        silent: true, symbol: 'none', label: { show: false },
        lineStyle: { color: '#3f4756', type: 'dashed', width: 1 },
        data: ys.map(y => ({ yAxis: y }))
      }
    };
  }

  function subTip(ps, S, xs) {
    const i = ps[0].dataIndex, b = S.bars[i];
    if (!b) return '';
    let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + tipTitle(b.d) + '</div>';
    const n = S.indName, ind = S.ind;
    const g = (k) => (ind[k] && ind[k][i] != null) ? fx(ind[k][i], 3) : '--';
    if (n === 'vol') {
      const metric = METRICS[S.metric] || METRICS.range;
      const mv = metric.get(b);
      if (mv != null) h += row(metric.label, fx(mv, 1) + metric.unit, '#4fc3f7');
      h += row('MA5', g('volMa5'), C.ma[1]); h += row('MA10', g('volMa10'), C.ma[2]);
    } else if (n === 'macd') {
      h += row('DIF', g('dif'), C.dif); h += row('DEA', g('dea'), C.dea);
      h += row('MACD', g('macd'), (ind.macd && ind.macd[i] >= 0) ? C.up : C.down);
    } else if (n === 'kdj') { h += row('K', g('k'), C.k); h += row('D', g('d'), C.d); h += row('J', g('j'), C.j); }
    else if (n === 'rsi') { h += row('RSI6', g('rsi6'), C.k); h += row('RSI12', g('rsi12'), C.d); h += row('RSI24', g('rsi24'), C.j); }
    else if (n === 'wr') { h += row('WR6', g('wr6'), C.wr[0]); h += row('WR14', g('wr14'), C.wr[1]); }
    else if (n === 'boll') { h += row('带宽', g('width'), C.boll[0]); }
    return h;
  }

  /* ═══════════════ 对外 ═══════════════ */
  const Chart = {
    METRICS,
    init(mainEl, subEl) {
      readTheme();
      main = mkChart(mainEl);
      sub = mkChart(subEl);
      echarts.connect('tjs');
      window.addEventListener('resize', U.debounce(() => { main.resize(); sub.resize(); }, 120));
      follow(mainEl, () => main);
      follow(subEl, () => sub);
      return this;
    },
    setTheme() { readTheme(); },
    // 副图（wxui.js 画的天气副图）必须复用同一套横轴契约，
    // 否则同一个时刻会落在不同的 x 像素上 —— 用户报的"上下日期没对齐"。
    axisOf, zoomStart, PAD_L, PAD_R,
    hasMain() { return !!main; },
    /** 主图当前用的横轴类别数组。副图必须吃同一份（见 wxui.js 的 alignSeries）——
        副图自己的聚合桶数跟主图 K 线根数能差一个数量级（实测 60 vs 553 根），
        不共用类别数组，留白和刻度怎么调都对不上。 */
    mainCats() {
      if (!main) return null;
      const o = main.getOption();
      return (o && o.xAxis && o.xAxis[0] && o.xAxis[0].data) || null;
    },
    renderMain(S) {
      if (!main) return;
      readTheme();
      let opt;
      if (S.mode === 'trend' || S.mode === '5day') opt = optTrend(S);
      else opt = optKline(S);
      main.setOption(opt, true);
      this._mainStart = opt.dataZoom ? opt.dataZoom[0].start : null;
    },
    renderSub(S) {
      if (!sub) return;
      readTheme();
      sub.setOption(optSub(S), true);
    },
    renderEmpty(msg) {
      if (main) main.setOption(emptyOpt(msg), true);
      if (sub) sub.setOption(emptyOpt(''), true);
    },
    resize() { if (main) main.resize(); if (sub) sub.resize(); },
    showLoading(txt) {
      if (main) main.showLoading('default', { text: txt || '加载中', color: C.avg, textColor: '#8b919e', maskColor: 'rgba(14,16,21,.6)', fontSize: 13, spinnerRadius: 9, lineWidth: 2 });
    },
    hideLoading() { if (main) main.hideLoading(); }
  };

  global.Chart = Chart;
})(window);
