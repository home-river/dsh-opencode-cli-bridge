# 发布与收录操作单（社区发布用）

> 2026-10-19 经社区生态实查整理（来源见文末）。发布时按顺序执行，勾掉 CHANGELOG「发布待办」。
> **结论与依据**（为什么这么写、坑在哪）见 [`RELEASE-CONCLUSIONS.md`](./RELEASE-CONCLUSIONS.md)。

## 一、发布前硬性检查

- [ ] **包名/仓库名定案**后同步三处（有单测守护一致性）：`package.json.name`、`src/client.js` 的模块 id、`cordis.patch.yml` 的 `name:`；
- [ ] `package.json` 补 `repository` / `homepage` / `bugs` —— **`repository` 必须指回 GitHub 收录仓库**（awesome-dsh-plugin 的 npm 映射靠它自动采集，手写 `npm:` 会被拒）；
- [ ] 兼容声明：顶层 `engines.dsh`（已写 `">=0.2.1-0 <0.3.0"`）；**不要**把范围写成 caret 单段（`^0.1.7` 归一化为 `>=0.1.7 <0.2.0-0`，跨 minor 必拒），**不要**再叠 `@deepseek-ai/dsh` peer（声明了 `engines.dsh` 时 peer 被忽略，只添 ERESOLVE 麻烦）；
- [ ] 仓库根具备：`dsh.bundle.patch` 声明 + `cordis.patch.yml`（`- insert: [{id, name}]`）——收录硬性前提，已具备；
- [ ] README 截图（放自己仓库 `screenshots.json`，1–8 张）。

## 二、npm 发布

```sh
npm pack                                  # 先出 tgz 自检 contents
dsh plugin --profile web add .\home-river-dsh-opencode-bridge-<ver>.tgz   # 干净 profile 冒烟
npm publish --access public               # scoped 包必须带 --access public
git tag v<ver> && git push --tags         # + GitHub Release
```

预构建包直接发 npm 可免 pnpm `allowBuilds` 构建授权摩擦（我们零构建脚本依赖，天然满足）。

## 三、市场收录（DSH 设置 → 插件市场）

1. 仓库打 GitHub topic：**`dsh-plugin`**（收录硬性要求；dshfind 等第三方目录也是按此 topic 每日自动同步）；
2. 向 **awesome-dsh-plugin** 提 PR（**不是** dsh-market，那边明确拒收条目 PR）：
   - 新增 `data/plugins/<owner>__<repo>.yml`，字段：

   ```yaml
   url: https://github.com/<owner>/<repo>       # 须与仓库完全一致
   name: <owner>/<repo>                          # monorepo 子包用 owner/repo#subname
   category: model                               # 枚举二选一：model / tools（按最终定位）
   description.en: "Bridge DSH to OpenCode-compatible models via the local OpenCode CLI."   # 必填、句号结尾
   description.zh: "通过本机 OpenCode CLI 在 DSH 中使用 OpenCode 兼容模型。"                  # 可选
   # tarball: https://github.com/<owner>/<repo>/releases/download/v<ver>/<name>-<ver>.tgz   # 可选
   ```

   - 一个 PR 最多 3 条；README（awesome 列表的）由脚本生成、不要手改；
   - 硬性前提：仓库满 1 天、真实可运行代码、描述属实无营销词；CI 校验格式，维护者人工读源码核对描述。
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
