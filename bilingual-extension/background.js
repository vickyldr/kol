const MENU_ID = "kol-analyze-selection";

function ignoreLastError() {
  void chrome.runtime.lastError;
}

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) ignoreLastError();

    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "用 KOL 助手分析这段消息",
        contexts: ["selection"]
      },
      ignoreLastError
    );
  });
}

async function openSidePanel(tabId) {
  if (!tabId) return;
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    console.warn("KOL Assistant could not open the side panel:", error);
  }
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);

chrome.action.onClicked.addListener((tab) => {
  openSidePanel(tab?.id);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  try {
    await chrome.storage.session.set({
      pendingMessage: info.selectionText || "",
      pendingSource: tab.url || ""
    });
    await openSidePanel(tab.id);
  } catch (error) {
    console.warn("KOL Assistant context menu action failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "OPEN_KOL_ASSISTANT") return;

  chrome.storage.session
    .set({
      pendingMessage: message.text || "",
      pendingSource: message.source || ""
    })
    .then(() => openSidePanel(sender.tab?.id))
    .catch((error) => {
      console.warn("KOL Assistant message action failed:", error);
    });
});

// 网页内联翻译：由后台代发请求，绕过 HTTPS 页面对 HTTP 服务的混合内容拦截。
async function handleTranslate(text) {
  const { kolConfig } = await chrome.storage.local.get("kolConfig");
  const base = kolConfig?.apiBase || "http://106.54.206.174:3210";
  const token = kolConfig?.token || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-KOL-Token"] = token;
  const response = await fetch(`${base}/api/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "翻译失败");
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KOL_TRANSLATE") return;
  handleTranslate(message.text)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "翻译失败" }));
  return true; // 保持消息通道开启以异步响应
});
