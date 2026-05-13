const CARD_ID = "gh-repo-ai-summary-card";
const CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTEXT_CACHE_MAX_ENTRIES = 20;
const CONTEXT_BUDGETS = {
  repoReadmeChars: 3500,
  repoVisibleFiles: 30,
  catalogEntries: 50,
  catalogSampleFiles: 2,
  catalogSampleChars: 700,
  catalogFallbackReadmeChars: 800,
  fileContentChars: 4500,
  fileFallbackReadmeChars: 500
};
const ROUTE_EXCLUDES = new Set([
  "about",
  "account",
  "codespaces",
  "collections",
  "contact",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "gist",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending"
]);

let lastRenderKey = "";
let renderTimer = 0;
let extensionContextInvalidated = false;
let pageObserver = null;
const summaryCache = new Map();
const streamRequests = new Map();

installExtensionContextErrorHandlers();
init();

function installExtensionContextErrorHandlers() {
  window.addEventListener("error", (event) => {
    if (!isExtensionContextInvalidated(event.error || event.message)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    handleInvalidatedExtensionContext();
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    if (!isExtensionContextInvalidated(event.reason)) {
      return;
    }

    event.preventDefault();
    handleInvalidatedExtensionContext();
  }, true);
}

function handleInvalidatedExtensionContext() {
  extensionContextInvalidated = true;
  window.clearTimeout(renderTimer);
  pageObserver?.disconnect();
  for (const request of streamRequests.values()) {
    request.reject(new Error("扩展已重新加载，请刷新当前 GitHub 页面后再试。"));
  }
  streamRequests.clear();
}

function init() {
  if (!isExtensionContextAvailable()) {
    handleInvalidatedExtensionContext();
    return;
  }

  scheduleRender();
  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", scheduleRender);

  pageObserver = new MutationObserver(scheduleRender);
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });
}

async function safeSendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      console.debug("[GitBrief] extension context invalidated while sending message", { type: message?.type });
      return { ok: false, error: "扩展已重新加载，请刷新当前 GitHub 页面后再试。" };
    }
    throw error;
  }
}

function isExtensionContextInvalidated(error) {
  return String(error?.message || error || "").includes("Extension context invalidated");
}

function isExtensionContextAvailable() {
  if (extensionContextInvalidated) {
    return false;
  }

  try {
    return Boolean(chrome?.runtime?.id);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      handleInvalidatedExtensionContext();
      return false;
    }
    throw error;
  }
}

function patchHistoryMethod(methodName) {
  const original = history[methodName];
  history[methodName] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    if (isExtensionContextAvailable()) {
      scheduleRender();
    }
    return result;
  };
}

function scheduleRender() {
  if (!isExtensionContextAvailable()) {
    return;
  }

  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    if (!isExtensionContextAvailable()) {
      return;
    }
    renderCard().catch(() => {});
  }, 250);
}

async function renderCard() {
  if (!isExtensionContextAvailable()) {
    return;
  }

  const repo = parseRepository();
  const existing = document.getElementById(CARD_ID);
  const mountTarget = findMountTarget();

  if (!repo || !mountTarget) {
    existing?.remove();
    lastRenderKey = "";
    return;
  }

  const pageContext = detectPageContext(repo);
  const scopeInfo = resolveScopeInfo(pageContext);
  const hierarchyText = renderHierarchyText(repo, pageContext);
  const renderKey = [
    repo.owner,
    repo.name,
    location.pathname,
    mountTarget.kind,
    scopeInfo.effectiveMode,
    hierarchyText
  ].join("|");

  if (existing && existing.parentElement && lastRenderKey === renderKey) {
    return;
  }

  existing?.remove();
  lastRenderKey = renderKey;

  const card = document.createElement("section");
  card.id = CARD_ID;
  card.className = `gh-repo-ai-card gh-repo-ai-card--${mountTarget.kind}`;
  card.dataset.repo = `${repo.owner}/${repo.name}`;
  card.dataset.mount = mountTarget.kind;
  card.innerHTML = `
    <div class="gh-repo-ai-card__header">
      <div>
        <h2>GitBrief</h2>
        <p>${escapeHtml(hierarchyText)}</p>
      </div>
      <a class="gh-repo-ai-card__settings" href="#" title="打开扩展设置">设置</a>
    </div>
    <div class="gh-repo-ai-card__actions gh-repo-ai-card__actions--single">
      <button class="gh-repo-ai-card__button gh-repo-ai-card__button--main" type="button">${escapeHtml(renderPrimaryButtonLabel(scopeInfo))}</button>
    </div>
    <div class="gh-repo-ai-card__status" role="status"></div>
    <article class="gh-repo-ai-card__result" hidden></article>
  `;

  const mainButton = card.querySelector(".gh-repo-ai-card__button--main");

  mainButton.addEventListener("click", () => {
    if (!isExtensionContextAvailable()) {
      return;
    }
    const latestPageContext = detectPageContext(repo);
    const latestScopeInfo = resolveScopeInfo(latestPageContext);
    handleSummarize(card, repo, latestPageContext, latestScopeInfo);
  });

  card.querySelector(".gh-repo-ai-card__settings").addEventListener("click", (event) => {
    event.preventDefault();
    if (!isExtensionContextAvailable()) {
      return;
    }
    safeSendMessage({ type: "open-options" });
  });

  mountCard(card, mountTarget);
}

