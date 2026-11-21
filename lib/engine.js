'use strict';
/**
 * 确定性筛选引擎
 *
 * 铁律（对应题目要求）：
 *  1. AI 不参与"是否通过"的判断，全部由本文件的确定性规则执行。
 *  2. 三态结果：pass / fail / unknown。数据缺失一律 unknown，绝不当作 pass。
 *  3. 一只股票只有"全部条件 pass"才算入选；存在 unknown 则归入"数据不完整"。
 *  4. 每条判定都记录：实际值、阈值、单位、时间窗口、数据来源接口与字段、
 *     数据时点、财报期、计算方法 —— 保证结论可追溯到原始字段。
 *  5. 分层漏斗：A 批量快照 -> B 批量K线派生 -> C 单股财务指标，
 *     便宜的先淘汰，昂贵的只对幸存者调用，并如实上报每层实际查询数量。
 */

const { getMetric, conditionsMaxStage } = require('./metrics');
const fuyao = require('./fuyao');

const TRADING_DAYS_PER_YEAR = 252;

// ---------------- 派生指标计算（纯函数，可单测） ----------------

function sampleStd(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const varSum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(varSum / (n - 1));
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1], cur = closes[i];
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * 从 K 线序列派生指标
 * @param {Array} bars 升序 K 线 [{date_ms, close_price, ...}]
 */
function deriveFromBars(bars) {
  const out = { trading_days_available: bars.length };
  if (!bars.length) return out;
  const closes = bars.map((b) => b.close_price).filter((v) => typeof v === 'number' && v > 0);
  out._closes = closes;
  out._lastDateMs = bars[bars.length - 1].date_ms;

  const rets = logReturns(closes);
  for (const win of [20, 60]) {
    const slice = rets.slice(-win);
    if (slice.length >= Math.min(win, 15)) {
      const sd = sampleStd(slice);
      if (sd !== null) out[`volatility_${win}d_annualized`] = sd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
    }
  }
  for (const win of [20, 60]) {
    if (closes.length > win) {
      const base = closes[closes.length - 1 - win];
      const last = closes[closes.length - 1];
      if (base > 0) out[`return_${win}d`] = (last / base - 1) * 100;
    }
  }
  // 最大回撤（近 60 个交易日）
  const win60 = closes.slice(-60);
  if (win60.length >= 5) {
    let peak = win60[0], mdd = 0;
    for (const p of win60) {
      if (p > peak) peak = p;
      const dd = peak > 0 ? (1 - p / peak) * 100 : 0;
      if (dd > mdd) mdd = dd;
    }
    out.max_drawdown_60d = mdd;
  }
  return out;
}

// ---------------- 条件求值 ----------------

function compare(actual, op, value, value2) {
  switch (op) {
    case '>': return actual > value;
    case '>=': return actual >= value;
    case '<': return actual < value;
    case '<=': return actual <= value;
    case '==': return Math.abs(actual - value) < 1e-9;
    case 'between': return actual >= Math.min(value, value2) && actual <= Math.max(value, value2);
    default: return null;
  }
}

function formatThreshold(c, metric) {
  const u = metric.unit === '%' ? '%' : (metric.unit === '倍' ? '倍' : (metric.unit === '元(CNY)' ? '元' : ''));
  if (c.op === 'between') return `${c.value}${u} ~ ${c.value2}${u}`;
  return `${c.op} ${c.value}${u}`;
}

/**
 * 对单只股票求值单个条件
 * @returns {{status:'pass'|'fail'|'unknown', actual, ...}}
 */
