/* global React, ReactDOM, htm */
'use strict';
/**
 * 知选 AI 前端 —— React 18 (UMD) + htm，无构建步骤，直接运行。
 * 所有原始财务数据均来自服务端代理的同花顺扶摇接口；前端不做任何数据编造。
 */
const { useState, useEffect, useRef, useMemo, useCallback } = React;
const html = htm.bind(React.createElement);

const LS_STRATEGIES = 'zhixuan.strategies.v1';
const LS_LASTINPUT = 'zhixuan.lastInput.v1';

// ---------------- utils ----------------
const api = {
  async get(p) { const r = await fetch(p); const j = await r.json(); if (!j.ok) throw j.error || new Error('请求失败'); return j.data; },
  async post(p, b) { const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); const j = await r.json(); if (!j.ok) throw j.error || new Error('请求失败'); return j.data; },
};
const fmt = (v, d = 2) => {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '--';
  const n = Number(v);
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(d);
};
const fmtRaw = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(d));
const ts = (ms) => (ms ? new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }) : '--');
const hm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const pctCls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const VERDICT_CN = { selected: '入选', excluded: '排除', incomplete: '数据不完整' };
const ST_CN = { pass: '通过', fail: '失败', unknown: '未知' };

// ---------------- 顶部栏 ----------------
function TopBar({ status, onOpenSettings, onSelfTest, selfTest }) {
  const f = status?.keys?.fuyao, d = status?.keys?.dashscope;
  return html`<div class="topbar">
    <div class="brand">
      <div class="logo">知</div>
      <div>知选 AI<small>自然语言智能选股与策略解释器</small></div>
    </div>
    <div class="spacer"></div>
    <div class="pill" title="扶摇金融数据 API（真实 A 股行情/估值/财务）">
      <i class=${'dot ' + (f?.configured ? 'on' : 'off')}></i>扶摇数据源 ${f?.configured ? '已连接' : '未配置'}
    </div>
    <div class="pill" title="千问大模型负责意图解析；未配置时使用内置中文金融规则解析器兜底">
      <i class=${'dot ' + (d?.configured ? 'on' : 'warn')}></i>意图解析 ${d?.configured ? '千问大模型' : '内置规则(兜底)'}
    </div>
    <button class="btn sm ghost" onClick=${onSelfTest} disabled=${selfTest.running}>
      ${selfTest.running ? html`<span class="spinner"></span>` : '🔌'} 接口自检
    </button>
    <button class="btn sm" onClick=${onOpenSettings}>⚙ 数据源设置</button>
  </div>`;
}

// ---------------- 意图输入 ----------------
const EXAMPLES = [
  '帮我找经营改善、估值合理、走势稳定的 A 股公司',
  '沪深300 里 PE(TTM) 小于 25、营收同比增长率大于 15%、近20日年化波动率小于 30% 的股票',
  '创业板里高成长、低负债、现金流健康的公司',
  '找几只成交活跃、毛利率高于 30%、ROE 大于 12% 的白酒概念股',
  '中证500 中估值偏低且最大回撤小于 20% 的标的',
  '帮我保证收益 20%，推荐一只必涨的股票',
];

function IntentPanel({ text, setText, onParse, parsing, universe, setUniverse, universes, parseInfo }) {
  return html`<div class="card">
    <h3>① 用一句话描述你的选股意图 <span class="tag">AI 只做意图理解与澄清，不产生任何财务数值</span></h3>
    <textarea rows="3" value=${text} placeholder="例如：帮我找经营改善、估值合理、走势稳定的 A 股公司"
      onChange=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onParse(); }}></textarea>
    <div class="chips mt8">
      ${EXAMPLES.map((s, i) => html`<button key=${i} class="chip" onClick=${() => setText(s)} title="点击填入">${s.length > 34 ? s.slice(0, 34) + '…' : s}</button>`)}
    </div>
    <div class="row mt12">
      <label class="fld">股票池
        <select value=${universe.kind + '|' + (universe.thscode || '')}
          onChange=${(e) => { const u = universes.find((x) => x.kind + '|' + (x.thscode || '') === e.target.value); if (u) setUniverse(u); }}>
          ${universes.map((u) => html`<option key=${u.name} value=${u.kind + '|' + (u.thscode || '')}>${u.name}${u.desc ? ' — ' + u.desc : ''}</option>`)}
        </select>
      </label>
      <div class="spacer flex1"></div>
      ${parseInfo ? html`<span class="hint">上次解析引擎：<b class="mono">${parseInfo}</b></span>` : null}
      <button class="btn primary" onClick=${onParse} disabled=${parsing || !text.trim()}>
        ${parsing ? html`<span class="spinner"></span> AI 正在解析…` : '🧠 AI 解析为筛选条件'}
      </button>
    </div>
  </div>`;
}