registerStreamMessageListener();

function registerStreamMessageListener() {
  if (!isExtensionContextAvailable()) {
    return;
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message?.requestId || !String(message.type || "").startsWith("summarize-repository-stream-")) {
        return false;
      }

      const request = streamRequests.get(message.requestId);
      if (!request) {
        return false;
      }

      if (message.type === "summarize-repository-stream-chunk") {
        request.onChunk(message.chunk || "", message);
        return false;
      }

      if (message.type === "summarize-repository-stream-done") {
        streamRequests.delete(message.requestId);
        request.resolve(message);
        return false;
      }

      if (message.type === "summarize-repository-stream-error") {
        streamRequests.delete(message.requestId);
        request.reject(new Error(message.error || "摘要生成失败。"));
        return false;
      }

      return false;
    });
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      handleInvalidatedExtensionContext();
      return;
    }
    throw error;
  }
}

function renderPrimaryButtonLabel(scopeInfo) {
  if (scopeInfo.preference === "file") {
    return "Brief file";
  }
  return scopeInfo.preference === "catalog" ? "Brief catalog" : "Brief repo";
}

function renderHierarchyText(repo, pageContext) {
  if (!pageContext.path) {
    return `${repo.owner}/${repo.name}`;
  }
  return `${repo.owner}/${repo.name}/${pageContext.path}`;
}

function parseRepository() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || ROUTE_EXCLUDES.has(parts[0])) {
    return null;
  }

  const [owner, name] = parts;
  if (!owner || !name || name.endsWith(".git")) {
    return null;
  }

  return { owner, name };
}

function detectPageContext(repo) {
  const parts = location.pathname.split("/").filter(Boolean);
  const marker = parts[2] || "";
  const branch = decodeURIComponent(parts[3] || "");
  const path = decodeURIComponent(parts.slice(4).join("/"));

  if (marker === "tree") {
    return {
      pageType: "tree",
      branch: branch || getDefaultBranch(),
      path,
      owner: repo.owner,
      name: repo.name
    };
  }

  if (marker === "blob") {
    return {
      pageType: "blob",
      branch: branch || getDefaultBranch(),
      path,
      owner: repo.owner,
      name: repo.name
    };
  }

  return {
    pageType: "repo",
    branch: getDefaultBranch(),
    path: "",
    owner: repo.owner,
    name: repo.name
  };
}

function resolveScopeInfo(pageContext) {
  if (pageContext.pageType === "repo") {
    return {
      preference: "repo",
      effectiveMode: "repository",
      scopePath: "/",
      warning: ""
    };
  }

  if (pageContext.pageType === "blob") {
    return {
      preference: "file",
      effectiveMode: "file",
      scopePath: pageContext.path ? `/${pageContext.path}` : "/",
      warning: ""
    };
  }

  const scopePath = pageContext.pageType === "tree"
    ? (pageContext.path ? `/${pageContext.path}` : "/")
    : parentDirectoryPath(pageContext.path);

  return {
    preference: "catalog",
    effectiveMode: "directory",
    scopePath,
    warning: ""
  };
}