function evalCondition(cond, stockData) {
  const metric = getMetric(cond.metric);
  if (!metric) {
    return { id: cond.id, metric: cond.metric, metricName: cond.metric, status: 'unknown', reason: '指标不在字典中', actual: null };
  }
  if (!metric.supported) {
    return {
      id: cond.id, metric: metric.id, metricName: metric.name, status: 'unknown',
      reason: `不支持的指标：${metric.unsupportedReason}`, actual: null, unsupported: true,
    };
  }
  const raw = stockData.values ? stockData.values[metric.id] : undefined;
  const base = {
    id: cond.id, metric: metric.id, metricName: metric.name, unit: metric.unit,
    window: metric.window, method: metric.method, op: cond.op,
    threshold: formatThreshold(cond, metric), thresholdValue: cond.value, thresholdValue2: cond.value2 ?? null,
    source: metric.source, assumption: cond.assumption || '', label: cond.label || `${metric.name} ${formatThreshold(cond, metric)}`,
    dataTime: null, reportPeriod: null,
  };

  if (raw === undefined) {
    return { ...base, status: 'unknown', actual: null, reason: `未取到该指标（取数层级 ${metric.stage} 未执行或未覆盖该股票）` };
  }
  if (raw === null || (typeof raw === 'number' && !Number.isFinite(raw))) {
    return {
      ...base, status: 'unknown', actual: null,
      reason: '数据源返回空值（null）。按规则「未知数据不能当作通过」，本条件记为未知，不计入入选。',
      dataTime: stockData.dataTime[metric.stage] || null,
      reportPeriod: metric.stage === 'C' ? (stockData.reportPeriod || null) : null,
    };
  }
  const actual = Number(raw);
  const ok = compare(actual, cond.op, cond.value, cond.value2);
  if (ok === null) return { ...base, status: 'unknown', actual, reason: `不支持的比较运算符 ${cond.op}` };
  return {
    ...base, status: ok ? 'pass' : 'fail', actual,
    reason: ok
      ? `实际 ${round(actual)}${metric.unit === '%' ? '%' : (metric.unit === '倍' ? '倍' : '')} 满足 ${base.threshold}`
      : `实际 ${round(actual)}${metric.unit === '%' ? '%' : (metric.unit === '倍' ? '倍' : '')} 不满足 ${base.threshold}`,
    dataTime: stockData.dataTime[metric.stage] || null,
    reportPeriod: metric.stage === 'C' ? (stockData.reportPeriod || null) : null,
  };
}

function round(v) { return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v; }

// ---------------- 主筛选流程 ----------------

/**
 * @param {object} opts
 *  - apiKey: 扶摇 Key
 *  - conditions: 条件数组
 *  - universe: {kind:'index'|'all', thscode}
 *  - limits: {stageBCap, stageCCap, concurrencyB, concurrencyC}
 *  - reportPeriods: 财报期回退链，如 ['2026-3','2026-2','2026-1','2025-4']
 *  - onProgress: (stage, info) => void
 */
