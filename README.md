# 知选 AI · 自然语言智能选股与策略解释器

把投资者模糊的中文选股意图（"经营改善、估值合理、走势稳定"）转换成**可检查、可修改、可执行**的结构化数据条件，用**同花顺扶摇真实 A 股数据**做确定性筛选，并逐条解释每只股票**为何入选、为何被排除、哪些数据缺失**，以及**条件变化会带来什么结果变化**。

- 在线产品：**https://qw4ps4mg.qwenwork.host/**
- 技术形态：QwenWork Pages 动态网页（Node.js 服务端 + React 前端，零生产依赖）

---

## 1. 快速开始

### 1.1 环境要求

- Node.js **>= 22**（使用了内置 `fetch`、`AbortController`）
- 无任何 npm 生产依赖，**不需要 `npm install`**

### 1.2 本地运行

```bash
cd zhixuan-ai
PORT=8091 node server.js
# 打开 http://127.0.0.1:8091
```

### 1.3 配置密钥（二选一）

**方式 A：环境变量（推荐用于生产）**

```bash
export FUYAO_API_KEY="<你的扶摇 X-api-key>"      # 必需，否则无法取真实数据
export DASHSCOPE_API_KEY="sk-<你的百炼 Key>"      # 可选，未配置则用内置规则解析器
export QWEN_MODEL="qwen-plus"                     # 可选，默认 qwen-plus
node server.js
```

**方式 B：网页内填写（推荐用于线上站点）**

打开页面 → 右上角 **⚙ 数据源设置** → 粘贴 Key → 保存。
Key 写入服务端进程的 `data/config.json`（权限 `0600`，已在 `.gitignore` 中），**不会**进入前端代码、浏览器 localStorage、日志或代码仓库。前端只能读到掩码状态（如 `sk-a****wxyz`）。

> **线上站点激活真实数据**：访问 https://qw4ps4mg.qwenwork.host/ → 右上角「⚙ 数据源设置」→ 粘贴扶摇 Key → 保存 → 点「🔌 接口自检」确认连通 → 即可开始筛选。约 10 秒。

### 1.4 密钥获取地址

| 密钥名称 | 用途 | 获取地址 | 是否必需 |
|---|---|---|---|
| `FUYAO_API_KEY` | 同花顺扶摇金融数据 API（请求头 `X-api-key`） | https://fuyao.aicubes.cn/admin/ （同花顺账号登录 → 创建 API Key） | **必需** |
| `DASHSCOPE_API_KEY` | 阿里云百炼 / 千问大模型（意图解析） | https://bailian.console.aliyun.com/ → API-KEY | 可选 |

### 1.5 运行测试

```bash
# 先启动服务，另开一个终端：
node test/run-tests.js --base http://127.0.0.1:8091              # 不依赖真实数据的用例
node test/run-tests.js --base http://127.0.0.1:8091 --with-data  # 含真实数据用例（需已配置扶摇 Key）
```

测试脚本会把 Markdown 结果表写入 `test-results/run-<时间戳>.md`。

---

## 2. 环境变量一览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8081` | 监听端口（QW Pages 动态页要求读取该变量） |
| `HOST` | `0.0.0.0` | 监听地址（QW Pages 动态页要求读取该变量） |
| `FUYAO_API_KEY` | 空 | 扶摇 API Key，缺失时所有取数接口返回真实 `no_key` 错误 |
| `FUYAO_BASE_URL` | `https://fuyao.aicubes.cn` | 扶摇 Base URL |
| `FUYAO_TIMEOUT_MS` | `25000` | 单次扶摇请求超时 |
| `DASHSCOPE_API_KEY` | 空 | 千问 Key，缺失时自动降级为内置规则解析器 |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容模式地址 |
| `QWEN_MODEL` | `qwen-plus` | 千问模型名 |
| `ZHIXUAN_DATA_DIR` | `<项目>/data` | 运行时配置目录 |

---

## 3. 功能说明

### P0-A 自然语言选股
顶部输入一句话（或点示例问题），由千问大模型转换为结构化条件 JSON。未配置千问 Key 时，自动切换到**内置中文金融规则解析器**（覆盖显式数值抽取、语义短语映射、单位换算、多子句切分），页面会明确标注本次使用的解析引擎（`qwen:qwen-plus` / `builtin-rules` / `qwen+rules-fallback`）。

每个条件卡片展示：**指标名、运算符、阈值、单位、时间窗口、计算方法、数据来源接口与原始字段名、默认假设**。所有阈值都标注为"默认假设、可修改、非投资判断"。

