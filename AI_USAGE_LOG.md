# AI 使用与验证记录（AI_USAGE_LOG.md）

本文件记录「知选 AI」开发过程中使用了哪些 AI 工具、AI 参与了哪些环节、生成了什么内容，以及**人工/自动化检查发现并修正了哪些错误或不合理结果**。

---

## 1. 使用的 AI 工具

| AI 工具 | 用途 | 参与环节 |
|---|---|---|
| QwenWork Agent（AI Coding） | 需求拆解、架构设计、全量代码生成、缺陷定位与修复、文档撰写 | 全流程 |
| 千问大模型 `qwen-plus`（DashScope OpenAI 兼容模式） | **产品运行时**：自然语言意图 → 结构化筛选条件 JSON | 产品功能（P0-A） |
| 内置中文金融规则解析器（本项目自研，非 AI） | 千问 Key 缺失时的降级通路；同时承担**合规检测**与**冲突识别**（这两项刻意不交给大模型） | 产品功能（P0-A/P0-B） |

**AI 未参与的环节**（刻意设计）：
- 个股是否通过筛选的判定 —— 100% 由 `lib/engine.js` 的确定性纯函数执行
- 所有财务/行情数值 —— 100% 来自同花顺扶摇 API 原始字段
- 合规边界判断 —— 由独立正则规则层执行，即使大模型"配合"了用户的不当请求，规则层仍会拦截并提示
- 指标字典 —— 人工依据扶摇官方文档逐字段核对后硬编码

---

## 2. AI 生成的代码与产品内容

| 产物 | 文件 | AI 参与度 | 人工核对方式 |
|---|---|---|---|
| 指标字典（44 项） | `lib/metrics.js` | AI 生成结构，字段名/单位/口径由人工对照扶摇官方文档逐项核对 | 与 https://fuyao.aicubes.cn/docs/api-reference/{valuations,prices,financial-indicators,ticker-list,a-share-index}/ 逐字段比对 |
| 扶摇 REST 客户端 | `lib/fuyao.js` | AI 生成 | 按官方文档核对：`X-api-key` 头、`code=0` 信封、100/10 批量上限、错误码 2001/2003/1001-1003/3001/5002/5003 |
| 意图解析（千问通路） | `lib/llm.js` `callQwen` / `buildPrompt` | AI 生成 | Prompt 中显式禁止发明指标与编造数值；输出经 `sanitizeModelOutput` 强制校验 |
| 意图解析（规则通路） | `lib/llm.js` `ruleParse` 等 | AI 生成 | 用 6 组中文语句做回归测试（见第 4 节） |
| 确定性筛选引擎 | `lib/engine.js` | AI 生成 | 波动率/回撤/区间涨跌算法用合成序列做数值自检；三态守恒用测试断言 |
| 服务端与任务队列 | `server.js` | AI 生成 | 本地启动 + curl/fetch 全接口实测 |
| 前端工作台 | `public/app.js`、`styles.css`、`index.html` | AI 生成 | 本地浏览器实跑 |
| 测试脚本 | `test/run-tests.js` | AI 生成 | 实际执行，输出真实 PASS/FAIL/SKIP |
| README / TEST_REPORT / DEMO_SCRIPT | 根目录 | AI 生成 | 人工核对与实测结果一致 |

---

## 3. AI 参与的产品运行时环节与边界控制

### 3.1 大模型输出的强制校验（防幻觉）

`lib/llm.js` → `sanitizeModelOutput()` 对千问返回的每一个条件执行：

1. `metric` 必须存在于指标字典（`getMetric()`），否则**丢弃**并转入 `unsupported` 数组，向用户展示"该指标不在知选 AI 的指标字典中，无法取数，已拒绝执行"。
2. `metric.supported` 必须为 `true`，否则丢弃并展示官方原因（如"扶摇当前 REST 接口未提供总市值字段"）。
3. `op` 必须在白名单 `> >= < <= == between` 内，否则丢弃。
4. `value` 必须 `Number.isFinite`，否则丢弃。
5. 合规检测**不采信大模型结论**，由 `detectCompliance()` 独立正则执行；若大模型漏报，规则层结果会覆盖补齐。
6. 若大模型一个可用条件都没产出但规则层能产出，自动回退并把引擎标记为 `qwen+rules-fallback`，同时在页面提示。

**效果**：大模型无法通过幻觉指标、幻觉阈值或"配合用户不当请求"来影响最终筛选结果。筛选判定链路中不存在任何 AI 输出。

### 3.2 Prompt 中的显式约束

系统提示词包含 6 条硬约束（见 `buildPrompt()`），其中关键三条：
- "你只能使用下面【可用指标字典】中的 metric id。绝对不允许发明指标、不允许编造任何财务数值或股票数据。"
- "你不判断任何具体股票是否通过筛选，那由确定性引擎基于真实数据完成。"
- "用户要求保证收益、预测必涨、给出买卖建议、目标价时，不要配合。"

