'use strict';
/**
 * 知选 AI —— 服务端入口
 * Node.js 22+，仅使用内置模块（无生产依赖），满足 QW Pages 动态页运行时约束。
 * 读取 process.env.PORT 与 process.env.HOST。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./lib/config');
const fuyao = require('./lib/fuyao');
const llm = require('./lib/llm');
const engine = require('./lib/engine');
const { METRICS } = require('./lib/metrics');

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const UNIVERSE_OPTIONS = [
  { kind: 'index', thscode: '000300.SH', name: '沪深300', desc: '大盘蓝筹，300 只，取数成本可控（推荐默认）' },
  { kind: 'index', thscode: '000905.SH', name: '中证500', desc: '中盘股，500 只' },
  { kind: 'index', thscode: '000016.SH', name: '上证50', desc: '超大盘，50 只，最快' },
  { kind: 'index', thscode: '399006.SZ', name: '创业板指', desc: '成长风格，100 只' },
  { kind: 'index', thscode: '000688.SH', name: '科创50', desc: '硬科技，50 只' },
  { kind: 'index', thscode: '886042.TI', name: '白酒概念（同花顺）', desc: '行业概念板块' },
  { kind: 'index', thscode: '886041.TI', name: '新能源车（同花顺）', desc: '行业概念板块' },
  { kind: 'all', thscode: null, name: '全部 A 股', desc: '全市场代码表，约 5000+ 只；受 B/C 层调用上限约束，未覆盖的股票会标记为数据不完整' },
];

/** 依据当前日期推导财报期回退链（A 股定期报告披露截止：一季报4/30、中报8/31、三季报10/31、年报次年4/30） */
function reportPeriodChain(now = new Date()) {
  const Y = now.getFullYear(), M = now.getMonth() + 1;
  if (M >= 11) return [`${Y}-3`, `${Y}-2`, `${Y}-1`, `${Y - 1}-4`];
  if (M >= 9) return [`${Y}-2`, `${Y}-1`, `${Y - 1}-4`, `${Y - 1}-3`];
  if (M >= 5) return [`${Y}-1`, `${Y - 1}-4`, `${Y - 1}-3`, `${Y - 1}-2`];
  return [`${Y - 1}-4`, `${Y - 1}-3`, `${Y - 1}-2`, `${Y - 1}-1`];
}

// ---------------- 任务队列（提供真实分阶段进度反馈） ----------------
const jobs = new Map();
function newJob(type) {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, { id, type, status: 'running', logs: [], result: null, error: null, createdAt: Date.now() });
  if (jobs.size > 60) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    jobs.delete(oldest.id);
  }
  return jobs.get(id);
}
function jobLog(job, step, info) {
  job.logs.push({ step, at: Date.now(), ...info });
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
}

// ---------------- HTTP 工具 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function errPayload(e) {
  if (e instanceof fuyao.FuyaoError) return { ok: false, error: e.toJSON() };
  return { ok: false, error: { kind: e.kind || 'internal', message: e.message || String(e) } };
}

// ---------------- 业务处理 ----------------

async function handleParse(body) {
  const text = String(body.text || '').trim();
  if (!text) return { ok: false, error: { kind: 'param', message: '请输入自然语言选股意图' } };
  if (text.length > 600) return { ok: false, error: { kind: 'param', message: '输入过长（上限 600 字），请精简描述' } };
  const cfg = config.get();
  const out = await llm.parseIntent(text, {
    dashscopeKey: cfg.dashscopeApiKey, model: cfg.qwenModel, universeOptions: UNIVERSE_OPTIONS,
  });
  return { ok: true, data: { ...out, reportPeriodChain: reportPeriodChain() } };
}

