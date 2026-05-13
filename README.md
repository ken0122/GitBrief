MIT License - Copyright (c) 2026 ken0122

# GitHub Repository Summarizer

一个 Manifest V3 Chrome 插件。打开 GitHub repository 页面时，它会在右侧插入“AI 仓库摘要”卡片；点击“总结此仓库”后，会读取当前页面可见的仓库信息和 README，并通过你配置的 Chat Completions 兼容接口生成中文概要。

## 功能

- 在 `github.com/{owner}/{repo}` 仓库页面右侧插入摘要卡片。
- 顶层仓库页面（含同级标签页）只显示单按钮：`Brief repo`。
- 目录页面只显示单按钮：`Brief catalog`。
- 文件详情页面只显示单按钮：`Brief file`。
- 摘要会持久化到扩展 IndexedDB；再次点击时会优先读取本地摘要，并用 GitHub 路径元数据判断是否需要更新。
- 支持配置 Base URL、模型 ID、API Key 和 temperature。
- 通过 background service worker 发起模型请求，内容脚本不直接持有请求逻辑。
- 输出内容聚焦快速判断：这是什么、怎么用、先看哪里，以及明显注意点。

## 安装

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录：`/Users/luokun/Documents/New project 2`。
5. 点击插件图标，进入设置页，填写模型接口配置。

## 模型接口要求

当前版本调用的是 OpenAI Chat Completions 兼容接口：

```http
POST {Base URL}/chat/completions
Authorization: Bearer {API Key}
Content-Type: application/json
```

请求体会包含 `model`、`temperature` 和 `messages`。如果使用 OpenAI 官方接口，Base URL 通常形如 `https://api.openai.com/v1`；如果使用其他兼容服务商，填对应服务商的 Base URL 和模型 ID。

## 使用

1. 打开任意 GitHub 仓库页面。
2. 在右侧找到“AI 仓库摘要”卡片（在 About 上方）。
3. 在顶层页面直接点击 `Brief repo`。
4. 在目录页面直接点击 `Brief catalog`。
5. 在文件详情页面直接点击 `Brief file`。
6. 点击主按钮执行摘要并等待模型返回。

## 看不到卡片时

1. 进入 `chrome://extensions/`，找到本扩展，点击刷新按钮重新加载扩展。
2. 回到 GitHub 仓库页面，强制刷新页面。
3. 确认 Chrome 没有限制扩展访问 `github.com`：扩展详情页里的“网站访问权限”应允许在 GitHub 上运行。
4. 如果 GitHub 页面没有右侧栏，卡片会退回显示在仓库标题下方。

## 安全说明

API Key 保存在本机 Chrome 扩展存储 `chrome.storage.local` 中，摘要缓存保存在扩展 IndexedDB 中。它们都不是端到端加密的机密保险箱；如果你需要更高安全性，建议改成由自己的后端代理模型请求，并让扩展只调用你的后端。
