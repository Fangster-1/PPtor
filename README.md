# PPtor

**Windows 桌宠形态的论文翻译工具** · v0.1.0 · MIT

把 PDF 拖到小幽灵身上，它会依次完成解析、翻译和排版导出，输出 PDF / Word / Markdown / HTML 四种格式的译文；之后你还可以就着译文继续提问。解析走 MinerU（云端 API 或本地服务），翻译走任意 OpenAI 兼容接口。

---

## 特性

- **投喂即翻译**：拖拽或菜单选文件，支持批量；忙碌时自动排队，随时取消。
- **双解析后端**：MinerU 云端 API，或本机自建的 MinerU 服务。
- **四格式导出**：PDF、Word（DOCX）、Markdown、自包含 HTML，可多选成组产出。
- **译文归档**：统一落入翻译文档库，每篇一个以中文标题命名的目录。
- **论文问答**：独立的微信式聊天窗口，多会话并列，每个翻译任务或导入的文档各成一个会话。
- **只发文本**：翻译请求固定为纯文本，不会把 PDF、图片或 base64 发给模型，即使所选模型支持视觉输入。
- **失败不报废**：单段失败回填原文、整篇标记部分成功；换术语表或参数后缓存自动失效。
- **凭据加密**：密钥由 Electron safeStorage 加密保存在本机。
- **桌宠本体**：矢量小幽灵，可拖动、Ctrl+滚轮缩放（0.5x~2x）、托盘常驻、窗口关闭不退出。

## 快速开始

环境要求：Windows 10/11 x64，Node.js 18+。

```bash
npm install
npm start
```

首次运行跟随气泡向导填写翻译模型与 MinerU，约 1 分钟。也可以双击根目录的 `start.bat` 启动。

打包为免安装产物：

```bash
npm run pack   # 目录版 dist/win-unpacked/PPtor.exe，日常使用推荐
npm run dist   # 便携版 dist/PPtor-0.1.0-portable.exe
```

目录版省去每次启动单文件的解压步骤；便携版的配置与译文保存在 EXE 附近。仓库不提供预编译二进制，请按需自行构建。

> 国内网络下载 Electron 二进制较慢时，可在 `~/.npmrc` 里临时配置镜像：
> `electron_mirror=https://npmmirror.com/mirrors/electron/` 与
> `electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 使用

| 操作 | 效果 |
| --- | --- |
| 拖入 PDF | 开始翻译；忙时投喂自动排队 |
| 拖动宠物 | 移动位置，松手保存，下次启动还原 |
| Ctrl + 滚轮 | 缩放宠物 |
| 单击 | 查看状态 / 继续未完成的配置 |
| 右键 | 常驻面板：翻译历史、论文问答、输出设置、置顶、打开译文库、隐藏、退出 |
| Esc | 收起气泡（确认框需点按钮，不会被 Esc 丢弃） |
| 托盘 | 显示宠物 / 拉回屏幕 / 总在最前；单击召回被隐藏的宠物 |

非英文材料会先确认再翻译。解析阶段用活动条表示服务仍在工作，翻译阶段显示「翻译 X/Y 段」与整篇总进度。

### 输出格式

| 格式 | 说明 |
| --- | --- |
| PDF | A4 排版译文，图片嵌入；缺图用占位图，不整单失败 |
| Word | 可编辑文档与表格，图片嵌入 OOXML；公式为 OMML 子集（分数/根号/上下标，cases、matrix 保留内容），未知命令保留原文 |
| Markdown | 译文与 data URI 图片同文件，文件头有兼容提示；缺图占位并注明 |
| HTML | 自包含单文件，可直接在浏览器打开 |

内容可选「只留译文」或「双语对照」；排版可选「通用排版」或「按原论文格式」。后者遵循解析结果的内容顺序，不等于逐页复刻原 PDF 版面。

排版约束（两种排版都执行）：公式、表格、图片、正文各自独立成段、互不嵌套；图上注下、表注绑定不断页；中英混排补空格、全半角标点统一；标题语义保留，大纲/书签/Word 导航不断裂；参考文献完整保留、悬挂缩进。

> Markdown 的 data URI 图片能否显示取决于阅读器，跨阅读器查看请用 HTML 或 PDF。单文件 base64 会膨胀约 33%，属正常现象。

### 论文问答

问答在独立聊天窗口中进行，左侧会话列表、右侧对话区。每个翻译任务或通过「添加文档」导入的译文各形成一个会话，各自保留论文集与对话历史，可切换、重命名、分组、删除。语料按三级回退加载，重启后从译文库读回，读不回的会话自动淘汰；不创建空会话。回答依据载入的论文材料，无法从材料确定的信息会明确说明。

## 项目结构

```
src/main/
  main.js            启动与生命周期、连通性状态机
  ipc/               渲染进程 ↔ 主进程路由（broadcast / ask-gateway / job-manager / qa-sessions / doc-loader）
  core/              解析、分块、翻译、导出、问答、上下文与内部记录
  pet/               桌宠窗口、资源加载与 PDF 打印
  chat/              问答聊天窗口
  assets/            托盘状态圆点图标
src/renderer/
  index.html         宠物窗（矢量幽灵 + 气泡 + 进度卡）
  pet/               宠物侧交互：拖拽、投放、动画、气泡、常驻面板、配置向导
  chat.html          问答窗
scripts/             资源生成与回归验证
assets/ build/       托盘图标与安装包图标
pets/paper-pet/      内置桌宠定义（Codex 宠物规范）
```

配置与译文属于用户数据，统一落在「软件根目录」下的 `config/`、`cache/`、`translated/`：便携版在 EXE 同级，开发时在项目根目录（或 `dist/`）。整个文件夹拷到 U 盘即可带着配置和产物一起走。这些目录已在 `.gitignore` 中排除，升级或清理旧版本时不要一并删除。

## 开发与验收

```bash
npm run verify        # 依次跑 selftest / export / runtime / pet-ui 四套回归
npm run smoke         # 原生 Electron 自检：窗口、IPC、图片 PDF、取消恢复、窗口释放
npm run chat:check    # 问答窗验收
npm run pet           # 重新生成内置桌宠资源
npm run pet:check     # 桌宠 UI 回归
```

`--smoke` 使用隔离的数据目录，不会触碰真实凭据与译文；失败返回非零状态。测试截图与报告保存在自检输出目录，可用 `--smoke-output=<绝对路径>` 指定证据目录。

仓库内的 `config/`、`cache/`、`dist/`、`release/`、`test-out/` 均为本地产物，未纳入版本控制。

## 安全说明

- API 密钥通过 Electron safeStorage 加密存储，仅在无法加密的环境下回退为明文——此时请勿分享你的配置目录，换机器需重新填写。
- 翻译链路只传输解析后的文本分段，不上传原始 PDF 或图片。
- 渲染层启用 CSP，`default-src 'self'`，不加载任何远程脚本或样式。

## License

MIT © 2026 Fangster-1
