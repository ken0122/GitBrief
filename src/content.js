const CARD_ID = "gh-repo-ai-summary-card";
const BRIEF_MODE_STORAGE_KEY = "briefModePreference";
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
let briefModePreference = "catalog";

init();

function init() {
  loadScopeModePreference().finally(scheduleRender);
  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", scheduleRender);

  const observer = new MutationObserver(scheduleRender);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

async function loadScopeModePreference() {
  try {
    const stored = await chrome.storage.local.get({ [BRIEF_MODE_STORAGE_KEY]: "catalog" });
    const mode = String(stored[BRIEF_MODE_STORAGE_KEY] || "catalog");
    if (isValidBriefMode(mode)) {
      briefModePreference = mode;
    }
  } catch {
    briefModePreference = "catalog";
  }
}

function patchHistoryMethod(methodName) {
  const original = history[methodName];
  history[methodName] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    scheduleRender();
    return result;
  };
}

function scheduleRender() {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderCard().catch(() => {});
  }, 250);
}

async function renderCard() {
  const repo = parseRepository();
  const existing = document.getElementById(CARD_ID);
  const mountTarget = findMountTarget();

  if (!repo || !mountTarget) {
    existing?.remove();
    lastRenderKey = "";
    return;
  }

  const pageContext = detectPageContext(repo);
  const showDropdown = isSublevelPage(pageContext);
  const scopeInfo = resolveScopeInfo(briefModePreference, pageContext, showDropdown);
  const hierarchyText = renderHierarchyText(repo, pageContext);
  const renderKey = [
    repo.owner,
    repo.name,
    location.pathname,
    mountTarget.kind,
    briefModePreference,
    showDropdown,
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
    <div class="gh-repo-ai-card__actions ${showDropdown ? "" : "gh-repo-ai-card__actions--single"}">
      <button class="gh-repo-ai-card__button gh-repo-ai-card__button--main" type="button">${escapeHtml(renderPrimaryButtonLabel(scopeInfo))}</button>
      ${showDropdown ? `
        <button
          class="gh-repo-ai-card__button gh-repo-ai-card__button--toggle"
          type="button"
          aria-haspopup="menu"
          aria-expanded="false"
          title="切换摘要范围"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M12.78 5.22a.75.75 0 0 1 0 1.06L8.53 10.53a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.75.75 0 0 1 1.06 0Z" fill="currentColor"></path>
          </svg>
        </button>
        <div class="gh-repo-ai-card__menu" role="menu" hidden>
          ${renderModeMenuItems(briefModePreference)}
        </div>
      ` : ""}
    </div>
    <div class="gh-repo-ai-card__status" role="status"></div>
    <article class="gh-repo-ai-card__result" hidden></article>
  `;

  const mainButton = card.querySelector(".gh-repo-ai-card__button--main");
  const toggleButton = card.querySelector(".gh-repo-ai-card__button--toggle");
  const menu = card.querySelector(".gh-repo-ai-card__menu");

  mainButton.addEventListener("click", () => {
    const latestPageContext = detectPageContext(repo);
    const latestScopeInfo = resolveScopeInfo(briefModePreference, latestPageContext, isSublevelPage(latestPageContext));
    handleSummarize(card, repo, latestPageContext, latestScopeInfo);
  });

  if (toggleButton && menu) {
    toggleButton.addEventListener("click", (event) => {
      event.preventDefault();
      const willOpen = menu.hidden;
      closeAllDropdownMenus();
      if (willOpen) {
        menu.hidden = false;
        toggleButton.setAttribute("aria-expanded", "true");
      }
    });

    menu.querySelectorAll("[data-brief-mode]").forEach((item) => {
      item.addEventListener("click", async (event) => {
        event.preventDefault();
        const mode = event.currentTarget.dataset.briefMode;
        await setBriefModePreference(mode);
      });
    });
  }

  card.querySelector(".gh-repo-ai-card__settings").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.sendMessage({ type: "open-options" });
  });

  mountCard(card, mountTarget);
}

async function setBriefModePreference(next) {
  const mode = String(next || "catalog");
  if (!isValidBriefMode(mode)) {
    return;
  }

  briefModePreference = mode;
  await chrome.storage.local.set({ [BRIEF_MODE_STORAGE_KEY]: mode });
  scheduleRender();
}

function closeAllDropdownMenus() {
  document.querySelectorAll(".gh-repo-ai-card__menu").forEach((node) => {
    node.hidden = true;
  });
  document.querySelectorAll(".gh-repo-ai-card__button--toggle").forEach((node) => {
    node.setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !target.closest(`#${CARD_ID}`)) {
    closeAllDropdownMenus();
  }
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAllDropdownMenus();
  }
});

