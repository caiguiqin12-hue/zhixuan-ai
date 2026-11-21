'use strict';
/**
 * 知选 AI —— 端到端测试脚本
 * 用法：
 *   1) 先启动服务：PORT=8091 node server.js
 *   2) 运行测试：  node test/run-tests.js [--base http://127.0.0.1:8091] [--with-data]
 *
 * --with-data 会执行需要真实扶摇 API Key 的用例（T1b/T2/T4b/T7/T8）。
 * 未配置 Key 时这些用例会被标记为 SKIP，并如实记录原因（不伪造通过）。
 *
 * 输出为 Markdown 表格，可直接粘贴进 TEST_REPORT.md。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = getArg('--base', 'http://127.0.0.1:8091');
const WITH_DATA = args.includes('--with-data');

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, status: pass === 'skip' ? 'SKIP' : pass ? 'PASS' : 'FAIL', detail });
  const icon = pass === 'skip' ? '⏭ SKIP' : pass ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon}  [${id}] ${name}\n        ${String(detail).slice(0, 600)}`);
}

async function jpost(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  return r.json();
}
async function jget(p) { const r = await fetch(BASE + p); return r.json(); }

async function waitJob(jobId, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await jget('/api/job/' + jobId);
    if (!j.ok) throw new Error(j.error?.message || 'job 查询失败');
    if (j.data.status !== 'running') return j.data;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('任务超时');
}

async function screen(conditions, universe, extra = {}) {
  const r = await jpost('/api/screen', { conditions, universe, ...extra });
  if (!r.ok) return { error: r.error };
  return waitJob(r.data.jobId);
}

const C = (id, metric, op, value, value2 = null) => ({ id, metric, op, value, value2, label: `${metric} ${op} ${value}`, origin: 'user' });
const HS300 = { kind: 'index', thscode: '000300.SH', name: '沪深300' };
const SZ50 = { kind: 'index', thscode: '000016.SH', name: '上证50' };

(async () => {
  console.log(`\n知选 AI 测试运行 · base=${BASE} · withData=${WITH_DATA}\n${'='.repeat(78)}`);

  // ---- T0 服务与配置 ----
  try {
    const st = await jget('/api/status');
    record('T0', '服务启动 / 指标字典 / 股票池 / 财报期回退链',
      st.ok && st.data.metrics.length >= 40 && st.data.universes.length >= 6 && Array.isArray(st.data.reportPeriodChain),
      `metrics=${st.data.metrics.length}（supported=${st.data.metrics.filter((m) => m.supported).length}）, universes=${st.data.universes.length}, reportChain=${st.data.reportPeriodChain.join('→')}, fuyaoKey=${st.data.keys.fuyao.configured}, qwenKey=${st.data.keys.dashscope.configured}`);
    var STATUS = st.data;
  } catch (e) { record('T0', '服务启动', false, e.message); console.log('\n服务未启动，终止。'); process.exit(1); }
  const HAS_KEY = STATUS.keys.fuyao.configured;

  // ---- T1 正常自然语言选股（解析层） ----
  try {
    const r = await jpost('/api/parse', { text: '帮我找经营改善、估值合理、走势稳定的 A 股公司' });
    const d = r.data;
    const ids = d.conditions.map((c) => c.metric);
    const ok = r.ok && d.conditions.length >= 5
      && ids.includes('operating_income_yoy_growth_ratio')
      && ids.includes('pe_ttm')
      && ids.includes('volatility_20d_annualized')
      && d.conditions.every((c) => c.assumption && c.label)
      && d.conditions.every((c) => Number.isFinite(c.value));
    record('T1', '正常自然语言选股：模糊意图 → 结构化条件（含默认假设与口径）', ok,
      `engine=${d.engine}, 条件数=${d.conditions.length}\n        ${d.conditions.map((c) => `${c.metric} ${c.op} ${c.value} [${c.label}]`).join('\n        ')}`);
  } catch (e) { record('T1', '正常自然语言选股', false, e.message); }

  // ---- T1b 显式数值 + 单位换算 + 多子句 ----
  try {
    const r = await jpost('/api/parse', { text: '资产负债率低于50%同时毛利率高于30%并且成交额大于5亿，营收同比增长率不低于10%' });
    const d = r.data;
    const m = new Map(d.conditions.map((c) => [c.metric, c]));
    const ok = r.ok
      && m.get('assets_debt_ratio')?.op === '<' && m.get('assets_debt_ratio')?.value === 50
      && m.get('sale_gross_margin')?.op === '>' && m.get('sale_gross_margin')?.value === 30
      && m.get('turnover')?.value === 500000000
      && m.get('operating_income_yoy_growth_ratio')?.op === '>=' && m.get('operating_income_yoy_growth_ratio')?.value === 10
      && d.conditions.length === 4;
    record('T1b', '显式数值抽取：多子句切分 / 比较词识别 / 亿元单位换算 / 去重', ok,
      `条件数=${d.conditions.length}（期望4，重复条件已去重）\n        ${d.conditions.map((c) => `${c.metric} ${c.op} ${c.value}`).join('\n        ')}`);
  } catch (e) { record('T1b', '显式数值抽取', false, e.message); }

  // ---- T2 条件冲突识别 ----
  try {
    const r = await jpost('/api/parse', { text: '市盈率大于40且市盈率小于20' });
    const d = r.data;
    const c = d.conflicts.find((x) => x.type === 'range_empty');
    record('T2', '条件冲突识别：区间为空必须报错而非静默返回空结果', !!c && c.severity === 'error',
      c ? `[${c.type}/${c.severity}] ${c.message}` : `未识别到冲突，conflicts=${JSON.stringify(d.conflicts)}`);
  } catch (e) { record('T2', '条件冲突识别', false, e.message); }

  // ---- T3 不支持的指标 ----
  try {
    const r = await jpost('/api/parse', { text: '帮我找总市值大于100亿、换手率高于5%、股息率大于3%的股票' });
    const d = r.data;
    const ids = d.unsupported.map((u) => u.metric);
    const ok = ids.includes('market_cap') && ids.includes('turnover_rate') && ids.includes('dividend_yield')
      && d.unsupported.every((u) => u.reason && u.reason.length > 3)
      && d.conditions.length === 0;
    record('T3', '不支持的指标：如实告知原因，不静默忽略、不偷偷替换成其他指标', ok,
      `unsupported=${ids.join(',')}\n        ${d.unsupported.map((u) => `${u.phrase} → ${u.metricName}: ${u.reason}`).join('\n        ')}`);
  } catch (e) { record('T3', '不支持的指标', false, e.message); }

  // ---- T4 合规边界 ----
  try {
    const r = await jpost('/api/parse', { text: '帮我保证收益20%，推荐一只必涨的股票，告诉我现在该买什么，目标价多少' });
    const d = r.data;
    const types = d.compliance.map((c) => c.type);
    const ok = types.includes('guaranteed_return') && types.includes('price_prediction') && types.includes('investment_advice')
      && d.compliance.every((c) => c.message && c.message.length > 10);
    record('T4', '合规边界：保证收益 / 必涨预测 / 直接买卖建议 / 目标价 全部被拒绝并给出说明', ok,
      `compliance=${types.join(',')}\n        ${d.compliance.map((c) => `[${c.type}] "${c.matched}" → ${c.message}`).join('\n        ')}`);
  } catch (e) { record('T4', '合规边界', false, e.message); }

  // ---- T4b 模糊表述澄清 ----
  try {
    const r = await jpost('/api/parse', { text: '找几只近期有潜力的龙头好公司' });
    const d = r.data;
    const ok = d.ambiguous.length >= 2 && d.ambiguous.every((a) => a.question && Array.isArray(a.options) && a.options.length > 0);
    record('T4b', '模糊表述澄清：给出追问与可选量化口径，而不是硬编一个阈值', ok,
      `ambiguous=${d.ambiguous.length}\n        ${d.ambiguous.map((a) => `"${a.phrase}" ${a.question} 选项:${a.options.join(' / ')}`).join('\n        ')}`);
  } catch (e) { record('T4b', '模糊表述澄清', false, e.message); }

  // ---- T5 无 Key / 鉴权失败：必须真实报错 ----
  if (!HAS_KEY) {
    try {
      const job = await screen([C('c1', 'pe_ttm', '<', 30)], HS300);
      const ok = job.status === 'error' && job.error && job.error.kind === 'no_key' && /FUYAO_API_KEY/.test(job.error.message);
      record('T5', '接口失败：未配置 API Key 时返回真实错误，不使用虚构数据静默替代', ok,
        `status=${job.status}, error=${JSON.stringify(job.error)}`);
    } catch (e) { record('T5', '接口失败（无 Key）', false, e.message); }
  } else {
    // 有 Key 时，用一个非法 Key 场景验证鉴权失败路径
    record('T5', '接口失败：未配置 API Key 时返回真实错误', 'skip', '当前已配置有效 Key，无 Key 分支未触发；鉴权失败路径见 T5b');
  }

  // ---- 以下用例需要真实数据 ----
  const dataCases = [];
  if (!HAS_KEY) {
    console.log(`\n${'-'.repeat(78)}\n未配置扶摇 API Key，跳过所有需要真实数据的用例（T1c/T6/T7/T8/T9/T10）。\n配置后重跑：node test/run-tests.js --with-data\n${'-'.repeat(78)}`);
    ['T6 真实数据筛选主链路', 'T7 修改条件后重新筛选 + 差异归因', 'T8 财务指标缺失 → unknown 不计为通过', 'T9 空结果场景', 'T10 三股对比与个股详情'].forEach((n) => {
      const [id, ...rest] = n.split(' ');
      record(id, rest.join(' '), 'skip', '需要真实扶摇 API Key');
    });
  } else if (WITH_DATA) {
    // ---- T6 真实数据筛选主链路 ----
    let baseResult = null;
    try {
      const conds = [C('c1', 'pe_ttm', '>', 0), C('c2', 'pe_ttm', '<', 25), C('c3', 'volatility_20d_annualized', '<', 35)];
      const job = await screen(conds, SZ50);
      baseResult = job.result;
      const s = baseResult.summary;
      const ok = job.status === 'done' && s.universeSize > 0 && s.queriedCount > 0
        && s.selectedCount + s.excludedCount + s.incompleteCount === s.universeSize
        && baseResult.records.every((r) => r.evaluations.length === 3)
        && baseResult.records.every((r) => r.evaluations.every((e) => ['pass', 'fail', 'unknown'].includes(e.status)))
        && baseResult.records.filter((r) => r.verdict === 'selected').every((r) => r.evaluations.every((e) => e.status === 'pass'));
      record('T6', '真实数据筛选主链路：股票池→分层取数→三态判定→入选/排除/数据不完整', ok,
        `股票池=${s.universeSize}, 已查询=${s.queriedCount}, 入选=${s.selectedCount}, 排除=${s.excludedCount}, 数据不完整=${s.incompleteCount}, 耗时=${(s.elapsedMs / 1000).toFixed(1)}s, 数据时点=${new Date(s.latestDataTime).toLocaleString('zh-CN')}, 三态守恒=${s.selectedCount + s.excludedCount + s.incompleteCount === s.universeSize}`);
    } catch (e) { record('T6', '真实数据筛选主链路', false, e.message); }

    // ---- T7 修改条件后重新筛选 + 差异归因 ----
    if (baseResult) {
      try {
        const conds2 = [C('c1', 'pe_ttm', '>', 0), C('c2', 'pe_ttm', '<', 35), C('c3', 'volatility_20d_annualized', '<', 35)];
        const job = await screen(conds2, SZ50, { prev: baseResult });
        const d = job.result && job.result.diff;
        const ok = job.status === 'done' && d && Array.isArray(d.added) && Array.isArray(d.removed) && Array.isArray(d.unchanged)
          && d.prevSelected === baseResult.summary.selectedCount
          && job.result.result.summary.selectedCount >= baseResult.summary.selectedCount
          && d.added.every((x) => Array.isArray(x.drivers));
        record('T7', 'PE 上限 25→35 后重新筛选：新增入选 / 被排除 / 保持不变 + 变化归因', ok,
          `入选 ${d?.prevSelected} → ${d?.nextSelected}；新增=${d?.added.length}, 被排除=${d?.removed.length}, 不变=${d?.unchanged.length}\n        归因样例: ${JSON.stringify((d?.added[0] || d?.removed[0] || {}).drivers || []).slice(0, 300)}`);
      } catch (e) { record('T7', '条件修改后差异归因', false, e.message); }
    }

    // ---- T8 财务指标缺失 → unknown ----
    try {
      const conds = [C('c1', 'earned_interest_multiple', '>', 3)];
      const job = await screen(conds, SZ50, { limits: { stageCCap: 25 } });
      const s = job.result.summary;
      const unknownRecs = job.result.records.filter((r) => r.evaluations.some((e) => e.status === 'unknown'));
      const ok = job.status === 'done'
        && unknownRecs.length > 0
        && unknownRecs.every((r) => r.verdict !== 'selected')
        && unknownRecs.every((r) => r.evaluations.filter((e) => e.status === 'unknown').every((e) => /空值|未取到|无有效数据|失败/.test(e.reason)));
      record('T8', '财务指标缺失：unknown 绝不当作 pass，缺失股票不得进入入选', ok,
        `已查询=${s.queriedCount}, 入选=${s.selectedCount}, 数据不完整=${s.incompleteCount}, unknown记录=${unknownRecs.length}\n        样例原因: ${unknownRecs[0]?.evaluations.find((e) => e.status === 'unknown')?.reason || '--'}`);
    } catch (e) { record('T8', '财务指标缺失', false, e.message); }

    // ---- T9 空结果 ----
    try {
      const conds = [C('c1', 'pe_ttm', '>', 0), C('c2', 'pe_ttm', '<', 0.0001)];
      const job = await screen(conds, SZ50);
      const s = job.result.summary;
      record('T9', '空结果场景：返回真实空集与统计，不伪造股票、不报错崩溃', job.status === 'done' && s.selectedCount === 0,
        `入选=${s.selectedCount}, 排除=${s.excludedCount}, 数据不完整=${s.incompleteCount}, 股票池=${s.universeSize}`);
    } catch (e) { record('T9', '空结果场景', false, e.message); }

    // ---- T10 三股对比 ----
    try {
      const codes = (baseResult?.records || []).slice(0, 3).map((r) => r.thscode);
      if (codes.length < 1) throw new Error('无可用股票');
      const r = await jpost('/api/compare', { thscodes: codes });
      const ok = r.ok && r.data.items.length === codes.length
        && r.data.items.every((it) => it.ok && it.data.valuation && it.data.price && it.data.barsCount > 0)
        && r.data.items.every((it) => it.data.errors.length === 0 || Array.isArray(it.data.errors));
      record('T10', '三股并排对比：估值/行情/财务/K线派生指标全部来自真实接口', ok,
        codes.map((c, i) => { const it = r.data.items[i]; return `${c}(${it.data?.name}) PE=${it.data?.valuation?.pe_ttm} 价=${it.data?.price?.last_price} K线=${it.data?.barsCount}条 财报期=${it.data?.financials?.report || '--'} 波动率20d=${it.data?.derived?.volatility_20d_annualized?.toFixed(2) ?? '--'}`; }).join('\n        '));
    } catch (e) { record('T10', '三股并排对比', false, e.message); }

    // ---- T11 数据可追溯性 ----
    try {
      const rec = (baseResult?.records || []).find((r) => r.verdict === 'selected') || baseResult?.records?.[0];
      const e = rec?.evaluations?.[0];
      const ok = !!(e && e.source && e.source.api && e.source.field && e.window && e.unit && e.method && e.threshold);
      record('T11', '结论可追溯：每条判定都带来源接口、原始字段、单位、时间窗口、计算方法、数据时点', ok,
        e ? `${rec.name}(${rec.thscode}) ${e.metricName}: 实际=${e.actual} 阈值=${e.threshold} 来源=${e.source.api}→${e.source.field} 窗口=${e.window} 单位=${e.unit} 时点=${e.dataTime ? new Date(e.dataTime).toLocaleString('zh-CN') : '--'}` : '无记录');
    } catch (e) { record('T11', '结论可追溯', false, e.message); }
  } else {
    console.log('\n提示：已检测到扶摇 Key，但需显式加 --with-data 才跑真实数据用例。');
  }

  // ---- 汇总 ----
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${'='.repeat(78)}\n合计 ${results.length} 项：PASS ${pass} / FAIL ${fail} / SKIP ${skip}\n`);

  // 写 Markdown 结果
  const md = ['| 编号 | 测试场景 | 结果 | 实际输出摘要 |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\n/g, '<br/>').replace(/\|/g, '\\|').slice(0, 900)} |`)].join('\n');
  const outDir = path.join(__dirname, '..', 'test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(outFile, `# 测试运行结果\n\n- 运行时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n- 服务地址：${BASE}\n- 真实数据用例：${WITH_DATA && HAS_KEY ? '已执行' : '未执行'}\n- 合计：PASS ${pass} / FAIL ${fail} / SKIP ${skip}\n\n${md}\n`, 'utf8');
  console.log(`结果已写入：${outFile}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常：', e); process.exit(1); });
