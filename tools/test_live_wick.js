'use strict';
/* 未收盘那根 K 线（forming bar）的**状态机**测试 —— 重写版。
 *
 * 上一版我测错了两件事，这里改掉：
 *   ① 测"影线宽度单调"是错的 —— 蜡烛收在最高处时上影本来就该是 0。
 *      真正必须单调的是 **h/l 极值本身**（价格回头不能取消已触及的极值）。
 *   ② 用"同一个 u 反复调 liveAt()"当输入是错的 —— 那不是在模拟行情推进。
 *      状态机的正确输入是**一序列采样**，所以这里按 u 逐步推进。
 *
 * 用法：node tools/test_live_wick.js      退出码 0 = 全部通过
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
  fetch: () => Promise.reject(new Error('probe: 不联网')), localStorage: { getItem: () => null, setItem() {} },
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

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const PERIODS = [[6, '1 日'], [5, '4 时'], [4, '1 时'], [3, '30 分'], [2, '15 分']];

/* 换档必须重新 resample，否则 series 还是上一档的 */
function usePeriod(bi, gi) {
  G.barIdx = bi;
  const rs = T.resample(G.base, pk.baseSeeds, pk.baseReg);
  G.series = rs.series; G.seeds = rs.seeds;
  G.i = gi;
  T.fbReset();                      // 换档 = 换了一整套时间轴，形成中状态必须清掉
  return rs.series;
}

console.log('① u=0 退化成一个点（影线为 0）');
console.log('② 极值 h/l 单调 —— 价格回头不许取消已触及的极值');
console.log('③ u=1 精确等于真 K 线');
console.log('④ 乱序 / 重复推进也自洽（采样游标只进不退）');
console.log('⑤ 不带 4 时档之类的抖动：h/l 的每一步变化都不回头\n');

for (const [bi, nm] of PERIODS) {
  for (const gi of [30, 31, 32]) {
    const series = usePeriod(bi, gi);
    /* ⚠ live bar 占的是 **series[gi]** 这一格（左邻是 series[gi-1]）——
 取 G.i+1，
       最后一格被 live bar 替换掉，所以目标就是 series[gi]，不是 series[gi+1]。
       我第一版断言写成了 series[gi+1]，重构后 45 项全假失败。 */
    const real = series[gi];
    const STEPS = 300;
    const hs = [], ls = [], cs = [], os = [];
    for (let k = 0; k <= STEPS; k++) {
      G.acc = k / STEPS;
      const L = T.liveAt();
      if (!L) { hs.push(NaN); ls.push(NaN); cs.push(NaN); os.push(NaN); continue; }
      hs.push(L.h); ls.push(L.l); cs.push(L.c); os.push(L.o);
    }
    const tag = nm + ' G.i=' + gi;

    // ① u=0：一个点
    check(tag + '  u=0 是点（h=l=c=o）',
      Math.abs(hs[0] - os[0]) < 1e-9 && Math.abs(ls[0] - os[0]) < 1e-9,
      'h=' + hs[0].toFixed(3) + ' l=' + ls[0].toFixed(3) + ' o=' + os[0].toFixed(3));

    // ② 极值单调
    let badH = -1, badL = -1;
    for (let i = 1; i < hs.length; i++) {
      if (hs[i] < hs[i - 1] - 1e-9 && badH < 0) badH = i;
      if (ls[i] > ls[i - 1] + 1e-9 && badL < 0) badL = i;
    }
    check(tag + '  极值 h 单调不减', badH < 0,
      badH >= 0 ? ('第 ' + badH + ' 步：' + hs[badH - 1].toFixed(4) + '→' + hs[badH].toFixed(4)) : '');
    check(tag + '  极值 l 单调不增', badL < 0,
      badL >= 0 ? ('第 ' + badL + ' 步：' + ls[badL - 1].toFixed(4) + '→' + ls[badL].toFixed(4)) : '');

    // ③ u=1 精确
    check(tag + '  u=1 精确等于真值',
      Math.abs(hs[STEPS] - real.h) < 1e-6 && Math.abs(ls[STEPS] - real.l) < 1e-6 && Math.abs(cs[STEPS] - real.c) < 1e-6,
      'live ' + hs[STEPS].toFixed(4) + '/' + ls[STEPS].toFixed(4) + '/' + cs[STEPS].toFixed(4) +
      '  真值 ' + real.h.toFixed(4) + '/' + real.l.toFixed(4) + '/' + real.c.toFixed(4));

    /* ⑥ TradingView 的两条不变量（用户报的"最新那根像独立出去的"就是这两条被破坏）：
          · 相邻**两根**之间：open[i+1] === close[i]
          · 极值必须包住实体：l ≤ min(o,c) 且 h ≥ max(o,c)

       ⚠ 注意**不能**拿"同一根内相邻两帧"去比 open 与上一帧的 close ——
         同一根未收盘蜡烛的收盘价本来就会被每个新样本**修订**（实测 1003.60 → 1004.01），
         这正是 lightweight-charts "same time ⇒ replace the existing item" 的语义。
         我第一版断言就是这么写错的，那 12 个"失败"全是假报警。
         真正要守的是**两根之间的接缝**。 */
    // 接缝：live bar 占 series[gi] 这一格，所以它的左邻是 series[gi-1]：
    //   liveBar.o 必须 === series[gi-1].c（这就是用户报的"跟左边接不上"）
    check(tag + '  接缝：open === 左邻 series[gi-1].c',
      Math.abs(os[0] - series[gi - 1].c) < 1e-9,
      'o=' + os[0].toFixed(4) + '  series[' + (gi - 1) + '].c=' + series[gi - 1].c.toFixed(4) +
      '   (G.i=' + G.i + ')');
    check(tag + '  接缝：收完的 close === series[gi].c',
      Math.abs(cs[STEPS] - real.c) < 1e-9,
      'c=' + cs[STEPS].toFixed(4) + '  真值 ' + real.c.toFixed(4));

    let envBad = -1;
    for (let i = 0; i < hs.length; i++) {
      if (!isFinite(hs[i])) continue;
      if (ls[i] > Math.min(os[i], cs[i]) + 1e-9 || hs[i] < Math.max(os[i], cs[i]) - 1e-9) { envBad = i; break; }
    }
    check(tag + '  极值包住实体（l ≤ min(o,c) ≤ max(o,c) ≤ h）', envBad < 0,
      envBad >= 0 ? ('第 ' + envBad + ' 步 o=' + os[envBad].toFixed(4) + ' h=' + hs[envBad].toFixed(4) +
                     ' l=' + ls[envBad].toFixed(4) + ' c=' + cs[envBad].toFixed(4)) : '');

    // ④ 重复推进 / 回退再推进，结果必须与顺序推进一致
    T.fbReset();
    for (let k = 0; k <= STEPS; k++) { G.acc = k / STEPS; T.liveAt(); }
    const seqH = T.liveAt().h, seqL = T.liveAt().l;
    T.fbReset();
    const probes = [0.9, 0.2, 0.5, 0.5, 0.7, 0.1, 1.0, 0.3];
    for (const q of probes) { G.acc = q; T.liveAt(); }
    for (let k = 0; k <= STEPS; k++) { G.acc = k / STEPS; T.liveAt(); }
    const mixH = T.liveAt().h, mixL = T.liveAt().l;
    check(tag + '  乱序推进后与顺序推进一致', Math.abs(seqH - mixH) < 1e-9 && Math.abs(seqL - mixL) < 1e-9,
      'seq ' + seqH.toFixed(4) + '/' + seqL.toFixed(4) + '  mix ' + mixH.toFixed(4) + '/' + mixL.toFixed(4));
  }
}

