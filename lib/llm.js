'use strict';
/**
 * 自然语言 -> 结构化筛选条件
 *
 * 职责边界（严格遵守题目要求）：
 *   AI 只负责「理解意图 / 澄清 / 解释」，输出可被人检查修改的条件 JSON。
 *   AI 不产生任何财务数值，不判断某只股票是否通过。
 *   是否通过由 lib/engine.js 的确定性规则引擎基于扶摇真实数据决定。
 *
 * 两条通路：
 *   1) 千问大模型（DashScope OpenAI 兼容模式），需要 DASHSCOPE_API_KEY
 *   2) 内置中文金融规则解析器（无 Key 时兜底，保证主链路可跑；
 *      配置 Key 后自动优先走大模型，并在 UI 标明本次使用的解析引擎）
 */

const { METRICS, getMetric } = require('./metrics');

const DASHSCOPE_BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen-plus';

// ---------------------------------------------------------------------------
// 指标别名词典（规则解析器与大模型 prompt 共用）
// ---------------------------------------------------------------------------
const ALIASES = {
  pe_ttm: ['pe', 'pe(ttm)', '市盈率', '市盈率ttm', 'pe ttm', '市盈'],
  pe_mrq: ['pe(mrq)', '市盈率mrq', '静态市盈率'],
  pb_mrq: ['pb', '市净率', 'pb(mrq)', '市净'],
  ps_ttm: ['ps', '市销率', '市销'],
  pcf_ttm: ['pcf', '市现率', '市现'],
  last_price: ['股价', '最新价', '价格', '收盘价'],
  price_change_ratio_pct: ['涨跌幅', '当日涨跌幅', '涨幅', '跌幅', '今日涨幅'],
  turnover: ['成交额', '成交金额'],
  volume: ['成交量'],
  volatility_20d_annualized: ['波动率', '年化波动率', '20日波动率', '近20日波动率', '波动'],
  volatility_60d_annualized: ['60日波动率', '近60日波动率'],
  return_20d: ['20日涨幅', '近20日涨跌幅', '月涨幅', '近一个月涨幅'],
  return_60d: ['60日涨幅', '近60日涨跌幅', '季涨幅', '近三个月涨幅'],
  max_drawdown_60d: ['最大回撤', '回撤', '60日最大回撤'],
  operating_income_yoy_growth_ratio: ['营收同比增长率', '营业收入同比增长率', '营收增速', '收入增长率', '营收增长', '营业收入增长'],
  net_profit_yoy_growth_ratio: ['净利润同比增长率', '净利增速', '净利润增长', '利润增长率'],
  operating_profit_yoy_growth_ratio: ['营业利润同比增长率', '营业利润增速'],
  total_assets_growth_ratio: ['总资产增长率', '总资产增速'],
  index_weighted_avg_roe: ['roe', '净资产收益率', '加权roe', '净资产回报率'],
  index_deduct_weighted_avg_roe: ['扣非roe', '扣非加权净资产收益率'],
  sale_gross_margin: ['毛利率', '销售毛利率'],
  sale_net_interest_ratio: ['净利率', '销售净利率'],
  total_assets_net_ratio: ['roa', '总资产收益率'],
  assets_debt_ratio: ['资产负债率', '负债率', '杠杆率'],
  current_ratio: ['流动比率'],
  quick_ratio: ['速动比率'],
  cash_ratio: ['现金比率'],
  earned_interest_multiple: ['已获利息倍数', '利息保障倍数'],
  total_assets_turnover_ratio: ['总资产周转率'],
  inventory_turnover_ratio: ['存货周转率'],
  receive_account_turnover_ratio: ['应收账款周转率'],
  operating_cash_flow_net_divide_income: ['销售现金比率', '经营现金流比率'],
  net_profit_cash_content: ['净利润现金含量', '现金含量'],
  operating_cash_net_yoy_growth_ratio: ['现金流量净额增长率', '现金流增长率'],
  cash_operating_index: ['现金营运指数'],
  market_cap: ['总市值', '市值', '流通市值', '大盘股', '小盘股', '中盘股'],
  turnover_rate: ['换手率'],
  dividend_yield: ['股息率', '分红率'],
  industry: ['行业', '板块', '概念'],
  future_price: ['目标价', '预测股价', '会涨到'],
  guaranteed_return: ['保证收益', '保底收益', '稳赚', '必涨', '一定涨', '无风险收益'],
};