同时把 36 个可用指标（含单位、时间窗口、取数层级）与 8 个不支持指标（含原因）完整注入 Prompt，让模型在受约束的闭集内选择。

---

## 4. 实际检查发现并修正的错误

以下是开发过程中**真实发现并修复**的缺陷，全部有对应的修复记录与回归验证。

### 缺陷 1：中文子句切分把「同」当成分隔符（严重）

- **现象**：输入 `PE小于25且ROE大于15%，营收同比增长率不低于10%`，只解析出 2 个条件，`营收同比增长率不低于10%` 被丢失。
- **AI 生成的错误代码**：
  ```js
  const clauses = n.split(/[，,；;。.\n、和且并且同时]+/).filter(Boolean);
  ```
  字符类 `[...并且同时]` 被 JS 解释为**单字符集合**，即 `并`、`且`、`同`、`时` 各自都是分隔符。因此 `营收同比增长率` 被从 `同` 处切断成 `营收` + `增长率不低于10%`，两半都无法匹配指标别名。
- **根因**：AI 把"并且/同时"这类**双字连词**误写进单字符字符类。
- **修复**：把多字连词移出字符类，改用交替分支：
  ```js
  const clauses = n
    .split(/(?:并且|同时|以及|而且|另外|此外)|[，,；;。.\n、和且]/)
    .map((s) => s.trim()).filter(Boolean);
  ```
- **验证**：回归测试 T1b 现在正确解析出 4 个条件（`assets_debt_ratio<50`、`sale_gross_margin>30`、`turnover>500000000`、`operating_income_yoy_growth_ratio>=10`）。

### 缺陷 2：条件重复产出（中等）

- **现象**：输入 `资产负债率低于50%同时毛利率高于30%并且成交额大于5亿`，`sale_gross_margin > 30` 出现两次。
- **根因**：显式数值解析器从"毛利率高于30%"抽出一次；语义规则 `/(毛利率高|高毛利)/` 又匹配到同一片段并追加一次默认阈值。两条通路没有互斥。
- **修复**：新增 `dedupeConditions()`，按 `metric|op|value|value2` 去重，在 `ruleParse` 返回前与 `parseIntent` 中各调用一次。
- **验证**：T1b 断言 `conditions.length === 4`，通过。

### 缺陷 3：不支持指标重复上报（轻微）

- **现象**：输入含"市值大于100亿"时，`unsupported` 数组出现两条 `market_cap`。
- **根因**：`UNSUPPORTED_PHRASES` 正则命中一次（phrase="市值"），显式数值解析器因指标不受支持又推入一次（phrase="市值大于100亿"），两条 phrase 不同导致初版按 `metric|phrase` 去重失效。
- **修复**：`dedupeUnsupported()` 改为仅按 `metric` 去重；同时过滤掉 `compliance:true` 的条目（这类已由合规面板呈现，重复计入"不支持指标"会造成语义混淆）。
- **验证**：T3 断言 `unsupported` 恰为 `turnover_rate, dividend_yield, market_cap` 三项，通过。

### 缺陷 4：`assignIds` 对象展开顺序导致 `value2` 变 undefined（中等）

- **现象**：非 `between` 条件的 `value2` 应为 `null`，实际为 `undefined`，序列化到前端后 `?? ''` 判断链出现不一致。
- **AI 生成的错误代码**：
  ```js
  return conditions.map((c, i) => ({ id: ..., value2: c.value2 ?? null, origin: ..., ...c, id: ... }));
  ```
  `...c` 在 `value2` 之后展开，当 `c.value2` 为 `undefined` 时会**覆盖**前面已归一化的 `null`。
- **修复**：调整展开顺序，先 `...c` 再逐字段归一化：
  ```js
  return conditions.map((c, i) => ({ ...c, id: c.id || `c${i+1}`, value2: c.op === 'between' ? (c.value2 ?? null) : null, origin: ..., ... }));
  ```
- **验证**：T1/T1b 输出中 `value2=null` 正确显示。

### 缺陷 5：测试脚本自身的环境问题（工具层）

- **现象 A**：Windows Git Bash 下 `curl -d '{"text":"中文"}'` 传给服务端后，中文未能正确到达，导致首轮接口测试误判为"解析器返回空条件"。
- **定位过程**：先用 `node -e` 直接 `require('./lib/llm')` 调用 `ruleParse`，得到正确的 7 个条件 → 证明解析器本身没问题 → 怀疑传输层 → 确认是 shell 参数编码问题，而非产品缺陷。
- **修复**：测试脚本改为纯 Node `fetch` + `JSON.stringify`，完全绕开 shell 编码，同时保证 UTF-8 正确性。
- **现象 B**：`/tmp` 在 Windows Node 下解析为不存在的 `C:\tmp`，`fs.writeFileSync` 报 `ENOENT`。
- **修复**：不再落临时文件，测试数据直接在内存中构造。
- **教训**：**接口测试失败时先区分"产品缺陷"与"测试工具缺陷"**，否则会误改正确的产品代码。

