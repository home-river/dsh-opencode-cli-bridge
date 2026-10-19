# 发布要点结论（社区发布生态查证记录）

> 2026-10-19 经社区生态实查整理。本文是**结论与依据**（知识记录），操作步骤见 [`RELEASE.md`](./RELEASE.md)。
> 每条标注「已证实」（有来源实锤）或「未查到」（无证据，勿依赖）。

## 一、DSH 兼容声明规则（决定 package.json 怎么写）

1. **已证实**：`dsh plugin add` 与 profile 启动都做兼容校验，读取顺序是——
   package.json **顶层** `engines.dsh`（SemVer 范围，例 `">=0.2.0 <0.3.0"`）**优先且唯一**；
   未声明才回退检查 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的每个范围
   （须全部匹配，预发布参与匹配）；两者都无则不约束。
2. **已证实**：不兼容的后果——bundle 整包跳过并列入 `skippedBundles`（启动器输出一次），
   普通插件行变 `disabled: true`，安装侧报 `incompatible-version`。
   豁免机制：`dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk`
   （写进 profile 的 `compatibility.json`，插件/DSH 升级均不继承）。
3. **已证实（陷阱）**：0.x 的 caret **不跨 minor**——`^0.1.7` 归一化为 `>=0.1.7 <0.2.0-0`，
   在 0.2.x 宿主上必拒（`includePrerelease: true` 也救不回）。实测案例：单段 `^0.1.7-rc.2`
   在 0.2.0-rc.1 宿主下 12/12 全拒、桌面端显示「异常/不包含任何组件」。
   惯例是显式多段范围或 `*`。
4. **已证实**：peer 校验只看名字为 `@deepseek-ai/dsh*` 的项；
   `peerDependenciesMeta.optional: true` **不豁免**该检查。
5. **已证实（纠偏）**：市场侧兼容预检也以顶层 `engines.dsh` 为准——生态里流传的
   `dsh.engines.dsh`（嵌在 `dsh` 段里）恒为 null，是已修复的 bug 形态，别照抄。
6. **已证实**：@deepseek-ai/* 若作为依赖，官方要求放 peerDependencies 且范围带显式
   预发布分支（如 `>=0.1.0-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0`），否则静默排除所有
   prerelease → ERESOLVE。**我们零 runtime 依赖 @deepseek-ai/*（G9），不写 peer 即无此坑。**

**本包落地**：`engines.dsh: ">=0.2.1-0 <0.3.0"`（下界带 `-0` 收进 0.2.1-rc 线；
上界防 minor 变更），无 peer。

## 二、市场收录机制（怎么进「DSH 设置 → 插件市场」）

1. **已证实**：dsh-market 仓库只是市场 **App**、不是目录——插件列表来自 curated 的
   **awesome-dsh-plugin** 注册表。收录 = 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 **PR**，
   合并后网站与插件市场自动收录（通常一天内）；dsh-market 明确拒收条目 PR。
2. **已证实**：收录物 = `data/plugins/<owner>__<repo>.yml` 一个 YAML 条目，字段：
   `url`（须与仓库完全一致）、`name`（owner/repo；monorepo 子包用 `owner/repo#subname`）、
   `category`（23 个枚举值）、`description.en`（必填、句号结尾）、`description.zh`（可选）、
   可选 `tarball:`（GitHub Release 托管的 https .tgz）。一个 PR 最多 3 条；
   awesome 列表 README 由脚本生成，不可手改。
3. **已证实**：收录硬性前提——package.json 声明 `dsh.bundle`（**只写 `dsh.client` 是最常见
   被拒原因**）+ 仓库根 `cordis.patch.yml`（`- insert: [{id, name}]`）；仓库满 1 天、
   真实可运行代码、活跃维护、**GitHub topic `dsh-plugin`**、描述属实无营销词。
   CI 校验格式，维护者人工读源码核对描述。
4. **已证实**：GitHub topic `dsh-plugin` 是**收录要求**，不是官方自动同步机制；
   按 topic 每日自动同步的是第三方目录（dshfind 插件超市等）。
5. **已证实**：npm 映射由 registry 自动采集——包的 `repository` 字段**必须指回收录仓库**，
   yml 里手写 `npm:` 会被拒。截图放自己仓库 `screenshots.json`（1–8 张）。
6. **已证实**：DSH 0.2.1+ 可在 Plugins → Discover → Index sources 加
   `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 作为索引源（多一个曝光入口）。
7. **未查到 → 无需准备**：`dsh.plugin.json` 属已移除的旧 plugin-registry 机制，
   现行宿主与市场均无读取证据，不要按它做发布物。

**本包现状**：`dsh.bundle.patch` + `cordis.patch.yml` 两个硬性前提已具备 ✅；
待办只剩 YAML 条目 PR、topic、`repository` 字段、截图。

## 三、社区 package.json 惯例（两个对标实测）

| 项 | dsh-better-sidebar@0.28.0 | @opencode2dsh/dsh-plugin@0.3.10 |
|---|---|---|
| `dsh` 段 | `bundle.patch` + `client.{inject,platform:"web"}` + `manifestVersion:1` + `icon` | `bundle.patch` + `client.{inject,platform,external}` |
| exports | `.` + `./client` 等子路径 | `.`,`./client`,`./cordis.patch.yml`,`./package.json` |
| files | 构建产物 + patch + README + locale | lib + patch + README + LICENSE |
| engines | 仅 `node>=20` | 仅 `node>=20` |
| peer | 13 个 `@deepseek-ai/*` 锁步 `^0.2.1-rc.1` | **无 @deepseek-ai peer**（宿主包进 devDeps） |
| 构建摩擦 | 无构建脚本依赖 | `pnpm.ignoredBuiltDependencies` 关传递构建 |

- **已证实**：发 npm 预构建包可免 pnpm `allowBuilds` 授权摩擦；零构建脚本依赖是卖点。
- **已证实**：版本对照表是惯例——README 给「你的 DSH 版本 → 装哪个插件版本」表，
  旧宿主 pin 精确版本、勿用 `latest`。

## 四、安装兜底写法（国内用户）

1. **已证实**：`dsh: command not found` → `npx -y --package @deepseek-ai/dsh dsh plugin ...`；
   另给源码 `npm pack` + `dsh plugin add ./*.tgz` 路径。
2. **已证实**：npm 镜像兜底的实际形态是 **profile 的 `.npmrc`**（指 `registry.npmmirror.com`，
   主备源自动切换，如 dsh-region 插件），不是 README 内联 `--registry` 参数；
   未找到社区 README 写内联镜像命令的实例。
3. **已证实**：dsh-market 自带中国区兜底（npm 镜像优先、GitHub 加速前缀 `DSHM_GITHUB_PROXY`、
   目录镜像 `DSHM_REGISTRY_URL`）。

## 来源

- https://github.com/awesome-dsh-plugin/awesome-dsh-plugin （contributing.md）
- https://github.com/dsh-market/dsh-market （Submit your plugin；issue #577 / #404）
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md
- dsh-app-boot README（evaluatePluginCompatibility / skippedBundles / allow-version）
- dsh-better-sidebar、@opencode2dsh/dsh-plugin 的 npm package.json 与 README
- hyzyn/dsh-codegraph、@cowwo/dsh-model-fit README（caret 陷阱与 ERESOLVE 实锤案例）
