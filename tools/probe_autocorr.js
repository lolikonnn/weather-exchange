'use strict';
/* 追查：价格差分的自相关为什么会是 −0.5（真实行情 ≈ 0）。
 * 逐项量 + 交叉相关分解，把"总自相关"拆成"自身项 + 交叉项"。
 * 用法：node tools/probe_autocorr.js
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

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const cov = (a, b) => { const ma = mean(a), mb = mean(b); return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / a.length; };
const ac1 = a => { const m = mean(a), d = a.reduce((s, x) => s + (x - m) ** 2, 0); if (!d) return 0;
  let n = 0; for (let i = 1; i < a.length; i++) n += (a[i] - m) * (a[i - 1] - m); return n / d; };
const diff = a => { const o = []; for (let i = 1; i < a.length; i++) o.push(a[i] - a[i - 1]); return o; };

T.setDbgComp(true);
const city = { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' };
let picked = null;
for (let r = 0; r < 12 && !picked; r++) { _s = 1000 + r * 7919; picked = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null }); }
T.setDbgComp(false);
const comp = picked.comp;
const names = Object.keys(comp[0]).filter(n => sd(comp.map(o => o[n])) > 1e-12);

// 差分
const D = {}; names.forEach(n => { D[n] = diff(comp.map(o => o[n])); });
const total = []; const L = D[names[0]].length;
for (let i = 0; i < L; i++) { let s = 0; names.forEach(n => s += D[n][i]); total.push(s); }

const v = sd(total) ** 2;
console.log('价格差分：σ = ' + sd(total).toFixed(4) + '   自相关 lag-1 = ' + ac1(total).toFixed(4));
console.log('');
// 分解：ac1(total) * var(total) = Σ_ij cov(Di[t], Dj[t-1]) / N
// 先用"总量法"验证：Σ_ij covlag(i,j) 除以 var(total) 应该等于 ac1
console.log('总自相关分解  ac1 = Σ_ij covlag(Di[t], Dj[t-1]) / var(total)');
console.log('');
console.log(pad('项 i', 9) + pad('项 j', 9) + pad('covlag', 12) + pad('对 ac1 的贡献', 14));
console.log('-'.repeat(46));
let acc = 0;
const contrib = [];
for (const i of names) {
  for (const j of names) {
    const a = D[i].slice(1), b = D[j].slice(0, -1);      // a[t] 与 b[t-1]
    const c = cov(a, b);
    const ct = c / v;
    acc += ct;
    if (Math.abs(ct) > 0.01) contrib.push([i, j, c, ct]);
  }
}
contrib.sort((x, y) => Math.abs(y[3]) - Math.abs(x[3]));
for (const [i, j, c, ct] of contrib) {
  console.log(pad(i, 9) + pad(j, 9) + pad(c.toFixed(4), 12) + pad((ct >= 0 ? '+' : '') + ct.toFixed(4), 14));
}
console.log('-'.repeat(46));
console.log('合计 = ' + acc.toFixed(4) + '   （实测 ac1 = ' + ac1(total).toFixed(4) + '）');
console.log('');
console.log('自身项（i=j）贡献合计 = ' + contrib.filter(x => x[0] === x[1]).reduce((s, x) => s + x[3], 0).toFixed(4));
console.log('交叉项（i≠j）贡献合计 = ' + contrib.filter(x => x[0] !== x[1]).reduce((s, x) => s + x[3], 0).toFixed(4));

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