const UNSUPPORTED_PHRASES = [
  { re: /(保证|保底|承诺|确保).{0,6}(收益|盈利|赚钱|不亏)/, metric: 'guaranteed_return', compliance: true },
  { re: /(必涨|一定涨|稳涨|铁定涨|肯定会涨|只涨不跌)/, metric: 'future_price', compliance: true },
  { re: /(稳赚|无风险|零风险|包赚)/, metric: 'guaranteed_return', compliance: true },
  { re: /(推荐|告诉我).{0,6}(买哪|买什么|该买|现在买)/, metric: 'guaranteed_return', compliance: true },
  { re: /(内幕|小道消息|庄家|操纵)/, metric: 'guaranteed_return', compliance: true },
  { re: /(目标价|预测.{0,4}股价|能涨到|会跌到)/, metric: 'future_price', compliance: false },
  { re: /(换手率)/, metric: 'turnover_rate', compliance: false },
  { re: /(股息率|分红率)/, metric: 'dividend_yield', compliance: false },
  { re: /(总市值|流通市值|市值)/, metric: 'market_cap', compliance: false },
];

// 语义短语 -> 条件模板（"经营改善/估值合理/走势稳定"这类模糊表达）
const SEMANTIC_RULES = [
  {
    re: /(经营改善|业绩改善|基本面改善|经营向好|业绩向好|基本面好转)/,
    phrase: '经营改善',
    conditions: [
      { metric: 'operating_income_yoy_growth_ratio', op: '>', value: 10, assumption: '把「经营改善」默认解释为营业收入同比增长率 > 10%（默认假设，非投资判断，可修改）' },
      { metric: 'net_profit_yoy_growth_ratio', op: '>', value: 0, assumption: '把「经营改善」默认解释为净利润同比增长率 > 0%（即未同比下滑）' },
    ],
  },
  {
    re: /(高成长|成长性|高速成长|成长股|增长快|高增长)/,
    phrase: '高成长',
    conditions: [
      { metric: 'operating_income_yoy_growth_ratio', op: '>', value: 20, assumption: '把「高成长」默认解释为营收同比增长率 > 20%' },
      { metric: 'net_profit_yoy_growth_ratio', op: '>', value: 20, assumption: '把「高成长」默认解释为净利润同比增长率 > 20%' },
    ],
  },
  {
    re: /(估值合理|估值不高|估值偏低|低估|便宜|性价比|合理估值)/,
    phrase: '估值合理',
    conditions: [
      { metric: 'pe_ttm', op: '>', value: 0, assumption: '把「估值合理」默认解释为 PE(TTM) > 0（排除亏损导致的负市盈率）' },
      { metric: 'pe_ttm', op: '<', value: 30, assumption: '把「估值合理」默认解释为 PE(TTM) < 30 倍（默认阈值，可修改）' },
      { metric: 'pb_mrq', op: '>', value: 0, assumption: '把「估值合理」默认解释为 PB(MRQ) > 0（排除净资产为负）' },
    ],
  },
  {
    re: /(走势稳定|走势稳健|波动小|低波动|稳健|平稳|抗跌|回撤小)/,
    phrase: '走势稳定',
    conditions: [
      { metric: 'volatility_20d_annualized', op: '<', value: 35, assumption: '把「走势稳定」默认解释为近 20 个交易日年化波动率 < 35%（默认阈值，可修改）' },
      { metric: 'max_drawdown_60d', op: '<', value: 25, assumption: '把「走势稳定」默认解释为近 60 个交易日最大回撤 < 25%' },
    ],
  },
  {
    re: /(盈利能力强|赚钱能力强|高质量|优质|高roe|高 roe|回报率好)/i,
    phrase: '盈利能力强',
    conditions: [
      { metric: 'index_weighted_avg_roe', op: '>', value: 10, assumption: '把「盈利能力强」默认解释为加权 ROE > 10%' },
      { metric: 'sale_net_interest_ratio', op: '>', value: 5, assumption: '把「盈利能力强」默认解释为销售净利率 > 5%' },
    ],
  },
  {
    re: /(财务稳健|负债低|低负债|低杠杆|偿债能力强|财务安全)/,
    phrase: '财务稳健',
    conditions: [
      { metric: 'assets_debt_ratio', op: '<', value: 60, assumption: '把「财务稳健」默认解释为资产负债率 < 60%' },
      { metric: 'current_ratio', op: '>', value: 1, assumption: '把「财务稳健」默认解释为流动比率 > 1 倍' },
    ],
  },
  {
    re: /(现金流好|现金流健康|现金流充裕|回款好)/,
    phrase: '现金流健康',
    conditions: [
      { metric: 'net_profit_cash_content', op: '>', value: 0.8, assumption: '把「现金流健康」默认解释为净利润现金含量 > 0.8 倍' },
      { metric: 'operating_cash_flow_net_divide_income', op: '>', value: 0, assumption: '把「现金流健康」默认解释为销售现金比率 > 0' },
    ],
  },
  {
    re: /(成交活跃|流动性好|流动性充足|活跃股|热门)/,
    phrase: '成交活跃',
    conditions: [
      { metric: 'turnover', op: '>', value: 200000000, assumption: '把「成交活跃」默认解释为当日成交额 > 2 亿元（默认阈值，可修改）' },
    ],
  },
  {
    re: /(毛利率高|高毛利)/,
    phrase: '毛利率高',
    conditions: [{ metric: 'sale_gross_margin', op: '>', value: 30, assumption: '把「毛利率高」默认解释为销售毛利率 > 30%' }],
  },
];