async function runScreen(body, job) {
  const cfg = config.get();
  const conditions = Array.isArray(body.conditions) ? body.conditions : [];
  if (!conditions.length) throw Object.assign(new Error('没有可执行的筛选条件。请先让 AI 解析或手动添加至少一个条件。'), { kind: 'param' });
  const universe = body.universe && body.universe.thscode ? body.universe : UNIVERSE_OPTIONS[0];
  const known = UNIVERSE_OPTIONS.find((u) => u.thscode === universe.thscode && u.kind === universe.kind);
  const resolved = known || universe;

  const result = await engine.screen({
    apiKey: cfg.fuyaoApiKey,
    conditions,
    universe: resolved,
    reportPeriods: Array.isArray(body.reportPeriods) && body.reportPeriods.length ? body.reportPeriods : reportPeriodChain(),
    limits: {
      stageBCap: Number(body.limits?.stageBCap || 150),
      stageCCap: Number(body.limits?.stageCCap || 80),
      concurrencyC: Number(body.limits?.concurrencyC || 6),
    },
    onProgress: (step, info) => jobLog(job, step, info),
  });

  let diff = null;
  if (body.prev && body.prev.records) {
    try { diff = engine.diffResults(body.prev, result); } catch (e) { diff = { error: e.message }; }
  }
  return { ok: true, data: { result, diff, universe: resolved, reportPeriods: body.reportPeriods || reportPeriodChain() } };
}

