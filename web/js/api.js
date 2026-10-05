/* ═══════════════════════════════════════════════════════════════
   api.js — 数据层
   ┌ 中国气象局 / 中国天气网官方接口  weather.cma.cn   （CORS 开放，直连）
   ├ 中国天气网   d1.weather.com.cn  （需 Referer，仅 EXE/APK 本地代理或 Actions 预抓）
   └ Open-Meteo  历史逐小时 + 16 日预报（K 线引擎）
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';
  const { storeGet, storeSet, fmtDate, pad2, parseISO } = U;

  const TZ = 'Asia/Shanghai';
  const CMA = 'https://weather.cma.cn';
  const OM_F = 'https://api.open-meteo.com/v1/forecast';
  const OM_A = 'https://archive-api.open-meteo.com/v1/archive';

  /* 本地代理探测：EXE / APK 外壳会注入 window.__TJS_LOCAL__。
     探针页等未注入时按 hostname 自行判定，避免本地调试误走直连。 */
  const LOCAL = (typeof global.__TJS_LOCAL__ !== 'undefined')
    ? !!global.__TJS_LOCAL__
    : (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) || location.protocol === 'file:');

  /* ───────── 缓存 ───────── */
  const mem = {};
  function cacheGet(key, ttl) {
    const e = mem[key];
    if (e && Date.now() - e.t < ttl) return e.v;
    return null;
  }
  function cacheSet(key, v) { mem[key] = { t: Date.now(), v }; }

  async function getJSON(url, opt) {
    opt = opt || {};
    const ttl = opt.ttl == null ? 600000 : opt.ttl;
    const key = opt.key || url;
    const hit = cacheGet(key, ttl);
    if (hit !== null) return hit;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 20000);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: opt.headers, mode: opt.mode || 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      let data;
      try { data = JSON.parse(txt); }
      catch (e) { data = JSON.parse(txt.replace(/^[^(]*\(|\)[;\s]*$/g, '')); }  // JSONP 兜底
      cacheSet(key, data);
      return data;
    } finally { clearTimeout(timer); }
  }

  /* ───────── 日期工具 ───────── */
  function todayStr() { return fmtDate(new Date()); }
  function shiftDate(s, days) {
    const d = U.parseDate(s); d.setDate(d.getDate() + days); return fmtDate(d);
  }
  /** 宽松数值：'23' -> 23，'' / null / '—' -> null */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /* ═══════════════ 1. 城市数据集 ═══════════════ */
  const Cities = {
    all: [], hot: [], byId: {},
    async load() {
      if (this.all.length) return this;
      const d = await getJSON('data/cities.json?ts=' + Math.floor(Date.now() / 3600000), { ttl: 3600000 });
      this.all = (d.cities || []).map(c => {
        c.py = c.py || ''; c.search = (c.name + ' ' + (c.prov || '') + ' ' + c.py + ' ' + c.id).toLowerCase();
        return c;
      });
      this.byId = {};
      this.byName = {};
      this.all.forEach(c => {
        if (c.id) this.byId[c.id] = c;
        if (c.name) this.byName[c.name] = c;
      });
      // cities.json 的 hot 既可能是 101 代码也可能是城市名，两种都认
      this.hot = (d.hot || []).map(k => this.byId[k] || this.byName[k]).filter(Boolean);
      if (!this.hot.length) this.hot = this.all.slice(0, 20);
      this.updated = d.updated;
      return this;
    },
    get(id) { return this.byId[id]; },
    /** 模糊搜索：城市名 / 拼音 / 省份 / 9位代码 */
    search(q, limit) {
      q = String(q || '').trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const c of this.all) {
        let score = 0;
        if (c.id === q) score = 1000;
        else if (c.name === q) score = 900;
        else if (c.name.startsWith(q)) score = 700 - c.name.length;
        else if (c.name.indexOf(q) >= 0) score = 500 - c.name.length;
        else if (c.py && c.py.startsWith(q)) score = 460;
        else if (c.py && c.py.indexOf(q) >= 0) score = 380;
        else if (c.search.indexOf(q) >= 0) score = 260;
        if (score) { out.push({ c, score: score + Math.min(c.pop || 0, 5000) / 5000 }); }
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, limit || 40).map(o => o.c);
    }
  };

  /* ═══════════════ 2. 中国气象局官方接口（直连） ═══════════════ */
  /* 气象局接口三级取数：本地代理 → 直连 → Actions 预抓静态。
     三级都是必需的：Pages 上没有本地代理，EXE/APK 里反过来，
     而浏览器直连 weather.cma.cn 在部分网络/网关环境下会被 CORS 拦掉。 */
  async function cmaRaw(sub, id, ttlMs, key) {
    const ep = { now: '/api/now/', view: '/api/weather/view?stationid=', hourly: '/api/hourly/' }[sub] || '/api/now/';
    if (LOCAL) {
      try {
        // 必须用绝对路径：APK 里页面挂在 /web/index.html 下，写成相对路径
        // 会解析成 /web/api/cma/...，被 Java 拦截器当成静态资源而 404。
        return await getJSON('/api/cma/' + sub + '?st=' + encodeURIComponent(id) +
                             '&ttl=' + Math.max(10, Math.round(ttlMs / 1000)),
                             { ttl: ttlMs, key: 'cl:' + key });
      } catch (e) { /* 落到直连 */ }
    }
    try {
      return await getJSON(CMA + ep + id, { ttl: ttlMs, key: 'cd:' + key });
    } catch (e) { /* 落到静态预抓 */ }
    try {
      return await getJSON('data/official/cma/' + id + '.' + sub + '.json',
                           { ttl: 600000, key: 'cs:' + key });
    } catch (e) { /* 三级都不可用 */ }
    return null;
  }

  const Cma = {
    ok(city) { return !!(city && city.cma); },

    /** 实况。响应形如 {msg,code,data:{location:{...}, now:{...}, lastUpdate:"..."}} */
    async now(city, ttl) {
      if (!this.ok(city)) return null;
      try {
        const ms = ttl || 180000;
        const d = await cmaRaw('now', city.cma, ms, 'now:' + city.cma);
        const dd = d && d.data, n = dd && dd.now;
        if (!n) return null;
        return {
          src: 'cma',
          temp: n.temperature, feels: n.feelst,
          precip: n.precipitation, humidity: n.humidity, pressure: n.pressure,
          windDir: n.windDirection, windDeg: n.windDirectionDegree,
          windSpeed: n.windSpeed, windScale: n.windScale,
          alarm: dd.alarm || [], jieQi: dd.jieQi || '',
          time: dd.lastUpdate || ''
        };
      } catch (e) { return null; }
    },

    /** 7 日预报 + 逐 3 小时 + 气候均值 */
    async view(city) {
      if (!this.ok(city)) return null;
      try {
        const d = await cmaRaw('view', city.cma, 900000, 'view:' + city.cma);
        const dd = d && d.data;
        if (!dd) return null;
        return dd;
      } catch (e) { return null; }
    },

    /** 逐 3 小时（7 天） */
    async hourly(city) {
      if (!this.ok(city)) return null;
      try {
        const d = await cmaRaw('hourly', city.cma, 900000, 'hourly:' + city.cma);
        return (d && d.data) || null;
      } catch (e) { return null; }
    },

    /** 未来 5 日：供盘口与 15 日预报使用 */
    async forecast(city) {
      const dd = await this.view(city);
      if (!dd) return null;
      return {
        location: dd.location || null,
        now: dd.now || null,
        daily: (dd.daily || []).map(x => ({
          date: x.date,
          high: x.high, low: x.low,
          dayText: x.dayText, nightText: x.nightText,
          dayCode: x.dayCode, nightCode: x.nightCode,
          dayWind: (x.dayWindDirection || '') + (x.dayWindScale || ''),
          nightWind: (x.nightWindDirection || '') + (x.nightWindScale || '')
        }))
      };
    }
  };

  /* ═══════════════ 3. Open-Meteo 历史逐小时（K 线引擎） ═══════════════ */
  const OpenMeteo = {
    /** 历史逐小时；返回 {time:[], temp:[], precip:[]} */
    async archive(lat, lon, startDate, endDate) {
      const url = OM_A + '?latitude=' + lat + '&longitude=' + lon +
        '&start_date=' + startDate + '&end_date=' + endDate +
        '&hourly=temperature_2m,precipitation' +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON(url, { ttl: 1800000, key: 'a|' + lat + ',' + lon + '|' + startDate });
      return this._unpack(d, 'temperature_2m', 'precipitation');
    },

    /** 近期逐小时（含过去 92 天）+ 16 日预报 */
    async forecast(lat, lon, pastDays, fcstDays) {
      const url = OM_F + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m,precipitation,relative_humidity_2m,wind_speed_10m,weather_code' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,sunrise,sunset' +
        // Open-Meteo 的风速默认单位是 km/h，而中国气象局给的是 m/s。
        // 不显式指定的话，"平均风速"会显示成 17.6 m/s（其实是 17.6 km/h ≈ 4.9 m/s），
        // 和一墙之隔的实况风速 5.0 m/s 自相矛盾。
        '&wind_speed_unit=ms' +
        '&past_days=' + (pastDays == null ? 92 : pastDays) +
        '&forecast_days=' + (fcstDays == null ? 16 : fcstDays) +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON(url, { ttl: 900000, key: 'f|' + lat + ',' + lon + '|' + pastDays + '|' + fcstDays });
      const h = this._unpack(d, 'temperature_2m', 'precipitation');
      h.humidity = (d.hourly && d.hourly.relative_humidity_2m) || [];
      h.wind = (d.hourly && d.hourly.wind_speed_10m) || [];
      h.wcode = (d.hourly && d.hourly.weather_code) || [];
      h.daily = d.daily || null;
      h.utcOffset = d.utc_offset_seconds;
      return h;
    },

    _unpack(d, tk, pk) {
      const h = (d && d.hourly) || {};
      return { time: h.time || [], temp: h[tk] || [], precip: (h[pk] || []).map(v => v || 0) };
    },

    /** 仅取最近 24 小时温度，用于指数条 sparkline */
    async mini(lat, lon) {
      const url = OM_F + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m&past_days=1&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON(url, { ttl: 1800000, key: 'm|' + lat + ',' + lon });
      return ((d.hourly && d.hourly.temperature_2m) || []).slice(-26);
    },

    /** 轻量快照：昨收 / 今日开高低 / 当前 / 最近 24h 走势（行情列表与指数条用） */
    async brief(lat, lon, ttl) {
      const url = OM_F + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m,precipitation&daily=weather_code,precipitation_sum' +
        '&past_days=2&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON(url, { ttl: ttl || 600000, key: 'b|' + lat + ',' + lon });
      const h = (d && d.hourly) || {};
      const times = h.time || [], temps = h.temperature_2m || [], prec = h.precipitation || [];
      if (!times.length) return null;
      const today = times[times.length - 1].slice(0, 10);
      const days = new Map();
      for (let i = 0; i < times.length; i++) {
        if (temps[i] == null) continue;
        const day = times[i].slice(0, 10);
        let g = days.get(day);
        if (!g) { g = { d: day, o: null, h: -Infinity, l: Infinity, c: null, n: 0, pts: [] }; days.set(day, g); }
        if (g.o == null) g.o = temps[i];
        if (temps[i] > g.h) g.h = temps[i];
        if (temps[i] < g.l) g.l = temps[i];
        g.c = temps[i]; g.n++;
        g.pts.push(temps[i]);
      }
      const arr = Array.from(days.values()).sort((a, b) => a.d < b.d ? -1 : 1);
      const cur = arr[arr.length - 1] || null;
      const prev = arr.length > 1 ? arr[arr.length - 2] : null;
      const dly = (d && d.daily) || {};
      const di = (dly.time || []).indexOf(today);
      return {
        today, prevClose: prev ? prev.c : (cur ? cur.o : null),
        open: cur ? cur.o : null, high: cur ? cur.h : null, low: cur ? cur.l : null,
        now: cur ? cur.c : null,
        wcode: di >= 0 && dly.weather_code ? dly.weather_code[di] : null,
        precip: di >= 0 && dly.precipitation_sum ? dly.precipitation_sum[di] : null,
        spark: arr.map(g => g.c),
        sparkPts: arr.length ? arr[arr.length - 1].pts : [],
        days: arr
      };
    }
  };

  /* ═══════════════ 4. 中国天气网 d1 域（本地代理 / 预抓文件） ═══════════════ */
  const Cn = {
    /** 实况。LOCAL 走代理；否则读 Actions 预抓的静态文件。两种来源统一返回 dataSK 对象。 */
    async snapshot(code) {
      if (LOCAL) {
        try {
          const d = await getJSON('/api/cn/snapshot?code=' + code, { ttl: 180000 });
          if (d && d.ok && d.data) return d.data;
        } catch (e) { /* 落到静态 */ }
      }
      try {
        const d = await getJSON('data/official/snapshot.json?ts=' + Math.floor(Date.now() / 300000), { ttl: 300000 });
        return (d && d.cities && d.cities[code]) || null;
      } catch (e) { return null; }
    },

    /** 当日预报(含预警)。同上，统一返回 {weatherinfo, alarm}。 */
    async forecast(code) {
      if (LOCAL) {
        try {
          const d = await getJSON('/api/cn/forecast?code=' + code, { ttl: 900000 });
          if (d && d.ok && d.data) return d.data;
        } catch (e) { /* 落到静态 */ }
      }
      try {
        const d = await getJSON('data/official/fcst/' + code + '.json', { ttl: 1800000 });
        return (d && d.weatherinfo) ? d : null;
      } catch (e) { return null; }
    },

    /** 月度日历：历史同期均值 + 最近观测 + 15/40 日预报。统一返回 fc40 数组。 */
    async calendar(code, ym) {
      ym = ym || (todayStr().slice(0, 7).replace('-', ''));
      if (LOCAL) {
        try {
          const d = await getJSON('/api/cn/calendar?code=' + code + '&ym=' + ym, { ttl: 1800000 });
          if (d && d.ok && Array.isArray(d.data)) return d.data;
        } catch (e) { /* 落到静态 */ }
      }
      try {
        const d = await getJSON('data/official/cal/' + code + '_' + ym + '.json', { ttl: 1800000 });
        return Array.isArray(d) ? d : null;
      } catch (e) { return null; }
    },

    /**
     * 从日历里抽出的官方预报条：{d, max, min, cla, hgl, w1}
     * cla: d15=未来15天 / d40=40天趋势 / obs=最近观测 / history=历史同期均值
     */
    async officialDaily(code) {
      const ym = todayStr().slice(0, 7).replace('-', '');
      const nx = (function () { const t = new Date(todayStr() + 'T00:00:00'); t.setDate(1); t.setMonth(t.getMonth() + 1); return U.fmtDate(t).slice(0, 7).replace('-', ''); })();
      const [a, b] = await Promise.all([Cn.calendar(code, ym), Cn.calendar(code, nx)]);
      const out = [], seen = {};
      for (const arr of [a, b]) {
        for (const it of (arr || [])) {
          const d = String(it.date || '');
          if (!/^\d{8}$/.test(d) || seen[d]) continue;
          seen[d] = 1;
          out.push({
            d: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
            max: num(it.max), min: num(it.min),
            hmax: num(it.hmax), hmin: num(it.hmin),
            maxobs: num(it.maxobs), minobs: num(it.minobs),
            rain: num(it.rainobs), hgl: it.hgl || '', w1: it.w1 || '', cla: it.cla || ''
          });
        }
      }
      out.sort(function (p, q) { return p.d < q.d ? -1 : 1; });
      return out;
    },

    async health() {
      if (!LOCAL) return { local: false };
      try { return await getJSON('/api/health', { ttl: 60000 }); }
      catch (e) { return { local: false }; }
    }
  };

  /* ═══════════════ 5. K 线构建 ═══════════════ */
  /** 逐小时点 -> 日 K 线数组 [{d,o,h,l,c,v,n}] */
  function toDailyBars(times, temps, precs, extra) {
    const map = new Map();
    for (let i = 0; i < times.length; i++) {
      const t = temps[i];
      if (t == null) continue;
      const day = String(times[i]).slice(0, 10);
      const hh = Number(String(times[i]).slice(11, 13));
      let b = map.get(day);
      if (!b) {
        b = {
          d: day, o: t, h: t, l: t, c: t, v: 0, n: 0,
          hours: new Array(24).fill(null), _hs: 0, _ws: 0, _hn: 0, _wn: 0, wcode: null,
          rainHours: 0
        };
        map.set(day, b);
      }
      if (t > b.h) b.h = t;
      if (t < b.l) b.l = t;
      b.hours[hh] = t;
      b.v += (precs[i] || 0);
      if ((precs[i] || 0) >= 0.1) b.rainHours++;
      if (extra) {
        if (extra.humidity && extra.humidity[i] != null) { b._hs += extra.humidity[i]; b._hn++; }
        if (extra.wind && extra.wind[i] != null) { b._ws += extra.wind[i]; b._wn++; }
        if (extra.wcode && extra.wcode[i] != null && b.wcode == null) b.wcode = extra.wcode[i];
      }
      b.n++;
    }
    const out = [];
    for (const b of map.values()) {
      // 收盘价取当日最后一个有效观测
      for (let h = 23; h >= 0; h--) if (b.hours[h] != null) { b.c = b.hours[h]; break; }
      for (let h = 0; h < 24; h++) if (b.hours[h] != null) { b.o = b.hours[h]; break; }
      b.range = +(b.h - b.l).toFixed(1);
      b.humAvg = b._hn ? +(b._hs / b._hn).toFixed(0) : null;
      b.windAvg = b._wn ? +(b._ws / b._wn).toFixed(1) : null;
      delete b._hs; delete b._ws; delete b._hn; delete b._wn;
      out.push(b);
    }
    out.sort((a, b) => a.d < b.d ? -1 : 1);
    return out;
  }

  /** 逐小时数组 -> 分时点 [{t, p, v}] */
  /** 从 fromIdx 起按天截取逐时点。days 用于封顶（分时=1 天，五日分时=5 天），
      否则会把 Open-Meteo 未来 16 天的预报一股脑画进"分时图"。 */
  function toHourlyPoints(times, temps, precs, fromIdx, days) {
    const out = [];
    const start = fromIdx || 0;
    const startDay = String(times[start] || '').slice(0, 10);
    let maxDay = '';
    if (days && startDay) {
      const d = U.parseDate(startDay);
      d.setDate(d.getDate() + days - 1);
      maxDay = U.fmtDate(d);
    }
    for (let i = start; i < times.length; i++) {
      const day = String(times[i]).slice(0, 10);
      if (maxDay && day > maxDay) break;          // ISO 日期串可直接比大小
      if (temps[i] == null) continue;
      out.push({ t: times[i], p: temps[i], v: precs[i] || 0 });
    }
    return out;
  }

  /* ═══════════════ 6. 统一取数入口 ═══════════════ */
  const Store = {
    /** 一次性拉齐某城市的全部分析数据 */
    async loadCity(city, onStep) {
      const step = onStep || function () { };
      step('连接中国气象局…');
      const [now, fcst] = await Promise.all([Cma.now(city), Cma.forecast(city)]);

      step('拉取历史逐小时（Open-Meteo）…');
      let hist = { time: [], temp: [], precip: [] };
      if (city.lat != null && city.lon != null) {
        const end = shiftDate(todayStr(), -93);
        const start = shiftDate(todayStr(), -560);
        try { hist = await OpenMeteo.archive(city.lat, city.lon, start, end); } catch (e) { hist = { time: [], temp: [], precip: [] }; }
      }

      step('拉取近期与 16 日预报…');
      let recent = { time: [], temp: [], precip: [], humidity: [], wind: [], wcode: [] };
      if (city.lat != null && city.lon != null) {
        try { recent = await OpenMeteo.forecast(city.lat, city.lon, 92, 16); } catch (e) { }
      }

      const times = hist.time.concat(recent.time);
      const temps = hist.temp.concat(recent.temp);
      const precs = hist.precip.concat(recent.precip || []);
      // 湿度/风速/天气码只有近期 92 天，补齐到与 times 等长（前段补 null）
      const off = hist.time.length;
      const padTo = (arr) => {
        const a = new Array(times.length).fill(null);
        if (arr) for (let i = 0; i < arr.length && off + i < times.length; i++) a[off + i] = arr[i];
        return a;
      };
      const humids = padTo(recent.humidity), winds = padTo(recent.wind), wcodes = padTo(recent.wcode);
      const daily = toDailyBars(times, temps, precs, { humidity: humids, wind: winds, wcode: wcodes });

      // 用 Open-Meteo daily 补/覆盖更可靠的最高最低温
      const omDaily = {};
      if (recent.daily && recent.daily.time) {
        recent.daily.time.forEach((d, i) => {
          omDaily[d] = {
            high: recent.daily.temperature_2m_max[i],
            low: recent.daily.temperature_2m_min[i],
            precip: recent.daily.precipitation_sum[i],
            code: recent.daily.weather_code[i],
            sunrise: recent.daily.sunrise[i], sunset: recent.daily.sunset[i]
          };
        });
      }
      daily.forEach(b => { if (omDaily[b.d]) { b.omHigh = omDaily[b.d].high; b.omLow = omDaily[b.d].low; b.wcode = omDaily[b.d].code; } });

      const week = IND.aggregate(daily, 'week');
      const month = IND.aggregate(daily, 'month');

      // 今日在 daily 中的下标（Open-Meteo 含未来 16 天预报，必须按日期定位"当前K线"）
      const today = todayStr();
      let ti = daily.findIndex(b => b.d === today);
      if (ti < 0) { // 时区/边界情况：取最后一个不晚于今天的
        ti = -1;
        for (let i = 0; i < daily.length; i++) if (daily[i].d <= today) ti = i;
      }
      const lastDay = ti >= 0 ? daily[ti].d : today;
      const dayIdx = times.findIndex(t => String(t).slice(0, 10) === lastDay);
      const intraday = dayIdx >= 0 ? toHourlyPoints(times, temps, precs, dayIdx, 1) : [];

      // 五日分时：**昨天 → 未来第三天**（共 5 天）。
      // 原来取的是"今天往前数 5 天"，全是已经发生过的历史，而天气预报最该看的
      // 恰恰是还没发生的部分 —— 所以改成横跨昨天/今天/未来三天。
      const d5start = daily[Math.max(0, ti - 1)].d;
      const d5idx = times.findIndex(t => String(t).slice(0, 10) === d5start);
      const five = d5idx >= 0 ? toHourlyPoints(times, temps, precs, d5idx, 5) : [];

      const official = await Cn.snapshot(city.id);
      // 中国天气网 d1 域：当日预报/预警 + 官方月度日历（历史同期均值 / 最近观测 / 15·40 日预报）
      let cnFcst = null, calDaily = [];
      if (city.id) {
        try {
          const r = await Promise.all([Cn.forecast(city.id), Cn.officialDaily(city.id)]);
          cnFcst = r[0]; calDaily = r[1] || [];
        } catch (e) { /* 官方源不可用不阻塞主流程 */ }
      }

      const out = {
        city, now, fcst, official, cnFcst, calDaily,
        hourly: { time: times, temp: temps, precip: precs, humidity: humids, wind: winds, wcode: wcodes },
        daily, week, month, intraday, five,
        omDaily, lastDay, todayIndex: ti, today,
        base: ti > 0 ? daily[ti - 1].c : (ti === 0 ? daily[0].o : null)
      };
      out.indicators = IND.computeAll(daily);
      out.stamp = new Date();
      return out;
    },

    /** 轻量行情：只取实况（用于列表轮询） */
    async quote(city) {
      const n = await Cma.now(city);
      if (n && n.temp != null) return n;
      // 官方站号缺省时退回 Open-Meteo 当前值
      if (city.lat != null) {
        try {
          const d = await getJSON(OM_F + '?latitude=' + city.lat + '&longitude=' + city.lon +
            '&current=temperature_2m,precipitation,relative_humidity_2m,wind_speed_10m,weather_code' +
            '&wind_speed_unit=ms' +          // 同上：默认 km/h，不指定会和气象局的 m/s 混着显示
            '&timezone=' + encodeURIComponent(TZ), { ttl: 300000, key: 'q|' + city.id });
          const c = d && d.current;
          if (c) return {
            src: 'om', temp: c.temperature_2m, precip: c.precipitation, humidity: c.relative_humidity_2m,
            windSpeed: c.wind_speed_10m, wcode: c.weather_code, time: c.time
          };
        } catch (e) { }
      }
      return null;
    },

    /** 批量行情（带并发限制） */
    async quotes(cities, conc) {
      const out = {}; let i = 0;
      const n = Math.max(1, Math.min(conc || 6, cities.length));
      const workers = new Array(n).fill(0).map(async () => {
        while (i < cities.length) {
          const c = cities[i++];
          try { const q = await this.quote(c); if (q) out[c.id] = q; } catch (e) { }
        }
      });
      await Promise.all(workers);
      return out;
    },

    /** 上一个交易日的收盘（昨收），用于计算涨跌 */
    prevClose(city, daily, curTemp) {
      if (!daily || daily.length < 2) return null;
      const last = daily[daily.length - 1];
      // 若最后一根是"今日未完成"，昨收 = 前一根收盘
      const today = todayStr();
      if (last.d === today || last.d >= today) {
        const p = daily[daily.length - 2];
        return p ? p.c : null;
      }
      return last.c;
    }
  };

  /** 天气代码 -> 中文（Open-Meteo WMO code） */
  const WMO = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
  };
  function wmoText(c) { return WMO[c] || '—'; }

  global.U = U;
  global.API = { Cities, Cma, OpenMeteo, Cn, Store, LOCAL, wmoText, todayStr, shiftDate, toDailyBars, toHourlyPoints, getJSON, num };
})(window);
