# DSH 插件接入合同调研：dsh-opencode-bridge LlmAdapter（只读）

调研对象：`F:\Program Files (x86)\DSH\resources\app.asar`（发行版打包文本，行号均指该文件）。
方法：grep 定位锚点 + `node tmp-asar-extract.mjs <start> <end> <out>` 抽取原文。
所有引用均为 asar 内原文短摘录 + 行号；未找到的条目显式写「未找到」。

---

## 1. 插件模块导出形态

### 1.1 官方文档规定的两种 Host 导出形态

cordis 插件开发技能文档（Host 插件导出形态章节）：

- 行 292559｜`index.js` exports one of these forms; do not mix them:`
- 行 292561｜`- \`export function apply(ctx, config) {}\` with optional \`export const inject = ['tools']\` and \`export const Config\`.`
- 行 292562｜`- A service class as the default export.`
- 行 292564｜`Register every resource inside \`apply\` with \`ctx.effect\` or \`ctx.on\` and return its cleanup. A plugin that declares \`Config\` validates the row's \`config\` at activation; query \`Config.listConfigs\` for an installed plugin's schema before writing its \`config\`, and follow \`$defs\` references in the returned document.`

结论：Host 插件入口是「具名导出 `apply`（可选 `inject`、`Config`）」或「默认导出 service class」二选一，不可混用。

### 1.2 参考 adapter 插件的真实导出（逐字）

`@deepseek-ai/dsh-llm-deepseek-account`（编译产物 `lib/index.js` 段）：

- 行 855428｜`const name = "llm-deepseek-account";`
- 行 855429｜`const inject = ["llm"];`
- 行 855431｜`function apply(ctx, config) {`
- 行 855481｜`export { Config, apply, inject, name };`

`@deepseek-ai/dsh-llm-deepseek-api-key`：

- 行 855791｜`const name = "llm-deepseek-api-key";`
- 行 855792｜`const inject = ["llm"];`
- 行 855794｜`function apply(ctx, config) {`
- 行 855826｜`export { Config, apply, inject, name, plainOptions, resolveAdapterOptions };`

`@deepseek-ai/dsh-llm-pi-ai`：

- 行 861893｜`const name = "llm-pi-ai";`
- 行 861894｜`const inject = ["llm"];`
- 行 861934｜`function apply(ctx, config) {`
- 行 862042｜`export { Config, PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols };`

（额外导出可有可无；核心四件套是 `name`/`inject`/`Config`/`apply`。技能文档的模板写法是 `export function apply(ctx, config)`，与编译产物的 `function apply(...); export { apply }` 等价。）

### 1.3 `inject` 应包含什么才能拿到 `ctx.llm`

- 三个 adapter 插件一致：行 855429 / 855792 / 861894｜`const inject = ["llm"];`
- 服务键名：行 866279｜`"key": "llm",`；行 866280｜`"exportName": "LlmRuntime",`
- 服务描述：行 866275｜`The abstract \`llm\` service: an adapter registry plus a streaming model-call API, interceptable via the \`llm/stream\` waterfall.`
- 实例注册：行 865489｜`super(ctx, "llm");`

结论：要拿到 `ctx.llm`，Host 插件导出 `export const inject = ["llm"]`（可按需再并列 `"settings"`、`"sessions"` 等；`registerDeepSeekProvider` 内部另用 `ctx.inject(["settings"], ...)` 做可选注入，见 1.5）。技能文档对可选服务的建议：

- 行 292595｜`- Put optional services in \`inject\` or \`ctx.inject([...], ...)\` so the plugin stays inactive in profiles without them instead of throwing.`

### 1.4 `apply(ctx)` 里如何注册 adapter（含句柄生命周期/销毁）

`ctx.llm.registerAdapter` 的服务端定义与 JSDoc：

- 行 866285｜`"signature": "registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle",`
- 行 866287｜`"jsDoc": "/**\n * Register an adapter for the given provider routes. Throws \`LlmError\` with code\n * \`DUPLICATE_ADAPTER\` if any provider already has an adapter (all-or-nothing).\n * Disposed with the fiber.\n * @param providers - every provider route this adapter should serve.\n * @param adapter - the adapter that streams calls for those providers.\n * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.\n */"`
- 行 866390–866391｜`"name": "AdapterRegistrationHandle",` / `"declaration": "export interface AdapterRegistrationHandle {\n    (): void;\n    replace(providers: string[]): void;\n}"`

