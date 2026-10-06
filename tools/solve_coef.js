'use strict';
/* 结构参数搜索 + 水平解析求解。
 *
 * 关键认识（来自 tools/solve_coef.js 的实测）：
 *   价格 = 趋势项 + 随机项，两部分的 σΔ 与 ρ1 是**可加**的：
 *     σΔ² = (TREND_K·aT)² + (L·aR)²        （aT/aR 是单位系数下的幅度）
 *     ρ1  ≈ Σ w_i²·ρ_i + 2·w_i·w_j·ρ_ij    （w 是方差占比）
 *   所以只有**结构参数**（EMA_A 决定趋势的粗糙度、以及趋势/随机的相对权重）
 *   会影响 ρ1；而**整体水平**由一个缩放 L 线性决定。
 *   → 两维网格搜结构参数（15 组，秒级），L 用解析式直接解，不用搜。
 *
 * 用法：node tools/solve_coef.js
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
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
const ac1 = a => { const m = mean(a), d = a.reduce((s, x) => s + (x - m) ** 2, 0); if (!d) return 0;
  let n = 0; for (let i = 1; i < a.length; i++) n += (a[i] - m) * (a[i - 1] - m); return n / d; };
const diff = a => { const o = []; for (let i = 1; i < a.length; i++) o.push(a[i] - a[i - 1]); return o; };

/* ── 靶子（真实欧易 15 分钟）── */
const GOAL = {
  level: 0.1577,      // SOL 单根 |涨跌| 中位 % —— 中位档（地级市）对齐它
  ratio: 3.09,        // WIF/BTC 梯度
  ac1: 0.10,          // 目标自相关。真实 15m ≈ 0.02，但那是**有效市场**的数；
                      // 游戏不能没有可骑的趋势，取 0.10 作为"有方向感但不假"的折中。
};
const META = '地级市';
const CITY_META = { name: '惠州', prov: '广东省', lat: 23.11, lon: 114.42, cma: '59298' };
const CITY_BIG = { name: '北京', prov: '北京市', lat: 39.81, lon: 116.47, cma: '54511' };
const CITY_SMALL = { name: '义乌', prov: '浙江省', lat: 29.31, lon: 120.07, cma: '' };

/** 在当前 P 下，把一个城市的序列拆成 trend / rand 两支（都含各自系数） */
function parts(city, n) {
  T.setDbgComp(true);              // ⚠ 不打开的话 pk.comp 是 null（踩过一次）
  const tt = [], rr = [];
  for (let k = 0; k < n; k++) {
    _s = 1000 + k * 7919;
    const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
    if (!pk || !pk.comp) continue;
    tt.push(...diff(pk.comp.map(o => o.trend)));
    rr.push(...diff(pk.comp.map(o => o.noise + o.carry + o.reg + o.dew + o.dish + o.micro
      + o.air + o.quake + o.typh + o.fcst)));
  }
  return { tt, rr };
}

/* 一次局里"中位 / σΔ"的换算比（分布形状决定，结构变了要重量） */
function medRatio(city) {
  _s = 1000;
  const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
  const c = pk.series.map(b => b.c);
  const r = []; for (let i = 1; i < c.length; i++) r.push((c[i] - c[i - 1]) / c[i - 1]);
  const ar = r.map(Math.abs).sort((a, b) => a - b);
  return (ar[ar.length >> 1] * 100) / (sd(r) * 100);
}

console.log('结构搜索：EMA_A（趋势粗糙度）× TREND_K（趋势权重）');
console.log('水平缩放 L 不搜 —— 由「中位档 σΔ 必须满足水平对齐」解析求出\n');
console.log('  ' + 'EMA_A'.padEnd(7) + 'TREND_K'.padEnd(9) + 'σΔT/σΔR'.padEnd(11) +
            'ρ1(合成)'.padEnd(10) + 'L'.padEnd(9) + '趋势方差占比');

