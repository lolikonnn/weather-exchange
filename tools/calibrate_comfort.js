'use strict';
/* 标定 comfort → 指数的映射系数。
 *
 * 指数的语义是"当地天气好坏"，所以：
 *     指数锚点 = BASE + (comfort − 中位) × COMFORT_K
 * 目标是最常见的那批波动（中位绝对涨跌）对上真实交易所的水平。
 *
 * 真实靶子（欧易 9 对 × 365 天 × 15 分钟，见 README）：
 *     中位 |收益| 0.1848%；直辖市 ≈ BTC 0.099%，县级市 ≈ WIF 0.254%
 *
 * 用法：node tools/calibrate_comfort.js
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
const hourOf = t => t.slice(0, 13) + ':00';
const am = {};
for (let k = 0; k < wx.air.time.length; k++) if (wx.air.pm25[k] != null) am[wx.air.time[k]] = +wx.air.pm25[k];
const pm25 = mn.time.map(t => (am[hourOf(t)] == null ? null : am[hourOf(t)]));

const cf = T.comfort(mn, pm25);
const med = T.median(cf);
console.log('comfort 中位 = ' + med.toFixed(2) + '，共 ' + cf.length + ' 根\n');

/* 锚点的绝对涨跌（还没乘任何系数）：|Δ(comfort − med)| */
const dRaw = [];
for (let i = 1; i < cf.length; i++) dRaw.push(Math.abs(cf[i] - cf[i - 1]));
const sRaw = dRaw.slice().sort((a, b) => a - b);
console.log('|Δcomfort| 的分布（未乘系数）：中位 ' + sRaw[sRaw.length >> 1].toFixed(3) +
  '   p90 ' + sRaw[Math.floor(.9 * sRaw.length)].toFixed(3) +
  '   p99 ' + sRaw[Math.floor(.99 * sRaw.length)].toFixed(3));
console.log('');

/* 真实靶子（百分数）：BTC 0.099、全市场中位 0.1848、WIF 0.2541 */
const GOALS = { 'BTC级(直辖市)': 0.099, '中位': 0.1848, 'WIF级(县级市)': 0.2541 };

console.log('若「价格 = BASE + (comfort − 中位) × K」，要让**中位绝对收益**落在靶子上：');
console.log('  真实靶子        需要 K      该 K 下的 p90/中位   （真实 3.35）');
console.log('  ' + '-'.repeat(64));
for (const [nm, g] of Object.entries(GOALS)) {
  // 中位绝对收益 = 中位K|Δcomfort| / BASE  →  K = g/100 * BASE / 中位|Δcomfort|
  const K = (g / 100) * 1000 / sRaw[sRaw.length >> 1];
  // 该 K 下的 p90/中位 = p90|Δcf| / 中位|Δcf|（与 K 和 BASE 无关）
  const ratio = sRaw[Math.floor(.9 * sRaw.length)] / sRaw[sRaw.length >> 1];
  console.log('  ' + nm.padEnd(16) + K.toFixed(1).padStart(8) + '      ' + ratio.toFixed(2).padStart(10));
}
console.log('');
console.log('  ★ 注意 p90/中位 与 K 无关 —— 它是 comfort 序列**本身的形状**，');
console.log('    所以上表三行的第三列都一样。要对上真实的 3.35，得改 comfort 的分布，不是改 K。');
console.log('');
console.log('  一天里 comfort 的波动（用于判断"一天一根"时能有多少行情）：');
const perDay = 96;
let dayRange = [];
for (let s = 0; s + perDay < cf.length; s += perDay) {
  const seg = cf.slice(s, s + perDay);
  dayRange.push(Math.max.apply(null, seg) - Math.min.apply(null, seg));
}
dayRange.sort((a, b) => a - b);
console.log('    日内极差(p50) = ' + dayRange[dayRange.length >> 1].toFixed(1) + ' 分  →  ×K 就是一天的点数');
