const API_BASE = "http://127.0.0.1:3210";
const messageInput = document.getElementById("message");
const contextInput = document.getElementById("context");
const operatorGoalInput = document.getElementById("operator-goal");
const productSelect = document.getElementById("product");
const result = document.getElementById("result");
const emptyState = document.getElementById("empty-state");
const errorBox = document.getElementById("request-error");
const analyzeButton = document.getElementById("analyze");
const statusButton = document.getElementById("service-status");
const askQuestionInput = document.getElementById("ask-question");
const askButton = document.getElementById("ask-qwen");
const askAnswer = document.getElementById("ask-answer");
const replyTargetInput = document.getElementById("reply-target");
const replyChineseInput = document.getElementById("reply-zh");
const replyLanguageSelect = document.getElementById("reply-language");
const archivePanel = document.getElementById("archive-panel");
const archiveList = document.getElementById("archive-list");
const archiveSearch = document.getElementById("archive-search");
const saveDialog = document.getElementById("save-dialog");
const templateCategorySelect = document.getElementById(
  "template-category-select"
);
const templateSelect = document.getElementById("template-select");
const templateDescription = document.getElementById("template-description");
const templateVariables = document.getElementById("template-variables");
const targetLanguage = document.getElementById("target-language");
const generateTemplateButton = document.getElementById("generate-template");
const templateStatus = document.getElementById("template-status");

let serviceOnline = false;
let waitTimer = null;
let lastAnalysis = null;
let archiveSearchTimer = null;
let quickTemplates = [];
let selectedTemplate = null;

async function loadPendingMessage() {
  const stored = await chrome.storage.session.get([
    "pendingMessage",
    "selectedProduct"
  ]);
  if (stored.pendingMessage) {
    messageInput.value = stored.pendingMessage;
    await chrome.storage.session.remove("pendingMessage");
  }
  if (stored.selectedProduct) productSelect.value = stored.selectedProduct;
}

async function readSelectionFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "";
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SELECTED_TEXT"
    });
    return response?.text || "";
  } catch {
    return "";
  }
}

async function loadProducts() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/products`);
    const products = await response.json();
    const selected = productSelect.value;
    productSelect.replaceChildren();
    for (const product of products) {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = `${product.name}${product.status === "example" ? "（示例）" : ""}`;
      productSelect.appendChild(option);
    }
    productSelect.value = selected || "generic";
  } catch {
    // Keep the generic local option.
  }
}

function renderTemplateCategories() {
  const categories = [...new Set(quickTemplates.map((item) => item.category))];
  templateCategorySelect.replaceChildren();
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    templateCategorySelect.appendChild(option);
  }
  if (categories[0]) renderTemplateButtons(categories[0]);
}

function renderTemplateButtons(category) {
  templateSelect.replaceChildren();
  selectedTemplate = null;
  templateVariables.classList.add("hidden");
  generateTemplateButton.classList.add("hidden");

  for (const template of quickTemplates.filter(
    (item) => item.category === category
  )) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    templateSelect.appendChild(option);
  }

  const firstTemplate = quickTemplates.find(
    (item) => item.category === category
  );
  if (firstTemplate) {
    selectQuickTemplate(firstTemplate);
  }
}

function variableLabel(name) {
  const labels = {
    product_name: "产品名称",
    creator_name: "红人名称",
    missing_details: "需要确认的事项",
    deadline: "原定截止时间",
    video_count: "视频数量",
    collaboration_period: "合作周期",
    videos_per_month: "每月视频数量",
    previous_product: "之前合作的产品",
    brief_link: "Brief / 脚本链接",
    revision_points: "需要修改的内容",
    payment_eta: "预计到账时间"
  };
  return labels[name] || name;
}

function selectQuickTemplate(template) {
  selectedTemplate = template;
  templateDescription.textContent = template.description || "";
  templateVariables.replaceChildren();

  for (const variable of template.required_variables) {
    const label = document.createElement("label");
    label.textContent = variableLabel(variable);
    const input = document.createElement("input");
    input.dataset.variable = variable;
    input.placeholder = `填写${variableLabel(variable)}`;
    if (variable === "product_name") {
      const selectedName =
        productSelect.options[productSelect.selectedIndex]?.textContent || "";
      if (!selectedName.includes("通用产品")) {
        input.value = selectedName.replace("（示例）", "");
      }
    }
    templateVariables.append(label, input);
  }

  templateVariables.classList.toggle(
    "hidden",
    !template.required_variables.length
  );
  generateTemplateButton.classList.remove("hidden");
}

async function loadQuickTemplates() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/quick-templates`);
    quickTemplates = await response.json();
    if (!response.ok) throw new Error("读取快捷话术失败");
    renderTemplateCategories();
  } catch (error) {
    templateStatus.textContent = error.message;
    templateStatus.classList.remove("hidden");
  }
}

