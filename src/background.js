const DEFAULT_CONFIG = {
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.2
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "summarize-repository") {
    summarizeRepository(message.payload)
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "summarize-repository-stream-start") {
    const requestId = message.requestId || createRequestId();
    streamSummaryToTab(message.payload, _sender.tab?.id, requestId)
      .then((result) => sendResponse({ ok: true, requestId, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        requestId,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message?.type === "get-config-status") {
    getConfig()
      .then((config) => sendResponse({
        ok: true,
        configured: Boolean(config.baseUrl && config.model && config.apiKey)
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "fetch-readme") {
    fetchReadme(message.payload)
      .then((readme) => sendResponse({ ok: true, readme }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "fetch-file-content") {
    fetchFileContent(message.payload)
      .then((content) => sendResponse({ ok: true, content }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "fetch-directory-snapshot") {
    fetchDirectorySnapshot(message.payload)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sendStreamMessage(tabId, message) {
  if (!tabId) {
    return Promise.resolve();
  }
  return chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    baseUrl: String(stored.baseUrl || "").replace(/\/+$/, ""),
    model: String(stored.model || "").trim(),
    apiKey: String(stored.apiKey || "").trim(),
    temperature: Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : 0.2
  };
}

async function summarizeRepository(repoContext) {
  const config = await getConfig();
  validateConfig(config);

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: buildMessages(repoContext)
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || response.statusText;
    throw new Error(`模型接口请求失败：${response.status} ${detail}`);
  }

  const summary = data?.choices?.[0]?.message?.content;
  if (!summary) {
    throw new Error("模型接口没有返回可用摘要。");
  }

  return summary.trim();
}

function buildMessages(repoContext) {
  return [
    {
      role: "system",
      content: [
        "你是资深软件架构师，擅长快速阅读 GitHub 仓库上下文。",
        "请用中文输出，语言清晰、具体、避免空泛。",
        "如果上下文不足，请明确说明哪些判断来自仓库页面可见信息，哪些仍需查看源码确认。"
      ].join("\n")
    },
    {
      role: "user",
      content: buildPrompt(repoContext)
    }
  ];
}

async function streamSummaryToTab(repoContext, tabId, requestId) {
  const startedAt = performance.now();
  let chunkCount = 0;

  try {
    const config = await getConfig();
    validateConfig(config);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        stream: true,
        messages: buildMessages(repoContext)
      })
    });

    if (!response.ok) {
      const detail = await readResponseError(response);
      throw new Error(`模型接口请求失败：${response.status} ${detail}`);
    }

    if (!response.body) {
      const summary = await summarizeRepository(repoContext);
      await sendStreamMessage(tabId, {
        type: "summarize-repository-stream-chunk",
        requestId,
        chunk: summary
      });
      await sendStreamMessage(tabId, {
        type: "summarize-repository-stream-done",
        requestId,
        summary,
        durationMs: Math.round(performance.now() - startedAt),
        fallback: true
      });
      return {
        summary,
        durationMs: Math.round(performance.now() - startedAt),
        fallback: true
      };
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let fullText = "";
    let firstChunkMs = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const parsed = parseStreamLine(line);
        if (!parsed || parsed.done || !parsed.text) {
          continue;
        }

        chunkCount += 1;
        if (!firstChunkMs) {
          firstChunkMs = Math.round(performance.now() - startedAt);
        }

        fullText += parsed.text;
        await sendStreamMessage(tabId, {
          type: "summarize-repository-stream-chunk",
          requestId,
          chunk: parsed.text,
          firstChunkMs
        });
      }
    }

    if (!fullText.trim()) {
      throw new Error("模型接口没有返回可用摘要。");
    }

    await sendStreamMessage(tabId, {
      type: "summarize-repository-stream-done",
      requestId,
      summary: fullText.trim(),
      firstChunkMs,
      durationMs: Math.round(performance.now() - startedAt),
      fallback: false
    });
    return {
      summary: fullText.trim(),
      firstChunkMs,
      durationMs: Math.round(performance.now() - startedAt),
      fallback: false
    };
  } catch (error) {
    if (chunkCount === 0) {
      try {
        const summary = await summarizeRepository(repoContext);
        await sendStreamMessage(tabId, {
          type: "summarize-repository-stream-chunk",
          requestId,
          chunk: summary
        });
        await sendStreamMessage(tabId, {
          type: "summarize-repository-stream-done",
          requestId,
          summary,
          durationMs: Math.round(performance.now() - startedAt),
          fallback: true
        });
        return {
          summary,
          durationMs: Math.round(performance.now() - startedAt),
          fallback: true
        };
      } catch (fallbackError) {
        await sendStreamMessage(tabId, {
          type: "summarize-repository-stream-error",
          requestId,
          error: fallbackError.message || String(fallbackError)
        });
        return {
          error: fallbackError.message || String(fallbackError)
        };
      }
    }

    await sendStreamMessage(tabId, {
      type: "summarize-repository-stream-error",
      requestId,
      error: error.message || String(error)
    });
    return {
      error: error.message || String(error)
    };
  }
}

async function readResponseError(response) {
  const data = await response.json().catch(() => ({}));
  return data?.error?.message || data?.message || response.statusText;
}

function parseStreamLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.startsWith("data:")) {
    return null;
  }

  const payload = trimmed.slice(5).trim();
  if (!payload) {
    return null;
  }
  if (payload === "[DONE]") {
    return { done: true };
  }

  const data = JSON.parse(payload);
  const choice = data?.choices?.[0];
  const text = choice?.delta?.content || choice?.message?.content || "";
  return { done: false, text };
}

function validateConfig(config) {
  if (!config.baseUrl || !config.model || !config.apiKey) {
    throw new Error("请先在扩展设置中配置 Base URL、模型 ID 和 API Key。");
  }

  try {
    new URL(config.baseUrl);
  } catch {
    throw new Error("Base URL 格式不正确。");
  }
}

function buildPrompt(repo) {
  const scopeMode = repo.scope?.effectiveMode || "repository";
  const scopeLabel = scopeMode === "directory" ? "目录级" : scopeMode === "file" ? "文件级" : "仓库级";
  const scopePath = repo.scope?.scopePath || "/";
  const scopeRule = scopeMode === "directory"
    ? "你必须只围绕给定目录路径进行摘要，不要把整个仓库当成摘要对象。"
    : "可以在仓库级别总结。";

  return [
    `仓库：${repo.owner}/${repo.name}`,
    `页面 URL：${repo.url}`,
    `摘要范围模式：${scopeLabel}`,
    `摘要范围路径：${repo.scope?.scopePath || "/"}`,
    `当前页面类型：${repo.scope?.pageType || "未知"}`,
    `当前分支：${repo.scope?.branch || "未知"}`,
    `模式说明：${repo.scope?.warning || "无"}`,
    `范围约束：${scopeRule}`,
    `标题：${repo.title || "未知"}`,
    `简介：${repo.description || "未提供"}`,
    `主题标签：${repo.topics?.join(", ") || "未提供"}`,
    `语言/技术线索：${repo.languages?.join(", ") || "未提供"}`,
    `可见文件：${repo.files?.join(", ") || "未采集到"}`,
    `目录清单（API）：${formatDirectoryEntries(repo.directoryEntries)}`,
    "",
    "目录文件片段（优先用于目录级摘要）：",
    formatDirectorySamples(repo.directoryFileSamples),
    "",
    `README 或页面主要内容（路径参考：${scopePath}）：`,
    repo.readme || "未采集到 README 内容。",
    "",
    `当前文件路径：${repo.filePath || "无"}`,
    "当前文件内容（仅文件级可用）：",
    repo.fileContent || "未采集到文件正文。",
    "",
    "请按以下结构输出：",
    "1. 主要作用：这个项目解决什么问题，面向谁。",
    "2. 技术原理：从可见信息推断它大致如何工作，涉及哪些关键模块或技术栈。",
    "3. 安装与使用：给出可执行的安装/运行步骤；如果信息不足，给出需要进一步查看的文件。",
    "4. 适合关注的源码入口：列出值得先看的文件或目录。",
    "5. 风险与注意事项：指出文档缺失、维护状态、依赖或安全方面的潜在风险。"
  ].join("\n");
}

async function fetchReadme(repo) {
  const owner = encodeURIComponent(repo.owner || "");
  const name = encodeURIComponent(repo.name || "");
  const branch = encodeURIComponent(repo.branch || "main");
  const scopePath = String(repo.scopePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const includeRootFallback = repo.includeRootFallback !== false;
  const candidates = ["README.md", "README.MD", "readme.md", "README"];

  if (!owner || !name) {
    return "";
  }

  const pathCandidates = [];
  if (scopePath) {
    for (const filename of candidates) {
      pathCandidates.push(`${scopePath}/${filename}`);
    }
  }
  if (includeRootFallback) {
    for (const filename of candidates) {
      pathCandidates.push(filename);
    }
  }

  for (const relativePath of pathCandidates) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${relativePath}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.text();
      }
    } catch {
      return "";
    }
  }

  return "";
}

