'use strict';
/* 按**真实 tick 序列**量：同一个速度下，各档位未收盘那根的收盘价每 tick 移动多少。
 * 用来诊断"长档位变化不够快"——粗档位一根覆盖的源样本多，跨一格只移动整根的百分之几。
 *
 * 用法：node tools/probe_live_rate.js
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
_s = 1000;
const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
G.base = pk.base; G.city = city; G.running = true; G.ended = false;

const TICK_HZ = T.TICK_HZ;           // 读实际值，别硬编码
const SPEED = T.SPEEDS[G.speedIdx];  // 读当前速度档，别硬编码

console.log('当前速度「' + T.SPEED_N[G.speedIdx] + '」= ' + SPEED + ' 分钟天气/秒，tick ' + TICK_HZ + ' Hz');
console.log('按**真实 tick 序列**统计未收盘那根的收盘价：\n');
console.log('  档位     整根墙钟    每 tick 移动（占整根）      帧数       活跃度      换向率');
console.log('  ' + '-'.repeat(86));

for (const [bi, nm] of [[0, '1 分'], [1, '5 分'], [2, '15 分'], [3, '30 分'],
                        [4, '1 时'], [5, '4 时'], [6, '1 日']]) {
  G.barIdx = bi;
  const rs = T.resample(pk.base, pk.baseSeeds, pk.baseReg);
  G.series = rs.series; G.seeds = rs.seeds; G.i = 30;
  const barMin = T.BAR_MIN[bi];
  const perTick = (SPEED / barMin) / TICK_HZ;
  const secPerBar = barMin / SPEED;

  T.fbReset();
  let prev = null, moves = 0, ticks = 0, signs = 0, lastSign = 0, alive = 0;
  const rng = rs.series[30].h - rs.series[30].l;
  for (let acc = 0; acc < 1; acc += perTick) {
    G.acc = Math.min(1, acc);
    const L = T.liveAt();
    if (prev !== null) {
      const d = L.c - prev;
      moves += Math.abs(d); ticks++;
      if (d !== 0) { alive++; const s = d > 0 ? 1 : -1; if (lastSign && s !== lastSign) signs++; lastSign = s; }
    }
    prev = L.c;
  }
  const perMove = ticks ? moves / ticks : 0;
  console.log('  ' + nm.padEnd(8) + (secPerBar.toFixed(1) + ' s').padEnd(12) +
    (perMove.toFixed(3) + ' 点 = ' + (100 * perMove / rng).toFixed(2) + '%').padEnd(22) +
    (ticks + ' 帧').padEnd(10) +
    ((ticks ? (100 * alive / ticks).toFixed(0) : '0') + '% 帧在动').padEnd(12) +
    (ticks ? (100 * signs / Math.max(1, alive)).toFixed(0) : '0') + '% 换向');
}
console.log('');
console.log('  ★ 各档位的"每 tick 移动占整根比例"应该在同一个量级。');
console.log('    修复前 1 日档只有 1.1%（15 分档 18.8%），差 17 倍 → 看着卡住。');
