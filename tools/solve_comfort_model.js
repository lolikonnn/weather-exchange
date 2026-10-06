'use strict';
/* 解新模型的三个旋钮，让指数同时满足：
 *    ① 波动水平  ≈ 真实中位 |涨跌| 0.1848%
 *    ② 形状      ≈ p90/中位 3.35、p99/中位 8.30
 *    ③ 自相关    ≈ 0（真实 15 分钟几乎不相关；原来的 0.87 太"黏"）
 *    ④ 天气解释力：指数与"天气好坏"的相关性要明显（改之前是 0）
 *
 * 三个旋钮：
 *    NOISE_AMP  全局噪声幅度（所有随机项乘它）
 *    REVERT     均值回归强度（大 → 回归快、自相关低、但噪声被压小）
 *    COMFORT_K  锚点灵敏度（大 → 天气主导、指数区间宽）
 *
 * 用法：node tools/solve_comfort_model.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const JS = p => path.join(ROOT, 'web', 'js', p);
const DATA = path.join(ROOT, 'data', 'crypto');
function fakeEl() {
  return { textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: {}, dataset: {}, title: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, removeChild() {}, remove() {},
    addEventListener() {}, querySelector: () => fakeEl(), querySelectorAll: () => [], closest: () => null,
    setAttribute() {}, getAttribute: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 400 }),
    getContext: () => ({}), focus() {}, blur() {}, offsetWidth: 0 };
}
const doc = { body: fakeEl(), documentElement: fakeEl(), querySelector: () => fakeEl(), querySelectorAll: () => [],
  getElementById: () => fakeEl(), createElement: () => fakeEl(), addEventListener() {}, hidden: false };
let _s = 1;
const rand = () => { _s ^= _s << 13; _s >>>= 0; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 4294967296; };
const sb = { console, setTimeout, clearTimeout, setInterval, clearInterval, document: doc,
  location: { search: '', hostname: '127.0.0.1', protocol: 'http:' }, navigator: {}, matchMedia: () => ({ matches: false }),
  requestAnimationFrame: () => 0, addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }), Path2D: function () {}, Image: function () {}, AbortController: function () {},
  fetch: () => Promise.reject(new Error('x')), localStorage: { getItem: () => null, setItem() {} },
  echarts: { init: () => ({ setOption() {}, on() {}, getZr: () => ({ on() {} }), getWidth: () => 900, resize() {}, dispose() {},
    getOption: () => ({ series: [], xAxis: [{ data: [] }] }), convertToPixel: () => 0 }), graphic: { LinearGradient: function () {} }, registerMap() {} } };
sb.window = sb; sb.globalThis = sb; sb.self = sb;
sb.Math = Object.create(Math); sb.Math.random = rand;
const ctx = vm.createContext(sb);
for (const f of ['util.js', 'indicators.js', 'api.js', 'chart.js', 'weather.js', 'wxui.js', 'app.js', 'game.js'])
  vm.runInContext(fs.readFileSync(JS(f), 'utf8'), ctx, { filename: f });
const T = sb.Game._t, G = sb.Game.G, P = T.P;

const wx = JSON.parse(fs.readFileSync(path.join(DATA, 'weather_广州.json'), 'utf8'));
const mn = { time: wx.minutely.time, temp: wx.minutely.temperature_2m, gust: wx.minutely.wind_gusts_10m,
  precip: wx.minutely.precipitation, wcode: wx.minutely.weather_code, cape: wx.minutely.cape, dew: wx.minutely.dew_point_2m };
const air = { time: wx.air.time, pm25: wx.air.pm25 };
const city = { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' };

const GOAL = { med: 0.1848, ratio90: 3.35, ratio99: 8.30 };

/** 跑 N 局，汇总统计 */
function run(trials) {
  const all = [];
  let corrSum = 0, corrN = 0;
  for (let t = 0; t < trials; t++) {
    _s = 1000 + t * 7919;
    G.barIdx = 2;                                   // 15 分钟，与真实靶子同粒度
    const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
    if (!pk || !pk.series || pk.series.length < 40) continue;
    const s = pk.series;
    const rets = [];
    for (let i = 1; i < s.length; i++) rets.push((s[i].c - s[i - 1].c) / s[i - 1].c * 100);
    all.push.apply(all, rets.filter(isFinite));
    // 指数 vs 恶劣度 的相关
    const sv = pk.sevWin || [];
    const n = Math.min(s.length, sv.length);
    if (n > 40) {
      const xs = sv.slice(0, n), ys = s.slice(0, n).map(b => b.c);
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let a = 0, b = 0, c = 0;
      for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
      if (b > 0 && c > 0) { corrSum += a / Math.sqrt(b * c); corrN++; }
    }
  }
  const r = all.slice().sort((x, y) => x - y);
  const abs = all.map(Math.abs).sort((x, y) => x - y);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const mu = all.reduce((a, b) => a + b, 0) / all.length;
  let num = 0, den = 0;
  for (let i = 0; i < all.length; i++) { den += (all[i] - mu) * (all[i] - mu); }
  // 自相关要在**每局内部**算再平均（跨局拼接会造出假跳变）
  return { med: q(abs, .5), ratio90: q(abs, .9) / q(abs, .5), ratio99: q(abs, .99) / q(abs, .5),
           corr: corrN ? corrSum / corrN : 0, n: all.length };
}

