'use strict';
/* 标定「点击做空天气」的系数 —— 用**搜索**代替拍脑袋。
 *
 * 靶子全部来自真实交易所（欧易 9 个对 × 365 天 × 15 分钟，见 tools/analyze_crypto.py）：
 *   ① 波动水平：BTC 单根 |涨跌| 中位 0.0822% ｜ SOL 0.1577% ｜ WIF 0.2541%
 *   ② 城市梯度：WIF/BTC = **3.09×**（这是"大城市像主流币、小城市像山寨币"的量化目标）
 *   ③ 自相关：15 分钟 ≈ +0.022（几乎无记忆）
 *
 * 做法：直接 load web/js/game.js（真代码），改 Game._t.P 里的系数，跑 5 个城市分层，
 * 量同一套指标，报告与靶子的差距。`--search` 会在二维网格上搜最优的
 * (水平缩放 L, 噪声平滑 NOISE_A)。
 *
 * 用法：
 *   node tools/calibrate_game.js              # 打当前系数的成绩单
 *   node tools/calibrate_game.js --search     # 搜最优 (L, NOISE_A)
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const JS = p => path.join(ROOT, 'web', 'js', p);
const DATA = path.join(ROOT, 'data', 'crypto');

/* ── 真值靶子 ── */
const TARGET = {
  med: { big: 0.0822, mid: 0.1577, small: 0.2541 },   // BTC / SOL / WIF，单根 |涨跌| 中位 %
  ratio: 3.09,                                        // WIF / BTC
  ac1: 0.022,
};

/* ── 假 DOM（同 tools/test_live_bar.js） ── */
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

const CITIES = [
  ['直辖市', { name: '北京', prov: '北京市', lat: 39.81, lon: 116.47, cma: '54511' }],
  ['省会', { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287' }],
  ['地级市', { name: '惠州', prov: '广东省', lat: 23.11, lon: 114.42, cma: '59298' }],
  ['区县', { name: '义乌', prov: '浙江省', lat: 29.31, lon: 120.07, cma: '' }],
];

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const pctl = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))];
const ac1 = a => { const m = mean(a), d = a.reduce((s, x) => s + (x - m) ** 2, 0); if (!d) return 0;
  let n = 0; for (let i = 1; i < a.length; i++) n += (a[i] - m) * (a[i - 1] - m); return n / d; };
const kurt = a => { const n = a.length, m = mean(a); const m2 = a.reduce((s, x) => s + (x - m) ** 2, 0) / n;
  if (!m2) return 0; const m4 = a.reduce((s, x) => s + (x - m) ** 4, 0) / n; return m4 / (m2 * m2) - 3; };

/* 跑一个城市分层，返回指标。rounds 局拼起来，但**跨局不算涨跌**。 */
function measure(city, rounds) {
  const rets = [], all = [];
  for (let r = 0; r < rounds; r++) {
    _s = 1000 + r * 7919;
    const pk = T.pickSeries(mn, null, city, { air, quake: null, typh: null, fcst: null });
    if (!pk || !pk.series || pk.series.length < 2) continue;
    const seg = pk.series;
    all.push(...seg.map(b => b.c));
    for (let i = 1; i < seg.length; i++) {
      const prev = seg[i - 1].c;
      if (prev) rets.push((seg[i].c - prev) / prev);
    }
  }
  if (!rets.length) return null;
  const ar = rets.map(Math.abs).sort((a, b) => a - b);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean(rets)) ** 2, 0) / rets.length);
  return {
    n: rets.length,
    med: pctl(ar, 0.5) * 100, p90: pctl(ar, 0.9) * 100, p99: pctl(ar, 0.99) * 100,
    sd: sd * 100, ac1: ac1(rets), kurt: kurt(rets),
  };
}

function score(rounds) {
  const rows = {};
  for (const [nm, c] of CITIES) rows[nm] = measure(c, rounds);
  if (!rows['直辖市'] || !rows['区县']) return { rows, err: 1e9 };
  const ratio = rows['区县'].med / rows['直辖市'].med;
  // 误差：波动水平（对数）+ 梯度（对数）+ 自相关（绝对）
  const eLvl = Math.abs(Math.log(rows['地级市'].med / TARGET.med.mid));
  const eRat = Math.abs(Math.log(ratio / TARGET.ratio));
  const eAc = Math.abs(rows['地级市'].ac1 - TARGET.ac1) * 2;
  return { rows, ratio, err: eLvl + eRat + eAc, eLvl, eRat, eAc };
}

function line(tag, r) {
  return '  ' + tag.padEnd(8) +
    ' 中位 ' + r.med.toFixed(4) + '%' +
    '  p90 ' + r.p90.toFixed(4) + '%' +
    '  p99 ' + r.p99.toFixed(4) + '%' +
    '  自相关 ' + r.ac1.toFixed(3).padStart(6) +
    '  峰度 ' + r.kurt.toFixed(1).padStart(6);
}