async function screen(opts) {
  const { apiKey, conditions, universe, limits = {}, reportPeriods, onProgress = () => {} } = opts;
  const stageBCap = limits.stageBCap || 120;
  const stageCCap = limits.stageCCap || 80;
  const startedAt = Date.now();
  const trace = { steps: [], errors: [] };
  const log = (step, info) => { trace.steps.push({ step, at: Date.now(), ...info }); onProgress(step, info); };

  const maxStage = conditionsMaxStage(conditions);

  // ---- 0. 股票池 ----
  log('universe', { message: '正在获取股票池…' });
  let pool = [];
  let poolSource = '';
  let poolTimestamp = null;
  if (universe.kind === 'all') {
    const t = await fuyao.getAShareTickerList(apiKey);
    pool = t.items.map((x) => ({ thscode: x.thscode, ticker: x.ticker, name: x.name }));
    poolSource = 'GET /api/meta/tickers/list?asset_type=a-share（全部 A 股代码表）';
    poolTimestamp = t.timestamp;
  } else {
    const c = await fuyao.getConstituents(apiKey, universe.thscode);
    pool = c.items.map((x) => ({ thscode: x.thscode, ticker: x.ticker, name: x.name }));
    poolSource = `GET /api/a-share-index/constituents/ths-stock-list?thscode=${universe.thscode}`;
    poolTimestamp = c.timestamp;
  }
  log('universe_done', { message: `股票池 ${pool.length} 只`, count: pool.length, source: poolSource });
  if (!pool.length) {
    return finalize({ pool: [], records: [], conditions, trace, startedAt, poolSource, poolTimestamp, maxStage, fatal: { kind: 'empty_universe', message: '股票池为空：该指数/板块当前没有返回成分股，或 API Key 无权访问该能力。' } });
  }

  const byCode = new Map(pool.map((p) => [p.thscode, {
    thscode: p.thscode, ticker: p.ticker, name: p.name,
    values: {}, dataTime: {}, reportPeriod: null, fetchErrors: [], missing: [],
    stagesDone: {},
  }]));
  const alive = new Set(pool.map((p) => p.thscode));

  // ---- A. 批量快照 ----
  const stageAMetrics = conditions.filter((c) => { const m = getMetric(c.metric); return m && m.supported && m.stage === 'A'; });
  const needValuation = stageAMetrics.some((c) => ['pe_ttm', 'pe_mrq', 'pb_mrq', 'ps_ttm', 'pcf_ttm'].includes(c.metric));
  const needPrices = stageAMetrics.some((c) => ['last_price', 'price_change_ratio_pct', 'turnover', 'volume'].includes(c.metric));
  // 即使没有 A 层条件，也取行情快照用于列表展示
  const codes = [...alive];

  if (needValuation) {
    log('stageA_valuation', { message: `正在批量获取估值快照（${codes.length} 只，100 只/请求）…` });
    const v = await fuyao.getValuationsSnapshot(apiKey, codes, { concurrency: 4 });
    for (const it of v.items) {
      const rec = byCode.get(it.thscode); if (!rec) continue;
      for (const f of ['pe_ttm', 'pe_mrq', 'pb_mrq', 'ps_ttm', 'pcf_ttm']) rec.values[f] = it[f] === undefined ? null : it[f];
      rec.dataTime.A_valuation = v.timestamp;
      rec.stagesDone.A_valuation = true;
      if (!rec.name && it.name) rec.name = it.name;
    }
    for (const c of codes) { const rec = byCode.get(c); if (rec && !rec.stagesDone.A_valuation) rec.missing.push('估值快照未返回该股票（上游无匹配记录）'); }
    v.errors.forEach((e) => trace.errors.push({ stage: 'A_valuation', ...e }));
    log('stageA_valuation_done', { message: `估值快照完成：返回 ${v.items.length} 条，失败批次 ${v.errors.length}`, returned: v.items.length, failedBatches: v.errors.length });
  }

  log('stageA_prices', { message: `正在批量获取行情快照（${codes.length} 只）…` });
  const p = await fuyao.getPricesSnapshot(apiKey, codes, { concurrency: 4 });
  for (const it of p.items) {
    const rec = byCode.get(it.thscode); if (!rec) continue;
    for (const f of ['last_price', 'price_change_ratio_pct', 'turnover', 'volume', 'open_price', 'high_price', 'low_price', 'prev_price']) rec.values[f] = it[f] === undefined ? null : it[f];
    rec.dataTime.A_price = p.timestamp;
    rec.stagesDone.A_price = true;
  }
  for (const c of codes) { const rec = byCode.get(c); if (rec && !rec.stagesDone.A_price) rec.missing.push('行情快照未返回该股票'); }
  p.errors.forEach((e) => trace.errors.push({ stage: 'A_prices', ...e }));
  log('stageA_prices_done', { message: `行情快照完成：返回 ${p.items.length} 条，失败批次 ${p.errors.length}`, returned: p.items.length, failedBatches: p.errors.length });

  // A 层淘汰
  let aEliminated = 0;
  if (stageAMetrics.length) {
    for (const code of [...alive]) {
      const rec = byCode.get(code);
      const failed = stageAMetrics.some((c) => {
        const v = rec.values[c.metric];
        if (v === null || v === undefined) return false; // 未知不淘汰，留到最后归入"数据不完整"
        return compare(Number(v), c.op, c.value, c.value2) === false;
      });
      if (failed) { alive.delete(code); aEliminated++; }
    }
  }
  log('stageA_filter', { message: `A 层（快照）淘汰 ${aEliminated} 只，剩余 ${alive.size} 只`, eliminated: aEliminated, remaining: alive.size });

  // ---- B. 历史K线派生 ----
  const stageBMetrics = conditions.filter((c) => { const m = getMetric(c.metric); return m && m.supported && m.stage === 'B'; });
  let bQueried = 0, bEliminated = 0;
  if (stageBMetrics.length && (maxStage === 'B' || maxStage === 'C')) {
    let targets = [...alive];
    if (targets.length > stageBCap) {
      log('stageB_cap', { message: `B 层候选 ${targets.length} 只超过上限 ${stageBCap}，按成交额降序取前 ${stageBCap} 只（其余标记为数据不完整）`, capped: true });
      targets.sort((x, y) => (byCode.get(y).values.turnover || 0) - (byCode.get(x).values.turnover || 0));
      const dropped = targets.slice(stageBCap);
      targets = targets.slice(0, stageBCap);
      dropped.forEach((c) => byCode.get(c).missing.push(`超出 B 层调用上限（${stageBCap}），未查询历史K线`));
    }
    const end = Date.now();
    const start = end - 200 * 24 * 3600 * 1000; // 约 200 自然日，足够覆盖 60 个交易日
    log('stageB', { message: `正在批量获取历史K线并计算波动率/区间涨跌/回撤（${targets.length} 只，10 只/请求）…` });
    const h = await fuyao.getHistoricalBatch(apiKey, targets, { interval: '1d', start, end, adjust: 'forward', concurrency: 5 });
    for (const code of targets) {
      const rec = byCode.get(code);
      const grp = h.series.get(code);
      if (!grp || !grp.item || !grp.item.length) { rec.missing.push('历史K线无记录（可能长期停牌或上市不足）'); continue; }
      const d = deriveFromBars(grp.item);
      for (const k of ['volatility_20d_annualized', 'volatility_60d_annualized', 'return_20d', 'return_60d', 'max_drawdown_60d', 'trading_days_available']) {
        rec.values[k] = d[k] === undefined ? null : d[k];
      }
      rec.dataTime.B = grp.timestamp || (d._lastDateMs ?? null);
      rec.stagesDone.B = true;
      rec.barsCount = grp.item.length;
      bQueried++;
    }
    h.errors.forEach((e) => trace.errors.push({ stage: 'B', ...e }));
    for (const code of [...alive]) {
      const rec = byCode.get(code);
      if (!rec.stagesDone.B) continue;
      const failed = stageBMetrics.some((c) => {
        const v = rec.values[c.metric];
        if (v === null || v === undefined) return false;
        return compare(Number(v), c.op, c.value, c.value2) === false;
      });
      if (failed) { alive.delete(code); bEliminated++; }
    }
    log('stageB_done', { message: `B 层完成：成功计算 ${bQueried} 只，淘汰 ${bEliminated} 只，剩余 ${alive.size} 只`, queried: bQueried, eliminated: bEliminated, remaining: alive.size, failedBatches: h.errors.length });
  }

  // ---- C. 单股财务指标 ----
  const stageCMetrics = conditions.filter((c) => { const m = getMetric(c.metric); return m && m.supported && m.stage === 'C'; });
  let cQueried = 0, cFailed = 0, cEliminated = 0;
  if (stageCMetrics.length && maxStage === 'C') {
    let targets = [...alive];
    if (targets.length > stageCCap) {
      log('stageC_cap', { message: `C 层候选 ${targets.length} 只超过上限 ${stageCCap}（财务指标为单股接口，成本高），按成交额降序取前 ${stageCCap} 只，其余标记为数据不完整`, capped: true });
      targets.sort((x, y) => (byCode.get(y).values.turnover || 0) - (byCode.get(x).values.turnover || 0));
      const dropped = targets.slice(stageCCap);
      targets = targets.slice(0, stageCCap);
      dropped.forEach((c) => byCode.get(c).missing.push(`超出 C 层调用上限（${stageCCap}），未查询财务指标`));
    }
    log('stageC', { message: `正在逐股获取财务指标（${targets.length} 只，报告期回退链 ${reportPeriods.join(' → ')}）…` });
    const C_FIELDS = ['operating_income_yoy_growth_ratio', 'net_profit_yoy_growth_ratio', 'operating_profit_yoy_growth_ratio', 'total_assets_growth_ratio', 'index_weighted_avg_roe', 'index_deduct_weighted_avg_roe', 'sale_gross_margin', 'sale_net_interest_ratio', 'total_assets_net_ratio', 'assets_debt_ratio', 'current_ratio', 'quick_ratio', 'cash_ratio', 'earned_interest_multiple', 'total_assets_turnover_ratio', 'inventory_turnover_ratio', 'receive_account_turnover_ratio', 'operating_cash_flow_net_divide_income', 'net_profit_cash_content', 'operating_cash_net_yoy_growth_ratio', 'cash_operating_index'];
    let done = 0;
    const res = await fuyao.mapLimit(targets, limits.concurrencyC || 6, async (code) => {
      const r = await fuyao.getFinancialIndicators(apiKey, code, reportPeriods);
      done++;
      if (done % 10 === 0 || done === targets.length) log('stageC_progress', { message: `财务指标进度 ${done}/${targets.length}`, done, total: targets.length });
      return r;
    });
    res.forEach((r, i) => {
      const code = targets[i];
      const rec = byCode.get(code);
      if (r.status === 'rejected') {
        cFailed++;
        rec.fetchErrors.push({ stage: 'C', error: r.reason instanceof fuyao.FuyaoError ? r.reason.toJSON() : { kind: 'unknown', message: String(r.reason) } });
        rec.missing.push('财务指标接口调用失败');
        return;
      }
      const v = r.value;
      if (!v.report) { cFailed++; rec.missing.push(`财务指标在报告期 ${reportPeriods.join('/')} 均无有效数据`); return; }
      for (const f of C_FIELDS) rec.values[f] = v.flat[f] === undefined ? null : (v.flat[f] === null ? null : Number(v.flat[f]));
      rec.reportPeriod = v.report;
      rec.dataTime.C = v.timestamp || null;
      rec.stagesDone.C = true;
      cQueried++;
    });
    for (const code of [...alive]) {
      const rec = byCode.get(code);
      if (!rec.stagesDone.C) continue;
      const failed = stageCMetrics.some((c) => {
        const v = rec.values[c.metric];
        if (v === null || v === undefined) return false;
        return compare(Number(v), c.op, c.value, c.value2) === false;
      });
      if (failed) { alive.delete(code); cEliminated++; }
    }
    log('stageC_done', { message: `C 层完成：成功取数 ${cQueried} 只，失败 ${cFailed} 只，淘汰 ${cEliminated} 只`, queried: cQueried, failed: cFailed, eliminated: cEliminated });
  }

  // ---- 终判：对全部股票逐条件求值 ----
  const records = pool.map((s) => {
    const rec = byCode.get(s.thscode);
    const evals = conditions.map((c) => evalCondition(c, rec));
    const passCount = evals.filter((e) => e.status === 'pass').length;
    const failCount = evals.filter((e) => e.status === 'fail').length;
    const unknownCount = evals.filter((e) => e.status === 'unknown').length;
    let verdict;
    if (failCount > 0) verdict = 'excluded';
    else if (unknownCount > 0) verdict = 'incomplete';
    else if (conditions.length === 0) verdict = 'incomplete';
    else verdict = 'selected';

    // 排除原因 / 入选原因
    const excludeReasons = evals.filter((e) => e.status === 'fail').map((e) => `${e.metricName}：${e.reason}`);
    const unknownReasons = evals.filter((e) => e.status === 'unknown').map((e) => `${e.metricName}：${e.reason}`);
    const passReasons = evals.filter((e) => e.status === 'pass').map((e) => `${e.metricName}：${e.reason}`);

    return {
      thscode: rec.thscode, ticker: rec.ticker, name: rec.name,
      verdict, passCount, failCount, unknownCount,
      evaluations: evals,
      excludeReasons, unknownReasons, passReasons,
      dataGaps: rec.missing, fetchErrors: rec.fetchErrors,
      reportPeriod: rec.reportPeriod,
      dataTime: rec.dataTime,
      snapshot: {
        last_price: rec.values.last_price ?? null,
        price_change_ratio_pct: rec.values.price_change_ratio_pct ?? null,
        turnover: rec.values.turnover ?? null,
        pe_ttm: rec.values.pe_ttm ?? null,
        pb_mrq: rec.values.pb_mrq ?? null,
        volatility_20d_annualized: rec.values.volatility_20d_annualized ?? null,
        return_60d: rec.values.return_60d ?? null,
      },
      values: rec.values,
      stagesDone: rec.stagesDone,
    };
  });

  return finalize({ pool, records, conditions, trace, startedAt, poolSource, poolTimestamp, maxStage, stageStats: { aEliminated, bQueried, bEliminated, cQueried, cFailed, cEliminated } });
}

