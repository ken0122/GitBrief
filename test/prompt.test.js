const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  PROMPT_BUDGETS,
  SYSTEM_PROMPT,
  buildMessages,
  buildPrompt
} = require("../src/prompt.js");

function makeBaseContext(overrides = {}) {
  return {
    owner: "octo",
    name: "demo",
    description: "A small repository for testing prompt shape.",
    languages: ["JavaScript", "CSS"],
    files: ["README.md", "src/background.js", "src/content.js"],
    readme: "README_CONTENT",
    filePath: "src/content.js",
    fileContent: "console.log('file content');",
    directoryEntries: [
      { type: "file", path: "src/background.js" },
      { type: "file", path: "src/content.js" }
    ],
    directoryFileSamples: [
      { path: "src/background.js", snippet: "background sample" },
      { path: "src/content.js", snippet: "content sample" }
    ],
    scope: {
      effectiveMode: "repository",
      scopePath: "/"
    },
    ...overrides
  };
}

test("repo prompt only includes repository context and suggested length", () => {
  const prompt = buildPrompt(makeBaseContext({
    readme: "R".repeat(PROMPT_BUDGETS.repoReadmeChars + 100),
    fileContent: "FILE_CONTENT_SHOULD_NOT_APPEAR",
    directoryFileSamples: [{ path: "src/hidden.js", snippet: "DIRECTORY_SAMPLE_SHOULD_NOT_APPEAR" }],
    scope: { effectiveMode: "repository", scopePath: "/" }
  }));

  assert.match(prompt, /仓库：octo\/demo/);
  assert.match(prompt, /README摘录：/);
  assert.match(prompt, /建议 300 中文字内。/);
  assert.doesNotMatch(prompt, /代码：/);
  assert.doesNotMatch(prompt, /样例：/);
  assert.doesNotMatch(prompt, /FILE_CONTENT_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /DIRECTORY_SAMPLE_SHOULD_NOT_APPEAR/);
  assert.ok(prompt.length < PROMPT_BUDGETS.repoReadmeChars + 800);
});

test("catalog prompt excludes full README when directory samples exist", () => {
  const entries = Array.from({ length: PROMPT_BUDGETS.catalogEntries + 5 }, (_, index) => ({
    type: "file",
    path: `src/file-${index}.js`
  }));
  const samples = Array.from({ length: PROMPT_BUDGETS.catalogSampleFiles + 2 }, (_, index) => ({
    path: `src/sample-${index}.js`,
    snippet: `sample-${index} `.repeat(200)
  }));
  const prompt = buildPrompt(makeBaseContext({
    readme: "README_SHOULD_NOT_APPEAR",
    fileContent: "FILE_CONTENT_SHOULD_NOT_APPEAR",
    directoryEntries: entries,
    directoryFileSamples: samples,
    scope: { effectiveMode: "directory", scopePath: "/src" }
  }));

  assert.match(prompt, /目录：octo\/demo\/src/);
  assert.match(prompt, /条目：/);
  assert.match(prompt, /样例：/);
  assert.match(prompt, /建议 250 中文字内。/);
  assert.match(prompt, /src\/file-49\.js/);
  assert.doesNotMatch(prompt, /src\/file-50\.js/);
  assert.match(prompt, /src\/sample-1\.js/);
  assert.doesNotMatch(prompt, /src\/sample-2\.js/);
  assert.doesNotMatch(prompt, /README_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /FILE_CONTENT_SHOULD_NOT_APPEAR/);
});

test("catalog prompt uses short README fallback only when samples are absent", () => {
  const prompt = buildPrompt(makeBaseContext({
    readme: "FALLBACK_README ".repeat(100),
    directoryFileSamples: [],
    scope: { effectiveMode: "directory", scopePath: "/docs" }
  }));

  assert.match(prompt, /README摘录：/);
  assert.match(prompt, /FALLBACK_README/);
  assert.ok(prompt.length < PROMPT_BUDGETS.catalogFallbackReadmeChars + 700);
});

test("file prompt only includes current file content when code is available", () => {
  const prompt = buildPrompt(makeBaseContext({
    readme: "README_SHOULD_NOT_APPEAR",
    fileContent: "export function run() { return 'ok'; }",
    directoryEntries: [{ type: "file", path: "src/other.js" }],
    directoryFileSamples: [{ path: "src/other.js", snippet: "OTHER_SAMPLE_SHOULD_NOT_APPEAR" }],
    scope: { effectiveMode: "file", scopePath: "/src/content.js" }
  }));

  assert.match(prompt, /文件：octo\/demo\/src\/content\.js/);
  assert.match(prompt, /代码：/);
  assert.match(prompt, /export function run/);
  assert.match(prompt, /建议 300 中文字内。/);
  assert.doesNotMatch(prompt, /README_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /OTHER_SAMPLE_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(prompt, /条目：/);
});

test("file prompt uses README background only when file content is missing", () => {
  const prompt = buildPrompt(makeBaseContext({
    readme: "README_BACKGROUND ".repeat(100),
    fileContent: "",
    scope: { effectiveMode: "file", scopePath: "/src/missing.js" }
  }));

  assert.match(prompt, /README背景：/);
  assert.match(prompt, /README_BACKGROUND/);
  assert.ok(prompt.length < PROMPT_BUDGETS.fileFallbackReadmeChars + 600);
});

test("messages use short GitBrief system prompt and do not require max_tokens", () => {
  const messages = buildMessages(makeBaseContext());
  const requestBody = {
    model: "test-model",
    temperature: 0.2,
    stream: true,
    messages
  };

  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.equal(Object.hasOwn(requestBody, "max_tokens"), false);
  assert.doesNotMatch(JSON.stringify(requestBody), /资深软件架构师|源码入口|风险与注意事项/);
});

test("background request bodies do not add max_tokens", () => {
  const backgroundPath = path.join(__dirname, "..", "src", "background.js");
  const backgroundSource = fs.readFileSync(backgroundPath, "utf8");

  assert.doesNotMatch(backgroundSource, /max_tokens/);
});