function renderScopeHint(scopeInfo) {
  if (scopeInfo.preference === "file") {
    return `文件范围（${scopeInfo.scopePath}）`;
  }
  return scopeInfo.preference === "catalog"
    ? `目录范围（${scopeInfo.scopePath}）`
    : "仓库范围（/）";
}

function parentDirectoryPath(path) {
  if (!path) {
    return "/";
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "/";
  }
  return `/${segments.slice(0, -1).join("/")}`;
}

function findSidebar() {
  const aboutSection = findAboutSection();
  if (aboutSection) {
    return {
      kind: "about",
      node: aboutSection
    };
  }

  const sidebar = (
    document.querySelector("aside.Layout-sidebar") ||
    document.querySelector(".Layout-sidebar") ||
    document.querySelector('[aria-label="Repository details"]') ||
    document.querySelector('[data-testid="repository-details-container"]')?.closest("aside, .Layout-sidebar, div") ||
    null
  );

  if (sidebar) {
    return { kind: "sidebar", node: sidebar };
  }

  return null;
}

function findAboutSection() {
  const headingGroups = [
    "aside h2, aside h3",
    ".Layout-sidebar h2, .Layout-sidebar h3",
    '[aria-label="Repository details"] h2, [aria-label="Repository details"] h3',
    '[data-testid="repository-details-container"] h2, [data-testid="repository-details-container"] h3',
    "h2, h3"
  ];

  let aboutHeading = null;
  for (const selector of headingGroups) {
    aboutHeading = Array.from(document.querySelectorAll(selector))
      .find((heading) => heading.textContent.trim() === "About");
    if (aboutHeading) {
      break;
    }
  }

  if (!aboutHeading) {
    return null;
  }

  return (
    aboutHeading.closest(".BorderGrid-cell") ||
    aboutHeading.closest('[data-testid="repository-details-container"]') ||
    aboutHeading.parentElement
  );
}

function findMountTarget() {
  const sidebar = findSidebar();
  if (sidebar) {
    return sidebar;
  }

  const repoHeader = document.querySelector("#repository-container-header");
  if (repoHeader?.parentElement) {
    return { kind: "header", node: repoHeader };
  }

  const repoMain = (
    document.querySelector("#repo-content-pjax-container") ||
    document.querySelector('[data-testid="repository-container"]') ||
    document.querySelector(".application-main main") ||
    document.querySelector("main")
  );

  if (repoMain) {
    return { kind: "main", node: repoMain };
  }

  return null;
}

function mountCard(card, target) {
  if (target.kind === "about") {
    target.node.insertBefore(card, target.node.firstChild);
    return;
  }

  if (target.kind === "sidebar") {
    target.node.insertBefore(card, target.node.firstChild);
    return;
  }

  if (target.kind === "header") {
    target.node.insertAdjacentElement("afterend", card);
    return;
  }

  target.node.insertBefore(card, target.node.firstChild);
}