function finalize({ pool, records, conditions, trace, startedAt, poolSource, poolTimestamp, maxStage, fatal, stageStats = {} }) {
  const selected = records.filter((r) => r.verdict === 'selected');
  const excluded = records.filter((r) => r.verdict === 'excluded');
  const incomplete = records.filter((r) => r.verdict === 'incomplete');
  // 数据时点
  const times = [];
  records.forEach((r) => Object.values(r.dataTime || {}).forEach((t) => { if (t) times.push(t); }));
  const latestDataTime = times.length ? Math.max(...times) : (poolTimestamp || null);
  const staleDays = latestDataTime ? Math.floor((Date.now() - latestDataTime) / 86400000) : null;

  return {
    fatal: fatal || null,
    summary: {
      universeSize: pool.length,
      queriedCount: records.filter((r) => Object.keys(r.stagesDone || {}).length > 0).length,
      selectedCount: selected.length,
      excludedCount: excluded.length,
      incompleteCount: incomplete.length,
      conditionCount: conditions.length,
      maxStageExecuted: maxStage,
      elapsedMs: Date.now() - startedAt,
      latestDataTime,
      dataStaleDays: staleDays,
      dataStale: staleDays !== null && staleDays > 7,
      ...stageStats,
    },
    poolSource,
    trace,
    records: records.sort((a, b) => {
      const order = { selected: 0, incomplete: 1, excluded: 2 };
      if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
      return (b.snapshot.turnover || 0) - (a.snapshot.turnover || 0);
    }),
  };
}

