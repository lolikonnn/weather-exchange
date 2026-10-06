'use strict';
/* 用真代码 + 真天气导出「操盘手」行情序列，供 tools/analyze_crypto.py 与真实交易所对拍。
 *
 * 关键点：**不重写公式**。这里 load 的就是 web/js/game.js，调的是它导出的
 * Game._t.pickSeries —— 也就是玩家实际跑的那个函数。任何"在 Python 里复刻一遍"的做法
 * 都会漂（我试过，复刻版单根 1.08%，真代码 0.19%，差 5 倍，因为复刻不出真天气的 sev 分布）。
 *
 * 用法：
 *   python tools\fetch_weather.py          # 先备好 data/crypto/weather_*.json
 *   node tools\export_game_series.js       # -> data/crypto/_game_*.json
 *   python tools\analyze_crypto.py --game
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'crypto');
const JS = p => path.join(ROOT, 'web', 'js', p);

/* ───────── 假 DOM（同 tools/test_live_bar.js） ───────── */
function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, title: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, remove() {}, addEventListener() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    closest: () => null, setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 400 }),
    getContext: () => ({}), focus() {}, blur() {}, offsetWidth: 0
  };
}
const doc = {
  body: fakeEl(), documentElement: fakeEl(),
  querySelector: () => fakeEl(), querySelectorAll: () => [],
  getElementById: () => fakeEl(), createElement: () => fakeEl(),
  addEventListener() {}, hidden: false
};

/* pickSeries 的窗口偏置用 Math.random 挑起点：钉住它，标定才可复现
   （仓库 NOTES 里也强调过这一点：「A/B 必须钉住 Math.random」）。 */
let _seed = 0;
function seedRandom(s) { _seed = s >>> 0; }
function rand() {                       // xorshift32，确定性
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 4294967296;
}

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: doc,
  location: { search: '', hostname: '127.0.0.1', protocol: 'http:' },
  navigator: {}, matchMedia: () => ({ matches: false }),
  requestAnimationFrame: () => 0, addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Path2D: function () {}, Image: function () {}, AbortController: function () {},
  fetch: () => Promise.reject(new Error('export: 不联网')),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  echarts: {
    init: () => ({ setOption() {}, on() {}, getZr: () => ({ on() {} }), getWidth: () => 900,
                   resize() {}, dispose() {}, getOption: () => ({ series: [], xAxis: [{ data: [] }] }),
                   convertToPixel: () => 0 }),
    graphic: { LinearGradient: function () {} }, registerMap() {}
  }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.Math = Object.create(Math);
sandbox.Math.random = rand;              // 只替换 random，其余照旧

const ctx = vm.createContext(sandbox);
for (const f of ['util.js', 'indicators.js', 'api.js', 'chart.js', 'weather.js', 'wxui.js',
                 'app.js', 'game.js']) {
  vm.runInContext(fs.readFileSync(JS(f), 'utf8'), ctx, { filename: f });
}

const T = sandbox.Game._t;
const G = sandbox.Game.G;

/* ───────── 读天气样本 ───────── */
const files = fs.readdirSync(DATA).filter(f => /^weather_.*\.json$/.test(f));
if (!files.length) {
  console.error('data/crypto/ 里没有 weather_*.json，先跑 python tools\\fetch_weather.py');
  process.exit(1);
}
const wxName = process.argv[2] || files[0];
const wx = JSON.parse(fs.readFileSync(path.join(DATA, wxName), 'utf8'));
console.log('天气样本: %s (%s)  %d 个 15 分钟时刻  %s',
  wxName, wx.name, wx.minutely.time.length, wx.minutely.time[0]);

// 照 api.js 的 OpenMeteo.minutely() 返回结构，字段名一字不差
const mn = {
  time: wx.minutely.time,
  temp: wx.minutely.temperature_2m,
  gust: wx.minutely.wind_gusts_10m,
  precip: wx.minutely.precipitation,
  wcode: wx.minutely.weather_code,
  cape: wx.minutely.cape,
  dew: wx.minutely.dew_point_2m
};
const air = { time: wx.air.time, pm25: wx.air.pm25 };

