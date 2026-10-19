# Changelog

## 0.1.0（首个公开版，2026-10-19 发布）

### 功能

- **原生 LlmAdapter 桥接**：DSH → `opencode run --format json` → OpenCode 兼容模型，
  模型选择器出现 `opencode-bridge` provider（Adapter 合同 + 七方法实现）
- **会话一对一续接**：DSH chat ↔ OpenCode session 绑定，增量 prompt 透传，
  绑定漂移/失效自动回退全量重放
- **切块模拟流式**：OC 整段 text 切块 + 22ms 节奏层（打字机效果），
  reasoning/工具回传映射（reasoning 皮镜像，防双重执行）
- **模型暴露筛选**：OC-bridge 侧边卡片勾选面板，写回 `~/.dsh-opencode-bridge/config.json`
- **CLI 环境检测**：面板常驻状态卡（版本/路径/来源），未安装时给按环境推荐的
  安装命令（npm/scoop/choco 探测）+ 一键复制 + GitHub Releases 下载链接，
  `CLI_NOT_FOUND` 报错与面板建议同口径
- **健壮性**：五层超时、AbortSignal 取消 + Windows 进程树清理（taskkill /T）、
  12 类错误分类、JSON Lines 协议解析（半行/超长行/污染行防护）

### 测试

- `node --test` 单测 239 条全绿（含真实子进程 spawn 路径）
- 真实 CLI 集成测试（`OCBRIDGE_IT=1` 手动开启）R01–R08、R11

### 发布待办（发布前清零，完整操作单见 docs/RELEASE.md）

- [x] 包名定案：**`dsh-opencode-cli-bridge`**（2026-10-19，裸名；因 npm 上已有同赛道
      `dsh-opencode-bridge` / `dsh-opencode-cli` 而弃用近似名），`package.json` /
      `client.js` 模块 id / `cordis.patch.yml` 三处已同步（单测守护一致性）
- [x] 建 GitHub 仓库 **`home-river/dsh-opencode-cli-bridge`**（与包名同），已补
      `repository` / `homepage` / `bugs` 字段
- [x] DSH 版本兼容声明：顶层 `engines.dsh: ">=0.2.1-0 <0.3.0"`（查证结论：宿主只认顶层
      `engines.dsh`、声明后忽略 peer；caret 跨 minor 必拒；`dsh.plugin.json` 属已移除旧机制，无需准备）
- [x] README 截图 + 仓库 `screenshots.json`（已含脱敏处理的 OC-bridge 面板图）
- [ ] 市场收录：GitHub topic `dsh-plugin` + 向 awesome-dsh-plugin 提 YAML 条目 PR
