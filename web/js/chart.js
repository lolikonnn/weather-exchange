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

  const C = {
    bg: 'transparent',
    axis: '#39404e',
    split: '#1e232d',
    label: '#7b8291',
    labelHi: '#c9cdd6',
    ma: ['#e9edf4', '#ffd666', '#d16dff', '#2bd6a0', '#4d9bff'],
    maName: ['MA5', 'MA10', 'MA20', 'MA30', 'MA60'],
    up: '#ff4d4f', down: '#00b578',
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
    const accent = s.getPropertyValue('--accent').trim();
    if (up) C.up = up;
    if (dn) C.down = dn;
    if (accent) C.avg = C.dea = C.d = accent;
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

  let main = null, sub = null;

  /* ───────── 通用 grid ───────── */
  function grid(l, r, t, b) {
    return { left: l, right: r, top: t, bottom: b, containLabel: false };
  }

  /* ═══════════════ 主图 ═══════════════ */

  /** 分时 / 五日 */
  function optTrend(S) {
    const pts = S.points || [];
    if (!pts.length) return emptyOpt('暂无分时数据');
    const base = S.base;
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

    const labelFmt = (v) => String(v).slice(11, 16);
    const axisLbl = S.five ? (v) => {
      const d = String(v).slice(0, 10), h = String(v).slice(11, 16);
      return h === '00:00' ? d.slice(5) : (h === '12:00' ? h : '');
    } : labelFmt;

    return {
      animation: false,
      backgroundColor: C.bg,
      grid: grid(52, 56, 14, 22),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => {
          const i = ps[0].dataIndex, t = xs[i], p = ys[i];
          const chg = base != null ? p - base : null;
          const pct = base ? chg / base * 100 : null;
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
        axisLabel: Object.assign({}, axisCommon.axisLabel, { interval: S.five ? Math.max(1, Math.floor(xs.length / 12)) : 1, formatter: axisLbl, hideOverlap: true }),
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
          type: 'value', min: +((lo - base) / base * 100).toFixed(2), max: +((hi - base) / base * 100).toFixed(2),
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
              { offset: 0, color: 'rgba(255,77,79,.30)' }, { offset: 1, color: 'rgba(255,77,79,.02)' }
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
    const candle = bars.map(b => [b.o, b.c, b.l, b.h]);
    const metric = METRICS[S.metric] || METRICS.range;

    const view = S.view == null ? 90 : S.view;
    const start = bars.length > view ? (1 - view / bars.length) * 100 : 0;

    const series = [{
      name: 'K线', type: 'candlestick', data: candle, z: 3,
      itemStyle: {
        color: C.up, color0: C.down,
        borderColor: C.up, borderColor0: C.down, borderWidth: 1
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
      grid: grid(52, 56, 16, 34),
      tooltip: Object.assign({}, tooltipBase, { formatter: klineTip(bars, xs, S, metric) }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel, { hideOverlap: true, formatter: v => S.monthMode ? v : v.slice(5) }),
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
            formatter: v => S.base ? sgn((v - S.base) / S.base * 100, 1) + '%' : v.toFixed(0)
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
      const chg = b.c - base, pct = base ? chg / base * 100 : 0;
      const amp = b.l ? (b.h - b.l) / (b.o || 1) * 100 : 0;
      let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + b.d + ' ' + weekday(b.d) +
        (b.wcode != null ? ' <span style="color:#4fc3f7">' + API.wmoText(b.wcode) + '</span>' : '') + '</div>';
      h += row('开', fx(b.o, 1) + ' ℃', U.trendColor(b.o - base));
      h += row('高', fx(b.h, 1) + ' ℃', C.up);
      h += row('低', fx(b.l, 1) + ' ℃', C.down);
      h += row('收', fx(b.c, 1) + ' ℃', U.trendColor(chg));
      h += row('涨跌', sgn(chg, 1) + ' ℃ ' + sgn(pct, 2) + '%', U.trendColor(chg));
      h += row('振幅', fx(b.h - b.l, 1) + ' ℃', C.labelHi);
      h += row(metric.label, fx(metric.get(b), metric.unit === '%' ? 0 : 1) + metric.unit, '#4fc3f7');
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
    const start = bars.length > view ? (1 - view / bars.length) * 100 : 0;
    const zoom = [
      { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
      { type: 'slider', xAxisIndex: [0], start: start, end: 100, show: false }
    ];
    const baseOpt = {
      animation: false, backgroundColor: C.bg,
      grid: grid(52, 56, 12, 6),
      tooltip: Object.assign({}, tooltipBase, {
        formatter: (ps) => subTip(ps, S, xs)
      }),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis: [{
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: C.axis } }, axisTick: { show: false },
        axisLabel: Object.assign({}, axisCommon.axisLabel, { hideOverlap: true, formatter: v => v.slice(5) }),
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
            value: v, itemStyle: { color: (bars[i].c >= bars[i].o ? C.up : C.down), opacity: .78 }
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
    let h = '<div style="font-weight:700;color:#e9edf4;margin-bottom:3px">' + b.d + ' ' + weekday(b.d) + '</div>';
    const n = S.indName, ind = S.ind;
    const g = (k) => (ind[k] && ind[k][i] != null) ? fx(ind[k][i], 3) : '--';
    if (n === 'vol') {
      const metric = METRICS[S.metric] || METRICS.range;
      h += row(metric.label, fx(metric.get(b), 1) + metric.unit, '#4fc3f7');
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
      return this;
    },
    setTheme() { readTheme(); },
    hasMain() { return !!main; },
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
