/* astro.js — 天文计算（纯函数：不取数、不碰 DOM、不发网络请求）
 *
 * 为什么要自己算：Open-Meteo 只给日出日落；月出月落、月相、黄金/蓝调时刻、
 * 天文暮光这些**没有任何免 key 又带 CORS 的接口**（USNO 的 api 域名都解析不出来，
 * timeanddate 一类没有公开接口）。好在这几样都是可以本地推的经典算法。
 *
 * 算法取 Meeus《Astronomical Algorithms》的低精度简化式：
 *   太阳：平黄经 + 中心差，赤纬精度 ~0.01°。
 *   ⚠ 日出日落的**实测**精度是 **0.2～2.4 分钟**，不是这里原来写的"±1 分钟" ——
 *     拿 sunrise-sunset.org 那套独立的 NOAA 实现对了 30 组（北京/广州/拉萨/漠河/三亚/
 *     曾母暗沙 × 5 个日期：2026 春分/夏至/秋分/冬至/10-08）。差的那一分多钟来自
 *     2 分钟粗扫的步长与两套近似式的取法差别；对表够用，但**别在界面上写比这更小的数**。
 *   月亮：黄经 6 项、黄纬 4 项简化级数，位置精度 ~0.3° → 月出月落 ±10 分钟。
 * 对"今晚适不适合搬凳子出去看星星"这个问题绰绰有余 —— 不会指错一整档。
 *
 * 全部对外接口挂在 window.ASTRO 上；时间一律用毫秒时间戳（跟 Date 一致）。 */
