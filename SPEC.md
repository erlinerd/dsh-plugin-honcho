# SPEC: dsh-plugin-honcho（原生 dsh cordis bundle）

给 dsh 做 Honcho 记忆回环插件，参考两个已验证实现：

- 领域逻辑：`~/code/projects/zcode-plugin-honcho`（v0.2.3，ZCode 进程外 hook：SessionStart recall → 注入；Stop → outbox 落盘 → 上传 Honcho；下次 session start 重试失败上传）
- dsh bundle 形态/构建/安装：`~/code/projects/dsh-plugin-langfuse`（已在本机 headless profile 端到端验证，直接抄工程结构、scripts、patch 挂载方式）

## 功能面（与 zcode 版一致）

1. **recall**：session 开始时拉取紧凑 peer 上下文（bounded）注入会话。
2. **capture**：turn 结束把 user prompt + assistant 最终回复写入本地 outbox，异步上传 Honcho（默认不收 tool 输入输出、不读隐藏推理）。
3. **重试**：下次 session start 重试 outbox 失败项。
4. **fail-open**：hook/网络/状态错误绝不阻塞 dsh 会话（handler 全部 contain 包裹，参考 dsh-plugin-langfuse 的 plugin.ts 模式）。

## 模块契约

### `src/plugin.ts`（默认导出，同 langfuse 插件形态）

```ts
export default class HonchoPlugin extends Service {
  static inject = ["sessions"]
  static Config = z.object({
    baseUrl: z.string().default("https://api.honcho.dev"),
    workspaceId: z.string().optional(),
    peerId: z.string().default("lei"),
    assistantPeerId: z.string().default("dsh"),
    enabled: z.boolean().default(true),
    injectContext: z.boolean().default(true),
    capturePrompts: z.boolean().default(true),
    captureResponses: z.boolean().default(true),
    maxContextChars: z.number().default(8000),
    maxCaptureChars: z.number().default(12000),
    debug: z.boolean().default(false),
  })
}
```

事件接线照抄 dsh-plugin-langfuse：`session/created`（recall + outbox 重试）、`session/event`（turn 组装）、`session/disposed`、`ctx.effect` shutdown drain；全部 contain 包裹。

### `src/credentials.ts`

env `HONCHO_API_KEY` > `$DSH_HOME/honcho.json`（`resolveDshHome()`）的 `{apiKey, baseUrl?, workspaceId?, peerId?}`。皆缺 → 静默停用（debug 一条 warn）。

### `src/honcho-client.ts`

移植 zcode `src/adapters/honcho-sdk-client.ts`（含其 SDK 依赖与调用方式，以 zcode 版为准原样移植：workspace/peer 语义、session 创建、chat 增量上传、context 查询）。

### `src/memory-tracker.ts` + `src/outbox.ts`

- 移植 zcode `application/memory-tracker.ts`：从 canonical session 事件（user/message、assistant/message、turn/end，类型核对 dsh-session lib/types）组装 turn 对。
- outbox：本地 JSON 存储，目录 `$DSH_HOME/honcho-outbox/`，带 file-lock（移植 zcode adapters/file-lock.ts、json-outbox-store.ts），上传成功即出队。
- recall 注入机制为**实现期调研项**，候选按序：dsh-system-prompt 贡献接口 → dsh-agent-instructions 式 baseline 注入 → dsh-hook-protocol attach-context。若 v1 找不到安全注入点，降级 capture-only + outbox 重试，README 注明（降级不算失败，但必须在交付报告中说明选型与原因）。

## 与 zcode 版的有意偏差（写进 README）

1. 进程内事件订阅 vs 进程外 hook——无 ZCODE_PLUGIN_DATA；outbox 迁到 `$DSH_HOME/honcho-outbox/`
2. 配置双通道：patch row `config`（非密）+ env/`honcho.json`（密钥）
3. peer 语义不变（与 zcode 共享 workspace/peer 即共享记忆；默认 assistantPeerId 用 `dsh` 区分来源）

## 测试清单

- tracker：turn 对组装；开关关闭时不采集；截断边界
- outbox：入队/出队/损坏恢复/锁
- client：mock fetch 断言端点、鉴权头、错误不 throw
- credentials：env 覆盖文件；皆缺静默停用
- containment：handler 抛错不外泄

## 完成门

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；构建物可被 headless profile 以 `link:` 方式安装（照抄 dsh-plugin-langfuse 在 `~/.dsh/profiles/headless/package.json` + `cordis.patch.yml` 的挂载方式）。真实 Honcho 落库冒烟由验证者执行。

## 权威参考

- 领域移植源：`~/code/projects/zcode-plugin-honcho/src/`
- dsh bundle 工程范本（已验证）：`~/code/projects/dsh-plugin-langfuse/`（含 SPEC、scripts、cordis.patch.yml、link 安装方式）
- 事件订阅/containment：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-telemetry/lib/index.js`
- 事件类型全集：`@deepseek-ai/dsh-session/lib/types/`