// 显式数值表达： "PE小于25" / "市盈率低于30倍" / "ROE大于15%" / "波动率不超过35%"
const CMP_WORDS = [
  { re: /(大于等于|不低于|至少|>=|≥)/, op: '>=' },
  { re: /(小于等于|不超过|不高于|至多|<=|≤)/, op: '<=' },
  { re: /(大于|高于|超过|多于|>|＞)/, op: '>' },
  { re: /(小于|低于|少于|不足|<|＜)/, op: '<' },
  { re: /(等于|=|＝)/, op: '==' },
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/，/g, ',').replace(/。/g, '.');
}

function findMetricByText(text) {
  const n = normalize(text);
  let best = null;
  for (const m of METRICS) {
    const list = ALIASES[m.id] || [];
    for (const a of list) {
      const na = normalize(a);
      if (na && n.includes(na)) {
        if (!best || na.length > best.len) best = { metric: m, len: na.length };
      }
    }
  }
  return best ? best.metric : null;
}

/** 解析显式数值条件 */
function parseExplicitNumeric(text) {
  const out = [];
  const n = String(text || '');
  // 逐个子句切分，避免跨子句误匹配。
  // 注意：不能把「并且/同时」拆成单字放进字符类，否则「营收同比增长率」里的「同」会被当成分隔符。
  const clauses = n
    .split(/(?:并且|同时|以及|而且|另外|此外)|[，,；;。.\n、和且]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const metric = findMetricByText(clause);
    if (!metric) continue;
    let op = null;
    for (const c of CMP_WORDS) { if (c.re.test(clause)) { op = c.op; break; } }
    const numMatch = clause.match(/(-?\d+(?:\.\d+)?)/);
    if (!op || !numMatch) continue;
    let value = Number(numMatch[1]);
    // 单位归一：成交额「亿/万」
    if (metric.id === 'turnover' || metric.id === 'volume') {
      if (/亿/.test(clause)) value *= 1e8;
      else if (/万/.test(clause)) value *= 1e4;
    }
    out.push({
      metric: metric.id, op, value,
      label: `${metric.name} ${op} ${numMatch[1]}${/亿/.test(clause) && metric.id === 'turnover' ? '亿' : (/万/.test(clause) && metric.id === 'turnover' ? '万' : '')}${metric.unit === '%' ? '%' : (metric.unit === '倍' ? '倍' : '')}`,
      assumption: `从原文「${clause.trim()}」直接抽取的显式数值条件。`,
      sourcePhrase: clause.trim(),
      confidence: 0.95,
    });
  }
  return out;
}