实现（LlmRuntime.registerAdapter）：

- 行 865521｜`registerAdapter(providers, adapter) {`
- 行 865524｜`const dispose = this.ctx.effect(function* () {`
- 行 865525｜`if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");`
- 行 865533｜`}.bind(this), "llm.registerAdapter()");`
- 行 865534–865538｜`const handle = (() => void dispose());` / `handle.replace = (next) => { ... this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned)); };`

DeepSeek 参考插件的调用与热更新：

- 行 858674｜`function registerDeepSeekProvider(ctx, provider, dependencies) {`
- 行 858695｜`const registration = ctx.llm.registerAdapter([provider], adapter);`
- 行 858697｜`ctx.on("loader/volatile-update", () => {`
- 行 858706｜`registration.replace([provider]);`

pi-ai 多路由版本（惰性注册 + 变更替换）：

- 行 862021–862027｜`if (registration === void 0) { if (routes.length === 0) { ... return; } registration = ctx.llm.registerAdapter(routes, adapter); } else registration.replace(routes);`
- 行 862031｜`ctx.on("loader/volatile-update", () => { ... ensureRegistrationFacts(); ensureDirectory(); ... });`

生命周期结论（均有原文）：

1. 注册发生在 `apply(ctx, config)` 内，直接调 `ctx.llm.registerAdapter([route], adapter)`；句柄同时是 disposer（`handle()`）与 `replace(routes)` 的载体。
2. 服务端把它包在 `ctx.effect(..., "llm.registerAdapter()")` 里，JSDoc 明说 `Disposed with the fiber.` —— 即插件 fiber 卸载/HMR 时自动回收，参考插件没有手动调 `registration()` 销毁；它们只保留句柄做 `replace`。
3. 路由变化（settings/volatile 配置变化）通过 `loader/volatile-update` 监听 + `registration.replace(routes)` 原子换路由集；重复路由注册会以 `DUPLICATE_ADAPTER` 失败（行 866287）。
4. 也可延迟注册：pi-ai 在零路由时先不注册（行 862022–862025），配置补上路由后再注册。

### 1.5 Config schema 如何导出、如何读取

Config 是 schemastery `z.object(...)`，随 `export { Config, ... }` 导出：

- deepseek 共享字段：行 856738–856749（`const deepSeekConfigFields = { baseURL: z.string().volatile(), thinking: ..., reasoningEffort: ..., maxTokens: ..., models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(), ... }`）；行 856763｜`const Config = z.object(deepSeekConfigFields);`
- api-key 插件叠加：行 855764–855767｜`const Config = z.object({ ...deepSeekConfigFields, apiKeyEnv: z.string().role("credential-ref").default("DEEPSEEK_API_KEY").volatile() });`
- pi-ai：行 860454｜`const Config = z.object({ providers: z.dict(profile).default({}).volatile() });`
- account 插件直接复用：行 855425｜`const Config = Config$1;`

运行时读取（volatile 引用用 `.get()`；或批量解引用）：

- 行 856722–856723｜`function plainOptions(config) { return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value])); }`
- 行 855772–855776｜`function plainOptions(config) { ... apiKeyEnv: config.apiKeyEnv.get() ... }`
- 直接 `.get()` 的例子：行 1073019–1073024（`config.apiKey.get()` / `config.baseURL.get()` / `config.model.get()` ...）

补充：`apply` 中可对配置做即时校验（pi-ai 行 861958｜`profiles();` —— 首次调用即在激活时抛出非法配置）。

---

## 2. 打包与安装合同

### 2.1 `package.json`：`dsh.bundle.patch`、`exports`、`files` 的准确形态

技能文档给出的最小 Host bundle manifest（行 292520–292527）：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

（行 292513｜`A bundle is a package whose \`package.json\` declares \`dsh.bundle.patch\`; the YAML patch inserts plugin entries. ... Read an existing patch before editing it: a matching override replaces the complete \`config\`.`）

