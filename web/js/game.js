/* ═══════════════════════════════════════════════════════════════
   game.js — 「点击做空天气」：拿真实天气当行情，15 分钟一根 K 线
   ═══════════════════════════════════════════════════════════════

   设计要点（改之前先读）：

   ① **标的是「天气指数 WXI」，不是气温本身**。
      这里踩过一次坑：第一版直接拿气温当价格，结果被吐槽「太稳定了，没有
      什么感觉，只要稳住总会升 / 降的」—— 因为气温有昼夜循环和季节趋势，
      抱着不动就能赢，盘感无从谈起。
      气温一小时才挪一两度，做成 K 线就是一条几乎水平的线。
      真正有波动的是**对流**：CAPE（对流有效位能）能从 0 冲到 5000、
      阵风能从 2 m/s 冲到 60 m/s、降水绝大多数时刻是 0、打雷时才爆。
      所以指数由这几项加权而成，**打雷下雨 = 拉升，天气转好 = 回落**。

   ② **价格是「趋势 + 噪声 + 突发行情」的组合**，不是原始指数：
          trend = EMA(sev, 0.05)                       // 慢分量，给方向
          shock = (|Δsev| − 0.9) × 34,  仅当 |Δsev| > 0.9 // 单根剧烈变化 → 一记冲击
          carry = carry × 0.78 + shock                 // 冲击的余波，顺着惯性再走几根
          price = 1000 + (trend − median(trend)) × 50  // 趋势放大，走得出行情
                       + (sev − trend) × 16            // 快分量，给盘中抖动
                       + carry                         // 突发行情
      系数是拿真数据调出来的（广州 / 哈尔滨 92 天实测）：
      单根 15 分钟中位涨跌 0.17%、p99 约 5~6%、单日振幅中位 9~11%、
      连续 3 根的最大跌幅中位 7.8%（哈尔滨能到 15%）。既走得动，又不会变成纯随机数。

      **`shock` 不是随机数** —— 触发条件是真实观测到的剧烈变化（CAPE 炸了、
      阵风猛增、开始下暴雨）。没有真实天气过程的时候，盘面就是平静的；
      久留美里那种「蜡烛图突然拉到底」，背后是真有一次对流爆发。

   ③ **行情是真的，但只有「K 线实体」是真采样出来的**。
      数据是 Open-Meteo 的 minutely_15（15 分钟一个点，92 天历史）。
      开盘价 = 上一根收盘价，收盘价 = 本根指数，这两个都是真值；
      上下影线按 |本根涨跌| × 0.3 建模 —— 15 分钟粒度拿不到根内的真实最高最低，
      只能这样近似。README 里写明了，别对外说影线也是实测。

   ④ **只用「现在」之前的段**。`i0` 是当前时刻在数组里的下标，取样只在其前，
      绝不碰预报段。界面上只显示「第 3 天 14:15」，不给真实日期 —— 否则
      一查历史就知道后面怎么走。

   ⑤ **爆仓是真爆**。权益跌破「占用保证金 × MAINTAIN」就强平，不是"亏光本金"
      那种假爆仓。满仓 + N 倍杠杆时反向走 (1−10%)/N 就没了：5 倍约 18%、
      10 倍约 9%、20 倍约 4.5%、50 倍约 1.8%、100 倍约 0.9%。
      按指数 1000 点算，100 倍只要反向 9 个点。

   ⑥ **只画最近一屏**。一局 672 根（15 分钟档、7 天），全塞进 1300px 的话一根才 1.9px，
      蜡烛会糊成一条线。所以按容器宽度算可视根数并跟着行情自动滑动 ——
      真实的操盘软件也是这么做的。
*/
(function (global) {
  'use strict';
  const { $, el, storeGet, storeSet, toast } = U;

  /* ═══════════════ 合约与规则 ═══════════════ */
  // 本金可以在开场卡片里改，而且**真的会改变难度**（见 cashTip 的注释）：
  // 手续费有 5 元保底、滑点随名义金额上涨、小城市盘子更小。
  // 本金翻 10 倍，手数也翻 10 倍，**仓位盈亏比例**那条仍然成立 ——
  // 但成本占本金的比例会随本金一起涨，所以"钱多"是把双刃剑。
  const DEF_CASH   = 300000;   // 默认本金（群里说"久留美都有三十万"，那就三十万）
  const CASH_MIN   = 1000;
  const CASH_MAX   = 100000000;
  const CASH_PRESETS = [100000, 300000, 1000000, 3000000, 10000000];
  const LOT_MULT   = 10;       // 1 手 × 指数每动 1 点 = 10 元
  const FEE_RATE   = 0.0005;   // 单边手续费，万分之五
  const FEE_MIN    = 5;        // 单笔最低手续费（对齐参考软件那句"单笔不足 5 元按 5 元收"）
  // 滑点：名义金额越大越难在你要的价位成交。
  // `slipOf()` 里 滑点(点) = SLIP_K × 名义金额 ÷ (CAP_BASE ÷ dishScale(城市))。
  // CAP_BASE = 300 万是「广州这类城市的盘子容量」的基准；小城市 capacity 更小、滑点更大。
  // 典型值：30 万本金 / 30% 仓 / 10 倍 → 名义 90 万 → 约 0.09%；300 万本金 → 约 0.9%。
  //
  // **SLIP_MAX 这个上限是必须有的。** 滑点按名义金额算，而 名义金额 = 本金 × 仓位% × 杠杆，
  // 所以滑点随杠杆**平方**增长：30 万本金、满仓、100 倍时名义 3 亿，滑点会算到 300 点 ——
  // 比 100 倍那条 0.9% 的爆仓线还远，等于"一开仓必爆"。截图真的逮到过
  // 「本金 30 万 · 滑点 ¥896,939」这种荒唐数字。
  //
  // 上限取 **10 点（指数的 1%）** 是折中：300 万本金 / 30% 仓 / 10 倍算出来是 9.54 点，
  // 刚好没被削到，所以**设计工作区间内「本金 ×10 → 成本占本金 ×10」这条线性还在**；
  // 再往上（1000 万，或任何 100 倍满仓）就被封在 10 点，
  // 表现为"一开仓就归零"而不是"欠下比本金还多的滑点"。
  const SLIP_K     = 3;
  const SLIP_MAX   = 10;
  const CAP_BASE   = 3000000;
  const MAINTAIN   = 0.10;     // 维持保证金率：权益 ≤ 占用保证金 × 10% 就强平
  const BASE       = 1000;     // 指数基准
  const TREND_K    = 50;       // 趋势分量放大倍数
  const NOISE_K    = 16;       // 快分量放大倍数
  const EMA_A      = 0.05;     // 趋势 EMA 系数（半衰期约 14 根 = 3.5 小时）
  const WICK_K     = 0.30;     // 影线 = |本根涨跌| × 这个系数
  // 突发行情：单根 15 分钟里 severity 变化超过 JUMP_AT 个稳健标准差才算"剧烈变化"，
  // 超出的部分乘 JUMP_K 变成冲击，再按 JUMP_DECAY 衰减出余波（见 pickSeries）。
  const JUMP_AT    = 0.9;
  const JUMP_K     = 34;
  const JUMP_DECAY = 0.78;
  const ROUND_DAYS = 7;        // 一局模拟 7 天（原来是 10 天）
  /* K 线周期档位（分钟）。**15 分钟是数据源的真实粒度**：Open-Meteo 的 minutely_15
     已经是最细的免费粒度了（minutely_1 / minutely 参数照收、HTTP 200，但 time 数组
     长度是 0，只看状态码发现不了）。所以：
       · ≥15 分钟（15/30/45/60）→ 把真数据**聚合**起来（30 = 2 根、45 = 3 根、60 = 4 根）
       · <15 分钟（1/5）→ 把每根 15 分钟**插值展开**（1 分钟 = 展开成 15 根）
     也就是说 1 分钟和 5 分钟档上那些细碎波动是**建模的、不是采到的**，README 写明了。 */
  const BAR_MIN    = [1, 5, 15, 30, 45, 60];
  const BAR_N      = ['1 分钟', '5 分钟', '15 分钟', '30 分钟', '45 分钟', '60 分钟'];
  const SRC_MIN    = 15;       // 数据源粒度（Open-Meteo minutely_15）
  /* 速度档位的单位是**每真实秒推进多少分钟的天气时间**（一局 = 7 天 = 10080 分钟）。
     所以一局的墙钟时长 = 10080 ÷ 这个数，**与 K 线周期无关**：1 分钟档和 60 分钟档
     看的是同一段天气、同样时长，只是一个看得细、一个看得粗。
     四档对应一局约 11.2 / 7.6 / 3.7 / 1.9 分钟。
     每根 K 线多长时间由 BAR_MIN 决定，所以「每秒几根 K 线」= 这个数 ÷ 周期分钟数，
     1 分钟档 + 狂暴档能到 90 根/秒 —— 那是画不过来的，所以主循环按 TICK_HZ 批处理。 */
  const SPEEDS     = [15, 22, 45, 90];
  const SPEED_N    = ['慢', '悠闲', '正常', '狂暴'];
  const TICK_HZ    = 10;       // 重绘频率上限（Hz）；一次 tick 可以推进多根 K 线
  function perDay()    { return 1440 / BAR_MIN[G.barIdx]; }   // 一天几根
  function roundBars() { return ROUND_DAYS * perDay(); }      // 一局几根
  function srcBars()   { return ROUND_DAYS * 1440 / SRC_MIN; } // 一局要几根 15 分钟源数据
  function barMin()    { return BAR_MIN[G.barIdx]; }          // 当前周期（分钟）
  function roundSecs() { return ROUND_DAYS * 1440 / SPEEDS[G.speedIdx]; } // 一局墙钟秒数

  /* ── 复合标的：标的不是一个城市的天气，而是「大盘 + 本地 + 湿度 + 盘子扰动」 ──
     群里那位说得对：只炒一个城市的对流，盯久了就那点花样。真实市场里你炒的东西
     是被大盘推着走的，所以这里把 15 分钟粒度的**同省区域平均气温**也当成一股力。
     要注意哪几项是真的、哪几项是建模的（README 里也写了）：
       区域项  reg  真数据：Open-Meteo 一次请求同省 8 城 15 分钟气温，等权平均
       湿度项  dew  真数据：minutely_15 的 dew_point_2m（PM2.5 没有 15 分钟产品，不拿它充数）
       盘子项  dish **建模**：带衰减的随机游走，小地方振幅更大（见 cityWeight）
     每一项都是"那一项的异常值 × 一个系数"，异常值用中位数对齐，所以叠加后
     基准仍然是 BASE = 1000。 */
  const REG_K      = 6;        // 区域大盘带动
  const DEW_K      = 5;        // 露点（湿热）项
  const DISH_K     = 3;        // 盘子扰动的基准振幅（再乘 cityWeight 得到的倍率）
  const DISH_DECAY = 0.96;     // 盘子扰动衰减（半衰期约 17 根 ≈ 4 小时）

  /* ── 四个「真数据」压力源：空气质量 / 地震 / 台风 / 预报偏离 ──
     这四个都是群里点名要的，而且**每一项都接了真实数据源**，没有一个是编的：
       空气  air   真数据：air-quality-api 的逐小时 PM2.5（小时级，按小时对齐回放窗口）
       地震  quake 真数据：USGS 按城市半径筛出的真实事件（时刻 / 震级 / 震源深度）
       台风  typh  真数据：中央气象台台风网的真实路径点（时刻 / 经纬度 / 风速 / 气压）
       预报  fcst  真数据：previous-runs 的「事后实测」减去「提前 24 小时发出的预报」
                     —— 也就是**当时那份预报错了多少**，报得越离谱行情越抖。
     但要说清楚**哪部分是真、哪部分是建模**：
       · 事件的**时刻、强度、位置**全部来自上面的真数据源；
       · 「指数往上还是往下」是**建模决策** —— 游戏设定是"指数越高＝当地越糟"
         （开场卡片原话：「打雷下雨 = 拉升，天气转好 = 回落」），
         所以台风和地震都做成**向上**的衰减冲击：出事冲高、随后回落，
         正好是"利好出尽"，玩家追高就要吃余波的亏。
       · 任何一项取不到数据就整项退化成 0，**绝不编数据补位**。
     每一个新项都先做稳健标准化再乘系数，所以叠加后基准仍然是 BASE = 1000。 */
  const AIR_K      = 6;        // ① 空气质量 PM2.5 的慢变量偏置（小时级，整局缓慢推着走）
  const QUAKE_M0   = 3.0;      // ② 低于这个震级不算压力（USGS 的查询下限也是 3.0）
  const QUAKE_K    = 12;       //    每高出 M0 一级、按距离衰减后的冲击点数
  const QUAKE_R    = 700;      //    震中到这个公里数之外就不计入了（与 api.js 的查询半径一致）
  const QUAKE_DECAY = 0.90;    //    余波衰减（半衰期约 6.6 根 ≈ 1.7 小时）
  const TYPHOON_R  = 900;      // ③ 台风中心影响到这个公里数以内才计入
  const TYPHOON_K  = 40;       //    风速/30 × 距离衰减后的冲击点数（台风是持续过程，不额外加余波）
  const FCST_K     = 2;        // ④ 预报偏离系数（实测 − 预报，已做稳健标准化）

  /* 上面这几个系数是量出来的，不是拍的。标尺来自探针实测：
     单根中位涨跌约 2.7 点（0.266%）、整局（672 根）振幅约 250 点（25%）。
     据此定"一次压力事件该有多大"：
       · 地震：M6 @ 400km → 峰值约 15 点；M7 @ 300km → 约 27 点；M4.6 @ 650km
         （北京窗口里真实出现过的那次）→ 约 1.3 点。梯度合理：小震就该几乎看不出来。
       · 台风：45m/s 从 300km 外压过来 → 峰值约 40 点，随距离自然涨落（不额外加余波）。
         北京窗口里真实台风全在 900km 外，所以台风项是 0 —— 这是对的，台风不去北京。
       · 空气：PM2.5 抬到 p90（123）→ +10 点左右；爆表（200+）→ +20 点。
       · 预报：实测−预报落到 2σ → 约 ±16 点（first-cut 取 7 时到过 ±60，太猛，砍到 2）。 */

  const LEVS = [
    { v: 1,   n: '1×',   t: '稳健',   cls: '' },
    { v: 5,   n: '5×',   t: '激进',   cls: '' },
    { v: 10,  n: '10×',  t: '疯狂',   cls: 'lev-danger' },
    { v: 20,  n: '20×',  t: '天台',   cls: 'lev-danger' },
    { v: 50,  n: '50×',  t: '天台没护栏', cls: 'lev-danger' },
    { v: 100, n: '100×', t: '久留美', cls: 'lev-danger' }
  ];

  /* ═══════════════ 运行状态 ═══════════════ */
  const G = {
    open: false,
    running: false,
    ended: false,
    city: null,
    series: [],       // [{ t, o, h, l, c }]，长度 roundBars()
    seeds: [],        // 每根的真实天气读数（CAPE / 阵风 / 降水 / 天气码 / 露点 / 盘子扰动）
    sev: null,        // 本局窗口的本地恶劣度序列（天气日历用）
    regLine: null,    // 区域大盘线（本局窗口那一截）；拿不到大盘时为 null
    regFrom: 0,       // 上面那条线在原始 92 天序列里的起点下标
    regCities: null,  // 组成大盘的城市名
    base: null,       // 15 分钟原样序列（局中换 K 线周期时重采样用）
    baseSeeds: null,
    baseReg: null,
    i: 0,
    price: 0,
    cash0: DEF_CASH,  // 本局本金（开场卡片里可改，局中不可改）
    cash: DEF_CASH,
    pos: 0,           // 净持仓手数，正 = 多
    avg: 0,           // 持仓均价（指数点）
    lev: 10,
    pct: 30,
    speedIdx: 1,
    barIdx: 2,        // K 线周期档位下标（BAR_MIN / BAR_N），默认 15 分钟
    timer: null,
    acc: 0,           // 帧间小数累加器：每帧推进不足一根时的余量（见 tick）
    peak: DEF_CASH,
    maxDD: 0,
    trades: 0,
    slipPaid: 0,      // 本局累计滑点成本（元）—— 本金越大、城市越小，这个数越肉疼
    feePaid: 0,       // 本局累计手续费（元）
    fills: [],        // 最近 5 笔成交，新的在前
    orders: [],       // 挂单：限价 { kind:'limit', dir, price, lots } / 止损止盈 { kind:'sl'|'tp', price }
    orderSeq: 0,
    sev: null,        // 本局的 severity 切片（天气日历要提前看"什么时候变天"）
    hist: [],
    liqPrice: null,
    liqAt: 0,
    sound: true,
    main: null,
    eqc: null,
    seeds: null,      // 这一局的原始天气分量（做闪报用）
    lastNews: ''
  };

  const THEME = { up: '#ff4d4f', down: '#00b578', flat: '#8b919e', ac: '#ffb74d', line: '#262b36', dim: '#8b919e', fg: '#e6e9ef' };
  function readTheme() {
    try {
      const s = getComputedStyle(document.body);
      const g = k => (s.getPropertyValue(k) || '').trim();
      if (g('--up')) THEME.up = g('--up');
      if (g('--down')) THEME.down = g('--down');
      if (g('--flat')) THEME.flat = g('--flat');
      if (g('--accent')) THEME.ac = g('--accent');
    } catch (e) { }
  }

  /* ═══════════════ 数字格式化 ═══════════════ */
  const n0 = v => (isFinite(v) ? Math.round(v) : 0).toLocaleString('en-US');
  const n1 = v => (isFinite(v) ? v : 0).toFixed(1);
  const n2 = v => (isFinite(v) ? v : 0).toFixed(2);
  function money(v) {
    const neg = v < 0;
    return (neg ? '-' : '') + '¥' + n0(Math.abs(v));
  }
  function sgnMoney(v) { return (v >= 0 ? '+' : '-') + '¥' + n0(Math.abs(v)); }
  function colorOf(v) { return v > 0 ? THEME.up : v < 0 ? THEME.down : THEME.flat; }

  /* ═══════════════ 账户数学 ═══════════════
     注意这里价格是「指数点」，不是摄氏度。合约规格：
     1 手 × 指数每动 1 点 = LOT_MULT 元。 */
  function marginUsed() { return G.pos ? Math.abs(G.pos) * G.avg * LOT_MULT / G.lev : 0; }
  function unreal() { return G.pos ? G.pos * (G.price - G.avg) * LOT_MULT : 0; }
  function equity() { return G.cash + unreal(); }
  /** 挂着的限价单锁掉的那部分保证金 —— 真券商就是这么算的，不然可以无限挂单把仓位吹到天上去 */
  function reservedMargin() {
    return G.orders.reduce((s, o) => s + (o.kind === 'limit' ? o.lots * o.price * LOT_MULT / G.lev : 0), 0);
  }
  function freeEq() { return equity() - marginUsed() - reservedMargin(); }
  function maxLots() { const m = G.price * LOT_MULT / G.lev; return m > 0 ? Math.floor(Math.max(0, freeEq()) / m) : 0; }
  /** 强平价：解 equity = marginUsed × MAINTAIN */
  function liqPriceOf() {
    if (!G.pos) return null;
    return G.avg + (Math.abs(G.pos) * G.avg * LOT_MULT / G.lev * MAINTAIN - G.cash) / (G.pos * LOT_MULT);
  }

  /**
   * 照现在的仓位比例下单的话，价格反向走多少就爆仓（百分数）。
   *
   * 这把「杠杆」和「仓位」两件事合成了一个数字 —— 这才是新手真正需要看的东西：
   * 满仓 20 倍是 4.5%，30% 仓位 20 倍是 16.2%，满仓 100 倍只有 0.9%。
   * 推导：开仓后现金 C、保证金 M = 手数·价·LOT/N，
   * 爆仓时 C + 手数·Δp·LOT = M·MAINTAIN  →  Δp = (M·MAINTAIN − C)/(手数·LOT)
   * 这个做法照 bilibili「FX 简单!」的下单卡搬的（它写「约可承受反向波动 4.00%」）。
   * 返回 null 表示连 1 手都开不出来。
   */
  function tolerablePct(pct) {
    if (!G.price) return null;
    const lots = Math.floor(maxLots() * pct / 100);
    if (lots < 1) return null;
    const M = lots * G.price * LOT_MULT / G.lev;
    const dp = (M * MAINTAIN - G.cash) / (lots * LOT_MULT);
    if (dp >= 0) return 0;                       // 开出来就已经在爆仓线下面了
    return Math.min(999, Math.abs(dp) / G.price * 100);
  }

  /* ═══════════════ 成交 ═══════════════ */
  /**
   * 这一单要吃掉多少滑点（指数点）。
   *
   * 这是我给"本金"加的第一根真杠杆 —— 在那之前，本金翻 10 倍只是手数翻 10 倍，
   * 盈亏**比例**一模一样，换句话说改本金等于没改。加上滑点之后就变了：
   * 单子的名义金额越大，越难在你要的价位全部成交。
   *
   *   名义金额 = 手数 × 价格 × LOT_MULT
   *   盘子容量 = CAP_BASE × (1 / dishScale(城市))      ← 小地方盘子小
   *   滑点(点) = SLIP_K × 名义金额 / 盘子容量
   *
   * 因为名义金额 ∝ 本金，所以**滑点占本金的比例随本金线性上升** ——
   * 30 万本金在广州市价约 0.09%，300 万就是约 0.9%，而且换到惠州还要再乘 2.6。
   * 钱多不等于好做，这一点是真券商天天在教的。
   *
   * `dishScale` 复用"盘子扰动"那套行政层级分档（见 cityWeight），不再单独造一个。
   */
  function slipOf(lots, px) {
    // 开场卡片上算这笔账时一局还没开始、G.price 还是 0，这时按基准点数估 ——
    // 不兜住的话 tip 会算出「滑点 ¥0」，把成本说小一大截（真踩过）。
    const p = (px > 0) ? px : (G.price > 0 ? G.price : BASE);
    // 没有城市时盘子按"中等"算。**不能直接 dishScale(null)** ——
    // cityWeight(null) 返回 1，dishScale 于是给出 1.6，开场卡片上的预估就凭空胖 60%。
    const ds = G.city ? (dishScale(G.city) || 1) : 1;
    const cap = CAP_BASE / ds;
    const raw = SLIP_K * Math.abs(lots) * p * LOT_MULT / cap;
    return Math.min(SLIP_MAX, raw);
  }

  /**
   * 按指定价成交。`p` 默认是最新价，但挂单必须按"挂的那个价"成交 —— 那正是挂单的意义。
   *
   * `useSlip` 决定这一单吃不吃滑点：
   *   - **市价单**（做多 / 做空 / 一键平仓）吃 —— 你是在向市场要流动性；
   *   - **止损止盈也吃** —— 止损触发时本质就是市价单，"插针时滑点最狠"正是真券商的日常抱怨；
   *   - **限价单不吃** —— 限价单的意义是"要么按我的价成交，要么别成交"，
   *     真实世界里的代价是**可能根本不成交**，这里如实照搬。
   *
   * 手续费有两档（对齐参考软件里那句"单笔不足 5 元按 5 元收取"）：
   * 名义金额 × 万分之五，但**不足 FEE_MIN 就按 FEE_MIN 收**。
   * 大资金感觉不到，小资金会明显更贵 —— 这是本金第二根真杠杆。
   */
  function applyFillAt(q, p, useSlip) {
    if (!q) return;
    const raw = (p > 0) ? p : G.price;
    const slip = (useSlip === false) ? 0 : slipOf(q);
    // 买入吃在更高的价、卖出砸在更低的价 —— 方向永远对自己不利
    p = raw + (q > 0 ? slip : -slip);
    const old = G.pos;
    const notional = Math.abs(q) * p * LOT_MULT;
    const fee = Math.max(FEE_MIN, notional * FEE_RATE);
    if (old === 0) {
      G.avg = p;
    } else if ((old > 0) === (q > 0)) {
      G.avg = (Math.abs(old) * G.avg + Math.abs(q) * p) / (Math.abs(old) + Math.abs(q));
    } else if (Math.abs(q) <= Math.abs(old)) {
      G.cash += -q * (p - G.avg) * LOT_MULT;
    } else {
      G.cash += old * (p - G.avg) * LOT_MULT;
      G.avg = p;
    }
    G.cash -= fee;
    G.pos = old + q;
    if (!G.pos) G.avg = 0;
    G.trades++;
    G.slipPaid = (G.slipPaid || 0) + Math.abs(q) * slip * LOT_MULT;
    G.feePaid = (G.feePaid || 0) + fee;
    // 仓位平掉之后，挂在它上面的止损止盈就没意义了
    if (!G.pos) G.orders = G.orders.filter(o => o.kind === 'limit');
    // 成交记录（最近 5 笔，新的在上）
    const kind = old === 0 ? (q > 0 ? '开多' : '开空')
      : (G.pos === 0 ? '平仓'
        : ((old > 0) === (q > 0) ? (q > 0 ? '加多' : '加空') : (q > 0 ? '减空' : '减多')));
    G.fills.unshift({ at: G.i, kind: kind, lots: Math.abs(q), px: p, fee: fee });
    if (G.fills.length > 5) G.fills.length = 5;
  }
  function applyFill(q) { applyFillAt(q, G.price); }

  /* ═══════════════ 挂单 ═══════════════ */
  /**
   * 限价开仓单：价格碰到 `price` 就按**这个价**开仓（不是按最新价 —— 那才是挂单的意思）。
   * 下单时就把它要占的保证金锁掉，所以不能靠挂单把仓位吹到天上去。
   */
  function placeLimit(dir, price, lots) {
    price = +price; lots = Math.floor(+lots);
    if (!(price > 0)) return '价格没填';
    if (!(lots >= 1)) return '手数至少 1';
    const need = lots * price * LOT_MULT / G.lev;
    if (need > freeEq() + 1e-6) return '可用保证金不够（要 ' + money(need) + '）';
    G.orders.push({ id: ++G.orderSeq, kind: 'limit', dir: dir > 0 ? 1 : -1, price: price, lots: lots });
    return null;
  }

  /** 止损 / 止盈挂在当前持仓上，碰到就把整个仓位平掉（跟真券商一样，不记手数） */
  function setStop(kind, price) {
    price = +price;
    if (!(price > 0)) return '价格没填';
    if (!G.pos) return '现在没有持仓';
    G.orders = G.orders.filter(o => o.kind !== kind);
    G.orders.push({ id: ++G.orderSeq, kind: kind, price: price });
    return null;
  }

  function cancelOrder(id) { G.orders = G.orders.filter(o => o.id !== id); }

  /**
   * 这一根 K 线里哪些挂单被碰到了。
   *
   * 判定用「上一根收盘 → 本根收盘」这条线段，再加本根的上下影线 ——
   * 光看收盘价的话，插针把你止损扫掉的情形就永远模拟不出来。
   * 同一根里有好几个价位被碰到时，按「离上一根收盘的距离」排序逐个成交：
   * 价格是从上一根收盘一路走过来的，先碰到的先成交，这才符合直觉。
   */
  function processOrders(prevPx) {
    if (!G.orders.length || !G.series[G.i]) return;
    const bar = G.series[G.i];
    const lo = Math.min(prevPx, G.price, bar.l);
    const hi = Math.max(prevPx, G.price, bar.h);
    const hits = G.orders.filter(o => o.price >= lo && o.price <= hi);
    if (!hits.length) return;
    hits.sort((a, b) => Math.abs(a.price - prevPx) - Math.abs(b.price - prevPx));
    for (const o of hits) {
      if (G.orders.indexOf(o) < 0) continue;   // 前面的成交可能已经把它带走了
      if (o.kind === 'limit') {
        // 限价单不吃滑点：要么按我的价成交，要么别成交
        applyFillAt(o.dir * o.lots, o.price, false);
        floatText('限价成交 ' + (o.dir > 0 ? '多' : '空') + ' ' + o.lots + ' 手 @ ' + n1(o.price), o.dir > 0 ? THEME.up : THEME.down, 12);
        beep(o.dir > 0 ? 660 : 440, .08, 'triangle', .04);
      } else if (G.pos) {
        const q = -G.pos;
        // 止损止盈本质是市价单，滑点照吃 —— 插针时被扫得最惨的就是它们
        applyFillAt(q, o.price);
        floatText((o.kind === 'sl' ? '止损触发 @ ' : '止盈触发 @ ') + n1(o.price), o.kind === 'sl' ? THEME.down : THEME.up, 13);
        beep(o.kind === 'sl' ? 300 : 900, .16, 'sine', .05);
      }
      G.orders = G.orders.filter(x => x.id !== o.id);
    }
  }

  function liquidate() {
    const p = G.price;
    G.liqPrice = p;
    G.liqAt = G.i;
    G.cash += G.pos * (p - G.avg) * LOT_MULT;
    G.cash = Math.max(0, G.cash);
    G.pos = 0; G.avg = 0;
    G.hist[G.hist.length - 1] = G.cash;
  }

  /* ═══════════════ 指数构造 ═══════════════ */
  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const h = b.length >> 1;
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  }
  /** 中位绝对偏差 → 稳健标准差。用 min/max 归一化的话，一次台风就把后面全压扁了。 */
  function robustScale(a, m) {
    const d = a.map(v => Math.abs(v - m));
    return (1.4826 * median(d)) || 1;
  }

  /** 当地"现在"的 'YYYY-MM-DDTHH:MM'，用来切出预报段 */
  function nowLocalStr() {
    const d = new Date();
    const u = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return u.toISOString().slice(0, 16);
  }

  /**
   * 这个城市有多"大"。用来定**盘子扰动**的振幅 —— 小地方筹码少，同样的资金进出
   * 更容易把价格打飞，这就是"庄家操盘"的观感来源。
   *
   * `cities.json` 里没有人口字段（只有 id/name/prov/py/lat/lon/cma/path），
   * 所以按**行政层级**分档，而不是假装知道人口：
   *   直辖市 3.0 / 省会 2.2 / 有国家站的地级市 1.6 / 有 path 的 1.2 / 区县 0.6
   * 再取 `1.6 / w` 当振幅倍率，并夹到 [0.35, 2.6] 免得极端值飞出画面。
   */
  function cityWeight(c) {
    if (!c) return 1;
    const p = String(c.prov || ''), nm = String(c.name || '');
    if (/^(北京市|上海市|天津市|重庆市)$/.test(p)) return 3.0;
    const core = p.replace(/(省|市|自治区|壮族|回族|维吾尔|特别行政区|自治州)/g, '');
    if (core && nm && (nm === core || nm.indexOf(core) === 0)) return 2.2;
    if (c.cma) return 1.6;
    if (c.path) return 1.2;
    return 0.6;
  }
  function dishScale(c) {
    const w = cityWeight(c);
    return Math.max(0.35, Math.min(2.6, 1.6 / w));
  }

  /** 把 minutely_15 的原始分量压成一条「天气恶劣度」序列 */
  function severity(mn) {
    const T = mn.temp.map(v => (v == null ? 0 : +v));
    const Gs = mn.gust.map(v => (v == null ? 0 : +v));
    const P = mn.precip.map(v => (v == null ? 0 : +v));
    const C = mn.cape.map(v => (v == null ? 0 : +v));
    const W = mn.wcode.map(v => (v == null ? 0 : +v));
    const mC = median(C), sC = robustScale(C, mC);
    const mG = median(Gs), sG = robustScale(Gs, mG);
    const mT = median(T), sT = robustScale(T, mT);
    const out = new Array(T.length);
    for (let i = 0; i < T.length; i++) {
      const wc = W[i];
      // 雷暴码权重最大 —— 它代表"此时此刻头上正在放电"，比任何数值都硬
      const storm = (wc === 95 || wc === 96 || wc === 99) ? 1.6
        : (wc === 80 || wc === 81 || wc === 82 || wc === 65 || wc === 63) ? 0.5 : 0;
      out[i] = (C[i] - mC) / sC * 1.00        // 对流有效位能
        + (Gs[i] - mG) / sG * 0.55            // 阵风
        + (T[i] - mT) / sT * 0.30             // 气温异常
        + Math.min(4, Math.sqrt(P[i])) * 0.45 // 实况降水
        + storm;
    }
    return out;
  }

  function ema(x, a) {
    const o = new Array(x.length);
    let v = x.length ? x[0] : 0;
    for (let i = 0; i < x.length; i++) { v = a * x[i] + (1 - a) * v; o[i] = v; }
    return o;
  }

  /** 两点间大圆距离（公里）。台风/地震都按"离城市多远"折算影响。 */
  function distKm(la1, lo1, la2, lo2) {
    const R = 6371, rad = Math.PI / 180;
    const dla = (la2 - la1) * rad, dlo = (lo2 - lo1) * rad;
    const a = Math.sin(dla / 2) * Math.sin(dla / 2) +
      Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 确定性伪随机（[-1,1]）。用它而不是 Math.random()，是为了同一段行情
   *  在同一个周期下每次都长得一样 —— 否则探针跑两次结果对不上，没法验收。 */
  function zag(a, b) {
    const x = Math.sin((a * 131 + b * 17) * 12.9898) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  function fmtMin(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) +
      'T' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /** 把几根 15 分钟的天气读数并成一根粗 K 线的读数。
   *  取 max 的是"极值型"（阵风、CAPE、天气码），取平均的是"状态型"（PM2.5、露点、盘子），
   *  降水求和。地震/台风取这一段里最强的那次，并把它的名字/距离/震级带上。 */
  function aggSeed(g) {
    if (g.length === 1) return g[0];
    const o = {
      cape: 0, gust: 0, precip: 0, wcode: 0, dew: null, dish: 0,
      pm25: null, air: 0, quake: 0, qmag: 0, qplace: '', typh: 0, tname: '', tdist: 0, fcst: 0
    };
    let dp = 0, dn = 0, pm = 0, pn = 0, n = 0;
    for (let i = 0; i < g.length; i++) {
      const s = g[i]; n++;
      o.cape = Math.max(o.cape, s.cape || 0);
      o.gust = Math.max(o.gust, s.gust || 0);
      o.precip = +(o.precip + (s.precip || 0)).toFixed(1);
      o.wcode = Math.max(o.wcode, s.wcode || 0);
      if (s.dew != null) { dp += s.dew; dn++; }
      o.dish += s.dish || 0;
      if (s.pm25 != null) { pm += s.pm25; pn++; }
      o.air += s.air || 0;
      o.fcst += s.fcst || 0;
      if ((s.quake || 0) > o.quake) { o.quake = s.quake; o.qmag = s.qmag; o.qplace = s.qplace; }
      if ((s.typh || 0) > o.typh) { o.typh = s.typh; o.tname = s.tname; o.tdist = s.tdist; }
    }
    o.dew = dn ? +(dp / dn).toFixed(1) : null;
    o.dish = +(o.dish / n).toFixed(1);
    o.pm25 = pn ? Math.round(pm / pn) : null;
    o.air = +(o.air / n).toFixed(1);
    o.fcst = +(o.fcst / n).toFixed(2);
    o.quake = +(+o.quake).toFixed(2);
    o.typh = +(+o.typh).toFixed(2);
    o.qmag = +(+o.qmag || 0).toFixed(1);
    return o;
  }

  /** 把 15 分钟的基准序列重采样成玩家选的 K 线周期。
   *  **数据源只有 15 分钟**（Open-Meteo 的 minutely_15 就是最细的免费粒度了），所以：
   *    · 周期 ≥ 15 分钟 → **聚合**真数据（15 原样、30 并 2 根、45 并 3 根、60 并 4 根）
   *    · 周期 <  15 分钟 → **插值展开**（1 分钟 = 1 根摊成 15 根、5 分钟 = 摊成 3 根）
   *  聚合只是"看粗一点"，丢的是细节；展开则是**建模** —— 两根 15 分钟之间到底
   *  怎么走的没人知道，所以收盘价沿父根的开→收线性走、叠一个确定性小锯齿，
   *  影线按父根振幅的比例分下去。**1 分钟/5 分钟档上那些细碎波动是画出来的、不是采到的**，
   *  README 里写明了。展开时最后一根强制收在父根收盘价上，所以把 1 分钟聚合回
   *  15 分钟能和真数据逐点对上。 */
  function resample(series, seeds, regLine) {
    const barMin = BAR_MIN[G.barIdx];
    const out = [], sd = [], rg = [];
    if (barMin >= SRC_MIN) {
      const k = Math.round(barMin / SRC_MIN);
      for (let i = 0; i < series.length; i += k) {
        const g = series.slice(i, i + k);
        const o = g[0].o, c = g[g.length - 1].c;
        let hi = -Infinity, lo = Infinity;
        for (let q = 0; q < g.length; q++) { if (g[q].h > hi) hi = g[q].h; if (g[q].l < lo) lo = g[q].l; }
        out.push({ t: g[0].t, o: o, h: Math.max(hi, o, c), l: Math.min(lo, o, c), c: c });
        sd.push(aggSeed(seeds.slice(i, i + k)));
        if (regLine) rg.push(regLine[Math.min(regLine.length - 1, i + k - 1)]);
      }
      return { series: out, seeds: sd, regLine: regLine ? rg : null };
    }
    // ── 展开：每根 15 分钟摊成 m 根 ──
    const m = Math.round(SRC_MIN / barMin);
    const t0 = series.length ? Date.parse(series[0].t) : 0;
    for (let i = 0; i < series.length; i++) {
      const p = series[i], amp = Math.max(1e-6, p.h - p.l);
      const base = t0 + i * SRC_MIN * 60000;
      const r0 = regLine ? regLine[i] : 0;
      const r1 = regLine ? regLine[Math.min(regLine.length - 1, i + 1)] : 0;
      let prev = p.o;
      for (let j = 0; j < m; j++) {
        const f = (j + 1) / m;
        let c = p.o + (p.c - p.o) * f + amp * 0.06 * zag(i, j);
        if (j === m - 1) c = p.c;                 // 收在父根收盘，聚合回去才对得上
        const o = prev;
        const w = amp * 0.10 * Math.abs(zag(i, j + 977)) + Math.abs(c - o) * WICK_K;
        out.push({
          t: fmtMin(base + j * barMin * 60000),
          o: o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c: c
        });
        sd.push(seeds[i]);                        // 子根共用父根那份天气读数
        if (regLine) rg.push(+(r0 + (r1 - r0) * f).toFixed(2));
        prev = c;
      }
    }
    return { series: out, seeds: sd, regLine: regLine ? rg : null };
  }

  /** 从 minutely_15 里随机截一段真实历史，做成带 OHLC 的 K 线。
   *  extra = { air, quake, typh, fcst } 四个压力源的数据（缺了就传 null，对应项退化成 0） */
  function pickSeries(mn, reg, city, extra) {
    if (!mn || !mn.time || !mn.time.length) return null;
    const n = mn.time.length;
    let i0 = mn.time.findIndex(t => t >= nowLocalStr());
    if (i0 < 0) i0 = n;
    // 只用"现在"之前的：预报段不能拿来当已发生的行情
    const end = Math.max(2, Math.min(n, i0));
    // 一局 7 天 = 672 根 15 分钟**源**数据。基准序列永远按数据源粒度（15 分钟）算，
    // 算完再按玩家选的周期重采样（见 resample）—— 这样价格模型只有一套，
    // 不会出现"1 分钟档和 60 分钟档走势不一样"的怪事。
    const need = srcBars();
    if (end < need + 1) return null;

    const sev = severity(mn);
    const tr = ema(sev, EMA_A);
    const now = nowLocalStr();

    // ── 区域大盘：同一个时间轴（两边都是 past_days=92 & 同一时区），按时间串对齐 ──
    let regSev = null, regTr = null, regMap = null;
    if (reg && reg.time && reg.time.length) {
      regMap = {};
      for (let k = 0; k < reg.time.length; k++) regMap[reg.time[k]] = k;
      // 拿本地这一局的时间轴去取大盘值，拼成等长的"虚拟城市"再套同一套 severity()
      const rv = { time: [], temp: [], gust: [], precip: [], wcode: [], cape: [], dew: [] };
      for (let k = 0; k < n; k++) {
        const j = regMap[mn.time[k]];
        rv.time.push(mn.time[k]);
        rv.temp.push(j == null ? null : reg.temp[j]);
        rv.gust.push(j == null ? null : reg.gust[j]);
        rv.precip.push(j == null ? (0) : (reg.precip[j] == null ? 0 : reg.precip[j]));
        rv.wcode.push(j == null ? 0 : (reg.wcode[j] || 0));
        rv.cape.push(j == null ? null : reg.cape[j]);
      }
      // severity() 里对 null 是当 0 处理的，所以只有大盘真的对齐上了才算数
      let hit = 0;
      for (let k = 0; k < Math.min(200, n); k++) if (rv.cape[k] != null && rv.gust[k] != null) hit++;
      if (hit > 100) { regSev = severity(rv); regTr = ema(regSev, EMA_A); }
    }

    // ── 露点（湿热）项：真数据，15 分钟粒度 ──
    const D = (mn.dew && mn.dew.length ? mn.dew : []).map(v => (v == null ? null : +v));
    const dOk = D.filter(v => v != null);
    const mDew = dOk.length ? median(dOk) : 0, sDew = dOk.length ? robustScale(dOk, mDew) : 1;

    // ── 盘子扰动：带衰减的随机游走。小地方振幅更大（庄家操盘）──
    const dScale = dishScale(city) * DISH_K;

    // ══ 四个压力源：时刻 / 强度 / 位置全部来自真数据，只做"怎么折成点数"的建模 ══
    // 定位根号一律用**时间差**（barT0 与事件时刻都用同一个 Date.parse 口径），
    // 所以浏览器把 mn.time 当本地时间还是 UTC 解释都不影响结果。
    const BAR_MS = 900000;
    const barT0 = mn.time.length ? Date.parse(mn.time[0]) : 0;
    const idxOf = t => (barT0 && t) ? Math.round((t - barT0) / BAR_MS) : -1;

    // ① 空气质量：小时级慢变量。PM2.5 按小时键对齐到每根 15 分钟 K。
    let airN = null, airRaw = null;
    if (extra && extra.air && extra.air.time && extra.air.time.length) {
      const A = extra.air, am = {};
      for (let k = 0; k < A.time.length; k++) if (A.pm25[k] != null) am[A.time[k]] = +A.pm25[k];
      const hourOf = t => t.slice(0, 13) + ':00';      // "2026-10-05T13:45" → "2026-10-05T13:00"
      const vals = [];
      const raw = new Array(n).fill(null);
      for (let k = 0; k < n; k++) {
        const v = am[hourOf(mn.time[k])];
        if (v != null) { raw[k] = v; vals.push(v); }
      }
      // 覆盖不到一半就不认 —— 否则拿零星半小时的 PM2.5 去推整局，等于编数据
      if (vals.length > n * 0.5) {
        const mA = median(vals), sA = robustScale(vals, mA) || 1;
        airN = new Array(n).fill(0);
        for (let k = 0; k < n; k++) airN[k] = raw[k] == null ? 0 : (raw[k] - mA) / sA;
        airRaw = raw;
      }
    }

    // ② 地震：事件型。每来一次就在对应根号上砸一记冲击，再按 QUAKE_DECAY 拖一段余波。
    //    按震中到城市的真实大圆距离衰减；超过 QUAKE_R 不计（与 api.js 的查询半径一致）。
    const qArr = new Array(n).fill(0);
    const qMag = new Array(n).fill(0), qPlace = new Array(n).fill('');
    if (extra && extra.quake && extra.quake.length && barT0 && city.lat != null) {
      for (const e of extra.quake) {
        const d = (e.mag || 0) - QUAKE_M0;
        if (d <= 0) continue;
        const i = idxOf(e.t);
        if (i < -160 || i >= n) continue;
        const dist = (e.lat != null) ? distKm(city.lat, city.lon, e.lat, e.lon) : 0;
        const near = Math.max(0, 1 - dist / QUAKE_R);
        if (near <= 0) continue;
        const amp = QUAKE_K * d * near;
        for (let j = Math.max(0, i); j < Math.min(n, i + 160); j++) {
          qArr[j] += amp * Math.pow(QUAKE_DECAY, j - i);
          // 播报要报"震级 + 震中"，所以顺手记下这一根上最强的那个事件
          if (+e.mag > qMag[j]) { qMag[j] = +e.mag; qPlace[j] = e.place || ''; }
        }
      }
    }

    // ③ 台风：持续过程，所以不像地震那样"砸一记再衰减"，而是**逐根算台风中心有多近**。
    //    路径点每 3~6 小时一个，按时间线性插值出中心位置，距离越近、风速越大，推得越高；
    //    台风压过来自然涨、走过去自然落，不需要额外加余波。
    const tArr = new Array(n).fill(0);
    const tName = new Array(n).fill(''), tWind = new Array(n).fill(0), tDist = new Array(n).fill(0);
    if (extra && extra.typh && extra.typh.length && barT0 && city.lat != null) {
      const byNum = {};
      for (const p of extra.typh) (byNum[p.num || '_'] = byNum[p.num || '_'] || []).push(p);
      for (const key in byNum) {
        const path = byNum[key].slice().sort((a, b) => a.t - b.t);
        if (!path.length) continue;
        const tA = +path[0].t, tB = +path[path.length - 1].t;
        for (let k = 0; k < n; k++) {
          const t = barT0 + k * BAR_MS;
          if (t < tA - 6 * 3600000 || t > tB + 6 * 3600000) continue;
          let lo = 0, hi = path.length - 1;
          while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (path[mid].t <= t) lo = mid; else hi = mid; }
          const a = path[lo], b = path[hi] || path[lo];
          const span = (b.t - a.t) || 1;
          const u = Math.max(0, Math.min(1, (t - a.t) / span));
          const la = a.lat + (b.lat - a.lat) * u, lo2 = a.lon + (b.lon - a.lon) * u;
          const w = (a.wind || 0) + ((b.wind || 0) - (a.wind || 0)) * u;
          const near = 1 - distKm(city.lat, city.lon, la, lo2) / TYPHOON_R;
          if (near > 0) {
            const add = TYPHOON_K * (w / 30) * near * near;   // 平方衰减，边缘影响小
            tArr[k] += add;
            if (add > tWind[k]) {                            // 播报取影响最大的那个台风
              tWind[k] = add;
              tName[k] = (path[lo].name || '') + (path[lo].num ? '' : '');
              tDist[k] = Math.round(distKm(city.lat, city.lon, la, lo2));
            }
          }
        }
      }
    }

    // ④ 预报偏离：实测气温 − 提前 24 小时发出的预报。报得越离谱，这根 K 线越"意外"。
    let fN = null;
    if (extra && extra.fcst && extra.fcst.time && extra.fcst.time.length) {
      const F = extra.fcst, fm = {};
      for (let k = 0; k < F.time.length; k++) {
        const a = F.act[k], f = F.fc1[k];
        if (a != null && f != null) fm[F.time[k]] = +a - +f;
      }
      const vals = [];
      const raw = new Array(n).fill(null);
      for (let k = 0; k < n; k++) {
        const v = fm[mn.time[k]];
        if (v != null) { raw[k] = v; vals.push(v); }
      }
      if (vals.length > n * 0.5) {
        const mF = median(vals), sF = robustScale(vals, mF) || 1;
        fN = new Array(n).fill(0);
        for (let k = 0; k < n; k++) fN[k] = raw[k] == null ? 0 : (raw[k] - mF) / sF;
      }
    }

    /* 回放窗口的事件偏置。
       纯随机会有个尴尬 —— 92 天里真来过台风、真震过，可随机截的那 7 天常常一个都没覆盖到，
       于是这几个压力源常年看不见（实测北京/广州十局里台风项 0 覆盖）。
       这里**不改成"每局必有事件"**（那就成安排好的剧情了，也就没有"你不知道这段是哪年月"），
       而是：一半的局挑"事件分最高"的那十天，另一半纯随机。
       事件分 = 这一窗里地震项 + 台风项贡献的总量。 */
    function biasedStart(s, limit) {
      if (Math.random() >= 0.5) return s;
      let best = -1, bestSc = -1;
      for (let t = 0; t < 40; t++) {
        const c = Math.floor(Math.random() * (limit - need));
        let ok = true;
        for (let j = 0; j < need; j += 7) {           // 每 7 根抽一次就够判断有没有洞
          if (mn.time[c + j] >= now || mn.gust[c + j] == null || mn.cape[c + j] == null) { ok = false; break; }
        }
        if (!ok) continue;
        let sc = 0;
        for (let j = 0; j < need; j += 4) sc += Math.abs(qArr[c + j]) + Math.abs(tArr[c + j]);
        if (sc > bestSc) { bestSc = sc; best = c; }
      }
      // 没找到更好的（或者全都是 0）就退回原来那个
      return (best >= 0 && bestSc > 0.5) ? best : s;
    }

    for (let k = 0; k < 24; k++) {
      const s = Math.floor(Math.random() * (end - need));
      let ok = true;
      for (let j = 0; j < need; j++) {
        // 只认"现在"之前、而且确实有数的点
        if (mn.time[s + j] >= now || mn.gust[s + j] == null || mn.cape[s + j] == null) { ok = false; break; }
      }
      if (!ok) continue;
      const s2 = biasedStart(s, end - need);

      const win = tr.slice(s2, s2 + need);
      const m = median(win);
      const series = [];
      const seeds = [];
      const regLine = [];          // 画在副图上的"大盘"（跟主图同一根数）
      let carry = 0, dish = 0;
      for (let j = 0; j < need; j++) {
        const k2 = s2 + j;
        // 「突发行情」：某根 15 分钟里天气本身剧烈变化（CAPE 炸了、阵风猛增、开始下暴雨）时，
        // 除了常规的噪声项，再砸进去一记冲击 —— 这就是久留美里那种"蜡烛图突然拉到底"。
        //
        // shock 是「这一刻打多狠」，carry 是「余波还走多远」。只有 shock 的话就出一根长阴、
        // 下一根立刻回弹，不像崩盘；加上 carry（按 JUMP_DECAY 衰减的动量）才有连续几根
        // 顺势砸下去的样子。系数是拿广州/哈尔滨 92 天的真实 minutely_15 调出来的：
        // 单根中位涨跌仍是 0.167%（平时盘感不变），但每局会出现几次连续 3 根跌 8~15% 的段。
        // 注意它**不是随机数** —— 触发条件是真实观测到的剧烈变化。
        const dsev = k2 > 0 ? (sev[k2] - sev[k2 - 1]) : 0;
        const shock = Math.abs(dsev) > JUMP_AT
          ? (Math.abs(dsev) - JUMP_AT) * JUMP_K * (dsev > 0 ? 1 : -1)
          : 0;
        carry = carry * JUMP_DECAY + shock;

        // 大盘的快分量：本地天气是一城一地，大盘是整省的天气过程。
        // 只取"快分量"（减去自己的 EMA）是有意的 —— 趋势项已经由本地负责，
        // 大盘再贡献一遍慢趋势就成了同一个信号算两次。
        let regFast = 0;
        if (regSev) regFast = (regSev[k2] - regTr[k2]) * REG_K;

        const dnorm = D[k2] == null ? 0 : (D[k2] - mDew) / sDew;

        // 盘子扰动：AR(1)。用噪声当驱动、按 DISH_DECAY 衰减，
        // 所以它是一条"能看出有人在推"的平滑曲线，而不是每根乱跳的雪花点。
        dish = dish * DISH_DECAY + (Math.random() - 0.5) * 2 * dScale;

        // 四个压力源（缺数据的项 airN/fN 为 null、qArr/tArr 天然为 0）
        const airTerm  = airN ? airN[k2] * AIR_K : 0;
        const quakeTerm = qArr[k2];
        const typhTerm = tArr[k2];
        const fcstTerm = fN ? fN[k2] * FCST_K : 0;

        const px = BASE + (tr[k2] - m) * TREND_K + (sev[k2] - tr[k2]) * NOISE_K + carry
          + regFast + dnorm * DEW_K + dish
          + airTerm + quakeTerm + typhTerm + fcstTerm;
        series.push({ t: mn.time[k2], c: px });
        regLine.push(BASE + regFast * 3 + dish * 0.2);
        seeds.push({
          cape: mn.cape[k2] | 0,
          gust: +(+mn.gust[k2]).toFixed(1),
          precip: +(+(mn.precip[k2] || 0)).toFixed(1),
          wcode: mn.wcode[k2] | 0,
          dew: D[k2] == null ? null : +(+D[k2]).toFixed(1),
          dish: +dish.toFixed(1),
          pm25: (airRaw && airRaw[k2] != null) ? +airRaw[k2].toFixed(0) : null,
          air: +airTerm.toFixed(1),
          quake: +quakeTerm.toFixed(2),
          qmag: qMag[k2] || 0,
          qplace: qPlace[k2] || '',
          typh: +typhTerm.toFixed(2),
          tname: tName[k2] || '',
          tdist: tDist[k2] || 0,
          fcst: +fcstTerm.toFixed(2)
        });
      }
      // 补 OHLC：开 = 上一根收，收 = 本根指数（都是真采样）；
      // 影线按 |本根涨跌| × WICK_K 建模（15 分钟粒度拿不到根内极值）。
      for (let j = series.length - 1; j >= 0; j--) {
        const c = series[j].c;
        const o = j > 0 ? series[j - 1].c : c;
        const w = Math.abs(c - o) * WICK_K;
        series[j].o = o;
        series[j].h = Math.max(o, c) + w;
        series[j].l = Math.min(o, c) - w;
      }
      if (!series.every(b => isFinite(b.o) && isFinite(b.c))) continue;
      // 按玩家选的 K 线周期重采样（15 分钟源 → 目标周期），价格模型本身不动。
      const rs = resample(series, seeds, regSev ? regLine : null);
      const raw = regSev ? regLine : null;
      return {
        series: rs.series, seeds: rs.seeds, sevWin: sev.slice(s2, s2 + need),
        regLine: rs.regLine,
        regFrom: s2,
        regCities: (reg && reg.cities) || null,
        // 15 分钟原样那一份也带出来 —— 局中换 K 线周期时不用重新取数据，
        // 直接拿它重采样再把已推进的天气时间映射过去就行。
        base: series, baseSeeds: seeds, baseReg: raw
      };
    }
    return null;
  }

  function labelAt(i) {
    const day = Math.floor(i / perDay()) + 1, m = (i % perDay()) * barMin();
    const hh = U.pad2(Math.floor(m / 60)), mm = U.pad2(m % 60);
    return (m === 0) ? ('第 ' + day + ' 天') : ('D' + day + ' ' + hh + ':' + mm);
  }

  /* ═══════════════ 天气日历 ═══════════════
     财经日历告诉你「20:30 有非农」，但不会告诉你数据是好是坏 —— 这个日历一样：
     它只标出**未来一天里天气什么时候会剧变**，一个字都不提往哪边。

     判定用的是 |Δseverity|，也就是"变化得多猛"。CAPE 炸上去和塌下来
     算出来是同一个数，所以强度条本身不泄露方向。
     触发门槛跟价格冲击用的同一个 JUMP_AT —— 日历上标了的，盘面上就真会动。 */
  function calendarAt(i, horizon) {
    if (!G.sev || !G.series.length) return [];
    const end = Math.min(G.series.length - 1, i + (horizon || perDay()));
    const raw = [];
    for (let k = Math.max(1, i + 1); k <= end; k++) {
      const d = Math.abs(G.sev[k] - G.sev[k - 1]);
      if (d > JUMP_AT) raw.push({ at: k, d: d });
    }
    // 同一场天气过程会连着好几根都在变，合并成一段
    const out = [];
    for (const e of raw) {
      const last = out[out.length - 1];
      if (last && e.at - last.to <= 3) { last.to = e.at; last.d = Math.max(last.d, e.d); }
      else out.push({ from: e.at, to: e.at, d: e.d });
    }
    return out;
  }

  /* ═══════════════ 新闻闪报（都用真实数值） ═══════════════ */
  /** 返回这一根 K 线上值得播报的天气事件，没有就返回 null */
  function newsAt(i) {
    const s = G.seeds && G.seeds[i];
    if (!s) return null;
    const prev = G.seeds && G.seeds[i - 1];
    const wc = s.wcode;
    // 「状态类」消息只在**刚跨过门槛的那一下**播（上升沿），不然台风挨着 500 公里飘两天，
    // 每根 K 线都要弹一次"🌀 台风" —— 那不是新闻，那是刷屏。
    // （实测不加这个判断时：一局 672 根里播了 540 次台风。）
    const rise = (f, th) => s[f] >= th && !(prev && prev[f] >= th);
    const fall = (f, th) => s[f] <= th && !(prev && prev[f] <= th);

    // 四个真数据压力源排在最前面 —— 它们是"外部消息"，比一根 K 线本身更能解释行情。
    // 顺序 = 罕见到常见：地震 > 台风 > 预报失准 > 空气。
    if (rise('quake', 1)) {
      const pl = String(s.qplace || '').replace(/^\s*(near|about)\s+/i, '').split(',')[0];
      return { k: 'quake', t: '🌋 地震', v: 'M' + n1(s.qmag) + (pl ? ' · ' + pl : '') + ' · 冲击 +' + n1(s.quake) };
    }
    if (rise('typh', 6)) {
      return { k: 'typhoon', t: '🌀 台风' + (s.tname ? ' ' + s.tname : ''),
               v: (s.tdist ? s.tdist + ' 公里外' : '影响中') + ' · 冲击 +' + n1(s.typh) };
    }
    if (Math.abs(s.fcst) >= 6 && Math.abs(prev ? prev.fcst : 0) < 6) {
      return s.fcst > 0
        ? { k: 'fcstH', t: '🔥 比预报更热', v: '预报失准 +' + n1(s.fcst) }
        : { k: 'fcstL', t: '❄️ 比预报更冷', v: '预报失准 ' + n1(s.fcst) };
    }
    // 空气是慢变量，只在真的"爆表"或真的干净时才播，且同样只播一次
    if (rise('pm25', 200)) return { k: 'airBad', t: '😷 空气爆表', v: 'PM2.5 ' + s.pm25 };
    if (s.pm25 != null && fall('pm25', 10)) return { k: 'airGood', t: '🍃 空气通透', v: 'PM2.5 ' + s.pm25 };
    // 盘子扰动其次 —— 它是"资金面"消息，比天气更能解释一根莫名的长阳/长阴。
    // 门槛 DISH_K × 2.5（约 p98）：实测 dish 的 p90 才 4.6，
    // 按 1.5 倍设会让 17% 的 K 线都弹一次"大单扫货"，那就成了噪音而不是消息。
    if (s.dish != null) {
      if (rise('dish', DISH_K * 2.5)) return { k: 'pump', t: '🏦 大单扫货', v: '盘子异动 +' + n1(s.dish) };
      if (fall('dish', -DISH_K * 2.5)) return { k: 'dump', t: '📉 有人出货', v: '盘子异动 ' + n1(s.dish) };
    }
    // 天气本身也是「状态」，同样只播上升沿 —— 一场雷暴持续两小时不该弹 8 次
    const pwc = prev ? prev.wcode : 0;
    const stormy = v => v === 95 || v === 96 || v === 99;
    if (stormy(wc) && !stormy(pwc)) return { k: 'storm', t: '⚡ 雷暴', v: 'CAPE ' + s.cape };
    if (rise('gust', 32)) return { k: 'gale', t: '🌀 阵风', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (rise('cape', 3000)) return { k: 'cape', t: '🌩 对流爆发', v: 'CAPE ' + s.cape };
    if (rise('gust', 25)) return { k: 'gust', t: '🌪 大风', v: '阵风 ' + n1(s.gust) + ' m/s' };
    if (rise('precip', 3)) return { k: 'rain', t: '🌧 短时强降水', v: s.precip + ' mm' };
    if (fall('cape', 50) && s.gust <= 6) return { k: 'calm', t: '🌤 天气转好', v: 'CAPE ' + s.cape };
    return null;
  }

  function flashNews(ev) {
    if (!ev || ev.k === G.lastNews) return;
    G.lastNews = ev.k;
    const p = $('.game-panel');
    if (!p) return;
    const old = p.querySelector('.gg-news');
    if (old) old.remove();
    const d = document.createElement('div');
    d.className = 'gg-news';
    d.innerHTML = '<b>' + ev.t + '</b><span>' + ev.v + '</span>';
    p.appendChild(d);
    setTimeout(() => d.remove(), 2200);
  }

  /* ═══════════════ 音效 ═══════════════ */
  let AC = null;
  function beep(freq, dur, type, vol) {
    if (!G.sound) return;
    try {
      AC = AC || new (global.AudioContext || global.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      const o = AC.createOscillator(), g = AC.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol == null ? .05 : vol, AC.currentTime);
      g.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(); o.stop(AC.currentTime + dur);
    } catch (e) { }
  }

  /* ═══════════════ 图表 ═══════════════ */
  function ensureCharts() {
    if (!G.main) {
      G.main = echarts.init($('#ggChart'), null, { renderer: 'canvas' });
      // 绑定一次就够 —— setOption(..., true) 不会把 on() 挂的监听清掉。
      // params.axesInfo[0].value 是 x 轴的**类别名**，用 indexOf 反查下标。
      G.main.on('updateAxisPointer', ev => {
        try {
          const ai = ev && ev.axesInfo && ev.axesInfo[0];
          if (!ai) return;
          const cats = (G.main.getOption().xAxis[0] || {}).data || [];
          const k = cats.indexOf(ai.value);
          if (k >= 0) updateOhlc((G._from || 0) + k);
        } catch (e) { }
      });
      // 鼠标离开图表就回到最新一根
      G.main.getZr().on('globalout', () => updateOhlc(G.i));
    }
    if (!G.eqc) G.eqc = echarts.init($('#ggEqChart'), null, { renderer: 'canvas' });
  }
  function disposeCharts() {
    try { if (G.main) G.main.dispose(); } catch (e) { }
    try { if (G.eqc) G.eqc.dispose(); } catch (e) { }
    G.main = G.eqc = null;
  }

  /** 一屏能看清多少根：容器宽度 ÷ 每根 9px，两端都夹一下 */
  function visBars() {
    const cw = (G.main && G.main.getWidth && G.main.getWidth()) || 900;
    return Math.max(36, Math.min(roundBars(), Math.floor(cw / 9)));
  }

  /** 简单移动平均。返回与 series 等长的数组，前 w−1 根是 null（线自然断开） */
  function movingAvg(src, w) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i].c;
      if (i >= w) sum -= src[i - w].c;
      out.push(i >= w - 1 ? +(sum / w).toFixed(2) : null);
    }
    return out;
  }
  const MA_DEF = [{ w: 5, color: '#f0b90b' }, { w: 20, color: '#7aa2f7' }];
  const REG_C = '#c792ea';   // 区域大盘线的颜色（紫），和 MA5 的黄 / MA20 的蓝分得开

  /**
   * 图表左上角那行读数 —— TradingView / MT4 的图例。
   * 不悬停时跟着最新一根走，鼠标在图上来回划就显示划到的那根。
   */
  function updateOhlc(gi) {
    const box = $('#ggOhlc'); if (!box || !G.series.length) return;
    const k = Math.max(0, Math.min(gi, G.series.length - 1));
    const b = G.series[k]; if (!b) return;
    const d = b.c - b.o, col = colorOf(d);
    let ma = '';
    if (G._ma) {
      ma = G._ma.map((a, j) => {
        const v = a[k];
        const m = MA_DEF[j];
        return '<span class="gg-ma' + m.w + '"><i style="background:' + m.color + '"></i>MA' + m.w +
          ' <b>' + (v == null ? '—' : n1(v)) + '</b></span>';
      }).join('&nbsp;&nbsp;');
    }
    box.innerHTML =
      '<em>' + labelAt(k) + '</em>' +
      '开<b style="color:' + col + '">' + n1(b.o) + '</b>' +
      '高<b style="color:' + col + '">' + n1(b.h) + '</b>' +
      '低<b style="color:' + col + '">' + n1(b.l) + '</b>' +
      '收<b style="color:' + col + '">' + n1(b.c) + '</b>' +
      (ma ? '&nbsp;&nbsp;' + ma : '');
  }

  function drawCharts() {
    if (!G.main || !G.eqc || !G.series.length) return;
    const n = Math.min(G.i + 1, G.series.length);
    const cw = (G.main.getWidth && G.main.getWidth()) || 800;
    const want = Math.max(3, Math.floor(cw / 76));
    const vis = visBars();
    const from = Math.max(0, n - vis);

    const xs = [], bars = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i < n; i++) {
      const b = G.series[i];
      xs.push(labelAt(i));
      bars.push([+b.o.toFixed(2), +b.c.toFixed(2), +b.l.toFixed(2), +b.h.toFixed(2)]);
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    // 均线：真实看盘软件都有，而且它让「现在处在什么位置」一眼可见。
    // 注意要拿**整段** series 算再切片 —— 只拿可视段算的话，每次窗口滑动
    // 均线都会整体跳一下，看着像在抽搐。
    const maAll = MA_DEF.map(d => movingAvg(G.series, d.w));
    G._ma = maAll;
    const maVis = maAll.map(a => a.slice(from, n));
    maVis.forEach(a => a.forEach(v => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    // 大盘线：不进 Y 轴范围计算 —— 它是参考指标，把它算进去会把蜡烛压扁。
    // 注意 regLine 已经是**本局窗口**那一截了（长度 = roundBars()），不用再加 regFrom。
    const regVis = G.regLine ? G.regLine.slice(from, n) : null;
    // 把 Y 轴拉开到能容纳「持仓均价」—— 否则入场线落在可视范围外时，
    // ECharts 会把它贴到坐标轴边缘，看起来像"价格就在最底下"，是骗人的。
    // 强平价只在**离得够近**时才纳入：1 倍杠杆下它在 90% 以外、10 倍下也在 10% 以外，
    // 硬拉进来会把蜡烛压成上面一小撮（试过 0.9 倍跨度的阈值，10 倍杠杆就把图压掉一半）。
    if (G.pos && isFinite(lo) && isFinite(hi)) {
      lo = Math.min(lo, G.avg); hi = Math.max(hi, G.avg);
      const lp0 = liqPriceOf();
      if (lp0 != null && isFinite(lp0)) {
        const span = (hi - lo) || 1;
        if (lp0 > lo - span * 0.25 && lp0 < hi + span * 0.25) { lo = Math.min(lo, lp0); hi = Math.max(hi, lp0); }
      }
    }
    // 挂着的单子也拉进可视范围 —— 挂单挂在天边看不见的话，跟没挂一样没感觉。
    // 但也别把轴拉爆：离得太远的（超过可视跨度 1.5 倍）就不管它，右侧列表里还有。
    if (G.orders.length && isFinite(lo) && isFinite(hi)) {
      const span0 = (hi - lo) || 1;
      G.orders.forEach(o => {
        if (o.price > lo - span0 * 1.5 && o.price < hi + span0 * 1.5) {
          lo = Math.min(lo, o.price); hi = Math.max(hi, o.price);
        }
      });
    }
    const yPad = ((hi - lo) || 1) * 0.08;
    const yMin = isFinite(lo) ? +(lo - yPad).toFixed(2) : undefined;
    const yMax = isFinite(hi) ? +(hi + yPad).toFixed(2) : undefined;

    const marks = [];
    // 现价水平线：横贯整张图，眼睛不用去找最后一根 K 线在哪
    if (G.i) marks.push({ yAxis: G.price, lineStyle: { color: 'rgba(255,255,255,.20)', type: 'solid', width: 1 } });
    if (G.pos) {
      marks.push({
        yAxis: G.avg, lineStyle: { color: THEME.ac, type: 'dashed', width: 1 },
        label: { formatter: '持仓均价 ' + n1(G.avg), color: THEME.ac, fontSize: 10, position: 'insideEndTop' }
      });
      const lp = liqPriceOf();
      if (lp != null && isFinite(lp)) {
        marks.push({
          yAxis: lp, lineStyle: { color: THEME.down, type: 'dotted', width: 1.2 },
          label: { formatter: '强平价 ' + n1(lp), color: THEME.down, fontSize: 10, position: 'insideEndBottom' }
        });
      }
    }
    // 挂单：限价用青色点线、止损用绿、止盈用红
    const ORD_C = { limit: '#4fc3f7', sl: THEME.down, tp: THEME.up };
    G.orders.forEach(o => {
      const tag = o.kind === 'limit' ? (o.dir > 0 ? '挂多 ' : '挂空 ') : (o.kind === 'sl' ? '止损 ' : '止盈 ');
      marks.push({
        yAxis: o.price, lineStyle: { color: ORD_C[o.kind], type: 'dotted', width: 1, opacity: .9 },
        label: {
          formatter: tag + n1(o.price) + (o.kind === 'limit' ? ' ×' + o.lots : ''),
          color: ORD_C[o.kind], fontSize: 9, position: 'insideStartTop'
        }
      });
    });

    G.main.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 58, top: 24, bottom: 24 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        axisPointer: { type: 'cross', label: { backgroundColor: '#2a3140' } },
        formatter: p => {
          const it = p[0]; if (!it) return '';
          const gi = from + it.dataIndex;
          // 顺手把左上角读数也切到这一根。ECharts 的 updateAxisPointer 事件
          // 只在鼠标真实移动时触发，程序化 showTip 不会 —— 两边都挂才稳。
          updateOhlc(gi);
          const b = G.series[gi], s = G.seeds[gi] || {};
          const d = b.c - b.o, dp = b.o ? d / b.o * 100 : 0;
          return labelAt(gi) +
            '<br/>开 <b>' + n1(b.o) + '</b>　高 <b>' + n1(b.h) + '</b>' +
            '<br/>低 <b>' + n1(b.l) + '</b>　收 <b>' + n1(b.c) + '</b>' +
            '<br/>涨跌 <b style="color:' + colorOf(d) + '">' + (d >= 0 ? '+' : '') + n1(d) +
            '　' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%</b>' +
            '<br/><span style="opacity:.7">CAPE ' + (s.cape == null ? '—' : s.cape) +
            '　阵风 ' + (s.gust == null ? '—' : n1(s.gust)) + ' m/s　降水 ' +
            (s.precip == null ? '—' : s.precip) + ' mm</span>';
        }
      },
      xAxis: {
        type: 'category', data: xs, boundaryGap: true,
        axisLine: { lineStyle: { color: THEME.line } },
        axisLabel: { color: THEME.dim, fontSize: 10, hideOverlap: true, interval: Math.max(0, Math.ceil(xs.length / want) - 1) },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value', scale: true, min: yMin, max: yMax,
        axisLabel: { color: THEME.dim, fontSize: 10, formatter: v => v.toFixed(0) },
        // 十字光标的纵向读数：默认会给成 1,103.96 这种带千分位两位小数，太啰嗦
        axisPointer: { label: { formatter: p => (+p.value).toFixed(1), backgroundColor: '#2a3140' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } }
      },
      series: [{
        name: 'WXI', type: 'candlestick', data: bars, z: 3,
        barMaxWidth: 14,
        itemStyle: {
          color: THEME.up, color0: THEME.down,
          borderColor: THEME.up, borderColor0: THEME.down
        },
        markLine: marks.length ? { silent: true, symbol: 'none', data: marks } : undefined
      }].concat(MA_DEF.map((d, k) => ({
        name: 'MA' + d.w, type: 'line', data: maVis[k], z: 4,
        showSymbol: false, smooth: false, connectNulls: false, silent: true,
        lineStyle: { width: 1.1, color: d.color, opacity: .85 }
      }))).concat(G.regLine ? [{
        // 区域大盘：把同省 8 城的天气压成一条线，和本地标的画在一起看背离。
        // 它**不是可交易的合约**，只当参考指标（所以 silent + 不参与 tooltip 之外的计算）。
        name: '大盘', type: 'line', data: regVis, z: 2,
        showSymbol: false, smooth: true, connectNulls: false, silent: true,
        lineStyle: { width: 1.2, color: REG_C, opacity: .8, type: 'dashed' }
      }] : [])
    }, true);
    G._from = from;
    updateOhlc(G.i < 0 ? 0 : G.i);   // 没有悬停时，读数跟着最新一根走

    // 权益图的基准标签：本金可改，这个数字必须跟着走（原来写死在 HTML 里，改成 30 万后就不对了）
    const eqb = $('#ggEqBase');
    if (eqb) eqb.textContent = '¥' + G.cash0.toLocaleString('en-US');

    // ── 现价标签：贴在右侧价格轴上，就是 MT4 那条「当前价」──
    const tag = $('#ggLastTag');
    if (tag) {
      const last = G.series[Math.min(G.i, G.series.length - 1)];
      const c = (last && last.c >= last.o) ? THEME.up : THEME.down;
      tag.textContent = n1(G.price);
      tag.style.background = c;
      try {
        const py = G.main.convertToPixel({ yAxisIndex: 0 }, G.price);
        if (py != null && isFinite(py)) tag.style.top = Math.round(py) + 'px';
      } catch (e) { }
    }

    // 大单爆点：最后一根波动特别大就闪一下
    if (n > from + 1) {
      const b = G.series[n - 1], d = b.c - b.o;
      if (Math.abs(d) / Math.max(1, b.o) > 0.025) floatText((d > 0 ? '▲ +' : '▼ ') + n1(d), colorOf(d), 30);
    }

    const e = G.hist.length ? G.hist : [G.cash];
    const base = G.cash0;
    const col = colorOf(e[e.length - 1] - base);
    const eqFrom = Math.max(0, e.length - vis);
    G.eqc.setOption({
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 56, right: 58, top: 8, bottom: 16 },
      tooltip: {
        trigger: 'axis', confine: true, backgroundColor: 'rgba(20,24,32,.94)',
        borderColor: THEME.line, textStyle: { color: '#dfe4ee', fontSize: 11 },
        formatter: p => { const it = p[0]; return it ? labelAt(eqFrom + it.dataIndex) + '<br/>权益 <b>' + money(it.value) + '</b>' : ''; }
      },
      xAxis: {
        type: 'category', data: xs.slice(0, Math.max(1, e.length - eqFrom)), boundaryGap: true,
        axisLine: { lineStyle: { color: THEME.line } }, axisLabel: { show: false }, axisTick: { show: false }
      },
      yAxis: { type: 'value', scale: true, axisLabel: { color: THEME.dim, fontSize: 9, formatter: v => Math.round(v / 1000) + 'k' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.05)' } } },
      series: [{
        name: '权益', type: 'line', data: e.slice(eqFrom), showSymbol: false,
        lineStyle: { width: 1.4, color: col },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: col + '40' }, { offset: 1, color: col + '00' }]) },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: base, lineStyle: { color: 'rgba(255,255,255,.22)', type: 'dashed', width: 1 }, label: { formatter: '本金', color: THEME.dim, fontSize: 9, position: 'insideEndTop' } }] }
      }]
    }, true);
  }

  /* ═══════════════ 面板渲染 ═══════════════ */
  function render() {
    const e = equity(), diff = e - G.cash0, pct = diff / G.cash0 * 100;
    const col = colorOf(diff);

    const eqEl = $('#ggEquity');
    if (eqEl) {
      if (eqEl.textContent !== n0(e)) {
        eqEl.classList.remove('gg-pop');
        void eqEl.offsetWidth;
        eqEl.classList.add('gg-pop');
      }
      eqEl.textContent = n0(e);
      eqEl.style.color = col;
    }
    const chgEl = $('#ggEqChg');
    if (chgEl) {
      chgEl.textContent = sgnMoney(diff) + '　(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      chgEl.style.color = col;
    }

    const mu = marginUsed(), lp = liqPriceOf();
    const rows = [
      ['WXI 现价', (G.pos || G.i) ? n1(G.price) : '—', 0],
      ['可用保证金', money(freeEq()), freeEq() < 0 ? -1 : 0],
      ['占用保证金', G.pos ? money(mu) : '—', 0],
      ['持仓', G.pos ? (G.pos > 0 ? '多 ' : '空 ') + Math.abs(G.pos) + ' 手' : '空仓', G.pos > 0 ? 1 : G.pos < 0 ? -1 : 0],
      ['持仓均价', G.pos ? n1(G.avg) : '—', 0],
      ['浮动盈亏', G.pos ? sgnMoney(unreal()) : '—', G.pos ? Math.sign(unreal()) : 0],
      ['强平价', (G.pos && lp != null && isFinite(lp)) ? n1(lp) : '—', 0],
      ['爆仓距离', (G.pos && lp != null && isFinite(lp) && G.price) ? (Math.abs(G.price - lp) / G.price * 100).toFixed(2) + '%' : '—', 0]
    ];
    const box = $('#ggStats');
    if (box) {
      box.innerHTML = rows.map(r =>
        '<div class="gg-row' + (r[2] < 0 ? ' gg-warn-row' : '') + '"><span>' + r[0] + '</span><span style="color:' +
        (r[2] ? colorOf(r[2]) : '') + '">' + r[1] + '</span></div>'
      ).join('');
    }

    const sub = $('#ggSub');
    if (sub) {
      const mm = (G.i % perDay()) * barMin();
      const when = G.series.length
        ? ('第 ' + (Math.floor(G.i / perDay()) + 1) + ' 天 ' + U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60) +
          '　·　' + (G.i + 1) + ' / ' + roundBars() + ' 根　·　' + G.lev + ' 倍杠杆')
        : '—';
      sub.textContent = G.city ? (G.city.name + ' WXI 天气指数　·　' + when) : when;
    }

    const lots = Math.floor(maxLots() * G.pct / 100);
    const lab = $('#ggLots');
    if (lab) lab.textContent = G.pct + '% ≈ ' + lots + ' 手' + (lots < 1 ? '（不够 1 手）' : '');

    // ── 下单预估：名义仓位 / 开仓手续费 / 可承受反向波动 ──
    const tPct = tolerablePct(G.pct);
    const calc = $('#ggCalc');
    if (calc) {
      const notional = lots * G.price * LOT_MULT;
      const openFee = Math.max(FEE_MIN, notional * FEE_RATE);
      // 预估滑点：这一单开进去要吃掉多少点、折成钱是多少、占本金几个百分点。
      // 把它明明白白摆出来，玩家才能感觉到「钱多不等于好做」——
      // 这个数与本金成正比，而且小城市还要再乘 dishScale。
      const slip = lots ? slipOf(lots) : 0;
      const slipYuan = lots ? Math.abs(lots) * slip * LOT_MULT : 0;
      const slipOnCap = (lots && G.cash0) ? (slipYuan / G.cash0 * 100) : 0;
      const slipCls = slipOnCap >= 1 ? ' gg-danger' : (slipOnCap >= 0.3 ? '' : ' gg-safe');
      const keyCls = tPct == null ? '' : (tPct < 3 ? ' gg-danger' : (tPct > 12 ? ' gg-safe' : ''));
      calc.innerHTML =
        '<div class="gg-crow"><span>名义仓位</span><b>' + (lots ? money(notional) : '—') + '</b></div>' +
        '<div class="gg-crow"><span>开仓手续费</span><b>' +
        (lots ? '¥' + openFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—') +
        '</b></div>' +
        '<div class="gg-crow gg-key' + slipCls + '"><span>预估滑点</span><b>' +
        (lots ? (slip.toFixed(2) + ' 点 · ¥' + slipYuan.toFixed(0) + ' · 本金 ' + slipOnCap.toFixed(2) + '%') : '—') +
        '</b></div>' +
        '<div class="gg-crow gg-key' + keyCls + '"><span>约可承受反向波动</span><b>' +
        (tPct == null ? '—' : tPct.toFixed(2) + '%') + '</b></div>';
    }

    // ── 成交记录 ──
    const fills = $('#ggFills'), tcount = $('#ggTrades');
    if (tcount) tcount.textContent = G.trades + ' 笔';
    if (fills) {
      if (!G.fills || !G.fills.length) fills.innerHTML = '<div class="gg-empty">还没下过单</div>';
      else fills.innerHTML = G.fills.map(f => {
        const col = f.kind.indexOf('多') >= 0 ? THEME.up : THEME.down;
        return '<div class="gg-f"><span>' + labelAt(f.at) + '</span>' +
          '<span style="color:' + col + '">' + f.kind + ' ' + f.lots + ' 手</span>' +
          '<span>' + n1(f.px) + '</span></div>';
      }).join('');
    }

    // ── 挂单列表 ──
    const ordBox = $('#ggOrders'), ordTip = $('#ggOrdTip');
    if (ordBox) {
      if (!G.orders.length) {
        ordBox.innerHTML = '<div class="gg-empty">没有挂单</div>';
      } else {
        ordBox.innerHTML = G.orders.map(o => {
          const isL = o.kind === 'limit';
          const col = isL ? '#4fc3f7' : (o.kind === 'sl' ? THEME.down : THEME.up);
          const name = isL ? (o.dir > 0 ? '限价多' : '限价空') : (o.kind === 'sl' ? '止损' : '止盈');
          const dist = G.price ? ((o.price - G.price) / G.price * 100) : 0;
          return '<div class="gg-o"><span style="color:' + col + '">' + name + '</span>' +
            '<span>' + (isL ? o.lots + ' 手' : '全平') + '</span>' +
            '<span>' + n1(o.price) + '</span>' +
            '<span class="dim">' + (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%</span>' +
            '<button class="gg-x" data-cancel="' + o.id + '" title="撤单">×</button></div>';
        }).join('');
      }
      if (ordTip) {
        const nL = G.orders.filter(o => o.kind === 'limit').length;
        const nS = G.orders.length - nL;
        ordTip.textContent = G.orders.length ? (nL + ' 个限价 · ' + nS + ' 个止损止盈') : '碰到价才成交';
      }
    }

    // ── 天气日历 ──
    // 注意别用 setT：它是在这个函数下面才 const 出来的，从这里调会踩 TDZ
    const calBox = $('#ggCal'), calTip = $('#ggCalTip');
    if (calBox) {
      const evs = calendarAt(G.i, perDay());
      if (calTip) calTip.textContent = '未来 24 小时 · ' + (evs.length ? evs.length + ' 次变天' : '风平浪静');
      if (!evs.length) {
        calBox.innerHTML = '<div class="gg-empty">接下来一天没什么动静</div>';
      } else {
        calBox.innerHTML = evs.slice(0, 6).map(e => {
          // 强度档是按实测 |Δsev| 分布定的：整局中位 0.06、p99 约 1.7、max 约 2.5，
          // 门槛 JUMP_AT=0.9 之上才进日历。所以「剧烈」是真的少见。
          const bars = Math.min(4, Math.max(1, Math.ceil(e.d / 0.7)));
          const when = labelAt(e.from) + (e.to > e.from ? '–' + labelAt(e.to).replace(/^D\d+ /, '') : '');
          return '<div class="gg-c"><span>' + when + '</span>' +
            '<i class="t' + bars + '">' + '▮'.repeat(bars) + '</i>' +
            '<b>' + (e.d >= 2.0 ? '剧烈' : e.d >= 1.3 ? '明显' : '一般') + '</b></div>';
        }).join('');
      }
    }

    const bl = $('#ggLong'), bs = $('#ggShort');
    if (bl && bs) bl.disabled = bs.disabled = (G.ended || !G.running || lots < 1);
    const bc = $('#ggClosePos');
    if (bc) bc.disabled = !G.pos;

    // ── 终端行情条 + 大号下单键上的价格 ──
    // 学 MT4/MT5：买卖价直接印在按钮上，不用先去看报价再回来点。
    // 「点差」这里显示的是**真实成本**：一手开+平的两次手续费，
    // 既折算成指数点数也给出金额 —— 不是装样子的假数字。
    const px = (G.pos || G.i) ? G.price : 0;
    const setT = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    if (px) {
      const costPts = px * FEE_RATE * 2;                       // 指数点
      const costYuan = px * LOT_MULT * FEE_RATE * 2;           // 每手 ¥
      setT('#ggTbSell', n1(px));
      setT('#ggTbBuy', n1(px));
      setT('#ggTbSpread', costPts.toFixed(1) + ' 点');
      setT('#ggSym', (G.city ? G.city.name : 'WXI') + ' WXI');
      // 把大盘是由哪几个城市平均出来的写进 title，鼠标停一下就能看到
      const symEl = $('#ggSym');
      if (symEl) symEl.title = G.regCities && G.regCities.length
        ? ('区域大盘 = ' + G.regCities.join(' / ') + ' 的等权平均（15 分钟，同省最多 8 城）')
        : '这台设备的区域大盘取不到，本局是纯本地行情';
      const mm = (G.i % perDay()) * barMin();
      setT('#ggTbTime', '第 ' + (Math.floor(G.i / perDay()) + 1) + ' 天 ' +
        U.pad2(Math.floor(mm / 60)) + ':' + U.pad2(mm % 60));
      const cost = $('#ggTbSpread');
      if (cost) cost.title = '一手开+平的手续费，合计 ¥' + costYuan.toFixed(2);
      setT('#ggTbConn', G.ended ? '已收盘' : (G.running ? '行情推送中' : '已暂停'));
      // 「行情速度」那一行右边实时报一局大概要跑多久 —— 光看数字没有体感
      const secs = roundSecs();
      setT('#ggSpeedTip', '一局约 ' + (secs >= 90 ? (secs / 60).toFixed(1) + ' 分钟' : Math.round(secs) + ' 秒'));
      const lp2 = $('#ggLongPx'), sp2 = $('#ggShortPx');
      if (lp2) lp2.textContent = n1(px);
      if (sp2) sp2.textContent = n1(px);
    } else {
      ['#ggTbSell', '#ggTbBuy', '#ggTbSpread', '#ggTbTime', '#ggLongPx', '#ggShortPx'].forEach(s => setT(s, '—'));
      setT('#ggTbConn', '未开局');
    }

    const panel = $('.game-panel');
    if (panel) {
      const ratio = mu > 0 ? e / mu : 9;
      panel.classList.toggle('danger2', mu > 0 && ratio < 1 + MAINTAIN * 3);
      panel.classList.toggle('danger', mu > 0 && ratio < 1 + MAINTAIN * 9 && ratio >= 1 + MAINTAIN * 3);
    }
    const live = $('#ggLive');
    if (live) {
      const hot = mu > 0 && e < mu * 2;
      live.textContent = G.ended ? '已收盘' : (G.running ? (hot ? '⚠ 保证金告急' : '做盘中') : '已暂停');
      live.className = 'gg-live' + (G.ended || !G.running ? ' off' : hot ? ' hot' : '');
    }

    drawCharts();
  }

  function floatText(txt, color, size) {
    const panel = $('.game-panel');
    if (!panel) return;
    const d = document.createElement('div');
    d.className = 'gg-float'; d.textContent = txt; d.style.color = color;
    if (size) d.style.fontSize = size + 'px';
    d.style.left = (16 + Math.random() * 44) + '%';
    d.style.top = '34%';
    panel.appendChild(d);
    setTimeout(() => d.remove(), 1100);
  }

  /* ═══════════════ 主循环 ═══════════════ */
  /** 一帧推进多少根 K 线。
   *  速度的单位是「每真实秒推进多少分钟天气」，换成根就是 SPEEDS/barMin()，
   *  再除以帧率。**必须用小数累加器**：1 分钟档在「慢」速下只有
   *  15/1/10 = 1.5 根/秒，每帧 0.15 根，取整就永远是 0 了。
   *  一帧可能推进好几根（60 分钟档 + 狂暴 = 90/60/10 = 0.15 根/帧，不会；
   *  但 1 分钟档 + 狂暴 = 90/1/10 = 9 根/帧），所以循环里逐根走、
   *  只在整批结束后 render 一次。挂单/爆仓仍然**逐根**判定 —— 影线扫到
   *  止损价就该在那一根成交，不能等这一批走完才看。 */
  function tick() {
    if (!G.running || G.ended) return;
    G.acc += (SPEEDS[G.speedIdx] / barMin()) / TICK_HZ;
    let step = Math.floor(G.acc);
    if (step < 1) return;                       // 还没攒够一根
    G.acc -= step;

    const eqBefore = equity();
    let news = null;

    for (let k = 0; k < step; k++) {
      if (G.i >= G.series.length - 1) { endRound('timeup'); return; }

      const prevPx = G.price;
      G.i++;
      G.price = G.series[G.i].c;

      // 挂单 / 止损止盈先跑，再判爆仓 —— 顺序反了的话，止损单会因为
      // "这一根已经先爆仓了"而永远来不及救你。
      processOrders(prevPx);

      const mu = marginUsed();
      if (mu > 0 && equity() <= mu * MAINTAIN) {
        liquidate();
        G.hist.push(G.cash);
        G.peak = Math.max(G.peak, G.cash);
        trackDD();
        if (global.navigator && navigator.vibrate) { try { navigator.vibrate([80, 60, 220]); } catch (e) { } }
        beep(110, .5, 'sawtooth', .09);
        render();
        endRound('liquidated');
        return;
      }

      const e = equity();
      G.hist.push(e);
      G.peak = Math.max(G.peak, e);
      trackDD();

      // 天气事件闪报（数值全是真的）；一帧走多根时只留最后一条，
      // 否则狂暴速下飘字会糊满屏幕
      const nw = newsAt(G.i);
      if (nw) news = nw;
    }

    if (news) flashNews(news);

    const mu = marginUsed(), e = equity();
    // 保证金告急的滴答声
    if (mu > 0 && e < mu * 1.6) beep(1180, .05, 'square', .022);
    // 里程碑音效
    if (Math.floor(eqBefore / 10000) !== Math.floor(e / 10000)) beep(e > eqBefore ? 880 : 320, .09, 'triangle', .035);
    render();
  }
  function trackDD() { const e = equity(); if (G.peak > 0) G.maxDD = Math.max(G.maxDD, (G.peak - e) / G.peak); }

  function startTimer() {
    stopTimer();
    G.acc = 0;
    G.timer = setInterval(tick, 1000 / TICK_HZ);
  }
  function stopTimer() { if (G.timer) { clearInterval(G.timer); G.timer = null; } }

  /* ═══════════════ 一局的生命周期 ═══════════════ */
  function resetState() {
    G.i = 0;
    G.price = G.series.length ? G.series[0].c : 0;
    G.cash = G.cash0;
    G.pos = 0; G.avg = 0;
    G.peak = G.cash0; G.maxDD = 0; G.trades = 0;
    G.fills = [];
    G.slipPaid = 0; G.feePaid = 0;
    G.orders = []; G.orderSeq = 0;
    G.hist = [G.cash0];
    G.liqPrice = null; G.liqAt = 0; G.lastNews = '';
    G.ended = false;
  }

  async function beginRound() {
    const cover = $('#ggCover');
    const app = global.__APP;
    const city = (app && app.S && app.S.cur) || null;
    if (!city) { toast('先选一个城市'); return; }

    if (cover) cover.innerHTML = '<div class="gg-card"><h2>取行情中…</h2><p>正在取 <b>' + city.name + '</b> 的 15 分钟天气行情</p><p class="dim">本地 92 天的对流能量 / 阵风 / 降水，外加同省城市的大盘，第一次要几秒。</p></div>';

    // 六个源并发取（本地 15 分钟行情 / 同省大盘 / 空气 / 地震 / 台风 / 预报偏离）。
    // 除了本地行情，其余**任何一个拿不到都只是那一项退化成 0**，不影响开局。
    let mn = null, reg = null;
    const extra = { air: null, quake: null, typh: null, fcst: null };
    try {
      const all = await Promise.all([
        API.OpenMeteo.minutely(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.regionIndex(city).catch(() => null),
        API.OpenMeteo.airHistory(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.quakes(city.lat, city.lon).catch(() => null),
        API.OpenMeteo.typhoons().catch(() => null),
        API.OpenMeteo.previousRuns(city.lat, city.lon).catch(() => null)
      ]);
      mn = all[0]; reg = all[1];
      extra.air = all[2]; extra.quake = all[3]; extra.typh = all[4]; extra.fcst = all[5];
    } catch (e) { mn = null; reg = null; }

    const picked = mn && pickSeries(mn, reg, city, extra);
    if (!picked) {
      if (cover) cover.innerHTML = '<div class="gg-card"><h2 class="lose">取不到行情</h2>' +
        '<p>15 分钟级天气数据没取回来（多半是 Open-Meteo 那边不通或额度用完了）。</p>' +
        '<p class="dim">过一会儿再试，或者换一个城市。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggRetry">再试一次</button>' +
        '<button class="gg-short" id="ggQuit">退出</button></div></div>';
      bindCoverOnce();
      return;
    }

    G.city = city;
    G.series = picked.series;
    G.seeds = picked.seeds;
    G.sev = picked.sevWin;
    G.regLine = picked.regLine;      // 大盘线（没有就是 null，图上也就不画）
    G.regFrom = picked.regFrom || 0;
    G.regCities = picked.regCities;  // 组成大盘的城市名，显示在副图标题上
    G.base = picked.base;            // 15 分钟原样那一份，局中换周期时重采样用
    G.baseSeeds = picked.baseSeeds;
    G.baseReg = picked.baseReg;
    resetState();
    readTheme();
    ensureCharts();
    if (cover) cover.hidden = true;

    G.running = true;
    startTimer();
    render();
  }

  function endRound(why) {
    G.running = false;
    G.ended = true;
    stopTimer();

    const finalEq = (why === 'liquidated') ? G.cash : equity();
    const ret = finalEq / G.cash0;
    const profit = finalEq - G.cash0;
    const liq = why === 'liquidated';

    let gr = 'E';
    if (liq) gr = 'F';
    else if (ret >= 5) gr = 'SSS';
    else if (ret >= 3) gr = 'S';
    else if (ret >= 2) gr = 'A';
    else if (ret >= 1.5) gr = 'B';
    else if (ret >= 1.15) gr = 'C';
    else if (ret >= 1.0) gr = 'D';

    const verdict = liq
      ? (G.lev >= 50 ? '百倍杠杆，反向一两个点就没了 —— 这正是久留美的下场。'
        : G.lev >= 20 ? '天台档 + 满仓，气象台都没你亏得快。'
          : G.lev >= 10 ? '十倍杠杆下，天气反向走一点点就清零了。'
            : '不是你方向错了，是你仓位太大了。')
      : profit > 0 ? (ret >= 2 ? '这波对流被你吃干净了。' : '见好就收，也是一种本事。')
        : '没亏就是赢，天气这东西本来就不好赌。';

    // 最佳记录存**收益率**而不是金额 —— 本金能改了，拿「赚了多少万」比大小没意义
    // （本金 1000 万赚 5 万和本金 1 万赚 5 万完全不是一回事）。
    // 用新键，老的绝对金额记录自然失效，不用做迁移。
    const rPct = (ret - 1) * 100;
    const bestP = storeGet('wxgame_bestp', null);
    const isNewBest = bestP == null || rPct > +bestP;
    if (isNewBest) { storeSet('wxgame_bestp', rPct.toFixed(2)); storeSet('wxgame_bestc', G.cash0); }
    const bestShow = isNewBest ? rPct : +bestP;
    const bestCash = isNewBest ? G.cash0 : +(storeGet('wxgame_bestc', 0) || 0);

    const btns = '<div class="gg-btns"><button class="gg-long" id="ggAgain">再来一局</button>' +
      '<button class="gg-short" id="ggQuit">退出</button></div>';

    const cover = $('#ggCover');
    if (cover) {
      cover.innerHTML =
        '<div class="gg-card">' +
        (liq ? '<div class="gg-flash"></div>' : '') +
        '<h2 class="' + (profit >= 0 ? 'win' : 'lose') + '">' + (liq ? '爆 仓' : profit >= 0 ? '收 盘 盈 利' : '收 盘 亏 损') + '</h2>' +
        '<div class="gg-grade">' + gr + '</div>' +
        '<div class="gg-final" style="color:' + colorOf(profit) + '">' + money(finalEq) + '</div>' +
        '<p>' + (liq ? '权益跌破维持保证金，被强制平仓。' : '7 天走完，自动结算。') + '</p>' +
        '<p style="color:' + colorOf(profit) + '">' + sgnMoney(profit) + '　（' + (profit >= 0 ? '+' : '') + ((ret - 1) * 100).toFixed(2) + '%）</p>' +
        '<div class="gg-tbl">' +
        '<div class="gg-row"><span>标的</span><span>' + (G.city ? G.city.name : '—') + ' WXI 天气指数</span></div>' +
        '<div class="gg-row"><span>本金</span><span>' + money(G.cash0) + '</span></div>' +
        '<div class="gg-row"><span>杠杆</span><span>' + G.lev + ' 倍</span></div>' +
        '<div class="gg-row"><span>爆仓时点</span><span>' + (liq ? (labelAt(G.liqAt) + '　@ ' + n1(G.liqPrice)) : '—') + '</span></div>' +
        '<div class="gg-row"><span>最大回撤</span><span>' + (G.maxDD * 100).toFixed(1) + '%</span></div>' +
        '<div class="gg-row"><span>下单次数</span><span>' + G.trades + '</span></div>' +
        '<div class="gg-row"><span>累计成本</span><span>手续费 ¥' + (G.feePaid || 0).toFixed(0) +
        ' · 滑点 ¥' + (G.slipPaid || 0).toFixed(0) + '</span></div>' +
        '<div class="gg-row"><span>本机最佳</span><span>' + (bestShow >= 0 ? '+' : '') + (+bestShow).toFixed(2) + '%' +
        '<span class="dim" style="font-weight:400">　（本金 ' + money(bestCash) + '）</span></span></div>' +
        '</div>' +
        '<p class="dim" style="font-size:12px">' + verdict + '</p>' +
        btns +
        '</div>';
      cover.hidden = false;
    }
    if (liq) { floatText('爆 仓', '#ff4d4f', 34); beep(90, .7, 'sawtooth', .1); }
    bindCoverOnce();
    render();
  }

  function bindCoverOnce() {
    const a = $('#ggAgain'), r = $('#ggRetry'), q = $('#ggQuit');
    if (a) a.onclick = () => beginRound();
    if (r) r.onclick = () => beginRound();
    if (q) q.onclick = () => close();
    // 本金选择器（只出现在开场卡片里）
    U.$$('.gg-cbtn').forEach(b => { b.onclick = () => setCash(+b.dataset.cash); });
    const inp = $('#ggCash');
    if (inp) {
      // 边打边改会一次次 clamp，光标乱跳，所以只在失焦/回车时落地
      inp.onchange = () => setCash(inp.value);
      inp.onkeydown = e => { if (e.key === 'Enter') { setCash(inp.value); inp.blur(); } };
    }
    cashTip();
  }

  /* ═══════════════ 交互 ═══════════════ */
  function trade(dir) {
    if (!G.running || G.ended) return;
    const lots = Math.floor(maxLots() * G.pct / 100);
    if (lots < 1) { toast('可用保证金不够开 1 手'); return; }
    applyFill(dir * lots);
    beep(dir > 0 ? 660 : 440, .07, 'square', .03);
    const r = $('.gg-right');
    if (r) { r.classList.remove('gg-pop'); void r.offsetWidth; r.classList.add('gg-pop'); }
    render();
  }

  function closeAll() {
    if (!G.running || G.ended || !G.pos) return;
    applyFill(-G.pos);
    beep(520, .08, 'square', .03);
    render();
  }

  function setSeg(sel, attr, val) {
    U.$$(sel).forEach(b => b.classList.toggle('on', b.dataset[attr] === String(val)));
  }

  /* 本金选择器（只在开场卡片里，局中不给改 —— 亏了再充值就不叫操盘了）。
     顺手算出「按基准 1000 点，这个本金在当前杠杆下满仓能开多少手」，
     好让人直观感到本金大小到底影响什么。 */
  function cashRowHTML() {
    const chips = CASH_PRESETS.map(v =>
      '<button type="button" class="gg-cbtn' + (v === G.cash0 ? ' on' : '') + '" data-cash="' + v + '">' +
      cashShort(v) + '</button>').join('');
    return '<div class="gg-cash">' +
      '<div class="gg-cash-head"><span>本金</span><b id="ggCashShow">' + money(G.cash0) + '</b></div>' +
      '<div class="gg-cash-row">' + chips +
      '<input class="gg-inp" id="ggCash" type="number" inputmode="numeric" step="1000" ' +
      'min="' + CASH_MIN + '" max="' + CASH_MAX + '" value="' + G.cash0 + '" title="自定义本金（' +
      n0(CASH_MIN) + ' ~ ' + n0(CASH_MAX) + '）"></div>' +
      '<p class="gg-cash-tip" id="ggCashTip"></p>' +
      '</div>';
  }
  function cashShort(v) {
    if (v >= 10000) { const w = v / 10000; return (w % 1 ? w.toFixed(1) : w) + ' 万'; }
    return n0(v);
  }
  // 本金能改，而且**真的会改变难度** —— 这一点以前写错了，现在靠三样东西成立：
  //   ① 最低手续费 5 元：本金越小，手续费占本金的比例越高，小资金被磨得更狠；
  //   ② 滑点与名义金额成正比：钱越多、单子越大，越难在你要的价位全部成交；
  //   ③ 小地方的盘子更小：同样的单子下到县城，滑点要乘上 dishScale（最大 2.6 倍）。
  // 当然仓位百分比那条仍然成立（本金翻 10 倍手数也翻 10 倍），
  // 所以文案里要把①②讲清楚，而不是笼统地说"更难"。
  function cashTip() {
    const T = $('#ggCashTip');
    if (!T) return;
    const lots = Math.floor(G.cash0 / (BASE * LOT_MULT / G.lev));
    const notional = lots * BASE * LOT_MULT;
    const fee = Math.max(FEE_MIN, notional * FEE_RATE);
    const slipYuan = lots * slipOf(lots) * LOT_MULT;
    const pct = G.cash0 ? ((fee + slipYuan) / G.cash0 * 100) : 0;
    const capped = slipOf(lots) >= SLIP_MAX - 1e-9;
    T.innerHTML = '按基准 <b>' + BASE + '</b> 点、当前 <b>' + G.lev + '×</b> 杠杆，满仓约 <b>' + n0(lots) +
      '</b> 手。<br>满仓<b>开一次 + 平一次</b>的手续费 + 滑点约 <b>¥' + n0((fee + slipYuan) * 2) +
      '（本金的 ' + (pct * 2).toFixed(2) + '%）</b>。本金越大、城市越小，这个数越肉疼：' +
      '手续费有 <b>¥' + FEE_MIN + ' 保底</b>，滑点随名义金额上涨' +
      (capped ? '（已触到 <b>' + SLIP_MAX + ' 点</b>上限）' : '') + ' —— 钱多不等于好做。';
  }
  function setCash(v) {
    v = Math.round(+v);
    if (!isFinite(v) || v <= 0) v = DEF_CASH;
    v = Math.max(CASH_MIN, Math.min(CASH_MAX, v));
    G.cash0 = v;
    storeSet('wxgame_cash', v);
    const s = $('#ggCashShow'); if (s) s.textContent = money(v);
    const inp = $('#ggCash'); if (inp && +inp.value !== v) inp.value = v;
    U.$$('.gg-cbtn').forEach(b => b.classList.toggle('on', +b.dataset.cash === v));
    cashTip();
  }

  /* K 线周期选择器。**局中也能换** —— 换的时候不重新取数据，而是拿开局留着的
     那份 15 分钟原样序列重采样一遍，再把"已经推进到第几分钟天气"映射到新周期的
     下标上。所以 1 分钟图看到第 3 天 12:00 切到 60 分钟图，还是第 3 天 12:00 附近，
     行情不会跳。持仓、挂单、权益都原样保留（价格口径没变，只是画粗画细）。 */
  function barRowHTML() {
    const chips = BAR_MIN.map((m, i) =>
      '<button type="button" class="gg-bbtn' + (i === G.barIdx ? ' on' : '') + '" data-bar="' + i + '">' +
      BAR_N[i] + '</button>').join('');
    return '<div class="gg-bar"><div class="gg-bar-head"><span>K 线周期</span>' +
      '<b id="ggBarShow">' + BAR_N[G.barIdx] + '</b></div>' +
      '<div class="gg-bar-row">' + chips + '</div>' +
      '<p class="gg-bar-tip" id="ggBarTip"></p></div>';
  }
  /** 真实粒度只有 15 分钟，所以得跟玩家说清楚哪几档是采到的、哪几档是画出来的。 */
  function barTip() {
    const T = $('#ggBarTip');
    if (!T) return;
    const m = barMin();
    const n = perDay();
    const base = '一局 <b>' + ROUND_DAYS + '</b> 天 = <b>' + n0(roundBars()) + '</b> 根，' +
      '每根 <b>' + m + '</b> 分钟（一天 ' + n0(n) + ' 根）。';
    const src = m > SRC_MIN
      ? 'Open-Meteo 的免费数据最细就是 <b>15 分钟</b>，这一档是把它 ' + (m / SRC_MIN) + ' 根并成 1 根，<b>全是真数据</b>。'
      : (m === SRC_MIN
        ? '这一档就是数据源<b>原样</b> —— Open-Meteo 最细只给到 15 分钟，<b>全是真数据</b>。'
        : '数据源最细只有 <b>15 分钟</b>，所以这一档是<u>插值展开</u>的 —— 收盘价沿 15 分钟的开→收走、影线按比例分，' +
          '细碎波动是<b>画出来的</b>，不是采到的。走势和 15 分钟档一致。');
    T.innerHTML = base + src;
  }
  function setBar(idx) {
    idx = Math.max(0, Math.min(BAR_MIN.length - 1, Math.round(+idx) || 0));
    storeSet('wxgame_bar', idx);
    if (idx === G.barIdx || !G.base) { G.barIdx = idx; syncBar(); return; }
    // 已经推进到第几分钟天气：G.i 是**最后一根已经走完的** K 线，所以"现在"在
    // 它的收盘时刻，也就是 (G.i + 1) × 旧周期。
    const nowMin = (G.i + 1) * barMin();
    const hist = G.hist.slice();
    G.barIdx = idx;
    const rs = resample(G.base, G.baseSeeds, G.baseReg);
    G.series = rs.series; G.seeds = rs.seeds; G.regLine = rs.regLine;
    // 只认"已经走完"的那些根 —— 下标 i 的 K 线**收于** (i+1)×周期，所以要
    // G.i = floor(nowMin / 周期) - 1。用 ceil/round 会往前跳到一段**未来**天气的
    // 收盘价上，白白扫掉止损；宁向往回退，退后不会超过一个周期。
    G.i = Math.max(0, Math.min(G.series.length - 1, Math.floor(nowMin / barMin()) - 1));
    G.price = G.series[G.i] ? G.series[G.i].c : G.price;
    G.hist = hist;                            // 权益曲线照旧攒着，不因为换周期断掉
    syncBar();
    render();
  }
  function syncBar() {
    const s = $('#ggBarShow'); if (s) s.textContent = BAR_N[G.barIdx];
    // 注意选的是 #ggBar button 而不是某个类名 —— index.html 里那几个按钮没写类
    U.$$('#ggBar button').forEach(b => b.classList.toggle('on', +b.dataset.bar === G.barIdx));
    barTip();
  }

  /* ═══════════════ 开关面板 ═══════════════ */
  function open() {
    readTheme();
    const mask = $('#game');
    if (!mask) return;
    mask.hidden = false;
    G.open = true;
    // 本金存的是"上次用过的"，第一次进来是默认值
    const saved = Math.round(+(storeGet('wxgame_cash', DEF_CASH) || DEF_CASH));
    G.cash0 = (isFinite(saved) && saved >= CASH_MIN && saved <= CASH_MAX) ? saved : DEF_CASH;
    // K 线周期也存上次用过的
    const sb = Math.round(+(storeGet('wxgame_bar', 2)));
    G.barIdx = (isFinite(sb) && sb >= 0 && sb < BAR_MIN.length) ? sb : 2;
    const cover = $('#ggCover');
    if (cover) {
      const app = global.__APP;
      const cityName = (app && app.S && app.S.cur && app.S.cur.name) || '当前城市';
      cover.hidden = false;
      cover.innerHTML =
        '<div class="gg-card">' +
        '<h2 style="font-size:22px;letter-spacing:2px">🎮 点击做空天气</h2>' +
        '<p>标的：<b>WXI 复合天气指数</b> —— <b>' + cityName + '</b> 本地的对流能量 / 阵风 / 降水 / 露点，' +
        '<b>外加同省城市平均出来的「大盘」</b>，再叠一层盘子扰动。<br>' +
        '打雷下雨 = 拉升，天气转好 = 回落。你不知道这段是哪年哪月 —— 只能靠盘感。</p>' +
        cashRowHTML() +
        '<ul class="gg-rules">' +
        '<li>一局 <b>7 天</b>，K 线周期有 <b>1 / 5 / 15 / 30 / 45 / 60 分钟</b>六档，右下角随时换。</li>' +
        '<li>图上那条<b style="color:#c792ea">紫色虚线就是大盘</b>（同省 8 城等权平均）。' +
        '本地跑赢大盘 = 自己这块地在出事；本地跟着大盘走 = 一场天气过程路过。</li>' +
        '<li>合约：指数每动 <code>1 点</code>，每手盈亏 <code>¥10</code>。</li>' +
        '<li>杠杆决定保证金：满仓时反向走 <code>(1−10%)÷杠杆</code> 就<u>爆仓</u>。' +
        '10 倍约 9%、20 倍约 4.5%、<b>100 倍只要 0.9%</b>。</li>' +
        '<li>手续费万分之五，开平都收。</li>' +
        '<li>右侧随时看得到<b>强平价</b>和<b>爆仓距离</b> —— 碰到就结束。</li>' +
        '<li>行情速度 <b>15 / 22 / 45 / 90 分钟天气每秒</b>，一局 <b>1.9 ~ 11.2 分钟</b>，随时能暂停。' +
        '速度是"每秒推进多少天气时间"，所以跟 K 线周期无关 —— 挑 1 分钟只是看得更细，不会玩得更久。</li>' +
        '</ul>' +
        '<p class="dim" style="font-size:12px">纯娱乐，和真实气象服务无关，也别拿这套路去真赌天气。</p>' +
        '<div class="gg-btns"><button class="gg-long" id="ggAgain">开始操盘</button>' +
        '<button class="gg-short" id="ggQuit">算了</button></div>' +
        '</div>';
      bindCoverOnce();
    }
    setTimeout(() => {
      ensureCharts();
      readTheme();
      setSeg('#ggLev button', 'lev', G.lev);
      setSeg('#ggPct button', 'pct', G.pct);
      setSeg('#ggSpeed button', 'sp', G.speedIdx);
      syncBar();
      render();
    }, 30);
  }

  function close() {
    stopTimer();
    G.running = false; G.open = false;
    const mask = $('#game');
    if (mask) mask.hidden = true;
    disposeCharts();
  }

  /* ═══════════════ 接线 ═══════════════ */
  function bind() {
    const btn = $('#btnGame');
    if (btn) btn.addEventListener('click', open);
    const x = $('#ggExit');
    if (x) x.addEventListener('click', close);
    const mask = $('#game');
    if (mask) mask.addEventListener('click', e => { if (e.target === mask) close(); });

    const L = $('#ggLong'), S = $('#ggShort'), C = $('#ggClosePos');
    if (L) L.addEventListener('click', () => trade(1));
    if (S) S.addEventListener('click', () => trade(-1));
    if (C) C.addEventListener('click', closeAll);

    // ── 挂单 ──
    // 价格框空着就按现价预填：绝大多数时候你想挂的就是"现价上下一点点"，
    // 每次手打五位数字太反人类。
    const ordPx = $('#ggOrdPx'), ordLots = $('#ggOrdLots');
    function readPx() {
      const v = parseFloat(ordPx && ordPx.value);
      return (isFinite(v) && v > 0) ? v : G.price;
    }
    function readLots() {
      const v = Math.floor(parseFloat(ordLots && ordLots.value));
      if (isFinite(v) && v >= 1) return v;
      return Math.floor(maxLots() * G.pct / 100);
    }
    function ordFeedback(err) {
      if (err) { toast(err); beep(200, .12, 'square', .04); }
      else render();
    }
    const ob = $('#ggOrdBuy'), os = $('#ggOrdSell'), sl = $('#ggSetSl'), tp = $('#ggSetTp');
    if (ob) ob.addEventListener('click', () => ordFeedback(placeLimit(1, readPx(), readLots())));
    if (os) os.addEventListener('click', () => ordFeedback(placeLimit(-1, readPx(), readLots())));
    if (sl) sl.addEventListener('click', () => ordFeedback(setStop('sl', readPx())));
    if (tp) tp.addEventListener('click', () => ordFeedback(setStop('tp', readPx())));
    // 撤单用事件委托 —— 列表每次 render 都是重建的，逐个绑会漏
    const ordBox = $('#ggOrders');
    if (ordBox) ordBox.addEventListener('click', e => {
      const b = e.target.closest('[data-cancel]');
      if (!b) return;
      cancelOrder(+b.dataset.cancel);
      render();
    });

    U.$$('#ggLev button').forEach(b => b.addEventListener('click', () => {
      G.lev = +b.dataset.lev; setSeg('#ggLev button', 'lev', G.lev); render();
    }));
    U.$$('#ggPct button').forEach(b => b.addEventListener('click', () => {
      G.pct = +b.dataset.pct; setSeg('#ggPct button', 'pct', G.pct); render();
    }));
    U.$$('#ggSpeed button').forEach(b => b.addEventListener('click', () => {
      G.speedIdx = +b.dataset.sp; setSeg('#ggSpeed button', 'sp', G.speedIdx);
      if (G.running) startTimer();
    }));
    // K 线周期：局中也能换（setBar 会把已推进的天气时间映射到新周期上）
    U.$$('#ggBar button').forEach(b => b.addEventListener('click', () => setBar(b.dataset.bar)));
    const snd = $('#ggSound');
    if (snd) snd.addEventListener('click', () => {
      G.sound = !G.sound; snd.textContent = G.sound ? '🔊' : '🔇';
      snd.title = G.sound ? '音效：开' : '音效：关';
    });

    // 键盘：↑/W 做多，↓/S 做空，空格平仓 —— 手速快才跟得上 24 根/秒
    global.addEventListener('keydown', e => {
      if (!G.open) return;
      if (e.key === 'Escape') { close(); return; }
      if (!G.running || G.ended) return;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { trade(1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { trade(-1); e.preventDefault(); }
      else if (e.key === ' ') { closeAll(); e.preventDefault(); }
    });
    global.addEventListener('resize', U.debounce(() => { if (G.open) { if (G.main) G.main.resize(); if (G.eqc) G.eqc.resize(); } }, 120));
  }

  global.Game = {
    open, close, G, bind,
    _t: {
      pickSeries, severity, ema, median, robustScale, applyFill, applyFillAt, equity, marginUsed,
      liqPriceOf, maxLots, beginRound, endRound, tick, beep, labelAt, newsAt, visBars,
      tolerablePct, placeLimit, setStop, cancelOrder, processOrders, calendarAt, freeEq,
      reservedMargin, JUMP_AT, setCash, cashTip, cityWeight, dishScale,
      slipOf, render, SLIP_K, SLIP_MAX, CAP_BASE, FEE_MIN,
      LEVS, LOT_MULT, MAINTAIN, FEE_RATE, SPEEDS,
      BASE, DEF_CASH, CASH_MIN, CASH_MAX, CASH_PRESETS,
      REG_K, DEW_K, DISH_K, DISH_DECAY,
      distKm, AIR_K, QUAKE_M0, QUAKE_K, QUAKE_R, QUAKE_DECAY, TYPHOON_R, TYPHOON_K, FCST_K,
      ROUND_DAYS, BAR_MIN, BAR_N, SRC_MIN, SPEED_N, TICK_HZ,
      perDay, roundBars, srcBars, barMin, roundSecs, resample, aggSeed, zag, fmtMin, setBar
    }
  };

  bind();

  // ?game=1 直接开局（和 ?help=1 / ?welcome=1 一个路子）
  try { if (/[?&]game=1\b/.test(global.location.search)) setTimeout(open, 500); } catch (e) { }
})(window);
