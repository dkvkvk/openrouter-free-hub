# OpenRouter 免费模型广场

一个**零构建、纯前端**的单页站点：查 OpenRouter 上当下所有免费（$0）模型，并挑最多 4 个同时问同一个问题、横向对比回答。

在线体验 → https://dkvkvk.github.io/openrouter-free-hub/

English: a no-build static web app to browse OpenRouter's currently-free models and chat with up to 4 of them in parallel, streaming side by side. Bring your own key; it never leaves your browser.

## 为什么不需要后端

OpenRouter 的 `GET /api/v1/models` 和 `POST /api/v1/chat/completions` 都返回 `Access-Control-Allow-Origin: *`，浏览器可以直连。所以这里没有任何代理层、没有 node 服务、不装依赖——API Key 也就只存在你本机的 `localStorage` 里，网络请求全部直达 OpenRouter。

## 用法

1. 打开 https://dkvkvk.github.io/openrouter-free-hub/ ，或者本地跑：

   ```bash
   git clone https://github.com/dkvkvk/openrouter-free-hub.git
   cd openrouter-free-hub
   python -m http.server 8777      # 然后访问 http://127.0.0.1:8777/
   ```

   直接双击 `index.html` 也能用（脚本都是非 module 的普通 `<script>`，不受 `file://` 的 CORS 限制）。

2. 点右上角 **🔑 获取 Key** 到 [openrouter.ai/keys](https://openrouter.ai/keys) 建一个 Key，回到 **⚙ 设置** 粘贴保存。
3. 左侧勾选筛选条件 → 点模型卡片的 **＋对话**（最多 4 个）→ 在下方输入问题，回复按模型分栏并行流式返回。

不填 Key 也能完整使用模型库的查询、筛选、排序、详情、复制 ID——列表接口不需要鉴权。

## 功能

| 分组 | 说明 |
| --- | --- |
| 模型库 | 实时拉全量列表筛出 $0 模型；关键词搜索、厂商下拉、5 个特性开关（工具调用 / 推理 / 视觉 / 结构化输出 / ≥128K）、4 种排序、统计条 |
| 详情 | 上下文与最大输出、模态、分词器、支持的全部请求参数、官方主页跳转、复制 ID |
| 对话 | 最多 4 个模型同题并行、SSE 流式、`reasoning` 单独折叠、停止、逐条复制、首字延迟与 t/s、`usage` 真实 token 数 |
| 运维 | 批量测活（每个模型发一条极短请求探连通性与延迟）、导出 Markdown、清空会话、刷新列表 |
| 容错 | 列表 30 分钟本地缓存 → 断网时退回仓库内置的快照 `assets/fallback-models.js` |

## 免费模型是怎么判定的

```js
Number(pricing.prompt) === 0 && Number(pricing.completion) === 0
```

比只认 `:free` 后缀更宽：截至 2026-09-25，全量 460 个模型里有 24 个 $0，其中 20 个带 `:free` 后缀，另外 4 个是未标后缀的预览模型（`openrouter/free` 路由器、`stealth/space-bunny-alpha`、两个 `google/lyria-3` 音乐模型）。数量随官方上下架每天变动，页面顶部会显示实时数字。

注意 `google/lyria-3-*` 这类输出含音频的模型，在纯文本对话框里可能拿不到文字回复；详情弹层里已标注。

## 限速与配额

免费模型：**20 次/分钟**；账户累计余额 < $10 时 **50 次/天**，≥ $10 时 1000 次/天，超出返回 `429`。

顶栏那行「本分钟已发 N / 20」**只统计本页发出的请求**，换标签页或别的应用用同一个 Key 打的请求不计入。要账号级真实配额得查 `GET /api/v1/auth/key`，目前没接。

## 上下文怎么算

每个模型各自重建上下文：系统提示词 + 历轮提问 + **该模型自己**上一轮已完成的回答。所以 A 模型看不到 B 模型的回答，多模型对比不会互相污染。

输入框上方「估算上文 ≈ N tokens」是字符数 ÷3.6 的粗估，超过所选模型最小窗口的 80% 会黄字提醒。**没有自动截断或滑窗**，聊长了会直接报上下文超限——请手动「清空对话」重开。

## 数据落在哪

全部在浏览器本地，无任何上报：

| key | 内容 |
| --- | --- |
| `orf.apiKey` | 你的 OpenRouter Key |
| `orf.settings` | 系统提示词、temperature、max_tokens、是否流式 |
| `orf.picks` | 已选模型 |
| `orf.turns` | 会话记录（保留最近 40 轮） |
| `orf.modelCache` | 模型列表缓存（30 分钟） |

设置弹层里的「清除本机数据」一键清空。

## 文件结构

```
index.html                    页面骨架 + 设置/详情弹层
assets/app.js                 全部逻辑（模型拉取、筛选、Markdown 渲染、SSE、对话）
assets/style.css              深色主题样式
assets/fallback-models.js     内置免费模型快照（断网兜底）
```

无框架、无打包器、无第三方脚本。Markdown 渲染是自己写的最小实现，所有文本先 HTML 转义再拼标签，`javascript:` 链接和原始 `<img>`/`<script>` 都不会变成真节点。

## 验证状态

已验证：模型拉取与筛选排序、详情弹层、4 个上限拦截、无 Key 拦截、流式拆帧与 Markdown 渲染（含 XSS 转义）的单元测试、线上 Pages 访问与控制台无报错。

**未验证**：真实对话请求（需要你自己的 Key，作者环境无法注入凭据）。这部分逻辑通过了 SSE 解析单测，但端到端没跑过线上接口，遇到问题的话开个 issue。

## License

未指定。默认版权归你，需要的话可以补一个 `LICENSE`（MIT 之类）。
