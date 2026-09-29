# dsh-plugin-honcho

dsh（DeepSeek Harness）原生 cordis 插件：Honcho 记忆回环——session 开始 recall 注入 peer 上下文，turn 结束采集 user/assistant 对异步上传 Honcho，失败项留待下次 session 重试。fail-open：任何错误绝不阻塞 dsh 会话。

领域逻辑移植自 [`zcode-plugin-honcho`](../zcode-plugin-honcho) v0.2.3（进程外 hook）；工程形态照抄已验证的 [`dsh-plugin-langfuse`](../dsh-plugin-langfuse)。

## 工作方式

- **capture**：`session/event`（`user/message` → 人写 prompt，first-wins——合成 runtime-context/system-reminder 注入在后；`assistant/message` → 最终回复，last-wins；`turn/end` → 组装 `MemoryTurn` 写入 outbox → 异步 bounded 上传）。默认不收 tool 输入输出。
- **recall**：`agent/created` 时拉取 peer 上下文（peer card + representation，`maxConclusions: 32`），经 `agent.inbox.inject()` 注入为模型可见上下文（`<honcho-recall>` 包裹，source kind `honcho-recall`）。listener 在 agent 创建完成前被 await——recall 在首个模型调用前落地（对齐 zcode SessionStart 语义），且有 3s 预算防止 Honcho 慢拖住首 turn。
- **retry**：outbox 持久化在 `$DSH_HOME/dsh-plugin-honcho/outbox/`（原子写 + 文件锁）；`session/created` 触发 bounded 重试，单条失败不饿死其余（毒丸隔离：损坏条目被扫描跳过）。
- **containment**：所有 handler 自包含（cordis emit 是 stop-on-throw）；`agent/created` listener 绝不 throw（throw 会 fail agent creation）；teardown 走 `ctx.effect(..., "honcho outbox")` drain。

文本红线：capture/recall 都先 `redactSensitiveText`（Bearer/token/api-key 赋值）后截断（`maxCaptureChars` / `maxContextChars`）。

## recall 注入选型（SPEC 调研项）

按 SPEC 候选顺序调研，最终选**候选之外的原生机制**：

| 候选 | 结论 |
| --- | --- |
| ① dsh-system-prompt 贡献接口 | ❌ section 挂全局 ctx 会把某次 recall 泄进所有后续 session 的 system prompt；per-agent 注册需 agent.ctx，与 session/created 时机错位 |
| ② dsh-agent-instructions 式 baseline | ❌ 内建包，baseline 注入机制内嵌请求组装，无对外贡献 API |
| ③ dsh-hook-protocol attach-context | ❌ README 明确 "avoid for bespoke behavior — a native Cordis plugin has the full harness API" |
| **✅ `agent/created` + `agent.inbox.inject()`** | dsh 原生 per-agent 注入通道（file-change notices / skill content 同类）：durable 落 session log、不 wake driver、source-attributed（`kind: "honcho-recall"`，仿 time-context 自报 kind 惯例）、创建期 await 保证首请求前注入 |

recall 失败/超时 → warn + capture-only 继续（降级路径存在但未触发——**已真实验证**：headless profile 实跑，`agent.inject` 注入 lei peer 的真实上下文（38 条 peerCard，8.6k chars → `maxContextChars` 截断）落入 session log（source kind `honcho-recall`），并随下一请求进入模型上下文）。

capture 侧过滤（真实验证发现）：dsh 的 recall/runtime-context 注入以 **user-role 事件**且排在人写 prompt **之前**落 log——tracker 只认 `source.kind === "user"` 的人写消息，否则注入文本会顶替真实 prompt 被上传。

真实冒烟结论（自建 Honcho，`honcho.honcho.example`）：capture → outbox → 上传 → 远端 messages 落库（`peer_id: lei`，`metadata: {source: "dsh", turnId, memoryKey}`）全部实测通过；验证者只需在长会话/多 turn 场景复验。

## 配置

patch row `config`（schemastery，全部默认值）：`baseUrl`（https://api.honcho.dev）、`workspaceId`（无默认）、`peerId`（lei）、`assistantPeerId`（dsh）、`enabled`、`injectContext`、`capturePrompts`、`captureResponses`（均 true）、`maxContextChars`（8000）、`maxCaptureChars`（12000）、`debug`。

## 凭证

`HONCHO_API_KEY` 环境变量 > `$DSH_HOME/honcho.json`（`{apiKey, baseUrl?, workspaceId?, peerId?}`）。**honcho.json 的覆盖字段赢过 patch config**（文件是最新的本机意图）；`workspaceId` 无处可解 → 静默停用（debug 一条 warn）。皆缺 → 静默停用。

## 与 zcode 版的有意偏差

1. 进程内事件订阅 vs 进程外 hook——无 ZCODE_PLUGIN_DATA；outbox 迁到 `$DSH_HOME/dsh-plugin-honcho/outbox/`
2. 配置双通道：patch row `config`（非密）+ env/`honcho.json`（密钥与本机覆盖，覆盖字段赢过 patch）
3. peer 语义不变（与 zcode 共享 workspace/peer 即共享记忆）；Honcho 侧 `source: "dsh"` metadata、honcho session id 前缀 `dsh-` 区分来源
4. `user/message` first-wins（dsh 一个 turn 含合成注入事件，人写 prompt 最先）——zcode hook 单 prompt 无此问题

实现注记：vendored schemastery 无 `.optional()`——`workspaceId` 用裸 `z.string()`（object 字段缺省即可选）。

## 安装

```bash
dsh plugin --profile <profile> add /abs/path/to/dsh-plugin-honcho
```

安装器契约同 langfuse 插件：`dsh.bundle.patch` 清单 + `files` 白名单（缺失则拒绝挂载/丢 lib），`scripts/build.mjs` 已内置两道校验。

## 开发

```bash
pnpm install
pnpm check   # lint + typecheck + test + build（含 pack dry-run 门禁）
```

真实 Honcho 落库冒烟由验证者执行，不在本仓库门禁内。
