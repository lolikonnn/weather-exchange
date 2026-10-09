'use strict';
/* tools/probe_astro.js —— 量「给模拟游戏加天文变量（月光 + 流星雨）」到底改了什么。
 *
 * 使用者问：「现在新添加了天文等模块，那么模拟游戏是否可以加入更多的变量使曲线变化
 * 更加夸张具有戏剧性？」—— 这个探针就是回答"加上之后戏剧性变了多少"的。
 *
 * 分两段：
 *   A. **合成数据**（确定性的）：造一段盖住 2026-12-14 双子座极大夜的 15 分钟序列，
 *      断言 —— 晴天时流星雨项真的在极大夜隆起、雨名是双子座；改成大雾（wcode 45）
 *      必须归零（看不见就是看不见）。
 *   B. **真数据**（`tmp/wx_gz.json`，广州 2026-07-09 ~ 10-09，含英仙座 8/13、宝瓶座 7/30）：
 *      同一批随机种子各跑一遍 **开/关天文项**，对比收益率分布的 p50/p90/p99/max ——
 *      也就是"戏剧性"（尾部）到底有没有变厚。
 *
 * 用法：node tools/probe_astro.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const JS = p => path.join(ROOT, 'web', 'js', p);

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
// astro.js 必须在 wxui/app/game 之前 —— 那三个都要用 global.ASTRO
for (const f of ['util.js', 'indicators.js', 'api.js', 'chart.js', 'weather.js', 'astro.js', 'wxui.js', 'app.js', 'game.js'])
  vm.runInContext(fs.readFileSync(JS(f), 'utf8'), ctx, { filename: f });
const T = sb.Game._t;
const A = sb.ASTRO;

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) pass++; else fail++;
  console.log('   ' + (c ? '✓' : '✗ **失败**') + ' ' + label + (extra ? '   ' + extra : ''));
  return c;
};
const CITY = { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' };
const NEED = T.srcBars();
console.log('srcBars() = ' + NEED + ' 根（15 分钟）');

/* ── A. 合成数据：双子座极大夜 ── */
console.log('');
console.log('① 合成数据：盖住 2026-08-13 英仙座极大夜');
function synth(t0Ms, n, wcode) {
  const time = [], temp = [], gust = [], precip = [], wcv = [], cape = [], dew = [];
  for (let i = 0; i < n; i++) {
    const ms = t0Ms + i * 900000;
    const d = new Date(ms);
    const p2 = v => (v < 10 ? '0' : '') + v;
    time.push(d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()));
    const hh = d.getHours() + d.getMinutes() / 60;
    temp.push(+(20 + 6 * Math.sin((hh - 9) / 24 * Math.PI * 2)).toFixed(1));
    gust.push(3); precip.push(0); wcv.push(wcode); cape.push(0); dew.push(10);
  }
  return { time, temp, gust, precip, wcode: wcv, cape, dew };
}
/* 起点放在 08-11 00:00、长度只比一个窗口多一点 ⇒ 随机截出来的每一窗都盖住 8/13。
   ⚠ 必须是**过去**的日期：`pickSeries` 里 `i0 = mn.time.findIndex(t => t >= nowLocalStr())`，
   而且窗口校验要求整窗 `mn.time[s+j] < now` —— 我一开始写的是 2026-12-12（双子座），
   相对"现在"整个落在未来，24 次候选全被否掉，`pickSeries` 直接返回 null。 */
const t0 = new Date(2026, 7, 11, 0, 0, 0).getTime();
const clear = synth(t0, NEED + 8, 0);
const fog = synth(t0, NEED + 8, 45);

T.setDbgComp(true);
/* ⚠ 这里**不要手写系数** —— 探针第一版写死 `T.P.METEOR_K = 16`，后来把源码默认值
   调到 40，探针照旧报 4.31，白测一轮。系数一律从 `T.P` 现取，测的就是要发布的那套值。 */
