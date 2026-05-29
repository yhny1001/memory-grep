# memory-grep — TauriTavern 动态记忆插件

为 [TauriTavern](https://github.com/qhduan/TauriTavern) 设计的"记忆压缩 + 按需检索"插件。每次发请求前自动压缩 prompt、把窗口外的相关历史用 grep 的方式取出注入回 system，避免长对话超 token 或 LLM 凭空编造。

兼容 ST 风格 Chat Completion，以及 TT 的 Agent Mode（不修改核心代码、不改 agent profile）。

---

## 解决的问题

随着对话变长，prompt 里塞进的"全量 chat history"会越来越大，最终：

- 命中 token 上限触发 ST 后端硬截断，丢失早期关键设定
- 持续吃 token 推高 API 成本
- 即使没截断，长 prompt 也让 LLM 注意力分散、容易"忘记"早期 setup

传统做法是手动 World Info / 摘要插件，但都需要人工维护。memory-grep 改成全自动：

1. 只保留最近 N 轮真实对话（默认 4 turns / 8 messages）
2. character preset（`<overall-rules>` / `<writing-guidelines>` / `<now-player-input>` 等）单独保留，不占用最近 N 轮配额
3. 用最新 user 输入做 `chat.search`，把窗口外的相关片段（snippet 已截取命中位置上下文）注入到 system 的 `【早期相关片段】` 区
4. Agent Mode 下，agent 看到 snippet 不够还可以自己 `chat.search` / `chat.read_messages` 兜底（plugin 在 system policy 里给出了精简协议）

---

## 工作原理

CHAT_COMPLETION_PROMPT_READY hook 拿到 `chat[]` 后：

```
原始 chat 数组（ST 给的）：
  [head system] + [可能很长的 chat history] + [character preset block]

partition 后变成：
  realDialog  = chat history 中的 user / assistant 真实对话
  presetBlock = role=user 但匹配 preset 模式的（XML 标签、中文【】、长 > 1500 字）

splice 之后注入到 prompt 的最终结构：
  [head system]
  [plugin policy system: 记忆约束 + 历史范围 + 早期相关片段 + 世界观]
  [recentReal: realDialog.slice(-recentTurns*2)]
  [presetBlock 全部]
  [hardRuleTail user: [#X] 引用规范]
```

### `【早期相关片段】` 智能注入

每轮发请求前，plugin 会：

1. 从 `recentReal` 取最新 user 输入做 query（避免被末尾 preset 污染）
2. 调用 `window.__TAURITAVERN__.api.chat.current.handle().searchMessages({query, limit})`
3. 过滤只保留 `index < visibleStart`（窗口外）的 hits
4. top-3 snippet（每条 ≤ 600 字符切片）拼成 block 注入

**智能跳过**条件（不注入空 block，省 token）：

- query 长度 < 5（`hi` / `嗯` 等短反馈）
- `windowInfo` API 不可用
- `total ≤ recentTurns*2`（所有历史都在窗口里）
- chat.search 返回空 / 所有 hits 都在窗口内

跳过时 agent 仍可看到 system policy 里的引导，需要时**自己**调 `chat.search` / `chat.read_messages` 兜底。

### Agent Mode vs Chat Mode

| | Agent Mode | Chat Mode |
|---|---|---|
| 检测方式 | `agent-system` 扩展的 `agentModeEnabled` flag → fallback 到 marker 扫描 | 默认路径 |
| 注入策略 | 智能 pre-grep snippet + 检索协议 | 一次性 pre-grep 全量结果 + sentinel fallback |
| 末尾追加 | `hardRuleTail`（[#X] 引用规范） | 无 |

---

## 安装

### 方式 1：TT 扩展商店（推荐）

设置 → Extensions → Install Extension → 粘贴：

```
https://github.com/yhny1001/memory-grep
```

→ Install → 重启 TT。

### 方式 2：手动 clone

```bash
cd "$HOME/Library/Application Support/com.tauritavern.client/data/extensions/third-party"
git clone https://github.com/yhny1001/memory-grep.git
```

→ 重启 TT。

### 方式 3：zip 离线安装

下载 release zip → Extensions → Install From File。

---

## 配置

设置 → Extensions → Memory Grep：

| 选项 | 默认 | 说明 |
|---|---|---|
| Enabled | true | 总开关 |
| Enable in Chat | true | 普通 Chat Completion 路径生效 |
| Enable in Agent | true | TT Agent Mode 路径生效 |
| Recent Turns | 4 | 保留最近 N 轮真实对话（= N\*2 messages） |
| Grep Top-K | 5 | `chat.search` 返回 top-K 候选，filter 后 top-3 注入 |
| Inject World Info content | true | 把激活的 World Info 完整内容注入 system；关闭则只注入条目名 |
| Sentinel on miss | `(no relevant memory)` | Chat Mode pre-grep 无结果时的占位 |
| Debug log | true | 开启时 console 输出 mutate 详情（partition / windowInfo / hits / 最终 prompt） |

---

## 验证与调试

### 1. Console

F12 → Console，每次发请求前应看到：

```
[memory-grep] v0.1.18 initialized (...)
[memory-grep] ⚙️ mutate (agent | chat) dryRun=false before=N
  ▸ partition: { head, realDialogTotal, recentRealKept, presetTotal }
  ▸ historyBlock: ...
  ▸ earlyContextBlock: ...
  ▸ policyMessage: ...
[memory-grep] ✅ mutate done (agent | chat) after=M
```

### 2. `scripts/diag.py`（仅 Agent Mode 有用）

直接读 TT 本地 agent run 目录，输出每个 round 的 tool calls / pre-grep 注入 / drift 事件：

```bash
python3 scripts/diag.py                # 最新 chat 的最新 run
python3 scripts/diag.py --runs 3       # 最近 3 个 run
python3 scripts/diag.py --chat <id>    # 指定 chat
python3 scripts/diag.py --run <run_id> # 指定 run
python3 scripts/diag.py --full-system  # dump 完整 system[0]
```

典型 healthy 输出包含：

- `plugin policy mode: AGENT` ✓
- `partition: { realDialogTotal: N, recentRealKept: 8, presetTotal: 8 }` ✓
- agent 调用了 `chat.search` 或 `chat.read_messages`（说明 plugin policy 引导生效）
- `workspace.commit` + `workspace.finish` 收尾

---

## 兼容性

- TauriTavern 2.0.0+（依赖 `window.__TAURITAVERN__.api.chat.current.handle().searchMessages` + `windowInfo()`）
- 任何 OpenAI 协议的 chat completion provider（DeepSeek / OpenAI / Anthropic-compat / Claude via gateway 等）
- 兼容标准 ST 扩展系统（manifest.json + activate hook）

---

## 已知行为（不是 bug）

| 现象 | 原因 |
|---|---|
| `【早期相关片段】` 有时不出现 | hits 全部在最近窗口内 → 静默跳过（节省 token），见 Agent 模式智能跳过条件 |
| Agent round-001 偶尔触发 `drift_recovery` | TT 后端 `tool_choice: required` 与 character preset 的"直接出文"指令冲突；plugin 不主动防御，TT 自带恢复机制可正常收尾 |
| LLM 没标 `[#X]` 引用 | `hardRuleTail` 是软约束；标了便于 audit，没标也不影响功能 |

---

## 版本历史

完整 changelog 见 `git log`。关键里程碑：

- **v0.1.18** — `chat_read_messages max_chars` 对齐后端硬上限 8000
- **v0.1.16** — system policy 从 25 行精简到 8 行，专注 grep
- **v0.1.15** — 撤回 drift 防御，专注 grep 正确性
- **v0.1.13** — `<now-player-input>` 包装短消息识别修复
- **v0.1.12** — pre-grep query 改从 `recentReal` 取，避免 preset 污染
- **v0.1.11** — pre-grep 智能注入正式上线
- **v0.1.10** — `partitionConversation` 把 character preset 跟真实对话隔离

---

## License

ISC
