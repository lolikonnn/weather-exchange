'use strict';
/* 只量**分布形状**（都用中位归一化，所以不受整体水平影响）：
 *   p90/中位、p99/中位、峰度
 * 这才是"该改哪个系数"的答案 —— 形状由 JUMP_K / NOISE_A / MICRO_K 决定，
 * 水平由整体缩放决定，两件事分开调，不要混在一起搜。
 *
 * 用法：node tools/shape_check.js
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
const P = T.P;

const wx = JSON.parse(fs.readFileSync(path.join(DATA, 'weather_广州.json'), 'utf8'));
const mn = { time: wx.minutely.time, temp: wx.minutely.temperature_2m, gust: wx.minutely.wind_gusts_10m,
  precip: wx.minutely.precipitation, wcode: wx.minutely.weather_code, cape: wx.minutely.cape, dew: wx.minutely.dew_point_2m };
const air = { time: wx.air.time, pm25: wx.air.pm25 };

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pctl = (s, p) => s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))];
const kurt = a => { const n = a.length, m = mean(a); const m2 = a.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (!m2) return 0; return a.reduce((s, x) => s + (x - m) ** 4, 0) / n / (m2 * m2) - 3; };

/** 真实：从 data/crypto 里读，用**段内**涨跌（bounds 切段） */
function realShape(pair) {
  const f = fs.readdirSync(DATA).find(x => x.toUpperCase().startsWith(pair.replace('-', '').toUpperCase()) && x.includes('15m_365d'));
  if (!f) return null;
  const d = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
  const c = d.rows.map(r => r[4]);
  const r = []; for (let i = 1; i < c.length; i++) if (c[i - 1]) r.push((c[i] - c[i - 1]) / c[i - 1]);
  const ar = r.map(Math.abs).sort((a, b) => a - b);
  const med = pctl(ar, 0.5);
  return { med: med * 100, p90: pctl(ar, 0.9) / med, p99: pctl(ar, 0.99) / med, kurt: kurt(r), n: r.length };
}

/** 游戏：真代码 + 真天气，跨局不算涨跌 */
function gameShape(city, rounds) {
  const r = [];
  for (let k = 0; k < rounds; k++) {
    _s = 1000 + k * 7919;
    const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
    if (!pk) continue;
    const c = pk.series.map(b => b.c);
    for (let i = 1; i < c.length; i++) if (c[i - 1]) r.push((c[i] - c[i - 1]) / c[i - 1]);
  }
  const ar = r.map(Math.abs).sort((a, b) => a - b);
  const med = pctl(ar, 0.5);
  return { med: med * 100, p90: pctl(ar, 0.9) / med, p99: pctl(ar, 0.99) / med, kurt: kurt(r), n: r.length };
}

console.log('分布形状（全部用中位归一化，与整体水平无关）');
console.log('真实 p90/中位 与 p99/中位 在 9 个币上非常一致 —— 这就是"形状"的靶子\n');
console.log('  ' + '标的'.padEnd(14) + '中位%'.padEnd(10) + 'p90/中位'.padEnd(11) + 'p99/中位'.padEnd(11) + '峰度');
console.log('  ' + '-'.repeat(58));
const real = {};
for (const p of ['BTC', 'ETH', 'SOL', 'DOGE', 'SUI', 'PEPE', 'WIF', 'BONK']) {
  const s = realShape(p);
  if (!s) continue;
  real[p] = s;
  console.log('  ' + p.padEnd(14) + s.med.toFixed(4).padEnd(10) +
    s.p90.toFixed(2).padEnd(11) + s.p99.toFixed(2).padEnd(11) + s.kurt.toFixed(0));
}
const rs = Object.values(real);
const avg = k => rs.reduce((s, x) => s + x[k], 0) / rs.length;
console.log('  ' + '-'.repeat(58));
console.log('  ' + '真实平均'.padEnd(14) + avg('med').toFixed(4).padEnd(10) +
  avg('p90').toFixed(2).padEnd(11) + avg('p99').toFixed(2).padEnd(11) + avg('kurt').toFixed(0));

console.log('\n  ' + '游戏分层'.padEnd(14) + '中位%'.padEnd(10) + 'p90/中位'.padEnd(11) + 'p99/中位'.padEnd(11) + '峰度');
console.log('  ' + '-'.repeat(58));
const CITIES = [
  ['直辖市', { name: '北京', prov: '北京市', lat: 39.81, lon: 116.47, cma: '54511' }],
  ['省会', { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287' }],
  ['地级市', { name: '惠州', prov: '广东省', lat: 23.11, lon: 114.42, cma: '59298' }],
  ['区县', { name: '义乌', prov: '浙江省', lat: 29.31, lon: 120.07, cma: '' }],
];
const gs = {};
for (const [nm, c] of CITIES) {
  const s = gameShape(c, 6);
  gs[nm] = s;
  console.log('  ' + nm.padEnd(14) + s.med.toFixed(4).padEnd(10) +
    s.p90.toFixed(2).padEnd(11) + s.p99.toFixed(2).padEnd(11) + s.kurt.toFixed(0));
}
console.log('  ' + '-'.repeat(58));
const gm = Object.values(gs);
const gavg = k => gm.reduce((s, x) => s + x[k], 0) / gm.length;
console.log('  ' + '游戏平均'.padEnd(14) + gavg('med').toFixed(4).padEnd(10) +
  gavg('p90').toFixed(2).padEnd(11) + gavg('p99').toFixed(2).padEnd(11) + gavg('kurt').toFixed(0));

console.log('\n  ── 结论 ──');
console.log('  水平：游戏 ' + gavg('med').toFixed(4) + '%  vs 真实平均 ' + avg('med').toFixed(4) + '%' +
  '  → 需要把整体缩放 ×' + (avg('med') / gavg('med')).toFixed(3));
console.log('  p90 形状：游戏 ' + gavg('p90').toFixed(2) + ' vs 真实 ' + avg('p90').toFixed(2) +
  '  → ' + (gavg('p90') > avg('p90') ? '偏肥' : '偏瘦'));
console.log('  p99 尾部：游戏 ' + gavg('p99').toFixed(2) + ' vs 真实 ' + avg('p99').toFixed(2) +
  '  → ' + (gavg('p99') > avg('p99') ? '**太肥 ' + (gavg('p99') / avg('p99')).toFixed(1) + '×**（JUMP_K 太大）' : '偏瘦'));