带 icon/locale 的清单补充（行 292547–292552）：`"icon": "./icon.svg",`、`"exports": { "./package.json": ..., "./locale/*.json": ... },`、`"files": ["locale/*.json", "icon.svg"]`。

`dsh.bundle.patch` 的取值合同（行 356344）：`A bundle's \`dsh.bundle.patch\` names one patch file or an ordered list of files; \`bundlePatchFiles\` validates the declaration and \`bundlePatchPaths\` resolves it to absolute paths; the layer concatenates their patch lists in that order.`（校验实现见行 357229：`if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");`）

真实 bundle 的完整形态（`@deepseek-ai/dsh-base`，即基底组合包）：

- 行 366924–366931｜`"exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }, "./cordis.patch.yml": "./cordis.patch.yml", "./src/*": "./src/*", "./package.json": "./package.json" },`
- 行 366933–366937｜`"files": [ "lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts" ],`
- 行 366939–366943｜`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } },`

参考 adapter 包（非 bundle、纯 Host 插件）的 `exports`/`files`（`@deepseek-ai/dsh-llm-deepseek`，行 858727–858738）：

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
},
"files": [ "lib/index.js", "lib/types/**/*.d.ts" ],
```

（api-key 包同形：行 855497–855508；`main: "lib/index.js"` / `types: "lib/types/index.d.ts"` 见行 855495–855496。）

安装动作（技能文档，行 292468 与 292755）：`plugin_manager` 用 `action: install_bundle`、`target` 为绝对包目录；`It runs package installation and bundle selection itself; do not reproduce those steps with shell commands.`

### 2.2 `cordis.patch.yml` 中插入 LLM adapter 插件行的真实例子（逐字）

基础 profile 的真实行（`packages/bundle/base` 的 cordis.patch.yml 段）：

```yaml
# 行 366899-366904（注释 + 行本体）
# The native DeepSeek adapter. No key or endpoint is inlined: both resolve per
# request from the `llm-deepseek:` settings section over this entry, with the
# key coming from the credential store below. Thinking defaults are a deployment
# choice.
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'

# 行 366906-366907
- id: llm-deepseek-account
  name: '@deepseek-ai/dsh-llm-deepseek-account'

# 行 366505-366506（pi-ai 多路由 twin，裸挂载）
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
```

README 里带 `config` 的真实行例（逐字）：

- 行 855631–855637（api-key README）：
  ```yaml
  - id: llm-deepseek
    name: '@deepseek-ai/dsh-llm-deepseek-api-key'
    config:
      reasoningEffort: high
      apiKeyEnv: DEEPSEEK_API_KEY
  ```
- 行 859050–85982（pi-ai README，节选结构）：
  ```yaml
  - name: '@deepseek-ai/dsh-llm-pi-ai'
    config:
      providers:
        openai:
          apiKeyEnv: OPENAI_API_KEY
          baseURL: https://proxy.example.com:8443
          reasoning: high
          retryPolicy:
            mode: normal
            maxRetries: 3
        anthropic:
          apiKeyEnv: ANTHROPIC_API_KEY
          models:
            - id: claude-sonnet-4-5
              contextWindow: 200000
  ```
- 行 863372–863377（最小组合，服务 + adapter）：
  ```yaml
  - name: '@deepseek-ai/dsh-llm'
  - name: '@deepseek-ai/dsh-llm-deepseek-api-key'
    config:
      apiKeyEnv: DEEPSEEK_API_KEY
  ```
- 通用插入模板（技能文档，行 292532–292537）：
  ```yaml
  - insert:
      - id: my-plugin
        name: '@local/my-plugin'
        config: {}
  ```

字段语义：行 `id` 是 Cordis entry id（也是 settings namespace 的默认取值，见 2.3），`name` 是包名，`config` 整块即插件 `Config` schema 解析的 `row.config`（技能文档行 292513 提醒：同 id 覆盖会整体替换 `config`）。

### 2.3 config（如 baseURL/models）如何在行里声明、插件如何读取

声明侧：一切进 `config:` 块，键名 = `Config` schema 字段名（如 `baseURL`、`apiKeyEnv`、`models`、`reasoningEffort`）。真实例子见 2.2 各段；字段穷尽来源是生成的 configuration catalog（行 856065｜`The generated [configuration catalog](...) is the exhaustive source for every accepted field and its JSDoc.`；行 856104 提到从 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 的 `llm-deepseek` entry 的 `config` 中删字段）。

读取侧：schema 声明 `.volatile()` 的字段在 `apply` 内用 `config.<field>.get()` 解引用（行 856722–856723 的 `plainOptions`、行 855775 `apiKeyEnv: config.apiKeyEnv.get()`、行 1073020 `baseURL: config.baseURL.get()`）；`models` 走同一机制（行 856749｜`models: z.array(catalogModel).default(DEFAULT_MODELS).volatile(),`）。

settings namespace 关联（GUI Models 页写入的 `llm-deepseek:` 段 ↔ entry id）：行 855641｜`The settings namespace is the Cordis entry id, or the plugin name without an entry.`；插件侧注册可配置路由时：行 855809–855813｜`ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "DeepSeek", settingsNs: ctx.fiber.entry?.options.id ?? "llm-deepseek-api-key", settingsPath: [] }]);`

配置热更新：volatile-only 变更发 `loader/volatile-update`（行 272364 描述 `_commitVolatile` → `emits \`loader/volatile-update\` to the owning fiber`），插件监听后 `registration.replace(...)`（行 858697/858706、862031/862027）。完整 schema 校验可在激活期查询：行 292490｜`a mounted plugin's Config JSON Schema (\`Config.listConfigs\`: filter the paged directory by \`name\`, then query the \`entry\` id)`。

