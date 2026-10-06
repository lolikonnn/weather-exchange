'use strict';
/* 量出价格式里**每一项各自**贡献了多少波动、自相关是多少 —— 用来定位
 * "自相关 −0.5" 到底是哪一项造成的（瞎调系数不如先量）。
 *
 * 用法：node tools/probe_components.js
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
const T = sb.Game._t;

const wx = JSON.parse(fs.readFileSync(path.join(DATA, 'weather_广州.json'), 'utf8'));
const mn = { time: wx.minutely.time, temp: wx.minutely.temperature_2m, gust: wx.minutely.wind_gusts_10m,
  precip: wx.minutely.precipitation, wcode: wx.minutely.weather_code, cape: wx.minutely.cape, dew: wx.minutely.dew_point_2m };
const air = { time: wx.air.time, pm25: wx.air.pm25 };

const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const ac1 = a => { const m = a.reduce((x, y) => x + y, 0) / a.length;
  const d = a.reduce((s, x) => s + (x - m) ** 2, 0); if (!d) return 0;
  let n = 0; for (let i = 1; i < a.length; i++) n += (a[i] - m) * (a[i - 1] - m); return n / d; };

T.setDbgComp(true);
const city = { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' };
let picked = null;
for (let r = 0; r < 12 && !picked; r++) {
  _s = 1000 + r * 7919;
  picked = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
}
T.setDbgComp(false);
if (!picked || !picked.comp) { console.error('拿不到分量'); process.exit(1); }

const comp = picked.comp;
const px = picked.base.map(b => b.c);
const dpx = []; for (let i = 1; i < px.length; i++) dpx.push(px[i] - px[i - 1]);

console.log('窗口 %d 根；价格单根差分 标准差 %.3f（中位|差分| %.3f）\n', px.length, sd(dpx),
  (() => { const a = dpx.map(Math.abs).sort((x, y) => x - y); return a[a.length >> 1]; })());

console.log('%-9s %10s %10s %10s %10s   %s', '分量', 'σ(水平)', 'σ(差分)', '自相关(水平)', '自相关(差分)', '差分方差占比');
console.log('-'.repeat(92));
const names = Object.keys(comp[0]);
const rows = [];
for (const n of names) {
  const a = comp.map(o => o[n]);
  const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
  rows.push({ n, sd: sd(a), sdd: sd(d), ac: ac1(a), acd: ac1(d), sdd2: sd(d) ** 2 });
}
const tot = rows.reduce((s, r) => s + r.sdd2, 0);
rows.sort((a, b) => b.sdd2 - a.sdd2);
for (const r of rows) {
  console.log('%-9s %10.3f %10.4f %10.3f %10.3f   %6.1f%%',
    r.n, r.sd, r.sdd, r.ac, r.acd, 100 * r.sdd2 / tot);
}
console.log('-'.repeat(92));
console.log('合计差分 σ = %.4f（各分量 σ 的平方和开根 = %.4f，相差大说明分量之间有相关）',
  sd(dpx), Math.sqrt(tot));
