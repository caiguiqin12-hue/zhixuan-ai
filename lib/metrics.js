'use strict';
/**
 * 指标注册表 —— 知选 AI 的"可筛选指标字典"
 *
 * 设计原则（对应题目要求）：
 *  1. 每个指标显式声明：单位、时间窗口、数据来源接口、原始字段名、计算方法。
 *     -> 前端可以完整展示"数据口径"，结论可追溯到原始字段。
 *  2. 每个指标声明 stage（取数成本层级），筛选引擎按成本从低到高分层执行，
 *     便宜的批量接口先淘汰，昂贵的单股接口只对幸存者调用。
 *  3. 不支持的指标必须显式登记为 supported:false，AI 解析出这类条件时
 *     产品要如实告知"不支持"，而不是静默忽略或编造数据。
 */

// stage 说明：
//  A = 批量快照（valuations / prices snapshot，100 只/请求）
//  B = 批量历史 K 线派生（historical-batch，10 只/请求）
//  C = 单股财务指标（financials/indicators，1 只/请求，最贵）
//  meta = 元信息，不参与阈值判断

const METRICS = [
  // ---------- A: 估值快照 /api/a-share/valuations/snapshot ----------
  {
    id: 'pe_ttm', name: '市盈率 PE(TTM)', unit: '倍', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/valuations/snapshot', field: 'pe_ttm' },
    window: 'TTM（最近连续 12 个月，通常由最近四个季度计算）',
    method: '数据源直接返回，服务端不做二次计算。净利润为负时可能为负值或 null。',
    caveat: '负值不代表"便宜"，亏损公司 PE 无常规估值意义。',
  },
  {
    id: 'pe_mrq', name: '市盈率 PE(MRQ)', unit: '倍', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/valuations/snapshot', field: 'pe_mrq' },
    window: 'MRQ（最近一个已披露报告期）',
    method: '数据源直接返回。',
  },
  {
    id: 'pb_mrq', name: '市净率 PB(MRQ)', unit: '倍', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/valuations/snapshot', field: 'pb_mrq' },
    window: 'MRQ（最近一个已披露报告期）',
    method: '数据源直接返回。净资产为负时该指标不具常规估值意义。',
  },
  {
    id: 'ps_ttm', name: '市销率 PS(TTM)', unit: '倍', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/valuations/snapshot', field: 'ps_ttm' },
    window: 'TTM', method: '数据源直接返回。',
  },
  {
    id: 'pcf_ttm', name: '市现率 PCF(TTM)', unit: '倍', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/valuations/snapshot', field: 'pcf_ttm' },
    window: 'TTM', method: '数据源直接返回。经营现金流为负时可能为负值或 null。',
  },

  // ---------- A: 行情快照 /api/a-share/prices/snapshot ----------
  {
    id: 'last_price', name: '最新价', unit: '元(CNY)', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/prices/snapshot', field: 'last_price' },
    window: '最新快照', method: '数据源直接返回。',
  },
  {
    id: 'price_change_ratio_pct', name: '当日涨跌幅', unit: '%', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/prices/snapshot', field: 'price_change_ratio_pct' },
    window: '当日（相对前收盘价）', method: '数据源直接返回，1.74 表示 +1.74%。',
  },
  {
    id: 'turnover', name: '成交额', unit: '元(CNY)', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/prices/snapshot', field: 'turnover' },
    window: '当日', method: '数据源直接返回。',
  },
  {
    id: 'volume', name: '成交量', unit: '股', stage: 'A', supported: true,
    source: { api: 'GET /api/a-share/prices/snapshot', field: 'volume' },
    window: '当日', method: '数据源直接返回。',
  },

  // ---------- B: 历史 K 线派生 /api/a-share/prices/historical-batch ----------
  {
    id: 'volatility_20d_annualized', name: '近20个交易日年化波动率', unit: '%', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'close_price（派生）' },
    window: '最近 20 个交易日日收益率',
    method: '取前复权收盘价序列最后 21 个交易点，计算 20 个日对数收益率 ln(P_t/P_{t-1}) 的样本标准差（n-1），再乘以 sqrt(252) 年化并换算为百分数。',
    caveat: '年化因子 252 为 A 股常用约定；停牌导致的缺日会拉长实际日历跨度。',
  },
  {
    id: 'volatility_60d_annualized', name: '近60个交易日年化波动率', unit: '%', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'close_price（派生）' },
    window: '最近 60 个交易日日收益率',
    method: '同上，窗口改为 60 个交易日（需 61 个收盘点）。',
  },
  {
    id: 'return_20d', name: '近20个交易日区间涨跌幅', unit: '%', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'close_price（派生）' },
    window: '最近 20 个交易日',
    method: '(P_last / P_20个交易日前 - 1) × 100，使用前复权收盘价。',
    caveat: '历史区间涨跌不构成对未来走势的预测。',
  },
  {
    id: 'return_60d', name: '近60个交易日区间涨跌幅', unit: '%', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'close_price（派生）' },
    window: '最近 60 个交易日', method: '(P_last / P_60个交易日前 - 1) × 100，前复权收盘价。',
  },
  {
    id: 'max_drawdown_60d', name: '近60个交易日最大回撤', unit: '%', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'close_price（派生）' },
    window: '最近 60 个交易日',
    method: 'max(1 - P_t / max(P_0..P_t)) × 100，取正数表示回撤幅度。',
  },
  {
    id: 'trading_days_available', name: '可用交易日数量', unit: '个', stage: 'B', supported: true,
    source: { api: 'GET /api/a-share/prices/historical-batch', field: 'item.length（派生）' },
    window: '取数窗口内', method: 'K 线序列实际返回的交易日条数，用于判断数据是否足够计算派生指标。',
  },

  // ---------- C: 财务指标 /api/a-share/financials/indicators ----------
  ...[
    ['operating_income_yoy_growth_ratio', '营业收入同比增长率', '%', 'growth', '报告期同比（YoY）'],
    ['net_profit_yoy_growth_ratio', '净利润同比增长率', '%', 'growth', '报告期同比（YoY）'],
    ['operating_profit_yoy_growth_ratio', '营业利润同比增长率', '%', 'growth', '报告期同比（YoY）'],
    ['total_assets_growth_ratio', '总资产增长率', '%', 'growth', '报告期同比（YoY）'],
    ['index_weighted_avg_roe', '净资产收益率 ROE(加权)', '%', 'profitability', '最近披露报告期'],
    ['index_deduct_weighted_avg_roe', '扣非加权净资产收益率', '%', 'profitability', '最近披露报告期'],
    ['sale_gross_margin', '销售毛利率', '%', 'profitability', '最近披露报告期'],
    ['sale_net_interest_ratio', '销售净利率', '%', 'profitability', '最近披露报告期'],
    ['total_assets_net_ratio', '总资产收益率 ROA', '%', 'profitability', '最近披露报告期'],
    ['assets_debt_ratio', '资产负债率', '%', 'solvency', '最近披露报告期'],
    ['current_ratio', '流动比率', '倍', 'solvency', '最近披露报告期'],
    ['quick_ratio', '速动比率', '倍', 'solvency', '最近披露报告期'],
    ['cash_ratio', '现金比率', '倍', 'solvency', '最近披露报告期'],
    ['earned_interest_multiple', '已获利息倍数', '倍', 'solvency', '最近披露报告期'],
    ['total_assets_turnover_ratio', '总资产周转率', '次', 'operation', '最近披露报告期'],
    ['inventory_turnover_ratio', '存货周转率', '次', 'operation', '最近披露报告期'],
    ['receive_account_turnover_ratio', '应收账款周转率', '次', 'operation', '最近披露报告期'],
    ['operating_cash_flow_net_divide_income', '销售现金比率', '倍', 'cash-flow', '最近披露报告期'],
    ['net_profit_cash_content', '净利润现金含量', '倍', 'cash-flow', '最近披露报告期'],
    ['operating_cash_net_yoy_growth_ratio', '现金流量净额增长率', '%', 'cash-flow', '报告期同比（YoY）'],
    ['cash_operating_index', '现金营运指数', '倍', 'cash-flow', '最近披露报告期'],
  ].map(([id, name, unit, ability, window]) => ({
    id, name, unit, stage: 'C', supported: true, ability,
    source: { api: 'GET /api/a-share/financials/indicators', field: `abilities[${ability}].indicators[index_id=${id}].value` },
    window,
    method: '数据源返回原始数值字符串，服务端仅做 Number() 解析，不做重算；上游缺失时为 null。',
    caveat: '百分比类指标按百分数值表达（89.12 表示 89.12%）。单季/累计口径以数据源为准。',
  })),

  // ---------- 明确不支持的指标：必须如实告知，不能编造 ----------
  ...[
    ['market_cap', '总市值', '扶摇当前 REST 接口未提供总市值/流通市值字段'],
    ['float_market_cap', '流通市值', '同上'],
    ['turnover_rate', '换手率', '需要流通股本，扶摇未提供'],
    ['dividend_yield', '股息率', '扶摇估值快照未提供该字段'],
    ['industry', '所属行业筛选', 'v1 仅支持按指数/板块成分定义股票池，不支持把行业作为阈值条件'],
    ['analyst_rating', '机构评级/目标价', '数据源未提供'],
    ['future_price', '未来股价/涨跌预测', '产品合规边界：不输出确定性涨跌预测'],
    ['guaranteed_return', '保证收益率', '产品合规边界：不承诺收益'],
  ].map(([id, name, reason]) => ({
    id, name, unit: '-', stage: 'none', supported: false, unsupportedReason: reason,
    source: null, window: '-', method: '-',
  })),
];

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));
const STAGE_ORDER = ['A', 'B', 'C'];

function getMetric(id) { return BY_ID.get(id) || null; }
function supportedMetrics() { return METRICS.filter((m) => m.supported); }

/** 条件所需的最深取数层级；用于漏斗调度 */
function conditionsMaxStage(conditions) {
  let deepest = -1;
  for (const c of conditions) {
    const m = getMetric(c.metric);
    if (!m || !m.supported) continue;
    const idx = STAGE_ORDER.indexOf(m.stage);
    if (idx > deepest) deepest = idx;
  }
  return deepest < 0 ? null : STAGE_ORDER[deepest];
}

module.exports = { METRICS, BY_ID, STAGE_ORDER, getMetric, supportedMetrics, conditionsMaxStage };