async function generateQuickTemplate() {
  if (!selectedTemplate || !serviceOnline) return;
  const variables = {};
  templateVariables
    .querySelectorAll("[data-variable]")
    .forEach((input) => {
      variables[input.dataset.variable] = input.value.trim();
    });

  generateTemplateButton.disabled = true;
  const originalText = generateTemplateButton.textContent;
  generateTemplateButton.textContent = "正在生成…";
  templateStatus.textContent = `正在生成「${selectedTemplate.name}」`;
  templateStatus.classList.remove("hidden");

  try {
    const response = await fetch(`${API_BASE}/api/generate-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: selectedTemplate.id,
        productId: productSelect.value,
        targetLanguage: targetLanguage.value,
        channel: selectedTemplate.id.includes("email") ? "Email" : "Instagram",
        variables
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "话术生成失败");

    const generatedAnalysis = {
      detected_language: targetLanguage.value,
      literal_chinese: "",
      implied_meaning: "主动发起的快捷话术",
      implication_confidence: "high",
      stage: selectedTemplate.category,
      intent: selectedTemplate.name,
      matched_source: selectedTemplate.name,
      match_type: "exact",
      reply_target: body.reply_target || "",
      reply_chinese: body.reply_chinese || "",
      alternative_target: "",
      alternative_chinese: "",
      required_variables: body.required_variables || [],
      internal_guidance: {
        level: "info",
        explanation: "由主动话术快捷库生成，请发送前检查变量和产品信息。",
        question_for_tl: "",
        temporary_reply_target: "",
        temporary_reply_chinese: "",
        operator_reminders: []
      },
      mentioned_items: [],
      risk_warning: "请确认价格、日期、数量、平台和授权条件没有遗漏。"
    };
    renderAnalysis(generatedAnalysis);
    templateStatus.textContent = "已生成，可继续编辑或保存为话术。";
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    templateStatus.textContent =
      error.name === "TimeoutError" ? "生成超时，请重试。" : error.message;
  } finally {
    generateTemplateButton.disabled = false;
    generateTemplateButton.textContent = originalText;
  }
}

async function checkService() {
  statusButton.textContent = "检测中";
  statusButton.className = "status";
  try {
    const response = await fetch(`${API_BASE}/health`);
    const health = await response.json();
    serviceOnline = response.ok && health.ok;
    statusButton.textContent = health.ai_configured ? "千问已连接" : "待配置 Key";
    statusButton.className = `status ${health.ai_configured ? "online" : "offline"}`;
    statusButton.title = `${health.provider} · ${health.model}`;
    await loadProducts();
    await loadQuickTemplates();
  } catch {
    serviceOnline = false;
    statusButton.textContent = "AI 未启动";
    statusButton.className = "status offline";
    statusButton.title = "请双击插件文件夹中的 start-assistant.cmd";
  }
}

function setText(id, value) {
  document.getElementById(id).textContent = value || "—";
}

function setValue(id, value) {
  document.getElementById(id).value = value || "";
}

function renderInternalGuidance(guidance = {}) {
  const card = document.getElementById("internal-guidance");
  const level = guidance.level || "info";
  card.className = `internal-card ${level}`;
  setText(
    "internal-level",
    level === "block"
      ? "必须询问 TL"
      : level === "confirm"
        ? "建议询问 TL"
        : "内部操作提醒"
  );
  setText("internal-explanation", guidance.explanation);

  const questionBox = document.getElementById("tl-question-box");
  setText("tl-question", guidance.question_for_tl);
  questionBox.classList.toggle("hidden", !guidance.question_for_tl);

  const temporaryBox = document.getElementById("temporary-reply-box");
  setText("temporary-reply-target", guidance.temporary_reply_target);
  setText("temporary-reply-chinese", guidance.temporary_reply_chinese);
  temporaryBox.classList.toggle(
    "hidden",
    !guidance.temporary_reply_target
  );

  const reminders = document.getElementById("operator-reminders");
  reminders.replaceChildren();
  for (const item of guidance.operator_reminders || []) {
    const li = document.createElement("li");
    li.textContent = item;
    reminders.appendChild(li);
  }
}

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  setText("language", analysis.detected_language);
  setText("stage", analysis.stage);
  setText("intent", analysis.intent);
  setText(
    "interpretation",
    `${analysis.match_type === "new_scenario" ? "新场景 · " : ""}${analysis.matched_source || ""}`
  );
  setText(
    "implied-meaning",
    `可能的言外之意（${analysis.implication_confidence || "low"}）：${analysis.implied_meaning || "无明显言外之意"}`
  );
  setValue("reply-target", analysis.reply_target);
  setValue("reply-zh", analysis.reply_chinese);
  setText("alternative-target", analysis.alternative_target);
  setText("alternative-zh", analysis.alternative_chinese);
  setText("risk", analysis.risk_warning);
  renderInternalGuidance(analysis.internal_guidance);
  renderMentionedItems(analysis.mentioned_items || []);

  const missingCard = document.getElementById("missing-card");
  const missingList = document.getElementById("missing-information");
  missingList.replaceChildren();
  for (const item of analysis.required_variables || []) {
    const li = document.createElement("li");
    li.textContent = item;
    missingList.appendChild(li);
  }
  missingCard.classList.toggle(
    "hidden",
    !(analysis.required_variables || []).length
  );

  emptyState.classList.add("hidden");
  result.classList.remove("hidden");
}

function renderArchive(records) {
  archiveList.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "archive-meta";
    empty.textContent = "还没有保存过确认话术。";
    archiveList.appendChild(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "archive-item";
    const title = document.createElement("h3");
    title.textContent = record.scene_name;
    const meta = document.createElement("p");
    meta.className = "archive-meta";
    meta.textContent = `${record.product_id} · ${record.stage || "未分类"} · v${record.version}`;
    const understanding = document.createElement("p");
    understanding.textContent = record.correct_understanding || "暂无理解说明";
    const reply = document.createElement("p");
    reply.textContent = record.external_reply_chinese
      ? `回复：${record.external_reply_chinese}`
      : "暂无外发回复";
    item.append(title, meta, understanding, reply);
    archiveList.appendChild(item);
  }
}

async function loadArchive(query = "") {
  if (!serviceOnline) return;
  const url = new URL(`${API_BASE}/api/archive`);
  if (query) url.searchParams.set("q", query);
  const response = await fetch(url);
  const records = await response.json();
  if (!response.ok) throw new Error(records.error || "读取存档失败");
  renderArchive(records);
}

async function saveCurrentScenario() {
  if (!lastAnalysis) return;
  const sceneName = document.getElementById("scene-name").value.trim();
  if (!sceneName) return;

  const response = await fetch(`${API_BASE}/api/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productSelect.value,
      scene_name: sceneName,
      stage: lastAnalysis.stage,
      trigger_examples: [messageInput.value.trim()],
      correct_understanding: [
        lastAnalysis.literal_chinese,
        lastAnalysis.implied_meaning
      ]
        .filter(Boolean)
        .join("；"),
      external_reply_target: replyTargetInput.value.trim(),
      external_reply_chinese: replyChineseInput.value.trim(),
      internal_guidance: lastAnalysis.internal_guidance,
      required_variables: lastAnalysis.required_variables,
      notes: document.getElementById("scene-notes").value.trim()
    })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "保存失败");
  saveDialog.close();
  archivePanel.classList.remove("hidden");
  await loadArchive();
}