const MK = T.P.METEOR_K, MK_MOON = T.P.MOON_K, MK_FLOW = T.P.METEOR_FLOW;
const setAstro = on => {
  T.P.METEOR_K = on ? MK : 0;
  T.P.MOON_K = on ? MK_MOON : 0;
  T.P.METEOR_FLOW = on ? MK_FLOW : 0;
};
console.log('   系数：METEOR_K ' + MK + '  MOON_K ' + MK_MOON + '  METEOR_FLOW ' + MK_FLOW);
setAstro(true);
_s = 4242;
const pClear = T.pickSeries(clear, null, CITY, { air: null, quake: null, typh: null, fcst: null });
ok(!!pClear, '晴天那一段能出序列');
if (pClear) {
  const met = pClear.seeds.map(s => s.meteor || 0);
  const maxMet = Math.max.apply(null, met);
  const names = {};
  pClear.seeds.forEach(s => { if (s.mname) names[s.mname] = (names[s.mname] || 0) + 1; });
  const maxMoon = Math.max.apply(null, pClear.seeds.map(s => s.moon || 0));
  console.log('   meteor 峰値 ' + maxMet.toFixed(2) + '，雨名 = ' + JSON.stringify(Object.keys(names)) +
    '，moon 峰値 ' + maxMoon.toFixed(2));
  ok(maxMet > 1, '极大夜里流星雨项真的隆起', 'max ' + maxMet.toFixed(2));
  ok(Object.keys(names).some(n => n.indexOf('英仙座') >= 0), '报出来的雨名是英仙座', Object.keys(names).join(','));
  ok(typeof pClear.seeds[0].moon === 'number', 'seeds 里带 moon 字段');
  ok(typeof pClear.seeds[0].mname === 'string', 'seeds 里带 mname 字段');
}
_s = 4242;
const pFog = T.pickSeries(fog, null, CITY, { air: null, quake: null, typh: null, fcst: null });
if (pFog) {
  const maxFog = Math.max.apply(null, pFog.seeds.map(s => s.meteor || 0));
  ok(maxFog === 0, '大雾天（wcode 45）流星雨项必须归零', 'max ' + maxFog.toFixed(2));
} else ok(false, '大雾那段也能出序列');

/* ── B. 真数据：开/关天文项，对比尾部 ── */
console.log('');
console.log('② 真数据（广州 92 天）：同一批种子，开/关天文项对比');
const FX = path.join(ROOT, 'tmp', 'wx_gz.json');
let done = false;
if (fs.existsSync(FX)) {
  const wx = JSON.parse(fs.readFileSync(FX, 'utf8')).minutely;
  const mn = { time: wx.time, temp: wx.temperature_2m, gust: wx.wind_gusts_10m,
    precip: wx.precipitation, wcode: wx.weather_code, cape: wx.cape, dew: wx.dew_point_2m };
  const pct = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
  const rets = base => { const r = []; for (let i = 1; i < base.length; i++) r.push(Math.abs(base[i].c - base[i - 1].c) / base[i - 1].c * 100); return r; };
  const ON = [], OFF = [], metPeak = [];
  let hitWin = 0, win = 0;
  for (let r = 0; r < 20; r++) {
   try {
    _s = 90001 + r * 7919;
    setAstro(true);
    const pOn = T.pickSeries(mn, null, CITY, { air: null, quake: null, typh: null, fcst: null });
    _s = 90001 + r * 7919;
    setAstro(false);
    const pOff = T.pickSeries(mn, null, CITY, { air: null, quake: null, typh: null, fcst: null });
    if (!pOn || !pOff || !pOn.base) continue;
    win++;
    ON.push.apply(ON, rets(pOn.base));
    OFF.push.apply(OFF, rets(pOff.base));
    const mp = Math.max.apply(null, pOn.seeds.map(s => s.meteor || 0));
    metPeak.push(mp);
    if (pOn.seeds.some(s => s.mname)) hitWin++;
   } catch (e) { console.log('   第 ' + r + ' 窗抛错：' + (e && (e.stack || e.message))); }
   if (r % 5 === 4) console.log('   …已跑 ' + (r + 1) + ' 窗，累计 ' + ON.length + ' 根');
  }
  setAstro(true);
  done = true;
  const line = (nm, a) => '   ' + nm + '  p50 ' + pct(a, .5).toFixed(4) + '%  p90 ' + pct(a, .9).toFixed(4) +
    '%  p99 ' + pct(a, .99).toFixed(4) + '%  max ' + Math.max.apply(null, a).toFixed(3) + '%';
  console.log(line('开天文 ', ON));
  console.log(line('关天文 ', OFF));
  const r90 = pct(ON, .9) / pct(OFF, .9), r99 = pct(ON, .99) / pct(OFF, .99);
  console.log('   尾部倍数：p90 ×' + r90.toFixed(3) + '   p99 ×' + r99.toFixed(3) +
    '   命中流星雨的窗口 ' + hitWin + '/' + win + '   单窗 meteor 峰值中位 ' + pct(metPeak, .5).toFixed(2));
  ok(win >= 10, '有足够多的窗口能对比', win + ' 窗');
  ok(ON.length === OFF.length, '开/关两组样本数一致（同种子配对）', ON.length + ' 根');
  ok(hitWin > 0, '这批真数据里确实有窗口盖住流星雨极大', hitWin + '/' + win);
  ok(Math.max.apply(null, metPeak) > 1, '流星雨项在真数据里也能起到量级', '单窗峰值 max ' + Math.max.apply(null, metPeak).toFixed(2));
} else {
  console.log('   （没有 tmp/wx_gz.json，跳过真数据对比）');
}
T.setDbgComp(false);
void A;
console.log('');
console.log('═══ 天文变量探针：' + pass + ' 通过 / ' + fail + ' 失败 ═══');
process.exit(fail ? 1 : 0);