async function handleSummarize(card, repo, pageContext, scopeInfo) {
  const mainButton = card.querySelector(".gh-repo-ai-card__button--main");
  const status = card.querySelector(".gh-repo-ai-card__status");
  const result = card.querySelector(".gh-repo-ai-card__result");

  mainButton.disabled = true;
  status.textContent = `正在采集${renderScopeHint(scopeInfo)}的信息...`;
  result.hidden = true;
  result.textContent = "";

  try {
    status.textContent = "正在检查本地摘要...";
    const cacheScope = makeSummaryCacheScope(repo, pageContext, scopeInfo);
    const cached = await getSummaryCache(cacheScope);
    if (cached?.summary) {
      result.innerHTML = renderMarkdownLike(cached.summary);
      result.hidden = false;
      status.textContent = cached.cacheWarning ? "已使用本地摘要，未能确认最新状态。" : "已使用本地摘要。";
      console.debug("[GitBrief] summary cache hit", {
        cacheKey: cacheScope.cacheKey,
        reason: cached.cacheReason,
        warning: cached.cacheWarning || ""
      });
      return;
    }
    if (cached?.stale) {
      status.textContent = "本地摘要已过期，正在更新...";
    } else {
      status.textContent = `正在采集${renderScopeHint(scopeInfo)}的信息...`;
    }

    const collectStartedAt = performance.now();
    const context = cached?.context || await collectRepositoryContext(repo, pageContext, scopeInfo);
    const collectDurationMs = Math.round(performance.now() - collectStartedAt);
    await setSummaryCache(cacheScope, { ...cached, context });
    console.debug("[GitBrief] context collected", { cacheKey: cacheScope.cacheKey, durationMs: collectDurationMs, cached: Boolean(cached?.context) });

    status.textContent = "正在生成摘要...";
    result.hidden = false;
    let streamedSummary = "";
    const modelStartedAt = performance.now();

    const doneMessage = await summarizeRepositoryWithStream(context, {
      onChunk(chunk, meta) {
        if (!chunk) {
          return;
        }
        streamedSummary += chunk;
        result.innerHTML = renderMarkdownLike(streamedSummary);
        if (meta?.firstChunkMs) {
          status.textContent = "正在生成摘要...";
        }
      }
    });

    const summary = String(doneMessage.summary || streamedSummary).trim();
    if (!summary) {
      throw new Error("模型接口没有返回可用摘要。");
    }

    result.innerHTML = renderMarkdownLike(summary);
    await setSummaryCache(cacheScope, { context, summary });
    status.textContent = doneMessage.fallback ? "摘要已生成（已使用兼容模式）。" : "摘要已生成。";
    console.debug("[GitBrief] summary generated", {
      cacheKey: cacheScope.cacheKey,
      firstTokenMs: doneMessage.firstChunkMs || null,
      modelDurationMs: doneMessage.durationMs || Math.round(performance.now() - modelStartedAt),
      fallback: Boolean(doneMessage.fallback)
    });
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    mainButton.disabled = false;
  }
}

async function summarizeRepositoryWithStream(context, handlers) {
  const requestId = createStreamRequestId();
  const streamPromise = new Promise((resolve, reject) => {
    streamRequests.set(requestId, {
      resolve,
      reject,
      onChunk: handlers?.onChunk || (() => {})
    });
  });

  safeSendMessage({
    type: "summarize-repository-stream-start",
    requestId,
    payload: context
  })
    .then((response) => {
      const request = streamRequests.get(requestId);
      if (!request) {
        return;
      }

      streamRequests.delete(requestId);
      if (!response?.ok || response.error) {
        request.reject(new Error(response?.error || "摘要生成失败。"));
        return;
      }

      request.resolve(response);
    })
    .catch((error) => {
      const request = streamRequests.get(requestId);
      if (!request) {
        return;
      }

      streamRequests.delete(requestId);
      request.reject(error);
    });

  return streamPromise;
}

function createStreamRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function makeSummaryCacheScope(repo, pageContext, scopeInfo) {
  const scopePath = normalizeCachePath(scopeInfo.scopePath || "/");
  const scope = {
    owner: repo.owner,
    name: repo.name,
    branch: pageContext.branch || "",
    effectiveMode: scopeInfo.effectiveMode || "",
    scopePath,
    pageType: pageContext.pageType || "",
    sourceUrl: location.href
  };
  return {
    ...scope,
    cacheKey: makeSummaryCacheKey(scope)
  };
}

function makeSummaryCacheKey(repo, pageContext, scopeInfo) {
  return [
    repo.owner,
    repo.name,
    repo.branch || pageContext?.branch || "",
    repo.effectiveMode || scopeInfo?.effectiveMode || "",
    repo.scopePath || normalizeCachePath(scopeInfo?.scopePath || "/")
  ].join("|");
}

