(function attachGitBriefPrompt(root) {
  const PROMPT_BUDGETS = {
    repoReadmeChars: 3500,
    repoVisibleFiles: 30,
    catalogEntries: 50,
    catalogSampleFiles: 2,
    catalogSampleChars: 700,
    catalogFallbackReadmeChars: 800,
    fileContentChars: 4500,
    fileFallbackReadmeChars: 500
  };

  const SYSTEM_PROMPT = "你是 GitBrief，只做 GitHub 页面快速摘要。用中文，具体、短，不写长报告；只基于给定上下文，不确定就说“不确定”。";

  function buildMessages(repoContext) {
    return [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: buildPrompt(repoContext)
      }
    ];
  }

  function buildPrompt(repo) {
    const scopeMode = repo?.scope?.effectiveMode || "repository";
    if (scopeMode === "directory") {
      return buildCatalogPrompt(repo);
    }
    if (scopeMode === "file") {
      return buildFilePrompt(repo);
    }
    return buildRepoPrompt(repo);
  }

  function buildRepoPrompt(repo) {
    const lines = [
      `仓库：${formatRepoName(repo)}`
    ];
    pushLabeledLine(lines, "简介", repo?.description);
    pushLabeledLine(lines, "语言", joinList(repo?.languages));
    pushLabeledLine(lines, "文件", joinList(repo?.files, PROMPT_BUDGETS.repoVisibleFiles));
    pushBlock(lines, "README摘录", truncateForPrompt(repo?.readme, PROMPT_BUDGETS.repoReadmeChars));
    pushOutput(lines, ["做什么", "怎么用", "先看哪里", "注意点"], "建议 300 中文字内。");
    return lines.join("\n");
  }

  function buildCatalogPrompt(repo) {
    const lines = [
      `目录：${formatRepoName(repo)}${normalizeDisplayPath(repo?.scope?.scopePath || "/")}`
    ];
    pushBlock(lines, "条目", formatDirectoryEntries(repo?.directoryEntries, PROMPT_BUDGETS.catalogEntries));
    pushBlock(lines, "样例", formatDirectorySamples(
      repo?.directoryFileSamples,
      PROMPT_BUDGETS.catalogSampleFiles,
      PROMPT_BUDGETS.catalogSampleChars
    ));
    if (!hasDirectorySamples(repo?.directoryFileSamples)) {
      pushBlock(lines, "README摘录", truncateForPrompt(repo?.readme, PROMPT_BUDGETS.catalogFallbackReadmeChars));
    }
    pushOutput(lines, ["目录职责", "关键文件", "阅读建议"], "建议 250 中文字内。");
    return lines.join("\n");
  }

  function buildFilePrompt(repo) {
    const filePath = normalizeDisplayPath(repo?.filePath || repo?.scope?.scopePath || "");
    const lines = [
      `文件：${formatRepoName(repo)}${filePath}`
    ];
    const fileContent = truncateForPrompt(repo?.fileContent, PROMPT_BUDGETS.fileContentChars);
    pushBlock(lines, "代码", fileContent);
    if (!fileContent) {
      pushBlock(lines, "README背景", truncateForPrompt(repo?.readme, PROMPT_BUDGETS.fileFallbackReadmeChars));
    }
    pushOutput(lines, ["文件职责", "关键逻辑", "依赖/注意点"], "建议 300 中文字内。");
    return lines.join("\n");
  }

  function formatRepoName(repo) {
    return `${repo?.owner || ""}/${repo?.name || ""}`;
  }

  function normalizeDisplayPath(path) {
    const value = String(path || "").trim();
    if (!value || value === "/") {
      return "/";
    }
    return `/${value.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }

  function pushLabeledLine(lines, label, value) {
    const text = joinList(value);
    if (text) {
      lines.push(`${label}：${text}`);
    }
  }

  function pushBlock(lines, label, value) {
    const text = String(value || "").trim();
    if (!text) {
      return;
    }
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`${label}：`, text);
  }

  function pushOutput(lines, items, suggestion) {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push("输出：", ...items.map((item) => `- ${item}`), suggestion);
  }

  function joinList(value, maxItems) {
    if (Array.isArray(value)) {
      return value
        .filter(Boolean)
        .slice(0, maxItems || value.length)
        .join(", ");
    }
    return String(value || "").trim();
  }

  function hasDirectorySamples(samples) {
    return Array.isArray(samples) && samples.some((item) => String(item?.snippet || "").trim());
  }

  function formatDirectoryEntries(entries, maxItems = PROMPT_BUDGETS.catalogEntries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return "";
    }
    return entries
      .slice(0, maxItems)
      .map((item) => `${item?.type === "dir" ? "[DIR]" : "[FILE]"} ${item?.path || "(unknown)"}`)
      .join("\n");
  }

  function formatDirectorySamples(samples, maxItems = PROMPT_BUDGETS.catalogSampleFiles, maxChars = PROMPT_BUDGETS.catalogSampleChars) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return "";
    }
    return samples
      .filter((item) => String(item?.snippet || "").trim())
      .slice(0, maxItems)
      .map((item) => `--- ${item.path || "(unknown)"} ---\n${truncateForPrompt(item.snippet, maxChars)}`)
      .join("\n\n");
  }

  function truncateForPrompt(text, maxLength) {
    const value = String(text || "").trim();
    if (!value || !maxLength) {
      return "";
    }
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}\n...[已截断]`;
  }

  const api = {
    PROMPT_BUDGETS,
    SYSTEM_PROMPT,
    buildMessages,
    buildPrompt,
    buildRepoPrompt,
    buildCatalogPrompt,
    buildFilePrompt,
    formatDirectoryEntries,
    formatDirectorySamples,
    truncateForPrompt
  };

  root.GitBriefPrompt = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
