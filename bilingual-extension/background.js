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