/* 逐局算自相关（跨局拼接会造假） */
function acf1(trials) {
  let sum = 0, cnt = 0;
  for (let t = 0; t < trials; t++) {
    _s = 1000 + t * 7919;
    G.barIdx = 2;
    const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
    if (!pk || !pk.series || pk.series.length < 40) continue;
    const s = pk.series, rr = [];
    for (let i = 1; i < s.length; i++) rr.push((s[i].c - s[i - 1].c) / s[i - 1].c * 100);
    const mu = rr.reduce((a, b) => a + b, 0) / rr.length;
    let a = 0, b = 0;
    for (let i = 0; i < rr.length; i++) { b += (rr[i] - mu) * (rr[i] - mu); if (i) a += (rr[i] - mu) * (rr[i - 1] - mu); }
    if (b > 0) { sum += a / b; cnt++; }
  }
  return cnt ? sum / cnt : 0;
}

console.log('靶子：中位 ' + GOAL.med + '%   p90/中位 ' + GOAL.ratio90 + '   p99/中位 ' + GOAL.ratio99 + '   自相关 ≈ 0\n');

const TRIALS = 6;
console.log('  NOISE_AMP  REVERT  COMFORT_K  NOISE_RV |   中位%   p90/中  p99/中   自相关   天气相关');
console.log('  ' + '-'.repeat(80));
const rows = [];
for (const na of [0.15, 0.4, 0.9]) {
  for (const rv of [0.0015]) {
    for (const ck of [25, 50, 100]) {
      for (const nr of [0.8]) {
      P.NOISE_AMP = na; P.REVERT = rv; P.COMFORT_K = ck; P.NOISE_REVERT = nr;
      const st = run(TRIALS);
      const ac = acf1(TRIALS);
      rows.push({ na, rv, ck, nr, st, ac });
      console.log('  ' + String(na).padEnd(11) + String(rv).padEnd(8) + String(ck).padEnd(11) + '| ' +
        st.med.toFixed(4).padStart(8) + '  ' + st.ratio90.toFixed(2).padStart(7) + '  ' +
        st.ratio99.toFixed(2).padStart(7) + '  ' + ac.toFixed(3).padStart(8) + '  ' +
        st.corr.toFixed(3).padStart(9) + '  nr=' + nr);
      }
    }
  }
}
console.log('');
/* 打分：中位要对上、形状偏差要小、自相关要接近 0、天气相关要够大 */
const score = r =>
  Math.abs(Math.log(r.st.med / GOAL.med)) * 3 +
  Math.abs(r.st.ratio90 - GOAL.ratio90) / 4 +
  Math.abs(r.st.ratio99 - GOAL.ratio99) / 12 +
  Math.abs(r.ac) * 2 +
  Math.max(0, 0.35 - Math.abs(r.st.corr)) * 2;
rows.sort((a, b) => score(a) - score(b));
console.log('最接近靶子的三组：');
rows.slice(0, 3).forEach(r => {
  console.log('  NOISE_AMP=' + r.na + '  REVERT=' + r.rv + '  COMFORT_K=' + r.ck +
    '   → 中位 ' + r.st.med.toFixed(4) + '%  形状 ' + r.st.ratio90.toFixed(2) + '/' + r.st.ratio99.toFixed(2) +
    '  自相关 ' + r.ac.toFixed(3) + '  天气相关 ' + r.st.corr.toFixed(3));
});
