'use strict';
/**
 * 扶摇（同花顺金融数据 API）REST 客户端
 * 文档：https://fuyao.aicubes.cn/docs/
 *
 * 关键约定（来自官方文档，已核对）：
 *  - Base URL: https://fuyao.aicubes.cn
 *  - 鉴权头: X-api-key；缺失/无效返回 code=2001；无权限 code=2003
 *  - HTTP 状态码恒为 200，业务错误经 body.code 表达
 *  - valuations/prices snapshot: thscodes 逗号分隔，单次最多 100 个 token
 *  - prices/historical-batch: 单次最多 10 个代码
 *  - financials/indicators: 单只 + 单报告期（yyyy-1..4）
 *  - meta/tickers/list: limit 最大 10000
 *
 * 失败处理原则：任何失败都抛出带 code/kind 的 FuyaoError，
 * 上层必须把真实错误状态透传到前端，禁止用虚构数据静默替代。
 */

const BASE_URL = process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn';
const TIMEOUT_MS = Number(process.env.FUYAO_TIMEOUT_MS || 25000);

class FuyaoError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'FuyaoError';
    this.kind = kind; // 'no_key' | 'auth' | 'permission' | 'param' | 'upstream' | 'network' | 'timeout' | 'business'
    Object.assign(this, extra);
  }
  toJSON() {
    return { kind: this.kind, message: this.message, code: this.code, request_id: this.request_id, path: this.path };
  }
}