/** 股票池识别 */
function parseUniverse(text) {
  const n = String(text || '');
  const table = [
    { re: /(沪深300|沪深 300|hs300)/i, kind: 'index', thscode: '000300.SH', name: '沪深300' },
    { re: /(中证500|中证 500)/i, kind: 'index', thscode: '000905.SH', name: '中证500' },
    { re: /(上证50|上证 50)/i, kind: 'index', thscode: '000016.SH', name: '上证50' },
    { re: /(创业板指|创业板)/, kind: 'index', thscode: '399006.SZ', name: '创业板指' },
    { re: /(科创50|科创 50)/i, kind: 'index', thscode: '000688.SH', name: '科创50' },
    { re: /(白酒)/, kind: 'index', thscode: '886042.TI', name: '白酒概念（同花顺）' },
    { re: /(新能源车|新能源汽车)/, kind: 'index', thscode: '886041.TI', name: '新能源车（同花顺）' },
    { re: /(全部a股|全a股|全市场|所有a股|a股全市场)/i, kind: 'all', thscode: null, name: '全部 A 股（受调用上限约束）' },
  ];
  for (const t of table) if (t.re.test(n)) return { ...t, matched: true };
  return { kind: 'index', thscode: '000300.SH', name: '沪深300', matched: false, assumption: '未识别到明确股票池，默认使用沪深300成分股（可在页面上切换）。' };
}

/** 合规边界识别 */
function detectCompliance(text) {
  const flags = [];
  const n = String(text || '');
  const rules = [
    { re: /(保证|保底|承诺|确保).{0,8}(收益|盈利|赚钱|不亏|回本)/, type: 'guaranteed_return' },
    { re: /(稳赚|包赚|无风险|零风险)/, type: 'guaranteed_return' },
    { re: /(必涨|一定涨|稳涨|铁定涨|肯定会涨|只涨不跌|涨停板保证)/, type: 'price_prediction' },
    { re: /(推荐|告诉我|帮我).{0,8}(买哪|买什么|该买|现在买|买入|加仓|满仓)/, type: 'investment_advice' },
    { re: /(内幕|小道消息|庄家|操盘|操纵股价)/, type: 'market_manipulation' },
    { re: /(目标价|能涨到|会涨到|会跌到|预测.{0,6}(股价|点位))/, type: 'price_prediction' },
    { re: /(翻倍|十倍股|百倍)/, type: 'guaranteed_return' },
  ];
  for (const r of rules) {
    const m = n.match(r.re);
    if (m) flags.push({ type: r.type, matched: m[0] });
  }
  // 去重
  const seen = new Set();
  return flags.filter((f) => (seen.has(f.type) ? false : (seen.add(f.type), true)));
}

const COMPLIANCE_MESSAGES = {
  guaranteed_return: '本产品不提供任何保证收益、保本或稳赚的判断。任何筛选结果都只是对历史/当前公开数据的条件匹配，不构成收益承诺。',
  price_prediction: '本产品不输出确定性涨跌预测或目标价。可以为你计算历史波动率、历史区间涨跌幅、最大回撤等已发生的事实指标，但历史表现不代表未来。',
  investment_advice: '本产品不提供直接买卖建议。可以帮你把意图转成可检查的数据条件，并展示每只股票为何满足/不满足这些条件，最终决策需由你自行判断并自担风险。',
  market_manipulation: '本产品不提供内幕信息、庄家动向或任何可能涉及市场操纵的内容。',
};