async function rewriteReply(direction) {
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }

  const button =
    direction === "target_to_chinese"
      ? document.getElementById("translate-to-chinese")
      : document.getElementById("generate-from-chinese");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent =
    direction === "target_to_chinese" ? "正在翻译…" : "正在生成双语回复…";
  errorBox.classList.add("hidden");

  try {
    const response = await fetch(`${API_BASE}/api/rewrite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction,
        message: messageInput.value.trim(),
        context: contextInput.value.trim(),
        operatorGoal: operatorGoalInput.value.trim(),
        productId: productSelect.value,
        detectedLanguage: lastAnalysis?.detected_language || "",
        replyLanguage: replyLanguageSelect?.value || "",
        replyTarget: replyTargetInput.value.trim(),
        replyChinese: replyChineseInput.value.trim()
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "双语回复生成失败。");
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;

    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
  } catch (error) {
    errorBox.textContent =
      error.name === "TimeoutError" ? "生成超时，请稍后重试。" : error.message;
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportArchive() {
  const response = await fetch(`${API_BASE}/api/archive/export`, {
    method: "POST"
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "导出失败");
  const blob = new Blob([JSON.stringify(body, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kol-scenario-archive-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderMentionedItems(items) {
  const card = document.getElementById("mentioned-items-card");
  const container = document.getElementById("mentioned-items");
  container.replaceChildren();

  for (const item of items) {
    const wrapper = document.createElement("div");
    wrapper.className = "mentioned-item";

    const title = document.createElement("h3");
    title.textContent = item.term || "未命名事项";
    wrapper.appendChild(title);

    const explanation = document.createElement("p");
    explanation.textContent = item.plain_explanation || "";
    wrapper.appendChild(explanation);

    const contextStatus = document.createElement("p");
    contextStatus.className = "context-status";
    contextStatus.textContent =
      item.previous_context === "yes"
        ? "当前提供的上下文中已经提到过。"
        : item.previous_context === "no"
          ? "当前提供的上下文中没有看到此前提及。"
          : "未提供完整历史，暂时无法判断此前是否聊过。";
    wrapper.appendChild(contextStatus);

    if (item.attention) {
      const attention = document.createElement("p");
      attention.textContent = `注意：${item.attention}`;
      wrapper.appendChild(attention);
    }
    if (item.suggested_action) {
      const action = document.createElement("p");
      action.textContent = `建议：${item.suggested_action}`;
      wrapper.appendChild(action);
    }
    container.appendChild(wrapper);
  }

  card.classList.toggle("hidden", !items.length);
}

function localFallback(text) {
  const scenario = KOLKnowledge.matchScenario(text);
  return {
    detected_language: KOLKnowledge.detectLanguage(text),
    literal_chinese: scenario
      ? scenario.interpretation
      : "离线模式无法可靠翻译这条消息，请先启动千问服务。",
    implied_meaning: "离线模式不进行潜台词判断",
    implication_confidence: "low",
    stage: scenario?.stage || "新场景",
    intent: scenario?.intent || "现有离线话术尚未覆盖",
    match_type: scenario ? "partial" : "new_scenario",
    matched_source: scenario ? "本地离线话术" : "离线保守回复",
    reply_target:
      scenario?.replyEn ||
      "Thanks for your message! Let me confirm the details with my team, and I’ll get back to you shortly.",
    reply_chinese:
      scenario?.replyZh || "谢谢你的消息！我先和团队确认一下具体情况，稍后回复你。",
    alternative_target: "",
    alternative_chinese: "",
    required_variables: [],
    internal_guidance: {
      level: "confirm",
      explanation: "AI 服务未启动，无法可靠判断红人的言外之意。",
      question_for_tl: "",
      temporary_reply_target: "",
      temporary_reply_chinese: "",
      operator_reminders: ["启动千问服务后重新分析"]
    },
    risk_warning: scenario?.risk || "当前为离线占位回复。"
  };
}

async function analyze() {
  const message = messageInput.value.trim();
  if (!message) {
    messageInput.focus();
    return;
  }

  errorBox.classList.add("hidden");
  analyzeButton.disabled = true;
  analyzeButton.textContent = serviceOnline ? "千问分析中…" : "离线匹配中…";
  let waitedSeconds = 0;
  if (serviceOnline) {
    waitTimer = setInterval(() => {
      waitedSeconds += 1;
      analyzeButton.textContent = `千问分析中 ${waitedSeconds}s`;
    }, 1000);
  }

  try {
    if (!serviceOnline) {
      renderAnalysis(localFallback(message));
      errorBox.textContent =
        "千问服务未启动，当前显示离线结果。请双击 start-assistant.cmd 后重试。";
      errorBox.classList.remove("hidden");
      return;
    }

    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        productId: productSelect.value,
        context: contextInput.value.trim(),
        operatorGoal: operatorGoalInput.value.trim(),
        channel: "Instagram"
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "千问分析失败。");
    renderAnalysis(body);
  } catch (error) {
    renderAnalysis(localFallback(message));
    errorBox.textContent =
      error.name === "TimeoutError"
        ? "千问超过 65 秒仍未返回，已显示离线结果。请稍后重试。"
        : `${error.message} 已显示离线结果。`;
    errorBox.classList.remove("hidden");
  } finally {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
    analyzeButton.disabled = false;
    analyzeButton.textContent = "分析并建议回复";
  }
}

async function askQwenDirectly() {
  const question = askQuestionInput.value.trim();
  if (!question) {
    askQuestionInput.focus();
    return;
  }
  if (!serviceOnline) {
    askAnswer.textContent = "千问服务尚未连接。";
    askAnswer.classList.remove("hidden");
    return;
  }

  askButton.disabled = true;
  askButton.textContent = "千问回答中…";
  askAnswer.classList.add("hidden");
  try {
    const response = await fetch(`${API_BASE}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        message: messageInput.value.trim(),
        context: contextInput.value.trim(),
        productId: productSelect.value,
        analysis: lastAnalysis
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "千问回答失败。");
    askAnswer.textContent = body.answer;
  } catch (error) {
    askAnswer.textContent =
      error.name === "TimeoutError"
        ? "回答超时，请稍后重试。"
        : error.message;
  } finally {
    askAnswer.classList.remove("hidden");
    askButton.disabled = false;
    askButton.textContent = "发送问题";
  }
}