---

## 3. ctx 服务面（会话/工作区/项目目录相关）

### 3.1 `GenerateOptions` 本身不带 workspace（事实）

行 866475｜`"declaration": "export interface GenerateOptions {\n    provider: string;\n    model: string;\n    reasoningEffort?: ReasoningEffortId;\n    messages: RequestMessage[];\n    system?: string;\n    tools?: ToolSchema[];\n    toolHistory?: ToolHistory;\n    temperature?: number;\n    maxTokens?: number;\n    stop?: string[];\n    signal?: AbortSignal;\n    sessionId?: Branded<'SessionId'>;\n    purpose?: 'compaction' | 'session-title';\n}"`

→ 无 `cwd`/`workspace`/`project` 字段；**唯一可用的关联键是 `sessionId`**（可选）。grep `GenerateOptions.*cwd`、`adapter.*workspace` 未找到任何 adapter 侧 workspace 传递路径（未找到）。

### 3.2 与「当前会话/工作区/项目目录」相关的宿主服务（签名摘录）

1. `ctx.sessions`（in-memory session store）
   - 服务描述：行 1016072–1016074｜`key: 'sessions'` / `summary: 'In-memory session store (\`ctx.sessions\`).'`
   - 行 1016118｜`signature: 'get(id: SessionId): Session | undefined'`（`description: 'Look up a live session.'`）
   - 行 1016124｜`signature: 'list(): Session[]'`
   - 行 968665｜`super(ctx, "sessions");`
   - `Session` 对象暴露 header（含 cwd）：行 290272｜`"declaration": "export class Session {\n ... readonly header: SessionHeader;\n ... get id(): SessionId; ... deriveMessages(): Message[]; ... }"`
   - `SessionHeader` 形状：行 290288｜`"declaration": "export interface SessionHeader {\n    readonly version: ...;\n    readonly id: SessionId;\n    readonly createdAt: number;\n    readonly cwd?: string;\n ... }"`