async function request(apiKey, path, query = {}) {
  if (!apiKey) {
    throw new FuyaoError('no_key', '未配置扶摇 API Key（FUYAO_API_KEY）。请在页面右上角「数据源设置」中填写，或在服务端环境变量中配置。', { path });
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${BASE_URL}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-api-key': apiKey, Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new FuyaoError('timeout', `请求扶摇接口超时（>${TIMEOUT_MS}ms）：${path}`, { path });
    throw new FuyaoError('network', `无法连接扶摇接口：${e.message}`, { path });
  }
  clearTimeout(timer);

  let body;
  const text = await res.text();
  try { body = JSON.parse(text); }
  catch { throw new FuyaoError('upstream', `扶摇接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, { path }); }

  const code = body && typeof body.code === 'number' ? body.code : null;
  if (code === 0) return body.data;
  const msg = (body && body.message) || '未知业务错误';
  const rid = body && body.request_id;
  if (code === 2001) throw new FuyaoError('auth', `扶摇 API Key 无效或缺失（code=2001）：${msg}`, { code, request_id: rid, path });
  if (code === 2003) throw new FuyaoError('permission', `当前 API Key 无权访问该数据能力（code=2003）：${msg}`, { code, request_id: rid, path });
  if (code === 5002) throw new FuyaoError('timeout', `扶摇上游数据源超时（code=5002）：${msg}`, { code, request_id: rid, path });
  if (code === 5003) throw new FuyaoError('upstream', `扶摇上游数据源不可用（code=5003）：${msg}`, { code, request_id: rid, path });
  if (code !== null && code >= 1000 && code < 2000) throw new FuyaoError('param', `请求参数错误（code=${code}）：${msg}`, { code, request_id: rid, path });
  throw new FuyaoError('business', `扶摇业务错误（code=${code}）：${msg}`, { code, request_id: rid, path });
}

/** 分块工具 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 并发受限执行，返回 [{status:'fulfilled'|'rejected', value|reason}]，保持输入顺序 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------- 业务封装 ----------------

/** A 股代码表（含中文名），带内存缓存 */
let tickerListCache = null;
async function getAShareTickerList(apiKey, { force = false } = {}) {
  if (tickerListCache && !force) return tickerListCache;
  const items = [];
  let offset = 0;
  const limit = 5000;
  for (let guard = 0; guard < 10; guard++) {
    const data = await request(apiKey, '/api/meta/tickers/list', { asset_type: 'a-share', limit, offset });
    const batch = (data && data.item) || [];
    items.push(...batch);
    if (batch.length < limit) { items.timestamp = data && data.timestamp; break; }
    offset += limit;
  }
  tickerListCache = { items, timestamp: items.timestamp || Date.now(), fetchedAt: Date.now() };
  return tickerListCache;
}

/** 指数/板块成分股 */
async function getConstituents(apiKey, indexThscode) {
  const data = await request(apiKey, '/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return { items: (data && data.item) || [], timestamp: data && data.timestamp };
}

/** 批量估值快照（自动按 100 分块） */
async function getValuationsSnapshot(apiKey, thscodes, { concurrency = 4, onProgress } = {}) {
  const groups = chunk(thscodes, 100);
  const res = await mapLimit(groups, concurrency, async (g, i) => {
    const data = await request(apiKey, '/api/a-share/valuations/snapshot', { thscodes: g.join(',') });
    if (onProgress) onProgress(i + 1, groups.length);
    return data;
  });
  return mergeBatch(res, groups, 'valuations');
}

/** 批量行情快照（自动按 100 分块） */
async function getPricesSnapshot(apiKey, thscodes, { concurrency = 4, onProgress } = {}) {
  const groups = chunk(thscodes, 100);
  const res = await mapLimit(groups, concurrency, async (g, i) => {
    const data = await request(apiKey, '/api/a-share/prices/snapshot', { thscodes: g.join(',') });
    if (onProgress) onProgress(i + 1, groups.length);
    return data;
  });
  return mergeBatch(res, groups, 'prices');
}

function mergeBatch(res, groups, label) {
  const items = [];
  const errors = [];
  let timestamp = null;
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const d = r.value || {};
      if (d.timestamp && (!timestamp || d.timestamp > timestamp)) timestamp = d.timestamp;
      items.push(...((d.item) || []));
    } else {
      errors.push({ batch: i, thscodes: groups[i], error: r.reason instanceof FuyaoError ? r.reason.toJSON() : { kind: 'unknown', message: String(r.reason) } });
    }
  });
  return { items, errors, timestamp, label };
}

/** 批量历史 K 线（自动按 10 分块） */
async function getHistoricalBatch(apiKey, thscodes, { interval = '1d', start, end, adjust = 'forward', concurrency = 5, onProgress } = {}) {
  const groups = chunk(thscodes, 10);
  const res = await mapLimit(groups, concurrency, async (g, i) => {
    const data = await request(apiKey, '/api/a-share/prices/historical-batch', { thscodes: g.join(','), interval, start, end, adjust });
    if (onProgress) onProgress(i + 1, groups.length);
    return data;
  });
  const series = new Map();
  const errors = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const grp of ((r.value && r.value.item) || [])) series.set(grp.thscode, grp);
    } else {
      errors.push({ batch: i, thscodes: groups[i], error: r.reason instanceof FuyaoError ? r.reason.toJSON() : { kind: 'unknown', message: String(r.reason) } });
    }
  });
  return { series, errors };
}

/** 单股财务指标，带报告期回退链 */
async function getFinancialIndicators(apiKey, thscode, reportPeriods) {
  let lastErr = null;
  for (const report of reportPeriods) {
    try {
      const data = await request(apiKey, '/api/a-share/financials/indicators', { thscode, report });
      const flat = {};
      for (const ab of ((data && data.abilities) || [])) {
        for (const ind of (ab.indicators || [])) flat[ind.index_id] = ind.value;
      }
      const nonNull = Object.values(flat).filter((v) => v !== null && v !== undefined).length;
      if (nonNull === 0) { lastErr = null; continue; } // 该期无数据，尝试更早报告期
      return { thscode, report: data.report || report, flat, timestamp: data && data.timestamp };
    } catch (e) {
      lastErr = e;
      // 参数类错误（如该报告期不存在）继续回退；鉴权/网络类错误直接抛出
      if (e instanceof FuyaoError && ['auth', 'permission', 'network', 'timeout', 'no_key'].includes(e.kind)) throw e;
    }
  }
  if (lastErr) throw lastErr;
  return { thscode, report: null, flat: {}, timestamp: null };
}

/** 个股所属板块（用于详情展示，非筛选条件） */
async function getStockSectors(apiKey, thscodes) {
  if (!thscodes.length) return new Map();
  const out = new Map();
  for (const g of chunk(thscodes, 100)) {
    try {
      const data = await request(apiKey, '/api/a-share-index/constituents/ths-index-list-by-stock', { thscode: g.join(',') });
      for (const it of ((data && data.item) || [])) out.set(it.thscode, it.index_list || []);
    } catch { /* 板块信息为可选增强，失败不影响主链路 */ }
  }
  return out;
}

/** 交易日历（用于数据日期是否过期的判断） */
async function getCalendar(apiKey) {
  try {
    const data = await request(apiKey, '/api/a-share/calendar/trading-days', {});
    return data;
  } catch (e) { return { error: e instanceof FuyaoError ? e.toJSON() : { message: String(e) } }; }
}

module.exports = {
  BASE_URL, FuyaoError, request, chunk, mapLimit,
  getAShareTickerList, getConstituents, getValuationsSnapshot, getPricesSnapshot,
  getHistoricalBatch, getFinancialIndicators, getStockSectors, getCalendar,
};