/* ───────── 城市分层 ───────── */
/* 权重用 cityWeight() 的真规则反推，等价于拿真 cities.json 的条目去试：
     直辖市 prov='北京市' → 3.0 ｜ 省会（name 以省名开头）→ 2.2
     直辖市 3.0 ｜ 省会 2.2 ｜ 有 cma 站 1.6 ｜ 其余 0.6 */
/* ⚠ 「有 path → 1.2」那一档**已经没有了**：cityWeight 里那条 if (c.path) 是死代码
   （cities.json 每座城都有 path），早就删了。但这份档位表还留着它，
   于是 D_path 和 E_county 权重都是 0.6、跑出来一模一样 —— 不是 bug，是标签没跟上。 */
const CITY_TIERS = [
  { key: 'A_municipality', desc: '直辖市 (w=3.0)', city: { name: '北京', prov: '北京市', lat: 39.81, lon: 116.47, cma: '54511', path: '中国, 北京, 北京' } },
  { key: 'B_capital', desc: '省会 (w=2.2)', city: { name: '广州', prov: '广东省', lat: 23.13, lon: 113.26, cma: '59287', path: '中国, 广东, 广州' } },
  { key: 'C_station', desc: '有国家站的地级市 (w=1.6)', city: { name: '惠州', prov: '广东省', lat: 23.11, lon: 114.42, cma: '59298', path: '' } },
  { key: 'D_path', desc: '其余（无站无省会，w=0.6）', city: { name: '佛山', prov: '广东省', lat: 23.02, lon: 113.12, cma: '', path: '中国, 广东, 佛山' } },
  { key: 'E_county', desc: '区县 (w=0.6)', city: { name: '义乌', prov: '浙江省', lat: 29.31, lon: 120.07, cma: '', path: '', lev: 3 } }
];

const ROUNDS = Number(process.argv[3] || 8);      // 每个分层跑几局（取分布，别只取一局）
const out = {};

for (const t of CITY_TIERS) {
  const w = T.cityWeight(t.city);
  const ds = T.dishScale(t.city);
  const rounds = [];
  const all = [];

  for (let r = 0; r < ROUNDS; r++) {
    seedRandom(1000 + r * 7919);
    let picked = null;
    try {
      picked = T.pickSeries(mn, null, t.city, { air: air, quake: null, typh: null, fcst: null });
    } catch (e) { picked = null; }
    if (!picked || !picked.series || !picked.series.length) continue;
    const seg = picked.series.map(b => [b.t, b.o, b.h, b.l, b.c, 0]);
    rounds.push(seg);
    for (const row of seg) all.push(row);
  }

  if (!all.length) { console.log('  ' + t.desc + ' 取不到序列，跳过'); continue; }

  // ⚠ **绝不能按时间排序**：每局是同一段 92 天里**随机截的窗口**，彼此重叠。
  //   排序会把 8 条价格曲线交错混在一起，相邻两根来自不同窗口、价格水平不同，
  //   于是涨跌幅变成一堆跳变 —— 实测这样量出来的自相关是 −0.48，
  //   看着像"行情在锯齿翻转"，其实是导出方式造成的假象（真实是 +0.185）。
  //   正确做法：保持每局内部的时间顺序，局与局之间**不跨**着算涨跌，
  //   所以下面把每局的根数记下来（bounds），分析器据此切段。
  const bounds = [];
  let acc = 0;
  for (const seg of rounds) { acc += seg.length; bounds.push(acc); }

  const f = path.join(DATA, '_game_' + t.key + '_15m.json');
  fs.writeFileSync(f, JSON.stringify({
    pair: 'GAME/' + t.key, bar: '15m', synthetic: true,
    desc: t.desc, cityWeight: w, dishScale: ds, rounds: rounds.length,
    count: all.length, bounds: bounds, rows: all
  }));
  console.log('  ' + t.desc.padEnd(26) + ' w=' + w.toFixed(2) +
    '  dishScale=' + ds.toFixed(3) + '  局数=' + rounds.length +
    '  根数=' + all.length + '  -> ' + path.basename(f));
}

/* 顺带把 wxgame_bestp 之类无关的噪声排掉：这里只输出序列 */
console.log('\n完成。接下来：python tools\\analyze_crypto.py --game');
