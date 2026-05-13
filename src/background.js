if (typeof importScripts === "function") {
  importScripts("prompt.js");
}

const DEFAULT_CONFIG = {
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.2
};
const SUMMARY_CACHE_DB_NAME = "gitbrief-cache";
const SUMMARY_CACHE_DB_VERSION = 1;
const SUMMARY_CACHE_STORE = "summaries";
const SUMMARY_CACHE_MAX_RECORDS = 200;
const SUMMARY_CACHE_FALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_PROMPT_VERSION = 2;
const SUMMARY_METADATA_VERSION = 1;

let summaryCacheDbPromise = null;

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

  if (message?.type === "get-summary-cache") {
    getSummaryCache(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, hit: false, stale: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "set-summary-cache") {
    setSummaryCache(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "delete-summary-cache") {
    deleteSummaryCache(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
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

async function getSummaryCache(payload) {
  const scope = normalizeSummaryCacheScope(payload);
  const cacheKey = makeSummaryCacheKey(scope);
  const record = await readSummaryCacheRecord(cacheKey);

  if (!record?.summary) {
    return { hit: false, stale: false, reason: "miss" };
  }

  if (record.promptVersion !== SUMMARY_PROMPT_VERSION) {
    return { hit: false, stale: true, reason: "prompt-version-changed", metadata: record.metadata || null };
  }

  try {
    const metadata = await fetchPathMetadata(scope);
    if (record.pathFingerprint && record.pathFingerprint === metadata.pathFingerprint) {
      await updateSummaryCacheAccess(cacheKey);
      return {
        hit: true,
        stale: false,
        summary: record.summary,
        metadata,
        reason: "fingerprint-match"
      };
    }

    return {
      hit: false,
      stale: true,
      metadata,
      reason: record.pathFingerprint ? "fingerprint-changed" : "fingerprint-missing"
    };
  } catch (error) {
    const updatedAt = Number(record.updatedAt || record.createdAt || 0);
    if (Date.now() - updatedAt <= SUMMARY_CACHE_FALLBACK_TTL_MS) {
      await updateSummaryCacheAccess(cacheKey);
      return {
        hit: true,
        stale: false,
        summary: record.summary,
        metadata: record.metadata || null,
        reason: "metadata-unavailable-fallback",
        warning: error.message || String(error)
      };
    }

    return {
      hit: false,
      stale: true,
      metadata: record.metadata || null,
      reason: "metadata-unavailable-expired",
      warning: error.message || String(error)
    };
  }
}

async function setSummaryCache(payload) {
  const scope = normalizeSummaryCacheScope(payload);
  const summary = String(payload?.summary || "").trim();
  if (!summary) {
    throw new Error("摘要为空，无法写入缓存。");
  }

  const cacheKey = makeSummaryCacheKey(scope);
  const config = await getConfig();
  const existing = await readSummaryCacheRecord(cacheKey);
  const now = Date.now();
  let metadata = null;
  let metadataError = "";

  try {
    metadata = await fetchPathMetadata(scope);
  } catch (error) {
    metadataError = error.message || String(error);
  }

  await writeSummaryCacheRecord({
    cacheKey,
    summary,
    owner: scope.owner,
    name: scope.name,
    branch: scope.branch,
    effectiveMode: scope.effectiveMode,
    scopePath: scope.scopePath,
    pageType: scope.pageType,
    sourceUrl: String(payload?.sourceUrl || ""),
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
    lastAccessedAt: now,
    model: config.model,
    promptVersion: SUMMARY_PROMPT_VERSION,
    metadataVersion: SUMMARY_METADATA_VERSION,
    metadata: metadata || existing?.metadata || null,
    metadataError,
    pathFingerprint: metadata?.pathFingerprint || ""
  });
  await cleanupSummaryCache();

  return {
    cacheKey,
    metadata,
    reason: metadata ? "stored-with-fingerprint" : "stored-without-fingerprint",
    warning: metadataError
  };
}

async function deleteSummaryCache(payload) {
  const scope = normalizeSummaryCacheScope(payload);
  const cacheKey = makeSummaryCacheKey(scope);
  await deleteSummaryCacheRecord(cacheKey);
  return { cacheKey, deleted: true };
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
  return GitBriefPrompt.buildMessages(repoContext);
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
  return GitBriefPrompt.buildPrompt(repo);
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
      sha: item.sha || "",
      size: Number(item.size || 0)
    }))
    : [];

  const sampleCandidates = Array.isArray(data)
    ? data
      .filter((item) => item?.type === "file" && item?.download_url && isTextLike(item?.name || "") && Number(item?.size || 0) <= 200000)
      .slice(0, GitBriefPrompt.PROMPT_BUDGETS.catalogSampleFiles)
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
        snippet: GitBriefPrompt.truncateForPrompt(text, GitBriefPrompt.PROMPT_BUDGETS.catalogSampleChars)
      };
    } catch {
      return null;
    }
  }));

  return {
    entries: entries.slice(0, GitBriefPrompt.PROMPT_BUDGETS.catalogEntries),
    fileSamples: fileSamples.filter(Boolean)
  };
}