2. `ctx.workspaceRegistry`（durable workspace registry）
   - 服务描述：行 1017402–1017404｜`key: 'workspaceRegistry'` / `summary: 'Durable workspace registry.'`
   - 行 1017419｜`signature: 'get(id: WorkspaceId): Workspace | undefined'`
   - 行 1017425｜`signature: 'list(): Workspace[]'`（`description: 'Synchronous workspace projection in durable registry order. Every entity\'s \`sessionIds\` getter is already filtered by the startup/live canonical-cwd header index; ...'`）
   - 行 1017407｜`signature: 'async create(path: string, title?: string): Promise<Workspace>'`
   - `Workspace` 形状：行 1021734｜`"declaration": "export interface Workspace {\n    readonly id: WorkspaceId;\n    readonly path: string;\n    readonly title: string;\n ... readonly sessionIds: readonly SessionId[];\n ... }"`
   - 类实例化：行 1081840｜`super(ctx, "workspaceRegistry");`；行 1081821｜`static inject = ["storageDomain", "sessionPersistence"];`
   - 会话→路径索引（内部 host API）：行 1081830–1081837｜`host = { ... sessionPath: (id) => this.sessionPaths.get(id), readSessionHeader: (id) => ... }`（只读 grep 未发现该 `host.sessionPath` 被外部插件直接调用的公开用例；仅 registry 自身行 1081569/1081644 使用。→ **外部插件经公开方法拿「会话→workspace」的路径：`ctx.workspaceRegistry.list()` 后按 `sessionIds.includes(sessionId)` 过滤**，真实用例见行 1074999｜`const owners = ctx.workspaceRegistry.list().filter((workspace) => workspace.sessionIds.includes(session.id));`）

3. 其他相关服务（仅列出，方法签名与本题相关的摘录）
   - `ctx.fs`：行 1014785｜`signature: 'processPathFromHostPath(hostPath: string): string | undefined'`（参考 adapter 用于把宿主路径映射进执行世界，行 858689｜`resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),`）
   - `sessionController`（`session` 命名空间）：行 339220｜`super(ctx, 'sessionController', { namespace: 'session' });`；其 `static inject` 含 `'sessions'`、`'workspaceRegistry'` 等（行 339187–339199）
   - `ctx.get("attachments")`、`ctx.get("credentials")`、`ctx.get("settings")` 均被参考插件使用（行 858688、855799、858675）
   - `sandbox`/`project` 名称的独立服务：grep `super(ctx, "sandbox")` / `class ProjectRegistry` → **未找到**（sandbox 以 policy/backends 形式存在，见行 907489 等 `workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`，但非以 `ctx.project` 形式暴露）

### 3.3 重点：adapter 如何拿到「当前聊天的工作区路径」——可行途径（按证据强度排序）

- **途径 A（宿主既有模式，最贴合）**：在插件自己的 `ctx.on("llm/stream", (options, next) => ...)` waterfall 里用 `options.sessionId` 反查会话再取 `header.cwd`。宿主插件的真实写法（`@deepseek-ai/dsh-agent-loop` 不变式插件，inject `["invariants","sessions"]`）：
  - 行 287611｜`if (options.sessionId === void 0) fail("a loop-built request must carry a session id");`
  - 行 287612–287613｜`const session = ctx.sessions.get(options.sessionId); if (!session) fail(...);`
  - 另一例（checkpoint 插件）：行 922894–922897｜`ctx.on("llm/stream", (options, next) => { if (options.sessionId === void 0) return next(); const session = ctx.sessions.get(options.sessionId); return session === void 0 ? next() : afterCheckpoint(ctx, session, next); });`
  - 取 cwd：行 287178｜`ctx.systemPrompt.variable("cwd", (context) => context.agent?.session.header.cwd);`；行 840633｜`const workdir = opts.agent?.session.header.cwd;`；行 1023038｜`const workdir = exec.agent?.session.header.cwd ?? process.cwd();`
  - caveat：`GenerateOptions.sessionId` 是**可选**的（行 866475），且非 agent-loop 的直呼（`ctx.llm.stream()` 裸调，见行 862230 描述 `Skip it when calls go through ctx.llm.stream() directly without the agent loop`）可能不带 sessionId —— 参考插件的处理是「没有就跳过/失败由调用方承担」，没有全局兜底。
- **途径 B（workspace registry，会话→已注册 workspace 路径）**：`ctx.workspaceRegistry.list().filter(w => w.sessionIds.includes(sessionId))`（行 1074999 的真实宿主用法；`Workspace.path` 即目录绝对路径，行 1021734）。仅覆盖「已注册进 workspace registry」的会话；registry 的成员资格规则见行 1081569｜`return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);`（cwd 与 workspace path 不一致会被过滤，行 1082372｜`canonical cwd '${path}' differs from workspace path '${record.path}'`）。
- **途径 C（完全未找到）**：`ctx.llm` / adapter 基类 / `GenerateOptions` 里直接提供 workspace 或 cwd 的字段或方法 —— **未找到**（grep `GenerateOptions.*cwd`、`adapter.*workspace`、`stream.*workspace` 无匹配）。也就是说 LlmAdapter 侧必须自行经 `sessionId` → `ctx.sessions` / `ctx.workspaceRegistry` 反查；README 与类型声明中均无官方「adapter 拿 cwd」API。

