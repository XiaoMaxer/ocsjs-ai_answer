<div align="center">

# OCS 网课助手 · AI 搜题增强版

基于 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs) 的增强版本，保留原有全部功能，新增可配置的大模型 AI 搜题能力。

**题库搜题 + AI 实时解答，并行可选，互不影响。**

</div>

> 本项目为个人修改版，非 OCS 官方版本。原项目版权归 enncy 所有，遵循 [MIT License](./LICENSE)。
> 仅用于学习与技术研究，请遵守所在学校与平台的规章制度。

## 与原版的差异

| 能力 | 原版 | 本版 |
| --- | --- | --- |
| 题库搜题 | ✅ | ✅ 完全保留，配置与逻辑零改动 |
| 大模型 AI 搜题 | ❌ | ✅ 新增，OpenAI 兼容接口 |
| 无题库也能搜题 | ❌ | ✅ 只启用 AI 即可 |
| 多模型服务切换 | - | ✅ 改地址 + 模型名即可 |
| AI 独立开关 / 测试连接 | - | ✅ 设置面板内独立控制 |
| AI 与题库并行 | - | ✅ 题库优先展示，AI 结果带「AI」标签 |
| 异常友好提示 | - | ✅ 密钥、额度、格式、超时均有提示 |

## 功能特性

- 自动答题、视频/文档任务、题库搜题、在线搜题、图片题优化等原有功能全部保留
- AI 搜题不依赖题库数据，直接根据题干与选项实时生成答案
- 支持 DeepSeek、OpenAI、通义千问、Kimi、Ollama、vLLM 等所有 OpenAI 兼容接口
- 可配置：接口地址、API Key、模型、温度、最大回答长度、超时、请求方式、系统提示词
- 请求失败只影响 AI 这一路结果，题库与自动答题流程继续运行
- AI 答案自动缓存，同一题不会重复请求；答案会还原 `[图片N]` 占位并匹配图片选项

## 安装

### 方式一：直接安装（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 ScriptCat
2. 在 [Releases](../../releases) 下载：
   - `ocs.common.user.js` —— 全域名通用版，**推荐**，大模型接口任意域名可跨域
   - `ocs.user.js` —— 官方域名版，使用自定义 AI 域名需在脚本头部补充 `@connect`
3. 打开脚本管理器 → 新建脚本 → 粘贴内容（或拖入文件）→ `Ctrl+S` 保存
4. 打开受支持的网课页面（超星、智慧树、职教云、中国大学 MOOC、雨课堂等），左侧出现 OCS 悬浮窗即安装成功

> 不要安装 `ocs.meta.js`（仅更新元数据）或 `ocs.dev.user.js`（开发版，依赖本地文件）。

### 方式二：本地构建

```powershell
corepack pnpm install

# 生成 dist/core.js 与 dist/index.js
$env:VITE_BUILD_PATH='../../dist'
cd packages\core;    corepack pnpm exec vite build
cd ..\scripts;       corepack pnpm exec vite build

# 生成 dist/ocs.user.js 等产物（需在仓库根目录执行）
```

> 仓库当前存在两处与 AI 改动无关的历史类型错误（`lodash/debounce` 缺少类型声明、[zhs.ts](packages/scripts/src/projects/zhs.ts) 的 `textContent` 判空），`pnpm build` 会在 `tsc` 步骤中断，可先用上面的 Vite 命令打包。

## 开启 AI 搜题

1. 悬浮窗 → **通用** → **全局设置**
2. 找到「**AI 搜题设置（大模型）**」，勾选「启用 AI 搜题」
3. 填写接口地址、API 密钥、模型名称
4. 点击「**🔌测试连接**」，会发起一次真实请求并提示结果
5. 保存后正常点击「开始答题」即可

### 配置项

