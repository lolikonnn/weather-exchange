/* ══════════════════ 🌊 潮汐（天文抽屉第 7 页的数据层）══════════════════
   真值来源：调和常数来自 Neaps tide-database 里的 **TICON-4**（GESLA-4 / UHSLC
   实测水位的调和分析）与 NOAA CO-OPS，许可 CC BY 4.0（逐站 license 见站表）。
   离线烘成 `web/data/tide.json`（29 KB：16 个站 + 44 座沿海城的索引）。
   分潮求和交给 `web/vendor/neaps-tide.js`（@neaps/tide-predictor，MIT），
   所以**打开这一页不联网**、点开就是瞬时的。

   为什么是"烘表 + 本地算"，而不是去找个潮汐 API：
     · 免费的潮汐接口要么要 key（彩云），要么只覆盖香港（天文台 HHOT）；
     · 调和常数是**常数** —— 拿到之后任意日期都能自己算，零请求、零额度、
       不受对方限流和下线影响；
     · 精度我们对着**香港天文台官方逐小时预报**逐点验过（`tmp/tide_hko.js`）：
       去掉两站基准面的常数差之后，平均绝对差 **0.036 m**、p90 0.069 m、最大 0.158 m。

   ⚠ 三条必须写在界面上（不能只写在这里）：
     ① 这是**天文潮**：调和常数只描述天体引潮力，**不含风暴增水、气压效应、
        河口径流**。台风天实际水位可能比它高一两米 —— 所以页脚要写"仅供参考"。
     ② 站是**借**的：我们只有 16 个站，离本城几十公里的站，潮时可能差十几分钟到
        一小时，所以每条都要写明"参考站 + 距离"。
     ③ CC BY 4.0 要**署名**。

   ⚠ 基准面坑：站表里有 7 个站 `chart_datum` 写的是 `LAT`，但 `datums` 里**没有**
     LAT 这个值（TICON-4 部分站不给）。照默认走的话，不同站会落在不同基准面上
     （有的相对 LAT、有的相对调和常数的原始基准），数字没法比。
     所以这里**一律显式传 `datum:'MSL'`**（16 个站都有 MSL），界面写
     「水位（相对平均海平面）」；反正用户真正要的是**高低潮时刻**。 */