/** 内置规则解析器（无大模型 Key 时的兜底通路） */
function ruleParse(text) {
  const conditions = [];
  const unsupported = [];
  const compliance = [];
  const consumed = [];

  // 1. 合规边界
  for (const f of detectCompliance(text)) {
    compliance.push({ type: f.type, matched: f.matched, message: COMPLIANCE_MESSAGES[f.type] });
  }

  // 2. 不支持的指标（如实告知）
  for (const p of UNSUPPORTED_PHRASES) {
    const m = String(text || '').match(p.re);
    if (m) {
      const met = getMetric(p.metric);
      unsupported.push({
        phrase: m[0], metric: p.metric, metricName: met ? met.name : p.metric,
        reason: met && met.unsupportedReason ? met.unsupportedReason : '当前数据源未提供该字段',
        compliance: !!p.compliance,
      });
    }
  }

  // 3. 显式数值条件
  for (const c of parseExplicitNumeric(text)) {
    const met = getMetric(c.metric);
    if (!met || !met.supported) {
      unsupported.push({ phrase: c.sourcePhrase, metric: c.metric, metricName: met ? met.name : c.metric, reason: met ? met.unsupportedReason : '未知指标', compliance: false });
      continue;
    }
    conditions.push({ ...c, origin: 'ai' });
    consumed.push(c.sourcePhrase);
  }

  // 4. 语义短语条件
  for (const rule of SEMANTIC_RULES) {
    const m = String(text || '').match(rule.re);
    if (!m) continue;
    for (const t of rule.conditions) {
      const met = getMetric(t.metric);
      if (!met || !met.supported) continue;
      conditions.push({
        metric: t.metric, op: t.op, value: t.value,
        label: `${met.name} ${t.op} ${t.value}${met.unit === '%' ? '%' : (met.unit === '倍' ? '倍' : '')}`,
        assumption: t.assumption, sourcePhrase: m[0], confidence: 0.7, origin: 'ai',
      });
    }
    consumed.push(m[0]);
  }

  // 5. 模糊/无法解析
  const ambiguous = [];
  const VAGUE = [
    { re: /(有潜力|潜力股|前景好|前景广阔)/, q: '「有潜力」不是可量化口径。你希望用哪个可测指标近似？', options: ['营收同比增长率 > 20%', '净利润同比增长率 > 20%', '加权 ROE > 15%'] },
    { re: /(龙头|白马|蓝筹)/, q: '「龙头/白马/蓝筹」缺少统一可测定义。可用以下代理指标，请选择：', options: ['当日成交额 > 10 亿元（流动性代理）', 'PE(TTM) 在 0~25 倍且加权 ROE > 12%', '沪深300 成分股 + 资产负债率 < 60%'] },
    { re: /(最近|近期|这段时间)/, q: '「近期」需要明确时间窗口。', options: ['近 20 个交易日', '近 60 个交易日', '最近一个已披露报告期'] },
    { re: /(好公司|优质公司|不错的)/, q: '「好公司」不是数据口径。请指定可测维度：', options: ['盈利能力（ROE、净利率）', '成长能力（营收/净利同比）', '财务稳健（资产负债率、流动比率）'] },
  ];
  for (const v of VAGUE) {
    const m = String(text || '').match(v.re);
    if (m) ambiguous.push({ phrase: m[0], question: v.q, options: v.options });
  }
  if (!conditions.length && !compliance.length && !unsupported.length) {
    ambiguous.push({
      phrase: String(text || '').slice(0, 40),
      question: '没有从这句话中识别出可量化的筛选条件。请补充指标与阈值，例如「PE(TTM) 小于 25 且营收同比增长率大于 15%」。',
      options: ['经营改善、估值合理、走势稳定', '高成长 + 低负债', '低波动 + 高 ROE'],
    });
  }

  return { conditions: dedupeConditions(conditions), unsupported: dedupeUnsupported(unsupported), ambiguous, compliance };
}

