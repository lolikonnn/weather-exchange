/* ═══════════════════════════════════════════════════════════════
   util.js — 通用工具函数
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** 创建元素：el('div', {class:'x', onclick:fn}, [子节点]) */
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(n.dataset, v);
      else n.setAttribute(k, v);
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null || c === false) return;
        n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    }
    return n;
  }

  const pad2 = n => (n < 10 ? '0' : '') + n;

  /** 数字格式化，固定小数位 */
  function fx(v, d) {
    if (v == null || v === '' || isNaN(v)) return '--';
    return Number(v).toFixed(d == null ? 1 : d);
  }

  /** 带正负号 */
  function sgn(v, d) {
    if (v == null || isNaN(v)) return '--';
    const n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(d == null ? 1 : d);
  }

  /** 涨跌颜色 class（配合 body.us 反转） */
  function cls(v) {
    if (v == null || isNaN(v) || Math.abs(v) < 1e-9) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function fmtHM(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  /** '2026-10-05' -> Date（本地零点） */
  function parseDate(s) {
    const p = String(s).slice(0, 10).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  /** 星期几。传进来的**不一定**是完整日期 —— 月K 的键只有 'YYYY-MM'，
   *  这种拼不出星期几。宁可返回空串，也不要吐出 '周undefined' 这种东西。 */
  function weekday(s) {
    const w = '日一二三四五六';
    const d = s instanceof Date ? s : parseDate(s);
    const n = d.getDay();
    return n === n ? '周' + w[n] : '';
  }

  /** ISO 时间串（可能无秒）-> Date */
  function parseISO(s) { return new Date(String(s).replace(' ', 'T')); }

  /** 数组按 key 取值，去除 null */
  function pluck(arr, k) { return arr.map(o => (o == null ? null : o[k])); }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function sum(a) { let s = 0; for (const v of a) s += v || 0; return s; }

  function avg(a) { return a.length ? sum(a) / a.length : 0; }

  function last(a) { return a && a.length ? a[a.length - 1] : null; }

  /** 简易深拷贝（JSON 安全数据） */
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ───────── 本地存储（带命名空间与降级） ───────── */
  const NS = 'tjs.';
  function storeGet(k, dflt) {
    try {
      const v = localStorage.getItem(NS + k);
      return v == null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function storeSet(k, v) {
    try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  /* ───────── 颜色 ───────── */
  /* 持平色也进了色板：`--flat` 现在是绿色（绿色＝平），不再是写死的中性灰。
     ⚠ 以前 trendColor 是直接把常量 FLAT 返回的，**不读 CSS 变量** ——
     所以外面改 `--flat` 它不跟着动（K 线蜡烛会变、自选列表却还是灰的，
     同一屏两种"平盘色"）。现在跟 up/down 一个规矩：先读变量，读不到才用常量兜底。 */
  const UP = '#ff4d4f', DOWN = '#00b578', FLAT = '#00b578';
  function upColor() { return getComputedStyle(document.body).getPropertyValue('--up').trim() || UP; }
  function downColor() { return getComputedStyle(document.body).getPropertyValue('--down').trim() || DOWN; }
  function flatColor() { return getComputedStyle(document.body).getPropertyValue('--flat').trim() || FLAT; }
  function trendColor(v) { return Math.abs(v) < 1e-9 ? flatColor() : (v > 0 ? upColor() : downColor()); }

  /* ───────── 气温的"涨跌幅" ───────── */
  /** 绝对零度。气温是**间隔尺度**量：摄氏/华氏的零点是人为约定的，不是"没有温度"，
      所以拿摄氏值当分母算比值没有意义 —— 换个单位这个"涨幅"就变了
      （21.0→22.5℃ 在摄氏下是 +7.14%、开尔文 +0.51%、华氏 +3.87%，同一件物理事实）。
      更糟的是它会直接算错：0℃ 时除零，**0℃ 以下整个符号翻转** —— 哈尔滨 2025-12~2026-02
      的 90 个交易日里有 88 天收盘价 < 0℃，其中 47 天是"升温却显示成负数"，
      最离谱的一天开 -4.8℃、收 -16.1℃（大降温 11.3℃）却显示 +235.4%。
      要算相对变化就必须用有真零点的绝对温标，于是分母统一加 K0。
      代价：因为大气温度只在 273~313K 之间晃，比值退化成 ΔT × ~0.0034，
      几乎就是绝对差的线性重标定 —— 但这正是物理上的实话，对气温来说有意义的就是
      绝对差 ΔT 本身，比值提供不了额外信息。附带好处：算出来是 ±0.1~2.5%，
      恰好落在真实股票一天的涨跌幅区间里。 */
  const K0 = 273.15;
  function pctOf(cur, base) {
    if (cur == null || base == null) return null;
    return (cur - base) / (base + K0) * 100;
  }
  /** 绝对差的中文说明用不到，但保留一个"绝对差"取值，免得各处再写一遍减法 */
  function diffOf(cur, base) {
    if (cur == null || base == null) return null;
    return cur - base;
  }

  /* ───────── 天气现象 -> 图标/量级 ───────── */
  const WX = [
    [/雷|闪电/, '⛈', 9], [/暴雪/, '🌨', 9], [/暴雨/, '🌧', 8], [/大雨/, '🌧', 7],
    [/雨夹雪|雨雪/, '🌨', 7], [/中雨/, '🌧', 6], [/小雪/, '🌨', 5], [/小雨|阵雨|冻雨/, '🌦', 4],
    [/雾|霾|浮尘|扬沙|沙尘|尘/, '🌫', 3], [/阴/, '☁', 2], [/多云/, '⛅', 1], [/晴/, '☀', 0],
    [/雪/, '🌨', 6], [/雨/, '🌧', 5]
  ];
  const WX_ICON = [
    [/雷/, '⛈'], [/暴雪|大雪/, '❄'], [/暴雨|大雨/, '🌧'], [/中雨/, '🌧'], [/小雨|阵雨|冻雨/, '🌦'],
    [/雨夹雪|雨雪/, '🌨'], [/雪/, '❄'], [/雾|霾|沙|尘/, '🌫'], [/阴/, '☁'], [/多云/, '⛅'], [/晴/, '☀']
  ];
  const WX_SHORT = [
    [/雷/, '雷'], [/暴雪/, '暴雪'], [/大雪/, '大雪'], [/中雪/, '中雪'], [/小雪|阵雪/, '小雪'], [/雪/, '雪'],
    [/暴雨/, '暴雨'], [/大雨/, '大雨'], [/中雨/, '中雨'], [/小雨|阵雨|冻雨/, '小雨'], [/雨夹雪|雨雪/, '雨夹雪'], [/雨/, '雨'],
    [/雾/, '雾'], [/霾/, '霾'], [/浮尘|扬沙|沙尘|尘/, '沙尘'], [/阴/, '阴'], [/多云/, '多云'], [/晴/, '晴']
  ];
  function wxIcon(t) { if (!t) return '—'; for (const [re, ic] of WX_ICON) if (re.test(t)) return ic; return '·'; }
  function wxShort(t) { if (!t) return '—'; for (const [re, s] of WX_SHORT) if (re.test(t)) return s; return String(t).slice(0, 3); }
  /** 天气严重度 0-9，用于"成交明细"里的红绿判断 */
  function wxSeverity(t) { if (!t) return 0; for (const [re, , s] of WX) if (re.test(t)) return s; return 0; }

  /* ───────── 风力 ───────── */
  function windLevel(ws) { // ws: m/s
    if (ws == null || isNaN(ws)) return '--';
    const b = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    let i = 0; while (i < b.length && ws >= b[i]) i++;
    return i + '级';
  }

  /** 时间段标签：早盘/午盘/尾盘/夜盘 —— 借用股市说法 */
  function sessionLabel(h) {
    if (h < 6) return '夜盘';
    if (h < 9) return '盘前';
    if (h < 12) return '早盘';
    if (h < 14) return '午盘';
    if (h < 18) return '午后';
    if (h < 22) return '尾盘';
    return '夜盘';
  }

  /** 数值数组 -> 归一化折线 path（用于指数条 sparkline） */
  function sparkPath(vals, w, h, pad) {
    if (!vals || vals.length < 2) return '';
    pad = pad || 1;
    let mn = Infinity, mx = -Infinity;
    for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const rng = (mx - mn) || 1;
    const step = (w - pad * 2) / (vals.length - 1);
    let d = '';
    for (let i = 0; i < vals.length; i++) {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) * (1 - (vals[i] - mn) / rng);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2000);
  }

  function debounce(fn, ms) {
    let tm = null;
    return function () {
      const a = arguments, self = this;
      clearTimeout(tm);
      tm = setTimeout(() => fn.apply(self, a), ms);
    };
  }

  /** 判断是否在 A 股交易时段（用于行情刷新频率的"盘后降频"） */
  function marketPhase(d) {
    d = d || new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return 'closed';
    const m = d.getHours() * 60 + d.getMinutes();
    if (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) return 'open';
    if (m >= 13 * 60 && m <= 15 * 60) return 'open';
    if (m > 11 * 60 + 30 && m < 13 * 60) return 'break';
    return 'closed';
  }

  global.U = {
    $, $$, el, pad2, fx, sgn, cls, fmtDate, fmtTime, fmtHM, parseDate, parseISO, weekday,
    pluck, clamp, sum, avg, last, clone, storeGet, storeSet,
    UP, DOWN, FLAT, upColor, downColor, flatColor, trendColor, K0, pctOf, diffOf,
    wxIcon, wxShort, wxSeverity, windLevel, sessionLabel, sparkPath,
    toast, debounce, marketPhase
  };
})(window);
