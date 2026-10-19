# 发布与收录操作单（社区发布用）

> 2026-10-19 经社区生态实查整理（来源见文末）。发布时按顺序执行，勾掉 CHANGELOG「发布待办」。
> **结论与依据**（为什么这么写、坑在哪）见工作区级 [`docs/RELEASE-CONCLUSIONS.md`](../../docs/RELEASE-CONCLUSIONS.md)——跨项目共享知识，放在工作区根 `docs/`（不入 git）。

## 一、发布前硬性检查

- [x] **包名定案：`dsh-opencode-cli-bridge`**（2026-10-19，裸名；npm 上已有同赛道
      `dsh-opencode-bridge`（Vikrant-Aleph）与 `dsh-opencode-cli`（chen44041-star），
      故弃用近似名）——`package.json` / `client.js` 模块 id / `cordis.patch.yml` 三处已同步；
- [x] GitHub 仓库 **`home-river/dsh-opencode-cli-bridge`** 已建（与包名同），
      `repository` / `homepage` / `bugs` 已补——**`repository` 必须指回收录仓库**
      （awesome-dsh-plugin 的 npm 映射靠它自动采集，手写 `npm:` 会被拒）；
- [x] 仓库根 `screenshots.json` 已声明（`["docs/screenshots/oc-bridge-panel.png"]`，
      相对路径、1–8 张；市场详情页展示，未声明时市场会从 README 自动抽取）；
- [ ] 兼容声明：顶层 `engines.dsh`（已写 `">=0.2.1-0 <0.3.0"`）；**不要**把范围写成 caret 单段（`^0.1.7` 归一化为 `>=0.1.7 <0.2.0-0`，跨 minor 必拒），**不要**再叠 `@deepseek-ai/dsh` peer（声明了 `engines.dsh` 时 peer 被忽略，只添 ERESOLVE 麻烦）；
- [ ] 仓库根具备：`dsh.bundle.patch` 声明 + `cordis.patch.yml`（`- insert: [{id, name}]`）——收录硬性前提，已具备；
- [ ] README 截图（放自己仓库 `screenshots.json`，1–8 张）。

## 二、npm 发布

```sh
npm pack                                  # 先出 tgz 自检 contents
dsh plugin --profile web add .\dsh-opencode-cli-bridge-<ver>.tgz   # 干净 profile 冒烟
npm publish                                # 裸名无需 --access public
git tag v<ver> && git push --tags         # + GitHub Release
```

预构建包直接发 npm 可免 pnpm `allowBuilds` 构建授权摩擦（我们零构建脚本依赖，天然满足）。

## 三、市场收录（DSH 设置 → 插件市场）

1. 仓库打 GitHub topic：**`dsh-plugin`**（收录硬性要求；dshfind 等第三方目录也是按此 topic 每日自动同步）；
2. 向 **awesome-dsh-plugin** 提 PR（**不是** dsh-market，那边明确拒收条目 PR）：
   - 新增 `data/plugins/<owner>__<repo>.yml`，字段：

   ```yaml
   url: https://github.com/home-river/dsh-opencode-cli-bridge   # 须与仓库完全一致
   name: home-river/dsh-opencode-cli-bridge
   category: model
   description:
     en: 'Bridge DSH to OpenCode-compatible models via the local OpenCode CLI: native LlmAdapter passthrough, persistent OC sessions with cross-turn tool results, tool mirroring, and a CLI environment check panel.'
     zh: '经本机 OpenCode CLI 在 DSH 中使用 OpenCode 兼容模型：原生 LlmAdapter 透传、OC 会话持久续接（工具结果跨轮可见）、工具镜像回传、CLI 环境检测面板。'
   ```

   - ⚠️ 描述含 `: `（冒号+空格）**必须整体加引号**，否则 YAML 解析成嵌套键；描述只写功能、无营销词，且**必须属实**（维护者对着源码逐句核对，夸大是被打回的主因）；
   - 一个 PR 最多 3 条；README（awesome 列表的）由脚本生成、不要手改；
   - 硬性前提：**仓库满 1 天**（CI 自动核查建仓时间——本仓 2026-10-19 创建，**2026-10-20 起可提 PR**）、真实可运行代码、`dsh-plugin` topic 已挂；CI 格式通过后维护者人工读源码核对描述。
3. 可选：dshbase.com 提交拿「已验证」徽章（CI 干净 profile 实测 `dsh plugin add`）。

## 四、README 安装兜底写法（已内置）

- `dsh: command not found` → `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add <pkg>`；
- 源码/tgz 安装路径；
- 国内镜像不是 README 内联参数，社区做法是 profile 的 `.npmrc` 指 `registry.npmmirror.com`（如 dsh-region 插件），README 提一句即可。

## 来源

- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin （contributing.md：收录流程与 YAML 字段）
- https://github.com/dsh-market/dsh-market （Submit your plugin：收录入口、中国区兜底）
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md （engines.dsh 兼容校验规则）
- dsh-better-sidebar / @opencode2dsh/dsh-plugin 的 npm package.json 与 README（惯例形态、caret 陷阱实例）