console.log('\n' + '='.repeat(64));
console.log('forming bar 状态机自检：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(64));

/* ── 附：全 7 档 × 全部进度 的有界性与有限性 ──
   （这两条原来在 tools/test_live_bar.js 里。那个文件是按**旧设计**写的
     —— live bar 占 series[G.i+1]、目标真值是 series[gi+1]。重构后占位改到
     series[G.i]，它的前提全变了、45 项假失败。所以把独有的两条并到这里，
     然后删掉旧文件，避免留一个"看着在测、其实前提是错的"探针。） */
console.log('\n附：全 7 档 × u∈[0,1] 的有界性 / 有限性');
for (const [bi, nm] of [[0, '1 分'], [1, '5 分'], [2, '15 分'], [3, '30 分'],
                        [4, '1 时'], [5, '4 时'], [6, '1 日']]) {
  G.barIdx = bi;
  const rs = T.resample(G.base, pk.baseSeeds, pk.baseReg);
  G.series = rs.series; G.seeds = rs.seeds; G.i = 30;
  T.fbReset();
  let bad = '';
  for (let k = 0; k <= 200 && !bad; k++) {
    G.acc = k / 200;
    const L = T.liveAt();
    if (!L) { bad = 'liveAt 返回 null'; break; }
    if (!isFinite(L.h) || !isFinite(L.l) || !isFinite(L.c) || !isFinite(L.o)) bad = 'NaN';
    else if (L.h < Math.max(L.o, L.c) - 1e-9) bad = 'h < max(o,c)';
    else if (L.l > Math.min(L.o, L.c) + 1e-9) bad = 'l > min(o,c)';
    else if (L.h < L.l - 1e-9) bad = 'h < l';
  }
  check(nm + ' 有界且有限（l ≤ min(o,c) ≤ max(o,c) ≤ h）', !bad, bad);
}

console.log('\n' + '='.repeat(64));
console.log('合计：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);