function report(title) {
  const s = score(6);
  console.log('\n' + '='.repeat(92));
  console.log(title);
  console.log('='.repeat(92));
  for (const [nm] of CITIES) if (s.rows[nm]) console.log(line(nm, s.rows[nm]));
  console.log('  ' + '-'.repeat(88));
  console.log('  梯度（区县/直辖市）= ' + s.ratio.toFixed(2) + '×   目标 ' + TARGET.ratio + '×' +
    '   偏差 ' + ((s.ratio / TARGET.ratio - 1) * 100).toFixed(0) + '%');
  console.log('  水平（地级市）    = ' + s.rows['地级市'].med.toFixed(4) + '%   目标 ' + TARGET.med.mid +
    '%   偏差 ' + ((s.rows['地级市'].med / TARGET.med.mid - 1) * 100).toFixed(0) + '%');
  console.log('  自相关            = ' + s.rows['地级市'].ac1.toFixed(3) + '      目标 ' + TARGET.ac1);
  console.log('  综合误差 = ' + s.err.toFixed(4) + '  (水平 ' + s.eLvl.toFixed(3) +
    ' + 梯度 ' + s.eRat.toFixed(3) + ' + 自相关 ' + s.eAc.toFixed(3) + ')');
  return s;
}

/* 把 P 恢复到初始值 */
const P0 = Object.assign({}, P);

const args = process.argv.slice(2);
report('当前系数（game.js 里 P 的现状）');

if (args.includes('--search')) {
  console.log('\n' + '='.repeat(92));
  console.log('搜索：水平 L × 城市梯度幂次 A × 趋势权重 T × 噪声平滑 NOISE_A');
  console.log('='.repeat(92));
  /* 为什么 TREND_K 必须一起搜：
     趋势项 (tr−m)×TREND_K 是**慢分量**，它的 lag-1 自相关高达 0.91。
     而所有随机项的自相关都在 0.2 附近、甚至为负（carry 的差分是 −0.08）。
     只压随机项、不动趋势的话，趋势在总波动里的占比反而上升，自相关越调越高 ——
     实测 L 从 0.45 降到 0.15，自相关从 0.186 升到 0.496，就是这个原因。
     但趋势又不能删：它是玩家"骑趋势"赚慢钱的那部分，删了就不是行情了。
     所以把它当**权重**来搜，找"够骑 + 不太成段"的平衡点。 */
  const L_KEYS = ['NOISE_K', 'JUMP_K', 'MICRO_K', 'DISH_K', 'DEW_K', 'REG_K', 'AIR_K',
                  'QUAKE_K', 'TYPHOON_K', 'FCST_K'];
  let best = null;
  for (const L of [0.6, 0.9, 1.2, 1.6, 2.2]) {
    for (const A of [0.35, 0.45, 0.55]) {
      for (const T of [4, 8, 14, 22]) {
        for (const CA of [0.577, 0.75, 0.95]) {
          for (const k of L_KEYS) P[k] = P0[k] * L;
          P.NOISE_A = A;
          P.NOISE_BOOST = Math.sqrt((1 + A) / (1 - A));
          P.CITY_AMP_A = CA;
          P.CITY_K = 1 / Math.pow(1.6, CA);        // 让 dishScale=1.0 那档的 cityAmp 恰好 = 1
          P.TREND_K = T;
          const s = score(4);
          if (!best || s.err < best.err) {
            best = { L, A, T, CA, err: s.err, s };
            console.log('  * L=' + L.toFixed(1) + ' A=' + A + ' T=' + T + ' CA=' + CA +
              '  误差 ' + s.err.toFixed(4) +
              '  水平 ' + s.rows['地级市'].med.toFixed(4) + '%' +
              '  梯度 ' + s.ratio.toFixed(2) + '×' +
              '  自相关 ' + s.rows['地级市'].ac1.toFixed(3));
          }
        }
      }
    }
  }
  console.log('\n最优：L=' + best.L + ' NOISE_A=' + best.A + ' TREND_K=' + best.T +
    ' CITY_AMP_A=' + best.CA + '（误差 ' + best.err.toFixed(4) + '）');
  for (const k of L_KEYS) P[k] = P0[k] * best.L;
  P.NOISE_A = best.A;
  P.NOISE_BOOST = Math.sqrt((1 + best.A) / (1 - best.A));
  P.CITY_AMP_A = best.CA;
  P.CITY_K = 1 / Math.pow(1.6, best.CA);
  P.TREND_K = best.T;
  report('最优参数下的成绩单');
  console.log('\n把下面这些写回 game.js 的 P：');
  console.log('  ' + L_KEYS.map(k => k + ': ' + (+P[k].toFixed(3))).join('\n  '));
  console.log('  NOISE_A: ' + P.NOISE_A.toFixed(3));
  console.log('  NOISE_BOOST: ' + P.NOISE_BOOST.toFixed(3));
  console.log('  CITY_AMP_A: ' + P.CITY_AMP_A.toFixed(3));
  console.log('  CITY_K: ' + P.CITY_K.toFixed(3));
  console.log('  TREND_K: ' + P.TREND_K + '   ← 这个原本不在 P 里，是模块级常量，改动时要一并挪进 P');
}