---

## 4. 参考 adapter 插件的文件布局 / StreamChunk 流转 / listModels

### 4.1 文件布局（README Source map 逐字摘录）

`@deepseek-ai/dsh-llm-pi-ai`（行 859046–859061，`### Source map` 表格）：

| 行 | 文件 | 职责（原文） |
|---|---|---|
| 859050 | `src/index.ts` | `Config snapshots, directory and route registration` |
| 859051 | `src/auth.ts` | `The credential store and ambient auth context over the harness credential plane` |
| 859052 | `src/login.ts` | `Authorization flows for the installed providers that ship a login` |
| 859053 | `src/config.ts` | `Profile schema, resolution, and serviceability checks` |
| 859054 | `src/catalog.ts` | `Installed-catalog integration and drift gates` |
| 859055 | `src/models.ts` | `Model collections, static providers, and reasoning levels over narrow pi-ai entry points` |
| 859056 | `src/provider.ts` | `The supported-protocol table and provider construction` |
| 859057 | `src/context.ts` | `Harness-to-pi-ai context conversion, image handling, replay restore` |
| 859058 | `src/stream.ts` | `pi-ai event conversion into harness \`StreamChunk\` values` |
| 859059 | `src/replay.ts` | `Versioned \`ReplayEnvelope\` storage and validation` |
| 859060 | `src/discovery.ts` | `Endpoint interrogation for configuration surfaces` |

`@deepseek-ai/dsh-llm-deepseek`（行 856126–856128，`### Source map` 正文）：

- 行 856128｜``[`src/index.ts`](src/index.ts) exports the protocol library; [`src/host.ts`](src/host.ts) binds shared Host services for provider plugins. [`src/adapter.ts`](src/adapter.ts) owns the request lifecycle; [`src/serialize.ts`](src/serialize.ts) and [`src/translate.ts`](src/translate.ts) map model input and streamed output. [`src/file-store.ts`](src/file-store.ts) owns upload reuse and recovery through [`src/files-api.ts`](src/files-api.ts).``

`@deepseek-ai/dsh-llm`（服务本体，行 863422–863436 `### Source map`）：`src/index.ts`（LlmRuntime）、`src/types.ts`（StreamChunk 协议）、`src/assembler.ts`（BlockAssembler）、`src/assistant-stream.ts` 等 —— 行 863427｜`| [\`src/types.ts\`](src/types.ts) | The \`StreamChunk\` protocol, content-block map, finish reasons, and shared vocabulary |`

（注意：README 引用的是**源码仓**路径 `packages/llm/llm-pi-ai/src/*.ts`；发行版安装包只带 `lib/index.js` + `lib/types/**/*.d.ts`（见 2.1 `files`），技能文档也明确：行 292492｜`installed packages ship built \`lib/index.js\` and \`lib/types/**/*.d.ts\` ... not \`src/\``。）

### 4.2 上游事件 → StreamChunk 的流转（两个参考实现）

StreamChunk 协议（行 866666–866667）：

`"declaration": "export type StreamChunk = { type: 'block-start'; index: number; blockType: ContentBlockType; } | { type: 'text-delta'; ... } | { type: 'reasoning-delta'; ... } | { type: 'tool-call-delta'; ... } | { type: 'block-end'; ... } | { type: 'usage'; usage: TokenUsage; } | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope; };"`

