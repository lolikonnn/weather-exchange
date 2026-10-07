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
  const OM_A = 'https://archive-api.open-meteo.com/v1/archive';
  /* archive 的备胎：historical-forecast 同样吃 start_date/end_date，而且跟 archive 主机
     是**两个不同的配额桶**（实测 archive 报 "Hourly API request limit exceeded" 时，
     换一台往往还活着）。 */
  const OM_A_ALT = 'https://historical-forecast-api.open-meteo.com/v1/forecast';

  /* ───────── 单槽位持久缓存（三份"贵且不太会变"的响应共用） ─────────
   * 历史逐小时 / 近期+预报 / 15 分钟行情，各占一个 localStorage 槽位。
   * **故意不按城市堆** —— 别把省下来的请求配额换成存储配额。换城市时会覆盖，
   * 但没关系：跨会话的"上次那座城市"由城市快照（tjs.cx*）负责。
   * 每个槽位两档有效期：
   *   · ttl   —— 新鲜期，期内直接用，一个请求都不发；
   *   · stale —— **数据源挂了时也认**的兜底期。
   * 为什么非要 stale 这一档：2026-10-07 Open-Meteo 额度用尽、全线 429，网页直接白掉。
   * 使用者的原话是「没有最新的记录就拿历史记录糊弄一下差不多得了」——
   * 过期的历史照样画得出 K 线，比一张空图强得多。 */
  const PC = {
    arch: { ttl: 12 * 3600000, stale: 30 * 86400000 },
    fcst: { ttl: 6 * 3600000, stale: 14 * 86400000 },
    min: { ttl: 6 * 3600000, stale: 14 * 86400000 }
  };
  /** 取持久缓存。allowStale=true 放宽到 stale 档 —— **只在"真的取不到"之后才这么问**。 */
  function pcGet(slot, key, allowStale) {
    const e = storeGet('pc.' + slot, null);
    if (!e || e.k !== key || !e.v) return null;
    const lim = allowStale ? PC[slot].stale : PC[slot].ttl;
    return (Date.now() - (e.t || 0)) < lim ? e.v : null;
  }
  function pcSet(slot, key, v) {
    try { storeSet('pc.' + slot, { k: key, t: Date.now(), v: v }); }
    catch (e) { /* 配额爆了就算了，下次再试 */ }
  }

  /* 本地代理探测：EXE / APK 外壳会注入 window.__TJS_LOCAL__。
     探针页等未注入时按 hostname 自行判定，避免本地调试误走直连。 */
  const LOCAL = (typeof global.__TJS_LOCAL__ !== 'undefined')
    ? !!global.__TJS_LOCAL__
    : (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) || location.protocol === 'file:');

  /* ───────── 缓存 ─────────
   * 除了「拿到结果就存」，这里还做了两件必须做的事，起因是一次实测：
   * 把页面挂 2 小时，Open-Meteo 被打了 804 次，其中 720 次全是同一个坐标的
   * current= 实况回退 —— 正好等于「每个轮询 tick 一次」（默认 10 秒）。
   * 原因是缓存只在请求**成功返回之后**才写入：只要一次请求还没落地（网络慢、
   * 或上游超时 20 秒 > 轮询间隔 10 秒），下一个 tick 就会再发一次，永远存不上。
   *   · inflight：同一个 key 正在飞的请求只保留一个，后来者直接复用那个 Promise。
   *   · fail：失败也记一笔短 TTL，避免上游持续挂掉时每个 tick 都重试。
   * 注意 TTL 必须和调用方的节流周期对齐，否则缓存先过期等于没节流。
   */
  const mem = {};
  function cacheGet(key, ttl) {
    const e = mem[key];
    if (e && Date.now() - e.t < ttl) return e.v;
    return null;
  }
  function cacheSet(key, v) { mem[key] = { t: Date.now(), v, bad: false }; }
  /** 失败也要压一会儿，否则上游一挂就是每 tick 一次重试 */
  const FAIL_TTL = 60000;
  function failGet(key) {
    const e = mem[key];
    if (e && e.bad && Date.now() - e.t < FAIL_TTL) return true;
    return false;
  }
  function failSet(key) { mem[key] = { t: Date.now(), v: null, bad: true }; }

  const inflight = {};

  /* ───────── Open-Meteo 主机回退 ─────────
   * 免费额度是**按主机名分桶**的：api.open-meteo.com 被限流（429
   * "Daily API request limit exceeded"）时，historical-forecast-api.open-meteo.com
   * 往往还是好的 —— 实测两者互不影响，而且后者参数与返回结构完全一致，
   * 连 past_days + forecast_days 的未来段都照给（实测 past_days=92&forecast_days=16
   * 返回 2026-07-06..2026-10-21，与主站等价）。
   * 所以同一份数据挂两个主机，谁行用谁；把可用的那个记在 omHost，别每次都去撞墙。
   * 缓存 key 带 `#h<idx>` —— 两台主机各存各的，否则一台的失败记录会把另一台也堵住。 */
  const OM_F = 'https://api.open-meteo.com/v1/forecast';
  const OM_F_ALT = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
  const OM_F_HOSTS = [OM_F, OM_F_ALT];
  let omHost = 0;

  /** 带主机回退的 Open-Meteo 取数。q 是 '?latitude=…' 那段查询串。 */
  async function omGetJSON(q, opt) {
    let lastErr = null;
    for (let i = 0; i < OM_F_HOSTS.length; i++) {
      const idx = (omHost + i) % OM_F_HOSTS.length;
      try {
        const d = await getJSON(OM_F_HOSTS[idx] + q, {
          ttl: opt && opt.ttl,
          key: ((opt && opt.key) || 'om' + q) + '#h' + idx
        });
        omHost = idx;              // 记住这台能用，下次先走它
        return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Open-Meteo 不可用');
  }

  async function getJSON(url, opt) {
    opt = opt || {};
    const ttl = opt.ttl == null ? 600000 : opt.ttl;
    const key = opt.key || url;
    const hit = cacheGet(key, ttl);
    if (hit !== null) return hit;
    if (failGet(key)) throw new Error('cached failure: ' + key);
    if (inflight[key]) return inflight[key];   // 同一个 key 在途 → 合并成一次请求

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 20000);
    const p = (async () => {
      try {
        const res = await fetch(url, { signal: ctl.signal, headers: opt.headers, mode: opt.mode || 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        let data;
        try { data = JSON.parse(txt); }
        catch (e) { data = JSON.parse(txt.replace(/^[^(]*\(|\)[;\s]*$/g, '')); }  // JSONP 兜底
        cacheSet(key, data);
        return data;
      } catch (e) {
        failSet(key);
        throw e;
      } finally {
        clearTimeout(timer);
        delete inflight[key];
      }
    })();
    inflight[key] = p;
    return p;
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
    all: [], hot: [], byId: {}, places: [],
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
      await this.loadPlaces();          // 拿不到也不影响主目录
      return this;
    },
    /** 省 / 地级市 / 区县三级地名目录（带中心点经纬度）。
     *  cities.json 只有 352 个**地级市**（源自气象局站号表），所以义乌、昆山、
     *  敦煌这类县级市在搜索框里搜不到。这里补齐到区县级：这些地方没有气象局
     *  站号，但带经纬度，直接走 Open-Meteo 按坐标取天气即可。 */
    async loadPlaces() {
      if (this.places.length) return this.places;
      let d;
      try {
        d = await getJSON('data/places.json?ts=' + Math.floor(Date.now() / 86400000), { ttl: 86400000 });
      } catch (e) { this.places = []; return this.places; }
      // 地级市里已经有气象局站号的那批，不要再以「无站号」的副本重复出现
      const bare = s => String(s || '').replace(/(自治州|自治县|地区|林区|特别行政区|市|县|区|盟)$/, '');
      const known = {};
      this.all.forEach(c => { known[bare(c.name)] = 1; });
      const out = [];
      (d.list || []).forEach(r => {
        const lev = r[6] || 3;
        if (lev === 1) return;                       // 省级：搜省名已经能命中省内的市
        const b = bare(r[1]);
        if (lev === 2 && (known[b] || known[b + '市'] || known[b + '地区'])) return;
        const c = {
          id: 'p' + r[0], name: r[1], lat: r[3], lon: r[2],
          prov: r[4] || '', city: r[5] || '', lev: lev,
          cma: '', py: '', place: true, pop: 0,
          path: [r[4], r[5], r[1]].filter(Boolean).join(', ')
        };
        c.search = (c.name + ' ' + c.prov + ' ' + c.city + ' ' + c.id + ' ' + b + ' ' + b.replace(/市$/, '')).toLowerCase();
        if (!this.byId[c.id]) this.byId[c.id] = c;
        out.push(c);
      });
      this.places = out;
      return out;
    },
    get(id) { return this.byId[id]; },
    /** 模糊搜索：城市名 / 拼音 / 省份 / 9位代码；再叠一层全国省市区县目录 */
    search(q, limit) {
      q = String(q || '').trim().toLowerCase();
      if (!q) return [];
      const out = [];
      const scan = (arr, base) => {
        for (const c of arr) {
          let score = 0;
          if (c.id === q) score = 1000;
          else if (c.name === q) score = 900;
          else if (c.name.startsWith(q)) score = 700 - c.name.length;
          else if (c.name.indexOf(q) >= 0) score = 500 - c.name.length;
          else if (c.py && c.py.startsWith(q)) score = 460;
          else if (c.py && c.py.indexOf(q) >= 0) score = 380;
          else if (c.search.indexOf(q) >= 0) score = 260;
          if (score) out.push({ c, score: score + base + Math.min(c.pop || 0, 5000) / 5000 });
        }
      };
      scan(this.all, 0);
      scan(this.places, -5);            // 同分时优先有气象局站号的城市
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

  /* ═══════ 气象局的"没数据"哨兵值 ═══════
     站点没有实时观测时，气象局不返回 null，而是把**每个**字段填成哨兵：
     数值给 9999、字符串给 "9999"、lastUpdate 停在最后一次正常上报的时刻。
     实测（2026-10-06）：
       45011B 澳门  lastUpdate 2025/08/08 10:25  9 个字段全 9999（一年前）
       58968  台北  lastUpdate 2025/04/23 21:17  同样全 9999
     这两个站是长期没人上报；而 58367 上海 / 57083 郑州 / 57780 株洲 / S1003 成都
     在 Actions 预抓的静态文件里也出现过 9999（lastUpdate 2026/10/05 19:10，
     说明这是**偶发**的，不是港澳台专属）—— 所以过滤要放在这里，而不是按城市白名单。

     不过滤的后果（用户实际报的 bug）：9999 被当成真温度存进 S.quotes，
     quoteOf 又优先取 S.quotes 而不是中国天气网快照，于是
     报价头显示 9999.0℃、涨幅 9999-23.9 = +9975.1 / (23.9+273.15) ≈ +3358%，
     湿度 9999%、风速 9999 m/s、体感 9999℃ 一起炸；9999 还会在自选按涨幅排序时顶到最上面。 */
  const CMA_BAD = 9999;
  function cmaNum(v) {
    if (v == null || v === '') return null;
    const n = (typeof v === 'number') ? v : Number(String(v).trim());
    return (!isFinite(n) || n === CMA_BAD) ? null : n;
  }
  function cmaStr(v) {
    if (v == null) return '';
    const t = String(v).trim();
    return (t === '' || t === String(CMA_BAD)) ? '' : t;
  }
  /** lastUpdate 形如 "2025/08/08 10:25"，不是 ISO —— 自己解析，别指望 new Date 跨引擎一致 */
  function cmaStamp(s) {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }
  /* 超过这个岁数的实况就不叫实况了。24 小时足够宽松：气象局正常时每分钟都上报，
     只有站点停报（或偶发 9999）才会跨过这条线。解析不出来时不判定，宁可信其有。 */
  const CMA_STALE_MS = 24 * 3600 * 1000;

  /** 清洗 data.now；整站没有可用温度、或实况已经过期时返回 null，让调用方退回 Open-Meteo */
  function cleanNow(n, lastUpdate) {
    if (!n) return null;
    const temp = cmaNum(n.temperature);
    if (temp == null) return null;
    const at = cmaStamp(lastUpdate);
    if (isFinite(at) && Date.now() - at > CMA_STALE_MS) return null;
    return {
      temp: temp, feels: cmaNum(n.feelst),
      precip: cmaNum(n.precipitation), humidity: cmaNum(n.humidity), pressure: cmaNum(n.pressure),
      windDir: cmaStr(n.windDirection), windDeg: cmaNum(n.windDirectionDegree),
      windSpeed: cmaNum(n.windSpeed), windScale: cmaStr(n.windScale)
    };
  }

  const Cma = {
    ok(city) { return !!(city && city.cma); },

    /** 实况。响应形如 {msg,code,data:{location:{...}, now:{...}, lastUpdate:"..."}} */
    async now(city, ttl) {
      if (!this.ok(city)) return null;
      try {
        const ms = ttl || 180000;
        const d = await cmaRaw('now', city.cma, ms, 'now:' + city.cma);
        const dd = d && d.data;
        const n = cleanNow(dd && dd.now, dd && dd.lastUpdate);
        // 哨兵/过期值被清干净 → 这个站没有实况。必须返回 null：
        // Store.quote 里 `if (n && n.temp != null) return n;` 和 loadCity 里
        // `now0 || Store.quote(...)` 都靠这个 null 才会去走 Open-Meteo 兜底。
        if (!n) return null;
        return Object.assign({
          src: 'cma', alarm: dd.alarm || [], jieQi: dd.jieQi || '', time: dd.lastUpdate || ''
        }, n);
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
        now: cleanNow(dd.now, dd.lastUpdate),
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
    /** 历史逐小时；返回 {time:[], temp:[], precip:[]}
     *
     *  ⚠ 这一段是**永远不变的历史**：窗口右端停在"今天-93 天"、左端是"今天-560 天"，
     *  只有跨天的时候最末尾才挪一格。可它偏偏是全站最贵的一次请求
     *  （467 天 × 24 小时 × 2 个变量，实测约 300 KB），而以前**每次刷新页面都重下一遍** ——
     *  既慢，又在烧 Open-Meteo 的免费额度。2026-10-07 那次 429
     *  （"Daily API request limit exceeded. Please try again tomorrow."）就是这么被烧穿的。
     *  所以除了内存缓存，再往 localStorage 里放一份：**单个槽位**（不按城市堆，避免把配额
     *  换成存储配额），12 小时失效。跨天那一格会晚 12 小时才补上，看历史 K 线毫无影响。 */
    async archive(lat, lon, startDate, endDate) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&start_date=' + startDate + '&end_date=' + endDate +
        '&hourly=temperature_2m,precipitation' +
        '&timezone=' + encodeURIComponent(TZ);
      // key 必须带上 endDate。只按 startDate 做 key 的话，"同一个 start、不同的 end"
      // 两次调用会互相命中缓存，第二次等于没发出去 —— 是个一直没被触发的潜伏 bug。
      const key = 'a|' + lat + ',' + lon + '|' + startDate + '|' + endDate;

      const fresh = pcGet('arch', key, false);
      if (fresh) return fresh;

      // 两台主机轮着试（配额是分开的）。这是**唯一一条没有走 omGetJSON 的 Open-Meteo 请求** ——
      // 因为它要的是 archive 那套 start_date/end_date 参数，跟 forecast 那套不一样。
      let d = null, lastErr = null;
      const hosts = [OM_A, OM_A_ALT];
      for (let i = 0; i < hosts.length; i++) {
        try { d = await getJSON(hosts[i] + q, { ttl: 1800000, key: key + '#h' + i }); break; }
        catch (e) { lastErr = e; }
      }
      if (d) {
        const out = this._unpack(d, 'temperature_2m', 'precipitation');
        if (out.time.length) pcSet('arch', key, out);
        return out;
      }
      // 两台都挂了（最常见的就是额度用尽 429）→ **过期的历史也认**，最多 30 天。
      // 这段是历史，晚几天画出来的还是那条 K 线；总比整页空白强。
      const stale = pcGet('arch', key, true);
      if (stale) return stale;
      throw lastErr || new Error('历史逐小时取不到');
    },

    /** 近期逐小时（含过去 92 天）+ 16 日预报 */
    async forecast(lat, lon, pastDays, fcstDays) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m,precipitation,relative_humidity_2m,wind_speed_10m,weather_code,cloud_cover,uv_index' +
        // 后面四个是给「🔭 天文」的观星指数用的，**加在同一次请求里** ——
        // 不新增请求、不引入第二个模型，所以天文页的云量永远跟主站天气一致。
        //   cloud_cover_low/mid/high：分层云量。低云直接挡星（硬伤），
        //     高层薄云肉眼看着还是"晴"，但它抬高背景亮度、先把银河糊掉。
        //   visibility：能见度（米），和气溶胶互补。
        ',cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,sunrise,sunset,uv_index_max,daylight_duration' +
        // Open-Meteo 的风速默认单位是 km/h，而中国气象局给的是 m/s。
        // 不显式指定的话，"平均风速"会显示成 17.6 m/s（其实是 17.6 km/h ≈ 4.9 m/s），
        // 和一墙之隔的实况风速 5.0 m/s 自相矛盾。
        '&wind_speed_unit=ms' +
        '&past_days=' + (pastDays == null ? 92 : pastDays) +
        '&forecast_days=' + (fcstDays == null ? 16 : fcstDays) +
        '&timezone=' + encodeURIComponent(TZ);
      const key = 'f|' + lat + ',' + lon + '|' + pastDays + '|' + fcstDays;
      const fresh = pcGet('fcst', key, false);
      if (fresh) return fresh;
      let d = null;
      try { d = await omGetJSON(q, { ttl: 900000, key: key }); }
      catch (err) {
        // 两台主机都挂了（最常见：额度用尽 429）→ **拿上次那份预报顶着**，最多 14 天。
        // 曲线会停在缓存那一天的末尾、5 日高低温也照旧有 —— 这就是"拿历史记录糊弄一下"。
        const stale = pcGet('fcst', key, true);
        if (stale) return stale;
        throw err;
      }
      const h = this._unpack(d, 'temperature_2m', 'precipitation');
      h.humidity = (d.hourly && d.hourly.relative_humidity_2m) || [];
      h.wind = (d.hourly && d.hourly.wind_speed_10m) || [];
      h.wcode = (d.hourly && d.hourly.weather_code) || [];
      h.cloud = (d.hourly && d.hourly.cloud_cover) || [];
      h.uv = (d.hourly && d.hourly.uv_index) || [];
      // 天文用的三项（跟上面同一份响应，没有第二个数据源）
      h.cloudLow = (d.hourly && d.hourly.cloud_cover_low) || [];
      h.cloudMid = (d.hourly && d.hourly.cloud_cover_mid) || [];
      h.cloudHigh = (d.hourly && d.hourly.cloud_cover_high) || [];
      h.vis = (d.hourly && d.hourly.visibility) || [];
      h.daily = d.daily || null;
      h.utcOffset = d.utc_offset_seconds;
      pcSet('fcst', key, h);
      return h;
    },

    _unpack(d, tk, pk) {
      const h = (d && d.hourly) || {};
      return { time: h.time || [], temp: h[tk] || [], precip: (h[pk] || []).map(v => v || 0) };
    },

    /** 15 分钟级行情（「点击做空天气」用）。
     *
     *  这里比逐小时多了两样关键的东西：**CAPE（对流有效位能）** 和 **阵风**。
     *  气温一小时才挪一两度，做成 K 线就是一条几乎水平的线，毫无盘感；
     *  而对流能量可以从 0 冲到 5000、阵风能从 2 m/s 冲到 60 m/s —— 这才是
     *  「天气行情」真正的波动来源，也是打雷下雨时价格突然拉升的物理依据。
     *
     *  **主机顺序是特意反过来的**：实测 api.open-meteo.com 的 minutely_15
     *  只保留最近一个月左右（past_days=92 时前面 2000 多个点全是 null），
     *  而 historical-forecast-api 满 92 天。omGetJSON 默认先走主站，
     *  所以这里先试 ALT，并且拿到后要验一遍「最早那天到底有没有数」。
     *  单看 HTTP 状态码是发现不了这件事的 —— 它会老老实实返回 200 加一串 null。 */
    async minutely(lat, lon) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&minutely_15=temperature_2m,wind_gusts_10m,precipitation,weather_code,cape,dew_point_2m' +
        '&past_days=92&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      let lastErr = null;
      const key = 'mn|' + lat + ',' + lon;
      const fresh = pcGet('min', key, false);
      if (fresh) return fresh;
      for (let i = 0; i < OM_F_HOSTS.length; i++) {
        const idx = (1 + i) % OM_F_HOSTS.length;   // 1=ALT 优先，然后才轮到主站
        try {
          const d = await getJSON(OM_F_HOSTS[idx] + q, {
            ttl: 1800000, key: key + '#h' + idx
          });
          const m = (d && d.minutely_15) || {};
          const t = m.time || [];
          if (!t.length) throw new Error('minutely_15 返回空');
          // 抽查最早一天：够一半才算这段历史是真的有
          let nn = 0, probe = Math.min(96, t.length);
          for (let k = 0; k < probe; k++) if (m.wind_gusts_10m && m.wind_gusts_10m[k] != null) nn++;
          if (nn < probe * 0.5 && i + 1 < OM_F_HOSTS.length) throw new Error('这台主机的 15 分钟历史不够长');
          const out = {
            time: t,
            temp: m.temperature_2m || [],
            gust: m.wind_gusts_10m || [],
            precip: (m.precipitation || []).map(v => v || 0),
            wcode: m.weather_code || [],
            cape: m.cape || [],
            dew: m.dew_point_2m || []
          };
          pcSet('min', key, out);
          return out;
        } catch (e) { lastErr = e; }
      }
      // 两台都挂了 → **拿上次那份顶着**（最多 14 天）。
      // 「点击做空天气」只硬依赖这一份数据，没有它开不了局 ——
      // 额度用尽时使用者的原话是"游戏也玩不了了"，这条兜底就是为它加的。
      const stale = pcGet('min', key, true);
      if (stale) return stale;
      throw lastErr || new Error('取不到 15 分钟行情');
    },

    /**
     * 区域大盘：把同省若干城市的 15 分钟天气**逐变量**平均成一条"区域行情"。
     *
     * 这是给「点击做空天气」用的 —— 单一城市的对流能量波动太随心，玩家很容易
     * 只盯自己那一小块地；真实市场里你炒的那个东西是被**大盘**推着走的。
     *
     * 取的变量和单城 `minutely()` 完全一致（而不是只取气温）：气温太慢太平，
     * 单独拿它当大盘等于把趋势又算了一遍；对流能量/阵风/降水才是波动来源，
     * 于是返回的这组平均值可以直接喂给同一套 `severity()`，得到"区域恶劣度"。
     *
     * Open-Meteo 支持**一次请求多个坐标**（`latitude=a,b,c&longitude=x,y,z` 直接返回数组），
     * 所以同省 8 个城市只要一个请求，不会把额度吃光。
     *
     * ⚠️ 是**等权**平均，不是按人口加权 —— `cities.json` 里只有 id/name/prov/py/lat/lon/cma/path，
     *    没有人口字段。等权就等权，不假装。
     * 失败返回 null（游戏那边会把大盘项退化成 0，纯本地行情照跑）。
     */
    async regionIndex(city, maxCities) {
      const N = maxCities || 8;
      const all = (Cities.all || []).filter(c => c && c.lat != null && c.lon != null);
      let list = all.filter(c => c.prov && c.prov === city.prov);
      // 直辖市（北京市/上海市/天津市/重庆市）在自己省里只有一两个"城市"，
      // 拿它做大盘就等于拿本地行情再做一遍 —— 那样的"大盘"既没意义，还会把快分量算两次。
      // 所以同省凑不够时，退化成**按真实距离取最近的几个城市**，这才是"这一带"的天气。
      let scope = city.prov;
      if (list.length < 4) {
        const near = all.filter(c => c.id !== city.id)
          .map(c => ({ c: c, d: Math.abs(c.lat - city.lat) + Math.abs(c.lon - city.lon) }))
          .sort((a, b) => (a.d - b.d) || (String(a.c.id) < String(b.c.id) ? -1 : 1))
          .slice(0, N);
        list = [city].concat(near.map(x => x.c));
        scope = '附近';
      } else {
        // 本市排第一，其余按 id 稳定排序取样 —— 顺序稳定的好处是缓存键和曲线都不会每次开一局就换
        list.sort((a, b) => (a.id === city.id ? -1 : b.id === city.id ? 1 : String(a.id) < String(b.id) ? -1 : 1));
      }
      const pick = list.slice(0, N);
      if (!pick.length) return null;
      const q = '?latitude=' + pick.map(c => c.lat).join(',') +
        '&longitude=' + pick.map(c => c.lon).join(',') +
        '&minutely_15=temperature_2m,wind_gusts_10m,precipitation,weather_code,cape,dew_point_2m' +
        '&past_days=92&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const key = 'rg|' + pick.map(c => c.id).join('.');
      let lastErr = null;
      for (let i = 0; i < OM_F_HOSTS.length; i++) {
        const idx = (1 + i) % OM_F_HOSTS.length;   // ALT 优先，理由同 minutely()
        try {
          const d = await getJSON(OM_F_HOSTS[idx] + q, { ttl: 1800000, key: key + '#h' + idx });
          const arr = Array.isArray(d) ? d : [d];
          const t = ((arr[0] && arr[0].minutely_15 && arr[0].minutely_15.time) || []);
          if (!t.length) throw new Error('区域大盘返回空');
          // 逐个时刻、逐个变量求平均，缺测的坐标跳过（不拿 0 去拉低平均）
          const VARS = { temp: 'temperature_2m', gust: 'wind_gusts_10m', precip: 'precipitation',
                         wcode: 'weather_code', cape: 'cape', dew: 'dew_point_2m' };
          const out = { time: t, cities: pick.map(c => c.name), scope: scope };
          for (const alias in VARS) {
            const src = VARS[alias];
            const col = new Array(t.length);
            for (let k = 0; k < t.length; k++) {
              let s = 0, n = 0;
              for (const one of arr) {
                const v = one && one.minutely_15 && one.minutely_15[src] ? one.minutely_15[src][k] : null;
                if (v != null) { s += v; n++; }
              }
              col[k] = n ? s / n : null;
            }
            out[alias] = col;
          }
          let nn = 0;
          for (let k = 0; k < Math.min(96, t.length); k++) if (out.gust[k] != null) nn++;
          if (nn < 48 && i + 1 < OM_F_HOSTS.length) throw new Error('这台主机的 15 分钟历史不够长');
          return out;
        } catch (e) { lastErr = e; }
      }
      if (global.console) console.warn('[regionIndex] 取不到区域大盘，退化为纯本地行情:', lastErr && lastErr.message);
      return null;
    },

    /* ───────── 下面四个是「复合标的」的加成项，全部是真实数据源 ─────────
     * 共同点：都返回**带时间轴**的序列，让 game.js 能对齐到它随机截取的那段窗口。
     * 任何一项取不到都返回 null / []，游戏那边退化成 0，绝不编数据补位。
     */

    /** ① 空气质量：逐小时 PM2.5，覆盖 past_days=92（与回放窗口同源同龄）。
     *  为什么不用 current：current 只有一个"现在"的值，对不上历史回放窗口。
     *  为什么是小时级：air-quality 的 minutely_15 返回 0 点（实测），小时是它的最细粒度。
     *  空气质量本来就变得慢，小时级反而比硬凑 15 分钟更诚实。 */
    async airHistory(lat, lon) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=pm2_5&past_days=92&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON('https://air-quality-api.open-meteo.com/v1/air-quality' + q,
        { ttl: 3600000, key: 'airh|' + lat + ',' + lon });
      const h = (d && d.hourly) || {};
      return { time: h.time || [], pm25: h.pm2_5 || [] };
    },

    /** 逐小时气溶胶光学厚度（AOD）—— 天文上"通透度"的专业指标。
     *  为什么另开一次请求：AOD 只在 **air-quality-api** 上，跟 weather 的 forecast 不同主机。
     *  但只要 2 天、只要一个字段，实测响应 **870 B**，比一张雷达图便宜得多。
     *  参考口径：<0.1 极品透明 · 0.1~0.2 很好 · 0.2~0.4 一般 · >0.4 明显发灰。
     *  这一项让观星指数不必只看云 —— 天上没云但一层霾，星星一样是糊的。 */
    async astroAir(lat, lon) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=aerosol_optical_depth&forecast_days=2&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON('https://air-quality-api.open-meteo.com/v1/air-quality' + q,
        { ttl: 1800000, key: 'aod|' + lat + ',' + lon });
      const h = (d && d.hourly) || {};
      return { time: h.time || [], aod: h.aerosol_optical_depth || [] };
    },

    /** ④ 预报偏离：**当时发出来的预报** vs 事后实况。
     *  previous-runs-api 的写法是「变量名后缀」而不是 models 参数 ——
     *  temperature_2m_previous_day1 = 提前 24 小时发出的预报（实测 864/864 非空，
     *  且与 historical-forecast 时间轴逐点相同，所以可以直接做差）。
     *  注意 previous-runs 同样给 temperature_2m（实况），一份请求两样都有。 */
    async previousRuns(lat, lon) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&minutely_15=temperature_2m,precipitation,temperature_2m_previous_day1' +
        '&past_days=92&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await getJSON('https://previous-runs-api.open-meteo.com/v1/forecast' + q,
        { ttl: 3600000, key: 'prev|' + lat + ',' + lon });
      const m = (d && d.minutely_15) || {};
      return { time: m.time || [], act: m.temperature_2m || [], fc1: m.temperature_2m_previous_day1 || [] };
    },

    /** ② 地震：USGS，免 key、CORS 全开、支持按城市半径筛。
     *  用 maxradiuskm 让"附近的地震"才有意义 —— 智利 8 级对广州的天气没影响，
     *  但对"当地压力源"的设定来说，它也不该推动广州的指数。
     *  返回 [{ t: epoch_ms, mag, place, depth }]，按时间升序。 */
    async quakes(lat, lon, radiusKm, days) {
      const R = radiusKm || 700, D = days || 130;
      const iso = t => new Date(t).toISOString().slice(0, 10);
      const now = Date.now();
      const q = '?format=geojson&starttime=' + iso(now - D * 86400000) + '&endtime=' + iso(now) +
        '&minmagnitude=3.0&limit=400&latitude=' + lat + '&longitude=' + lon + '&maxradiuskm=' + R;
      const d = await getJSON('https://earthquake.usgs.gov/fdsnws/event/1/query' + q,
        { ttl: 1800000, key: 'eq|' + lat + ',' + lon + ',' + R + '|' + iso(now) });
      const out = ((d && d.features) || []).map(f => {
        const p = (f && f.properties) || {}, g = f && f.geometry;
        if (p.mag == null || !p.time) return null;
        const c = (g && g.coordinates) || [];
        return { t: p.time, mag: p.mag, place: p.place || '',
                 lat: +c[1], lon: +c[0], depth: (c.length > 2 ? +c[2] : null) };
      }).filter(Boolean);
      out.sort((a, b) => a.t - b.t);
      return out;
    },

    /** ③ 台风：中央气象台台风网（typhoon.nmc.cn）。
     *  HTTPS 可用、CORS 是 *，返回是 JSONP —— getJSON 里的 JSONP 兜底会剥掉外层。
     *  列表按**新→旧**排序，条目形如
     *    [3346033, 'KOGUMA', '小熊', '2629', '2629', null, '小熊星座', 'start']
     *  路径点在第 8 项，每个点形如
     *    [id, '202601140000', <epoch_ms>, 'TD', 经度, 纬度, 气压, 风速, ...]
     *  列表本身不带日期，只能把 view_ 拉下来才知道有没有落在窗口里 —— 所以取**最近 30 个**，
     *  并且**并发限流**、TTL 放长到 6 小时。
     *
     *  ⚠️ 一开始只取了 12 个，结果 92 天窗口里的台风几乎全被切掉：列表按新→旧排，
     *     前 12 个最新的是 9 月底~10 月初那几个，而真正逼近华南的（沙德尔 211km、
     *     美莎克 477km、紫檀 350km）都在 7~8 月 —— 离城市最近的反而被丢掉了。
     *     30 个足够覆盖 past_days=92 的整段窗口。 */
    async typhoons(maxN) {
      const N = maxN || 30;
      const year = new Date().getFullYear();
      let list;
      try {
        const d = await getJSON('https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_' + year,
          { ttl: 21600000, key: 'tyl|' + year });
        list = (d && d.typhoonList) || [];
      } catch (e) {
        // 跨年时会落到去年
        try {
          const d = await getJSON('https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_' + (year - 1),
            { ttl: 21600000, key: 'tyl|' + (year - 1) });
          list = (d && d.typhoonList) || [];
        } catch (e2) { return []; }
      }
      const pick = list.slice(0, N);
      const pts = [];
      let at = 0;
      const worker = async () => {
        while (at < pick.length) {
          const a = pick[at++];
          try {
            const d = await getJSON('https://typhoon.nmc.cn/weatherservice/typhoon/jsons/view_' + a[0],
              { ttl: 21600000, key: 'tyv|' + a[0] });
            const tr = (d && d.typhoon && d.typhoon[8]) || [];
            for (const p of tr) {
              if (!p || p[2] == null) continue;
              pts.push({ t: +p[2], lat: +p[5], lon: +p[4], wind: +p[7] || 0,
                         pres: +p[6] || null, grade: p[3] || '',
                         name: (a[2] || a[1] || '').replace(/\s+/g, ''), num: a[3] || '' });
            }
          } catch (e) { /* 单个台风拉不到就跳过，不影响别的 */ }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);   // 并发 4
      pts.sort((x, y) => x.t - y.t);
      return pts;
    },

    /** 仅取最近 24 小时温度，用于指数条 sparkline */    async mini(lat, lon) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m&past_days=1&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await omGetJSON(q, { ttl: 1800000, key: 'm|' + lat + ',' + lon });
      return ((d.hourly && d.hourly.temperature_2m) || []).slice(-26);
    },

    /** 轻量快照：昨收 / 今日开高低 / 当前 / 最近 24h 走势（行情列表与指数条用） */
    async brief(lat, lon, ttl) {
      const q = '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=temperature_2m,precipitation&daily=weather_code,precipitation_sum' +
        '&past_days=2&forecast_days=1&timezone=' + encodeURIComponent(TZ);
      const d = await omGetJSON(q, { ttl: ttl || 600000, key: 'b|' + lat + ',' + lon });
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

    /**
     * 气象局版的「昨收 + 迷你走势」—— 二级源（Open-Meteo）整个挂掉时的兜底。
     *
     * ★ 昨收的定义和 OpenMeteo.brief 不完全一样，这是数据源的粒度决定的，不是 bug：
     *     OpenMeteo.brief.prevClose = 昨天最后一个整点的气温（真正的"收盘价"）
     *     Cn.brief.prevClose        = 昨天实测日均温 = (maxobs + minobs) / 2
     *   一个来自逐小时、一个来自逐日，所以同一个城市两边算出来的涨跌幅会有出入。
     *   日历年月表里只有 cla='obs' 的日子带 maxobs/minobs，所以只认这些日子。
     *
     * 成本：按城市一份月度日历（Cn.calendar 自己缓存 30 分钟），不是按小时放大。
     * 覆盖：桌面版/APK 走本地代理，是全部 352 城；GitHub Pages 是静态站，
     *       只有预抓过的 45 城有 cal 文件（热门 22 城全在里面），其余城市这里返回 null。
     */
    async brief(city) {
      if (!city || !city.id) return null;
      const today = todayStr();

      // 只保留"今天以前 + 带实测高低温"的日子，日均温当作那天的收盘价
      const collect = function (arr) {
        const out = [];
        for (const it of (arr || [])) {
          const d = String(it.date || '');
          if (!/^\d{8}$/.test(d)) continue;
          const ds = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
          if (ds >= today) continue;
          const hi = num(it.maxobs), lo = num(it.minobs);
          if (hi == null || lo == null) continue;
          out.push({ d: ds, c: (hi + lo) / 2 });
        }
        return out;
      };
      const ymOf = function (m) {
        const t = new Date(today + 'T00:00:00');
        t.setDate(1); t.setMonth(t.getMonth() + m);
        return U.fmtDate(t).slice(0, 7).replace('-', '');
      };

      // 当月文件通常还带着上月末尾几天；万一没有（比如月初抓的当月文件从 1 号起），
      // 再补一份上月 —— 只在这条罕见分支上多花一次请求。
      let days = collect(await Cn.calendar(city.id, ymOf(0)));
      if (!days.length) days = collect(await Cn.calendar(city.id, ymOf(-1)));
      if (!days.length) return null;

      days.sort(function (p, q) { return p.d < q.d ? -1 : 1; });
      const prev = days[days.length - 1];
      return {
        today: today, src: 'cma',
        prevClose: prev.c, prevDay: prev.d,
        open: null, high: null, low: null, now: null,
        wcode: null, precip: null,
        spark: days.slice(-24).map(function (x) { return x.c; }),
        sparkPts: [], days: days
      };
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
  /** 从 fromIdx 起按天截取逐时点。days 用于封顶（分时=1 天，7日分时=7 天），
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

  /* ───────── 城市快照：跨会话的持久缓存 ─────────
   * 为什么要有：一次冷启动要拉六份数据（历史 560 天、近 92 天 + 未来 16 天、实况、
   * 预报、官方快照、官方月度日历），手机上一次就是好几秒。可这里面**绝大部分根本不会变** ——
   * 昨天的日K、上个月的历史、甚至上周的逐小时，跟刚才打开时一模一样。
   * 所以先把上次那份**原样渲染出来**，同时照常去拉最新的，回来再替换一遍。
   * 这就是手机天气软件那个体感："进去先看到上次的情报，停一会儿自己更新成最新的"。
   *
   * 存哪儿：localStorage。key 里带**结构版本号**，`out` 的形状一改就把版本 +1，
   * 旧的一律不认 —— 免得读出一份缺字段的旧结构，在渲染里炸出一堆 undefined。
   * 存多少：只留最近 CX_KEEP 座城市（一份 200~400 KB，localStorage 一共才 5 MB）。
   */
  const CX_VER = 1, CX_KEEP = 2, CX_MAX_AGE = 30 * 86400000;
  const CX_HOURS = 2800;
  const cxKey = id => 'cx' + CX_VER + '.' + id;
  const cxIndex = () => storeGet('cx.idx', null) || [];

  /** 派生数据**一律不存**：`indicators` / `week` / `month` 全都能由 `daily` 现算，
   *  而它们加起来 **524 KB**，占了整份快照的 61%（实测：indicators 221 + week 154 + month 149）。
   *  读回来的时候现算一遍，既省了 2/3 的空间，也顺带保证"指标"和"日K"永远是**同一版公式**
   *  算出来的 —— 不会出现"存的时候是老公式、读回来还没重算"这种鬼故事。 */
  const CX_DERIVED = ['indicators', 'week', 'month'];

  /** 存之前瘦身：① 扔掉派生数据；② 裁掉逐小时的历史长尾。
   *  为什么要裁逐小时：它是 **560 天 × 24 小时 × 12 条平行数组**，整份 JSON 实测 1622 KB；
   *  localStorage 一共才 5 MB，而 `setItem` 是**同步**的 —— 手机上一次写 1.6 MB 会明显卡一下。
   *  裁掉安全吗：日K 是**另外单独存的**（`daily` 里每天还自带 `hours` 数组），
   *  真正会去翻 `hourly` 的只有三处，而且全都只看"最近"：
   *    · `renderTape` 从末尾往前数 60 行；
   *    · `hourIndexAt` 找"现在"是哪个时次；
   *    · 天文页取今晚 18:00 → 明晨 06:00 那一窗。
   *  留 2800 小时（≈116 天）把最近 92 天 + 未来 16 日预报全包住，够用。 */
  function cxSlim(out) {
    const copy = {};
    Object.keys(out).forEach(k => { if (CX_DERIVED.indexOf(k) < 0) copy[k] = out[k]; });
    const h = out.hourly;
    if (h && h.time && h.time.length > CX_HOURS) {
      const cut = h.time.length - CX_HOURS;
      const slim = {};
      Object.keys(h).forEach(k => {
        const v = h[k];
        slim[k] = Array.isArray(v) ? v.slice(cut) : v;   // 平行数组必须一起裁，否则下标全错位
      });
      copy.hourly = slim;
      copy.cxCut = cut;                                  // 记一笔裁了多少，方便排查
    }
    return copy;
  }

  function cxSave(out) {
    if (!out || !out.city || !out.city.id) return;
    if (!out.daily || !out.daily.length) return;          // 空壳不存，否则下次开出一片空白
    const id = out.city.id;
    const rec = { at: Date.now(), out: cxSlim(out) };
    try { storeSet(cxKey(id), rec); }
    catch (e) {
      // 配额爆了：先把别的几份清掉再试一次；还写不进去就放弃 —— 缓存失败绝不能影响主流程
      try { cxIndex().forEach(o => { if (o !== id) storeSet(cxKey(o), null); }); storeSet(cxKey(id), rec); }
      catch (e2) { }
    }
    const idx = cxIndex().filter(x => x !== id);
    idx.unshift(id);
    idx.slice(CX_KEEP).forEach(old => storeSet(cxKey(old), null));
    storeSet('cx.idx', idx.slice(0, CX_KEEP));
  }
  /** 读上次那份。**不检查有效期到秒**，只要没超过一个月就给 —— 反正马上会去拉新的。
   *  派生数据（indicators / week / month）存的时候扔掉了，这里现算回来：
   *  它们本来就是 daily 的函数，算一遍几十毫秒，比存 524 KB 划算得多。 */
  function cxPeek(city) {
    if (!city || !city.id) return null;
    const rec = storeGet(cxKey(city.id), null);
    if (!rec || !rec.out || !rec.out.daily || !rec.out.daily.length) return null;
    if (Date.now() - (rec.at || 0) > CX_MAX_AGE) return null;
    const out = rec.out;
    try {
      if (!out.indicators) out.indicators = IND.computeAll(out.daily);
      if (!out.week) out.week = IND.aggregate(out.daily, 'week');
      if (!out.month) out.month = IND.aggregate(out.daily, 'month');
    } catch (e) { return null; }        // 重算失败就当没有快照，走正常加载
    return rec;
  }

  /* ═══════════════ 6. 统一取数入口 ═══════════════ */
  const Store = {
    /** 上次打开这座城市时看到的整份行情（可能为 null）。给 app.js 做"先显示旧的"。 */
    peekCity(city) { return cxPeek(city); },
    /** 手写一份快照。正常路径由 loadCity 自己存，这个口子是给探针/排错用的。 */
    saveCity(out) { cxSave(out); },
    /** 手动丢缓存（调试/排错用） */
    dropCity(city) { if (city && city.id) storeSet(cxKey(city.id), null); },

    /** 一次性拉齐某城市的全部分析数据 */
    async loadCity(city, onStep) {
      const step = onStep || function () { };
      step('连接中国气象局…');
      /* ── 六件事一次性全发出去 ──
       * 它们之间**没有任何依赖**，原来却是一条 `await` 接一条的瀑布：手机上一次冷启动
       * 要串行等六轮网络往返（实况 → 预报 → 历史 560 天 → 近 92 天 + 16 日预报 →
       * 官方快照 → 官方日历），这是"打开要爬一会儿"的一半原因。
       * 现在并发发出去，总耗时约等于**最慢的那一份**。
       * 必要的几份（Cma.now / Cma.forecast / Cn.snapshot）故意不加 catch —— 它们挂了本来就
       * 该让上层报"加载失败"；可选的几份各自 catch 成 null，缺了不阻塞主流程。 */
      step('正在拉取 ' + city.name + ' 的行情…');
      const hasLL = city.lat != null && city.lon != null;
      // 历史窗口故意停在「今天-93」：最后 92 天 + 未来 16 天由 recent 接上
      const archStart = shiftDate(todayStr(), -560);
      const archEnd = shiftDate(todayStr(), -93);
      const [now0, fcst, hist0, recent0, official, cnPair] = await Promise.all([
        Cma.now(city),
        Cma.forecast(city),
        hasLL ? OpenMeteo.archive(city.lat, city.lon, archStart, archEnd).catch(() => null) : null,
        hasLL ? OpenMeteo.forecast(city.lat, city.lon, 92, 16).catch(() => null) : null,
        Cn.snapshot(city.id),
        city.id
          ? Promise.all([Cn.forecast(city.id).catch(() => null), Cn.officialDaily(city.id).catch(() => null)])
          : Promise.resolve([null, []])
      ]);
      const hist = hist0 || { time: [], temp: [], precip: [] };
      const recent = recent0 || {
        time: [], temp: [], precip: [], humidity: [], wind: [], wcode: [],
        cloud: [], uv: [], cloudLow: [], cloudMid: [], cloudHigh: [], vis: [], daily: null
      };
      // 中国天气网 d1 域：当日预报/预警 + 官方月度日历（历史同期均值 / 最近观测 / 15·40 日预报）
      const cnFcst = cnPair ? cnPair[0] : null;
      const calDaily = (cnPair && cnPair[1]) || [];
      // 没有气象局站号的城市（例如「当前所在地」这种纯坐标点）实况是空的。
      // 不补的话报价头会是一片 "--"（体感 / 风向 / 气压最明显），所以退回 Open-Meteo 当前值。
      const now = now0 || (hasLL ? await Store.quote(city) : null);

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
      const clouds = padTo(recent.cloud), uvs = padTo(recent.uv);
      // 天文用的三项（分层云量 / 能见度）跟其它近期字段一样：只有近 92 天有，
      // 前段（历史归档那段）补齐 null。**忘了往这儿加**的话，观星页会一直显示「云 --/--」——
      // forecast() 里取回来了、却在这一步被丢掉，是这次差点漏掉的一环。
      const cloudLows = padTo(recent.cloudLow), cloudMids = padTo(recent.cloudMid);
      const cloudHighs = padTo(recent.cloudHigh), viss = padTo(recent.vis);
      const daily = toDailyBars(times, temps, precs, { humidity: humids, wind: winds, wcode: wcodes });

      // ⚠ 历史与预报**两份都没拿到**时 `daily` 会是空数组（最常见：Open-Meteo 免费额度用尽 429）。
      // 2026-10-07 那次这里**抛了错**，整页只剩一句"加载失败" —— 而气象局的实况、官方预报、
      // 官方日历那三路其实都是好的。所以现在**不抛错**，只打个标记降级：
      //   · 行情栏（报价头 / 五档盘口 / 逐时流水）照常从气象局的数据出；
      //   · 曲线没有最新的就用历史顶上（archive / forecast 的过期缓存，见 pcGet 的 stale 档），
      //     真的一点都没有时 chart.js 自己会画"暂无K线数据"；
      //   · out.degraded 让界面能如实说明"看的是历史数据"。
      const noBars = !daily.length;

      // 用 Open-Meteo daily 补/覆盖更可靠的最高最低温
      const omDaily = {};
      if (recent.daily && recent.daily.time) {
        recent.daily.time.forEach((d, i) => {
          omDaily[d] = {
            high: recent.daily.temperature_2m_max[i],
            low: recent.daily.temperature_2m_min[i],
            precip: recent.daily.precipitation_sum[i],
            code: recent.daily.weather_code[i],
            sunrise: recent.daily.sunrise[i], sunset: recent.daily.sunset[i],
            // 紫外线最大指数、昼长（秒）；老版本 Open-Meteo 可能不给，允许缺
            uvMax: (recent.daily.uv_index_max || [])[i],
            daylight: (recent.daily.daylight_duration || [])[i]
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

      // 7 日分时：**昨天 → 未来第五天**（共 7 天）。
      // 原来取的是"今天往前数 5 天"，全是已经发生过的历史，而天气预报最该看的
      // 恰恰是还没发生的部分 —— 所以改成横跨昨天/今天/未来若干天。
      // 2026-10-07：从 5 天扩到 7 天 —— 右侧盘口列的是"未来 5 日"，主图只到未来第三天，
      // 两块对不上；现在 昨天 + 今天 + 未来五天，正好和右边一一对应。
      // ⚠ `daily` 可能是**空的**（Open-Meteo 全线 429）。原来这里直接下标，会抛
      // "Cannot read properties of undefined (reading 'd')"。空的时候就老老实实给空数组，
      // 让 chart.js 去画它自己的"暂无K线数据"。
      const d7start = daily.length ? daily[Math.max(0, ti - 1)].d : null;
      const d7idx = d7start ? times.findIndex(t => String(t).slice(0, 10) === d7start) : -1;
      const seven = d7idx >= 0 ? toHourlyPoints(times, temps, precs, d7idx, 7) : [];

      // official / cnFcst / calDaily 已经在上面那一批并发请求里一起取回来了

      const out = {
        city, now, fcst, official, cnFcst, calDaily,
        hourly: { time: times, temp: temps, precip: precs, humidity: humids, wind: winds, wcode: wcodes, cloud: clouds, uv: uvs,
          cloudLow: cloudLows, cloudMid: cloudMids, cloudHigh: cloudHighs, vis: viss },
        daily, week, month, intraday, seven,
        omDaily, lastDay, todayIndex: ti, today,
        base: ti > 0 ? daily[ti - 1].c : (ti === 0 ? daily[0].o : null),
        // true = 逐小时/日K 这一路没拿到，界面要如实说明"曲线看的是历史数据"
        degraded: noBars
      };
      out.indicators = IND.computeAll(daily);
      out.stamp = new Date();
      // 存一份快照给**下次打开**用（先把旧的显示出来，同时照常去拉新的）。
      // 放在最后：此时 out 已经完整，缺字段的半成品绝不会被存进去。
      cxSave(out);
      return out;
    },

    /** 轻量行情：只取实况（用于列表轮询） */
    async quote(city) {
      const n = await Cma.now(city);
      if (n && n.temp != null) return n;
      // 官方站号缺省时退回 Open-Meteo 当前值
      if (city.lat != null) {
        try {
          const d = await omGetJSON('?latitude=' + city.lat + '&longitude=' + city.lon +
            '&current=temperature_2m,apparent_temperature,precipitation,relative_humidity_2m,' +
            'wind_speed_10m,wind_direction_10m,surface_pressure,weather_code' +
            '&wind_speed_unit=ms' +          // 同上：默认 km/h，不指定会和气象局的 m/s 混着显示
            '&timezone=' + encodeURIComponent(TZ), { ttl: 300000, key: 'q|' + city.id });
          const c = d && d.current;
          if (c) return {
            src: 'om', temp: c.temperature_2m, precip: c.precipitation, humidity: c.relative_humidity_2m,
            windSpeed: c.wind_speed_10m, wcode: c.weather_code, time: c.time,
            // 这几个字段以前没取，导致无站号城市的报价头「体感 / 风向 / 气压」恒为 "--"
            feels: c.apparent_temperature, pressure: c.surface_pressure,
            windDeg: c.wind_direction_10m,
            windDir: (global.Weather ? global.Weather.dirName(c.wind_direction_10m) : null)
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

  /* ───────── NOAA SWPC：空间天气（地磁 / 极光） ─────────
   * 为什么是 NOAA：免 key、`Access-Control-Allow-Origin: *`，浏览器里能直连 ——
   * 跟当初地震页选 USGS 而不是 ceic.ac.cn 是同一个判据（后者不给 CORS 头）。
   *   · forecast 那份**同时含 observed / estimated / predicted**，一份就够画
   *     "过去一天 + 未来三天"，不用再拼两份；
   *   · 1m 那份每分钟刷新，专门用来显示"现在"。
   * 实测极光椭圆图那几个 JPG 常年返回 202 空体（不是 200），所以这一页只用 JSON。
   *
   * Kp 是**三小时一档**的地磁活动指数（0~9），5 以上就算地磁暴，对应 NOAA 的 G1~G5。
   * SWPC 的 time_tag 是**不带时区的 UTC**（"2026-10-07T03:00:00"），补个 Z 再解析。 */
  const SWPC_HOST = 'https://services.swpc.noaa.gov';
  // OVATION 极光网格是自己 fetch 的（不走 getJSON 的缓存，见 auroraProb 的注释），
  // 这个模块级变量就是它的缓存：只留"离你最近那一格的概率"，不留整张网格。
  const AUR = { t: 0, v: null, key: '' };
  const swpcTime = s => {
    // ⚠ 两种写法都有：Kp / 太阳黑子那几份是**不带时区**的 UTC（"2026-10-07T03:00:00"），
    // 而 summary/*（太阳风）**自带 Z**（"2026-10-07T08:27:00Z"）。一律先摘掉尾部的 Z 再补，
    // 否则会拼成 "...ZZ" → Date.parse 返回 NaN → 时间显示成 null。
    const t = Date.parse(String(s).replace(' ', 'T').replace(/Z$/i, '') + 'Z');
    return isFinite(t) ? new Date(t) : null;
  };
  const SWPC = {
    /** 现在这一刻的 Kp（每分钟更新） */
    async kpNow() {
      const j = await getJSON(SWPC_HOST + '/json/planetary_k_index_1m.json',
        { ttl: 120000, key: 'swpc:kp1m', timeout: 12000 });
      const last = (j && j.length) ? j[j.length - 1] : null;
      if (!last) return null;
      const v = (last.estimated_kp != null) ? last.estimated_kp : last.kp_index;
      return { t: swpcTime(last.time_tag) || new Date(), kp: v == null ? null : +v };
    },
    /** 过去一天 + 未来三天的 Kp 序列（每行带 observed / estimated / predicted） */
    async kpSeries() {
      const j = await getJSON(SWPC_HOST + '/products/noaa-planetary-k-index-forecast.json',
        { ttl: 900000, key: 'swpc:kpf', timeout: 15000 });
      if (!j || !j.length) return [];
      return j.map(r => ({ t: swpcTime(r.time_tag), kp: r.kp == null ? null : +r.kp, kind: r.observed || '' }))
        .filter(x => x.t && x.kp != null);
    },
    /** 太阳黑子数（月值）。25 周上行期能到 100+，这也是极光变多的背景原因。 */
    async sunspots() {
      const j = await getJSON(SWPC_HOST + '/json/solar-cycle/observed-solar-cycle-indices.json',
        { ttl: 21600000, key: 'swpc:ssn', timeout: 15000 });
      if (!j || !j.length) return null;
      const last = j[j.length - 1];
      // ⚠ smoothed_ssn 在当月还没算出来时是 **-1**（不是 null），别把 -1 当数据用。
      return { month: last['time-tag'] || '', ssn: last.ssn == null ? null : +last.ssn };
    },

    /** **你头顶**此刻的极光概率（%）。OVATION 模型的 1° 全球网格。
     *
     *  这是极光这一页最值钱的一件东西：在这之前只能用"你这个纬度大约需要 Kp ≥ N"
     *  这种经验口径去猜，现在直接给一个百分比。
     *
     *  ⚠ 原始 JSON **919 KB**（gzip 后 142 KB），是全站最贵的一次请求，所以：
     *    ① TTL 半小时（模型本身也是这个刷新节奏）；
     *    ② **故意不走 getJSON 的通用缓存** —— 那会把解析后那张 65160 个点的
     *       对象图一直留在内存里，老安卓 WebView 吃不消。这里自己 fetch，
     *       就近取一格，只把那个百分点存下来，解析出来的大对象让它被回收掉。
     *  网格格式：`coordinates: [[经度, 纬度, 概率], …]`，经度 0~359、纬度 -90~90。 */
    async auroraProb(lat, lon) {
      const key = (+lat).toFixed(1) + ',' + (+lon).toFixed(1);
      if (AUR.v != null && AUR.key === key && Date.now() - AUR.t < 1800000) return AUR.v;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      try {
        const res = await fetch(SWPC_HOST + '/json/ovation_aurora_latest.json',
          { signal: ctl.signal, mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const arr = j && j.coordinates;
        if (!arr || !arr.length) throw new Error('OVATION 结构不对');
        const wantLon = Math.round(((+lon % 360) + 360) % 360), wantLat = Math.round(+lat);
        let best = null, bd = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          let dl = Math.abs(c[0] - wantLon); if (dl > 180) dl = 360 - dl;
          const db = Math.abs(c[1] - wantLat);
          const d = dl * dl + db * db;
          if (d < bd) { bd = d; best = c; }
        }
        if (!best) return null;
        const v = {
          prob: +best[2], gridLon: best[0], gridLat: best[1],
          obs: j['Observation Time'] || '', fcast: j['Forecast Time'] || ''
        };
        AUR.v = v; AUR.t = Date.now(); AUR.key = key;
        return v;
      } finally { clearTimeout(timer); }
    },

    /** 太阳风速度 + 磁场 Bz。两个接口分别只有 **59 / 60 字节**，便宜得离谱。
     *  Bz 是极光预报里最灵的一个量：**朝南（负值）＝和地球磁场反着接，能量灌得进来**；
     *  朝北（正值）就算速度再快也大多被挡回去。所以只看 Kp 是看不出"接下来会不会爆"的。 */
    async solarWind() {
      const [sp, mg] = await Promise.all([
        getJSON(SWPC_HOST + '/products/summary/solar-wind-speed.json',
          { ttl: 300000, key: 'swpc:swsp', timeout: 10000 }),
        getJSON(SWPC_HOST + '/products/summary/solar-wind-mag-field.json',
          { ttl: 300000, key: 'swpc:swmg', timeout: 10000 })
      ]);
      const a = sp && sp[0], b = mg && mg[0];
      if (!a && !b) return null;
      return {
        speed: (a && a.proton_speed != null) ? +a.proton_speed : null,
        bt: (b && b.bt != null) ? +b.bt : null,
        bz: (b && b.bz_gsm != null) ? +b.bz_gsm : null,
        t: swpcTime((a && a.time_tag) || (b && b.time_tag))
      };
    },

    /** 当前太阳耀斑等级（GOES X 射线）。`current_class` 形如 "A0.0" / "C3.2" / "M1.5" / "X2.0"。
     *  耀斑是地磁暴的源头 —— M 级以上通常意味着两三天后可能有一场极光。 */
    async flareNow() {
      const j = await getJSON(SWPC_HOST + '/json/goes/primary/xray-flares-latest.json',
        { ttl: 300000, key: 'swpc:flare', timeout: 12000 });
      const r = j && j[0];
      if (!r) return null;
      const cur = String(r.current_class || '').trim();
      return {
        text: cur,
        cls: cur ? cur.charAt(0).toUpperCase() : '',
        num: parseFloat(cur.slice(1)) || 0,
        max: r.max_class || '', maxT: swpcTime(r.max_time)
      };
    }
  };

  global.U = U;
  global.API = { Cities, Cma, OpenMeteo, Cn, Store, SWPC, LOCAL, wmoText, todayStr, shiftDate, toDailyBars, toHourlyPoints, getJSON, num };
})(window);