/**
 * 条件变更后的结果差异（P0-E）
 * 归因：对每只状态变化的股票，找出评估结果发生变化的条件
 */
function diffResults(prev, next) {
  if (!prev || !prev.records) return null;
  const prevMap = new Map(prev.records.map((r) => [r.thscode, r]));
  const nextMap = new Map(next.records.map((r) => [r.thscode, r]));
  const added = [], removed = [], unchanged = [], becameIncomplete = [], becameComplete = [];

  for (const [code, n] of nextMap) {
    const p = prevMap.get(code);
    if (!p) continue;
    if (p.verdict === 'selected' && n.verdict === 'selected') { unchanged.push({ thscode: code, name: n.name }); continue; }
    if (p.verdict !== 'selected' && n.verdict === 'selected') {
      added.push({ thscode: code, name: n.name, drivers: attribute(p, n) });
    } else if (p.verdict === 'selected' && n.verdict !== 'selected') {
      removed.push({ thscode: code, name: n.name, drivers: attribute(p, n), nowVerdict: n.verdict });
    } else if (p.verdict === 'excluded' && n.verdict === 'incomplete') {
      becameIncomplete.push({ thscode: code, name: n.name, drivers: attribute(p, n) });
    } else if (p.verdict === 'incomplete' && n.verdict !== 'incomplete') {
      becameComplete.push({ thscode: code, name: n.name, drivers: attribute(p, n) });
    }
  }
  return {
    added, removed, unchanged, becameIncomplete, becameComplete,
    prevSelected: prev.summary.selectedCount, nextSelected: next.summary.selectedCount,
  };
}