function normalizeSummaryCacheScope(payload) {
  return {
    owner: String(payload?.owner || "").trim(),
    name: String(payload?.name || "").trim(),
    branch: String(payload?.branch || "main").trim() || "main",
    effectiveMode: String(payload?.effectiveMode || "repository").trim() || "repository",
    scopePath: normalizeSummaryPath(payload?.scopePath || "/"),
    pageType: String(payload?.pageType || "").trim()
  };
}

function normalizeSummaryPath(path) {
  const normalized = String(path || "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

function makeSummaryCacheKey(scope) {
  return [
    scope.owner,
    scope.name,
    scope.branch,
    scope.effectiveMode,
    scope.scopePath
  ].join("|");
}

async function fetchPathMetadata(scope) {
  const data = await fetchGitHubContents(scope);
  const entries = Array.isArray(data) ? data : [data];
  const normalizedEntries = entries
    .filter(Boolean)
    .map((item) => ({
      type: item.type || (Array.isArray(data) ? "unknown" : "file"),
      path: item.path || scope.scopePath,
      sha: item.sha || "",
      size: Number(item.size || 0)
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const pathFingerprint = [
    `v${SUMMARY_METADATA_VERSION}`,
    Array.isArray(data) ? "directory" : "file",
    ...normalizedEntries.map((item) => `${item.type}:${item.path}:${item.sha}:${item.size}`)
  ].join("|");

  return {
    metadataVersion: SUMMARY_METADATA_VERSION,
    fetchedAt: Date.now(),
    type: Array.isArray(data) ? "directory" : "file",
    entries: normalizedEntries,
    pathFingerprint
  };
}

async function fetchGitHubContents(scope) {
  const owner = encodeURIComponent(scope.owner || "");
  const name = encodeURIComponent(scope.name || "");
  const branch = encodeURIComponent(scope.branch || "main");
  const path = String(scope.scopePath || "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  if (!owner || !name) {
    throw new Error("缺少仓库 owner 或 name，无法校验缓存。");
  }

  const apiPath = path ? `/${path}` : "";
  const url = `https://api.github.com/repos/${owner}/${name}/contents${apiPath}?ref=${branch}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub 元数据请求失败：${response.status} ${response.statusText}`);
  }

  return response.json();
}

function openSummaryCacheDb() {
  if (summaryCacheDbPromise) {
    return summaryCacheDbPromise;
  }

  summaryCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SUMMARY_CACHE_DB_NAME, SUMMARY_CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUMMARY_CACHE_STORE)) {
        const store = db.createObjectStore(SUMMARY_CACHE_STORE, { keyPath: "cacheKey" });
        store.createIndex("updatedAt", "updatedAt");
        store.createIndex("lastAccessedAt", "lastAccessedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 打开失败。"));
  });

  return summaryCacheDbPromise;
}

async function readSummaryCacheRecord(cacheKey) {
  const db = await openSummaryCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARY_CACHE_STORE, "readonly");
    const request = tx.objectStore(SUMMARY_CACHE_STORE).get(cacheKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("读取摘要缓存失败。"));
  });
}

async function writeSummaryCacheRecord(record) {
  const db = await openSummaryCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARY_CACHE_STORE, "readwrite");
    tx.objectStore(SUMMARY_CACHE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("写入摘要缓存失败。"));
    tx.onabort = () => reject(tx.error || new Error("写入摘要缓存失败。"));
  });
}

async function updateSummaryCacheAccess(cacheKey) {
  const record = await readSummaryCacheRecord(cacheKey);
  if (!record) {
    return;
  }
  await writeSummaryCacheRecord({ ...record, lastAccessedAt: Date.now() });
}

async function deleteSummaryCacheRecord(cacheKey) {
  const db = await openSummaryCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARY_CACHE_STORE, "readwrite");
    tx.objectStore(SUMMARY_CACHE_STORE).delete(cacheKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("删除摘要缓存失败。"));
    tx.onabort = () => reject(tx.error || new Error("删除摘要缓存失败。"));
  });
}

async function cleanupSummaryCache() {
  const db = await openSummaryCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SUMMARY_CACHE_STORE, "readwrite");
    const store = tx.objectStore(SUMMARY_CACHE_STORE);
    const request = store.getAll();

    request.onsuccess = () => {
      const now = Date.now();
      const records = Array.isArray(request.result) ? request.result : [];
      const invalidKeys = records
        .filter((record) => (
          !record?.summary ||
          record.promptVersion !== SUMMARY_PROMPT_VERSION ||
          (!record.pathFingerprint && now - Number(record.updatedAt || record.createdAt || 0) > SUMMARY_CACHE_FALLBACK_TTL_MS)
        ))
        .map((record) => record.cacheKey);
      const invalidKeySet = new Set(invalidKeys);
      const validRecords = records
        .filter((record) => !invalidKeySet.has(record.cacheKey))
        .sort((a, b) => Number(b.lastAccessedAt || b.updatedAt || 0) - Number(a.lastAccessedAt || a.updatedAt || 0));
      const overflowKeys = validRecords
        .slice(SUMMARY_CACHE_MAX_RECORDS)
        .map((record) => record.cacheKey);

      for (const cacheKey of [...invalidKeys, ...overflowKeys]) {
        store.delete(cacheKey);
      }
    };
    request.onerror = () => reject(request.error || new Error("清理摘要缓存失败。"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("清理摘要缓存失败。"));
    tx.onabort = () => reject(tx.error || new Error("清理摘要缓存失败。"));
  });
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