/** 条件冲突识别（确定性规则，不依赖 AI） */
function detectConflicts(conditions) {
  const conflicts = [];
  const byMetric = new Map();
  conditions.forEach((c, i) => {
    const key = c.metric;
    if (!byMetric.has(key)) byMetric.set(key, []);
    byMetric.get(key).push({ ...c, _idx: i });
  });
  for (const [metric, list] of byMetric) {
    const met = getMetric(metric);
    const name = met ? met.name : metric;
    let lower = null; // >= / >
    let upper = null; // <= / <
    for (const c of list) {
      if (c.op === '>' || c.op === '>=') {
        if (!lower || c.value > lower.value || (c.value === lower.value && c.op === '>')) lower = c;
      } else if (c.op === '<' || c.op === '<=') {
        if (!upper || c.value < upper.value || (c.value === upper.value && c.op === '<')) upper = c;
      } else if (c.op === '==' && list.length > 1) {
        conflicts.push({
          type: 'redundant', metric, metricName: name, ids: list.map((x) => x.id),
          message: `对「${name}」同时存在等值条件与其他范围条件，可能导致结果恒为空，请确认。`,
        });
      }
    }
    if (lower && upper) {
      const empty = lower.value > upper.value || (lower.value === upper.value && (lower.op === '>' || upper.op === '<'));
      if (empty) {
        conflicts.push({
          type: 'range_empty', metric, metricName: name, ids: [lower.id, upper.id],
          message: `「${name}」的取值区间为空：要求 ${lower.op} ${lower.value} 且 ${upper.op} ${upper.value}，任何股票都不可能同时满足，筛选结果必然为 0。请修改其中一个阈值。`,
          severity: 'error',
        });
      } else if (lower.value === upper.value) {
        conflicts.push({
          type: 'range_tight', metric, metricName: name, ids: [lower.id, upper.id],
          message: `「${name}」被约束为恰好等于 ${lower.value}，命中概率极低，建议放宽区间。`,
          severity: 'warn',
        });
      }
    }
    // 重复条件
    const dup = new Map();
    list.forEach((c) => {
      const k = `${c.op}:${c.value}`;
      if (dup.has(k)) conflicts.push({ type: 'duplicate', metric, metricName: name, ids: [dup.get(k), c.id], message: `「${name} ${c.op} ${c.value}」重复出现，已保留一条即可。`, severity: 'warn' });
      else dup.set(k, c.id);
    });
  }
  // PE 语义冲突：要求 PE < 0 通常意味着用户想找亏损股，与"估值合理"矛盾
  const pe = conditions.filter((c) => c.metric === 'pe_ttm');
  if (pe.some((c) => (c.op === '<' || c.op === '<=') && c.value <= 0)) {
    conflicts.push({ type: 'semantic', metric: 'pe_ttm', metricName: '市盈率 PE(TTM)', ids: pe.map((c) => c.id), message: 'PE(TTM) 上限被设为 0 或负数。负 PE 通常代表公司亏损，这与「估值合理」的常见含义相反，请确认你的真实意图。', severity: 'warn' });
  }
  return conflicts;
}

function assignIds(conditions) {
  return conditions.map((c, i) => ({
    ...c,
    id: c.id || `c${i + 1}`,
    value2: c.op === 'between' ? (c.value2 ?? null) : null,
    origin: c.origin || 'ai',
    confidence: typeof c.confidence === 'number' ? c.confidence : 0.7,
    label: c.label || '',
    assumption: c.assumption || '',
    sourcePhrase: c.sourcePhrase || '',
  }));
}

/** 去重：不支持指标按 metric 去重；合规类短语已由合规面板呈现，不再重复计入 */
function dedupeUnsupported(list) {
  const seen = new Set();
  const out = [];
  for (const u of list || []) {
    if (u.compliance) continue;
    if (seen.has(u.metric)) continue;
    seen.add(u.metric);
    out.push(u);
  }
  return out;
}