const P0 = Object.assign({}, P);
let best = null;
const rows = [];
for (const A of [0.05, 0.10, 0.18, 0.30, 0.45]) {
  for (const TK of [20, 35, 50, 80]) {
    P.NOISE_A = P0.NOISE_A;        // 这两维先不动，只看结构
    P.TREND_K = TK;
    P.EMA_A = A;
    const pm = parts(CITY_META, 3);
    if (!pm.tt.length) { console.log('  [dbg] A=' + A + ' TK=' + TK + ' parts 为空'); continue; }
    const sdt = sd(pm.tt), sdr = sd(pm.rr);
    const rt = ac1(pm.tt), rr2 = ac1(pm.rr);
    const kSig = medRatio(CITY_META);
    const wantSigma = GOAL.level / kSig;                 // 需要多少价格单位 σΔ
    // σΔ² = (sdt·TK/当前TK)² ... 这里 sdt 已是 TK 下的实测，直接按比例缩放
    const sdtAt50 = sdt * (50 / TK);
    const st = sdtAt50 * (TK / 50);                   // = sdt，保持直观
    const need2 = wantSigma * wantSigma - st * st;
    if (need2 <= 0) { rows.push([A, TK, sdt / sdr, NaN, NaN, 1]); continue; }
    const L = Math.sqrt(need2) / sdr;
    const wt = (st * st) / (wantSigma * wantSigma), wr = 1 - wt;
    // 交叉项目前没直接量，用 (ρt+ρr)/2 近似
    const rho = wt * rt + wr * rr2 + 2 * Math.sqrt(wt * wr) * (rt + rr2) / 2;
    rows.push([A, TK, sdt / sdr, rho, L, wt]);
    console.log('  ' + String(A).padEnd(7) + String(TK).padEnd(9) +
      (sdt / sdr).toFixed(3).padStart(8) + '   ' +
      rho.toFixed(3).padStart(6) + '    ' +
      L.toFixed(4).padStart(7) + '   ' +
      (wt * 100).toFixed(1).padStart(6) + '%' +
      (Math.abs(rho - GOAL.ac1) < 0.05 ? '   ← 接近' : ''));
    const err = Math.abs(rho - GOAL.ac1);
    if (!best || err < best.err) best = { A, TK, L, rho, err, wt };
  }
}

/* ── 梯度：结构定下来之后，cityAmp 幂次单独解 ── */
P.EMA_A = best.A; P.TREND_K = best.TK;
function medAt(city) {
  const pm = parts(city, 3);
  if (!pm.tt.length) return null;
  const sdt = sd(pm.tt), sdr = sd(pm.rr);
  const st = sdt, sr = sdr * best.L;
  return Math.sqrt(st * st + sr * sr);
}
const sdBig = medAt(CITY_BIG), sdSmall = medAt(CITY_SMALL), sdMeta = medAt(CITY_META);
console.log('\n  ── 梯度 ──');
console.log('  σΔ：大城市 ' + sdBig.toFixed(3) + '  中位 ' + sdMeta.toFixed(3) + '  小城市 ' + sdSmall.toFixed(3));
console.log('  当前梯度（小/大）= ' + (sdSmall / sdBig).toFixed(3) + '×   目标 ' + GOAL.ratio + '×');

console.log('\n  ── 结论 ──');
console.log('  结构：EMA_A = ' + best.A + '   TREND_K = ' + best.TK +
  '   （趋势方差的 ' + (best.wt * 100).toFixed(1) + '%，合成 ρ1 = ' + best.rho.toFixed(3) + '）');
const LK = ['NOISE_K', 'JUMP_K', 'MICRO_K', 'DISH_K', 'DEW_K', 'REG_K', 'AIR_K', 'QUAKE_K', 'TYPHOON_K', 'FCST_K'];
console.log('  水平：随机项统一 × ' + best.L.toFixed(4));
console.log('    ' + LK.map(k => k + ': ' + (+(P0[k] * best.L).toFixed(3))).join('\n    '));
console.log('  TREND_K: ' + best.TK + '   EMA_A: ' + best.A);