### 缺陷 6：发布产物中残留运行时日志

- **现象**：本地测试产生的 `server.log` 位于发布目录内，会被打包上传。
- **修复**：通过系统回收站安全删除（可恢复），并在 `.gitignore` 中排除 `*.log`；发布前增加自动化密钥泄露自检（扫描 `sk-[A-Za-z0-9]{16,}` 等模式）与 `data/config.json` 存在性检查。
- **验证**：发布前自检输出 `OK 源码中无任何硬编码密钥`，`data/` 目录为空，发布目录体积 342KB。

---

## 5. 对 AI 生成结果的合理性复核（非缺陷类）

以下是 AI 给出的方案中，经复核后**主动调整**的设计决策：

| AI 初始方案 | 复核结论 | 最终方案 |
|---|---|---|
| 用"总市值"作为"大盘股"的代理指标 | 扶摇 REST 未提供市值字段，任何代理都会造成口径失真 | 显式登记为 `supported:false`，如实告知用户不支持，不用代理指标偷偷替代 |
| 合规检测交给大模型在 Prompt 里判断 | 大模型可能被诱导"配合"用户 | 独立正则规则层执行，且在大模型漏报时强制覆盖补齐 |
| 数据缺失时按"该条件跳过"处理 | 等价于把 unknown 当 pass，违反题目铁律 | 严格三态，`unknown` 永不等于 `pass`，含 unknown 的股票归入"数据不完整"而非"入选" |
| 全市场 5000+ 只股票全量跑 C 层财务指标 | 单股接口，会产生数千次请求，不可行 | 分层漏斗 + 可配置上限，超限股票如实标记"数据不完整"并说明排序依据（当日成交额降序） |
| 前端用 CDN 加载 React | 线上环境 CDN 可达性不确定，会造成白屏 | 本地 vendored 到 `public/vendor/`，零外部依赖 |
| 用 Babel Standalone 支持 JSX | 运行时编译慢、体积大 | 改用 `htm`（1.3KB）tagged template，无需编译 |
| 策略存服务端数据库 | 题目允许 localStorage，且引入数据库会增加密钥面与复杂度 | localStorage，并在页面明确标注存储范围与丢失风险 |

---

## 6. 关键数字的可追溯性

产品中出现的每一个数字都可以回溯到原始来源：

| 界面数字 | 来源 |
|---|---|
| 初始股票池数量 | 扶摇 `constituents/ths-stock-list` 或 `meta/tickers/list` 返回的 `item.length` |
| 实际完成数据查询数量 | `records.filter(r => Object.keys(r.stagesDone).length > 0).length` |
| PE / PB / PS / PCF | 扶摇 `valuations/snapshot` 原始字段，未做二次计算 |
| 最新价 / 涨跌幅 / 成交额 | 扶摇 `prices/snapshot` 原始字段 |
| 20/60 日年化波动率 | 扶摇 `prices/historical-batch` 前复权收盘价 → `lib/engine.js` `deriveFromBars()`，算法全文在指标卡片中展示 |
| 60 日最大回撤 / 区间涨跌幅 | 同上 |
| 21 项财务指标 | 扶摇 `financials/indicators` 的 `abilities[].indicators[].value` 原始字符串，仅做 `Number()` 解析 |
| 数据时点 | 各接口返回的 `data.timestamp`（毫秒），界面分别显示估值/行情/K线/财务各自时点 |
| 财报期 | 接口返回的 `data.report` 回显（如 `2026-3`） |
| 失败批次 | 扶摇返回的 `code` / `message` / `request_id` 原样透传 |

界面上每条判定都同时展示：实际值、阈值、单位、时间窗口、来源接口路径、原始字段名、数据时点、财报期、计算方法全文、条件来源假设。

---

## 7. 未使用 AI 的验证手段

为避免"用 AI 验证 AI"，以下验证全部由确定性手段完成：

1. `node test/run-tests.js` —— 13 项端到端断言，PASS/FAIL 由布尔表达式判定，不由 AI 评价。
2. 波动率/回撤算法用**合成价格序列**做数值自检（`deriveFromBars` 对已知序列输出可手算校验的值）。
3. 三态守恒断言：`selectedCount + excludedCount + incompleteCount === universeSize`。
4. 入选正确性断言：所有 `verdict === 'selected'` 的记录，其 `evaluations` 必须**全部**为 `pass`。
5. unknown 安全性断言：所有含 `unknown` 判定的记录，`verdict` 必须**不等于** `selected`。
6. 发布前密钥泄露扫描：正则匹配源码中是否存在 `sk-` 开头的长字符串。