function normalizeCachePath(path) {
  const normalized = String(path || "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "/";
}

async function getSummaryCache(cacheScope) {
  const entry = summaryCache.get(cacheScope.cacheKey);
  const memoryValue = entry && Date.now() - entry.createdAt <= CONTEXT_CACHE_TTL_MS
    ? entry.value
    : null;
  if (entry && !memoryValue) {
    summaryCache.delete(cacheScope.cacheKey);
  }

  const response = await safeSendMessage({
    type: "get-summary-cache",
    payload: cacheScope
  });

  if (response?.ok && response.hit && response.summary) {
    return {
      ...memoryValue,
      summary: response.summary,
      cacheReason: response.reason || "",
      cacheWarning: response.warning || ""
    };
  }

  if (response?.ok && response.stale) {
    return {
      ...memoryValue,
      stale: true,
      cacheReason: response.reason || "",
      cacheWarning: response.warning || ""
    };
  }

  return memoryValue;
}

async function setSummaryCache(cacheScope, value) {
  const entry = {
    createdAt: Date.now(),
    value: value?.context ? { context: value.context } : {}
  };

  summaryCache.set(cacheScope.cacheKey, entry);

  if (summaryCache.size > CONTEXT_CACHE_MAX_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value;
    summaryCache.delete(oldestKey);
  }

  if (value?.summary) {
    const response = await safeSendMessage({
      type: "set-summary-cache",
      payload: {
        ...cacheScope,
        summary: value.summary,
        sourceUrl: cacheScope.sourceUrl
      }
    });
    if (!response?.ok) {
      console.debug("[GitBrief] summary cache write skipped", { error: response?.error || "unknown" });
    }
  }
}

async function collectRepositoryContext(repo, pageContext, scopeInfo) {
  const title = document.querySelector("strong[itemprop='name'] a")?.textContent?.trim() || repo.name;
  const description = (
    document.querySelector("[itemprop='about']")?.textContent ||
    document.querySelector("meta[name='description']")?.content ||
    ""
  ).trim();
  const topics = uniqueTexts(document.querySelectorAll("a.topic-tag"));
  const languages = collectLanguages();
  const files = collectVisibleFiles();
  let readme = "";
  let fileContext = { path: "", content: "" };
  let directoryContext = { entries: [], fileSamples: [] };

  if (scopeInfo.preference === "file") {
    fileContext = await collectFileContext(repo, pageContext, scopeInfo).catch(() => ({ path: "", content: "" }));
    if (!fileContext.content) {
      readme = await collectReadme(repo, pageContext.branch, scopeInfo).catch(() => "");
    }
  } else if (scopeInfo.preference === "catalog") {
    directoryContext = await collectDirectoryContext(repo, pageContext, scopeInfo).catch(() => ({ entries: [], fileSamples: [] }));
    if (!directoryContext.fileSamples.length) {
      readme = await collectReadme(repo, pageContext.branch, scopeInfo).catch(() => "");
    }
  } else {
    readme = await collectReadme(repo, pageContext.branch, scopeInfo).catch(() => "");
  }

  const readmeLimit = resolveReadmeLimit(scopeInfo, fileContext, directoryContext);

  return {
    ...repo,
    title,
    description: truncate(description, 1000),
    topics,
    languages,
    files,
    readme: readmeLimit ? truncate(readme, readmeLimit) : "",
    filePath: fileContext.path,
    fileContent: truncate(fileContext.content, CONTEXT_BUDGETS.fileContentChars),
    directoryEntries: limitDirectoryEntries(directoryContext.entries),
    directoryFileSamples: limitDirectoryFileSamples(directoryContext.fileSamples),
    scope: {
      preference: scopeInfo.preference,
      effectiveMode: scopeInfo.effectiveMode,
      scopePath: scopeInfo.scopePath,
      warning: scopeInfo.warning,
      pageType: pageContext.pageType,
      branch: pageContext.branch
    },
    url: location.href
  };
}

function resolveReadmeLimit(scopeInfo, fileContext, directoryContext) {
  if (scopeInfo.preference === "repo") {
    return CONTEXT_BUDGETS.repoReadmeChars;
  }
  if (scopeInfo.preference === "catalog" && !directoryContext.fileSamples.length) {
    return CONTEXT_BUDGETS.catalogFallbackReadmeChars;
  }
  if (scopeInfo.preference === "file" && !fileContext.content) {
    return CONTEXT_BUDGETS.fileFallbackReadmeChars;
  }
  return 0;
}

function limitDirectoryEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.slice(0, CONTEXT_BUDGETS.catalogEntries);
}

function limitDirectoryFileSamples(samples) {
  if (!Array.isArray(samples)) {
    return [];
  }
  return samples
    .filter((item) => String(item?.snippet || "").trim())
    .slice(0, CONTEXT_BUDGETS.catalogSampleFiles)
    .map((item) => ({
      ...item,
      snippet: truncate(item.snippet, CONTEXT_BUDGETS.catalogSampleChars)
    }));
}

