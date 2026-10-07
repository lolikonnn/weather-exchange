/* astro.js — 天文计算（纯函数：不取数、不碰 DOM、不发网络请求）
 *
 * 为什么要自己算：Open-Meteo 只给日出日落；月出月落、月相、黄金/蓝调时刻、
 * 天文暮光这些**没有任何免 key 又带 CORS 的接口**（USNO 的 api 域名都解析不出来，
 * timeanddate 一类没有公开接口）。好在这几样都是可以本地推的经典算法。
 *
 * 算法取 Meeus《Astronomical Algorithms》的低精度简化式：
 *   太阳：平黄经 + 中心差，赤纬精度 ~0.01° → 日出日落 ±1 分钟（够对表）；
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

  /* ── 月亮（Meeus 第 47 章的简化式，精度约 0.3°） ── */
  function moonRaDec(ms) {
    const T = (jdOf(ms) - 2451545.0) / 36525;
    const Lp = norm360(218.316 + 481267.881 * T);             // 平黄经
    const M = norm360(134.963 + 477198.867 * T);              // 平近点角
    const F = norm360(93.272 + 483202.017 * T);               // 升交点角距
    const D = norm360(297.850 + 445267.112 * T);              // 日月平距角
    const Ms = norm360(357.528 + 35999.050 * T);              // 太阳平近点角
    const lam = Lp
      + 6.289 * sind(M) - 1.274 * sind(2 * D - M) + 0.658 * sind(2 * D)
      + 0.214 * sind(2 * M) - 0.186 * sind(Ms) - 0.114 * sind(2 * F);
    const bet = 5.128 * sind(F) + 0.281 * sind(M + F)
      - 0.278 * sind(F - M) - 0.173 * sind(F - 2 * D);
    const eps = 23.439 - 0.0000004 * (jdOf(ms) - 2451545.0);
    return {
      ra: norm360(Math.atan2(sind(lam) * cosd(eps) - Math.tan(bet * D2R) * sind(eps), cosd(lam)) * R2D),
      dec: Math.asin(sind(bet) * cosd(eps) + cosd(bet) * sind(eps) * sind(lam)) * R2D
    };
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
   * 只吃"手上已有的逐小时字段"，不额外请求任何接口：
   *   云量 55 分（唯一的大头，云是观星的头号敌人）
   *   降水 20 分（有雨雪直接扣满）
   *   湿度 10 分（>90% 会起雾结露，镜面废掉）
   *   风   10 分（>8 m/s 抖得没法看，视宁度也差）
   *   月光  5 分（满月能把背景亮度抬高 2~3 等，深空目标全糊） */
  function starScore(o) {
    o = o || {};
    const cloud = o.cloud == null ? 50 : o.cloud;
    const precip = o.precip == null ? 0 : o.precip;
    const hum = o.humidity == null ? 60 : o.humidity;
    const wind = o.wind == null ? 2 : o.wind;
    const why = [];

    let s = 100 - cloud * 0.55;
    if (cloud <= 20) why.push('云量 ' + Math.round(cloud) + '%，通透');
    else if (cloud >= 70) why.push('云量 ' + Math.round(cloud) + '%，基本没戏');

    if (precip > 0) { s -= 20; why.push('有降水 ' + precip.toFixed(1) + ' mm'); }
    if (hum > 90) { s -= 10; why.push('湿度 ' + Math.round(hum) + '%，易起雾结露'); }
    else if (hum > 80) s -= 5;
    if (wind > 8) { s -= 10; why.push('风 ' + wind.toFixed(1) + ' m/s，视宁度差'); }
    else if (wind > 5) s -= 5;
    if (o.moonUp) {
      s -= (o.moonIllum || 0) * 5;
      if ((o.moonIllum || 0) > 0.6) why.push('月光亮（' + Math.round(o.moonIllum * 100) + '%）');
    }

    s = Math.max(0, Math.min(100, Math.round(s)));
    return {
      score: s, why: why,
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

  global.ASTRO = {
    // 基础几何
    sunAlt: sunAlt, moonAlt: moonAlt, sunRaDec: sunRaDec, moonRaDec: moonRaDec,
    // 月相
    moonPhase: moonPhase, moonPhaseTxt: moonPhaseTxt,
    // 事件
    sunEvents: sunEvents, moonEvents: moonEvents, nextNight: nextNight,
    // 评分与判据
    starScore: starScore, kpScale: kpScale, auroraNeedKp: auroraNeedKp,
    // 流星雨
    showers: SHOWERS, nextShowers: nextShowers,
    // 常量给外面用（比如"今晚"取 18:00 起算）
    SYNODIC: SYN
  };
})(window);