/** 条件去重：同一 metric+op+value(+value2) 只保留一条，避免显式数值与语义规则重复产出 */
function dedupeConditions(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const k = `${c.metric}|${c.op}|${c.value}|${c.value2 ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** 校验并规整大模型返回的条件（防止 AI 编造指标） */
function sanitizeModelOutput(raw, originalText) {
  const conditions = [];
  const unsupported = [];
  for (const c of (Array.isArray(raw.conditions) ? raw.conditions : [])) {
    const met = getMetric(c.metric);
    if (!met) {
      unsupported.push({ phrase: c.label || c.metric, metric: c.metric || 'unknown', metricName: c.metric || '未知指标', reason: '该指标不在知选 AI 的指标字典中，无法取数，已拒绝执行。', compliance: false });
      continue;
    }
    if (!met.supported) {
      unsupported.push({ phrase: c.label || met.name, metric: met.id, metricName: met.name, reason: met.unsupportedReason, compliance: false });
      continue;
    }
    if (!['>', '>=', '<', '<=', '==', 'between'].includes(c.op)) continue;
    const value = Number(c.value);
    if (!Number.isFinite(value)) continue;
    conditions.push({
      metric: met.id, op: c.op, value,
      value2: c.op === 'between' ? Number(c.value2) : null,
      label: c.label || `${met.name} ${c.op} ${value}${met.unit === '%' ? '%' : (met.unit === '倍' ? '倍' : '')}`,
      assumption: c.assumption || '由大模型从你的表述中推断的默认阈值，可修改。',
      sourcePhrase: c.sourcePhrase || '',
      confidence: typeof c.confidence === 'number' ? c.confidence : 0.7,
      origin: 'ai',
    });
  }
  for (const u of (Array.isArray(raw.unsupported) ? raw.unsupported : [])) {
    const met = getMetric(u.metric);
    unsupported.push({ phrase: u.phrase || '', metric: u.metric || 'unknown', metricName: met ? met.name : (u.metric || '未知指标'), reason: u.reason || (met && met.unsupportedReason) || '数据源未提供该字段', compliance: !!u.compliance });
  }
  const ambiguous = (Array.isArray(raw.ambiguous) ? raw.ambiguous : []).map((a) => ({ phrase: a.phrase || '', question: a.question || '', options: Array.isArray(a.options) ? a.options.slice(0, 4) : [] }));
  const compliance = detectCompliance(originalText).map((f) => ({ ...f, message: COMPLIANCE_MESSAGES[f.type] }));
  const universe = raw.universe && raw.universe.thscode ? { kind: 'index', thscode: raw.universe.thscode, name: raw.universe.name || raw.universe.thscode, matched: true } : parseUniverse(originalText);
  return { conditions: assignIds(conditions), unsupported, ambiguous, compliance, universe, notes: raw.notes || '' };
}

function buildPrompt(text, universeOptions) {
  const dict = METRICS.filter((m) => m.supported).map((m) => `- ${m.id} | ${m.name} | 单位:${m.unit} | 窗口:${m.window} | 取数层级:${m.stage}`).join('\n');
  const unsup = METRICS.filter((m) => !m.supported).map((m) => `- ${m.id} | ${m.name} | 原因:${m.unsupportedReason}`).join('\n');
  return [
    {
      role: 'system',
      content: `你是「知选 AI」的意图解析器。你的唯一任务是把用户的中文选股意图转换成结构化筛选条件 JSON。

严格约束：
1. 你只能使用下面【可用指标字典】中的 metric id。绝对不允许发明指标、不允许编造任何财务数值或股票数据。
2. 你不判断任何具体股票是否通过筛选，那由确定性引擎基于真实数据完成。
3. 用户表述模糊时，你必须给出一个明确的默认阈值，并在 assumption 字段用一句话说明这是"默认假设、可修改、非投资判断"。
4. 用户提到【不支持指标】里的内容时，放进 unsupported 数组并说明原因，不要偷偷转成别的指标。
5. 用户要求保证收益、预测必涨、给出买卖建议、目标价时，不要配合；把可量化的部分正常转成条件，其余放入 ambiguous 并在 notes 中说明产品不提供收益承诺与涨跌预测。
6. 只输出 JSON，不要输出 markdown 代码块以外的任何解释文字。

【可用指标字典】
${dict}

【不支持指标】
${unsup}

【可选股票池】
${universeOptions.map((u) => `- ${u.thscode || 'all'} | ${u.name}`).join('\n')}

输出 JSON schema：
{
  "conditions": [{"metric":"pe_ttm","op":"<","value":30,"label":"市盈率 PE(TTM) < 30倍","assumption":"...","sourcePhrase":"估值合理","confidence":0.8}],
  "unsupported": [{"phrase":"市值大于100亿","metric":"market_cap","reason":"..."}],
  "ambiguous": [{"phrase":"...","question":"...","options":["...","..."]}],
  "universe": {"thscode":"000300.SH","name":"沪深300"},
  "notes": "一句话说明本次解析的关键默认假设"
}
op 只能取: > >= < <= == between（between 需同时给 value 与 value2）`,
    },
    { role: 'user', content: String(text || '') },
  ];
}

/** 调用千问大模型 */
async function callQwen(apiKey, text, universeOptions, { model } = {}) {
  const url = `${DASHSCOPE_BASE}/chat/completions`;
  const body = {
    model: model || QWEN_MODEL,
    messages: buildPrompt(text, universeOptions),
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const kind = e && e.name === 'AbortError' ? 'timeout' : 'network';
    throw Object.assign(new Error(kind === 'timeout' ? '调用千问大模型超时（>45s）' : `无法连接千问大模型：${e.message}`), { kind });
  }
  clearTimeout(timer);
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 400);
    try { const j = JSON.parse(raw); detail = (j.error && (j.error.message || j.error.code)) || detail; } catch {}
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    throw Object.assign(new Error(`千问大模型返回 HTTP ${res.status}：${detail}`), { kind, status: res.status });
  }
  let json;
  try { json = JSON.parse(raw); } catch (e) { throw Object.assign(new Error('千问大模型返回内容无法解析为 JSON'), { kind: 'parse' }); }
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw Object.assign(new Error('千问大模型返回空内容'), { kind: 'empty' });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw Object.assign(new Error('千问大模型未返回合法 JSON'), { kind: 'parse' });
    parsed = JSON.parse(m[0]);
  }
  return parsed;
}

/**
 * 主入口：解析自然语言
 * 返回 { engine, conditions, unsupported, ambiguous, compliance, universe, conflicts, notes, llmError }
 */
async function parseIntent(text, { dashscopeKey, model, universeOptions }) {
  const fallback = ruleParse(text);
  const universeFromText = parseUniverse(text);
  let engine = 'builtin-rules';
  let result = { ...fallback, universe: universeFromText, notes: '' };
  let llmError = null;

  if (dashscopeKey) {
    try {
      const raw = await callQwen(dashscopeKey, text, universeOptions, { model });
      const sanitized = sanitizeModelOutput(raw, text);
      // 大模型漏掉合规检测时，规则层补齐（合规判断不交给 AI 独裁）
      if (!sanitized.compliance.length) sanitized.compliance = fallback.compliance;
      // 大模型没识别出股票池时，用规则层结果
      if (!sanitized.universe || !sanitized.universe.thscode) sanitized.universe = universeFromText;
      result = { ...sanitized, engine: `qwen:${model || QWEN_MODEL}` };
      engine = result.engine;
      // 若大模型一个条件都没给出，但规则层能给出，则合并兜底，避免主链路空转
      if (!result.conditions.length && fallback.conditions.length) {
        result.conditions = fallback.conditions;
        result.notes = (result.notes ? result.notes + ' ' : '') + '大模型未产出可用条件，已回退到内置规则解析结果。';
        engine = 'qwen+rules-fallback';
      }
    } catch (e) {
      llmError = { kind: e.kind || 'unknown', message: e.message, status: e.status };
      result = { ...fallback, universe: universeFromText, notes: '' };
      engine = 'builtin-rules';
    }
  }

  const conditions = assignIds(dedupeConditions(result.conditions || []));
  const conflicts = detectConflicts(conditions);
  return { engine, conditions, unsupported: dedupeUnsupported(result.unsupported || []), ambiguous: result.ambiguous || [], compliance: result.compliance || [], universe: result.universe, conflicts, notes: result.notes || '', llmError };
}

module.exports = { parseIntent, ruleParse, detectConflicts, detectCompliance, parseUniverse, findMetricByText, ALIASES, COMPLIANCE_MESSAGES, QWEN_MODEL, DASHSCOPE_BASE };