async function fetchFileContent(payload) {
  const owner = encodeURIComponent(payload?.owner || "");
  const name = encodeURIComponent(payload?.name || "");
  const branch = encodeURIComponent(payload?.branch || "main");
  const path = String(payload?.path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  if (!owner || !name || !path) {
    return "";
  }

  const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    return "";
  }

  return response.text();
}

async function fetchDirectorySnapshot(payload) {
  const owner = encodeURIComponent(payload?.owner || "");
  const name = encodeURIComponent(payload?.name || "");
  const branch = encodeURIComponent(payload?.branch || "main");
  const path = String(payload?.path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  if (!owner || !name) {
    return { entries: [], fileSamples: [] };
  }

  const apiPath = path ? `/${path}` : "";
  const url = `https://api.github.com/repos/${owner}/${name}/contents${apiPath}?ref=${branch}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    return { entries: [], fileSamples: [] };
  }

  const data = await response.json().catch(() => []);
  const entries = Array.isArray(data)
    ? data.map((item) => ({
      type: item.type || "unknown",
      path: item.path || "",
      size: Number(item.size || 0)
    }))
    : [];

  const sampleCandidates = Array.isArray(data)
    ? data
      .filter((item) => item?.type === "file" && item?.download_url && isTextLike(item?.name || "") && Number(item?.size || 0) <= 200000)
      .slice(0, 4)
    : [];

  const fileSamples = await Promise.all(sampleCandidates.map(async (item) => {
    try {
      const fileResp = await fetch(item.download_url);
      if (!fileResp.ok) {
        return null;
      }
      const text = await fileResp.text();
      return {
        path: item.path || item.name || "",
        snippet: truncateForPrompt(text, 1200)
      };
    } catch {
      return null;
    }
  }));

  return {
    entries: entries.slice(0, 80),
    fileSamples: fileSamples.filter(Boolean)
  };
}

function isTextLike(filename) {
  const lower = String(filename || "").toLowerCase();
  const exts = [
    ".md", ".txt", ".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php",
    ".c", ".cc", ".cpp", ".h", ".hpp",
    ".css", ".scss", ".less", ".html", ".xml", ".sh", ".bash", ".zsh"
  ];
  return exts.some((ext) => lower.endsWith(ext));
}

function truncateForPrompt(text, maxLength) {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[已截断]`;
}

function formatDirectoryEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "未采集到目录清单。";
  }
  return entries
    .map((item) => `${item.type === "dir" ? "[DIR]" : "[FILE]"} ${item.path || "(unknown)"}`)
    .join("; ");
}

function formatDirectorySamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return "未采集到目录文件片段。";
  }
  return samples
    .map((item) => `--- ${item.path} ---\n${item.snippet || ""}`)
    .join("\n\n");
}
