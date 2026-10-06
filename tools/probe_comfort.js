'use strict';
/* 量「天气舒适度」标尺：它真的有动态范围吗？好天气和坏天气分得开吗？
 * 这个标尺就是指数的"基本面"，所以先看它，再看价格。
 *
 * 用法：node tools/probe_comfort.js
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

// PM2.5 按小时对齐（和 game.js 里同一口径）
const hourOf = t => t.slice(0, 13) + ':00';
const am = {};
for (let k = 0; k < wx.air.time.length; k++) if (wx.air.pm25[k] != null) am[wx.air.time[k]] = +wx.air.pm25[k];
const pm25 = mn.time.map(t => (am[hourOf(t)] == null ? null : am[hourOf(t)]));

const cf = T.comfort(mn, pm25);
const sv = T.severity(mn, pm25);
const v = cf.slice().sort((a, b) => a - b);
const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];

console.log('天气舒适度 comfort ∈ [0,100]（广州 92 天，' + cf.length + ' 根 15 分钟）\n');
console.log('  分布： min ' + q(0).toFixed(1) + '   p1 ' + q(.01).toFixed(1) + '   p10 ' + q(.10).toFixed(1) +
  '   中位 ' + q(.50).toFixed(1) + '   p90 ' + q(.90).toFixed(1) + '   p99 ' + q(.99).toFixed(1) + '   max ' + q(1).toFixed(1));
console.log('  动态范围（p99−p1）= ' + (q(.99) - q(.01)).toFixed(1) + ' 分');
console.log('');

// 各类天气下的舒适度，验证"好天气一定比坏天气高"
console.log('  按天气码分组的平均舒适度（验证方向性）：');
const byWc = {};
for (let i = 0; i < cf.length; i++) {
  const w = mn.wcode[i] | 0;
  (byWc[w] = byWc[w] || []).push(cf[i]);
}
const NAME = { 0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '雾', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷暴', 96: '雷暴+冰雹', 99: '强雷暴' };
Object.entries(byWc).sort((a, b) => b[1].length - a[1].length).slice(0, 12).forEach(([w, arr]) => {
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  console.log('    wcode ' + String(w).padStart(3) + '  ' + (NAME[w] || '?').padEnd(10) +
    String(arr.length).padStart(6) + ' 根   平均 ' + m.toFixed(1).padStart(5) +
    '   ' + '█'.repeat(Math.max(0, Math.round(m / 2))));
});
console.log('');

// 好天气 vs 坏天气的日数占比
const good = cf.filter(x => x >= q(.75)).length, bad = cf.filter(x => x <= q(.25)).length;
console.log('  最舒服的 25% 有 ' + good + ' 根，最难受的 25% 有 ' + bad + ' 根（总量 ' + cf.length + '）');
console.log('');

// severity 现在是 comfort 的负增量，看看它触发跳变的频率
let jumped = 0;
for (let i = 1; i < sv.length; i++) if (Math.abs(sv[i] - sv[i - 1]) > 1.8) jumped++;
console.log('  severity（= −Δcomfort/10）超过 JUMP_AT=1.8 的次数：' + jumped +
  '  （每局 672 根，平均每局 ' + (jumped / cf.length * 672).toFixed(1) + ' 次）');

console.log('\n  按月看平均舒适度（7/8/9/10 月）：');
const byMonth = {};
for (let i = 0; i < cf.length; i++) {
  const mo = mn.time[i].slice(5, 7);
  (byMonth[mo] = byMonth[mo] || []).push(cf[i]);
}
Object.entries(byMonth).sort().forEach(([mo, arr]) => {
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  console.log('    ' + mo + ' 月  平均 ' + m.toFixed(1).padStart(5) + '  （' + arr.length + ' 根）');
});