### P0-B 条件编辑与冲突识别
- 所有 AI 生成的条件都可**改指标 / 改运算符 / 改阈值 / 删除**，修改后自动标记为「已手动修改」；也可**手动新增**条件。
- **冲突识别**（确定性规则，不依赖 AI）：`range_empty`（区间为空，必然 0 结果，error 级）、`range_tight`（区间收紧为等值）、`duplicate`（重复条件）、`redundant`（等值与范围并存）、`semantic`（如 PE 上限 ≤ 0 与"估值合理"语义相反）。
- **不支持的指标**：`market_cap`/`turnover_rate`/`dividend_yield`/`industry` 等被显式登记为 `supported:false`，AI 解析到时**如实告知原因**，不静默忽略、不偷偷替换成别的指标。
- **模糊表述澄清**：如"有潜力""龙头""近期""好公司"会触发追问并给出可选量化口径。

### P0-C 真实数据筛选（分层漏斗）
数据源：同花顺扶摇金融数据 API。**禁止模拟数据**——未配置 Key 时页面顶部显示红色阻塞提示，筛选按钮不可用。

| 层级 | 接口 | 批量能力 | 覆盖指标 |
|---|---|---|---|
| A | `GET /api/a-share/valuations/snapshot`<br>`GET /api/a-share/prices/snapshot` | 100 只/请求 | PE(TTM/MRQ)、PB、PS、PCF、最新价、涨跌幅、成交额、成交量 |
| B | `GET /api/a-share/prices/historical-batch` | 10 只/请求 | 20/60 日年化波动率、20/60 日区间涨跌幅、60 日最大回撤、可用交易日数 |
| C | `GET /api/a-share/financials/indicators` | 1 只/请求（最贵） | 21 项财务指标：营收/净利/营业利润同比、ROE、扣非ROE、毛利率、净利率、ROA、资产负债率、流动/速动/现金比率、已获利息倍数、周转率类、现金流类 |

股票池：`GET /api/a-share-index/constituents/ths-stock-list`（沪深300 / 中证500 / 上证50 / 创业板指 / 科创50 / 同花顺概念板块）或 `GET /api/meta/tickers/list?asset_type=a-share`（全部 A 股）。

**成本控制**：A 层先淘汰，B/C 层只对幸存者调用，并有可配置上限（默认 B≤150、C≤80）。**超出上限的股票会被如实标记为「数据不完整」，绝不假装通过。**

### P0-D 入选与排除解释
每只股票展开后显示逐条件判定，每条包含：

- 三态结果 **通过 / 失败 / 未知**
- 实际值 + 比较阈值 + 单位
- 时间窗口（TTM / MRQ / 近20个交易日 / 报告期同比 …）
- 数据来源接口路径 + **原始字段名**（如 `abilities[growth].indicators[index_id=operating_income_yoy_growth_ratio].value`）
- 数据时点（毫秒时间戳转本地时间）+ **财报期**（如 `2026-3`）
- 计算方法全文
- 条件来源假设

汇总区显示：**初始股票池数量 / 实际完成数据查询数量 / 满足全部条件数量 / 不满足条件数量 / 数据不完整数量**，外加各层淘汰数、失败批次数、最新数据时点与**数据过期告警**（>7 天）。

### P0-E 条件改变后的结果变化
再次筛选时自动携带上一次结果做 diff，输出：**新增入选 / 被排除（原入选）/ 保持不变 / 由排除转为数据不完整**，并对每只状态变化的股票做**归因**——逐条件比对判定状态，只有状态真正变化的条件才列为变化原因（区分 `status_changed` / `condition_added` / `condition_removed`，并显示阈值与实际值的前后对照）。

### P0-F 后续操作
- **三股并排对比**：估值、行情、21 项财务指标、K 线派生指标、所属板块、近 70 个交易日收盘价归一化走势 SVG 图。缺失项标注「无数据」，不做插值。
- **策略保存/加载**：条件 + 股票池 + 原始输入存入浏览器 `localStorage['zhixuan.strategies.v1']`，最多 50 条。页面明确标注存储范围：**仅当前浏览器，不上传服务器、不跨设备同步，清缓存即丢失；API Key 不会写入 localStorage**。
- 不实现真实交易或自动下单（题目不要求）。

---

## 4. AI 与确定性引擎的职责边界

```
用户自然语言
    │
    ▼
┌─────────────────────────────────────────┐
│ AI 层（千问大模型 / 内置规则解析器）      │
│ 职责：理解意图、澄清模糊表述、生成解释文本 │
│ 禁止：产生任何原始财务数值                 │
│ 禁止：判断任何个股是否通过筛选             │
│ 输出：条件 JSON（指标 id + 运算符 + 阈值） │
└─────────────────────────────────────────┘
    │  仅输出 metric id / op / value
    ▼
┌─────────────────────────────────────────┐
│ 校验层 sanitizeModelOutput                │
│ · 指标 id 必须在字典中，否则拒绝并告知     │
│ · 运算符白名单 > >= < <= == between       │
│ · 数值必须 Number.isFinite                │
│ · 合规检测由规则层独立执行，不交给 AI 独裁 │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 确定性筛选引擎 lib/engine.js              │
│ · 全部判定由纯函数 compare() 执行          │
│ · 三态：pass / fail / unknown             │
│ · 数据缺失 → unknown，unknown ≠ pass      │
│ · 入选 = 全部条件 pass                    │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ 数据层 lib/fuyao.js                       │
│ · 同花顺扶摇 REST API，真实字段            │
│ · 失败抛 FuyaoError（kind/code/request_id）│
│ · 禁止用虚构数据静默替代                   │
└─────────────────────────────────────────┘
```