// ---------------- 合规 / 澄清 / 不支持 ----------------
function NoticePanel({ parsed }) {
  if (!parsed) return null;
  const { compliance = [], ambiguous = [], unsupported = [], conflicts = [] } = parsed;
  if (!compliance.length && !ambiguous.length && !unsupported.length && !conflicts.length) return null;
  return html`<div class="grid sect">
    ${compliance.length ? html`<div class="alert error">
      <b>⚠ 合规边界提示（产品拒绝执行以下诉求）</b>
      <ul>${compliance.map((c, i) => html`<li key=${i}><b>${c.matched}</b> — ${c.message}</li>`)}</ul>
      <div class="mt8 hint">本产品的输出仅为「历史/当前公开数据的条件匹配结果」，不构成投资建议、收益承诺或涨跌预测。</div>
    </div>` : null}

    ${conflicts.length ? html`<div class="alert ${conflicts.some((c) => c.severity === 'error') ? 'error' : 'warn'}>
      <b>⚡ 条件冲突识别</b>
      <ul>${conflicts.map((c, i) => html`<li key=${i}>[${c.type}] ${c.message}</li>')}</ul>
    </div>` : null}

    ${unsupported.length ? html`<div class="alert warn">
      <b>🚫 不支持的指标（已如实告知，未静默忽略、未用其他指标偷偷替代）</b>
      <ul>${unsupported.map((u, i) => html`<li key=${i}>原文「<b>${u.phrase}</b>」→ ${u.metricName}：<span class="mono">${u.reason}</span></li>')}</ul>
    </div>` : null}

    ${ambiguous.length ? html`<div class="alert info">
      <b>❓ 需要你澄清的模糊表述</b>
      <ul>${ambiguous.map((a, i) => html`<li key=${i}>
        「<b>${a.phrase}</b>」${a.question}
        ${a.options?.length ? html`<div class="chips mt8">${a.options.map((o, j) => html`<button key=${j} class="chip sm" title="点击作为新的输入去解析">${o}</button>')}</div>` : null}
      </li>')}</ul>
    </div>` : null}
  </div>`;
}

// ---------------- 条件编辑器 ----------------
function ConditionsEditor({ conditions, setConditions, metrics, conflicts, onAdd, onRun, running, canRun }) {
  const supported = useMemo(() => metrics.filter((m) => m.supported), [metrics]);
  const conflictIds = useMemo(() => new Set((conflicts || []).flatMap((c) => c.ids || [])), [conflicts]);

  const patch = (id, p) => setConditions((cs) => cs.map((c) => (c.id === id ? { ...c, ...p, origin: 'user' } : c)));
  const remove = (id) => setConditions((cs) => cs.filter((c) => c.id !== id));

  return html`<div class="card">
    <h3>② AI 识别出的筛选条件 <span class="tag">全部可修改 / 可删除 / 可新增 —— 由确定性引擎执行，AI 不参与判定</span></h3>
    ${!conditions.length
      ? html`<div class="empty">还没有条件。先在上方输入一句话让 AI 解析，或点击下方「新增条件」手动构建。</div>`
      : html`<div class="cond-grid">
        ${conditions.map((c) => {
          const m = metrics.find((x) => x.id === c.metric) || {};
          return html`<div key=${c.id} class=${'cond' + (conflictIds.has(c.id) ? ' conflict' : '')}>
            <div class="top">
              <span class=${'badge ' + (c.origin === 'user' ? 'user' : 'ai')}>${c.origin === 'user' ? '已手动修改' : 'AI 生成'}</span>
              <span class=${'badge stage' + (m.stage || 'A')}>取数层级 ${m.stage || '?'}</span>
              <span class="name" title=${c.label}>${m.name || c.metric}</span>
              <button class="btn sm ghost danger" title="删除该条件" onClick=${() => remove(c.id)}>✕</button>
            </div>
            <div class="ctrls">
              <select value=${c.metric} onChange=${(e) => patch(c.id, { metric: e.target.value })}>
                ${supported.map((mm) => html`<option key=${mm.id} value=${mm.id}>${mm.name}（${mm.unit}）</option>`)}
              </select>
              <select value=${c.op} onChange=${(e) => patch(c.id, { op: e.target.value })}>
                ${['>', '>=', '<', '<=', '==', 'between'].map((o) => html`<option key=${o} value=${o}>${o}</option>`)}
              </select>
              <input class="num" type="number" step="any" value=${c.value}
                onChange=${(e) => patch(c.id, { value: e.target.value === '' ? '' : Number(e.target.value) })} />
              ${c.op === 'between' ? html`<input class="num" type="number" step="any" placeholder="上限" value=${c.value2 ?? ''}
                onChange=${(e) => patch(c.id, { value2: e.target.value === '' ? '' : Number(e.target.value) })} />` : null}
              <span class="hint">${m.unit}</span>
            </div>
            <div class="meta">
              <div>📐 口径：<b>${m.window}</b></div>
              <div>🧮 计算：${m.method}</div>
              <div>🔗 来源：<code>${m.source ? m.source.api + ' → ' + m.source.field : '--'}</code></div>
              ${c.assumption ? html`<div>💡 默认假设：${c.assumption}</div>` : null}
              ${m.caveat ? html`<div>⚠ 注意：${m.caveat}</div>` : null}
            </div>
          </div>`;
        })}
      </div>`}
    <div class="row mt12">
      <button class="btn sm" onClick=${onAdd}>＋ 新增条件</button>
      <button class="btn sm ghost" onClick=${() => setConditions([])} disabled=${!conditions.length}>清空全部</button>
      <div class="spacer flex1"></div>
      <span class="hint">共 ${conditions.length} 个条件，关系为 <b>AND（全部满足才入选）</b></span>
      <button class="btn primary" onClick=${onRun} disabled=${running || !canRun}>
        ${running ? html`<span class="spinner"></span> 正在用真实数据筛选…` : '▶ 执行真实数据筛选'}
      </button>
    </div>
  </div>`;
}

// ---------------- 进度 ----------------
function ProgressPanel({ job }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [job?.logs?.length]);
  if (!job) return null;
  const last = job.logs?.[job.logs.length - 1];
  return html`<div class="card">
    <h3>③ 取数与筛选进度 <span class="tag">分层漏斗：A 批量快照 → B 批量K线派生 → C 单股财务指标</span></h3>
    <div class="row">
      ${job.status === 'running' ? html`<span class="spinner"></span>` : job.status === 'done' ? html`<span style="color:var(--pass)">✔</span>` : html`<span style="color:var(--fail)">✖</span>`}
      <b>${last?.message || (job.status === 'done' ? '完成' : '启动中…')}</b>
      <div class="spacer flex1"></div>
      <span class="hint mono">job ${job.id} · ${job.logs?.length || 0} 条日志</span>
    </div>
    <div class="log mt8" ref=${ref}>
      ${(job.logs || []).map((l, i) => html`<div key=${i} class=${'l' + (l.step === 'fatal' || l.error ? ' err' : '')}>
        <span class="t">${hm(l.at)}</span><span>[${l.step}] ${l.message || JSON.stringify(l)}</span>
      </div>`)}
    </div>
    ${job.error ? html`<div class="alert error mt8"><b>接口真实错误（未使用任何虚构数据替代）</b><br/>
      kind=<code class="mono">${job.error.kind}</code> ${job.error.code !== undefined ? html`<span>code=<code class="mono">${job.error.code}</code></span>` : null}<br/>${job.error.message}
      ${job.error.request_id ? html`<div class="hint mt8">request_id: <code class="mono">${job.error.request_id}</code>（可用于向数据源排查）</div>` : null}
    </div>` : null}
  </div>`;
}

// ---------------- 汇总 ----------------
function SummaryStats({ result }) {
  if (!result) return null;
  const s = result.summary;
  return html`<div class="card">
    <h3>④ 筛选结果汇总 <span class="tag">数据源：${result.poolSource}</span></h3>
    <div class="stats">
      <div class="stat pool"><div class="k">初始股票池</div><div class="v">${s.universeSize}</div><div class="s">只</div></div>
      <div class="stat"><div class="k">实际完成数据查询</div><div class="v">${s.queriedCount}</div><div class="s">只（至少取到一层数据）</div></div>
      <div class="stat sel"><div class="k">满足全部条件</div><div class="v">${s.selectedCount}</div><div class="s">只 · 全部条件 pass</div></div>
      <div class="stat exc"><div class="k">不满足条件</div><div class="v">${s.excludedCount}</div><div class="s">只 · 至少一条 fail</div></div>
      <div class="stat inc"><div class="k">数据不完整</div><div class="v">${s.incompleteCount}</div><div class="s">只 · 存在 unknown（不计入入选）</div></div>
      <div class="stat"><div class="k">耗时</div><div class="v">${(s.elapsedMs / 1000).toFixed(1)}</div><div class="s">秒</div></div>
    </div>
    <div class="row mt12">
      <span class="pill"><i class=${'dot ' + (s.dataStale ? 'warn' : 'on')}></i>最新数据时点 ${ts(s.latestDataTime)}</span>
      ${s.dataStale ? html`<span class="alert warn" style="padding:4px 10px">⚠ 数据已 ${s.dataStaleDays} 天未更新，可能为停牌、节假日或上游延迟，请谨慎解读</span>` : null}
      ${s.maxStageExecuted ? html`<span class="pill">最深取数层级 ${s.maxStageExecuted}</span>` : null}
      ${s.aEliminated !== undefined ? html`<span class="pill">A层淘汰 ${s.aEliminated}</span>` : null}
      ${s.bQueried ? html`<span class="pill">B层计算 ${s.bQueried}</span>` : null}
      ${s.cQueried ? html`<span class="pill">C层取数 ${s.cQueried}</span>` : null}
      ${s.cFailed ? html`<span class="pill" style="color:#fca5a5">C层失败 ${s.cFailed}</span>` : null}
      ${(result.trace?.errors?.length) ? html`<span class="pill" style="color:#fca5a5">失败批次 ${result.trace.errors.length}</span>` : null}
    </div>
    ${result.fatal ? html`<div class="alert error mt12"><b>${result.fatal.kind}</b>：${result.fatal.message}</div>` : null}
    ${result.trace?.errors?.length ? html`<details class="mt12"><summary class="hint" style="cursor:pointer">查看 ${result.trace.errors.length} 个失败批次详情（真实错误，未静默替代）</summary>
      <div class="log mt8">${result.trace.errors.map((e, i) => html`<div key=${i} class="l err"><span class="t">${e.stage}</span><span>${JSON.stringify(e.error)} · 影响 ${(e.thscodes || []).length} 只</span></div>`)}</div>
    </details>` : null}
  </div>`;
}

// ---------------- 差异 ----------------
function DiffPanel({ diff }) {
  if (!diff) return null;
  const col = (title, arr, cls, render) => html`<div class="diff-col">
    <h4>${title}<span class="n ${cls}">${arr.length}</span></h4>
    ${!arr.length ? html`<div class="hint">无</div>` : arr.slice(0, 40).map((x, i) => html`<div key=${i} class="diff-item">
      <b>${x.name || x.thscode}</b> <span class="code">${x.thscode}</span>
      ${render ? render(x) : null}
    </div>`)}
    ${arr.length > 40 ? html`<div class="hint mt8">仅显示前 40 条，共 ${arr.length} 条</div>` : null}
  </div>`;
  const drv = (x) => (x.drivers || []).length ? html`<div class="drv">${x.drivers.map((d, i) => html`<div key=${i}>
    ${d.kind === 'status_changed' ? html`<span>↳ <b>${d.metricName}</b>：阈值 ${d.prevThreshold} → ${d.threshold}，实际值 ${fmtRaw(d.prevActual, 3)} → ${fmtRaw(d.actual, 3)}，判定 ${d.from.split('→')[1]?.trim()} → ${d.to.split('→')[1]?.trim()}</span>` : null}
    ${d.kind === 'condition_added' ? html`<span>↳ 新增条件 <b>${d.label}</b>（当前 ${ST_CN[d.status]}，实际 ${fmtRaw(d.actual, 3)}）</span>` : null}
    ${d.kind === 'condition_removed' ? html`<span>↳ 删除条件 <b>${d.label}</b>（原判定 ${ST_CN[d.prevStatus]}）</span>` : null}
  </div>`)}</div>` : null;

  return html`<div class="card">
    <h3>⑤ 条件变更前后对比 <span class="tag">上一次入选 ${diff.prevSelected} 只 → 本次入选 ${diff.nextSelected} 只</span></h3>
    <div class="diff-cols">
      ${col('🟢 新增入选', diff.added, '', drv)}
      ${col('🔴 被排除（原入选）', diff.removed, '', (x) => html`<div class="drv">当前状态：${VERDICT_CN[x.nowVerdict]}</div>${drv(x)}`)}
      ${col('⚪ 保持不变（两次都入选）', diff.unchanged, '')}
      ${col('🟡 由排除转为数据不完整', diff.becameIncomplete, '', drv)}
    </div>
    <div class="hint mt8">归因逻辑：逐条件比对同一只股票在两次筛选中的判定状态，只有状态发生变化的条件才会被列为变化原因。</div>
  </div>`;
}

// ---------------- 结果表 ----------------
function StockRow({ r, expanded, onToggle, onCompare, inCompare, conditions }) {
  return html`<React.Fragment key=${r.thscode}>
    <tr class=${r.verdict === 'selected' ? 'sel-row' : ''}>
      <td><button class="btn sm ghost" onClick=${onToggle}>${expanded ? '▾' : '▸'}</button></td>
      <td><b>${r.name || '--'}</b><div class="code">${r.thscode}</div></td>
      <td><span class=${'vbadge v-' + r.verdict}>${VERDICT_CN[r.verdict]}</span></td>
      <td class="num">${fmtRaw(r.snapshot.last_price)}</td>
      <td class=${'num ' + pctCls(r.snapshot.price_change_ratio_pct)}>${r.snapshot.price_change_ratio_pct == null ? '--' : fmtRaw(r.snapshot.price_change_ratio_pct) + '%'}</td>
      <td class="num">${fmtRaw(r.snapshot.pe_ttm)}</td>
      <td class="num">${fmtRaw(r.snapshot.pb_mrq)}</td>
      <td class="num">${r.snapshot.volatility_20d_annualized == null ? '--' : fmtRaw(r.snapshot.volatility_20d_annualized, 1) + '%'}</td>
      <td class="num">${fmt(r.snapshot.turnover)}</td>
      <td>
        <span class="st st-pass">通过 ${r.passCount}</span>
        ${r.failCount ? html` <span class="st st-fail">失败 ${r.failCount}</span>` : null}
        ${r.unknownCount ? html` <span class="st st-unknown">未知 ${r.unknownCount}</span>` : null}
      </td>
      <td><button class="btn sm" disabled=${inCompare} onClick=${() => onCompare(r)}>${inCompare ? '已加入' : '＋对比'}</button></td>
    </tr>
    ${expanded ? html`<tr class="detail"><td colSpan="11"><div class="detail-in">
      <div class="row" style="align-items:flex-start">
        <div class="flex1">
          <h4 style="margin:0 0 8px;font-size:13px">逐条件判定（三态：通过 / 失败 / 未知）</h4>
          <div class="ev-list">
            ${r.evaluations.map((e, i) => html`<div key=${i} class=${'ev ' + e.status}>
              <div class="h">
                <span class=${'st st-' + e.status}>${ST_CN[e.status]}</span>
                <span class="nm">${e.metricName}</span>
                <span class="hint">${e.threshold}</span>
                <span class="av">实际值：<b>${e.actual === null || e.actual === undefined ? '无数据' : fmtRaw(e.actual, 4)}${e.unit === '%' && e.actual != null ? '%' : (e.unit === '倍' && e.actual != null ? '倍' : '')}</b></span>
              </div>
              <div class="b">
                <div>${e.reason}</div>
                <div>📐 时间窗口：<b>${e.window}</b> ｜ 单位：<b>${e.unit}</b></div>
                <div>🔗 数据来源：<code>${e.source ? e.source.api : '--'}</code> → 字段 <code>${e.source ? e.source.field : '--'}</code></div>
                <div>🕒 数据时点：${ts(e.dataTime)}${e.reportPeriod ? html`<span> ｜ 📑 财报期：<b class="mono">${e.reportPeriod}</b></span>` : null}</div>
                <div>🧮 计算方法：${e.method}</div>
                ${e.assumption ? html`<div>💡 条件来源假设：${e.assumption}</div>` : null}
              </div>
            </div>`)}
          </div>
        </div>
        <div style="width:330px;flex:none">
          <h4 style="margin:0 0 8px;font-size:13px">结论摘要</h4>
          ${r.verdict === 'selected' ? html`<div class="alert ok"><b>入选原因</b><ul>${r.passReasons.map((x, i) => html`<li key=${i}>${x}</li>')}</ul></div>` : null}
          ${r.verdict === 'excluded' ? html`<div class="alert error"><b>排除原因</b><ul>${r.excludeReasons.map((x, i) => html`<li key=${i}>${x}</li>')}</ul></div>` : null}
          ${r.verdict === 'incomplete' ? html`<div class="alert warn"><b>数据缺失情况（未知不计为通过）</b><ul>${r.unknownReasons.map((x, i) => html`<li key=${i}>${x}</li>')}</ul></div>` : null}
          ${r.dataGaps?.length ? html`<div class="alert warn mt8"><b>取数缺口</b><ul>${r.dataGaps.map((x, i) => html`<li key=${i}>${x}</li>')}</ul></div>` : null}
          ${r.fetchErrors?.length ? html`<div class="alert error mt8"><b>接口调用失败（真实错误）</b><ul>${r.fetchErrors.map((x, i) => html`<li key=${i}><code>${JSON.stringify(x.error)}</code></li>')}</ul></div>` : null}
          <dl class="kv mt12">
            <dt>财报期</dt><dd>${r.reportPeriod || '--'}</dd>
            <dt>估值时点</dt><dd>${ts(r.dataTime?.A_valuation)}</dd>
            <dt>行情时点</dt><dd>${ts(r.dataTime?.A_price)}</dd>
            <dt>K线时点</dt><dd>${ts(r.dataTime?.B)}</dd>
            <dt>K线条数</dt><dd>${r.barsCount ?? '--'}</dd>
          </dl>
        </div>
      </div>
    </div></td></tr>` : null}
  </React.Fragment>`;
}

function ResultsTable({ result, filter, setFilter, compare, onCompare, query, setQuery }) {
  const [expanded, setExpanded] = useState(null);
  const rows = useMemo(() => {
    let rs = result?.records || [];
    if (filter !== 'all') rs = rs.filter((r) => r.verdict === filter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rs = rs.filter((r) => (r.name || '').toLowerCase().includes(q) || r.thscode.toLowerCase().includes(q) || r.ticker.includes(q));
    }
    return rs;
  }, [result, filter, query]);
  const cmpSet = useMemo(() => new Set(compare.map((c) => c.thscode)), [compare]);

  if (!result) return null;
  return html`<div class="card">
    <h3>⑥ 股票列表与条件命中情况 <span class="tag">点击 ▸ 展开每只股票的完整判定依据与数据口径</span></h3>
    <div class="row" style="margin-bottom:10px">
      <div class="chips">
        ${[['all', '全部 ' + result.records.length], ['selected', '入选 ' + result.summary.selectedCount], ['excluded', '排除 ' + result.summary.excludedCount], ['incomplete', '数据不完整 ' + result.summary.incompleteCount]]
          .map(([k, label]) => html`<button key=${k} class=${'chip' + (filter === k ? ' active' : '')} onClick=${() => setFilter(k)}>${label}</button>`)}
      </div>
      <input placeholder="搜索名称 / 代码" value=${query} onChange=${(e) => setQuery(e.target.value)} style="width:190px" />
      <div class="spacer flex1"></div>
      <span class="hint">显示 ${rows.length} 条</span>
    </div>
    ${!rows.length
      ? html`<div class="empty">
          <b>当前筛选条件下没有匹配的股票。</b><br/>
          这是真实的空结果，不是加载失败。可能原因：阈值过严、条件之间存在冲突、或股票池本身不覆盖该类标的。<br/>
          建议：放宽阈值（例如把 PE 上限从 25 调到 35）、删除部分条件，或切换到更大的股票池后重新筛选。
        </div>`
      : html`<div class="tbl-wrap" style="max-height:620px;overflow-y:auto">
        <table>
          <thead><tr>
            <th></th><th>股票</th><th>判定</th><th class="num">最新价</th><th class="num">涨跌幅</th>
            <th class="num">PE(TTM)</th><th class="num">PB</th><th class="num">20日年化波动率</th><th class="num">成交额</th>
            <th>条件命中</th><th>对比</th>
          </tr></thead>
          <tbody>
            ${rows.slice(0, 300).map((r) => html`<${StockRow} key=${r.thscode} r=${r} expanded=${expanded === r.thscode}
              onToggle=${() => setExpanded(expanded === r.thscode ? null : r.thscode)}
              onCompare=${onCompare} inCompare=${cmpSet.has(r.thscode)} />`)}
          </tbody>
        </table>
        ${rows.length > 300 ? html`<div class="hint" style="padding:9px">仅渲染前 300 条，请用筛选/搜索缩小范围。</div>` : null}
      </div>`}
  </div>`;
}

// ---------------- 对比 ----------------
function CompareModal({ compare, onClose, metrics }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    api.post('/api/compare', { thscodes: compare.map((c) => c.thscode) })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [compare.map((c) => c.thscode).join(',')]);

  const rows = useMemo(() => {
    if (!data) return [];
    const ids = ['last_price', 'price_change_ratio_pct', 'turnover', 'pe_ttm', 'pe_mrq', 'pb_mrq', 'ps_ttm', 'pcf_ttm',
      'volatility_20d_annualized', 'volatility_60d_annualized', 'return_20d', 'return_60d', 'max_drawdown_60d',
      'operating_income_yoy_growth_ratio', 'net_profit_yoy_growth_ratio', 'index_weighted_avg_roe', 'sale_gross_margin',
      'sale_net_interest_ratio', 'assets_debt_ratio', 'current_ratio', 'net_profit_cash_content'];
    return ids.map((id) => ({ id, m: metrics.find((x) => x.id === id) })).filter((x) => x.m);
  }, [data, metrics]);

  const valOf = (item, id) => {
    if (!item?.ok) return null;
    const d = item.data;
    if (d.derived && d.derived[id] !== undefined) return d.derived[id];
    if (d.valuation && d.valuation[id] !== undefined) return d.valuation[id];
    if (d.price && d.price[id] !== undefined) return d.price[id];
    if (d.financials?.flat && d.financials.flat[id] !== undefined) return d.financials.flat[id] === null ? null : Number(d.financials.flat[id]);
    return null;
  };

  return html`<div class="mask" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal">
      <h2>三股并排对比 <span class="hint">最多 3 只 · 全部为扶摇真实数据</span>
        <button class="btn sm ghost x" onClick=${onClose}>✕ 关闭</button></h2>
      ${loading ? html`<div class="empty"><span class="spinner"></span> 正在逐股拉取估值 / 行情 / 财务指标 / K线派生指标…</div>` : null}
      ${err ? html`<div class="alert error"><b>对比数据获取失败（真实错误）</b><br/>kind=<code>${err.kind}</code> ${err.message}</div>` : null}
      ${data ? html`<div>
        ${data.items.some((i) => !i.ok) ? html`<div class="alert error"><b>部分股票取数失败</b>
          <ul>${data.items.filter((i) => !i.ok).map((i, k) => html`<li key=${k}><code>${i.thscode}</code>：${JSON.stringify(i.error)}</li>`)}</ul></div>` : null}
        <div class="tbl-wrap mt12"><table>
          <thead><tr><th>指标</th><th>单位</th>${data.items.map((it, i) => html`<th key=${i} class="num">${compare[i]?.name || it.thscode}<div class="code">${it.thscode}</div></th>`)}</tr></thead>
          <tbody>
            <tr><td colspan=${2 + data.items.length} class="hint" style="background:var(--panel-2)">财报期：${data.items.map((it) => (it.ok ? (it.data.financials?.report || '--') : '--')).join(' / ')} ｜ K线条数：${data.items.map((it) => (it.ok ? it.data.barsCount : '--')).join(' / ')}</td></tr>
            ${rows.map(({ id, m }) => html`<tr key=${id}>
              <td title=${m.method}>${m.name}<div class="hint">${m.window}</div></td>
              <td class="hint">${m.unit}</td>
              ${data.items.map((it, i) => { const v = valOf(it, id); return html`<td key=${i} class="num">${v === null || v === undefined ? html`<span class="st st-unknown">无数据</span>` : fmtRaw(v, 3)}</td>`; })}
            </tr>`)}
            <tr><td><b>所属板块</b></td><td class="hint">-</td>
              ${data.items.map((it, i) => html`<td key=${i} style="font-size:11.5px">${it.ok ? (it.data.sectors || []).map((s) => s.name).join('、') || '--' : '--'}</td>`)}
            </tr>
          </tbody>
        </table></div>
        <div class="cmp-sec">
          <h5>近 70 个交易日收盘价走势（前复权）</h5>
          <${SparkCompare} items=${data.items} />
        </div>
        <div class="alert info mt12">对比仅呈现历史与当前的客观数据差异，<b>不构成任何买卖建议、涨跌预测或收益承诺</b>。数据缺失项已标注为「无数据」，未做任何插值或估算。</div>
      </div>` : null}
    </div>
  </div>`;
}

function SparkCompare({ items }) {
  const series = items.filter((i) => i.ok && i.data.barsTail?.length).map((i) => i.data.barsTail);
  if (!series.length) return html`<div class="hint">无可用 K 线数据</div>`;
  const W = 900, H = 170, PAD = 8;
  const all = series.flat().map((b) => b.close_price);
  const min = Math.min(...all), max = Math.max(...all);
  const norm = (s) => {
    const base = s[0].close_price;
    return s.map((b, i) => {
      const x = PAD + (i / Math.max(1, s.length - 1)) * (W - PAD * 2);
      const v = (b.close_price / base - 1) * 100;
      return [x, v];
    });
  };
  const vs = series.flatMap((s) => norm(s).map((p) => p[1]));
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const y = (v) => H - PAD - ((v - vmin) / Math.max(1e-9, vmax - vmin)) * (H - PAD * 2);
  const colors = ['#60a5fa', '#f0b429', '#22c55e'];
  return html`<div>
    <svg viewBox=${'0 0 ' + W + ' ' + H} style="width:100%;height:190px;background:var(--bg-2);border:1px solid var(--line);border-radius:6px">
      <line x1=${PAD} y1=${y(0)} x2=${W - PAD} y2=${y(0)} stroke="#2c3d5c" stroke-dasharray="3 3" />
      ${series.map((s, i) => {
        const pts = norm(s).map(([x, v]) => x.toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
        return html`<polyline key=${i} points=${pts} fill="none" stroke=${colors[i % 3]} stroke-width="1.6" />`;
      })}
    </svg>
    <div class="row mt8">${items.filter((i) => i.ok).map((it, i) => {
      const t = it.data.barsTail || [];
      const base = t[0]?.close_price, last = t[t.length - 1]?.close_price;
      const chg = base ? (last / base - 1) * 100 : null;
      return html`<span key=${i} class="pill"><i class="dot" style=${{ background: colors[i % 3] }}></i>${it.data.name || it.thscode}
        <b class=${pctCls(chg)} style="margin-left:5px">${chg === null ? '--' : (chg > 0 ? '+' : '') + chg.toFixed(2) + '%'}</b></span>`;
    })}</div>
    <div class="hint mt8">纵轴为相对区间首个交易日收盘价的涨跌幅（%），横轴为最近 ${Math.max(...series.map((s) => s.length))} 个交易日。历史走势不代表未来表现。</div>
  </div>`;
}

// ---------------- 策略保存 ----------------
function StrategyPanel({ conditions, universe, text, onLoad, notify }) {
  const [list, setList] = useState([]);
  const [name, setName] = useState('');
  useEffect(() => {
    try { setList(JSON.parse(localStorage.getItem(LS_STRATEGIES) || '[]')); } catch { setList([]); }
  }, []);
  const persist = (next) => { setList(next); localStorage.setItem(LS_STRATEGIES, JSON.stringify(next)); };
  const save = () => {
    const n = (name || '').trim() || `策略 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    if (!conditions.length) return notify('当前没有条件，无法保存', 'warn');
    persist([{ id: Date.now(), name: n, text, universe, conditions, savedAt: Date.now() }, ...list].slice(0, 50));
    setName(''); notify(`已保存策略「${n}」到本浏览器 localStorage`, 'ok');
  };
  const del = (id) => persist(list.filter((s) => s.id !== id));
  return html`<div class="card">
    <h3>⑧ 策略保存与重新加载 <span class="tag">存储范围：仅当前浏览器 localStorage，不上传服务器、不跨设备同步</span></h3>
    <div class="row">
      <input placeholder="策略名称（留空自动用时间戳）" value=${name} onChange=${(e) => setName(e.target.value)} style="width:250px" />
      <button class="btn" onClick=${save} disabled=${!conditions.length}>💾 保存当前条件为策略</button>
      <div class="spacer flex1"></div>
      <span class="hint">已保存 ${list.length} 个</span>
    </div>
    ${list.length ? html`<div class="tbl-wrap mt12"><table>
      <thead><tr><th>策略名</th><th>股票池</th><th class="num">条件数</th><th>保存时间</th><th>条件摘要</th><th></th></tr></thead>
      <tbody>${list.map((s) => html`<tr key=${s.id}>
        <td><b>${s.name}</b></td>
        <td class="hint">${s.universe?.name || '--'}</td>
        <td class="num">${s.conditions?.length || 0}</td>
        <td class="hint">${ts(s.savedAt)}</td>
        <td class="hint" style="max-width:420px">${(s.conditions || []).map((c) => c.label || `${c.metric} ${c.op} ${c.value}`).join(' 且 ')}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" onClick=${() => { onLoad(s); notify(`已加载策略「${s.name}」`, 'ok'); }}>加载</button>
          <button class="btn sm ghost danger" onClick=${() => del(s.id)}>删除</button>
        </td>
      </tr>`)}</tbody>
    </table></div>` : html`<div class="hint mt12">还没有保存任何策略。</div>`}
    <div class="alert info mt12" style="font-size:12px">
      <b>存储范围说明：</b>策略（条件 + 股票池 + 原始输入）保存在<b浏览器 <code class="mono">localStorage['${LS_STRATEGIES}']</code>，最多 50 条。
      清除浏览器数据或使用无痕模式会导致策略丢失；不同设备/浏览器之间不会同步。<b>API Key 不会写入 localStorage</b>，只保存在服务端。
    </div>
  </div>`;
}

// ---------------- 设置 ----------------
function SettingsModal({ status, onClose, onSaved, notify }) {
  const [fuyao, setFuyao] = useState('');
  const [dash, setDash] = useState('');
  const [model, setModel] = useState(status?.keys?.qwenModel || 'qwen-plus');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const patch = { qwenModel: model };
      if (fuyao.trim()) patch.fuyaoApiKey = fuyao.trim();
      if (dash.trim()) patch.dashscopeApiKey = dash.trim();
      const st = await api.post('/api/config', patch);
      onSaved(st); notify('密钥已保存到服务端（不会返回前端、不写入日志与代码仓库）', 'ok');
      setFuyao(''); setDash('');
    } catch (e) { notify('保存失败：' + e.message, 'err'); }
    finally { setBusy(false); }
  };
  return html`<div class="mask" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal" style="max-width:720px">
      <h2>⚙ 数据源设置 <button class="btn sm ghost x" onClick=${onClose}>✕</button></h2>
      <div class="alert info" style="font-size:12.5px">
        密钥仅保存在<b服务端进程的 <code class="mono">data/config.json</code>（已 .gitignore）或环境变量中。
        前端只收到掩码状态，<b>不会</b>把 Key 写进浏览器代码、日志或代码仓库。
      </div>
      <div class="grid mt12" style="gap:12px">
        <label class="fld">扶摇金融数据 API Key（FUYAO_API_KEY）
          <input type="password" placeholder=${status?.keys?.fuyao?.configured ? '已配置 ' + status.keys.fuyao.masked + '（留空则不修改）' : '粘贴你的 X-api-key'} value=${fuyao} onChange=${(e) => setFuyao(e.target.value)} />
          <span class="hint">获取方式：用同花顺账号登录 <a href="https://fuyao.aicubes.cn/admin/" target="_blank" rel="noreferrer">https://fuyao.aicubes.cn/admin/</a> → 创建 API Key。当前状态：
            <b style=${{ color: status?.keys?.fuyao?.configured ? 'var(--pass)' : 'var(--fail)' }}>${status?.keys?.fuyao?.configured ? '已配置（来源 ' + status.keys.fuyao.source + '）' : '未配置'}</b></span>
        </label>
        <label class="fld">千问大模型 API Key（DASHSCOPE_API_KEY，可选）
          <input type="password" placeholder=${status?.keys?.dashscope?.configured ? '已配置 ' + status.keys.dashscope.masked + '（留空则不修改）' : '粘贴 sk-... （留空则使用内置规则解析器）'} value=${dash} onChange=${(e) => setDash(e.target.value)} />
          <span class="hint">获取方式：<a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">阿里云百炼控制台</a> → API-KEY。未配置时产品仍可运行，意图解析改用内置中文金融规则解析器（页面会标明本次使用的引擎）。</span>
        </label>
        <label class="fld">千问模型名
          <select value=${model} onChange=${(e) => setModel(e.target.value)}>
            ${['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'].map((m) => html`<option key=${m} value=${m}>${m}</option>`)}
          </select>
        </label>
      </div>
      <div class="row mt16">
        <button class="btn primary" onClick=${save} disabled=${busy}>${busy ? html`<span class="spinner"></span>` : null} 保存</button>
        <button class="btn ghost" onClick=${onClose}>关闭</button>
      </div>
    </div>
  </div>`;
}

// ---------------- 主应用 ----------------
function App() {
  const [status, setStatus] = useState(null);
  const [bootErr, setBootErr] = useState(null);
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [conditions, setConditions] = useState([]);
  const [universe, setUniverse] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState(null);
  const [result, setResult] = useState(null);
  const [prevResult, setPrevResult] = useState(null);
  const [diff, setDiff] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [compare, setCompare] = useState([]);
  const [showCompare, setShowCompare] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState(null);
  const [selfTest, setSelfTest] = useState({ running: false, data: null });
  const [limits, setLimits] = useState({ stageBCap: 150, stageCCap: 80 });
  const pollRef = useRef(null);

  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 4200);
  }, []);

  // 启动加载
  useEffect(() => {
    api.get('/api/status').then((d) => {
      setStatus(d);
      setUniverse(d.universes[0]);
      try { const last = localStorage.getItem(LS_LASTINPUT); if (last) setText(last); } catch {}
    }).catch((e) => setBootErr(e));
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  const metrics = status?.metrics || [];
  const universes = status?.universes || [];

  const onParse = async () => {
    setParsing(true); setParsed(null);
    try { localStorage.setItem(LS_LASTINPUT, text); } catch {}
    try {
      const d = await api.post('/api/parse', { text });
      setParsed(d);
      setConditions(d.conditions || []);
      setConflicts(d.conflicts || []);
      if (d.universe) {
        const u = universes.find((x) => x.thscode === d.universe.thscode) || d.universe;
        setUniverse(u);
      }
      if (d.llmError) notify('千问大模型调用失败（' + d.llmError.kind + '）：' + d.llmError.message + ' —— 已自动回退到内置规则解析器', 'warn');
      else notify(`解析完成，引擎：${d.engine}，生成 ${(d.conditions || []).length} 个条件`, 'ok');
    } catch (e) { notify('解析失败：' + (e.message || JSON.stringify(e)), 'err'); setParsed({ error: e }); }
    finally { setParsing(false); }
  };

  const pollJob = (jobId) => {
    const tick = async () => {
      try {
        const j = await api.get('/api/job/' + jobId);
        setJob({ ...j });
        if (j.status === 'running') { pollRef.current = setTimeout(tick, 700); return; }
        setRunning(false);
        if (j.status === 'done' && j.result) {
          setResult(j.result.result);
          setDiff(j.result.diff || null);
          setFilter('all');
          if (j.result.result?.fatal) notify(j.result.result.fatal.message, 'err');
          else notify(`筛选完成：入选 ${j.result.result.summary.selectedCount} 只 / 排除 ${j.result.result.summary.excludedCount} 只 / 数据不完整 ${j.result.result.summary.incompleteCount} 只`, 'ok');
        } else {
          notify('筛选失败：' + (j.error?.message || '未知错误'), 'err');
        }
      } catch (e) {
        setRunning(false);
        notify('任务状态查询失败：' + e.message, 'err');
      }
    };
    tick();
  };

  const onRun = async () => {
    if (!conditions.length) return notify('没有可执行的条件', 'warn');
    if (!status?.keys?.fuyao?.configured) {
      setShowSettings(true);
      return notify('尚未配置扶摇 API Key，无法获取真实数据。产品拒绝使用模拟数据充当真实股票数据。', 'err');
    }
    setRunning(true); setJob(null);
    try {
      const d = await api.post('/api/screen', { conditions, universe, limits, prev: result || null });
      if (result) setPrevResult(result);
      pollJob(d.jobId);
    } catch (e) {
      setRunning(false);
      notify('筛选启动失败：' + (e.message || JSON.stringify(e)), 'err');
    }
  };

  const onAddCondition = () => {
    const id = 'c' + (conditions.length + 1) + '_' + Date.now().toString(36);
    setConditions([...conditions, { id, metric: 'pe_ttm', op: '<', value: 30, value2: null, origin: 'user', label: '市盈率 PE(TTM) < 30倍', assumption: '手动新增的条件。', confidence: 1 }]);
  };

  const onCompare = (r) => {
    if (compare.length >= 3) return notify('最多并排对比 3 只股票', 'warn');
    setCompare([...compare, { thscode: r.thscode, name: r.name }]);
  };

  const runSelfTest = async () => {
    setSelfTest({ running: true, data: null });
    try { const d = await api.post('/api/selftest', {}); setSelfTest({ running: false, data: d }); }
    catch (e) { setSelfTest({ running: false, data: { error: e } }); }
  };

  const loadStrategy = (s) => {
    setConditions(s.conditions || []);
    setText(s.text || '');
    const u = universes.find((x) => x.thscode === s.universe?.thscode && x.kind === s.universe?.kind);
    if (u) setUniverse(u);
    setParsed(null); setDiff(null);
  };

  if (bootErr) return html`<div class="app"><div class="alert error">初始化失败：${bootErr.message || JSON.stringify(bootErr)}</div></div>`;
  if (!status) return html`<div class="app"><div class="empty"><span class="spinner"></span> 正在加载工作台配置…</div></div>`;

  return html`<div class="app">
    <${TopBar} status=${status} onOpenSettings=${() => setShowSettings(true)} onSelfTest=${runSelfTest} selfTest=${selfTest} />

    ${toast ? html`<div class=${'alert ' + (toast.kind === 'err' ? 'error' : toast.kind === 'warn' ? 'warn' : toast.kind === 'ok' ? 'ok' : 'info')} style="position:fixed;top:64px;right:20px;z-index:200;max-width:460px">${toast.msg}</div>` : null}

    ${!status.keys.fuyao.configured ? html`<div class="alert error" style="margin-bottom:14px">
      <b>⛔ 未配置扶摇 API Key —— 无法获取真实 A 股数据。</b><br/>
      本产品明确禁止用模拟数据充当真实股票数据，因此在配置密钥前筛选功能不可用。<br/>
      需要你配置的密钥名称：<code class="mono">FUYAO_API_KEY</code>（请求头 <code class="mono">X-api-key</code>）。
      获取地址：<a href="https://fuyao.aicubes.cn/admin/" target="_blank" rel="noreferrer">https://fuyao.aicubes.cn/admin/</a>（同花顺账号登录 → 创建 API Key）。
      <div class="mt8"><button class="btn primary sm" onClick=${() => setShowSettings(true)}>立即配置</button></div>
    </div>` : null}

    <${IntentPanel} text=${text} setText=${setText} onParse=${onParse} parsing=${parsing}
      universe=${universe || universes[0]} setUniverse=${setUniverse} universes=${universes}
      parseInfo=${parsed?.engine} />

    ${selfTest.data ? html`<div class="card sect">
      <h3>接口自检结果 <span class="tag">真实调用，非模拟</span></h3>
      ${selfTest.data.error ? html`<div class="alert error">${JSON.stringify(selfTest.data.error)}</div>` : html`<div class="grid" style="gap:8px">
        ${selfTest.data.fuyao?.ok
          ? html`<div class="alert ok"><b>扶摇数据源 ✔</b> 样本：${(selfTest.data.fuyao.sample || []).map((s) => `${s.name || s.thscode} PE(TTM)=${s.pe_ttm ?? 'null'} PB=${s.pb_mrq ?? 'null'}`).join(' ｜ ')}<div class="hint mt8">数据时点 ${ts(selfTest.data.fuyao.timestamp)}</div></div>`
          : html`<div class="alert error"><b>扶摇数据源 ✖</b> <code>${JSON.stringify(selfTest.data.fuyao?.error)}</code></div>`}
        ${selfTest.data.dashscope?.ok
          ? html`<div class="alert ok"><b>千问大模型 ✔</b> 引擎 ${selfTest.data.dashscope.engine}，测试语句解析出 ${selfTest.data.dashscope.conditionCount} 个条件</div>`
          : html`<div class="alert warn"><b>千问大模型 ✖</b> <code>${JSON.stringify(selfTest.data.dashscope?.error)}</code><div class="hint mt8">不影响主链路：意图解析会自动使用内置规则解析器。</div></div>`}
      </div>`}
    </div>` : null}

    <${NoticePanel} parsed=${parsed} />

    <div class="sect">
      <${ConditionsEditor} conditions=${conditions} setConditions=${setConditions} metrics=${metrics}
        conflicts=${parsed?.conflicts || conflicts} onAdd=${onAddCondition} onRun=${onRun} running=${running}
        canRun=${!!conditions.length && status.keys.fuyao.configured} />
    </div>

    <div class="sect">
      <div class="card">
        <h3>取数上限（控制接口调用成本） <span class="tag">超出上限的股票会被如实标记为「数据不完整」，不会假装通过</span></h3>
        <div class="row">
          <label class="fld">B 层（历史K线，10只/请求）最多查询
            <input class="num" type="number" min="0" max="500" value=${limits.stageBCap} onChange=${(e) => setLimits({ ...limits, stageBCap: Number(e.target.value) })} /></label>
          <label class="fld">C 层（财务指标，1只/请求）最多查询
            <input class="num" type="number" min="0" max="300" value=${limits.stageCCap} onChange=${(e) => setLimits({ ...limits, stageCCap: Number(e.target.value) })} /></label>
          <span class="hint">财报期回退链：<code class="mono">${(status.reportPeriodChain || []).join(' → ')}</code></span>
        </div>
      </div>
    </div>

    ${job ? html`<div class="sect"><${ProgressPanel} job=${job} /></div>` : null}
    ${result ? html`<div class="sect"><${SummaryStats} result=${result} /></div>` : null}
    ${diff ? html`<div class="sect"><${DiffPanel} diff=${diff} /></div>` : null}
    ${result ? html`<div class="sect"><${ResultsTable} result=${result} filter=${filter} setFilter=${setFilter}
      compare=${compare} onCompare=${onCompare} query=${query} setQuery=${setQuery} /></div>` : null}

    <div class="sect">
      <${StrategyPanel} conditions=${conditions} universe=${universe} text=${text} onLoad=${loadStrategy} notify=${notify} />
    </div>

    <div class="foot">
      <b>职责边界</b>：AI（千问大模型 / 内置规则解析器）只负责理解意图、澄清模糊表述与生成解释文本，<b>不产生任何原始财务数据，也不判断个股是否通过筛选</b>；
      筛选判定完全由确定性规则引擎执行，输入为同花顺扶摇 API 返回的真实字段。<br/>
      <b>三态判定</b>：每个条件对每只股票只有 通过 / 失败 / 未知 三种状态；数据缺失一律记为「未知」，<b>未知不等于通过</b>，因此存在未知的股票归入「数据不完整」而非「入选」。<br/>
      <b>失败处理</b>：接口超时、鉴权失败、上游不可用等情况会把真实错误码与 request_id 展示给用户，不使用虚构数据静默替代。<br/>
      <b>合规声明</b>：本产品不提供确定性涨跌预测、收益承诺或直接买卖建议；所有阈值均为可修改的默认假设，不构成投资判断依据。投资有风险，决策需自主。<br/>
      <b>数据来源</b>：同花顺扶摇金融数据 API（<code class="mono">${status.fuyaoBaseUrl}</code>）｜ <b>意图解析</b>：<code class="mono">${status.qwenBaseUrl}</code>
    </div>

    ${compare.length ? html`<div class="tray">
      <b style="font-size:12.5px">对比栏（${compare.length}/3）</b>
      ${[0, 1, 2].map((i) => compare[i]
        ? html`<div key=${i} class="slot filled">${compare[i].name || compare[i].thscode}<span onClick=${() => setCompare(compare.filter((_, k) => k !== i))}>✕</span></div>`
        : html`<div key=${i} class="slot">空位 ${i + 1}</div>`)}
      <button class="btn primary sm" disabled=${compare.length < 1} onClick=${() => setShowCompare(true)}>并排对比</button>
      <button class="btn sm ghost" onClick=${() => setCompare([])}>清空</button>
      <div class="spacer flex1"></div>
      <button class="btn sm" onClick=${onRun} disabled=${running}>↻ 用当前条件再次筛选</button>
    </div>` : null}

    ${showCompare && compare.length ? html`<${CompareModal} compare=${compare} onClose=${() => setShowCompare(false)} metrics=${metrics} />` : null}
    ${showSettings ? html`<${SettingsModal} status=${status} onClose=${() => setShowSettings(false)} notify=${notify}
      onSaved=${(st) => setStatus({ ...status, keys: st })} />` : null}
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