(function (global) {
  'use strict';

  var DB_URL = 'data/tide.json';
  var TTL = 86400000;          // 烘死的静态表，一天缓存
  var MAX_KM = 150;            // 借站上限：超过它就不借了，如实说"附近没有潮汐站"
  var DATUM = 'MSL';
  var S = { p: null, db: null };

  /** 懒加载站表。跟 api.js 的 `LP.load()` 一个路子：只加载一次、失败可重试。 */
  function load() {
    if (S.p) return S.p;
    if (!global.API || !global.API.getJSON) return Promise.resolve(null);
    S.p = global.API.getJSON(DB_URL, { ttl: TTL, key: 'tide' })
      .then(function (d) { S.db = d || null; return S.db; })
      .catch(function () { S.p = null; return null; });
    return S.p;
  }

  /* 大圆距离（km）。跟 api.js 里那份同一个公式，不引依赖。 */
  function km(a1, o1, a2, o2) {
    var R = 6371, p1 = a1 * Math.PI / 180, p2 = a2 * Math.PI / 180;
    var dp = p2 - p1, dl = (o2 - o1) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function mk(db, i, dist, how) {
    var s = db.stations[i];
    if (!s) return null;
    return { i: i, st: s, km: dist, how: how, name: s.name, zh: s.name };
  }

  /** 按坐标找最近的站（`maxKm` 之外返回 null）。 */
  function atSync(db, lat, lon, maxKm) {
    if (!db || lat == null || lon == null) return null;
    var lim = maxKm == null ? MAX_KM : maxKm, best = null;
    for (var i = 0; i < db.stations.length; i++) {
      var s = db.stations[i];
      var d = km(lat, lon, s.lat, s.lon);
      if (!best || d < best.km) best = { i: i, km: d };
    }
    if (!best || best.km > lim) return null;
    return mk(db, best.i, Math.round(best.km * 10) / 10, 'geo');
  }

  /** 某个城市（或「当前所在地」）该用哪个站。
   *  ① 先查烘好的市级索引（那是按 150 km 挑过的）；
   *  ② 表里没有（内陆城、或者 `__loc__`）→ 退回按坐标查，半径收紧到 60 km。 */
  function of(cityId, lat, lon) {
    return load().then(function (db) {
      if (!db) return null;
      var e = db.city && db.city[String(cityId)];
      if (e) return mk(db, e[0], e[1], 'city');
      return atSync(db, lat, lon, 60);
    });
  }

  function at(lat, lon, maxKm) {
    return load().then(function (db) { return atSync(db, lat, lon, maxKm); });
  }

  /** 站表记录 → 预报器要的站对象。**这是唯一一处做字段映射的地方**，
   *  字段名写错就会在 tmp/tide_test.js 里露馅（那份测试用的是同一段映射）。 */
  function toStation(rec) {
    var db = S.db, s = rec.st;
    return {
      id: s.id, name: s.name, continent: s.continent, country: s.country, region: s.region,
      timezone: s.tz, disclaimers: '',
      latitude: s.lat, longitude: s.lon,
      source: { name: s.src, id: s.id, url: s.srcUrl },
      datums: s.datums, chart_datum: s.cd, type: s.type,
      harmonic_constituents: s.c.map(function (x) {
        return { name: db.names[x[0]], amplitude: x[1], phase: x[2] };
      })
    };
  }

  function predictor(rec) {
    if (!global.TIDE || !global.TIDE.useStation) return null;
    try { return global.TIDE.useStation(toStation(rec), rec.km || 0); }
    catch (e) { return null; }
  }

  /** 未来一段时间的**曲线**（默认每 10 分钟一个点，跟预报器一致）。 */
  function curve(rec, t0, t1) {
    var p = predictor(rec);
    if (!p) return null;
    try {
      var r = p.getTimelinePrediction({ start: new Date(t0), end: new Date(t1), datum: DATUM });
      return (r && r.timeline) || null;
    } catch (e) { return null; }
  }

  /** 高低潮。预报器给的是 **平潮时刻**（涨落速率为 0 的那一点），
   *  所以界面上的措辞用「高平潮 / 低平潮」，不写"最高潮"。 */
  function extremes(rec, t0, t1) {
    var p = predictor(rec);
    if (!p) return null;
    try {
      var r = p.getExtremesPrediction({ start: new Date(t0), end: new Date(t1), datum: DATUM });
      return (r && r.extremes) || null;
    } catch (e) { return null; }
  }

  /** 一点的水位（给"此刻"那个大字用）。 */
  function levelAt(rec, t) {
    var p = predictor(rec);
    if (!p) return null;
    try {
      var r = p.getWaterLevelAtTime({ time: new Date(t), datum: DATUM });
      return r ? r.level : null;
    } catch (e) { return null; }
  }

  /** 大潮 / 小潮：朔望（新月、满月）时日月引潮力叠加 → 大潮；两弦 → 小潮。
   *  用月亮龄算，不查表：|cos(π·age/14.765)| 在 age=0（朔）与 14.77（望）得 1，
   *  在 7.38 / 22.1（两弦）得 0。阈值取 0.8 / 0.35 是"离朔望三天内算大潮"那个
   *  常识口径（半个朔望月是 14.77 天）。 */
  function phase(ms) {
    var A = global.ASTRO;
    if (!A || !A.moonPhase) return null;
    var mp = A.moonPhase(ms);
    var age = mp.age == null ? null : mp.age;
    if (age == null) return null;
    var k = Math.abs(Math.cos(Math.PI * age / 14.765));
    return {
      age: age, k: k, mp: mp,
      kind: k >= 0.8 ? 'spring' : (k <= 0.35 ? 'neap' : 'mid'),
      label: k >= 0.8 ? '大潮' : (k <= 0.35 ? '小潮' : '中潮'),
      why: k >= 0.8
        ? (age < 7.4 ? '离新月 ' + age.toFixed(1) + ' 天：日月在一条线上，引潮力叠加'
          : '离满月 ' + Math.abs(age - 14.77).toFixed(1) + ' 天：日月对拉，引潮力叠加')
        : (k <= 0.35 ? '上下弦：日月成直角，引潮力互相抵消' : '介于朔望与两弦之间')
    };
  }

  /** 站点元信息（页脚署名用）。 */
  function meta() {
    if (!S.db) return null;
    return { src: S.db.src, db: S.db.db, lic: S.db.lic, bbox: S.db.bbox, maxKm: S.db.maxCityKm, n: S.db.stations.length };
  }

  /** 分潮振幅（按名字取，单位米）。站表里没有这个分潮就返回 0。 */
  function ampOf(rec, name) {
    var db = S.db;
    if (!db) return 0;
    var want = -1;
    for (var i = 0; i < db.names.length; i++) if (db.names[i] === name) { want = i; break; }
    if (want < 0) return 0;
    for (var j = 0; j < rec.st.c.length; j++) if (rec.st.c[j][0] === want) return rec.st.c[j][1];
    return 0;
  }

  /** 潮汐类型：用**调和常数**算形状因子 F = (K1 + O1) / (M2 + S2)（海洋学通用口径）。
   *  F < 0.25 半日潮（一天两次高潮、两次低潮，且两次差不多高）
   *  0.25 ~ 1.5 混合潮，以半日为主（两次高潮不等高，中国沿海多属这一类）
   *  1.5 ~ 3.0 混合潮，以全日为主       F > 3 全日潮（一天只一次高潮）
   *  这是**从本站自己的常数算出来的**，不是查表抄的 —— 所以每站都可能不一样。 */
  function formFactor(rec) {
    const m2 = ampOf(rec, 'M2'), s2 = ampOf(rec, 'S2');
    const k1 = ampOf(rec, 'K1'), o1 = ampOf(rec, 'O1');
    const den = m2 + s2;
    if (!(den > 0)) return null;
    const F = (k1 + o1) / den;
    const kind = F < 0.25 ? '半日潮' : F < 1.5 ? '混合潮（半日为主）'
      : F < 3.0 ? '混合潮（全日为主）' : '全日潮';
    const note = F < 0.25 ? '一天两次高潮、两次低潮，两次高度差不多'
      : F < 1.5 ? '一天两次高潮，但两次不一样高，我国的黄海、东海、南海大多如此'
        : F < 3.0 ? '两次高潮里有一次明显更高，另一次几乎看不出来' : '一天只有一次明显的高潮';
    return { F: F, kind: kind, note: note, parts: { M2: m2, S2: s2, K1: k1, O1: o1 } };
  }

  /** 月亮过中天（上中天＝月亮在子午线上最高时）。用 `moonAlt` 的**极大值**扫出来 ——
   *  比"方位角过 180°"稳：月亮赤纬会超过纬度，那方位角就跑到正北去了。
   *  高潮通常出现在月中天前后（差多少是各港口的"潮汐间隙"），所以这个时刻有实用价值。 */
  function transits(lat, lon, t0) {
    var A = global.ASTRO;
    if (!A || !A.moonAlt) return null;
    var out = [];
    var step = 4 * 60000, span = 36 * 3600000;
    var prev2 = null, prev1 = null;
    for (var t = t0 - 12 * 3600000; t <= t0 + span; t += step) {
      var a = A.moonAlt(t, lat, lon);
      if (prev2 != null && prev1 != null) {
        if (prev1 > prev2 && prev1 >= a) out.push({ t: t - step, alt: prev1, up: true });
        else if (prev1 < prev2 && prev1 <= a) out.push({ t: t - step, alt: prev1, up: false });
      }
      prev2 = prev1; prev1 = a;
    }
    return out;
  }

  global.TIDEDATA = {
    load: load, of: of, at: at, curve: curve, extremes: extremes,
    levelAt: levelAt, phase: phase, meta: meta, km: km,
    ampOf: ampOf, formFactor: formFactor, transits: transits,
    DATUM: DATUM, MAX_KM: MAX_KM
  };
})(window);