document.getElementById("analyze").addEventListener("click", analyze);
generateTemplateButton.addEventListener("click", generateQuickTemplate);
templateCategorySelect.addEventListener("change", () => {
  renderTemplateButtons(templateCategorySelect.value);
});
templateSelect.addEventListener("change", () => {
  const template = quickTemplates.find(
    (item) => item.id === templateSelect.value
  );
  if (template) selectQuickTemplate(template);
});
askButton.addEventListener("click", askQwenDirectly);
document
  .getElementById("translate-to-chinese")
  .addEventListener("click", () => rewriteReply("target_to_chinese"));
document
  .getElementById("generate-from-chinese")
  .addEventListener("click", () => rewriteReply("chinese_to_target"));
function openSaveDialog() {
  if (!lastAnalysis) {
    errorBox.textContent = "请先分析消息或生成一条回复，再保存为话术。";
    errorBox.classList.remove("hidden");
    return;
  }
  document.getElementById("scene-name").value =
    lastAnalysis.matched_source === "新场景"
      ? lastAnalysis.intent
      : lastAnalysis.matched_source || "";
  document.getElementById("scene-notes").value = "";
  // 在弹窗里预览这次到底会存下什么，避免“鬼知道保存的是什么”。
  document.getElementById("preview-target").textContent =
    replyTargetInput.value.trim() || "—";
  document.getElementById("preview-chinese").textContent =
    replyChineseInput.value.trim() || "—";
  saveDialog.showModal();
}