(function (global) {
  'use strict';

  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const SYN = 29.530588853;                                  // 朔望月长度（天）
  const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14) / 86400000;  // 2000-01-06 18:14 UTC 那次新月

  const sind = x => Math.sin(x * D2R);
  const cosd = x => Math.cos(x * D2R);
  const norm360 = x => ((x % 360) + 360) % 360;
  const jdOf = ms => ms / 86400000 + 2440587.5;               // 1970-01-01T00:00Z = JD 2440587.5

  /* ── 太阳 ── */
  function sunRaDec(ms) {
    const n = jdOf(ms) - 2451545.0;
    const L = norm360(280.460 + 0.9856474 * n);               // 平黄经
    const g = norm360(357.528 + 0.9856003 * n);               // 平近点角
    const lam = norm360(L + 1.915 * sind(g) + 0.020 * sind(2 * g));
    const eps = 23.439 - 0.0000004 * n;                       // 黄赤交角
    return {
      ra: norm360(Math.atan2(cosd(eps) * sind(lam), cosd(lam)) * R2D),
      dec: Math.asin(sind(eps) * sind(lam)) * R2D
    };
  }

  /* ── 月亮（Meeus 第 47 章的简化式，精度约 0.3°） ──
   * 把五个辐角单独拆出来：月亮的**位置**和**距离**用的是同一组量，
   * 拆开就不用算两遍，也免得两个函数各写一份级数。 */
  function moonArgs(ms) {
    const T = (jdOf(ms) - 2451545.0) / 36525;
    return {
      T: T,
      Lp: norm360(218.316 + 481267.881 * T),             // 平黄经
      M: norm360(134.963 + 477198.867 * T),              // 平近点角
      F: norm360(93.272 + 483202.017 * T),               // 升交点角距
      D: norm360(297.850 + 445267.112 * T),              // 日月平距角
      Ms: norm360(357.528 + 35999.050 * T)               // 太阳平近点角
    };
  }

  function moonRaDec(ms) {
    const a = moonArgs(ms);
    const lam = a.Lp
      + 6.289 * sind(a.M) - 1.274 * sind(2 * a.D - a.M) + 0.658 * sind(2 * a.D)
      + 0.214 * sind(2 * a.M) - 0.186 * sind(a.Ms) - 0.114 * sind(2 * a.F);
    const bet = 5.128 * sind(a.F) + 0.281 * sind(a.M + a.F)
      - 0.278 * sind(a.F - a.M) - 0.173 * sind(a.F - 2 * a.D);
    const eps = 23.439 - 0.0000004 * (jdOf(ms) - 2451545.0);
    return {
      ra: norm360(Math.atan2(sind(lam) * cosd(eps) - Math.tan(bet * D2R) * sind(eps), cosd(lam)) * R2D),
      dec: Math.asin(sind(bet) * cosd(eps) + cosd(bet) * sind(eps) * sind(lam)) * R2D
    };
  }

  /** 地心距离（公里）。前 5 项，误差约 ±0.3%（±1200 km）——
   *  判"超级月亮/微月"够用了（近地点 356500、远地点 406700，两者差 14%）。 */
  function moonDistance(ms) {
    const a = moonArgs(ms);
    return 385000.56
      - 20905.355 * cosd(a.M)
      - 3699.111 * cosd(2 * a.D - a.M)
      - 2955.968 * cosd(2 * a.D)
      - 569.925 * cosd(2 * a.M);
  }

  /** 视直径（度）。月亮半径 1737.4 km；典型值 0.49°（远）～0.56°（近）。 */
  function moonSizeDeg(ms) {
    return 2 * Math.atan(1737.4 / moonDistance(ms)) * R2D;
  }

  /** 格林尼治平恒星时（度） */
  function gmstDeg(ms) {
    return norm360(280.46061837 + 360.98564736629 * (jdOf(ms) - 2451545.0));
  }

  /** 由赤经赤纬算某地的地平高度（度）。忽略大气折射 —— 日出日落用 -0.833° 门槛来补。 */
  function altOf(ra, dec, ms, lat, lon) {
    const H = norm360(gmstDeg(ms) + lon - ra);                // 时角
    return Math.asin(sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(H)) * R2D;
  }

  const sunAlt = (ms, lat, lon) => { const s = sunRaDec(ms); return altOf(s.ra, s.dec, ms, lat, lon); };
  const moonAlt = (ms, lat, lon) => { const m = moonRaDec(ms); return altOf(m.ra, m.dec, ms, lat, lon); };

  /* ── 月相 ── */
  /** 相位 0 = 新月、0.5 = 满月。八等分取名字 + 一个能直接放在标题里的 emoji。 */
  function moonPhase(ms) {
    const days = (ms instanceof Date ? ms.getTime() : Number(ms)) / 86400000;
    if (!isFinite(days)) return { p: 0, illum: 0, name: '--', emoji: '🌑', age: 0 };
    const p = ((((days - NEW_MOON_REF) % SYN) + SYN) % SYN) / SYN;
    const names = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];
    const emoji = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    const idx = Math.floor(p * 8 + 0.5) % 8;
    return {
      p: p, illum: (1 - Math.cos(2 * Math.PI * p)) / 2,
      name: names[idx], emoji: emoji[idx], age: p * SYN
    };
  }

  function moonPhaseTxt(ms) {
    const m = moonPhase(ms);
    if (m.name === '--') return '--';
    return m.name + ' ' + Math.round(m.illum * 100) + '%';
  }

  /* ── 阈值穿越求解 ──
   * 先按 step 分钟粗扫，发现变号再二分 20 次（≈ 0.1 秒）。比牛顿法省事，
   * 而且在"当天没有穿越"（极昼极夜）时自然返回空数组，不用额外判特例。 */
  function crossings(altFn, t0, t1, h0, stepMin) {
    const step = (stepMin || 2) * 60000;
    const out = [];
    let prevT = t0, prev = altFn(t0) - h0;
    for (let t = t0 + step; t <= t1; t += step) {
      const cur = altFn(t) - h0;
      if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0)) {
        let a = prevT, b = t, fa = prev - h0;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2, fm = altFn(m) - h0;
          if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else { b = m; }
        }
        out.push({ t: (a + b) / 2, dir: cur > prev ? 1 : -1 });
      }
      prev = cur; prevT = t;
    }
    return out;
  }

  /* 太阳事件的语义命名。门槛：
   *   +6°  —— 摄影上"黄金时刻"的上界
   *   -4°  —— 黄金时刻的下界、蓝调时刻的上界
   *   -6°  —— 蓝调时刻的下界，再低就是天文暮光（天真正黑透）
   *   -0.833° —— 日出日落（太阳中心 + 大气折射 + 视半径的标准门槛） */
  const SUN_EVENTS = [
    { h: 6, dir: -1, kind: 'golden', label: '黄金时刻开始' },
    { h: 6, dir: 1, kind: 'golden-end', label: '黄金时刻结束' },
    { h: -0.833, dir: -1, kind: 'sunset', label: '日落' },
    { h: -0.833, dir: 1, kind: 'sunrise', label: '日出' },
    { h: -4, dir: -1, kind: 'blue', label: '蓝调时刻开始' },
    { h: -4, dir: 1, kind: 'blue-end', label: '蓝调时刻结束' },
    { h: -6, dir: -1, kind: 'dark', label: '天全黑' },
    { h: -6, dir: 1, kind: 'dawn', label: '天开始亮' }
  ];

  /** 把 [t0,t1] 之间所有太阳事件按时间排好。
   *  一次扫描同时判 8 个门槛（每个采样点只算一次太阳高度），比扫 4 遍快 4 倍。 */
  function sunEvents(t0, t1, lat, lon) {
    const step = 2 * 60000;
    const alt = ms => sunAlt(ms, lat, lon);
    let prevT = t0, prevA = alt(t0);
    const raw = [];
    for (let t = t0 + step; t <= t1; t += step) {
      const a = alt(t);
      SUN_EVENTS.forEach(ev => {
        const pv = prevA - ev.h, cv = a - ev.h;
        if ((pv <= 0 && cv > 0) || (pv >= 0 && cv < 0)) {
          const goingUp = cv > pv;
          if ((ev.dir === 1) !== goingUp) return;
          let x = prevT, y = t, fx = pv;
          for (let k = 0; k < 20; k++) {
            const m = (x + y) / 2, fm = alt(m) - ev.h;
            if ((fx < 0) === (fm < 0)) { x = m; fx = fm; } else { y = m; }
          }
          raw.push({ t: (x + y) / 2, kind: ev.kind, label: ev.label });
        }
      });
      prevA = a; prevT = t;
    }
    raw.sort((p, q) => p.t - q.t);
    return raw;
  }

  /** 取现在起接下来一个"天文夜"：太阳低于 -6° 的那一段（可能有多个，取第一个够长的）。
   *  极昼时返回 null —— 调用方要能接受"今晚没有真正的天黑"。 */
  function nextNight(ms, lat, lon) {
    const evs = sunEvents(ms - 12 * 3600000, ms + 36 * 3600000, lat, lon);
    let start = null;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.kind === 'dark') start = e.t;
      else if (e.kind === 'dawn' && start != null && e.t > ms - 6 * 3600000) {
        return { from: Math.max(start, ms - 6 * 3600000), to: e.t };
      }
    }
    return null;
  }

  /** 月亮出没：门槛取 +0.125°（视差 0.95° − 折射 0.57° − 视半径 0.25° 的标准口径）。 */
  function moonEvents(t0, t1, lat, lon) {
    const alt = ms => moonAlt(ms, lat, lon);
    return crossings(alt, t0, t1, 0.125, 3).map(c => ({
      t: c.t, kind: c.dir > 0 ? 'moonrise' : 'moonset',
      label: c.dir > 0 ? '月出' : '月落'
    })).sort((a, b) => a.t - b.t);
  }

  /* ── 观星评分 ──
   * 满分 100，七项：
   *   低云   40 —— 云是头号敌人，而且**低云是硬伤**：它就在你头顶，直接挡星
   *   中高云 25 —— 软伤：高层薄云肉眼看着还是"晴"，但它把背景亮度抬起来，
   *              暗目标（银河、深空）先糊。这也是为什么非要分层云量不可
   *   降水   12 —— 有雨雪直接扣
   *   湿度    6 —— >90% 会起雾结露，镜面废掉
   *   风      6 —— >8 m/s 抖得没法看，视宁度也差
   *   月光    6 —— 满月能把背景亮度抬高 2~3 等
   *   通透度  5 —— AOD（气溶胶光学厚度）与能见度里**更差的那个**，共用同一格，不重复扣
   * 另有三条**封顶**：低云 ≥90% 封 20、≥70% 封 45、中高云 ≥85% 且低云少封 55。
   * 加封顶是因为纯线性扣分曾经算出"低云 80% → 67 分 不错"这种明显不诚实的结论 ——
   * 云是观星唯一的天敌，别的项再好也救不回来。
   *
   * 分层云量（cloudLow/cloudMid/cloudHigh）来自 Open-Meteo，和主站天气**同一次请求**，
   * 所以这一页永远不可能跟上面的天气数据互相打脸。
   * 没有分层数据时退化成"总云量同时扣前两项"，跟老口径等价，不会凭空多给分。 */
  function starScore(o) {
    o = o || {};
    const why = [];
    const hasLayers = (o.cloudLow != null || o.cloudMid != null || o.cloudHigh != null);
    const total = o.cloud == null ? 50 : o.cloud;
    const low = hasLayers ? (o.cloudLow || 0) : total;
    const high = hasLayers ? Math.max(o.cloudMid || 0, o.cloudHigh || 0) : total;
    const precip = o.precip == null ? 0 : o.precip;
    const hum = o.humidity == null ? 60 : o.humidity;
    const wind = o.wind == null ? 2 : o.wind;

    let s = 100 - low * 0.40 - high * 0.25;
    if (low >= 60) why.push('低云 ' + Math.round(low) + '%，挡得严实');
    else if (low <= 15 && high <= 25) why.push(hasLayers ? '低云少、中高云也薄，通透' : '云量 ' + Math.round(total) + '%，通透');
    if (high >= 50 && low < 60) why.push('中高云 ' + Math.round(high) + '%，薄云会糊掉暗目标');

    if (precip > 0) { s -= 12; why.push('有降水 ' + precip.toFixed(1) + ' mm'); }
    if (hum > 90) { s -= 6; why.push('湿度 ' + Math.round(hum) + '%，易起雾结露'); }
    else if (hum > 80) s -= 3;
    if (wind > 8) { s -= 6; why.push('风 ' + wind.toFixed(1) + ' m/s，视宁度差'); }
    else if (wind > 5) s -= 3;
    if (o.moonUp) {
      s -= (o.moonIllum || 0) * 6;
      if ((o.moonIllum || 0) > 0.6) why.push('月光亮（' + Math.round(o.moonIllum * 100) + '%）');
    }
    // 通透度：AOD 与能见度各算一个 0～5 的扣分，取更差的那个（两者高度相关，不能重复扣）
    let tr = 2.5;                                   // 两个都没有时给中间值，别变成隐藏加分
    if (o.aod != null) {
      tr = Math.min(5, Math.max(0, o.aod * 12.5));
      if (o.aod >= 0.4) why.push('气溶胶偏多（AOD ' + o.aod.toFixed(2) + '）');
    }
    if (o.vis != null && o.vis < 12000) {
      const vt = Math.min(5, Math.max(0, (12000 - o.vis) / 12000 * 5));
      if (vt > tr) { tr = vt; why.push('能见度只有 ' + (o.vis / 1000).toFixed(1) + ' km'); }
    }
    s -= tr;

    // 云量封顶（见上面那段注释：线性扣分给出过"低云 80% = 67 分"这种不诚实的结论）
    let cap = 100;
    if (low >= 90) cap = 20;
    else if (low >= 70) cap = 45;
    else if (high >= 85 && low < 30) cap = 55;
    if (s > cap) s = cap;

    s = Math.max(0, Math.min(100, Math.round(s)));
    return {
      score: s, why: why, capped: cap,
      label: s >= 80 ? '极佳' : s >= 60 ? '不错' : s >= 40 ? '一般' : s >= 20 ? '较差' : '不宜',
      color: s >= 80 ? '#2ecc71' : s >= 60 ? '#7ed957' : s >= 40 ? '#f0c419' : s >= 20 ? '#e67e22' : '#e74c3c'
    };
  }

  /* ── 地磁活动 / 极光 ── */
  /** Kp → 地磁暴等级（NOAA 的 G 分级就是 Kp 5~9 对应 G1~G5）。 */
  function kpScale(kp) {
    if (kp == null || !isFinite(kp)) return { g: '', text: '—', color: '#7f8c9a' };
    if (kp >= 9) return { g: 'G5', text: '超强地磁暴', color: '#c0392b' };
    if (kp >= 8) return { g: 'G4', text: '强地磁暴', color: '#e74c3c' };
    if (kp >= 7) return { g: 'G3', text: '大地磁暴', color: '#e67e22' };
    if (kp >= 6) return { g: 'G2', text: '中等地磁暴', color: '#f0c419' };
    if (kp >= 5) return { g: 'G1', text: '小地磁暴', color: '#f1c40f' };
    if (kp >= 4) return { g: '', text: '活跃', color: '#7ed957' };
    return { g: '', text: '平静', color: '#3498db' };
  }

  /** 在某个纬度上看到极光大约需要多强的 Kp。
   *  经验口径（中国极光摄影圈的共识）：漠河（53°N）要 Kp≥7、
   *  新疆北部（48°N 上下）要 Kp≥8、华北（44°N）要 Kp≥9，再往南没戏。
   *  返回 10 表示"Kp 满格也看不到"，调用方据此说人话。 */
  function auroraNeedKp(lat) {
    const a = Math.abs(lat == null ? 0 : lat);
    if (a >= 52) return 7;
    if (a >= 48) return 8;
    if (a >= 44) return 9;
    return 10;
  }

  /* ── 流星雨 ──
   * 静态表（IMO 的 9 场主要流星雨）。**peak 是 [月, 日]，没有年份** ——
   * 年份在 nextShowers 里按"当前年份"现推，所以这张表不会过完今年就失效。
   *
   * ⚠ 准到什么程度 —— 别把它当成 IMO 的年度预报：
   *   · 活动期 from/to、辐射点、母体：常年不变，可信；
   *   · **极大日期是传统的日历日，不等于天文上的"极大时刻"**。IMO 是用**太阳黄经 λ☉**
   *     定义极大的，同一个 λ☉ 落到日历年上会漂 ±1 天；
   *   · **ZHR 是"常年参考值"，不是今年的预测** —— 象限仪座在 60～200 之间年际起伏，
   *     双子座这些年持续增强，天龙座还爆过（2011 年 ZHR 一度到 600+）。
   *   · 这一页真正"算出来的"只有**月光干扰**（用真实月相算）与最佳时段，那部分可信。
   * 要更准就把 peak 换成 λ☉、运行时反解那次穿越的瞬时（astro.js 里本来就有太阳黄经，
   * 顺手能暴露出来）。现在没做是因为**没有可信的 λ☉ 表**：www.imo.net 正在迁站，
   * 历年日历 PDF 现在全部 302 到"正在重建"页，Wikipedia 在这台机器上又连不通。 */
  const SHOWERS = [
    { name: '象限仪座流星雨', code: 'QUA', from: [12, 28], peak: [1, 3], to: [1, 12], zhr: 110, radiant: '牧夫座', parent: '小行星 2003 EH1' },
    { name: '天琴座流星雨', code: 'LYR', from: [4, 16], peak: [4, 22], to: [4, 25], zhr: 18, radiant: '天琴座', parent: '彗星 C/1861 G1' },
    { name: '宝瓶座 η 流星雨', code: 'ETA', from: [4, 19], peak: [5, 6], to: [5, 28], zhr: 50, radiant: '宝瓶座', parent: '哈雷彗星' },
    { name: '南宝瓶座 δ 流星雨', code: 'SDA', from: [7, 12], peak: [7, 30], to: [8, 23], zhr: 25, radiant: '宝瓶座', parent: '彗星 96P/Machholz' },
    { name: '英仙座流星雨', code: 'PER', from: [7, 17], peak: [8, 13], to: [8, 24], zhr: 100, radiant: '英仙座', parent: '彗星 109P/Swift-Tuttle' },
    { name: '猎户座流星雨', code: 'ORI', from: [10, 2], peak: [10, 21], to: [11, 7], zhr: 20, radiant: '猎户座', parent: '哈雷彗星' },
    { name: '狮子座流星雨', code: 'LEO', from: [11, 6], peak: [11, 18], to: [11, 30], zhr: 15, radiant: '狮子座', parent: '彗星 55P/Tempel-Tuttle' },
    { name: '双子座流星雨', code: 'GEM', from: [12, 4], peak: [12, 14], to: [12, 20], zhr: 150, radiant: '双子座', parent: '小行星 3200 Phaethon' },
    { name: '小熊座流星雨', code: 'URS', from: [12, 17], peak: [12, 22], to: [12, 26], zhr: 10, radiant: '小熊座', parent: '彗星 8P/Tuttle' }
  ];

  /** 一场流星雨"当前这一轮"的活动窗口，ms 不在窗口里就返回 null。
   *  ⚠ 跨年那场（象限仪座 12/28 → 1/12）以前**算错了**：窗口只按"ms 所在年份"推一次
   *  （`from = mk(y-1, 12/28)`、`to = mk(y, 1/12)`），于是
   *   ① 12/28～12/31 被算成"不在活动期"（其实正处在活动期）；
   *   ② 收尾那天也被判掉 —— `to` 取的是当天 00:00，1/12 晚上当然大于它。
   *  现在两个候选窗口都试，并且 `to` 取**那一天的最后一毫秒**。 */
  function activeWindow(ms, s) {
    const mk = (yy, md) => new Date(yy, md[0] - 1, md[1], 0, 0, 0).getTime();
    const endOf = (yy, md) => mk(yy, md) + 86399999;
    const y = new Date(ms).getFullYear();
    const wrap = s.from[0] > s.to[0];
    const cands = wrap
      ? [[mk(y, s.from), endOf(y + 1, s.to)], [mk(y - 1, s.from), endOf(y, s.to)]]
      : [[mk(y, s.from), endOf(y, s.to)]];
    for (let i = 0; i < cands.length; i++) {
      if (ms >= cands[i][0] && ms <= cands[i][1]) return { from: cands[i][0], to: cands[i][1] };
    }
    return null;
  }

  /** 接下来 n 场流星雨的极大。峰值一律取当地 02:00 —— 后半夜辐射点最高、
   *  也是所有流星雨的传统最佳观测时段。**这是显示约定，不是天文上的极大时刻。**
   *
   *  ★ 年份是运行时现推的，所以这张表**不会"过完今年就失效"**：
   *    2026/12/31 查会给出 2027/1/3 的象限仪座，2030/12/31 会给出 2031/1/3 的。
   *
   *  ★ 正在活动期的那场排最前，而且给的是**这一轮**的极大（哪怕刚过去一两天），
   *    不是"明年那一轮"。以前会把明年的极大贴上"正在活动期"的标签，很误导。 */
  function nextShowers(ms, n) {
    const y = new Date(ms).getFullYear();
    const out = [];
    SHOWERS.forEach(s => {
      const win = activeWindow(ms, s);
      const mk2 = yy => new Date(yy, s.peak[0] - 1, s.peak[1], 2, 0, 0).getTime();
      let peak = null;
      if (win) {                                  // 在活动期：取落在这一轮窗口里的那个极大
        for (let yy = y - 1; yy <= y + 1; yy++) {
          const p = mk2(yy);
          if (p >= win.from && p <= win.to) { peak = p; break }
        }
      }
      if (peak == null) {                         // 否则取下一个还没到的极大
        for (let yy = y; yy <= y + 1; yy++) {
          const p = mk2(yy);
          if (p >= ms) { peak = p; break }
        }
      }
      if (peak == null) return;
      out.push({ s: s, peak: peak, days: (peak - ms) / 86400000, active: !!win });
    });
    out.sort((a, b) => (a.active !== b.active) ? (a.active ? -1 : 1) : (a.peak - b.peak));
    return out.slice(0, n || 4);
  }

  /* ── 方位角 ──
   * altOf 只给高度。要回答"往哪边看"就得有方位角：从正北起、顺时针 0→360
   * （90=正东、180=正南、270=正西）。用 Meeus 13.5 的自南向西方位角再加 180 度。 */
  function azOf(ra, dec, ms, lat, lon) {
    const H = gmstDeg(ms) + lon - ra;
    const alt = altOf(ra, dec, ms, lat, lon);
    const A = Math.atan2(sind(H), cosd(H) * sind(lat) - Math.tan(dec * D2R) * cosd(lat)) * R2D;
    return { alt: alt, az: norm360(A + 180) };
  }

  const DIR16 = ['正北', '北偏东', '东北', '东偏北', '正东', '东偏南', '东南', '南偏东',
    '正南', '南偏西', '西南', '西偏南', '正西', '西偏北', '西北', '北偏西'];
  function dirName(az) { return DIR16[Math.round(norm360(az) / 22.5) % 16]; }

  /* ── 亮星表（J2000 赤经赤纬，取自耶鲁亮星星表） ──
   * 只列**肉眼最容易认出来的那些**（全部亮于 2.1 等），中英双名都给：
   * 中文名给习惯叫法，英文名用来消歧（同一个中文名在不同书里可能指不同的星）。
   * 这张表是死的，不会过期，也不会跟任何天气数据打架。
   * ⚠ 用途是"抬头往哪看"，不是精密天体测量 —— 差个零点几度肉眼根本看不出来。 */
  const STARS = [
    { n: '天狼星', en: 'Sirius', ra: 101.287, dec: -16.716, m: -1.46, con: '大犬座' },
    { n: '老人星', en: 'Canopus', ra: 95.988, dec: -52.696, m: -0.74, con: '船底座' },
    { n: '南门二', en: 'Rigil Kentaurus', ra: 219.902, dec: -60.834, m: -0.27, con: '半人马座' },
    { n: '大角星', en: 'Arcturus', ra: 213.915, dec: 19.182, m: -0.05, con: '牧夫座' },
    { n: '织女一', en: 'Vega', ra: 279.235, dec: 38.784, m: 0.03, con: '天琴座' },
    { n: '五车二', en: 'Capella', ra: 79.172, dec: 45.998, m: 0.08, con: '御夫座' },
    { n: '参宿七', en: 'Rigel', ra: 78.634, dec: -8.202, m: 0.13, con: '猎户座' },
    { n: '南河三', en: 'Procyon', ra: 114.825, dec: 5.225, m: 0.34, con: '小犬座' },
    { n: '水委一', en: 'Achernar', ra: 24.428, dec: -57.237, m: 0.46, con: '波江座' },
    { n: '参宿四', en: 'Betelgeuse', ra: 88.793, dec: 7.407, m: 0.50, con: '猎户座' },
    { n: '马腹一', en: 'Hadar', ra: 210.956, dec: -60.373, m: 0.61, con: '半人马座' },
    { n: '河鼓二', en: 'Altair', ra: 297.696, dec: 8.868, m: 0.77, con: '天鹰座' },
    { n: '十字架二', en: 'Acrux', ra: 186.650, dec: -63.099, m: 0.77, con: '南十字座' },
    { n: '毕宿五', en: 'Aldebaran', ra: 68.980, dec: 16.509, m: 0.85, con: '金牛座' },
    { n: '角宿一', en: 'Spica', ra: 201.298, dec: -11.161, m: 1.04, con: '室女座' },
    { n: '心宿二', en: 'Antares', ra: 247.352, dec: -26.432, m: 1.09, con: '天蝎座' },
    { n: '北河三', en: 'Pollux', ra: 116.329, dec: 28.026, m: 1.14, con: '双子座' },
    { n: '北落师门', en: 'Fomalhaut', ra: 344.413, dec: -29.622, m: 1.16, con: '南鱼座' },
    { n: '天津四', en: 'Deneb', ra: 310.358, dec: 45.280, m: 1.25, con: '天鹅座' },
    { n: '十字架三', en: 'Mimosa', ra: 191.930, dec: -59.689, m: 1.25, con: '南十字座' },
    { n: '轩辕十四', en: 'Regulus', ra: 152.093, dec: 11.967, m: 1.35, con: '狮子座' },
    { n: '弧矢七', en: 'Adhara', ra: 104.656, dec: -28.972, m: 1.50, con: '大犬座' },
    { n: '北河二', en: 'Castor', ra: 113.650, dec: 31.888, m: 1.58, con: '双子座' },
    { n: '尾宿八', en: 'Shaula', ra: 263.402, dec: -37.104, m: 1.62, con: '天蝎座' },
    { n: '十字架一', en: 'Gacrux', ra: 187.791, dec: -57.113, m: 1.63, con: '南十字座' },
    { n: '参宿五', en: 'Bellatrix', ra: 81.283, dec: 6.350, m: 1.64, con: '猎户座' },
    { n: '五车五', en: 'Elnath', ra: 81.573, dec: 28.608, m: 1.65, con: '金牛座' },
    { n: '南船五', en: 'Miaplacidus', ra: 138.300, dec: -69.717, m: 1.67, con: '船底座' },
    { n: '参宿二', en: 'Alnilam', ra: 84.053, dec: -1.202, m: 1.69, con: '猎户座' },
    { n: '鹤一', en: 'Alnair', ra: 332.058, dec: -46.961, m: 1.74, con: '天鹤座' },
    { n: '玉衡', en: 'Alioth', ra: 193.507, dec: 55.960, m: 1.77, con: '大熊座' },
    { n: '天枢', en: 'Dubhe', ra: 165.932, dec: 61.751, m: 1.79, con: '大熊座' },
    { n: '天船三', en: 'Mirfak', ra: 51.081, dec: 49.861, m: 1.79, con: '英仙座' },
    { n: '弧矢一', en: 'Wezen', ra: 107.098, dec: -26.393, m: 1.83, con: '大犬座' },
    { n: '箕宿三', en: 'Kaus Australis', ra: 276.043, dec: -34.385, m: 1.85, con: '人马座' },
    { n: '摇光', en: 'Alkaid', ra: 206.885, dec: 49.313, m: 1.86, con: '大熊座' },
    { n: '尾宿五', en: 'Sargas', ra: 264.330, dec: -42.998, m: 1.86, con: '天蝎座' },
    { n: '海石一', en: 'Avior', ra: 125.628, dec: -59.510, m: 1.86, con: '船底座' },
    { n: '五车三', en: 'Menkalinan', ra: 89.882, dec: 44.947, m: 1.90, con: '御夫座' },
    { n: '三角形三', en: 'Atria', ra: 252.166, dec: -69.028, m: 1.91, con: '南三角座' },
    { n: '井宿三', en: 'Alhena', ra: 99.428, dec: 16.399, m: 1.93, con: '双子座' },
    { n: '孔雀十一', en: 'Peacock', ra: 306.412, dec: -56.735, m: 1.94, con: '孔雀座' },
    { n: '勾陈一', en: 'Polaris', ra: 37.955, dec: 89.264, m: 1.98, con: '小熊座', note: '北极星' },
    { n: '军市一', en: 'Mirzam', ra: 95.675, dec: -17.956, m: 1.98, con: '大犬座' },
    { n: '星宿一', en: 'Alphard', ra: 141.897, dec: -8.659, m: 1.98, con: '长蛇座' },
    { n: '娄宿三', en: 'Hamal', ra: 31.793, dec: 23.463, m: 2.00, con: '白羊座' },
    { n: '土司空', en: 'Deneb Kaitos', ra: 10.897, dec: -17.987, m: 2.04, con: '鲸鱼座' },
    { n: '斗宿四', en: 'Nunki', ra: 283.816, dec: -26.297, m: 2.05, con: '人马座' },
    { n: '库楼三', en: 'Menkent', ra: 211.672, dec: -36.370, m: 2.06, con: '半人马座' },
    { n: '壁宿二', en: 'Alpheratz', ra: 2.097, dec: 29.090, m: 2.06, con: '仙女座' },
    // 不是恒星，但观星的人最想知道的"往哪看"就是它 —— 银河系中心（人马座 A*）
    { n: '银河中心', en: 'Sgr A*', ra: 266.417, dec: -29.008, m: 99, con: '人马座', note: '银心' }
  ];

  /** 此刻地平线以上的亮星（按亮度排）。minAlt 默认 8° —— 太贴地平的星星
   *  被大气消光和地面遮挡得厉害，报出来也没用。 */
  function brightStars(ms, lat, lon, minAlt) {
    const lim = (minAlt == null ? 8 : minAlt);
    const out = [];
    STARS.forEach(s => {
      const p = azOf(s.ra, s.dec, ms, lat, lon);
      if (p.alt < lim) return;
      out.push({
        name: s.n, en: s.en, con: s.con, mag: s.m, note: s.note || '',
        alt: p.alt, az: p.az, dir: dirName(p.az)
      });
    });
    out.sort((a, b) => a.mag - b.mag);
    return out;
  }

  /* ── 行星（JPL 简化开普勒元素，1800–2050 有效） ──
   * 表来自 JPL "Approximate Positions of the Major Planets"：
   * 六个元素 a / e / I / 平黄经 L / 近日点黄经 / 升交点黄经，外加每儒略世纪变率。
   * 精度：内行星角分级、木星土星十几角分 —— 回答"天上那颗亮的往哪看"绰绰有余。 */
  const EARTH_EL = [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0];
  const EARTH_RT = [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0];
  const PLANET_TAB = [
    { n: '水星', en: 'Mercury', el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
      rt: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
    { n: '金星', en: 'Venus', el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
      rt: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
    { n: '火星', en: 'Mars', el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
      rt: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
    { n: '木星', en: 'Jupiter', el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
      rt: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
    { n: '土星', en: 'Saturn', el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
      rt: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    // 天王星、海王星：**肉眼都看不见**（5.5 等 / 7.8 等），但在不在天上、几点升到多高
    // 跟那五颗是同一个问题，所以照样算。行里会带上星等，使用者自己看得出要上双筒。
    { n: '天王星', en: 'Uranus', el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
      rt: [0.00000198, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
    { n: '海王星', en: 'Neptune', el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
      rt: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] }
  ];

  /** 解开普勒方程 M = E − e·sinE（弧度）。牛顿迭代 12 次封顶，正常 3～4 次就收敛。 */
  function kepler(M, e) {
    let E = M;
    for (let i = 0; i < 12; i++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-10) break;
    }
    return E;
  }

  /** 日心黄道直角坐标（J2000 黄道面），单位 AU */
  function helio(el, rt, T) {
    const a = el[0] + rt[0] * T, e = el[1] + rt[1] * T, I = el[2] + rt[2] * T;
    const L = el[3] + rt[3] * T, w = el[4] + rt[4] * T, O = el[5] + rt[5] * T;
    let M = norm360(L - w); if (M > 180) M -= 360;
    const E = kepler(M * D2R, e);
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const wp = (w - O) * D2R, om = O * D2R, inc = I * D2R;
    return {
      x: (Math.cos(wp) * Math.cos(om) - Math.sin(wp) * Math.sin(om) * Math.cos(inc)) * xp -
        (Math.sin(wp) * Math.cos(om) + Math.cos(wp) * Math.sin(om) * Math.cos(inc)) * yp,
      y: (Math.cos(wp) * Math.sin(om) + Math.sin(wp) * Math.cos(om) * Math.cos(inc)) * xp -
        (Math.sin(wp) * Math.sin(om) - Math.cos(wp) * Math.cos(om) * Math.cos(inc)) * yp,
      z: (Math.sin(wp) * Math.sin(inc)) * xp + (Math.cos(wp) * Math.sin(inc)) * yp
    };
  }

  /** 日地距离（AU）。就是地球轨道的**日心半径** —— 跟 `planets()` 里算地球位置用的是
      同一个量。太阳的视直径、以及"现在离太阳近不近"（近日点 1 月初、远日点 7 月初）都靠它。 */
  function sunDist(ms) {
    const T = (jdOf(ms) - 2451545.0) / 36525;
    const E = helio(EARTH_EL, EARTH_RT, T);
    return Math.sqrt(E.x * E.x + E.y * E.y + E.z * E.z);
  }

  /** 视星等的经验式（Mallama 那一套的简化版，土星环忽略不计） */
  /** 行星的视星等：V = H + 5·log10(r·Δ) + 相位项。
      前五颗用 Astronomical Almanac 的经典拟合（含相位角的多项式）；
      天王星、海王星用 Harris 的 H（−7.19 / −6.87）加一个极小的相位项 ——
      它们离太阳太远，相位角最大也就 3° 上下，那项基本可以忽略，但留着不吃亏。
      ⚠ 表里没有名字时退回 `-2 + base`，那只是个占位，**不代表真实亮度**。 */
  function magOf(N, r, d, i) {
    const base = 5 * Math.log10(r * d);
    const f = {
      '水星': () => -0.42 + base + 0.0380 * i - 0.000273 * i * i + 0.000002 * i * i * i,
      '金星': () => -4.40 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i,
      '火星': () => -1.52 + base + 0.016 * i,
      '木星': () => -9.40 + base + 0.005 * i,
      '土星': () => -8.88 + base + 0.044 * i,
      '天王星': () => -7.19 + base + 0.0028 * i,
      '海王星': () => -6.87 + base + 0.0018 * i
    }[N];
    const v = f ? f() : -2 + base;
    return isFinite(v) ? v : null;
  }

  /** 此刻七颗行星的高度/方位/亮度。返回按亮度排好的一列。
      ⚠ 后两颗（天王星 5.5 等、海王星 7.8 等）**肉眼看不见**，要双筒或小望远镜；
        页面上靠星等那一列自己说明，不额外加标记。 */
  function planets(ms, lat, lon) {
    const T = (jdOf(ms) - 2451545.0) / 36525;
    const E = helio(EARTH_EL, EARTH_RT, T);
    const eR = Math.sqrt(E.x * E.x + E.y * E.y + E.z * E.z);
    const eps = (23.43928 - 0.0000004 * (jdOf(ms) - 2451545.0)) * D2R;
    const sun = sunRaDec(ms);
    const out = [];
    PLANET_TAB.forEach(p => {
      const h = helio(p.el, p.rt, T);
      const x = h.x - E.x, y = h.y - E.y, z = h.z - E.z;
      const d = Math.sqrt(x * x + y * y + z * z);
      const elonLon = norm360(Math.atan2(y, x) * R2D), elat = Math.asin(z / d) * R2D;
      const ra = norm360(Math.atan2(sind(elonLon) * Math.cos(eps) - Math.tan(elat * D2R) * Math.sin(eps), cosd(elonLon)) * R2D);
      const dec = Math.asin(sind(elat) * Math.cos(eps) + cosd(elat) * Math.sin(eps) * sind(elonLon)) * R2D;
      const r = Math.sqrt(h.x * h.x + h.y * h.y + h.z * h.z);
      const cosi = (r * r + d * d - eR * eR) / (2 * r * d);
      const phase = Math.acos(Math.max(-1, Math.min(1, cosi))) * R2D;
      const elong = Math.acos(Math.max(-1, Math.min(1,
        sind(dec) * sind(sun.dec) + cosd(dec) * cosd(sun.dec) * cosd(ra - sun.ra)))) * R2D;
      const av = azOf(ra, dec, ms, lat, lon);
      out.push({
        name: p.n, en: p.en, mag: magOf(p.n, r, d, phase), dist: d,
        alt: av.alt, az: av.az, dir: dirName(av.az), up: av.alt > 3, elong: elong
      });
    });
    out.sort((a, b) => (a.mag == null ? 99 : a.mag) - (b.mag == null ? 99 : b.mag));
    return out;
  }

  /** X 射线耀斑等级的配色与说法。A/B 是背景级，C 小耀斑，M 中等，X 最强 ——
   *  每一级之间差 10 倍（M1 = 10×C1，X1 = 10×M1）。 */
  function flareScale(txt) {
    const c = String(txt || '').charAt(0).toUpperCase();
    if (c === 'X') return { level: '大耀斑', note: '几天后可能有一场极光', color: '#c0392b' };
    if (c === 'M') return { level: '中等耀斑', note: '可能引发地磁扰动', color: '#e74c3c' };
    if (c === 'C') return { level: '小耀斑', note: '常见，通常无影响', color: '#e67e22' };
    if (c === 'B') return { level: '背景偏亮', note: '安静', color: '#f0c419' };
    return { level: '平静背景', note: '没有活动', color: '#3498db' };
  }

  /** 太阳风 Bz 的人话。Bz 是**朝南还是朝北**决定能量灌不灌得进来：
   *  朝南（负值）＝行星际磁场和地球磁场反接，太阳风能量直接灌进磁层 → 利于极光；
   *  朝北（正值）就算速度再快，也大多被磁层挡回去 —— 所以只看 Kp 看不出"接下来会不会爆"。 */
  function bzMood(bz) {
    if (bz == null || !isFinite(bz)) return { text: '--', good: false, color: '#7f8c9a' };
    if (bz <= -10) return { text: '强烈朝南，很有利于极光', good: true, color: '#2ecc71' };
    if (bz <= -5) return { text: '朝南，有利于极光', good: true, color: '#7ed957' };
    if (bz < 0) return { text: '略朝南', good: true, color: '#f0c419' };
    if (bz < 5) return { text: '接近零，作用不大', good: false, color: '#7f8c9a' };
    return { text: '朝北，把能量挡了回去', good: false, color: '#e67e22' };
  }

  /** 月亮此刻的位置与视大小（方位角 + 距离 + 视直径）。
   *  距离与视直径是"超级月亮"那一类说法的根据：近地点 356500 km、远地点 406700 km，
   *  视直径 0.49°～0.56°，差 14% —— 肉眼其实看不出来，但拍照党关心。 */
  function moonPos(ms, lat, lon) {
    const m = moonRaDec(ms);
    const p = azOf(m.ra, m.dec, ms, lat, lon);
    const d = moonDistance(ms);
    return {
      alt: p.alt, az: p.az, dir: dirName(p.az),
      dist: d, size: moonSizeDeg(ms),
      big: d < 365000, small: d > 404000
    };
  }

  /* ═══════════════ 光污染（站点常量，不进时间序列）═══════════════
   *  数据来源：**David Lorenz 的 Light Pollution Atlas 2025**（2025 版，由 VIIRS 年度
   *  夜间灯光经大气传输模型推算的天顶人工亮度）。离线烘成 `web/data/lp.json`，
   *  运行时只查表、**零网络请求**；每城取的是 **5×5 像素（≈4.6 km）窗口的中位档**
   *  （图集是 1/120° 的量化分档栅格，单像素会跳变 —— 实测相邻 12 km 的两点能差 3 档）。
   *
   *  ⚠ **这不是 Bortle 等级。** 作者 David Lorenz 明确要求过：
   *    "I ask that you do not conflate the Bortle Scale with my maps."
   *    他的图是**天顶人工亮度的模拟值**；Bortle 是肉眼主观评级、看的是整片天。
   *    所以这个模块里**不许出现"波特尔"三个字**，只能说"光污染等级 / 天顶亮度"。
   *
   *  数值口径（来自 https://djlorenz.github.io/astronomy/lp/colors.html）：
   *    Zone 号每 +1 = 人工光污染 ×3，a/b 子档各 ×1.73；LPI = 人工亮度/自然亮度，
   *    LPI=1 正好是 3b/4a 的分界，城市常 >30；自然天光基准 **22.0 mag/arcsec²**。
   */
  const LP_ORDER = ['0', '1a', '1b', '2a', '2b', '3a', '3b', '4a', '4b',
    '5a', '5b', '6a', '6b', '7a', '7b'];

  /** 档位 → 人话。
   *  `cap` 是**这个站点理论上限**：光污染是站点属性，天空再晴也冲不破它。
   *  用天顶亮度线性映射到 0～100（17.5 等 = 谷底、22.0 等 = 满分），
   *  下限压到 8 分而不是 0 —— "灯下也能看见月亮和木星"是事实，给 0 反而是错的。 */
  function lpInfo(v) {
    if (!v || !v.z) return null;
    const magLo = v.magLo == null ? 22 : v.magLo;
    const magHi = v.magHi == null ? magLo : v.magHi;
    const cap = Math.round(Math.max(8, Math.min(100, (magLo - 17.5) / 4.5 * 100)));
    const lpi = v.lpiLo == null ? 0 : v.lpiLo;
    const lpiTxt = v.lpiHi == null ? ('>' + v.lpiLo) : (lpi < 1 ? v.lpiLo + '～' + v.lpiHi : Math.round((v.lpiLo + v.lpiHi) / 2) + '');
    const desc =
      magLo >= 21.5 ? '银河结构清晰，极限星等 6.5 上下' :
        magLo >= 20.9 ? '银河清楚可见，深空目标好找' :
          magLo >= 20.4 ? '银河看得出轮廓，但已发灰' :
            magLo >= 19.9 ? '银河只剩淡淡一条，散星还清楚' :
              magLo >= 19.4 ? '银河基本看不见，亮星仍醒目' :
                magLo >= 18.9 ? '只有十几颗亮星，天空底色发橙' :
                  '只剩月亮和几颗最亮的星，天空泛白';
    const color =
      magLo >= 21.4 ? '#2e9be6' : magLo >= 20.4 ? '#2ecc71' :
        magLo >= 19.4 ? '#f0c419' : magLo >= 18.4 ? '#e67e22' : '#e74c3c';
    return {
      z: v.z, cap: cap, color: color, magLo: magLo, magHi: magHi, lpiTxt: lpiTxt,
      label: v.z + ' 级',
      /** 「3a · 天顶 21.7 等/平方角秒 · 人工光约 0.4 倍自然光」 */
      brief: v.z + ' 级 · 天顶 ' + magLo.toFixed(2) + ' 等/平方角秒' +
        (lpi >= 1 ? ' · 人工光约为自然光的 ' + lpiTxt + ' 倍' : ' · 人工光还少于自然光'),
      desc: desc
    };
  }

  /** 把站点光污染并进观星评分：**封顶**，不参与逐小时加减。
   *  理由：云、湿度、月光每小时在变，光污染不会 —— 混进同一套线性扣分里，
   *  会出现"重污染城市今晚云少所以 62 分"这种自欺欺人的结论。 */
  function capByLP(sc, info) {
    if (!sc || !info) return sc;
    if (sc.score > info.cap) {
      sc.score = info.cap;
      sc.capped = Math.min(sc.capped == null ? 100 : sc.capped, info.cap);
      sc.why = (sc.why || []).concat(['本站光污染 ' + info.z + ' 级，夜空上限就到这里']);
      sc.label = sc.score >= 80 ? '极佳' : sc.score >= 60 ? '不错' : sc.score >= 40 ? '一般' : sc.score >= 20 ? '较差' : '不宜';
      sc.color = sc.score >= 80 ? '#2ecc71' : sc.score >= 60 ? '#7ed957' : sc.score >= 40 ? '#f0c419' : sc.score >= 20 ? '#e67e22' : '#e74c3c';
    }
    return sc;
  }

  /* ═══════════════ 朝霞 / 晚霞 / 火烧云（本地启发式）═══════════════
   *  ⚠ **没有免费开放的霞预报接口**，这是本站自拟的启发式评分，**不是权威预报**。
   *  界面上必须如实这么写。物理依据（都是常识层面的）：
   *    · 霞靠**中高云接光**：太少没画布（天空只会由蓝转灰），太多则整片挡掉；
   *    · **低云挡地平线** —— 太阳得能照到云底，低云一厚就完；
   *    · **气溶胶（AOD）**：适量（0.1~0.4）让红色更浓，过多（>0.7）把天糊成一片灰黄；
   *    · **能见度**：霾同样会把颜色洗掉。
   *  输入全部来自已经取到的数据（分层云量/能见度来自主站 hourly，AOD 来自
   *  `API.OpenMeteo.astroAir`），所以**不新增任何网络请求**。 */
  function twilightGlow(o) {
    o = o || {};
    const why = [];
    const tot = o.cloud == null ? null : o.cloud;
    const L = o.cloudLow == null ? (tot == null ? null : tot) : o.cloudLow;
    const M = o.cloudMid == null ? (tot == null ? null : tot) : o.cloudMid;
    const H = o.cloudHigh == null ? (tot == null ? null : tot) : o.cloudHigh;
    if (L == null && M == null && H == null) {
      return { score: null, label: '数据不足', color: '#7f8c9a', why: ['这一时段没有逐小时云量'], fire: false };
    }
    const low = L == null ? 30 : L, mid = M == null ? 30 : M, high = H == null ? 30 : H;
    const canvas = Math.max(mid, high);

    let s = 100;
    // ① 画布：中高云
    if (canvas < 10) { s -= 55; why.push('中高云太少（' + Math.round(canvas) + '%），没有能接光的云'); }
    else if (canvas < 25) { s -= 22; why.push('中高云偏少（' + Math.round(canvas) + '%），颜色会淡'); }
    else if (canvas <= 70) { why.push('中高云 ' + Math.round(canvas) + '%，正好当画布'); }
    else if (canvas <= 90) { s -= 30; why.push('中高云 ' + Math.round(canvas) + '%，铺得太满'); }
    else { s -= 50; why.push('中高云 ' + Math.round(canvas) + '%，整片糊住'); }

    // ② 地平线：低云
    if (low >= 70) { s -= 45; why.push('低云 ' + Math.round(low) + '%，把地平线挡死了'); }
    else if (low >= 40) { s -= 18; why.push('低云 ' + Math.round(low) + '%，地平线附近会被挡'); }
    else if (low <= 15) why.push('低云少，地平线通透');

    // ③ 气溶胶
    if (o.aod != null) {
      if (o.aod > 0.7) { s -= 22; why.push('气溶胶太重（AOD ' + o.aod.toFixed(2) + '），天会发浑'); }
      else if (o.aod > 0.4) { s -= 8; why.push('气溶胶偏多（AOD ' + o.aod.toFixed(2) + '）'); }
      else if (o.aod >= 0.08) why.push('气溶胶适中（AOD ' + o.aod.toFixed(2) + '），利于出红');
      else { s -= 6; why.push('空气太干净（AOD ' + o.aod.toFixed(2) + '），缺散射粒子'); }
    }
    // ④ 能见度
    if (o.vis != null && o.vis < 10000) {
      const vt = Math.min(20, (10000 - o.vis) / 10000 * 30);
      s -= vt;
      why.push('能见度只有 ' + (o.vis / 1000).toFixed(1) + ' km，霾会把颜色洗掉');
    }
    s = Math.max(0, Math.min(100, Math.round(s)));
    return {
      score: s, why: why,
      // 「火烧云」单列一档：要中高云够、低云薄、还得有点气溶胶，三者同时满足才算
      fire: s >= 62 && canvas >= 25 && low < 45,
      label: s >= 75 ? '很可能烧起来' : s >= 55 ? '有机会' : s >= 35 ? '一般' : s >= 15 ? '希望不大' : '基本没戏',
      color: s >= 75 ? '#e74c3c' : s >= 55 ? '#e67e22' : s >= 35 ? '#f0c419' : s >= 15 ? '#7f8c9a' : '#4a5560'
    };
  }

  /* ═══════════════ 天体的可见时段（纯本地）═══════════════
   *  使用者要的是"文字列表、不要甘特图"。做法：对高度角扫描一遍，
   *  找出 `alt ≥ minAlt` 的连续区间。`minAlt` 默认 10°——
   *  低于 10° 时大气消光已经吃掉一两个星等，而且多半被楼和树挡着，
   *  把它算进"可见"是自欺欺人。 */
  function altWindows(altFn, t0, t1, minAlt, stepMin) {
    const step = (stepMin || 6) * 60000;
    const lim = (minAlt == null ? 10 : minAlt);
    const out = [];
    let cur = null;
    for (let t = t0; t <= t1; t += step) {
      const a = altFn(t);
      if (a >= lim) {
        if (!cur) cur = { from: t, to: t, maxAlt: a, maxAt: t };
        else {
          cur.to = t;
          if (a > cur.maxAlt) { cur.maxAlt = a; cur.maxAt = t; }
        }
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** 一整夜里各天体的可见时段。`bodies` 形如 [{name, emoji, alt(ms)}]。
   *  返回 [{name, emoji, windows:[{from,to,maxAlt,maxAt,dur}], best}]，按"最长的窗口"降序。 */
  function skyWindows(bodies, t0, t1, minAlt, stepMin) {
    return (bodies || []).map(b => {
      const ws = altWindows(b.alt, t0, t1, minAlt, stepMin).map(w =>
        ({ from: w.from, to: w.to, maxAlt: w.maxAlt, maxAt: w.maxAt, dur: w.to - w.from }));
      const best = ws.slice().sort((p, q) => q.maxAlt - p.maxAlt)[0] || null;
      return { name: b.name, emoji: b.emoji, windows: ws, best: best, total: ws.reduce((a, w) => a + w.dur, 0) };
    }).sort((a, b) => (b.best ? b.best.maxAlt : -1) - (a.best ? a.best.maxAlt : -1));
  }

  global.ASTRO = {
    // 基础几何
    sunAlt: sunAlt, moonAlt: moonAlt, sunRaDec: sunRaDec, moonRaDec: moonRaDec,
    sunDist: sunDist,
    azOf: azOf, dirName: dirName,
    // 月相与月亮
    moonPhase: moonPhase, moonPhaseTxt: moonPhaseTxt,
    moonDistance: moonDistance, moonSizeDeg: moonSizeDeg, moonPos: moonPos,
    // 事件
    sunEvents: sunEvents, moonEvents: moonEvents, nextNight: nextNight,
    // 评分与判据
    starScore: starScore, kpScale: kpScale, auroraNeedKp: auroraNeedKp,
    flareScale: flareScale, bzMood: bzMood,
    // 光污染（站点常量，查 web/data/lp.json 的烘焙表）
    lpInfo: lpInfo, capByLP: capByLP, LP_ORDER: LP_ORDER,
    // 朝霞 / 晚霞 / 火烧云（本站启发式，非权威预报）
    twilightGlow: twilightGlow,
    // 天体可见时段（纯本地扫描高度角）
    altWindows: altWindows, skyWindows: skyWindows,
    // 此刻的天空（全部本地算，不联网）
    stars: STARS, brightStars: brightStars, planets: planets,
    // 流星雨
    showers: SHOWERS, nextShowers: nextShowers,
    // 常量给外面用（比如"今晚"取 18:00 起算）
    SYNODIC: SYN
  };
})(window);
