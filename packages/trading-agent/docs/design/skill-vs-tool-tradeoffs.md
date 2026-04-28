# Skill vs Tool 封装策略分析

> 日期: 2026-04-22
> 背景: 评估 `nl-stock-screener` 在 `pi-coding-agent`（skill 方案）与 `trading-agent`（tool 封装方案）中的集成方式优劣。

---

## 两种方案对比

### 1. Skill 方案（pi-coding-agent）

**机制**: Agent 读取 `SKILL.md`，LLM 按文档指引手动执行 `write` → `bash` → `read` 完成筛选。

**维护优势**
- 零代码封装，`SKILL.md` 即文档
- Skill 更新后自动生效，无需改 agent 代码
- 通用性强，新技能即插即用

**实际运行时的隐性损失**

| 方面 | 问题 |
|------|------|
| **类型安全** | JSON config 由 LLM 手写，可能字段拼错、类型不对（如把 `"golden"` 写成 `"gold"`），运行时才报错 |
| **路径解析** | 每次都要 LLM 自己拼接 `C:/Users/.../.agents/skills/...`，跨平台（Win/Mac/Linux）容易出错 |
| **错误处理** | 如果 `screen.py` 报错，LLM 需要自行解读 Python traceback 并决定重试策略 |
| **Token 开销** | 每次筛选都要先 `read SKILL.md`（几百行），再 `write` 配置，再 `bash` 执行，再 `read` 结果——至少 4 轮工具调用 |
| **结果格式化** | 每次输出格式依赖 LLM 即时渲染，不稳定 |
| **超时控制** | 无，如果 JoinQuant API 卡死，整个对话挂起 |

---

### 2. Tool 封装方案（trading-agent）

**机制**: Agent 调用 `advancedScreenTool`，参数即结构化 JSON，tool 代码内部完成 write → spawn → read → format。

**维护负担**
- 需要维护 `advanced-screening.ts`（~100 行）
- Skill 升级时可能要同步改 schema 或 description
- 硬编码路径需要验证

**运行时优势**

| 方面 | 收益 |
|------|------|
| **类型约束** | TypeBox schema 强制 LLM 输出合法结构，字段类型错误在调用前就被拦截 |
| **一步完成** | LLM 只发一次 tool call，agent 内部完成全部操作 |
| **错误兜底** | 可以 catch Python 异常、格式化错误信息、自动重试、控制 timeout |
| **零 skill 加载** | 不需要每次读取 SKILL.md，系统提示里直接有 tool description |
| **体验一致** | 结果总是统一表格格式，不受 LLM 即兴发挥影响 |

---

## 当前 trading-agent 的工具矩阵问题

目前 8 个工具中存在**过度封装**:

| 工具 | 功能本质 | 建议 |
|------|----------|------|
| `market-data` | 读实时行情 / 跑 Python | **移除**，skill + bash 即可 |
| `compare-stocks` | 读多股数据 / 跑 Python | **移除**，skill + bash 即可 |
| `sector-rotation` | 读板块数据 / 跑 Python | **移除**，skill + bash 即可 |
| `concept-stocks` | 读概念股数据 / 跑 Python | **移除**，skill + bash 即可 |
| `macro-data` | 读宏观数据 / 跑 Python | **移除**，skill + bash 即可 |
| `screening` | 基本面筛选（调用 `stock_screener.py`）| **合并或移除**，与 `advanced-screening` 重叠 |
| `advanced-screening` | 技术面+基本面组合筛选 | **保留**，核心高频功能，需要类型安全 |

---

## 核心区别：`advanced-screening` 为什么值得保留

与其他工具不同，`advanced-screening` 涉及**自然语言到结构化 JSON 的精确转换**：

- 转换错误率较高（字段名、运算符、数值单位容易出错）
- Type-safe tool call 能显著降低失败率
- 高频操作，每次省 3-4 轮工具调用 + 几百 token 的 skill 读取

**结论**: 只有需要**精确参数映射 + 高频调用 + 强类型约束**的核心功能，才值得维护专用 tool。

---

## 决策矩阵

| 场景 | 推荐方案 |
|------|----------|
| 探索性、一次性、灵活度要求高的操作 | **Skill 方案**（更轻量） |
| 高频、结构化输入、需要可靠性的核心功能 | **Tool 封装**（更稳健） |

---

## 待办事项

- [ ] 修正 `nl-stock-screener/SKILL.md` 中 `market_cap` 单位错误（应为"亿元"而非"元"）
- [ ] 评估移除 `trading-agent` 中 5 个纯数据查询工具的可行性
- [ ] 合并 `screening` 与 `advanced-screening`，消除功能重叠
- [ ] 为保留的 `advanced-screening` 添加更完善的错误处理和重试机制