document
  .getElementById("save-scenario")
  .addEventListener("click", openSaveDialog);
document
  .querySelectorAll(".save-trigger")
  .forEach((button) => button.addEventListener("click", openSaveDialog));
document.getElementById("open-archive").addEventListener("click", async () => {
  archivePanel.classList.toggle("hidden");
  if (!archivePanel.classList.contains("hidden")) {
    archivePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      await loadArchive();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  }
});
document.getElementById("save-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveCurrentScenario();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
});
document.getElementById("cancel-save").addEventListener("click", () => {
  saveDialog.close();
});
document.getElementById("toggle-archive").addEventListener("click", async () => {
  archivePanel.classList.toggle("hidden");
  if (!archivePanel.classList.contains("hidden")) await loadArchive();
});
archiveSearch.addEventListener("input", () => {
  clearTimeout(archiveSearchTimer);
  archiveSearchTimer = setTimeout(() => loadArchive(archiveSearch.value.trim()), 300);
});
document.getElementById("export-archive").addEventListener("click", exportArchive);
document.getElementById("load-selection").addEventListener("click", async () => {
  const selected = await readSelectionFromPage();
  if (selected) messageInput.value = selected;
  messageInput.focus();
});
productSelect.addEventListener("change", () => {
  chrome.storage.session.set({ selectedProduct: productSelect.value });
  // 切换产品后刷新当前模板的变量输入框，让 product_name 等自动跟随新产品填充。
  if (selectedTemplate) selectQuickTemplate(selectedTemplate);
});
statusButton.addEventListener("click", checkService);

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    await navigator.clipboard.writeText(target.textContent);
    const oldText = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1000);
  });
});

document.querySelectorAll("[data-copy-value]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyValue);
    await navigator.clipboard.writeText(target.value);
    const oldText = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1000);
  });
});

loadPendingMessage();
checkService();
