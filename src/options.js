const DEFAULT_CONFIG = {
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.2
};

const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");
const clearButton = document.getElementById("clear-button");

loadConfig();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const config = {
    baseUrl: document.getElementById("base-url").value.trim().replace(/\/+$/, ""),
    model: document.getElementById("model").value.trim(),
    apiKey: document.getElementById("api-key").value.trim(),
    temperature: Number(document.getElementById("temperature").value || 0.2)
  };

  await chrome.storage.local.set(config);
  setStatus("设置已保存。");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.set(DEFAULT_CONFIG);
  fillForm(DEFAULT_CONFIG);
  setStatus("设置已清空。");
});

async function loadConfig() {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  fillForm(config);
}

function fillForm(config) {
  document.getElementById("base-url").value = config.baseUrl || "";
  document.getElementById("model").value = config.model || "";
  document.getElementById("api-key").value = config.apiKey || "";
  document.getElementById("temperature").value = config.temperature ?? 0.2;
}

function setStatus(message) {
  statusNode.textContent = message;
  window.setTimeout(() => {
    if (statusNode.textContent === message) {
      statusNode.textContent = "";
    }
  }, 3000);
}
