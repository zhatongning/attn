# Attn

[English](README.md) | [简体中文](README.zh-CN.md)

[下载最新构建](https://github.com/zhatongning/attn/releases/latest) | [全部构建版本](https://github.com/zhatongning/attn/releases)

> 面向需要人工决策、检查或恢复的 Codex 会话的本地 macOS 关注面板。

Attn 是一个面向同时处理多个 Codex 会话的用户的轻量常驻状态面板。它将本地会话证据归纳为一个问题的答案：**我现在是否需要处理这个会话？**

这是一个供本地使用的 MVP。它主要面向 Codex Desktop，并通过 iTerm 提供有限的 Codex CLI 跳转支持。

## 解决的问题

多个 Agent 会话并行运行时，重要节点很容易被忽略：

- Agent 正在等待结构化输入、确认或其他人工介入。
- 任务已经完成，需要在上下文尚新的时候检查结果。
- 运行在收到完成信号前已经停止。
- 会话看似仍在执行，但现有证据不完整或数据源已降级。

Codex 有用的会话历史，但没有提供一个本地、可操作的关注清单来处理这些情况。Attn 将相关的本地信号集中到一个紧凑面板中，同时避免成为一个完整的会话仪表盘。

## Attn 的能力

- 观察本地 Codex 会话，并只在紧凑悬浮面板中展示父会话。
- 将会话归类为 `blocked`、`attention`、`inspect`、`running`、`follow-up`、`stopped` 或 `idle`。
- 将需要处理的行排在安静上下文之前，并支持在需要时展开面板查看更多条目。
- 支持 Jump back、置顶、忽略和恢复操作。
- 桌面端来源的会话跳转到精确线程；CLI 来源的会话如果由 Codex Desktop 持有，也会跳转到桌面端，否则聚焦匹配的 iTerm 活动会话，或在 iTerm 中恢复该 CLI 会话。
- 每五秒刷新一次，并在 macOS 的所有空间中保持面板可见。
- 支持拖动面板，或通过 macOS 应用菜单定位唯一的面板窗口。

## 快捷键

| 操作 | macOS 默认快捷键 |
| --- | --- |
| 展开或收起面板 | **Control-Command-9**（`⌃⌘9`） |
| 按顺时针顺序轮换面板的四个角落位置 | **Control-Command-P**（`⌃⌘P`） |

两个快捷键都可在其他应用获得焦点时使用，并可在 **Attn -> 设置** 中自定义或禁用。升级会保留已保存的快捷键；要采用新默认值，请分别恢复面板快捷键和位置快捷键的默认值，再应用设置。

## 工作原理

Attn 组合多个本地证据源，而不会把单个时间戳当作确定结论：

| 来源 | Attn 的用途 |
| --- | --- |
| Codex hooks | 在可选 hooks 已安装时，提供会话正在活动的强实时证据。 |
| Codex 会话 JSONL | 提供完成、停止和结构化输入等持久任务事件。 |
| Codex SQLite 线程数据库 | 发现会话、获取标题、工作区、归档状态和元数据。 |
| 活动 CLI 进程扫描 | 用作匹配 Codex CLI 会话仍在执行的回退信号。 |

Rust 数据源层收集观测值，将其标准化为会话行后传入 React 状态面板模型。面板负责排序、渲染操作，并只持久化本地配置和用户选择。

有关完整状态机、证据规则和流转理由，请参阅[状态流转](docs/status-flow.md)。有关 macOS 显示行为，请参阅[窗口位置](docs/window-placement.md)。

## 状态说明

| 状态 | 含义 | 预期操作 |
| --- | --- | --- |
| `blocked` | 证据表明数据源问题或未解决失败需要处理。 | 调查来源或决定如何继续。 |
| `attention` | Agent 正在等待结构化用户输入。 | 提供所需输入或处理该请求。 |
| `inspect` | 最近完成但尚未确认的任务，或可检查的失败，需要查看。 | 打开会话并检查结果。 |
| `running` | 会话有当前活动证据。 | 无需操作；它会作为上下文继续可见。 |
| `follow-up` | Attn 已记录对已完成结果的一次成功确认。 | 暂无即时操作。 |
| `stopped` | 运行在完成信号出现前结束。 | 继续、检查或忽略该会话。 |
| `idle` | 会话已较旧，或当前无需操作。 | 无需操作。 |

从 `inspect` 行选择 **Jump back** 是 Attn 可靠的确认操作。它会将该精确完成信号切换为配置时长内的安静 `follow-up` 状态，随后变为 `idle`。在 Attn 外直接打开同一个 Codex Desktop 线程目前不会确认该信号，因为 Codex 没有向本应用暴露可靠的按线程已读/已打开信号。

## 数据与隐私

Attn 使用本地 Codex 数据，读取：

- 本地 SQLite 状态数据库中的 Codex 线程元数据。
- `~/.codex/sessions` 下用于状态证据的会话 JSONL 文件。
- `~/.codex/agent-session-inbox/hook-events.jsonl` 中的可选 hook 事件。

Hook 写入器只记录状态流转所需的元数据：事件类型、时间戳、Codex 提供时的会话 ID、工作区路径和工具名称。它不会写入原始提示词或模型输出。面板展示状态元数据与证据置信度，而不是会话内容。

Hook 安装需要用户显式操作。在 **Attn -> Settings** 中选择 **Install Codex hooks**，即可将 Attn 命令合并到现有的用户级 Codex hook 配置。已有 hook 命令会被保留，重复的 Attn 命令会被避免。

## 环境要求

- macOS。原生应用使用 macOS 专用的 Tauri API，并提供 macOS 应用菜单工作流。
- Node.js 和 npm。
- Rust 工具链，以及 Tauri 所需的平台依赖。
- 本地 Codex Desktop 或 Codex CLI 会话数据。

自动构建使用 Node.js 24.20.0 和 Rust 1.96.0，并分别在 Apple Silicon 和 Intel 的 macOS 15 runner 上运行。可下载版本见 [GitHub 构建](#github-构建)；开发时仍可从源码构建。

## 本地运行

```bash
git clone <repository-url> attn
cd attn
npm ci
npm run tauri dev
```

浏览器预览仅用于 UI 开发：

```bash
npm run dev
```

服务地址为 `http://127.0.0.1:1420/`。原生窗口管理、hook 安装和 Jump back 需要在 Tauri 桌面运行时中使用。

## 验证与构建

```bash
npm test
npm run test:rust
npm run build
```

构建调试版 macOS 应用包：

```bash
npm run tauri build -- --debug
```

## 自动更新

打包后的 Attn `0.1.1` 及以后版本会在面板启动时检查已签名的更新通道。发现更新不会自动下载、安装或重启；面板会提供 **更新** 和 **稍后** 两个操作。选择 **稍后** 只在本次应用会话内不再提示。选择 **更新** 后，Attn 才会下载已签名的归档、原地安装并重启。安装失败会保留在面板中，当前应用继续运行。

Attn `0.1.0` 不含 updater 插件，必须先通过 DMG 或 ZIP 手动升级一次到 `0.1.1`。浏览器预览和 Tauri 开发运行不会访问更新通道。

## GitHub 构建

每次向 `master` 推送都会自动运行 **Build Attn** GitHub Actions 工作流。两个架构分别通过 `npm ci` 安装依赖、运行前端和 Rust 测试，再使用已提交的锁文件构建 release 版 `.app`、`.dmg` 和带签名的 updater 归档。两个架构都成功后，工作流自动发布 GitHub Release。手动运行时，只有选择 `master` 才会读取签名密钥、生成 updater 归档并允许发布 Release；其他分支刻意只构建普通安装产物。

| 版本 | Runner | Rust target |
| --- | --- | --- |
| Apple Silicon | `macos-15` | `aarch64-apple-darwin` |
| Intel | `macos-15-intel` | `x86_64-apple-darwin` |

从固定的[最新版下载页](https://github.com/zhatongning/attn/releases/latest)下载，也可直接使用下面的安装包链接。公开 Release 可匿名下载，无需进入 Actions 或登录 GitHub。

| Mac | 安装程序 | 应用压缩包 | Updater 归档 | 校验文件 |
| --- | --- | --- | --- | --- |
| Apple Silicon | [DMG](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.dmg) | [ZIP](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.app.zip) | [Updater](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.app.tar.gz) | [SHA-256](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-arm64.SHA256SUMS.txt) |
| Intel | [DMG](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.dmg) | [ZIP](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.app.zip) | [Updater](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.app.tar.gz) | [SHA-256](https://github.com/zhatongning/attn/releases/latest/download/Attn-macOS-x64.SHA256SUMS.txt) |

Updater 归档仅供应用自动消费；手动安装请使用 DMG 或 ZIP。每个已发布构建使用独立的 `build-<commit-sha>` 标签。Release 文件不受 Actions 产物 30 天保留期限制，历史构建可从 Releases 页面下载。发布任务校验两个架构的全部文件、上传完成后才公开草稿；较旧构建晚完成时不会覆盖较新的下载版本，重跑也不会改写已发布的文件。

只有当普通 SemVer 严格高于当前最新 Release 时，才会发布自动更新。`package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 必须使用同一个普通 SemVer。版本相同或更低的构建可以作为历史下载保留，但不能替换最新下载页或 updater 的 `latest.json` 清单。

应用将 updater 公钥和 HTTPS 清单地址提交在 `src-tauri/tauri.conf.json`。启用发布 CI 前，必须将匹配的私钥设置为仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`；私钥设置了密码时才额外配置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。不得提交任何私钥值。只有 CI 会启用 updater 归档生成，并在发布前用已提交的公钥校验每个 `.app.tar.gz` 签名。

Actions 同时保留 30 天产物，入口为 **Actions -> Build Attn -> 构建记录 -> Artifacts**。`master` 构建中每个架构的产物包含 `.dmg`、保留应用包权限的 `.app.zip`、`.app.tar.gz`、`.app.tar.gz.sig` 和校验文件；其他分支的构建刻意只保留 DMG、ZIP 和对应校验文件。同一次运行重跑时会替换该架构的产物，因此仅重试失败任务时可以复用另一架构已成功的产物。

构建采用 ad-hoc 签名，无需 Apple 开发者凭证。这些产物未经 Apple 公证，首次打开下载的应用时，macOS 可能要求在 **系统设置 -> 隐私与安全性** 中允许打开。面向外部用户进行可信分发时，需要另行配置 Developer ID 签名和 Apple 公证。

## 项目结构

| 范围 | 主要位置 |
| --- | --- |
| Codex 数据发现和 JSONL 解析 | `src-tauri/src/codex_source.rs` |
| 观测值到会话状态的分类 | `src-tauri/src/domain/classification.rs` |
| 确认、置顶、忽略和 Jump back 行为 | `src-tauri/src/inbox_store.rs` |
| Tauri 命令和 macOS 窗口设置 | `src-tauri/src/lib.rs` |
| 状态排序和展示模型 | `src/features/statusPanel/statusPanel.ts` |
| 面板 UI 与本地设置 | `src/features/statusPanel/StatusPanelView.tsx` |

## 已知限制

以下是当前的产品和技术边界，不代表面板可以正确推断所有会话状态。

1. **没有 Codex Desktop 外部已读的可靠信号。** Attn 可在自身 Jump back 成功后确认 `inspect` 行，但不能证明用户是否直接在 Codex Desktop 中打开或阅读过同一个历史线程。
2. **安装 hooks 后运行状态更可靠。** 未安装可选 Codex hooks 时，Attn 会回退到 JSONL、SQLite 和进程证据，因此部分 `running` 状态是推断结果，而非直接观测。
3. **部分生命周期窗口仍是技术默认值。** 当前活动时间为两小时；未读完成任务最多保持 `inspect` 12 小时；确认后的 `follow-up` 默认持续 30 分钟，最小 20 分钟。这些数值仍需持续进行产品验证。
4. **部分安静和检查状态刻意保持宽泛。** `inspect` 可以表示成功完成，也可以表示可检查的失败；`idle` 则可能表示旧会话不活跃，或结果已经被确认。
5. **产品范围较窄。** v1 不支持其他 Agent 提供商、移动端工作流、定时清理、真实活动摘要或 Warp 终端跳转。
6. **公开协作与兼容性覆盖仍需完善。** 还需要独立的贡献政策和更完整的兼容性矩阵。

## 参与贡献

贡献需要保持“证据”和“推断”的边界。修改会话行为时：

1. 说明支撑新状态的源事件或元数据。
2. 添加或更新聚焦的 JavaScript 和 Rust 测试。
3. 变更状态流转或确认语义时，同步更新[状态流转](docs/status-flow.md)。
4. 不要在测试、Issue 或示例中加入原始提示词、模型输出或私密会话数据。

在接受外部贡献前，维护者应添加独立的贡献政策。

## 许可证

Attn 采用 [MIT 许可证](LICENSE)。