| 配置 | 说明 | 默认 |
| --- | --- | --- |
| 启用 AI 搜题 | 总开关，关闭时与原版完全一致 | 关闭 |
| AI 接口地址 | OpenAI 兼容的 `chat/completions` 地址；只填域名或 `/v1` 会自动补全 | - |
| API 密钥 | 仅保存在本地脚本存储；本地模型可留空 | - |
| 模型名称 | 服务商提供的模型 ID | - |
| AI 温度 | 0-2，越低越稳定 | 0.3 |
| AI 最大回答长度 | 单次回答 tokens 上限 | 1024 |
| AI 请求超时 | 秒，超时只影响 AI 结果 | 60 |
| AI 请求方式 | `GM_xmlhttpRequest`（可跨域）或 `fetch`（需接口支持 CORS） | GM |
| AI 系统提示词 | 约束输出格式，默认只输出答案 | 见代码 |
| AI 无法确定时随机兜底 | AI 无法确定答案时，优先题库；题库也无答案则随机作答。关闭后此类题目留空 | 开启 |

### 常见服务

| 服务 | 接口地址 | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b`（密钥留空） |

> 全域名通用版已声明 `@connect *`。官方域名版使用自定义接口时，请在脚本头部添加 `@connect 你的接口域名`，或把「AI 请求方式」切换为 `fetch`（接口需允许浏览器跨域）。

## AI 无法确定时的兜底流程

当 AI 返回「无法确定 / 不确定 / 无法回答 / 不知道」等回答时，**不会把这段文字当作答案提交**，而是按以下顺序处理：

1. **禁止直接提交**：剔除该 AI 不确定结果，避免尤其是填空题把它原文写入输入框
2. **优先题库**：题库条目本来就排在 AI 之前，剔除 AI 后自然使用题库答案
3. **随机兜底**：题库也没有匹配答案时，按题型随机生成答案并提交（默认开启，可在设置中关闭）
   - 单选：随机选项字母
   - 多选：随机 1~N 个不重复选项
   - 判断：随机「正确 / 错误」
   - 填空：随机文案按填空数量填入
4. **用户提示**：命中题库兜底或随机兜底时，悬浮窗会弹出明确提示，说明本次使用了哪种兜底方式

> 随机答案仅作为最后的兜底手段，不保证正确，建议开启题库以获得更可靠的结果。

## 异常处理

| 场景 | 表现 |
| --- | --- |
| API Key 无效 / 无权限（401、403） | 结果面板提示「API 密钥无效或无权限」 |
| 频率或额度受限（429、余额不足） | 提示「请求频率或额度受限」 |
| 返回不是 JSON（网关错误页等） | 提示「接口返回格式异常」 |
| 返回缺少回答内容 | 提示「未找到回答内容，请确认接口为 OpenAI 兼容格式」 |
| 请求超时 | 该题 AI 结果失败，其他题库与答题流程继续 |
| 配置不完整 / 未启用 | 不注入 AI，原有题库行为完全不变 |

## 兼容性说明

- 题库配置格式、`AnswererWrapper`、handler 解析、缓存、答案匹配均未改动
- AI 仅在 `getWorkOptions()` 中追加到题库列表末尾，**未启用时不产生任何影响**
- 内核新增可选字段 `timeout_seconds`，旧题库未设置时继续使用全局超时
- 支持「只启用 AI、不配置任何题库」的纯 AI 模式

## 本地开发与测试

```powershell
corepack pnpm install
corepack pnpm test        # 原有解析逻辑（170 项）
corepack pnpm test:ai     # AI 搜题模块（25 项）
corepack pnpm tsc:check   # utils / core 类型检查
```

AI 模块与测试文件：

- [packages/scripts/src/utils/ai-answerer.ts](packages/scripts/src/utils/ai-answerer.ts)
- [tests/ai-answerer.test.ts](tests/ai-answerer.test.ts)

## 目录结构

```
packages/core      答题内核（worker、resolver、answer-wrapper）
packages/scripts   业务实现（超星/智慧树/职教云/中国大学MOOC/雨课堂等）
packages/utils     通用工具
scripts            构建脚本
tests              单元测试
dist               构建产物（Git 忽略，随 Release 发布）
```

## 免责声明

- 本项目仅供学习、研究与技术交流，不得用于商业用途
- 使用本脚本产生的任何后果（包括账号风险、成绩问题）由使用者自行承担
- 请遵守所在学校、平台的服务条款；建议仅用于辅助复习与自测
- 本项目与 OCS 官方无关，请勿向官方反馈本修改版问题

## 许可证与致谢

- 原项目：[ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)，作者 enncy
- 许可证：[MIT License](./LICENSE)，Copyright (c) 2022 enncy
- 本版在原有代码基础上新增 AI 搜题模块，保留原始版权与许可声明