function attribute(prevRec, nextRec) {
  const drivers = [];
  const pm = new Map((prevRec.evaluations || []).map((e) => [e.metric + '|' + e.op + '|' + e.thresholdValue, e]));
  for (const e of (nextRec.evaluations || [])) {
    const key = e.metric + '|' + e.op + '|' + e.thresholdValue;
    const old = pm.get(key);
    if (!old) {
      drivers.push({ kind: 'condition_added', metric: e.metric, metricName: e.metricName, label: e.label, status: e.status, actual: e.actual, threshold: e.threshold });
      continue;
    }
    if (old.status !== e.status) {
      drivers.push({ kind: 'status_changed', metric: e.metric, metricName: e.metricName, label: e.label, from: `${old.threshold} → ${old.status}`, to: `${e.threshold} → ${e.status}`, actual: e.actual, prevActual: old.actual, threshold: e.threshold, prevThreshold: old.threshold });
    }
  }
  for (const [key, old] of pm) {
    const still = (nextRec.evaluations || []).some((e) => (e.metric + '|' + e.op + '|' + e.thresholdValue) === key);
    if (!still) drivers.push({ kind: 'condition_removed', metric: old.metric, metricName: old.metricName, label: old.label, prevStatus: old.status, prevThreshold: old.threshold });
  }
  return drivers;
}

module.exports = { screen, diffResults, deriveFromBars, evalCondition, compare, sampleStd, logReturns, TRADING_DAYS_PER_YEAR };