**大模型输出被强制校验**：`lib/llm.js` 的 `sanitizeModelOutput()` 会丢弃任何不在指标字典中的 `metric`、任何非法运算符、任何非有限数值，并把被丢弃的项转入 `unsupported` 数组如实展示。AI 无法通过幻觉让某只股票"通过"。

---

## 5. 数据来源与口径

| 项 | 说明 |
|---|---|
| 数据源 | 同花顺扶摇金融数据 API，`https://fuyao.aicubes.cn` |
| 文档 | https://fuyao.aicubes.cn/docs/ |
| 鉴权 | 请求头 `X-api-key`；HTTP 状态码恒为 200，业务错误经 `body.code` 表达 |
| 响应信封 | `{code, message, request_id, data}`，`code=0` 为成功 |
| 时间戳 | 毫秒级 Unix 时间戳，时区 `Asia/Shanghai` |
| 货币 | A 股恒为 `CNY` |
| K 线复权 | 默认 `forward`（前复权） |
| 财报期格式 | `yyyy-1`(一季报) / `yyyy-2`(中报) / `yyyy-3`(三季报) / `yyyy-4`(年报) |
| 财报期回退链 | 按当前日期推导，默认 `2026-3 → 2026-2 → 2026-1 → 2025-4`（依据 A 股定期报告披露截止日 4/30、8/31、10/31、次年 4/30） |
| 百分比口径 | 财务指标百分比类按百分数值表达，`89.12` 表示 `89.12%` |
| 年化因子 | 波动率年化使用 `sqrt(252)`，A 股常用约定 |
| 波动率算法 | 最近 N 个日对数收益率 `ln(P_t/P_{t-1})` 的样本标准差（n-1）× `sqrt(252)` × 100 |
| 最大回撤算法 | `max(1 - P_t / max(P_0..P_t)) × 100`，窗口 60 个交易日 |

**错误码处理**（全部透传给用户，不静默）：

| code | kind | 处理 |
|---|---|---|
| 2001 | `auth` | API Key 无效或缺失 |
| 2003 | `permission` | Key 无权访问该数据能力 |
| 1001/1002/1003 | `param` | 参数缺失/格式非法/超出单次上限 |
| 3001 | `business` | 目标不在 A 股代码表 |
| 5002 | `timeout` | 上游数据源超时 |
| 5003 | `upstream` | 上游数据源不可用 |
| — | `no_key` | 本地未配置 `FUYAO_API_KEY` |

失败批次的 `request_id` 会展示在页面上，可用于向数据源排查。

---

## 6. 已知限制与未做事项

**已知限制**

1. **不支持的指标**：总市值、流通市值、换手率、股息率、机构评级/目标价。扶摇当前 REST 接口未提供这些字段，产品会如实告知而不是用代理指标偷偷替代。因此"大盘股/小盘股"这类表述无法直接筛选。
2. **行业/板块不能作为阈值条件**：只能通过选择股票池（同花顺概念/行业指数成分）间接实现。板块信息仅在个股详情与对比中展示。
3. **C 层（财务指标）是单股接口**，成本高。默认上限 80 只，超出者标记为「数据不完整」。全市场 5000+ 只股票无法在一次请求内完成 C 层全量取数。
4. **B/C 层超限时的排序依据是当日成交额**（降序保留），这是一个显式记录的近似策略，不是随机丢弃。
5. **财报期回退链是按披露截止日推导的**，个别公司延迟披露时会回退到更早报告期；页面会显示每只股票实际使用的财报期。
6. **数据时点不同步**：估值、行情、K 线、财务指标的更新时间可能不同，页面分别显示各自时点，不做"全部同步"的暗示。
7. **无用户体系**：策略保存在浏览器 localStorage，换设备/清缓存即丢失。
8. **千问降级**：未配置 `DASHSCOPE_API_KEY` 时使用内置规则解析器，覆盖常见中文金融表述，但对复杂长句的理解能力弱于大模型。

**明确未做（按题目要求不投入）**

