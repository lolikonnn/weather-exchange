'use strict';
/* 两维小网格：JUMP_AT（触发门槛+尾部形状）× L（整体水平），边搜边打印。
 *
 * 靶子（真实欧易 9 币 15 分钟，tools/shape_check.js 量的，9 个币高度一致）：
 *   中位            0.1848%（BTC 0.0994% ~ WIF 0.2541%）
 *   p90/中位        3.35
 *   p99/中位        8.30
 *   梯度(极差)      2.56×（BTC→WIF）
 *
 * 为什么这么小：只搜 2 维 × 每维 5 点 = 25 组，每组只跑 2 局，秒级出结果。
 * 之前 180 组 × 4 局把工具跑成"卡死"，是我的问题 —— 结构参数该用解析法解（见 solve_coef.js），
 * 形状参数才需要小网格。
 *
 * 用法：node tools/tune_shape.js
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
const ac1 = a => { const m = mean(a), d = a.reduce((s, x) => s + (x - m) ** 2, 0); if (!d) return 0;
  let n = 0; for (let i = 1; i < a.length; i++) n += (a[i] - m) * (a[i - 1] - m); return n / d; };
const kurt = a => { const n = a.length, m = mean(a); const m2 = a.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (!m2) return 0; return a.reduce((s, x) => s + (x - m) ** 4, 0) / n / (m2 * m2) - 3; };

const GOAL = { med: 0.1848, p90: 3.35, p99: 8.30 };

const CITIES = [
  ['直辖市', { name: '北京', prov: '北京市', lat: 39.81, lon: 116.47, cma: '54511' }],
  ['地级市', { name: '惠州', prov: '广东省', lat: 23.11, lon: 114.42, cma: '59298' }],
  ['区县', { name: '义乌', prov: '浙江省', lat: 29.31, lon: 120.07, cma: '' }],
];

/** 三档一起量，返回各档中位与合并后的形状（形状与城市无关，合并样本更稳） */
function measure(rounds) {
  const all = [], meds = {}, acs = [];
  for (const [nm, c] of CITIES) {
    const r = [];
    for (let k = 0; k < rounds; k++) {
      _s = 1000 + k * 7919;
      const pk = T.pickSeries(mn, null, c, { air, quake: null, typh: null, fcst: null });
      if (!pk) continue;
      const cc = pk.series.map(b => b.c);
      for (let i = 1; i < cc.length; i++) if (cc[i - 1]) r.push((cc[i] - cc[i - 1]) / cc[i - 1]);
    }
    if (!r.length) continue;
    const ar = r.map(Math.abs).sort((a, b) => a - b);
    meds[nm] = pctl(ar, 0.5) * 100;
    // ⚠ 自相关必须**逐城市各算各的再平均**。把三个城市的涨跌序列拼成一条再算的话，
    //   拼接处是假跳变（不同城市的价位/天气不同），会把 ρ1 系统性地带偏 ——
    //   实测拼着算得 0.505、分开算是 0.445，而搜索里因此选错了参数。
    acs.push(ac1(r));
    all.push(...r);
  }
  const aa = all.map(Math.abs).sort((a, b) => a - b);
  const med = pctl(aa, 0.5) * 100;
  return { meds, med, p90: pctl(aa, 0.9) / pctl(aa, 0.5), p99: pctl(aa, 0.99) / pctl(aa, 0.5),
           kurt: kurt(all), ac1: acs.reduce((s, x) => s + x, 0) / (acs.length || 1) };
}

const P0 = Object.assign({}, P);
const LK = ['NOISE_K', 'JUMP_K', 'MICRO_K', 'DISH_K', 'DEW_K', 'REG_K', 'AIR_K', 'QUAKE_K', 'TYPHOON_K', 'FCST_K'];

/* 最终定参：只搜两个还没对上的量 *   CITY_AMP_A → 城市梯度（实测 9.81× 太陡，目标 2.56×）
 *   TREND_K    → 自相关（实测 0.45，真实 15m ≈ 0.02，游戏保留 0.12 左右）
 * 水平（中位）每组都对齐到 0.1848%。 */
console.log('最终定参：CITY_AMP_A（梯度）× TREND_K（自相关）');
console.log('真实靶子：梯度 2.56x（BTC→WIF）｜自相关 ≈0.02（游戏取 0.12 保留一点趋势感）');
console.log('水平每组对齐到中位 0.1848%\n');
console.log('  ' + 'CITY_A'.padEnd(8) + 'TREND_K'.padEnd(9) + 's'.padEnd(8) +
  '中位%'.padEnd(9) + 'p90'.padEnd(7) + 'p99'.padEnd(7) + '梯度'.padEnd(7) + '自相关'.padEnd(8) + '误差');
console.log('  ' + '-'.repeat(74));

let best = null;
for (const CA of [0.30, 0.40, 0.50, 0.62]) {
  for (const TK of [8, 14, 24]) {
    P.CITY_AMP_A = CA; P.CITY_K = 1 / Math.pow(1.6, CA);
    P.TREND_K = TK; P.JUMP_AT = 1.8;
    for (const k of LK) P[k] = P0[k] * 1.0;
    const a = measure(3);
    const s = 0.1848 / a.med;
    for (const k of LK) P[k] = P0[k] * s;
    const m = measure(3);
    if (!m.meds['地级市'] || !m.meds['直辖市']) continue;
    const ratio = m.meds['地级市'] / m.meds['直辖市'];
    const err = Math.abs(Math.log(ratio / 2.56)) * 2 +
                Math.abs(m.ac1 - 0.12) * 1.5 +
                Math.abs(Math.log(m.p99 / 8.30)) * 0.8 +
                Math.abs(Math.log(m.p90 / 3.35)) * 0.6;
    console.log('  ' + CA.toFixed(2).padEnd(8) + String(TK).padEnd(9) + s.toFixed(3).padEnd(8) +
      m.med.toFixed(4).padEnd(9) + m.p90.toFixed(2).padEnd(7) + m.p99.toFixed(2).padEnd(7) +
      ratio.toFixed(2).padEnd(7) + m.ac1.toFixed(3).padEnd(8) + err.toFixed(4) +
      (err < 0.9 ? '  <- 好' : ''));
    if (!best || err < best.err) best = { CA, TK, s, m, ratio, err };
  }
}

console.log('');
console.log('选中：CITY_AMP_A=' + best.CA + '  TREND_K=' + best.TK + '  s=' + best.s.toFixed(4));
console.log('  -> 中位 ' + best.m.med.toFixed(4) + '%（0.1848）  p90 ' + best.m.p90.toFixed(2) +
  '（3.35）  p99 ' + best.m.p99.toFixed(2) + '（8.30）');
console.log('  -> 梯度 ' + best.ratio.toFixed(2) + 'x（2.56）  自相关 ' + best.m.ac1.toFixed(3) + '（0.12）');
console.log('');
console.log('=== 写回 game.js 的 P ===');
console.log('  CITY_AMP_A: ' + best.CA + '   CITY_K: ' + (1 / Math.pow(1.6, best.CA)).toFixed(4));
console.log('  TREND_K: ' + best.TK);
console.log('  ' + LK.map(k => k + ': ' + (+(P0[k] * best.s).toFixed(3))).join('\n  '));