function renderModeMenuItems(activeMode) {
  const modes = [
    { value: "catalog", label: "Brief catalog" },
    { value: "repo", label: "Brief repo" }
  ];

  return modes.map((mode) => {
    const selected = mode.value === activeMode;
    const mark = selected ? "✓ " : "";
    return `<button type="button" class="gh-repo-ai-card__menu-item" role="menuitemradio" aria-checked="${selected ? "true" : "false"}" data-brief-mode="${mode.value}">${mark}${mode.label}</button>`;
  }).join("");
}

function renderPrimaryButtonLabel(scopeInfo) {
  if (scopeInfo.preference === "catalog") {
    return "Brief catalog";
  }
  return "Brief repo";
}

function renderHierarchyText(repo, pageContext) {
  if (!pageContext.path) {
    return `${repo.owner}/${repo.name}`;
  }
  return `${repo.owner}/${repo.name}/${pageContext.path}`;
}

function isValidBriefMode(mode) {
  return mode === "catalog" || mode === "repo";
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

function resolveScopeInfo(preference, pageContext, showDropdown) {
  if (!showDropdown) {
    return {
      preference: "repo",
      effectiveMode: "repository",
      scopePath: "/",
      warning: ""
    };
  }

  const safePreference = isValidBriefMode(preference) ? preference : "catalog";
  if (safePreference === "repo") {
    return {
      preference: "repo",
      effectiveMode: "repository",
      scopePath: "/",
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
  return scopeInfo.preference === "catalog"
    ? `目录范围（${scopeInfo.scopePath}）`
    : "仓库范围（/）";
}

function isSublevelPage(pageContext) {
  return pageContext.pageType === "tree" || pageContext.pageType === "blob";
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
  const toggleButton = card.querySelector(".gh-repo-ai-card__button--toggle");
  const status = card.querySelector(".gh-repo-ai-card__status");
  const result = card.querySelector(".gh-repo-ai-card__result");

  closeAllDropdownMenus();
  mainButton.disabled = true;
  if (toggleButton) {
    toggleButton.disabled = true;
  }
  status.textContent = `正在采集${renderScopeHint(scopeInfo)}的信息...`;
  result.hidden = true;
  result.textContent = "";

  try {
    const context = await collectRepositoryContext(repo, pageContext, scopeInfo);
    status.textContent = "正在调用模型生成摘要...";

    const response = await chrome.runtime.sendMessage({
      type: "summarize-repository",
      payload: context
    });

    if (!response?.ok) {
      throw new Error(response?.error || "摘要生成失败。");
    }

    result.innerHTML = renderMarkdownLike(response.summary);
    result.hidden = false;
    status.textContent = "摘要已生成。";
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally {
    mainButton.disabled = false;
    if (toggleButton) {
      toggleButton.disabled = false;
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
  const readme = await collectReadme(repo, pageContext.branch, scopeInfo);
  const fileContext = await collectFileContext(repo, pageContext, scopeInfo);
  const directoryContext = await collectDirectoryContext(repo, pageContext, scopeInfo);

  return {
    ...repo,
    title,
    description: truncate(description, 1000),
    topics,
    languages,
    files,
    readme: truncate(readme, 14000),
    filePath: fileContext.path,
    fileContent: truncate(fileContext.content, 12000),
    directoryEntries: directoryContext.entries,
    directoryFileSamples: directoryContext.fileSamples,
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

async function collectDirectoryContext(repo, pageContext, scopeInfo) {
  if (scopeInfo.preference !== "catalog") {
    return { entries: [], fileSamples: [] };
  }

  const directoryPath = String(scopeInfo.scopePath || "/").replace(/^\/+/, "");
  const response = await chrome.runtime.sendMessage({
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
  if (scopeInfo.preference !== "catalog" || pageContext.pageType !== "blob") {
    return { path: "", content: "" };
  }
  if (!pageContext.path) {
    return { path: "", content: "" };
  }

  const pageCode = collectCodeFromPage();
  if (pageCode) {
    return { path: pageContext.path, content: pageCode };
  }

  const response = await chrome.runtime.sendMessage({
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

  const scopePath = String(scopeInfo?.scopePath || "/").replace(/^\/+/, "");
  const preferScoped = scopeInfo?.preference === "catalog" && scopePath.length > 0;

  const response = await chrome.runtime.sendMessage({
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
    .slice(0, 50);
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