- 注册登录、用户画像、持仓管理
- 复杂回测系统、行情预测模型、多 Agent 架构
- 真实交易 / 自动下单 / 券商接口对接
- 服务端持久化数据库（当前用 localStorage + 服务端配置文件即可满足需求）
- iFinD MCP 接入（市场宽度/资金/宏观/政策/新闻）——扶摇已覆盖主链路所需数据

---

## 7. 合规声明

- 本产品**不输出确定性涨跌预测、收益承诺或直接买卖建议**。
- 用户要求"保证收益""必涨""推荐买什么""目标价"时，解析层会命中合规规则并**拒绝执行**，同时给出说明。合规检测由独立规则层执行，不依赖大模型自觉。
- 所有阈值均为**可修改的默认假设**，不构成投资判断依据。
- 事实（接口返回的原始字段）、推断（AI 生成的默认假设与解释文本）、不确定信息（`unknown` 状态、数据缺口、失败批次）在界面上**分别标注、视觉区分**。
- 数据缺失、冲突、过期或调用失败时**不生成"正常"结论**：缺失记 `unknown`，冲突报 error，过期显示告警，失败显示真实错误码与 `request_id`。
- 公开仓库不包含 API Key、用户隐私或受限数据。

---

## 8. 项目结构

```
zhixuan-ai/
├── server.js              # Node HTTP 服务（仅内置模块，零生产依赖）
├── package.json
├── .gitignore             # data/ 与 .env 已排除，防止密钥入库
├── lib/
│   ├── metrics.js         # 指标字典：44 项（36 可用 + 8 显式不支持），含单位/窗口/来源/算法
│   ├── fuyao.js           # 扶摇 REST 客户端：分块、并发限流、错误分类、报告期回退
│   ├── llm.js             # 千问调用 + 内置规则解析器 + 输出校验 + 冲突识别 + 合规检测
│   ├── engine.js          # 确定性筛选引擎：分层漏斗、三态判定、解释生成、结果 diff 归因
│   └── config.js          # 运行时密钥存储（服务端，掩码对外）
├── public/
│   ├── index.html
│   ├── styles.css         # 深色金融科技工作台
│   ├── app.js             # React 18 + htm，无构建步骤
│   └── vendor/            # 本地 vendored React/ReactDOM/htm（避免 CDN 依赖）
├── test/
│   └── run-tests.js       # 端到端测试脚本，输出 Markdown 结果表
├── test-results/          # 测试运行产物
├── README.md
├── AI_USAGE_LOG.md
├── TEST_REPORT.md
└── DEMO_SCRIPT.md
```

---

## 9. 开源归属与许可

| 项目 | 许可 | 本项目的使用方式 |
|---|---|---|
| [erishen/stock-analyzer](https://github.com/erishen/stock-analyzer) | MIT | **参考其产品交互思路**（筛选表格、条件卡片、结果列表的信息组织方式）。未复制其源码——该项目为 Python/Streamlit 技术栈，与本项目 React + Node 架构不兼容，直接移植成本高于重写。 |
| [ZhuLinsen/alphasift](https://github.com/ZhuLinsen/alphasift) | Apache-2.0 | **参考其确定性条件过滤与解释输出的设计思想**：条件→判定→解释的数据结构分层、参数规则显式化。本项目的 `evaluations[]` 结构（status/actual/threshold/source/window/method/dataTime/reportPeriod）沿用该思路并扩展了 `unknown` 三态与数据溯源字段。未复制其源码。 |
| [kwokyx/qwen-screener](https://github.com/kwokyx/qwen-screener) | **未见明确许可证** | **仅参考其公开描述的功能设计**：`stock_screen` / `explain_result` / `ask_clarification` 三段式工具划分与交互流程。本项目的「执行筛选 / 逐条解释 / 模糊澄清」三个能力对应该设计思路。**未复制任何受保护源码**。 |
| [HiThink-Tech/Financial-API](https://github.com/HiThink-Tech/Financial-API) | 官方文档 | 同花顺扶摇金融数据 API 官方文档与请求示例，本项目按文档契约实现客户端。 |
| React 18.3.1 | MIT | 本地 vendored 于 `public/vendor/`，未修改。 |
| htm 3.1.1 | Apache-2.0 | 本地 vendored 于 `public/vendor/`，未修改。 |

**本项目源码许可：MIT。**

第三方库版权声明：
- React (c) Meta Platforms, Inc. — MIT License
- htm (c) Jason Miller — Apache License 2.0

---

## 10. 上传到 GitHub

```bash
cd zhixuan-ai
git init
git add .
git status                      # 确认 data/ 与 .env 未被纳入
git commit -m "feat: 知选 AI —— 自然语言智能选股与策略解释器"
git branch -M main
git remote add origin https://github.com/<你的用户名>/zhixuan-ai.git
git push -u origin main
```

**推送前务必确认**：`git status` 中不出现 `data/config.json`、`.env`、任何 `*.log`。`.gitignore` 已覆盖这些路径。
