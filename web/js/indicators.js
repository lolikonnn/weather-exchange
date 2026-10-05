/* ═══════════════════════════════════════════════════════════════
   indicators.js — 技术指标计算（输入为数字数组，输出与输入等长，不足处为 null）
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /** 简单移动平均 */
  function MA(src, n) {
    const out = new Array(src.length).fill(null);
    let s = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      s += (v == null ? 0 : v);
      if (i >= n) s -= (src[i - n] == null ? 0 : src[i - n]);
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  /** 指数移动平均；首个有效值用 SMA 播种 */
  function EMA(src, n) {
    const out = new Array(src.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null, buf = [], started = false;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null) { out[i] = prev; continue; }
      if (!started) {
        buf.push(v);
        if (buf.length === n) {
          prev = buf.reduce((a, b) => a + b, 0) / n;
          started = true; out[i] = prev;
        }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  /** 威尔德平滑（RSI 用） */
  function wilder(src, n) {
    const out = new Array(src.length).fill(null);
    let prev = null, buf = [];
    for (let i = 0; i < src.length; i++) {
      const v = src[i] == null ? 0 : src[i];
      if (prev == null) {
        buf.push(v);
        if (buf.length === n) { prev = buf.reduce((a, b) => a + b, 0) / n; out[i] = prev; }
      } else {
        prev = (prev * (n - 1) + v) / n;
        out[i] = prev;
      }
    }
    return out;
  }

  /** MACD(12,26,9)：返回 {dif, dea, macd} */
  function MACD(close, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    const ef = EMA(close, fast), es = EMA(close, slow);
    const dif = close.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
    const dea = EMA(dif, sig);
    const macd = dif.map((d, i) => (d == null || dea[i] == null) ? null : (d - dea[i]) * 2);
    return { dif, dea, macd };
  }

  /** KDJ(9,3,3)：返回 {k, d, j} */
  function KDJ(high, low, close, n, m1, m2) {
    n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
    const len = close.length;
    const k = new Array(len).fill(null), d = new Array(len).fill(null), j = new Array(len).fill(null);
    let pk = 50, pd = 50;
    for (let i = 0; i < len; i++) {
      if (i < n - 1) continue;
      let hh = -Infinity, ll = Infinity;
      for (let t = i - n + 1; t <= i; t++) {
        if (high[t] > hh) hh = high[t];
        if (low[t] < ll) ll = low[t];
      }
      const rsv = (hh === ll) ? 50 : (close[i] - ll) / (hh - ll) * 100;
      pk = (m1 - 1) / m1 * pk + rsv / m1;
      pd = (m2 - 1) / m2 * pd + pk / m2;
      k[i] = pk; d[i] = pd; j[i] = 3 * pk - 2 * pd;
    }
    return { k, d, j };
  }

  /** RSI，返回数组的数组 */
  function RSI(close, periods) {
    periods = periods || [6, 12, 24];
    return periods.map(n => {
      const len = close.length;
      const up = new Array(len).fill(null), dn = new Array(len).fill(null);
      for (let i = 1; i < len; i++) {
        const ch = close[i] - close[i - 1];
        up[i] = ch > 0 ? ch : 0;
        dn[i] = ch < 0 ? -ch : 0;
      }
      const au = wilder(up, n), ad = wilder(dn, n);
      return close.map((_, i) => {
        if (au[i] == null || ad[i] == null) return null;
        if (au[i] + ad[i] === 0) return 50;
        return au[i] / (au[i] + ad[i]) * 100;
      });
    });
  }

  /** BOLL(20,2)：返回 {mid, upper, lower, width} */
  function BOLL(close, n, k) {
    n = n || 20; k = k || 2;
    const mid = MA(close, n);
    const upper = new Array(close.length).fill(null);
    const lower = new Array(close.length).fill(null);
    const width = new Array(close.length).fill(null);
    for (let i = n - 1; i < close.length; i++) {
      const seg = close.slice(i - n + 1, i + 1);
      const m = mid[i];
      const v = seg.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
      const sd = Math.sqrt(v);
      upper[i] = m + k * sd;
      lower[i] = m - k * sd;
      width[i] = m ? (upper[i] - lower[i]) / m * 100 : null;
    }
    return { mid, upper, lower, width };
  }

  /** WR 威廉指标(14)：0(超买)~100(超卖)，此处返回 100-原始值 使高=强 */
  function WR(high, low, close, n) {
    n = n || 14;
    const out = new Array(close.length).fill(null);
    for (let i = n - 1; i < close.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let t = i - n + 1; t <= i; t++) {
        if (high[t] > hh) hh = high[t];
        if (low[t] < ll) ll = low[t];
      }
      out[i] = (hh === ll) ? 50 : (hh - close[i]) / (hh - ll) * 100;
    }
    return out;
  }

  /** 从日K序列计算全部指标 */
  function computeAll(bars) {
    const close = bars.map(b => b.c), high = bars.map(b => b.h), low = bars.map(b => b.l);
    const r = {
      ma5: MA(close, 5), ma10: MA(close, 10), ma20: MA(close, 20),
      ma30: MA(close, 30), ma60: MA(close, 60),
      volMa5: MA(bars.map(b => b.v || 0), 5),
      volMa10: MA(bars.map(b => b.v || 0), 10)
    };
    Object.assign(r, MACD(close, 12, 26, 9));
    Object.assign(r, KDJ(high, low, close, 9, 3, 3));
    const rsi = RSI(close, [6, 12, 24]);
    r.rsi6 = rsi[0]; r.rsi12 = rsi[1]; r.rsi24 = rsi[2];
    Object.assign(r, BOLL(close, 20, 2));
    r.wr14 = WR(high, low, close, 14);
    r.wr6 = WR(high, low, close, 6);
    return r;
  }

  /** 由日K聚合为周K / 月K */
  function aggregate(daily, mode) {
    if (!daily.length) return [];
    const keyOf = (d) => {
      const dt = U.parseDate(d.d);
      if (mode === 'week') {
        const wd = (dt.getDay() + 6) % 7;            // 周一=0
        const mon = new Date(dt.getTime() - wd * 86400000);
        return U.fmtDate(mon);
      }
      return d.d.slice(0, 7);                        // month: 'YYYY-MM'
    };
    const out = [];
    let cur = null;
    for (const d of daily) {
      const k = keyOf(d);
      if (!cur || cur.k !== k) {
        if (cur) out.push(cur.bar);
        cur = { k, bar: { d: k, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v || 0, n: 1, raw: [d] } };
      } else {
        const b = cur.bar;
        b.h = Math.max(b.h, d.h); b.l = Math.min(b.l, d.l); b.c = d.c;
        b.v += (d.v || 0); b.n++; b.raw.push(d);
      }
    }
    if (cur) out.push(cur.bar);
    return out;
  }

  /** 为指标附加"最低覆盖"标记：返回最后一个非 null 的下标 */
  function lastValid(arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i;
    return -1;
  }

  global.IND = { MA, EMA, MACD, KDJ, RSI, BOLL, WR, computeAll, aggregate, lastValid };
})(window);