- **pi-ai（`src/stream.ts` 对应产物）**：行 860861–860872｜`/** Translate the pi-ai event stream into StreamChunks. pi-ai never throws mid-stream — failures arrive as \`error\` events, which become error/aborted \`finish\` chunks ... */` + `async function* toStreamChunks(events, contextWindow, callerSignal, requestedModel) {`；映射示例：行 860877–860881（`case "text_start": yield { type: "block-start", ... }`）、行 860962–860972（`case "done": yield { type: "usage", ... }; yield { type: "finish", reason: ..., replayState: ... }; return;`）、行 860987（`throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");`）
- **DeepSeek（direct-fetch SSE）**：行 858338–858343｜`/** Translate decoded SSE data into the Harness stream protocol. @param events - framed, decoded provider events in arrival order. @param model - requested model id stored in durable replay state. @returns blocks, one final usage value, and exactly one terminal finish. */ async function* translate(events, model) {`；wire 流程：行 856132｜`One \`stream()\` call normally makes one model request: ... fetch from the resolved \`baseURL\`, ... and translate the SSE stream into the harness protocol.`；调用点：行 858649｜`yield* translate(parseSse(response.body, activity), options.model);`
- 两个 adapter 的类定义：pi-ai 行 861153｜`var PiAiAdapter = class extends LlmAdapter {`，`stream(options)` → `streamWithSnapshot`（行 861241–861244）；DeepSeek 行 858498｜`var DeepSeekAdapter = class extends LlmAdapter {`，`prepareCall` 返回 `{ model, stream }`（行 858528–858530）
- 基类契约（行 865352–865356）：`Provider-wire adapter for the harness message and stream vocabulary. Register implementations with \`ctx.llm.registerAdapter(providers, adapter)\`. Every provider HTTP request must include \`attributionHeaders()\`; ...`；类型（行 866499）：`abstract class LlmAdapter { ... listModels(_provider: string): Promise<readonly LlmModelInfo[]>; ... abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>; }`
- 消费侧保证（行 863379）：`A stream returns token-level chunks and always ends with one terminal \`finish\` chunk.`；行 863451｜`**Protocol ordering** — \`usage\` precedes \`finish\`, tool arguments stay raw JSON strings, and nothing follows the terminal \`finish\`.`

### 4.3 模型目录（listModels）两层

- **adapter 层**：基类默认返回空（行 865394–865395｜`listModels(_provider) { return Promise.resolve([]); }`，JSDoc 行 865386–865393：`List models this adapter can currently advertise for one owned provider. ... the base empty catalog offers no GUI selection.`）。DeepSeek 实现（行 858519–858521）：`async listModels(provider) { return this.dependencies.discoverModels?.(provider) ?? []; }`；pi-ai 实现（行 861201–861211）：从 snapshot catalog 映射 `{ provider, id, name, inputModalities }`。
- **runtime 层（`ctx.llm.listModels`）**：签名行 866355｜`"signature": "async listModels(provider: string): Promise<LlmModelInfo[]>,"`；实现行 865761–865775（委托 `this.registration(provider).adapter.listModels(provider)` 并校验 `provider` 匹配、id/name 非空、去重，否则抛 `INVALID_CATALOG`）；GUI 依赖（行 863360）：`The GUI requires catalog membership for selection and submission; adapters intended for GUI use must implement \`listModels\` ...`
- 目录条目的宿主读法（README，行 856042）：`Clients, including model discovery tools, can read the advisory entries through \`ctx.llm.listModels('deepseek-official')\`.`

---

## 附：明确「未找到」的项

- adapter 基类或 `GenerateOptions` 中直接携带 workspace/cwd/project 的字段或 API：**未找到**（grep `GenerateOptions.*cwd`、`adapter.*workspace path`、`stream.*workspace` 均无 adapter 侧匹配）。
- 以 `ctx.project` / `ProjectRegistry` 形式暴露的「项目目录」服务：**未找到**（仅 `projectRoot` 探测函数与 `workspaceRegistry`）。
- 发行版安装包内 `src/*.ts` 源文件：**未找到**（仅 README 中引用的源码仓路径；安装包只有 `lib/index.js` 与 `lib/types/**/*.d.ts`，行 292492、858735–858738）。
- `ctx.workspaceRegistry.sessionPath(id)` 作为公开服务方法：**未找到**（仅 registry 内部 `host.sessionPath`，行 1081832/1082793；外部公开用法是 `list()` + `sessionIds.includes(...)`，行 1074999）。
- 参考 adapter 文档中出现的「opencode-bridge」相关现成插件：**未找到**（`opencode` 仅作为 pi-ai 上游 provider 数据存在，行 1106081–1106099；与本调研的 DSH 接入层合同无关）。
