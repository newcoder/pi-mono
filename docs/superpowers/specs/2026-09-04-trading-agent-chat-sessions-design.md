# Trading Agent Web UI 多会话聊天功能设计

日期: 2026-09-04
状态: 已与用户逐节确认（方案 A：服务端会话注册表 + 按连接跟踪当前会话）

## 背景与现状

trading-agent 的 web 聊天目前是**单会话、纯内存**：

- `src/main.ts` 启动时构建**一个** `TradingSession`（内部包 pi-agent-core 的 `Agent`），消息存于 `agent.state.messages`，无任何持久化；服务端重启即丢失全部历史。
- `src/server/server.ts` 把这个唯一会话传给所有 WebSocket 客户端。
- `src/server/ws-handler.ts` 协议：`prompt` / `get_state` / `abort`；服务端事件 `agent_event`、`trading_event` 原样转发。
- 前端 `web/src/main.ts`（vanilla TS + 手写 DOM）：`state.messages` 内存镜像 + 事件增量渲染；页面刷新后靠 `get_state` 从服务端内存恢复。
- `Agent` 可用 `initialState.messages` 带历史重建 —— `TradingSession.switchModel()` 已证明该路径可行。

目标功能：多会话、会话文件持久化、自动提取会话名称（即时截取 + LLM 精炼）、新建会话、从既有会话继续对话、web UI 会话列表（消息区顶部下拉）+ 新建按钮 + 删除。

## 方案选择

用户选定**方案 A**：

- 服务端 `SessionManager` 持有 `Map<id, TradingSession>`，会话按需懒加载（从文件恢复 messages 重建 Agent）。
- 每个会话一个 JSON 文件存于 `~/.trading-agent/sessions/`（数据目录约定与 `~/.trading-agent/data/market.db` 一致）。
- WS 连接各自记录当前会话，事件只转发当前绑定会话。
- 否决：B（前端 localStorage 持久化 —— 历史全量上传、换浏览器即丢、与"保存到文件"不符）；C（SQLite 存会话 —— 数据量小、文件更易人工检查/备份）。

## 数据模型与存储

每会话一个文件 `~/.trading-agent/sessions/<id>.json`：

```json
{
  "id": "a1b2c3d4-xxxx",
  "title": "请对 600519 贵州茅台 进行综合…",
  "titleSource": "truncated" | "refined",
  "createdAt": "2026-09-04T10:00:00.000Z",
  "updatedAt": "2026-09-04T10:30:00.000Z",
  "messages": [ /* pi-ai AgentMessage[] 原样 JSON 序列化 */ ]
}
```

- `id`：`crypto.randomUUID()`。
- `AgentMessage` 是纯数据（文本/图片 content 块、toolCall/toolResult），可直接序列化。含图片消息文件会较大，本地单用户可接受，不设上限。
- `create()` **立即写 meta 文件**（`messages: []`）—— 空会话随服务重启保留（否则空会话只在内存里存在，列表行为不一致）。
- 会话列表 meta = 各文件的 `id/title/titleSource/createdAt/updatedAt` + messages 长度。文件数少，直接读目录解析，不维护单独索引文件。

### SessionManager（新 `src/core/session-manager.ts`）

```ts
interface SessionMeta {
  id: string;
  title: string;
  titleSource: "truncated" | "refined";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

class SessionManager {
  constructor(opts: {
    sessionsDir: string;
    // main.ts 提供的工厂，签名带 hooks（见下）；闭包捕获 model/systemPrompt/tools/streamFn
    createSession: (
      initialMessages?: AgentMessage[],
      hooks?: { onFirstPrompt?: (input: string) => void },
    ) => TradingSession;
    // main.ts 注入：用当前模型+鉴权做一次轻量补全，返回 <=12 字中文标题或 null（失败容忍）
    refineTitle?: (messages: AgentMessage[]) => Promise<string | null>;
  });
  list(): Promise<SessionMeta[]>;              // updatedAt 倒序
  get(id): TradingSession | undefined;          // 懒加载：文件 → createSession(file.messages)
  create(): Promise<{ session: TradingSession; meta: SessionMeta }>;
  delete(id): Promise<void>;                    // dispose + 删文件
  save(id): Promise<void>;                      // 写回文件 + 更新 updatedAt
}
```

