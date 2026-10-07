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

  /* 把 Weather.series() 的输出**重新对齐到主图用的横轴类别数组**上。
     为什么必须这么做（实测数据）：主图日K 有 553 根（来自一份很长的日线历史），
     而副图的数据源只有逐小时（Open-Meteo 最多回溯 92 天）→ 副图只能聚合出 60 个桶。
     60 ≠ 553，两边类别数组不同，哪怕留白 / boundaryGap / 刻度函数都调成一样，
     同一个日期仍旧落在不同的 x 像素上。所以副图不再自己定横轴，直接吃主图的。
     主图有、逐小时覆盖不到的时段填 null：柱子不画、线自然断开 —— 这是数据可得性的
     诚实反映，不是 bug；要让它变满只能换更长的数据源（归档 API），不是这里能补的。 */
  // 这份名单就是"对齐时要逐字段搬过去的列"—— Weather.series() 里新增一个字段，
  // 忘了往这儿加，它在副图上就会**静默消失**（不报错、也不为空，就是没有）。
  const ALIGN_FIELDS = ['temp', 'precip', 'prob', 'wind', 'gust', 'windDir',
    'cloud', 'cloudLow', 'cloudMid', 'cloudHigh', 'uv', 'pm25', 'aqi'];

  function alignSeries(cats, s) {
    if (!cats || !cats.length) return s;
    const stub = () => {
      // s 为 null 时也要返回一份"空但横轴正确"的壳：这样"暂无数据"的空状态
      // 跟有数据时占的是同一套坐标，切换口径不会整块图跳一下。
      const o = { mode: null, span: '', key: cats.slice(), label: [] };
      ALIGN_FIELDS.forEach(f => { o[f] = cats.map(() => null); });
      cats.forEach(k => o.label.push(String(k).slice(5).replace('T', ' ').replace('-', '/')));
      return o;
    };
    if (!s) return stub();
    const idx = {};
    if (s.key) for (let i = 0; i < s.key.length; i++) idx[s.key[i]] = i;
    const out = { mode: s.mode, span: s.span, key: cats.slice(), label: [] };
    ALIGN_FIELDS.forEach(f => { out[f] = []; });
    cats.forEach(k => {
      const i = idx[k];
      // 主图有、副图没有 → label 用一个从键现推的兜底写法（K线是 2026-10-05 → 10/05）
      out.label.push(i == null
        ? String(k).slice(5).replace('T', ' ').replace('-', '/')
        : s.label[i]);
      ALIGN_FIELDS.forEach(f => out[f].push(i == null ? null : ((s[f] || [])[i] == null ? null : s[f][i])));
    });
    return out;
  }

  /* 副图统一的坐标轴外壳。
     左右留白、boundaryGap、刻度函数、dataZoom 全部从主图那边取同一份（Chart 暴露的横轴契约）——
     这四样里只要有一样跟主图不同，同一个时刻就会落在不同的 x 像素上，
     看过去就是用户报的"上下日期没对齐"。 */
  function base(TH, xs, yName, period, view) {
    const hourly = (period === 'trend' || period === '7day');
    const CH = (typeof window !== 'undefined' && window.Chart) || null;
    const ax = CH ? CH.axisOf(period, xs.length) : { interval: 'auto', formatter: v => String(v) };
    const L = CH ? CH.PAD_L : 72, R = CH ? CH.PAD_R : 64;
    const o = {
      animation: false,
      // ⚠ grid.top 必须给轴的 **name** 留地方：ECharts 把 yAxis.name 画在绘图区顶部、
      //   网格**外面**（默认 nameLocation:'end'）。以前 top:16，名字整个落在画布上边界之外，
      //   被裁得只剩一丁点 —— 就是使用者看到的"页签栏下面和视图之间藏了什么东西"。
      //   空气那档有**两个**名字（左 `AQI`、右 `μg/m³`），降水也是（`mm` / `%`）。
      //   带单位才准确（使用者明确要求保留），所以名字留着、把地方让出来。
      //   top 只影响纵向，x 轴位置由 left/right 决定 → **不影响主副图对齐**。
      // 刻度字体必须跟主图一样：chart.js 的 axisCommon.axisLabel 是
      // `fontSize: 10.5, fontFamily: 'Consolas,monospace'`。副图以前用 10 + 默认无衬线，
      // 两块图的数字粗细和字宽都不一样（使用者提过）。
      grid: { left: L, right: R, top: 26, bottom: 26, containLabel: false },
      tooltip: {
        trigger: 'axis', confine: true, axisPointer: { type: 'cross', label: { backgroundColor: '#39404e' } },
        backgroundColor: '#161a22', borderColor: '#2b323d',
        textStyle: { color: '#e9edf4', fontSize: 11 }
      },
      xAxis: {
        type: 'category', data: xs,
        // 主图七档**统一** boundaryGap: true（一格一个点、居中），副图跟着走。
        // 以前这里是 `!hourly` —— 逐小时那两档跟着折线用 false，于是柱子骑在刻度点上、
        // 左右各探半根压住左边的刻度。现在两边都是 true，柱子在格里、和主图一格对一格。
        boundaryGap: true,
        axisLine: { lineStyle: { color: TH.line } },
        axisLabel: { color: TH.dim, fontSize: 10.5, fontFamily: 'Consolas,monospace', interval: ax.interval, formatter: ax.formatter, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value', name: yName || '', nameTextStyle: { color: TH.dim, fontSize: 10.5 },
        axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10.5, fontFamily: 'Consolas,monospace' },
        splitLine: { lineStyle: { color: TH.line, type: 'dashed' } }
      }
    };
    // K 线主图带 dataZoom，副图如果不带，两块图可见的区间根本不是同一段。
    // 用 Chart.zoomStart() 算同一个 start，主图拖到哪儿副图就跟到哪儿。
    if (!hourly && CH && view) {
      const start = CH.zoomStart(xs.length, view);
      o.dataZoom = [
        { type: 'inside', xAxisIndex: [0], start: start, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true, moveOnMouseWheel: false },
        { type: 'slider', xAxisIndex: [0], start: start, end: 100, show: false }
      ];
    }
    return o;
  }

  /* ═══════════════ 1. 副图 ═══════════════ */

  /** 降水：柱子＝降水量(mm)，黄线＝降水概率(%) */
  function optPrecip(w, TH, period, view) {
    const o = base(TH, w.key || w.label, 'mm', period, view);
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      return w.label[i] + '<br/>降水 ' + fx1(w.precip[i]) + ' mm' +
        '<br/>概率 ' + Math.round(w.prob[i] || 0) + '%' +
        '<br/>气温 ' + fx1(w.temp[i]) + '℃';
    };
    // ⚠ 这根轴必须**显式写到右边**：base() 建的轴默认 left，两根都留在左边的话，
    //   两列数字会画在同一个 52px 的左边距里，互相压、还溢出到柱子上。
    o.yAxis = [o.yAxis, {
      type: 'value', max: 100, min: 0, name: '%', position: 'right',
      nameTextStyle: { color: TH.dim, fontSize: 10.5 },
      axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10.5, fontFamily: 'Consolas,monospace', formatter: '{value}' },
      splitLine: { show: false }
    }];
    const mx = Math.max(0.6, ...w.precip.map(v => v || 0));
    o.series = [
      {
        name: '降水量', type: 'bar', yAxisIndex: 0, barWidth: '62%', clip: true,
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
  function optWind(w, TH, period, view) {
    const o = base(TH, w.key || w.label, 'm/s', period, view);
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
  function optCloud(w, TH, period, view) {
    const o = base(TH, w.key || w.label, '%', period, view);
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

  /** 空气：柱子＝PM2.5，线＝AQI。吃 series() 的输出，所以跟着周期走 */
  // 紫外线强度的口语说法。app.js 里有一份一样的，但两个文件是各自独立的 IIFE，
  // 谁也看不见谁，所以这里再写一份（改阈值时两边都要动）。
  function uvWord(v) {
    if (v == null) return '--';
    return v < 3 ? '弱' : v < 6 ? '中等' : v < 8 ? '强' : v < 11 ? '很强' : '极强';
  }
  /** 紫外线等级对应的颜色（越强越红，跟气象上的分级一致）。 */
  function uvColor(v) {
    if (v == null) return '#7f8fa6';
    return v < 3 ? '#2bd6a0' : v < 6 ? '#ffd666' : v < 8 ? '#ffb74d' : v < 11 ? '#ff7043' : '#d16dff';
  }

  function optAir(s, TH, period, view) {
    // 横轴要用原始键（主图的刻度函数认这个），tooltip 里仍旧写给人看的 label
    const xs = (s && s.label) || [], keys = (s && (s.key || s.label)) || [];
    // 没数据时**也要走 base() 建同一套坐标轴**再挂一句提示。
    // 以前这里直接 return 一个只有 title 的 option，于是空状态下副图连 xAxis 都没有，
    // 上下两块图的对齐契约当场失效（探针里表现为 reading '0' 的报错）。
    if (!s || !xs.length || !(s.aqi || []).some(v => v != null)) {
      const o0 = base(TH, keys, 'μg/m³', period, view);
      o0.title = { text: '空气质量数据暂不可用', left: 'center', top: 'middle', textStyle: { color: TH.dim, fontSize: 12 } };
      return o0;
    }
    const pm = s.pm25 || [], aq = s.aqi || [];
    // 紫外线：数据来自 Open-Meteo 的 uv_index，和 PM2.5 一个来源、一条时间轴，
    // 所以直接当第三条线挂在这张图上（"今天该不该防晒"和"今天空气行不行"是同一类问题）。
    const uv = s.uv || [], uvOk = uv.some(v => v != null);
    // ── 轴位统一规则：**左边＝柱子的量程，右边＝折线的量程**（跟「降水」一档一致，
    //    也是炒股软件的惯例）。所以这里：左轴 = PM2.5（柱子，μg/m³）、右轴 = AQI（折线+紫外线）。
    //    以前是反的（AQI 在左、PM2.5 在右），使用者提出来统一。
    const o = base(TH, keys, 'μg/m³', period, view);
    o.tooltip.formatter = ps => {
      const i = ps[0].dataIndex;
      const lv = W.aqiLevel(aq[i]);
      return xs[i] + '<br/>AQI ' + (aq[i] == null ? '--' : Math.round(aq[i])) + '（' + lv.n + '）' +
        '<br/>PM2.5 ' + fx1(pm[i]) + ' μg/m³' +
        (uvOk ? '<br/>紫外线 ' + fx1(uv[i]) + (uv[i] == null ? '' : '（' + uvWord(uv[i]) + '）') : '');
    };
    // 右轴：AQI（折线那一套）。不写 position 就默认留在左边、跟 PM2.5 那根叠在一起，
    // 而且左边距只有 72px，塞不下两列数字。
    o.yAxis = [o.yAxis, {
      type: 'value', name: 'AQI', position: 'right',
      nameTextStyle: { color: TH.dim, fontSize: 10.5 },
      axisLine: { show: false }, axisLabel: { color: TH.dim, fontSize: 10.5, fontFamily: 'Consolas,monospace' }, splitLine: { show: false }
    }];
    o.series = [
      {
        name: 'PM2.5', type: 'bar', yAxisIndex: 0, barWidth: '55%', clip: true,
        data: (pm || []).map(v => ({ value: v == null ? 0 : v, itemStyle: { color: 'rgba(169,123,255,.55)' } }))
      },
      {
        name: 'AQI', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false,
        lineStyle: { width: 1.6, color: TH.accent }, itemStyle: { color: TH.accent },
        data: (aq || []).map(v => (v == null ? null : v))
      }
    ];
    // ── 紫外线并到 AQI 那根轴上（**不再单开第三根轴**）──
    // 这张图已经有两套刻度：左侧 PM2.5（μg/m³）、右侧 AQI（0~500）。
    // 右留白一共只有 56px，塞不下第三列，试过的两条路都不行：
    //   · `offset:38` 推出 AQI 外面 → 被容器切掉（"右侧数字被遮住"）；
    //   · 刻度画进图内 → 正好压在高高的 PM2.5 柱子上（"跟柱状图叠一起"），
    //     而且轴自己的 `name:'UV'` 还留在图外顶部，看着像"有个东西没删干净"。
    // 所以 UV 按 0~12 → 0~AQI轴上限 做**线性映射**，当第三条线画在 AQI 那根轴上；
    // 它的真值在 tooltip 里（带「弱 / 中等 / 强」字样），不靠刻度读。
    if (uvOk) {
      const aVals = aq.filter(v => v != null && isFinite(v));
      const aMax = Math.max(100, Math.ceil(Math.max.apply(null, aVals.concat([0])) / 50) * 50);
      o.yAxis[1].max = aMax;
      o.series.push({
        name: '紫外线', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false, z: 4,
        // 逐点着色让"今天什么时候晒"一眼看出来
        data: uv.map(v => ({ value: v == null ? null : +(v / 12 * aMax).toFixed(1), itemStyle: { color: uvColor(v) } })),
        lineStyle: { width: 1.5, color: '#ffb74d' }, itemStyle: { color: '#ffb74d' }
      });
    }
    return o;
  }

  /* ═══════════════ 2. 全屏功能页 ═══════════════ */

  const WXUI = {
    /** 副图总入口：name ∈ precip|wind|cloud|air，其它名字返回 false 交回 chart.js。
        period 是主图的周期（trend|7day|day|week|month|fcst），副图跟着它走。
        view 是主图 K 线默认显示多少根 —— 副图的 dataZoom 必须用同一个值，
        否则主图只显示最近 90 根、副图显示全部，上下两排刻度对不上。
        axis 是**主图用的横轴类别数组**，必须原样用（见 alignSeries 的注释）。 */
    drawSub(name, wx, air, period, view, axis) {
      if (!W.isWeatherSub(name) || name === 'range') return false;
      const ec = subEc();
      if (!ec) return false;
      const TH = theme();
      // 原来这里写死 window(wx.hourly, 48) —— 不管选哪个周期都只画 48 根小时柱，
      // 所以用户会觉得"降水/风/云量/空气的数据太少、间隔太长"。
      // 现在交给 Weather.series() 按周期重新分桶聚合（日K按天、周K按周…）。
      // 但只聚合还不够：聚合出来的桶数是"逐小时数据能覆盖多少"，而主图 K 线是另一套历史，
      // 实测日K 主图 553 根、副图只有 60 根 —— 两套类别数组对不上，刻度必然错位。
      // 所以再按主图的类别数组重新对齐一次（缺的时刻填 null）。
      const s = alignSeries(axis, wx && wx.hourly ? W.series(wx.hourly, air, name, period) : null);
      let opt;
      if (name === 'air') opt = optAir(s, TH, period, view);
      else if (name === 'precip') opt = s ? optPrecip(s, TH, period, view) : msg('暂无数据', TH);
      else if (name === 'wind') opt = s ? optWind(s, TH, period, view) : msg('暂无数据', TH);
      else if (name === 'cloud') opt = s ? optCloud(s, TH, period, view) : msg('暂无数据', TH);
      else opt = msg('暂无数据', TH);
      ec.setOption(opt, true);
      return true;
    },

    /** 主图叠加用的取数：把当前副图口径变成「按时间键索引」的查表，交给 chart.js 画到主图上。
        为什么不直接按下标对：
          - 分时/7日的横轴是"今天 24 小时 / 昨天→未来五天"，而 series('trend') 给的是
            "从现在往前 2 小时起 24 小时"，两边窗口不一样，按下标对会整体错位；
          - K 线周期的横轴是 K 线柱子，只有按分桶键对才准 —— 而 series() 的分桶键和
            IND.aggregate 的完全一致（周一 / YYYY-MM / YYYY-MM-DD），所以那边反过来必须按键对。
        统一成"按键查表"两种情况都对：查不到的填 null，线自然断在数据边界上。 */
    overlayOf(name, wx, air, period) {
      const M = {
        precip: { label: '降水量', unit: 'mm', color: '#4fc3f7', raw: 'precip', agg: 'precip' },
        wind:   { label: '风速',   unit: 'm/s', color: '#2bd6a0', raw: 'wind',   agg: 'wind' },
        cloud:  { label: '云量',   unit: '%',   color: '#9fb3c8', raw: 'cloud',  agg: 'cloud' },
        air:    { label: 'PM2.5',  unit: 'µg/m³', color: '#d16dff', raw: 'pm25', agg: 'pm25' },
        uv:     { label: '紫外线', unit: '',      color: '#ffb74d', raw: 'uv',   agg: 'uv' }
      }[name];
      if (!M) return null;

      const src = (name === 'air' ? air : (wx && wx.hourly)) || null;
      if (!src || !src.time || !src.time.length) return null;

      const byKey = {};
      if (period === 'trend' || period === '7day' || !period) {
        // 逐小时：直接拿原始时次当键，主图显示哪几个小时就有哪几个小时
        const a = src[M.raw] || [];
        for (let i = 0; i < src.time.length; i++) byKey[src.time[i]] = a[i];
      } else {
        const s = W.series(wx && wx.hourly, air, name, period);
        if (!s || !s.key) return null;
        const a = s[M.agg] || [];
        for (let i = 0; i < s.key.length; i++) byKey[s.key[i]] = a[i];
      }
      return { name: M.label, unit: M.unit, color: M.color, byKey: byKey };
    },

    /* ── 雷达 / 卫星播放器 ── */
    _play: null,

    /* ── 雷达：全国拼图 / 八大区拼图 / 单站（精确到城市）──
       这三层对应气象局公开的三档雷达产品。选大区看拼图，选到具体城市就看那一站的雷达。
       45 城里只有 30 个有独立雷达站（映射表由 tools/radar_slugs.py 离线探测生成），
       其余城市（珠海、佛山、上海、拉萨…）没有单站，只能回落到所在大区。 */
    _radarReg: null,
    _radarProv: null,
    _radarCity: null,
    _radarFrames: null,   // 已探测到的帧 —— 切省/切市时不想重下十几兆
    _radarKey: null,      // 上面那批帧对应的目标（区域代号 或 'S:城市id'）

    async openRadar(region, prov, cityId) {
      const app = window.__APP;
      const cur = app && app.S && app.S.cur;
      const geo = app && app.S && app.S.geo;
      const stations = await W.radarCities();
      const all = (window.API && API.Cities && API.Cities.all) || [];
      const hv = (app && app.haversine) || (() => 1e9);

      // 主页正在浏览的城市，以及「当前所在地」各自能对到哪个雷达站。
      // 所在地优先用最近的那个城市；那个城市没有独立雷达站时，退而找**最近的有站城市**
      // （气象局没有「按坐标取雷达」的接口，只能落到单站产品上）。
      const curSt = (cur && cur.id && stations[cur.id]) ? cur.id : null;
      let locSt = null;
      if (geo) {
        if (geo.nearId && stations[geo.nearId]) locSt = geo.nearId;
        else {
          let bk = Infinity;
          all.forEach(c => {
            if (!stations[c.id] || c.lat == null || c.lon == null) return;
            const k = hv(geo.lat, geo.lon, c.lat, c.lon);
            if (k < bk) { bk = k; locSt = c.id; }
          });
        }
      }

      if (region === undefined || region === null) {
        // 首次打开：默认落到**主页正在浏览的城市**的单站雷达（用户明确要求这个当默认）；
        // 它没有站就沿用上次选的大区。
        region = this._radarReg;
        prov = this._radarProv;
        cityId = this._radarCity;
        if (curSt) { region = W.regionFor(API.Cities.get(curSt)); prov = API.Cities.get(curSt).prov; cityId = curSt; }
        if (!region) region = W.regionFor(cur);
      }
      if (prov === undefined) prov = this._radarProv;
      if (cityId === undefined) cityId = this._radarCity;

      // 大区 -> 该区里的省。**不再只收"有雷达站的省"**：有些省一个单站都没有，
      // 按老写法（`if (stations[c.id] && …)`）那个省在列表里根本不出现，
      // 用户看到的就是"城市列表不完全"。现在所有省都列出来。
      const inReg = c => region === 'ACHN' || W.regionFor(c) === region;
      const provs = [];
      all.forEach(c => {
        if (inReg(c) && provs.indexOf(c.prov) < 0) provs.push(c.prov);
      });
      if (!prov && provs.length) prov = provs[0];        // 别让城市行空着
      if (prov && provs.indexOf(prov) < 0) prov = provs[0] || null;
      // 城市同样**列全**：没有单站雷达的城市照常可选 —— 打开时用**离它最近的那个有站城市**
      // 的单站产品（比大区拼图贴近得多，大区图一覆盖就是几百公里，看不出本地那块雨）。
      // 名字后面**不再标「就近站」**：头部那句已经写明用哪一站、多远，
      // 选项卡里再标一遍是冗余，反而把城市名挤长了（使用者提的）。
      const cityBtns = prov
        ? all.filter(c => c.prov === prov).map(c => [c.id, c.name])
        : [];
      if (cityId && cityBtns.every(x => x[0] !== cityId)) cityId = null;

      // 「📡 当前位置 / 📍 正在浏览」两个快捷入口，永远排在大区行上面一行
      const jumpBtns = [];
      if (locSt) jumpBtns.push(['@loc', '📡 当前位置']);
      if (curSt && curSt !== locSt) jumpBtns.push(['@cur', '📍 ' + (API.Cities.get(curSt) || {}).name]);
      const activeJump = (locSt && cityId === locSt) ? '@loc' : ((curSt && cityId === curSt) ? '@cur' : '');

      this._radarReg = region; this._radarProv = prov; this._radarCity = cityId;

      const body = $('#wxRadarBody'), sub = $('#wxRadarSub');
      if (!body) return;

      const stId = (cityId && stations[cityId]) ? cityId : null;
      const st = stId ? stations[stId] : null;
      const rname = (W.RADAR_REGIONS.filter(x => x.k === region)[0] || {}).n || region;
      const cityNm = cityId ? ((API.Cities.get(cityId) || {}).name || '') : '';
      /* 选中的城市**没有自己的雷达站**时，用**离它最近的那个有站城市**，而不是大区拼图 ——
         大区图一覆盖就是几百公里，本地那块雨根本看不出来。
         这跟上面「当前位置」那条回落路径是**同一条规则**（气象局没有"按坐标取雷达"的接口，
         只能落到最近的单站产品上）。真的一个站都够不着时才退回大区拼图。 */
      let near = null, nearKm = 0;
      if (cityId && !stId) {
        const me = API.Cities.get(cityId);
        if (me && me.lat != null && me.lon != null) {
          let bk = Infinity;
          all.forEach(c => {
            if (!stations[c.id] || c.lat == null || c.lon == null) return;
            const k = hv(me.lat, me.lon, c.lat, c.lon);
            if (k < bk) { bk = k; near = c; nearKm = k; }
          });
        }
      }
      // 真正去取数的那个站（自己的站优先，没有就用就近站）。
      // ⚠ 站对象里**没有 `id` 字段** —— id 就是 `stations` 的键，所以要单独记一份。
      const useId = stId || (near ? near.id : null);
      const useSt = useId ? stations[useId] : null;
      const key = useId ? 'S:' + useId : region;
      const label = st
        ? ((cityId === locSt ? '📡 当前位置 · ' : cityId === curSt ? '📍 ' + (API.Cities.get(curSt) || {}).name + ' · ' : '') + st.name + ' 单站雷达')
        : (useSt
            ? '雷达回波 · ' + useSt.name + ' 单站雷达（' + cityNm + ' 没有自己的站，用最近的 ' + useSt.name + '，约 ' + Math.round(nearKm) + ' km）'
            : (cityNm
                ? '雷达回波 · ' + rname + '（' + cityNm + ' 附近没有单站雷达，用大区拼图）'
                : '雷达回波 · ' + rname));

      let frames = this._radarFrames;
      if (this._radarKey !== key || !frames || !frames.length) {
        body.innerHTML = '<div class="wx-load">正在探测最近有货的雷达帧…</div>';
        // 单站和大区都没有 small/ 档，每帧 500–900 KB，所以只取 8 帧；
        // 只有全国拼图有 small/（约 200 KB），可以取 16 帧。
        const want = useSt ? 8 : (region === 'ACHN' ? 16 : 8);
        const step = (g, t) => { if (sub) sub.textContent = '已找到 ' + g + ' 帧'; };
        try {
          frames = useSt ? await W.probeStation(useSt.az, want, step)
                         : await W.probeRadar(region, want, step);
        } catch (e) {
          this._radarFrames = null; this._radarKey = null;
          body.innerHTML = '<div class="wx-load">雷达数据获取失败：' + esc(e.message) + '</div>';
          return;
        }
        this._radarFrames = frames; this._radarKey = key;
      }
      if (!frames.length) {
        this._radarFrames = null; this._radarKey = null;
        body.innerHTML = '<div class="wx-load">暂时取不到雷达回波（中国气象局该时段没有发布，或本机网络不通）</div>';
        return;
      }

      renderPlayer(body, sub, frames, label, {
        segs: [
          { regions: jumpBtns, region: activeJump, act: 'jump' },
          { regions: W.RADAR_REGIONS.map(r => [r.k, r.n]), region: region, act: 'reg' },
          { regions: provs.map(p => [p, p.replace(/省|市|自治区|回族|维吾尔|壮族|特别行政区/g, '')]), region: prov, act: 'prov' },
          { regions: cityBtns, region: cityId, act: 'city' }
        ],
        onSeg: (act, k) => {
          if (act === 'jump') {
            const c = API.Cities.get(k === '@loc' ? locSt : curSt);
            if (c) WXUI.openRadar(W.regionFor(c), c.prov, c.id);
          } else if (act === 'reg') WXUI.openRadar(k, null, null);
          else if (act === 'prov') WXUI.openRadar(region, k, null);
          else WXUI.openRadar(region, prov, k);
        }
      });
    },

    /** 卫星云图：FY-4B 真彩（WXBL）/ 风云二号红外（WXCL）两种产品可切。默认真彩 —— 更好看也更好认 */
    _satKind: 'rgb',
    async openSat(kind) {
      kind = kind || this._satKind || 'rgb';
      this._satKind = kind;
      const body = $('#wxSatBody'), sub = $('#wxSatSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在探测最近的卫星云图…</div>';
      let frames;
      try {
        frames = await W.probeSat(12, (got, total) => { if (sub) sub.textContent = '已找到 ' + got + ' 帧'; }, kind);
      } catch (e) { body.innerHTML = '<div class="wx-load">云图获取失败：' + esc(e.message) + '</div>'; return; }
      if (!frames.length) { body.innerHTML = '<div class="wx-load">暂时取不到卫星云图</div>'; return; }
      renderPlayer(body, sub, frames, kind === 'rgb' ? '卫星云图 · FY-4B 真彩' : '卫星云图 · 风云二号红外', {
        regions: [['rgb', '真彩云图'], ['ir', '红外云图']], region: kind,
        onRegion: k => WXUI.openSat(k)
      });
    },

    /* ── 降水：最近 1 小时实况 / 全国降水量预报图（7 档时效）。默认实况 —— 更新更勤 ──
       预报时效那 7 档不是"我们造的"：中央气象台的产品代号**恒为 ER24**，
       时效藏在时次戳末尾 5 位（`zfill(3) + '00'`），所以同一套 URL 模板换个后缀就有 24~168 小时。 */
    _precipKind: 'now',
    _precipWin: 24,
    async openPrecip(kind, win) {
      kind = kind || this._precipKind || 'now';
      win = win || this._precipWin || 24;
      this._precipKind = kind;
      this._precipWin = win;
      const body = $('#wxPrecipBody'), sub = $('#wxPrecipSub');
      if (!body) return;
      const nowKind = kind === 'now';
      body.innerHTML = '<div class="wx-load">' + (nowKind
        ? '正在探测最近 1 小时降水实况…'
        : '正在探测未来 ' + win + ' 小时的降水预报图…') + '</div>';
      let frames;
      const n = nowKind ? 8 : 6;
      try {
        frames = await W.probePrecip(n, got => { if (sub) sub.textContent = '已找到 ' + got + ' 张'; }, kind, win);
      } catch (e) { body.innerHTML = '<div class="wx-load">降水数据获取失败：' + esc(e.message) + '</div>'; return; }
      if (!frames.length) { body.innerHTML = '<div class="wx-load">暂时取不到降水图</div>'; return; }
      renderPlayer(body, sub, frames,
        nowKind ? '全国 1 小时降水实况' : '全国降水量预报图（未来 ' + win + ' 小时）', {
        segs: [
          { regions: [['now', '最近 1 小时实况'], ['fcst', '预报图']], region: kind, act: 'kind' },
          // 实况档下不显示时效行 —— 实况没有"预报时效"这回事
          nowKind ? null : {
            regions: W.PRECIP_WINS.map(h => [String(h), h + ' 小时']), region: String(win), act: 'win'
          }
        ].filter(Boolean),
        onSeg: (act, reg) => {
          if (act === 'kind') WXUI.openPrecip(reg, reg === 'fcst' ? WXUI._precipWin : undefined);
          else WXUI.openPrecip('fcst', +reg);
        }
      });
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

    /* ── 预警 ──
       全国同时有几百条生效中的预警，倒序拉下来一万年也翻不到跟自己有关的那条。
       所以按**离当前所在地的距离**排序，最近的排最前，并在每条的时间后面标出距离。
       气象局的 warning 接口本身就带经纬度（weather.js 的 warnings() 已经取成 lat/lon），
       所以这只是换个排序，不需要额外请求。 */
    async openWarn() {
      const body = $('#wxWarnBody'), sub = $('#wxWarnSub');
      if (!body) return;
      body.innerHTML = '<div class="wx-load">正在拉取预警信号…</div>';
      let ws;
      try { ws = await W.warnings(); }
      catch (e) { body.innerHTML = '<div class="wx-load">预警数据获取失败：' + esc(e.message) + '</div>'; return; }

      const app = window.__APP;
      const c = (app && app.S && app.S.cur) || null;
      const hasLL = !!(c && isFinite(c.lat) && isFinite(c.lon));
      if (hasLL) {
        ws.forEach(w => {
          w.d = (isFinite(w.lat) && isFinite(w.lon)) ? qkDist(c.lat, c.lon, w.lat, w.lon) : Infinity;
        });
        ws.sort((x, y) => x.d - y.d);
      }

      if (sub) {
        const n = ws.length;
        if (!n) sub.textContent = '';
        else if (!hasLL) sub.textContent = '全国生效中 ' + n + ' 条';
        else {
          const near = ws.find(w => isFinite(w.d));
          sub.textContent = '全国生效中 ' + n + ' 条 · 按离 ' + (c.name || '当前城市') + ' 的距离排序'
            + (near ? '（最近 ' + Math.round(near.d) + ' 公里）' : '');
        }
      }
      if (!ws.length) { body.innerHTML = '<div class="wx-load">当前全国没有生效中的预警信号</div>'; return; }
      body.innerHTML = '<div class="wx-warn">' + ws.map(w => {
        const col = warnColor(w.title);
        const d = (w.d != null && isFinite(w.d)) ? Math.round(w.d) : null;
        return '<div class="wx-warn-item" style="border-left-color:' + col + '">' +
          '<div class="wx-warn-t"><span class="wx-warn-tag" style="background:' + col + '">' +
          esc(shortWarn(w.title)) + '</span>' + esc(w.title) + '</div>' +
          '<div class="wx-warn-time">' + esc(w.time) +
          (d == null ? '' : '<span class="wx-warn-d">' + d + ' 公里</span>') + '</div>' +
          '<div class="wx-warn-x">' + esc(w.text) + '</div></div>';
      }).join('') + '</div>';
    },

    /* ── 预警滚动条 ──
       用户问："炒股网站上是不是有时候会有滚动的提示条？那当前所在地最新的预警信号能不能像这样做一个滚动？"
       炒股软件那条滚的是公告，这里滚的是**当前正在看的那个城市**的预警。

       三次改动的结论（越靠后越新）：

       1. 一开始滚的是"离当前所在地 R 公里以内的预警"，还带距离。问题是半径法会把隔壁市的
          预警一起卷进来 —— 用户要的是"这个区市的"，不是"附近一片的"。
       2. 改成按**地名筛标题**：气象局的预警标题自己就点了地名（「广东省韶关市发布森林火险
          黄色预警信号」），所以拿地名去标题里找就够了，不用猜坐标半径，也不用额外请求。
          但那时候筛的是**定位所在**的区市。
       3. 现在筛的是**当前查看的**区市（`S.cur`）：换了自选里的哪一座，条子就跟着换。
          以前按定位筛，人切到北京看行情，条子还停在"我家门口"的那座城市，
          跟上面那块行情头说的根本不是同一个地方。

       一个刻意的取舍：**这个区市一条都没有就整条收起来**，不留"暂无预警"占位 ——
       横在行情头下面的条子宁可不出现，也不要变成一行常驻的废话。

       动画走 CSS（`translateX(0 → -50%)`），内容**铺两遍**，滚过一半正好接上开头，所以看不出接缝；
       只有内容确实比可视区宽才铺第二遍（否则静态摆着更清楚，不至于看见同一条并排出现两次）；
       跑的时长按内容实际宽度算（`TICK_PPS` 像素/秒），内容长短不影响观感速度。 */
    _tk: { MAX: 10, PPS: 26, PERIOD: 300000 },
    _tkTimer: 0,
    _tkSig: '',
    _tkSeq: 0,

    async tickerRefresh() {
      const bar = $('#warnTicker'), run = $('#tickerRun'), tag = $('#tickerTag');
      if (!bar || !run) return;
      const app = global.__APP;
      const S = (app && app.S) || null;
      const cur = (S && S.cur) || null;

      // 每次刷新领一个号：网络回来得晚的那一趟如果发现自己已经过期，就什么都别动。
      // 切城市切得快的时候，先发的那一趟完全可能后回来，把新城市刚画好的结果盖掉 ——
      // 表现就是"快速切城市时条子显示不出来"。
      const token = ++this._tkSeq;
      // 收起来的**同时把签名清掉**：签名留着的话，下次切回同一座城市会算出同样的
      // 签名 → 走到"数据没变"那条提前 return → 可见性再也补不回来，条子永远藏着。
      const hide = () => { bar.hidden = true; this._tkSig = ''; };

      // 滚的是**当前正在看的那个城市**的预警（不是定位所在的城市）：
      // 自选里换了哪一座，条子就跟着换。以前按定位筛，人切到别的城市看行情时，
      // 条子还停在"我家门口"，和上面那块行情头说的不是同一个地方。
      const keys = [];
      if (cur && cur.name) {
        keys.push(cur.name);
        // 在看的是「区 / 定位到的那一块」时把上级市也带上：区一级常常没有自己的预警，
        // 气象局的标题写的是「广东省广州市发布…」。地级市自己不带上（会串到隔壁）。
        if ((cur.loc || cur.lev === 3) && cur.city && cur.city !== cur.name) keys.push(cur.city);
      }
      if (!keys.length) { hide(); return; }

      let ws;
      try { ws = await W.warnings(); }
      catch (e) { ws = null; }
      if (token !== this._tkSeq) return;          // 这一趟过期了，交给后来那趟
      if (!ws || !ws.length) { hide(); return; }

      // 气象局的预警标题自己就点了地名：「广东省韶关市发布森林火险黄色预警信号」
      // 「广东省广州市天河区发布暴雨橙色预警信号」—— 所以按地名把标题筛一遍就是"这个区市的预警"，
      // 不需要额外请求，也不用猜坐标半径（半径法会把隔壁市的预警一起卷进来）。
      const hit = ws.filter(w => {
        const t = w.title || '';
        return keys.some(k => k && k.length >= 2 && t.indexOf(k) >= 0);
      });
      // 这个区市一条都没有 —— 整条收起来（用户选的行为），不留"暂无预警"占位。
      if (!hit.length) { hide(); return; }

      // 在看区一级时，点名了那个区的那条更贴近"我家门口"，排前面；同级按发布时间新的在前。
      const deep = (cur && (cur.loc || cur.lev === 3)) ? cur.name : '';
      const spec = w => (deep && (w.title || '').indexOf(deep) >= 0) ? 0 : 1;
      hit.sort((a, b) => (spec(a) - spec(b)) || String(b.time || '').localeCompare(String(a.time || '')));
      const list = hit.slice(0, this._tk.MAX);

      // 数据没变就别重画 —— 重画会把动画打回开头，看着像一直在闪。
      const sig = keys.join(',') + '|' + ((cur && cur.name) || '') + '|' + hit.length + '|' + list.map(w => w.title).join('~');
      if (sig === this._tkSig) {
        // 但**可见性要补上**：上一次可能是被"这个城市没预警"收起来的，
        // 只比签名就 return 的话，条子永远回不来。
        bar.hidden = false;
        return;
      }
      this._tkSig = sig;

      const txt = w => {
        // 同一座城市的预警，距离没有信息量（都在你家附近），改成显示发布时间。
        const d = shortWarnTime(w.time);
        const col = warnColor(w.title), t = w.title || '气象预警';
        return '<span class="ticker-it" title="' + esc(t) + '">' +
          '<b style="color:' + col + '">【' + esc(shortWarn(t)) + '】</b>' +
          esc(t) + (d ? '<i> · ' + esc(d) + '</i>' : '') + '</span>';
      };
      const once = list.map(txt).join('');
      const view = run.parentNode;
      if (tag) tag.textContent = '⚠ ' + ((cur && cur.name) || '') + '预警';
      // ⚠ 量宽度之前**必须先让它可见**：条子收起来的时候是 `display:none`，
      //   这时 `scrollWidth` / `clientWidth` 全是 0，下面那条"内容比可视区宽才滚"
      //   的判据永远不成立 → 长预警被 24px 的高度切掉半截，看着就是"文字显示不完全"。
      bar.hidden = false;
      // 先铺一遍量宽度：够宽才需要"铺两遍 + 自己往左推"那套无缝滚动，
      // 否则静态摆着更清楚 —— 而且不滚的时候铺两遍会让人看见同一条预警并排出现两次。
      run.innerHTML = once;
      void run.offsetWidth;
      const half = run.scrollWidth;
      const over = half > (view ? view.clientWidth : 0) + 4;
      if (over) run.innerHTML = once + once;
      if (view) view.scrollLeft = 0;
      this._tkHalf = over ? half : 0;
      this.tickerRun();
    },

    /* 预警条"自己往左走" + 让人随时接管。
       走的是 `.ticker-view` 的 scrollLeft（不是 CSS transform）：内容在普通流里，
       所以手指一划 / 滚轮一滚随时能拖，接管期间自动走让位，松手几秒后接着走。
       铺了两遍内容，推过半截就绕回开头，接缝看不出来。
       `_tkHalf === 0`（内容放得下）就完全不动。 */
    _tkHalf: 0,
    _tkHold: 0,
    _tkRaf: 0,
    _tkLast: 0,
    _tkDown: 0,

    // 单独拎出来是为了能在探针里直接喂 dt 验"推得动、会绕回"
    tickAdvance(dt) {
      const view = $('#tickerView');
      if (!view || !this._tkHalf) return 0;
      if (Date.now() < this._tkHold) return view.scrollLeft;
      let x = view.scrollLeft + this._tk.PPS * dt;
      if (x >= this._tkHalf) x -= this._tkHalf;
      view.scrollLeft = x;
      return x;
    },
    tickHold(ms) { this._tkHold = Date.now() + (ms == null ? 4000 : ms); },
    tickStop() {
      if (this._tkRaf) { global.cancelAnimationFrame(this._tkRaf); this._tkRaf = 0; }
    },
    tickerRun() {
      this.tickStop();
      if (!this._tkHalf) return;
      // 系统里开了"减少动态效果"就别自己走 —— 但内容还在普通流里，手指照样能拖。
      if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      this._tkLast = 0;
      const step = ts => {
        this._tkRaf = global.requestAnimationFrame(step);
        if (!this._tkLast) { this._tkLast = ts; return; }
        // 标签页切回来时 ts 会跳一大截，夹一下免得一下冲过头
        const dt = Math.min(0.1, (ts - this._tkLast) / 1000);
        this._tkLast = ts;
        this.tickAdvance(dt);
      };
      this._tkRaf = global.requestAnimationFrame(step);
    },

    /* 定时刷新 + 点整条打开预警面板。
       ⚠ 这里只挂一次定时器：init() 可能被调用多次（比如深链重进），
       每次都 setTimeout 的话会有好几个定时器一起跑，切城市时同时重算。 */
    tickerInit() {
      const bar = $('#warnTicker');
      if (!bar) return;
      const view = $('#tickerView');
      // 点整条打开预警信号面板 —— 但**横向拖动过就不算点**，否则想拖一下看看
      // 后面几条预警，手一松就跳进面板了。
      bar.addEventListener('click', () => {
        if (view && Math.abs(view.scrollLeft - this._tkDown) > 4) return;
        WXUI.open('wxWarn');
      });
      if (view) {
        const hold = ms => this.tickHold(ms);
        // 手指/滚轮一碰就先让位，松手几秒后自己接着走
        view.addEventListener('pointerdown', () => { this._tkDown = view.scrollLeft; hold(6000); }, { passive: true });
        view.addEventListener('touchstart', () => { this._tkDown = view.scrollLeft; hold(6000); }, { passive: true });
        view.addEventListener('wheel', () => hold(6000), { passive: true });
        view.addEventListener('pointerup', () => hold(2500), { passive: true });
        view.addEventListener('touchend', () => hold(2500), { passive: true });
        // 鼠标悬停时别自己走（跟以前 `animation-play-state:paused` 一个意思）
        view.addEventListener('mouseenter', () => hold(1e9), { passive: true });
        view.addEventListener('mouseleave', () => hold(1200), { passive: true });
      }
      this.tickerRefresh();
      if (this._tkTimer) return;
      this._tkTimer = setInterval(() => WXUI.tickerRefresh(), this._tk.PERIOD);
    },

    /* ── 地震 ──
       数据源是 USGS（免 key、CORS 全开）。为什么不用中国地震台网：www.ceic.ac.cn
       响应是 200 但**不带 CORS 头**，浏览器里直连读不到。
       为什么按"离当前城市的距离"排：全国一年几千次地震，不筛距离就是一堆与你无关的列表。
       半径 700 公里、震级 3.0 以上、最近 130 天 —— 与游戏里用的是同一套口径。 */
    _qk: { R: 700, D: 130 },
    async openQuake() {
      const body = $('#wxQuakeBody'), sub = $('#wxQuakeSub');
      if (!body) return;
      // ⚠ 是 window.__APP 不是 window.APP —— 全局只有带双下划线那一个，
      // 写成 APP 的话这里恒为 null，面板永远显示"先选一个城市"。
      const app = window.__APP;
      const c = (app && app.S && app.S.cur) || null;
      body.innerHTML = '<div class="wx-load">正在拉取地震目录…</div>';
      if (!c || c.lat == null) {
        body.innerHTML = '<div class="wx-load">先选一个城市，地震按离它的距离筛。</div>';
        return;
      }
      let list;
      try { list = await API.OpenMeteo.quakes(c.lat, c.lon, this._qk.R, this._qk.D); }
      catch (e) { body.innerHTML = '<div class="wx-load">地震目录获取失败：' + esc(e.message) + '</div>'; return; }
      if (!list.length) {
        if (sub) sub.textContent = '最近 ' + this._qk.D + ' 天 · ' + this._qk.R + ' 公里内';
        body.innerHTML = '<div class="wx-load">最近 ' + this._qk.D + ' 天、' + this._qk.R +
          ' 公里内没有 M3.0 以上的地震 —— 这是好事。</div>';
        return;
      }
      // 算到当前城市的真实大圆距离，顺便记住最近的那次
      const rows = list.map(q => {
        const d = (q.lat != null && isFinite(q.lat)) ? qkDist(c.lat, c.lon, q.lat, q.lon) : null;
        return { q: q, d: d };
      });
      const near = rows.filter(r => r.d != null).sort((a, b) => a.d - b.d)[0];
      if (sub) sub.textContent = '最近 ' + this._qk.D + ' 天 · ' + this._qk.R + ' 公里内 ' + rows.length +
        ' 次' + (near ? ' · 最近一次 ' + Math.round(near.d) + ' 公里' : '');
      // 近的排前面：同一次地震对"当地"的意义就是这个距离
      rows.sort((a, b) => (a.d == null ? 1e9 : a.d) - (b.d == null ? 1e9 : b.d));
      body.innerHTML = '<div class="wx-quake">' + rows.map(r => {
        const q = r.q, mag = (q.mag == null ? '—' : q.mag.toFixed(1));
        const col = qkColor(q.mag);
        const t = q.t ? new Date(q.t) : null;
        const ts = t ? (t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
          ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes())) : '';
        return '<div class="wx-qk-item" style="border-left-color:' + col + '">' +
          '<div class="wx-qk-top"><span class="wx-qk-mag" style="background:' + col + '">M' + mag + '</span>' +
          '<span class="wx-qk-place">' + esc(q.place || '（无地点描述）') + '</span>' +
          (r.d != null ? '<span class="wx-qk-d">' + Math.round(r.d) + ' km</span>' : '') + '</div>' +
          '<div class="wx-qk-meta">' + esc(ts) +
          (q.depth != null && isFinite(q.depth) ? ' · 深 ' + Math.round(q.depth) + ' km' : '') +
          '</div></div>';
      }).join('') + '</div>';
    },

    /* ── 天文 ──
       四页：观星 / 极光 / 日月 / 流星雨。
       只有极光那页要打 NOAA SWPC（免 key、CORS 全开），其余三页全靠 astro.js
       在本地推算 —— 打开就是瞬时的，也不占任何接口额度。 */
    _as: { page: 'star' },
    openAstro(page) {
      const body = $('#wxAstroBody'), sub = $('#wxAstroSub');
      if (!body) return;
      if (page) this._as.page = page;
      const app = window.__APP;
      const c = (app && app.S && app.S.cur) || null;
      const d = (app && app.S && app.S.data) || null;
      const me = this;
      const PAGES = [['star', '✨ 观星'], ['aurora', '🌌 极光'], ['moon', '🌗 日月'], ['meteor', '☄️ 流星雨']];
      body.innerHTML =
        '<div class="wx-seg">' + PAGES.map(p =>
          '<button class="wx-segbtn' + (p[0] === this._as.page ? ' on' : '') +
          '" data-asp="' + p[0] + '">' + p[1] + '</button>').join('') + '</div>' +
        '<div class="wx-as" id="wxAsPane"></div>';
      body.querySelectorAll('[data-asp]').forEach(b => b.addEventListener('click', () => me.openAstro(b.dataset.asp)));
      const pane = body.querySelector('#wxAsPane');
      if (!c || c.lat == null || c.lon == null) {
        if (sub) sub.textContent = '';
        pane.innerHTML = '<div class="wx-load">先选一个城市 —— 天文这几样都得知道当地的经纬度。</div>';
        return;
      }
      const now = Date.now();
      if (this._as.page === 'aurora') { asAurora(pane, sub, c, now); return; }
      if (this._as.page === 'moon') { asMoon(pane, sub, c, now); return; }
      if (this._as.page === 'meteor') { asMeteor(pane, sub, c, now); return; }
      asStar(pane, sub, c, d, now);
    },

    /* 通用开关 */
    open(id) {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
      // 不传参：让 openRadar 自己决定（沿用上次的区域，或按当前城市自动定位到单站）。
      // ⚠ 不要写成 this.openRadar(this._radarReg) —— 首次打开时它是 null，
      // 而 null 不等于 undefined，会把"按城市自动选区"那段整个跳过，
      // 结果拿 region=null 去拼 URL，每一帧都是 ..._ECREF_null_... 全 404。
      if (id === 'wxRadar') this.openRadar();
      if (id === 'wxSat') this.openSat(this._satKind);
      if (id === 'wxPrecip') this.openPrecip(this._precipKind);
      if (id === 'wxTy') this.openTyphoon();
      if (id === 'wxWarn') this.openWarn();
      if (id === 'wxQuake') this.openQuake();
      if (id === 'wxAstro') this.openAstro();
    },
    close(id) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    /* ── 定位 ──
       原来这里有个 locate()：点工具栏的「📍 我附近」，在本地城市表里找最近的一座。
       已经删掉了 —— 定位在城市列表那一行「📍 定位当前位置」里（app.js 的 renderGeo），
       而且应用启动时只要已经授权过就会静默定位到 LOC_ID，工具栏再放一个入口是冗余的。
       那个方法本身也是重复实现：最近城市的算法 app.js 里有一份（nearestCity + haversine）。 */

    init() {
      // 顶栏功能按钮
      document.querySelectorAll('[data-wx]').forEach(b => {
        b.addEventListener('click', () => WXUI.open(b.dataset.wx));
      });
      // 点遮罩或 ✕ 关闭；点面板内部不关。
      //
      // ⚠ 这里必须是**捕获阶段**（第三个参数 true）。原因：面板里有些按钮在自己的
      // handler 里会把 body.innerHTML 整个重画（雷达/云图的地区切换 .wx-segbtn、
      // 台风列表 .wx-tyitem）。如果这个判断放在冒泡阶段，等事件冒泡到抽屉时
      // e.target 已经脱离文档，closest('.drawer-panel') 返回 null，于是被误判成
      // "点了面板外面" —— 表现就是"切换项目时弹出的小窗口自己关掉了"。
      // 捕获阶段在目标自己的 handler 之前跑，DOM 还没被改，判断才准。
      document.querySelectorAll('.wx-drawer').forEach(d => {
        d.addEventListener('click', e => {
          const t = e.target;
          if (!t || !t.closest) return;
          if (t.closest('[data-close]') || !t.closest('.drawer-panel')) WXUI.close(d.id);
        }, true);
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') document.querySelectorAll('.wx-drawer').forEach(d => { d.hidden = true; });
      });
      // 横向可滚的行（雷达/云图的 大区 → 省 → 市）挂"滚轮转横向"。
      //
      // 为什么需要：这些行是 overflow-x:auto，但**鼠标滚轮默认只滚垂直方向**，
      // 滚动条又被 CSS 收窄成一条细线，结果在桌面端看起来就是"这一行滚不动"。
      // 用事件委托绑在 document 上（这些行是 innerHTML 重画出来的，绑不到具体元素）。
      document.addEventListener('wheel', e => {
        const t = e.target;
        if (!t || !t.closest) return;
        const seg = t.closest('.wx-seg');
        if (!seg) return;
        if (seg.scrollWidth <= seg.clientWidth + 1) return;   // 没得滚就别抢事件
        const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (!d) return;
        const before = seg.scrollLeft;
        seg.scrollLeft = before + d;
        if (seg.scrollLeft !== before) e.preventDefault();     // 滚到头就把事件还给页面
      }, { passive: false });
      // （工具栏那颗「📍 我附近」按钮和它的 WXUI.locate() 已经删掉，见上面"定位"那段注释。）
      // 预警滚动条：拉一次 + 挂 5 分钟定时器（tickerInit 内部防重入）
      WXUI.tickerInit();
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
  /** 「2026年10月05日16时23分」→「10-05 16:23」。气象局的时间戳是中文写法，
   *  滚动条里那一格塞不下原文。认不出来就返回空串，宁可少显示也不写错。 */
  function shortWarnTime(s) {
    const m = String(s || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日(\d{1,2})时(\d{1,2})分/);
    if (!m) return '';
    const p = n => (n < 10 ? '0' + n : '' + n);
    return p(+m[2]) + '-' + p(+m[3]) + ' ' + p(+m[4]) + ':' + p(+m[5]);
  }

  /* ── 地震面板用的小工具 ──
     ⚠ pad2 不要在这里再定义一次 —— 文件顶部（wxui.js:16）已经有一个
     `const pad2 = n => ...`，重复声明会让整个 IIFE 抛
     `SyntaxError: Identifier 'pad2' has already been declared`，
     WXUI 直接挂不上（报错只在 window.__errs 里能看见）。 */
  /** 两点间大圆距离（公里）。和 game.js 里的 distKm 同一套算法，
   *  但不共用 —— wxui 是主站天气页的模块，不该为了一个函数去依赖游戏模块。 */
  function qkDist(la1, lo1, la2, lo2) {
    const R = 6371, rad = Math.PI / 180;
    const dla = (la2 - la1) * rad, dlo = (lo2 - lo1) * rad;
    const a = Math.sin(dla / 2) * Math.sin(dla / 2) +
      Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  /** 震级配色：跟预警信号一个思路 —— 越严重越红。 */
  function qkColor(m) {
    if (m == null) return '#7f8c9a';
    if (m >= 6.0) return '#e74c3c';
    if (m >= 5.0) return '#e67e22';
    if (m >= 4.0) return '#f0c419';
    return '#3498db';
  }

  /* ───────── 天文面板：四个子页的排版 ─────────
     壳在 WXUI.openAstro() 里（分段控件 + 分发），这里只管把每一页画出来。
     数据来源：经纬度取当前城市；逐小时取 S.data.hourly（**异步补的，可能还没到**）；
     Kp / 太阳黑子打 NOAA SWPC；其余全部由 astro.js 在本地推算。 */

  /** 毫秒 → HH:MM */
  function asHM(t) {
    const d = (t instanceof Date) ? t : new Date(t);
    return isNaN(d.getTime()) ? '--' : pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /** 时长 → "3 小时 20 分" */
  function asDur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 60 ? (m + ' 分') : (Math.floor(m / 60) + ' 小时 ' + pad2(m % 60) + ' 分');
  }
  /** 逐小时平行数组里落在 [t0,t1] 的整点（连下标一起带出来），最多 cap 个。
   *  下标必须带 —— cloud/precip/humidity/wind 是跟 time 同长的**平行数组**。 */
  function asHours(h, t0, t1, cap) {
    const out = [];
    if (!h || !h.time) return out;
    for (let i = 0; i < h.time.length; i++) {
      const t = Date.parse(String(h.time[i]).replace(' ', 'T'));
      if (!isFinite(t) || t < t0 || t > t1) continue;
      out.push({ t: t, i: i });
      if (cap && out.length >= cap) break;
    }
    return out;
  }
  function asBar(pct, color) {
    return '<i class="wx-as-bar"><b style="width:' +
      Math.max(2, Math.min(100, Math.round(pct))) + '%;background:' + color + '"></b></i>';
  }

  /* ── ① 观星指数 ── */
  function asStar(pane, sub, c, d, now) {
    const A = global.ASTRO;
    if (!A) { pane.innerHTML = '<div class="wx-load">astro.js 没加载出来</div>'; return; }
    const mp = A.moonPhase(now);
    const night = A.nextNight(now, c.lat, c.lon);
    const from = night ? Math.max(night.from, now - 3600000) : now;
    const to = night ? night.to : now + 6 * 3600000;
    const h = d && d.hourly;
    const hrs = asHours(h, from, to, 14);

    const rows = hrs.map(x => ({
      t: x.t,
      cloud: (h && h.cloud) ? h.cloud[x.i] : null,
      sc: A.starScore({
        cloud: (h && h.cloud) ? h.cloud[x.i] : null,
        precip: (h && h.precip) ? h.precip[x.i] : null,
        humidity: (h && h.humidity) ? h.humidity[x.i] : null,
        wind: (h && h.wind) ? h.wind[x.i] : null,
        moonUp: A.moonAlt(x.t, c.lat, c.lon) > 0,
        moonIllum: mp.illum
      })
    }));
    const best = rows.slice().sort((p, q) => q.sc.score - p.sc.score)[0] || null;

    if (sub) {
      sub.textContent = (night ? '天文夜 ' + asHM(night.from) + '→' + asHM(night.to) + '（' + asDur(night.to - night.from) + '）'
        : '今夜没有真正的天黑') + ' · ' + mp.emoji + ' ' + mp.name + ' ' + Math.round(mp.illum * 100) + '%';
    }

    let html = '';
    if (best) {
      html += '<div class="wx-as-lead">' +
        '<span class="wx-as-big" style="color:' + best.sc.color + '">' + best.sc.score + '</span>' +
        '<span class="wx-as-leadlab"><b>' + best.sc.label + '</b><br>' + asHM(best.t) + ' 前后最合适</span></div>';
      if (best.sc.why.length) html += '<div class="wx-as-note">' + esc(best.sc.why.join(' · ')) + '</div>';
    }
    html += '<div class="wx-as-h2">' + (night ? '今晚逐小时' : '接下来几小时') + '</div>';
    if (!rows.length) {
      html += '<div class="wx-load">逐小时数据还没到 —— 它跟副图一起异步加载，' +
        '过一会儿再点开这一页就有逐小时评分了。</div>';
    } else {
      html += '<div class="wx-as-list">' + rows.map(r =>
        '<div class="wx-as-row">' + '<b>' + asHM(r.t) + '</b>' + asBar(r.sc.score, r.sc.color) +
        '<span style="color:' + r.sc.color + '">' + r.sc.score + ' ' + r.sc.label + '</span>' +
        '<em>云 ' + (r.cloud == null ? '--' : Math.round(r.cloud) + '%') + '</em></div>').join('') + '</div>';
    }
    html += '<div class="wx-as-foot">评分口径：云量 55 分 · 降水 20 · 湿度 10 · 风 10 · 月光 5。' +
      '「天文夜」是太阳低于 -6°、天真正黑透的那一段。逐小时气象数据来自 Open-Meteo，' +
      '月相与月光遮挡在本地推算。</div>';
    pane.innerHTML = html;
  }

  /* ── ② 极光 / 地磁 ── */
  function asAurora(pane, sub, c, now) {
    const A = global.ASTRO;
    const SW = global.API && global.API.SWPC;
    if (sub) sub.textContent = 'NOAA 空间天气';
    if (!A || !SW) { pane.innerHTML = '<div class="wx-load">数据层没就绪（ASTRO / API.SWPC）</div>'; return; }
    pane.innerHTML = '<div class="wx-load">正在取 NOAA 的 Kp 指数…</div>';
    Promise.all([
      SW.kpNow().catch(() => null),
      SW.kpSeries().catch(() => []),
      SW.sunspots().catch(() => null)
    ]).then(res => {
      const cur = res[0], series = res[1], ssn = res[2];
      const need = A.auroraNeedKp(c.lat);
      const sc = A.kpScale(cur ? cur.kp : null);
      const fut = series.filter(x => x.t.getTime() > now);
      const peak = fut.reduce((m, x) => (x.kp > m.kp ? x : m), { kp: -1, t: null });
      const pk = A.kpScale(peak.kp >= 0 ? peak.kp : null);
      const latTxt = Math.abs(c.lat).toFixed(1) + '°' + (c.lat >= 0 ? 'N' : 'S');

      let html = '<div class="wx-as-lead">' +
        '<span class="wx-as-big" style="color:' + sc.color + '">' +
        (cur && cur.kp != null ? cur.kp.toFixed(1) : '--') + '</span>' +
        '<span class="wx-as-leadlab"><b>Kp ' + (sc.g ? sc.g + ' · ' : '') + sc.text + '</b><br>' +
        (cur ? asHM(cur.t) + ' 实测' : '取不到实时值') + '</span></div>';

      if (fut.length) {
        html += '<div class="wx-as-h2">未来 3 天（每 3 小时一档）</div><div class="wx-as-kp">' +
          fut.slice(0, 24).map(x => {
            const s2 = A.kpScale(x.kp);
            return '<i title="' + esc(asHM(x.t) + '  Kp ' + x.kp.toFixed(1) + '  ' + s2.text) +
              '" style="height:' + Math.max(3, Math.round(x.kp / 9 * 100)) + '%;background:' + s2.color +
              (x.kind === 'predicted' ? ';opacity:.5' : '') + '"></i>';
          }).join('') + '</div>' +
          '<div class="wx-as-axis"><span>现在</span><span>+1 天</span><span>+2 天</span><span>+3 天</span></div>' +
          '<div class="wx-as-note">未来三天峰值 <b>Kp ' + (peak.kp >= 0 ? peak.kp.toFixed(1) : '--') + '</b>' +
          '（' + pk.text + '）· 不透明＝实测/估计，半透明＝预报</div>';
      }

      html += '<div class="wx-as-h2">在你这个纬度看得到吗</div>';
      if (need > 9) {
        html += '<div class="wx-as-note">你现在看的是 <b>' + esc(c.name) + '（' + latTxt + '）</b>，' +
          '按经验口径<b>即使 Kp 满格（9）也基本看不到极光</b>。要看得往北：' +
          '漠河（53°N）约需 Kp ≥ 7、新疆北部（48°N）≥ 8、华北（44°N）≥ 9。</div>';
      } else {
        const ok = (peak.kp >= need) || !!(cur && cur.kp >= need);
        html += '<div class="wx-as-note">你现在看的是 <b>' + esc(c.name) + '（' + latTxt + '）</b>，' +
          '这一纬度大约需要 <b>Kp ≥ ' + need + '</b>。当前 ' + (cur && cur.kp != null ? cur.kp.toFixed(1) : '--') +
          '、未来三天峰值 ' + (peak.kp >= 0 ? peak.kp.toFixed(1) : '--') + ' → <b>' +
          (ok ? '有机会，往北走、避开城市灯光' : '暂时没戏') + '</b>。</div>';
      }
      html += '<div class="wx-as-foot">' +
        (ssn && ssn.ssn != null
          ? '太阳黑子数（' + esc(ssn.month) + ' 月均）<b>' + ssn.ssn.toFixed(1) + '</b> —— ' +
            '黑子多说明太阳活动强，地磁暴和极光也更容易出现。<br>'
          : '') +
        '数据来源：NOAA SWPC（免 key、CORS 全开）。Kp 是三小时一档的地磁活动指数，' +
        '5 以上算地磁暴，也就是 NOAA 的 G1～G5。</div>';
      pane.innerHTML = html;
    }).catch(e => {
      pane.innerHTML = '<div class="wx-load">NOAA 没取到：' + esc(String((e && e.message) || e)) + '</div>';
    });
  }

  /* ── ③ 日月（今天的事件表） ── */
  function asMoon(pane, sub, c, now) {
    const A = global.ASTRO;
    if (!A) { pane.innerHTML = '<div class="wx-load">astro.js 没加载出来</div>'; return; }
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const day0 = t0.getTime(), day1 = day0 + 86400000;
    const se = A.sunEvents(day0, day1, c.lat, c.lon);
    const me = A.moonEvents(day0 - 6 * 3600000, day1 + 6 * 3600000, c.lat, c.lon);
    const mp = A.moonPhase(now);
    if (sub) sub.textContent = '今天 · ' + mp.emoji + ' ' + mp.name + ' ' + Math.round(mp.illum * 100) + '%';

    const ev = (arr, kind) => arr.filter(x => x.kind === kind)[0] || null;
    const at = (arr, kind) => { const e = ev(arr, kind); return e ? e.t : null; };
    // 每一条都是"从一个时刻到另一个时刻"的时段；缺一头就显示 --。
    const WIN = [
      ['日出 → 日落', at(se, 'sunrise'), at(se, 'sunset')],
      ['清晨黄金时刻', at(se, 'blue-end'), at(se, 'golden-end')],
      ['清晨蓝调时刻', at(se, 'dawn'), at(se, 'blue-end')],
      ['傍晚黄金时刻', at(se, 'golden'), at(se, 'blue')],
      ['傍晚蓝调时刻', at(se, 'blue'), at(se, 'dark')],
      ['天全黑（天文夜）', at(se, 'dark'), at(se, 'dawn')],
      ['月出 → 月落', at(me, 'moonrise'), at(me, 'moonset')]
    ];
    let html = '<div class="wx-as-lead">' +
      '<span class="wx-as-big">' + mp.emoji + '</span>' +
      '<span class="wx-as-leadlab"><b>' + mp.name + ' · 照亮 ' + Math.round(mp.illum * 100) + '%</b><br>' +
      '月龄 ' + mp.age.toFixed(1) + ' 天（朔望月 ' + A.SYNODIC.toFixed(2) + ' 天）</span></div>';
    html += '<div class="wx-as-h2">' + esc(c.name) + ' · 今天</div><div class="wx-as-list">' +
      WIN.map(w => {
        // ⚠「天黑 → 天亮」是**跨午夜**的，w[2] < w[1]，直接相减会得到负数被夹成 0 分。
        const dur = (w[1] && w[2]) ? (w[2] > w[1] ? w[2] - w[1] : w[2] - w[1] + 86400000) : null;
        return '<div class="wx-as-row2"><b>' + w[0] + '</b><span>' +
          (w[1] ? asHM(w[1]) : '--') + (w[2] ? ' → ' + asHM(w[2]) : '') +
          (dur != null ? '　<i>' + asDur(dur) + '</i>' : '') + '</span></div>';
      }).join('') + '</div>';
    html += '<div class="wx-as-foot">全部在本地推算（astro.js，Meeus 简化式）：' +
      '日出日落 ±1 分钟、月出月落 ±10 分钟。' +
      '黄金时刻＝太阳高度 +6°～-4°；蓝调时刻＝-4°～-6°；天文夜＝低于 -6°。' +
      (mp.illum > 0.7 ? '<br>⚠ 今晚月光很亮，深空天体基本被压住 —— 适合看月面和行星。' : '') +
      '</div>';
    pane.innerHTML = html;
  }

  /* ── ④ 流星雨 ── */
  function asMeteor(pane, sub, c, now) {
    const A = global.ASTRO;
    if (!A) { pane.innerHTML = '<div class="wx-load">astro.js 没加载出来</div>'; return; }
    const list = A.nextShowers(now, 5);
    const mpNow = A.moonPhase(now);
    const first = list[0];
    if (sub) {
      // 正在活动期时 first.days 可能是负的（极大刚过去一两天）—— 那也要说人话，
      // 不能显示"下一场 -2 天后"。
      sub.textContent = !first ? ''
        : (first.days < 0 ? ('正在活动期 · ' + first.s.name + '（极大刚过）')
          : ('下一场 ' + Math.round(first.days) + ' 天后 · ' + first.s.name));
    }
    if (!list.length) { pane.innerHTML = '<div class="wx-load">没有算出来</div>'; return; }
    let html = '<div class="wx-list">' + list.map(x => {
      const s = x.s, mp = A.moonPhase(x.peak);
      const moonPen = mp.illum > 0.7 ? '月光强（照亮 ' + Math.round(mp.illum * 100) + '%），实际数量会大打折扣'
        : mp.illum > 0.4 ? '月光中等（' + Math.round(mp.illum * 100) + '%）'
          : '月光弱（' + Math.round(mp.illum * 100) + '%），条件不错';
      const d = new Date(x.peak);
      const when = x.days < 0 ? ('极大刚过 ' + Math.abs(Math.round(x.days)) + ' 天')
        : x.days < 1 ? '就在今天' : ('还有 ' + Math.round(x.days) + ' 天');
      return '<div class="wx-as-card' + (x.active ? ' on' : '') + '">' +
        '<div class="wx-as-cardhead"><b>' + esc(s.name) + '</b>' +
        (x.active ? '<span class="wx-as-badge">正在活动期</span>' : '') + '</div>' +
        '<div class="wx-as-meta">极大 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' +
        '　·　' + when + '</div>' +
        '<div class="wx-as-meta">ZHR ' + s.zhr + ' 颗/时（常年参考值）　·　辐射点 ' + esc(s.radiant) +
        '　·　母体 ' + esc(s.parent) + '</div>' +
        '<div class="wx-as-meta">活动期 ' + s.from[0] + '/' + s.from[1] + ' ～ ' + s.to[0] + '/' + s.to[1] +
        '　·　极大夜月相 ' + mp.emoji + mp.name + '：' + moonPen + '</div>' +
        '</div>';
    }).join('') + '</div>';
    html += '<div class="wx-as-foot">' +
      '<b>准到什么程度</b>：这张表是<b>离线</b>的 9 场主要流星雨，只有「活动期 / 辐射点 / 母体」是常年不变的；' +
      '「极大」写的是传统的日历日，而 IMO 是用<b>太阳黄经</b>定义极大的，同一个黄经落到日历上会漂 ±1 天；' +
      '「ZHR」是<b>常年参考值而不是今年的预测</b>（象限仪座在 60～200 之间年际起伏，天龙座 2011 年爆到 600+）。' +
      '这一页真正算出来的是<b>极大夜的月光</b>和最佳时段。<br>' +
      '年份是运行时现推的，所以<b>不存在"过完今年就失效"</b>——12/31 打开会直接给出明年 1 月 3 日的象限仪座。' +
      '<br>ZHR 的含义是"辐射点在正头顶、天空全黑"时每小时的理论流星数，' +
      '实际能看到的通常只有它的三分之一到一半。看流星挑后半夜（辐射点最高），避开月光和城市灯光。' +
      '当前月相 ' + mpNow.emoji + mpNow.name + '（照亮 ' + Math.round(mpNow.illum * 100) + '%）。</div>';
    pane.innerHTML = html;
  }

  /* 图片播放器：雷达 / 卫星 / 降水共用。
     opt.segs 可以给多行分段控件（雷达用三行：大区 → 省 → 市）；
     opt.regions 是单行的简写，两者等价。 */
  function renderPlayer(body, sub, frames, title, opt) {
    opt = opt || {};
    let i = 0;
    const rows = opt.segs || (opt.regions ? [{ regions: opt.regions, region: opt.region, act: '' }] : []);
    const segRows = rows.filter(s => s && (s.regions || []).length).map(s =>
      '<div class="wx-seg">' + s.regions.map(r =>
        '<button class="wx-segbtn' + (r[0] === s.region ? ' on' : '') +
        '" data-seg="' + (s.act || '') + '" data-reg="' + esc(r[0]) + '">' + esc(r[1]) + '</button>'
      ).join('') + '</div>'
    ).join('');
    body.innerHTML =
      '<div class="wx-player">' +
        '<div class="wx-pbar">' +
          (segRows ? '<div class="wx-segs">' + segRows + '</div>' : '') +
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

    /* 头部固定显示"这一次在看什么"（哪一站 / 哪一档时效 / 哪片大区）。
       ⚠ 以前 title 只进了 `<img alt>`，而 show() 每帧又把 sub 覆盖成时间戳 ——
       于是调用方精心拼的那句说明（比如「珠海 没有自己的站，用最近的 广州，约 108 km」）
       **用户一个字都看不到**。时间戳本来就有一个专用的 `.wx-pt` 在显示，不必再塞进头部。 */
    if (sub) sub.textContent = title;

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
      const act = b.dataset.seg;
      if (act != null && act !== '' && opt.onSeg) { opt.onSeg(act, b.dataset.reg); return; }
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
        confine: true,
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
