'use strict';
/* 验收新的「天气好坏 → 指数」模型：
 *   ① 指数还像不像一个市场（中位涨跌、p90/中位、自相关）
 *   ② 指数和天气的相关性有没有建立起来（改之前是 0）
 *   ③ 锚点制之后长期水平有没有被锁在 BASE 附近
 *
 * 用法：node tools/check_comfort_model.js
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
const T = sb.Game._t, G = sb.Game.G;

const wx = JSON.parse(fs.readFileSync(path.join(DATA, 'weather_广州.json'), 'utf8'));
const mn = { time: wx.minutely.time, temp: wx.minutely.temperature_2m, gust: wx.minutely.wind_gusts_10m,
  precip: wx.minutely.precipitation, wcode: wx.minutely.weather_code, cape: wx.minutely.cape, dew: wx.minutely.dew_point_2m };
const air = { time: wx.air.time, pm25: wx.air.pm25 };
const city = { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' };

const pct = (a, b) => (b - a) / a * 100;
function stats(rets) {
  const r = rets.filter(isFinite).map(Math.abs).sort((a, b) => a - b);
  const q = p => r[Math.min(r.length - 1, Math.floor(p * r.length))];
  return { med: q(.5), p90: q(.9), p99: q(.99), ratio90: q(.9) / q(.5), ratio99: q(.99) / q(.5) };
}

console.log('真实交易所靶子：中位 0.1848%   p90/中位 3.35   p99/中位 8.30\n');

for (const [bi, nm] of [[2, '15 分'], [4, '1 时'], [6, '1 日']]) {
  _s = 1000;
  G.barIdx = bi;
  const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
  if (!pk) { console.log(nm + ' 取数失败'); continue; }
  const s = pk.series;
  const rets = [];
  for (let i = 1; i < s.length; i++) rets.push(pct(s[i - 1].c, s[i].c));
  const st = stats(rets);
  const lo = Math.min.apply(null, s.map(b => b.l));
  const hi = Math.max.apply(null, s.map(b => b.h));
  const mean = s.reduce((a, b) => a + b.c, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b.c - mean) * (b.c - mean), 0) / s.length);

  // lag-1 自相关
  const rr = rets.filter(isFinite);
  const mu = rr.reduce((a, b) => a + b, 0) / rr.length;
  let num = 0, den = 0;
  for (let i = 0; i < rr.length; i++) { den += (rr[i] - mu) * (rr[i] - mu); if (i) num += (rr[i] - mu) * (rr[i - 1] - mu); }
  const ac = num / den;

  console.log(nm.padEnd(7) + '根数 ' + String(s.length).padStart(5) +
    '   指数区间 ' + lo.toFixed(0) + '~' + hi.toFixed(0) +
    '   均值 ' + mean.toFixed(1) + '  标准差 ' + sd.toFixed(1));
  console.log('        中位 ' + st.med.toFixed(4) + '%   p90/中位 ' + st.ratio90.toFixed(2) +
    '   p99/中位 ' + st.ratio99.toFixed(2) + '   lag-1 自相关 ' + ac.toFixed(3));
  console.log('');
}

/* ② 指数 vs 天气：同期相关。改之前这个数应该接近 0 */
console.log('指数与"天气好坏"的关系（改之前应该接近 0）：');
_s = 1000;
G.barIdx = 4;
const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
{
  const s = pk.series;
  const src = pk.base || s;
  // 用 sevWin（本局的恶劣度窗口）对齐：它是 comfort 的负增量
  const sv = pk.sevWin || [];
  const n = Math.min(s.length, sv.length);
  if (n > 20) {
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) { xs.push(sv[i]); ys.push(s[i].c); }
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
    console.log('  corr(恶劣度, 指数) = ' + (a / Math.sqrt(b * c)).toFixed(3) +
      '   （负值 = 天气越差指数越低，这就是我们要的方向）');
  } else {
    console.log('  sevWin 长度不足（' + sv.length + '），无法算相关');
  }
}