**接线（无循环依赖）**：SessionManager 调用工厂时注入 `onFirstPrompt` 钩子（闭包引用自身实例，箭头字段/调用时绑定即可）。SessionManager 对每个创建的会话订阅 `agent_event`，统一驱动：
- `agent_end` → 防抖 1s 落盘（`save(id)`）
- 首轮 `agent_end`（该会话尚为 truncated 占位且有首条用户文本）→ 触发 `refineTitle(messages)`；完成时若会话仍存在 → 更新标题 + 落盘；结果 null/异常 → 静默保留截断标题

保存触发汇总：首条 prompt 截断标题即落盘；每条 `agent_end` 防抖 1s；切换/新建前 flush；服务端 SIGINT flush 全部。写盘失败仅 console.error，不打断对话。

### TradingSession 小改

`TradingSessionOptions` 增加：
- `initialMessages?: AgentMessage[]` —— 构造时传入 `initialState.messages`（参考 `switchModel` 现有写法），`messages` getter 不变
- `onFirstPrompt?: (input: string) => void` —— 在 `prompt()` 内、消息队列处理前调用：条件 = 当前 `messages` 为空且 `input.trim()` 非空；参数为原始输入文本（非附件拼接后的文本）

### main.ts 重构：单会话 → 工厂

现在 `afterToolCall` 闭包内 `session.emit("trading_event", ...)` 自引用单例。改为 `createTradingSession(initialMessages?)` 工厂；sentiment/navigate 的 trading_event 派发不再在闭包里自引用 session，改为经 `agent_event`（tool details 携带完整信息）或局部变量捕获的方式绑定到被创建的实例。会话中途 Agent 只存内存，恢复时用**当前** systemPrompt/tools（与现状"重启即用新配置"一致）。

## WS 协议扩展

每个连接绑定一个会话；`session_switch` 先退订旧会话再订阅新会话（`ws-handler` 已有 per-connection 的 on/off 模式）。同一会话多个标签页 = 多个独立订阅，均收事件（与现状一致）。

**meta 变化推送通道**：`SessionManager extends EventEmitter`，emit `session_updated {id, meta}` / `session_deleted {id}`；server.ts 持有 manager，ws-handler 转发给绑定该会话的连接（`session_updated` 使列表标题即时刷新）。

请求带 `reqId`，服务端回复携带同 `reqId`（前端 `request()` 按 reqId resolve；`client.ts` 需新增轻量请求-响应关联，现有 `get_state` 也是 fire-and-forget）。

| 消息 | 方向 | 回复/说明 |
|---|---|---|
| `session_list` | C→S | `session_list`：`[{id, title, titleSource, createdAt, updatedAt, messageCount}]` |
| `session_new` | C→S | 建会话并**绑定**当前连接；`session_created`（meta + 空 messages） |
| `session_switch {sessionId}` | C→S | 加载/复用并绑定；`session_state`（meta + 完整 messages 原文） |
| `session_delete {sessionId}` | C→S | 删除；若该会话正被**其他**连接绑定，向它们推送 `session_deleted`，其 UI 退回"空会话"状态。若删除的是**自己**绑定的会话：回复 `session_deleted` 后前端自动 `session_new` 平滑接续 |
| `prompt` | C→S | 不变，发往**当前绑定**会话 |
| `get_state` | C→S | 返回当前绑定会话的 messages（含 meta） |
| （服务端推送） | S→C | `session_updated`（标题精炼完成等 meta 变化时） |

## 标题自动提取（两者结合）

**标题来源的输入 = 用户在输入框敲的原始文本**（TradingSession.prompt 的 `input`，非附件拼接后的完整 promptText；附件内容可能是大文件，不应进标题）。纯附件首条（input 为空）→ 截断与精炼都跳过，保持"新会话"。

1. **即时截取**：`session_new` 后标题为"新会话"。首次 prompt 触发 `onFirstPrompt(input)` → SessionManager 取 input（去换行、折叠空白）前 30 字符设为标题 + 立即落盘，`titleSource: "truncated"`。
2. **LLM 精炼**：见 SessionManager 接线段 —— 首轮 `agent_end` 后触发 `refineTitle(messages)`（上下文 = 首条用户消息 + 首条助手回复摘要）。成功 → 更新标题为 `"refined"` 并推送 `session_updated`（由 ws-handler 将 meta 变化广播给绑定该会话的连接）；失败/超时静默保留截断标题。删除会话时精炼仍在途 → 完成后检查会话已不存在则丢弃。