async function buildStockDetail(apiKey, thscode, reportPeriods) {
  const [val, px, fin, sectors] = await Promise.all([
    fuyao.getValuationsSnapshot(apiKey, [thscode]).catch((e) => ({ error: e.toJSON ? e.toJSON() : { message: e.message } })),
    fuyao.getPricesSnapshot(apiKey, [thscode]).catch((e) => ({ error: e.toJSON ? e.toJSON() : { message: e.message } })),
    fuyao.getFinancialIndicators(apiKey, thscode, reportPeriods).catch((e) => ({ error: e.toJSON ? e.toJSON() : { message: e.message } })),
    fuyao.getStockSectors(apiKey, [thscode]).catch(() => new Map()),
  ]);
  const end = Date.now(), start = end - 200 * 24 * 3600 * 1000;
  const hist = await fuyao.getHistoricalBatch(apiKey, [thscode], { interval: '1d', start, end }).catch((e) => ({ series: new Map(), errors: [{ error: e.toJSON ? e.toJSON() : { message: e.message } }] }));
  const grp = hist.series.get(thscode);
  const bars = (grp && grp.item) || [];
  const derived = engine.deriveFromBars(bars);
  delete derived._closes;
  return {
    thscode,
    name: (val.items && val.items[0] && val.items[0].name) || null,
    valuation: (val.items && val.items[0]) || null,
    price: (px.items && px.items[0]) || null,
    financials: fin && fin.flat ? { report: fin.report, flat: fin.flat } : null,
    derived,
    barsCount: bars.length,
    barsTail: bars.slice(-70).map((b) => ({ date_ms: b.date_ms, close_price: b.close_price, volume: b.volume })),
    sectors: sectors.get(thscode) || [],
    errors: [val.error, px.error, fin && fin.error, ...(hist.errors || []).map((e) => e.error)].filter(Boolean),
    dataTime: { valuation: val.timestamp, price: px.timestamp, kline: grp ? grp.timestamp : null },
  };
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  try {
    // ---- API ----
    if (p === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        data: {
          keys: config.publicStatus(),
          universes: UNIVERSE_OPTIONS,
          metrics: METRICS,
          reportPeriodChain: reportPeriodChain(),
          fuyaoBaseUrl: fuyao.BASE_URL,
          qwenBaseUrl: llm.DASHSCOPE_BASE,
          serverTime: Date.now(),
        },
      });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.fuyaoApiKey === 'string') patch.fuyaoApiKey = body.fuyaoApiKey.trim();
      if (typeof body.dashscopeApiKey === 'string') patch.dashscopeApiKey = body.dashscopeApiKey.trim();
      if (typeof body.qwenModel === 'string' && body.qwenModel.trim()) patch.qwenModel = body.qwenModel.trim();
      config.save(patch);
      return sendJSON(res, 200, { ok: true, data: config.publicStatus() });
    }

    if (p === '/api/parse' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, await handleParse(body));
    }

    if (p === '/api/screen' && req.method === 'POST') {
      const body = await readBody(req);
      const job = newJob('screen');
      sendJSON(res, 200, { ok: true, data: { jobId: job.id } });
      (async () => {
        try {
          const out = await runScreen(body, job);
          job.result = out.data; job.status = 'done';
        } catch (e) {
          job.status = 'error'; job.error = errPayload(e).error;
          jobLog(job, 'fatal', { message: e.message });
        }
      })();
      return;
    }

    if (p.startsWith('/api/job/') && req.method === 'GET') {
      const job = jobs.get(p.slice('/api/job/'.length));
      if (!job) return sendJSON(res, 404, { ok: false, error: { kind: 'not_found', message: '任务不存在或已过期' } });
      return sendJSON(res, 200, { ok: true, data: job });
    }

    if (p === '/api/stock' && req.method === 'GET') {
      const thscode = u.searchParams.get('thscode');
      if (!thscode) return sendJSON(res, 200, { ok: false, error: { kind: 'param', message: '缺少 thscode' } });
      const cfg = config.get();
      const data = await buildStockDetail(cfg.fuyaoApiKey, thscode.toUpperCase(), reportPeriodChain());
      return sendJSON(res, 200, { ok: true, data });
    }

    if (p === '/api/compare' && req.method === 'POST') {
      const body = await readBody(req);
      const codes = (Array.isArray(body.thscodes) ? body.thscodes : []).map((c) => String(c).toUpperCase()).slice(0, 3);
      if (!codes.length) return sendJSON(res, 200, { ok: false, error: { kind: 'param', message: '请至少选择 1 只股票' } });
      const cfg = config.get();
      const chain = reportPeriodChain();
      const items = await Promise.all(codes.map(async (c) => {
        try { return { thscode: c, ok: true, data: await buildStockDetail(cfg.fuyaoApiKey, c, chain) }; }
        catch (e) { return { thscode: c, ok: false, error: e.toJSON ? e.toJSON() : { message: e.message } }; }
      }));
      return sendJSON(res, 200, { ok: true, data: { items, reportPeriods: chain } });
    }

    if (p === '/api/selftest' && req.method === 'POST') {
      // 数据源连通性自检：真实调用，返回真实结果或真实错误
      const cfg = config.get();
      const out = { fuyao: null, dashscope: null };
      try {
        const v = await fuyao.getValuationsSnapshot(cfg.fuyaoApiKey, ['600519.SH', '000001.SZ']);
        out.fuyao = { ok: true, sample: v.items, timestamp: v.timestamp };
      } catch (e) { out.fuyao = { ok: false, error: e.toJSON ? e.toJSON() : { message: e.message } }; }
      if (cfg.dashscopeApiKey) {
        try {
          const r = await llm.parseIntent('估值合理走势稳定', { dashscopeKey: cfg.dashscopeApiKey, model: cfg.qwenModel, universeOptions: UNIVERSE_OPTIONS });
          out.dashscope = { ok: !r.llmError, engine: r.engine, conditionCount: r.conditions.length, error: r.llmError };
        } catch (e) { out.dashscope = { ok: false, error: { message: e.message } }; }
      } else {
        out.dashscope = { ok: false, error: { kind: 'no_key', message: '未配置 DASHSCOPE_API_KEY，当前使用内置规则解析器兜底' } };
      }
      return sendJSON(res, 200, { ok: true, data: out });
    }

    // ---- 静态资源 ----
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      // SPA 回退
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(fs.readFileSync(idx));
      }
      res.writeHead(404); return res.end('Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
    return res.end(fs.readFileSync(full));
  } catch (e) {
    return sendJSON(res, 200, errPayload(e));
  }
});

server.listen(PORT, HOST, () => {
  // 不打印任何密钥
  console.log(`[知选 AI] listening on http://${HOST}:${PORT}`);
  const st = config.publicStatus();
  console.log(`[知选 AI] 扶摇 Key: ${st.fuyao.configured ? '已配置(' + st.fuyao.source + ')' : '未配置'} | 千问 Key: ${st.dashscope.configured ? '已配置(' + st.dashscope.source + ')' : '未配置(使用内置规则解析)'}`);
});