async function collectDirectoryContext(repo, pageContext, scopeInfo) {
  if (scopeInfo.preference !== "catalog") {
    return { entries: [], fileSamples: [] };
  }

  const directoryPath = String(scopeInfo.scopePath || "/").replace(/^\/+/, "");
  const response = await safeSendMessage({
    type: "fetch-directory-snapshot",
    payload: {
      owner: repo.owner,
      name: repo.name,
      branch: pageContext.branch,
      path: directoryPath
    }
  });

  if (response?.ok && response.snapshot) {
    return {
      entries: Array.isArray(response.snapshot.entries) ? response.snapshot.entries : [],
      fileSamples: Array.isArray(response.snapshot.fileSamples) ? response.snapshot.fileSamples : []
    };
  }

  return { entries: [], fileSamples: [] };
}

async function collectFileContext(repo, pageContext, scopeInfo) {
  if (scopeInfo.preference !== "file" || pageContext.pageType !== "blob") {
    return { path: "", content: "" };
  }
  if (!pageContext.path) {
    return { path: "", content: "" };
  }

  const pageCode = collectCodeFromPage();
  if (pageCode) {
    return { path: pageContext.path, content: pageCode };
  }

  const response = await safeSendMessage({
    type: "fetch-file-content",
    payload: {
      owner: repo.owner,
      name: repo.name,
      branch: pageContext.branch,
      path: pageContext.path
    }
  });

  if (response?.ok) {
    return { path: pageContext.path, content: response.content || "" };
  }

  return { path: pageContext.path, content: "" };
}

function collectCodeFromPage() {
  const lines = Array.from(document.querySelectorAll("td.blob-code .blob-code-inner, .react-file-line-contents"));
  const text = lines
    .map((node) => node.textContent || "")
    .join("\n")
    .trim();
  return text;
}

async function collectReadme(repo, branch, scopeInfo) {
  const pageReadme = document.querySelector("article.markdown-body")?.innerText?.trim();
  if (pageReadme) {
    return pageReadme;
  }

  const readmeScopePath = scopeInfo?.preference === "file"
    ? parentDirectoryPath(scopeInfo.scopePath)
    : scopeInfo?.scopePath;
  const scopePath = String(readmeScopePath || "/").replace(/^\/+/, "");
  const preferScoped = scopeInfo?.preference === "catalog" && scopePath.length > 0;

  const response = await safeSendMessage({
    type: "fetch-readme",
    payload: {
      ...repo,
      branch: branch || getDefaultBranch(),
      scopePath,
      includeRootFallback: !preferScoped
    }
  });

  if (response?.ok) {
    return response.readme || "";
  }

  return "";
}

function getDefaultBranch() {
  const branchButton = document.querySelector('[data-hotkey="w"] span')?.textContent?.trim();
  if (branchButton) {
    return branchButton;
  }

  const branchFromUrl = location.pathname.match(/\/tree\/([^/]+)/)?.[1];
  return decodeURIComponent(branchFromUrl || "main");
}

function collectLanguages() {
  const languageRows = Array.from(document.querySelectorAll("a[href*='search?l='], a[href*='/search?l=']"));
  const labels = languageRows
    .map((node) => node.textContent.replace(/\s+/g, " ").trim())
    .filter((text) => text && !text.includes("Search all"));

  return [...new Set(labels)].slice(0, 12);
}

function collectVisibleFiles() {
  const nodes = Array.from(document.querySelectorAll(
    '[aria-labelledby="files"] a[href], [data-testid="list-view-item-title"] a[href], div[role="rowheader"] a[href]'
  ));

  return [...new Set(nodes
    .map((node) => node.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, CONTEXT_BUDGETS.repoVisibleFiles);
}

function uniqueTexts(nodes) {
  return [...new Set(Array.from(nodes)
    .map((node) => node.textContent.replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, 20);
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || "";
  }

  return `${text.slice(0, maxLength)}\n...[已截断]`;
}

function renderMarkdownLike(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^## (.*)$/gm, "<h4>$1</h4>")
    .replace(/^# (.*)$/gm, "<h4>$1</h4>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