## Web UI（web/src/main.ts + client.ts）

### 会话栏（消息区顶部，stock-chart-panel 与消息列表之间）

```
┌────────────────────────────────────────────────┐
│ ▾ 请对 600519 贵州茅台 进行综合…      [+ 新建] │  ← #session-bar
├────────────────────────────────────────────────┤
│ ▾ 会话列表                                      │
│  ├ ● 请对 600519 贵州茅台 进行综合…   今天 5条 │
│  ├ ○ 北向资金今日流入分析             昨天 3条 │
│  ├ ○ 回测结果解读                   09-02 8条 │
│  └ ○ 新会话                                      │
├────────────────────────────────────────────────┤
│  (消息区 / 工具调用)                          │
└────────────────────────────────────────────────┘
```

- 当前会话名 + chevron 点击展开/收起下拉（绝对定位覆盖层）；外部点击 / Escape 关闭；列表项 hover 显示 × 删除按钮（confirm 确认）。
- **[+ 新建]** → `session_new`，清空消息区渲染（不整页刷新）。
- 切换 → 全量重建消息区 + 清空工具日志；图表/股票池/日历/新闻等旁路面板不动。
- 重新连接：`session_list` → localStorage 记 lastSessionId 恢复（不存在则取列表最新）；服务端无会话 → `session_new`。
- `isStreaming` 时禁用 切换/新建/删除（服务端不强制）。
- 新状态：`state.sessions: SessionMeta[]`、`state.currentSession`、`state.sessionDropdownOpen`；本地存储 key 如 `trading-agent.lastSessionId`。

### 恢复渲染

`session_state` 返回原始 AgentMessage[]。新增 `agentMessagesToChat(messages)` 转换为现有 `state.messages` 显示形态：

- user 消息取文本 content 块；assistant 消息取全部文本块拼接（结构化 content 数组 → 字符串），`isStreaming: false`。
- toolCall / toolResult 消息跳过 —— 工具过程只在实时运行的工具日志里可见。
- 用户图片附件（image content 块，data URL 存储）→ 渲染 `<img src="data:...">`；文本附件内容作为消息文本原样显示。
- 空会话显示欢迎/空提示。

## 错误处理与边界

- 写盘失败：console.error 后继续（对话不中断）。
- 会话文件损坏（JSON 解析失败）：`list()` 跳过该文件并 console.warn；`get(id)` 返回 undefined → 前端提示"会话不可用"。
- 删除进行中（正在 prompt）的会话：服务端允许（dispose 会中断进行中的 prompt 队列）—— 前端在 streaming 时禁用删除已覆盖常规路径。
- 标题精炼并发：同一会话仅触发一次（按 titleSource 判断）。

## 测试

- 单测（vitest）：
  - `session-manager`：create/list/get（懒加载恢复）/delete/save 文件往返、损坏文件容错、防抖保存。
  - `TradingSession`：带 `initialMessages` 构造后 `messages` 与传入一致。
  - `ws-handler`：mock 两个会话 + 两个连接，`session_switch` 后事件只转发到绑定连接。
- 手动验证：
  - 两个会话分别对话 → 切换 → 历史正确；刷新页面/重启服务后会话列表与内容完整。
  - 首条消息截断标题即时生效；首轮结束后标题被 LLM 精炼（≤12 字）。
  - 流式进行中按钮禁用；删除会话（含被另一标签页绑定的会话）行为正确。
- e2e（playwright，可选）：会话新建→对话→刷新恢复→切换 冒烟一条。

## 涉及文件清单

| 文件 | 改动 |
|---|---|
| `src/core/session-manager.ts` | 新增 |
| `src/core/trading-session.ts` | options 加 `initialMessages` |
| `src/main.ts` | 单会话 → `createTradingSession` 工厂 + `SessionManager` + SIGINT flush + `refineTitle` 注入 |
| `src/server/server.ts` | 构造签名接收 SessionManager（或工厂） |
| `src/server/ws-handler.ts` | per-connection 会话绑定 + 新消息类型 + reqId 回复 |
| `web/src/api/client.ts` | `request()` reqId 关联 + session API 方法 |
| `web/src/main.ts` | 会话栏/下拉 UI + 切换/新建/删除 + 恢复渲染转换 |
| `web/src/app.css` | 会话栏样式 |
| 单测若干 | 见上 |
