/* ═══════════════════════════════════════════════════════════════
   weather.js — 真正的天气功能层

   这一层把原来那些"炒股指标"(MACD/KDJ/RSI/BOLL/WR)换成气象上真用得着的东西：
     · 逐小时降水 + 降水概率        Open-Meteo
     · 风向风速 + 阵风              Open-Meteo
     · 云量（总/低/中/高）           Open-Meteo
     · 空气质量 AQI / PM2.5 / PM10  Open-Meteo air-quality
     · 雷达回波动画                 中国气象局 image.nmc.cn
     · 卫星云图                     中国气象局 image.nmc.cn
     · 台风路径                     中国气象局 typhoon.nmc.cn/weatherservice
     · 预警信号                     中国气象局 typhoon.nmc.cn/weatherservice

   全部来源都带 Access-Control-Allow-Origin: *，所以浏览器可以直连，
   GitHub Pages 与本地代理都不需要额外配置；APK 里则走 Java 拦截器。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const TZ = 'Asia/Shanghai';

  // 同一份前端要跑三种环境：
  //   · GitHub Pages —— 直连官方源（Open-Meteo 与气象局都带 ACAO:*，已验证）
  //   · 本地服务     —— 走 server/app.py 的 /api/om、/api/nmc 代理，少一次跨域
  //   · Android APK  —— 走 MainActivity 的拦截器，同源且能离线兜底
  // ?local=0 / ?local=1 可强制切换，方便在本地一条命令里复现线上取数路径。
  const LOCAL = !!global.__TJS_LOCAL__;
  const pick = (local, remote) => (LOCAL ? local : remote);

  const OM_F = pick('/api/om/v1/forecast', 'https://api.open-meteo.com/v1/forecast');
  const OM_Q = pick('/api/om/v1/air-quality', 'https://air-quality-api.open-meteo.com/v1/air-quality');
  const NMC = pick('/api/nmc', 'https://typhoon.nmc.cn/weatherservice');
  const IMG = 'https://image.nmc.cn';

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const num = v => (v === '' || v == null || isNaN(v)) ? null : +v;
  const fx = (v, n) => (v == null || isNaN(v)) ? '--' : (+v).toFixed(n == null ? 1 : n);

  /* ───────── 缓存 ───────── */
  const mem = {};
  function hit(k, ttl) { const e = mem[k]; return (e && Date.now() - e.t < ttl) ? e.v : null; }
  function put(k, v) { mem[k] = { t: Date.now(), v: v }; }

  /* 中国气象局的接口一律用 JSONP 包一层，而且层次不统一：
       · typhoon/jsons/list_default  →  fname(({...}))     ← 两层括号
       · typhoon/jsons/view_3346033  →  fname({...})       ← 一层括号
       · fetch_json/warning/json     →  fname([[...]])     ← 一层括号，内容是数组
     所以逐个剥壳试，谁能 JSON.parse 成功就用谁。 */
  function parseLoose(txt) {
    const s = String(txt).trim();
    const cands = [s];
    const m = s.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (m) cands.push(m[1].trim());
    for (let i = 0; i < 3; i++) {
      const prev = cands[cands.length - 1];
      if (prev.charAt(0) === '(' && prev.charAt(prev.length - 1) === ')') {
        cands.push(prev.slice(1, -1).trim());
      } else break;
    }
    for (let i = 0; i < cands.length; i++) {
      try { return JSON.parse(cands[i]); } catch (e) { /* 试下一个 */ }
    }
    throw new Error('不是合法 JSON');
  }

  async function jget(url, ttl, key) {
    ttl = ttl == null ? 900000 : ttl;
    key = key || url;
    const h = hit(key, ttl);
    if (h) return h;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, { signal: ctl.signal, mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = parseLoose(await res.text());
      put(key, d);
      return d;
    } finally { clearTimeout(timer); }
  }

  /* ═══════════════ 1. 逐小时天气（一个请求拿全） ═══════════════ */
  const HOURLY = [
    'temperature_2m', 'precipitation', 'precipitation_probability', 'rain', 'showers',
    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
    'relative_humidity_2m', 'uv_index', 'visibility', 'dew_point_2m', 'weather_code'
  ].join(',');

  const Weather = {
    /** 当前城市的逐小时气象要素。解析失败抛异常，调用方自己兜。
        pastDays 决定往回拉多久 —— 副图要能画"日K/周K/月K"，就得有几个月的历史。 */
    async hourly(lat, lon, days, pastDays) {
      days = days || 3;
      pastDays = pastDays == null ? 1 : pastDays;
      const url = OM_F + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=' + HOURLY +
        '&wind_speed_unit=ms' +
        '&past_days=' + pastDays + '&forecast_days=' + days +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await jget(url, 900000, 'wx2|' + lat + ',' + lon + '|' + days + '|' + pastDays);
      const h = (d && d.hourly) || {};
      const t = h.time || [];
      if (!t.length) throw new Error('逐小时数据为空');
      // "现在"在数组里的下标。past_days 拉长以后它不再固定是 24，所以显式算出来
      // 交给 series() 用。
      // 注意这里**不再截断** —— 返回完整数组，series() 按周期自己切，
      // window() 也会重新定位"现在"，向后兼容。
      const now = Date.now() - 3 * 3600000;
      let i0 = 0;
      for (let i = 0; i < t.length; i++) {
        if (new Date(t[i].replace(' ', 'T') + ':00+08:00').getTime() >= now) { i0 = Math.max(0, i - 1); break; }
      }
      return {
        src: 'Open-Meteo',
        time: t, i0: i0,
        temp: h.temperature_2m || [],
        precip: (h.precipitation || []).map(v => v || 0),
        prob: (h.precipitation_probability || []).map(v => (v == null ? 0 : v)),
        wind: h.wind_speed_10m || [],
        windDir: h.wind_direction_10m || [],
        gust: h.wind_gusts_10m || [],
        cloud: h.cloud_cover || [],
        cloudLow: h.cloud_cover_low || [],
        cloudMid: h.cloud_cover_mid || [],
        cloudHigh: h.cloud_cover_high || [],
        rh: h.relative_humidity_2m || [],
        uv: h.uv_index || [],
        vis: h.visibility || [],
        dew: h.dew_point_2m || [],
        wcode: h.weather_code || []
      };
    },

    /** 空气质量逐小时（同样支持往回拉，副图的"空气"也要能看日K）
        坑：air-quality 接口**不接受 past_days 与 forecast_days 同时出现** ——
        两个都给会 400 Bad Request（实测 past_days=92&forecast_days=16 → 400，
        而只给 past_days=92 → 200，自带 92 天历史 + 5 天预报）。所以这里只给 past_days。 */
    async air(lat, lon, pastDays) {
      pastDays = pastDays == null ? 1 : pastDays;
      const url = OM_Q + '?latitude=' + lat + '&longitude=' + lon +
        '&hourly=pm10,pm2_5,us_aqi,ozone,nitrogen_dioxide' +
        '&past_days=' + pastDays +
        '&timezone=' + encodeURIComponent(TZ);
      const d = await jget(url, 1800000, 'air3|' + lat + ',' + lon + '|' + pastDays);
      const h = (d && d.hourly) || {};
      return {
        src: 'Open-Meteo CAMS',
        time: h.time || [],
        pm25: h.pm2_5 || [], pm10: h.pm10 || [],
        aqi: h.us_aqi || [], o3: h.ozone || [], no2: h.nitrogen_dioxide || []
      };
    },

    _wx: {},
    /** 把逐小时 + 空气质量都备好，缓存在内存里 */
    async ensure(city) {
      if (!city) return null;
      const cur = this._wx[city.id];
      if (cur && Date.now() - cur.t < 900000) return cur;
      const out = { t: Date.now(), city: city, hourly: null, air: null, err: null };
      // 92 天历史 + 16 天预报：副图要画月K就得有 24 个月……
      // 实际取 92 天（够画日K/周K，月K会只剩 3 个点，所以月K在副图上隐藏），
      // 再长会让这次请求的 JSON 大到手机上难接受。
      try { out.hourly = await this.hourly(city.lat, city.lon, 16, 92); }
      catch (e) { out.err = String(e.message || e); }
      try { out.air = await this.air(city.lat, city.lon, 92); } catch (e) { /* 空气是加分项，失败不影响主图 */ }
      this._wx[city.id] = out;
      return out;
    },

    /* ═══════════════ 2. 雷达回波 / 卫星云图 ═══════════════

       两个实测出来的坑，改地址拼接前务必先看这里：

       ① 文件名的时次戳是 **UTC**，不是北京时间。
          实测 2026-10-05 20:15 CST 时，最新一帧是 ..._PI_20261005115400000.PNG，
          换成北京时间正好是 19:54，只滞后 21 分钟；而同一时刻 12:48（＝北京 20:48）
          是 404。所以下面前缀一律用 getUTC* 取值，Date 对象本身仍是真实时刻，
          显示的时候用本地 getter 就自动是北京时间。

       ② **只有全国 ACHN 有 small/ 档**（约 200 KB），其余七个大区
          （东北/华北/华东/华南/华中/西北/西南）**只有原图**，每帧 479–960 KB。
          所以 small 只对 ACHN 用；别的区域一律走原图，靠少取几帧控制流量。 */

    /** 雷达八大区。城市级雷达官方没有发布，能拿到的最细粒度就是这八个大区。 */
    RADAR_REGIONS: [
      { k: 'ACHN', n: '全国' }, { k: 'ANEC', n: '东北' }, { k: 'ANCN', n: '华北' },
      { k: 'AECN', n: '华东' }, { k: 'ACCN', n: '华中' }, { k: 'ASCN', n: '华南' },
      { k: 'ANWC', n: '西北' }, { k: 'ASWC', n: '西南' }
    ],

    /** 省 -> 雷达大区。打开雷达时按当前城市所在省自动选中对应大区。 */
    PROV_REGION: {
      '黑龙江': 'ANEC', '吉林': 'ANEC', '辽宁': 'ANEC',
      '北京': 'ANCN', '天津': 'ANCN', '河北': 'ANCN', '山西': 'ANCN', '内蒙古': 'ANCN',
      '上海': 'AECN', '江苏': 'AECN', '浙江': 'AECN', '安徽': 'AECN', '福建': 'AECN',
      '江西': 'AECN', '山东': 'AECN', '台湾': 'AECN',
      '河南': 'ACCN', '湖北': 'ACCN', '湖南': 'ACCN',
      '广东': 'ASCN', '广西': 'ASCN', '海南': 'ASCN', '香港': 'ASCN', '澳门': 'ASCN',
      '陕西': 'ANWC', '甘肃': 'ANWC', '青海': 'ANWC', '宁夏': 'ANWC', '新疆': 'ANWC',
      '重庆': 'ASWC', '四川': 'ASWC', '贵州': 'ASWC', '云南': 'ASWC', '西藏': 'ASWC'
    },

    /** 城市 -> 该城市对应的雷达大区代号（查不到就回落到全国） */
    regionFor(city) {
      if (!city) return 'ACHN';
      const p = String(city.prov || city.province || '').replace(/省|市|自治区|回族|维吾尔|壮族|特别行政区/g, '');
      return this.PROV_REGION[p] || this.PROV_REGION[String(city.prov || '').slice(0, 2)] || 'ACHN';
    },

    /** 某个 6 分钟整点的雷达拼图地址。region 取 RADAR_REGIONS 里的代号 */
    radarUrl(region, dt, size) {
      const y = dt.getUTCFullYear(), mo = pad2(dt.getUTCMonth() + 1), da = pad2(dt.getUTCDate());
      const ts = '' + y + mo + da + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      // 见上面 ②：只有 ACHN 有 small/ 档，别的区域请求 small/ 会 404
      const small = (size !== 'full') && region === 'ACHN';
      return IMG + '/product/' + y + '/' + mo + '/' + da + '/RDCP/' + (small ? 'small/' : '') +
        'SEVP_AOC_RDCP_SLDAS3_ECREF_' + region + '_L88_PI_' + ts + '.PNG';
    },

    /** FY-4B 真彩云图（比红外 WXCL 好看，用于"卫星云图"页的第二个产品）。 */
    satColorUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/WXBL/medium/' +
        'SEVP_NSMC_WXBL_FY4B_ETCC_ACHN_LNO_PY_' + ts + '.JPG';
    },

    /** 1 小时降水实况（"降水预报"页的第二个产品：预报 + 实况对照）。
        注意这是 PB_ 前缀、小写 .jpg、15 位时次戳；24 小时预报图是 P9_ + 17 位。 */
    precipNowUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/STFC/medium/' +
        'SEVP_NMC_STFC_SFER_ER1_ACHN_L88_PB_' + ts + '.jpg';
    },

    /** 卫星云图（国家卫星气象中心 FY 系列，产品代号 WXCL）。
        时次戳同样是 UTC，网格是每 30 分钟的 :15 与 :45，偶有缺帧；
        medium/ 约 130 KB（small/ 54 KB、原图 506 KB）。 */
    satUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '00000';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/WXCL/medium/' +
        'SEVP_NSMC_WXCL_ASC_E99_ACHN_LNO_PY_' + ts + '.JPG';
    },

    /** 中央气象台全国降水量预报图（未来 24 小时）。
        产品代号 STFC_SFER_ER24，每 12 小时一张，时次戳 00 / 12（UTC）＝北京 08 / 20 时。 */
    precipUrl(dt) {
      const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
      const ts = '' + y + m + d + pad2(dt.getUTCHours()) + pad2(dt.getUTCMinutes()) + '02400';
      return IMG + '/product/' + y + '/' + m + '/' + d + '/STFC/medium/' +
        'SEVP_NMC_STFC_SFER_ER24_ACHN_L88_P9_' + ts + '.JPG';
    },

    /** 逐帧试探：能把 404 变成"跳过这一帧"，因为图床对不存在的时次返回 404 */
    _tryImg(url) {
      return new Promise(res => {
        const im = new Image();
        im.onload = () => res(true);
        im.onerror = () => res(false);
        im.src = url;
      });
    },

    /** 探测最近有货的雷达帧：从"现在"的 6 分钟整点往回试，凑够 n 帧。
        官方约滞后 20 分钟发布，中间偶尔断档，所以容忍一段连续 miss 再放弃。 */
    async probeRadar(region, n, onStep) {
      n = n || 16;
      const base = new Date();
      base.setUTCMinutes(Math.floor(base.getUTCMinutes() / 6) * 6, 0, 0);
      const out = [];
      let miss = 0;
      for (let k = 0; k < n * 8 && out.length < n && miss < 30; k++) {
        const dt = new Date(base.getTime() - (k + 1) * 360000);
        const url = this.radarUrl(region, dt, 'small');
        /* eslint-disable no-await-in-loop */
        const ok = await this._tryImg(url);
        if (ok) { out.push({ url: url, t: dt, f: true }); miss = 0; }
        else miss++;
        if (onStep) onStep(out.length, n);
      }
      out.reverse();                       // 时间正序：最早的在前
      return out;
    },

    /** 卫星云图：从最近的一个 :15 / :45 世界时时次往回凑 n 帧。
        kind='ir' 红外云图 WXCL ｜ 'rgb' FY-4B 真彩云图 WXBL */
    async probeSat(n, onStep, kind) {
      n = n || 12;
      const rgb = kind === 'rgb';
      const now = new Date();
      const base = new Date(now.getTime());
      base.setUTCMinutes(base.getUTCMinutes() < 45 ? 15 : 45, 0, 0);
      const out = [];
      for (let k = 0; k < n * 4 && out.length < n; k++) {
        const dt = new Date(base.getTime() - k * 1800000);
        if (dt.getTime() > now.getTime()) continue;
        const url = rgb ? this.satColorUrl(dt) : this.satUrl(dt);
        /* eslint-disable no-await-in-loop */
        const ok = await this._tryImg(url);
        if (ok) out.push({ url: url, t: dt, f: true });
        if (onStep) onStep(out.length, n);
      }
      out.sort((a, b) => a.t - b.t);
      return out;
    },

    /** 降水图两种：
        kind='fcst' 未来 24 小时**预报**（中央气象台画的，每 12 小时一张，00/12 UTC）
        kind='now'  最近 1 小时**实况**（每小时一张，整点） */
    async probePrecip(n, onStep, kind) {
      n = n || 6;
      const nowKind = kind === 'now';
      const now = new Date();
      const base = new Date(now.getTime());
      base.setUTCMinutes(0, 0, 0);
      let step = 43200000;
      if (nowKind) step = 3600000;
      else if (base.getUTCHours() < 12) base.setUTCHours(0);
      else base.setUTCHours(12);
      const out = [];
      for (let k = 0; k < n * 3 && out.length < n; k++) {
        const dt = new Date(base.getTime() - k * step);
        if (dt.getTime() > now.getTime()) continue;
        const url = nowKind ? this.precipNowUrl(dt) : this.precipUrl(dt);
        /* eslint-disable no-await-in-loop */
        const ok = await this._tryImg(url);
        if (ok) out.push({ url: url, t: dt, f: true });
        if (onStep) onStep(out.length, n);
      }
      out.sort((a, b) => a.t - b.t);
      return out;
    },

    /* ═══════════════ 3. 台风 ═══════════════ */
    async typhoonList() {
      const d = await jget(NMC + '/typhoon/jsons/list_default', 900000, 'ty|list');
      const arr = (d && d.typhoonList) || [];
      return arr.map(r => ({
        id: r[0], en: r[1], cn: (r[2] || '').replace(/[\s\\n]+/g, ''), no: r[3],
        num: r[4], meaning: r[6], live: r[7] === 'start'
      }));
    },

    async typhoonView(id) {
      const d = await jget(NMC + '/typhoon/jsons/view_' + id, 600000, 'ty|v|' + id);
      const ty = d && d.typhoon;
      if (!ty) throw new Error('没有这个台风');
      const pts = (ty[8] || []).map(p => ({
        id: p[0], t: p[1], epoch: p[2], cat: p[3],
        lon: num(p[4]), lat: num(p[5]), pres: num(p[6]), wind: num(p[7]),
        moveDir: p[8], moveSpd: num(p[9]),
        radii: p[10] || [],
        fcst: this._fcst(p[11]),
        issue: (p[12] || [])[1] || ''
      })).filter(p => p.lat != null && p.lon != null);
      return {
        id: ty[0], en: ty[1], cn: (ty[2] || '').replace(/[\s\\n]+/g, ''), no: ty[3],
        meaning: ty[6], live: ty[7] === 'start', pts: pts
      };
    },

    /** 各家预报：{"BABJ":[[12,"202610050000",lon,lat,pres,wind,"BABJ","TS"],...]} */
    _fcst(o) {
      if (!o) return [];
      const out = [];
      for (const org in o) {
        (o[org] || []).forEach(r => {
          out.push({ org: org, h: num(r[0]), t: r[1], lon: num(r[2]), lat: num(r[3]),
                     pres: num(r[4]), wind: num(r[5]), cat: r[7] });
        });
      }
      out.sort((a, b) => a.h - b.h);
      return out;
    },

    /* ═══════════════ 4. 预警信号 ═══════════════ */
    async warnings() {
      const d = await jget(NMC + '/fetch_json/warning/json', 300000, 'warn');
      const arr = Array.isArray(d) ? d : [];
      return arr.map(r => ({
        title: r[0] || '', time: r[5] || '',
        icon: r[6] ? (IMG + r[6]) : '',
        lat: num(r[7]), lon: num(r[8]), text: r[9] || ''
      }));
    },

    /* ═══════════════ 5. 底图 ═══════════════ */
    _map: null,
    async chinaMap() {
      if (this._map) return this._map;
      const d = await jget('data/china.json', 86400000, 'chinamap');
      this._map = d;
      if (global.echarts) {
        try { echarts.registerMap('wxChina', d); } catch (e) { /* 重复注册无所谓 */ }
      }
      return d;
    },

    /* 台风专用的"亚洲-太平洋"底图。中国底图只画中国，台风跑到 168°E
       那种地方就是一片空白，所以这里换成裁过的世界图（151 KB，
       由 tools/slim_world.py 从 echarts 的 world.json 生成）。
       只在第一次打开台风页时才加载，主页不为它付流量。 */
    _wmap: null,
    async worldMap() {
      if (this._wmap) return this._wmap;
      const d = await jget('data/world.json', 86400000, 'worldmap');
      this._wmap = d;
      if (global.echarts) {
        try { echarts.registerMap('wxWorld', d); } catch (e) { /* 重复注册无所谓 */ }
      }
      return d;
    },

    /* ═══════════════ 6. 等级字典 ═══════════════ */
    CAT: {
      TD: { n: '热带低压', c: '#7fd4ff' }, TS: { n: '热带风暴', c: '#5ce08a' },
      STS: { n: '强热带风暴', c: '#f0c419' }, TY: { n: '台风', c: '#ff9f43' },
      STY: { n: '强台风', c: '#ff5c5c' }, SuperTY: { n: '超强台风', c: '#d24bff' },
      TDd: { n: '热带低压', c: '#7fd4ff' }
    },
    catName(k) { return (this.CAT[k] || {}).n || k || '--'; },
    catColor(k) { return (this.CAT[k] || {}).c || '#8fa4bd'; },

    /** AQI 分级（美标 EPA） */
    aqiLevel(a) {
      if (a == null) return { n: '--', c: '#8fa4bd' };
      if (a <= 50) return { n: '优', c: '#5ce08a' };
      if (a <= 100) return { n: '良', c: '#f0c419' };
      if (a <= 150) return { n: '轻度污染', c: '#ff9f43' };
      if (a <= 200) return { n: '中度污染', c: '#ff5c5c' };
      if (a <= 300) return { n: '重度污染', c: '#c0392b' };
      return { n: '严重污染', c: '#8e44ad' };
    },

    /* 风向：角度 -> 16 方位中文 */
    DIR16: ['北', '北北东', '东北', '东北东', '东', '东南东', '东南', '南南东',
            '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'],
    dirName(deg) {
      if (deg == null) return '--';
      return this.DIR16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] + '风';
    },

    /* ═══════════════ 7. 逐小时副图（替换炒股指标） ═══════════════ */
    /** 把时间轴裁到看得清的窗口：默认从"现在"起 48 小时 */
    window(wx, hours) {
      if (!wx || !wx.time || !wx.time.length) return null;
      hours = hours || 48;
      let i0 = 0;
      const now = Date.now() - 3600000;
      for (let i = 0; i < wx.time.length; i++) {
        const t = new Date(wx.time[i].replace(' ', 'T') + ':00+08:00').getTime();
        if (t >= now) { i0 = Math.max(0, i - 2); break; }
      }
      const e = i0 + hours;
      const cut = a => (a || []).slice(i0, e);
      return {
        label: cut(wx.time).map(s => s.slice(5, 16).replace('T', ' ')),
        temp: cut(wx.temp), precip: cut(wx.precip), prob: cut(wx.prob),
        wind: cut(wx.wind), windDir: cut(wx.windDir), gust: cut(wx.gust),
        cloud: cut(wx.cloud), cloudLow: cut(wx.cloudLow),
        cloudMid: cut(wx.cloudMid), cloudHigh: cut(wx.cloudHigh),
        rh: cut(wx.rh), uv: cut(wx.uv), vis: cut(wx.vis), dew: cut(wx.dew)
      };
    },

    /* ═══════════ 7.5 副图按周期出数（分时 / 五日 / 日K / 周K / 月K / 预报K） ═══════════

       原来 drawSub 里写死 `window(wx.hourly, 48)` —— 不管选哪个周期都只画
       "从现在起 48 小时"（48 根柱子、每根 1 小时），所以用户会觉得
       "降水/风/云量/空气的数据太少、间隔太长"。实际上逐小时数组本身横跨
       past_days+forecast_days 天，只要按周期重新分桶聚合就行，不用再发请求。

       聚合口径按物理量该有的口径选，不是一律取平均：
         降水量      窗口内 **求和**（一天的雨量 = 各小时之和）
         降水概率    窗口内 **最大**（这一天下雨的可能性）
         风速/阵风   窗口内 **最大**（这一天风最大的时候）
         云量        窗口内 **平均**
         PM2.5/AQI   窗口内 **平均**
         气温        窗口内 **平均**
       桶的边界用**当地时间**（Open-Meteo 已按时区返回本地时间字符串）。 */
    series(hourly, air, name, period) {
      period = period || 'trend';
      if (!hourly || !hourly.time || !hourly.time.length) return null;

      // 分时就是"今天 24 小时"，交给 window()，它就是为这个场景写的
      if (period === 'trend') {
        const w = this.window(hourly, 24);
        if (w) { w.mode = 'hour'; w.span = '今天 · 逐小时'; }
        return w;
      }

      const T = hourly.time;
      const dayStr = t => String(t).slice(0, 10);
      const fmt = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      const dayAdd = (ds, n) => {
        const p = ds.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
        d.setDate(d.getDate() + n); return fmt(d);
      };
      const weekStart = ds => {
        const p = ds.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmt(d);
      };
      const today = dayStr(T[hourly.i0] || T[T.length - 1]);

      // 空气质量是另一个请求，起止时刻不一定对齐 —— 按时间字符串查表对齐
      const aIdx = {};
      if (air && air.time) for (let i = 0; i < air.time.length; i++) aIdx[air.time[i]] = i;
      const airP = (k, t) => {
        const i = aIdx[t];
        if (i == null) return null;
        const v = (air[k] || [])[i];
        return v == null ? null : v;
      };

      // 每个周期：取数窗口 + 分桶键（keyOf=null 表示不聚合，保持逐小时）
      let from, to, keyOf, mode, span;
      if (period === '5day') {
        // 需求：天气预报最重要的是"预报"，所以五日 = 昨天 → 未来第三天
        from = dayAdd(today, -1); to = dayAdd(today, 3);
        keyOf = null; mode = 'hour'; span = '昨天 → 未来三天 · 逐小时';
      } else if (period === 'day') {
        from = dayAdd(today, -59); to = today;
        keyOf = dayStr; mode = 'day'; span = '最近 60 天 · 逐日';
      } else if (period === 'week') {
        from = dayAdd(today, -363); to = today;
        keyOf = t => weekStart(dayStr(t)); mode = 'week'; span = '最近 52 周 · 逐周';
      } else if (period === 'month') {
        const p = today.split('-'), d = new Date(+p[0], +p[1] - 1, 1);
        d.setMonth(d.getMonth() - 23); from = fmt(d); to = today;
        keyOf = t => dayStr(t).slice(0, 7); mode = 'month'; span = '最近 24 个月 · 逐月';
      } else {                                   // fcst 预报K
        from = today; to = dayAdd(today, 15);
        keyOf = dayStr; mode = 'day'; span = '未来 16 天 · 逐日';
      }

      // 逐小时 -> 分桶
      const buckets = [], byKey = {};
      for (let i = 0; i < T.length; i++) {
        const ds = dayStr(T[i]);
        if (ds < from || ds > to) continue;
        const k = keyOf ? keyOf(T[i]) : null;
        let b;
        if (k == null) {
          b = { label: T[i].slice(5, 16).replace('T', ' ').replace('-', '/'), rows: [] };
          buckets.push(b);
        } else {
          b = byKey[k];
          if (!b) {
            b = byKey[k] = {
              label: (mode === 'month' ? k.replace('-', '/') : k.slice(5).replace('-', '/')),
              rows: []
            };
            buckets.push(b);
          }
        }
        b.rows.push({
          temp: hourly.temp[i], precip: hourly.precip[i], prob: hourly.prob[i],
          wind: hourly.wind[i], gust: hourly.gust[i], windDir: hourly.windDir[i],
          cloud: hourly.cloud[i], cloudLow: hourly.cloudLow[i],
          cloudMid: hourly.cloudMid[i], cloudHigh: hourly.cloudHigh[i],
          pm25: airP('pm25', T[i]), aqi: airP('aqi', T[i])
        });
      }
      if (!buckets.length) return null;

      const agg = (rows, k, how) => {
        const a = rows.map(r => r[k]);
        if (how === 'sum') { let s = 0; a.forEach(v => { s += (v || 0); }); return +s.toFixed(1); }
        if (how === 'max') { let m = null; a.forEach(v => { if (v != null && (m == null || v > m)) m = v; }); return m; }
        let s = 0, n = 0; a.forEach(v => { if (v != null) { s += v; n++; } });
        return n ? +(s / n).toFixed(1) : null;
      };
      // 主导风向：取风最大那一刻的风向（角度直接取平均是错的）
      const dirAt = rows => {
        let bd = null, bw = -1;
        rows.forEach(r => { if (r.wind != null && r.wind > bw) { bw = r.wind; bd = r.windDir; } });
        return bd;
      };

      const out = {
        mode: mode, span: span, label: [], temp: [], precip: [], prob: [],
        wind: [], gust: [], windDir: [], cloud: [], cloudLow: [], cloudMid: [],
        cloudHigh: [], pm25: [], aqi: []
      };
      buckets.forEach(b => {
        out.label.push(b.label);
        out.temp.push(agg(b.rows, 'temp', 'mean'));
        out.precip.push(agg(b.rows, 'precip', 'sum'));
        out.prob.push(agg(b.rows, 'prob', 'max'));
        out.wind.push(agg(b.rows, 'wind', 'max'));
        out.gust.push(agg(b.rows, 'gust', 'max'));
        out.windDir.push(dirAt(b.rows));
        out.cloud.push(agg(b.rows, 'cloud', 'mean'));
        out.cloudLow.push(agg(b.rows, 'cloudLow', 'mean'));
        out.cloudMid.push(agg(b.rows, 'cloudMid', 'mean'));
        out.cloudHigh.push(agg(b.rows, 'cloudHigh', 'mean'));
        out.pm25.push(agg(b.rows, 'pm25', 'mean'));
        out.aqi.push(agg(b.rows, 'aqi', 'mean'));
      });
      return out;
    },

    /** 副图定义表：名字 -> {标题, 单位, 数据源} */
    SUBS: [
      { k: 'range',  n: '温差',   tip: '每天一根柱子，柱子越高说明那天忽冷忽热（最高温与最低温的差）' },
      { k: 'precip', n: '降水',   tip: '降水量（柱子）和下雨概率（黄线）。跟着上面的周期走：分时看小时、日K看天、周K看周' },
      { k: 'wind',   n: '风',     tip: '风速（柱子）、阵风（虚线）和风向（箭头）。跟着周期走：日K取当天最大风，周K取当周最大风' },
      { k: 'cloud',  n: '云量',   tip: '总云量（白线）以及低云/中云/高云各占多少。跟着周期走，按窗口取平均' },
      { k: 'air',    n: '空气',   tip: '空气质量指数 AQI 与 PM2.5 浓度。跟着周期走，按窗口取平均' }
    ],

    isWeatherSub(k) { return this.SUBS.some(s => s.k === k); }
  };

  global.Weather = Weather;
})(window);
