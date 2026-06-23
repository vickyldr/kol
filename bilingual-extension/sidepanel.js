let API_BASE = "http://127.0.0.1:3210";
let API_TOKEN = "";
let API_ADMIN = "";

// 给受保护的接口附带团队口令。
function authHeaders(base = {}) {
  return API_TOKEN ? { ...base, "X-KOL-Token": API_TOKEN } : base;
}

// 编辑/删除话术等管理员操作，额外附带管理员口令。
function adminHeaders(base = {}) {
  const headers = authHeaders(base);
  return API_ADMIN ? { ...headers, "X-KOL-Admin": API_ADMIN } : headers;
}

function isAdminUser() {
  return Boolean(API_ADMIN);
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get("kolConfig");
    if (stored.kolConfig) {
      API_BASE = stored.kolConfig.apiBase || API_BASE;
      API_TOKEN = stored.kolConfig.token || "";
      API_ADMIN = stored.kolConfig.adminToken || "";
    }
  } catch {
    // 读取失败时沿用默认本机地址。
  }
}

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

// 板块切换 + 主动发板块（B）相关元素
const tabReactive = document.getElementById("tab-reactive");
const tabProactive = document.getElementById("tab-proactive");
const panelReactive = document.getElementById("panel-reactive");
const panelProactive = document.getElementById("panel-proactive");
const freeIntentInput = document.getElementById("free-intent");
const generateFreeButton = document.getElementById("generate-free");
const freeStatus = document.getElementById("free-status");
const resultPro = document.getElementById("result-pro");
const replyTargetProInput = document.getElementById("reply-target-pro");
const replyChineseProInput = document.getElementById("reply-zh-pro");
const translateProButton = document.getElementById("translate-pro");

// 选话术（多语言话术库）相关元素
const playbookDialog = document.getElementById("playbook-dialog");
const playbookStage = document.getElementById("playbook-stage");
const playbookSearch = document.getElementById("playbook-search");
const playbookList = document.getElementById("playbook-list");

let serviceOnline = false;
let waitTimer = null;
let lastAnalysis = null;
let archiveSearchTimer = null;
let quickTemplates = [];
let selectedTemplate = null;
let lastProScene = "";
let lastProCategory = "主动话术";
let pendingSave = null;
let playbook = [];
let playbookTarget = "reactive";

function switchMode(mode) {
  const reactive = mode !== "proactive";
  tabReactive.classList.toggle("active", reactive);
  tabProactive.classList.toggle("active", !reactive);
  panelReactive.classList.toggle("hidden", !reactive);
  panelProactive.classList.toggle("hidden", reactive);
}

async function loadPendingMessage() {
  const stored = await chrome.storage.session.get([
    "pendingMessage",
    "selectedProduct"
  ]);
  if (stored.pendingMessage) {
    messageInput.value = stored.pendingMessage;
    switchMode("reactive");
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
    const response = await fetch(`${API_BASE}/api/products`, {
      headers: authHeaders()
    });
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
    const response = await fetch(`${API_BASE}/api/quick-templates`, {
      headers: authHeaders()
    });
    quickTemplates = await response.json();
    if (!response.ok) throw new Error("读取快捷话术失败");
    renderTemplateCategories();
  } catch (error) {
    templateStatus.textContent = error.message;
    templateStatus.classList.remove("hidden");
  }
}

// 主动发板块（B）的统一结果渲染：外语 + 中文对照 + 待填变量。
function renderProactiveReply({ target, chinese, required, sceneName, category }) {
  replyTargetProInput.value = target || "";
  replyChineseProInput.value = chinese || "";
  lastProScene = sceneName || "";
  lastProCategory = category || "主动话术";

  const missingCard = document.getElementById("missing-card-pro");
  const missingList = document.getElementById("missing-information-pro");
  missingList.replaceChildren();
  for (const item of required || []) {
    const li = document.createElement("li");
    li.textContent = item;
    missingList.appendChild(li);
  }
  missingCard.classList.toggle("hidden", !(required || []).length);

  resultPro.classList.remove("hidden");
  resultPro.scrollIntoView({ behavior: "smooth", block: "start" });
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
      headers: authHeaders({ "Content-Type": "application/json" }),
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

    renderProactiveReply({
      target: body.reply_target || "",
      chinese: body.reply_chinese || "",
      required: body.required_variables || [],
      sceneName: selectedTemplate.name,
      category: selectedTemplate.category
    });
    templateStatus.textContent = "已生成，可核对、编辑或保存为话术。";
  } catch (error) {
    templateStatus.textContent =
      error.name === "TimeoutError" ? "生成超时，请重试。" : error.message;
  } finally {
    generateTemplateButton.disabled = false;
    generateTemplateButton.textContent = originalText;
  }
}

// 入口二：自由输入中文意图 → 润色生成双语（复用 /api/rewrite）。
async function generateFreeReply() {
  const intent = freeIntentInput.value.trim();
  if (!intent) {
    freeIntentInput.focus();
    return;
  }
  if (!serviceOnline) {
    freeStatus.textContent = "千问服务尚未连接。";
    freeStatus.classList.remove("hidden");
    return;
  }

  generateFreeButton.disabled = true;
  const originalText = generateFreeButton.textContent;
  generateFreeButton.textContent = "正在生成双语…";
  freeStatus.textContent = `正在用${targetLanguage.value}润色你的话……`;
  freeStatus.classList.remove("hidden");

  try {
    const body = await postRewrite({
      direction: "chinese_to_target",
      message: "",
      context: "",
      productId: productSelect.value,
      replyLanguage: targetLanguage.value,
      replyTarget: "",
      replyChinese: intent
    });
    renderProactiveReply({
      target: body.reply_target || "",
      chinese: body.reply_chinese || "",
      required: [],
      sceneName: "自由主动话术",
      category: "主动话术"
    });
    freeStatus.textContent = "已生成，可核对、编辑或保存为话术。";
  } catch (error) {
    freeStatus.textContent =
      error.name === "TimeoutError" ? "生成超时，请重试。" : error.message;
  } finally {
    generateFreeButton.disabled = false;
    generateFreeButton.textContent = originalText;
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
    await loadPlaybook();
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
    archiveList.appendChild(buildArchiveItem(record));
  }
}

function buildArchiveItem(record) {
  const item = document.createElement("article");
  item.className = "archive-item";

  const title = document.createElement("h3");
  title.textContent = record.scene_name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  meta.textContent = `${record.product_id} · ${record.stage || "未分类"} · v${record.version}`;
  const understanding = document.createElement("p");
  understanding.textContent = record.correct_understanding || "暂无理解说明";
  const target = document.createElement("p");
  target.textContent = record.external_reply_target
    ? `外语：${record.external_reply_target}`
    : "暂无外语回复";
  const reply = document.createElement("p");
  reply.textContent = record.external_reply_chinese
    ? `中文：${record.external_reply_chinese}`
    : "暂无中文回复";
  item.append(title, meta, understanding, target, reply);

  // 只有管理员（本地填了管理员口令）才显示编辑/删除。
  if (isAdminUser()) {
    const actions = document.createElement("div");
    actions.className = "archive-item-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => enterArchiveEdit(item, record));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "archive-delete";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => deleteArchiveRecord(record));
    actions.append(editBtn, delBtn);
    item.appendChild(actions);
  }
  return item;
}

function enterArchiveEdit(item, record) {
  item.replaceChildren();
  item.classList.add("editing");

  const mkField = (labelText, value, rows) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const field = rows
      ? document.createElement("textarea")
      : document.createElement("input");
    if (rows) field.rows = rows;
    field.value = value || "";
    item.append(label, field);
    return field;
  };

  const nameField = mkField("场景名称", record.scene_name, 0);
  const targetField = mkField("外语回复", record.external_reply_target, 4);
  const chineseField = mkField("中文回复", record.external_reply_chinese, 4);
  const notesField = mkField("运营备注", record.notes, 2);

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存修改";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () =>
    item.replaceWith(buildArchiveItem(record))
  );
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      await saveArchiveEdit(record, {
        scene_name: nameField.value.trim() || record.scene_name,
        external_reply_target: targetField.value.trim(),
        external_reply_chinese: chineseField.value.trim(),
        notes: notesField.value.trim()
      });
      await loadArchive(archiveSearch.value.trim());
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存修改";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      item.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  item.appendChild(actions);
}

// 编辑时保留未改动的字段，带管理员口令提交（沿用同一 id 即为更新）。
async function saveArchiveEdit(record, changes) {
  const response = await fetch(`${API_BASE}/api/archive`, {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: record.id,
      status: record.status,
      product_id: record.product_id,
      stage: record.stage,
      trigger_examples: record.trigger_examples,
      correct_understanding: record.correct_understanding,
      internal_guidance: record.internal_guidance,
      required_variables: record.required_variables,
      ...changes
    })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      body.code === "FORBIDDEN"
        ? "没有编辑权限，请确认管理员口令填写正确。"
        : body.error || "保存修改失败。"
    );
  }
}

async function deleteArchiveRecord(record) {
  if (!window.confirm(`确定删除话术「${record.scene_name}」？此操作不可撤销。`)) {
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/archive/delete`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: record.id })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        body.code === "FORBIDDEN"
          ? "没有删除权限，请确认管理员口令填写正确。"
          : body.error || "删除失败。"
      );
    }
    await loadArchive(archiveSearch.value.trim());
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

async function loadArchive(query = "") {
  if (!serviceOnline) return;
  const url = new URL(`${API_BASE}/api/archive`);
  if (query) url.searchParams.set("q", query);
  const response = await fetch(url, { headers: authHeaders() });
  const records = await response.json();
  if (!response.ok) throw new Error(records.error || "读取存档失败");
  renderArchive(records);
}

// 收集板块 A（红人来消息）当前要保存的内容。
function reactiveSaveCtx() {
  return {
    productId: productSelect.value,
    target: replyTargetInput.value.trim(),
    chinese: replyChineseInput.value.trim(),
    sceneName: lastAnalysis
      ? lastAnalysis.matched_source === "新场景"
        ? lastAnalysis.intent
        : lastAnalysis.matched_source || ""
      : "",
    stage: lastAnalysis?.stage || "",
    trigger: messageInput.value.trim(),
    understanding: lastAnalysis
      ? [lastAnalysis.literal_chinese, lastAnalysis.implied_meaning]
          .filter(Boolean)
          .join("；")
      : "",
    internal_guidance: lastAnalysis?.internal_guidance || {},
    required_variables: lastAnalysis?.required_variables || []
  };
}

// 收集板块 B（我主动发）当前要保存的内容。
function proactiveSaveCtx() {
  return {
    productId: productSelect.value,
    target: replyTargetProInput.value.trim(),
    chinese: replyChineseProInput.value.trim(),
    sceneName: lastProScene || "",
    stage: lastProCategory || "主动话术",
    trigger: "",
    understanding: "",
    internal_guidance: {},
    required_variables: []
  };
}

function openSaveDialog(ctx) {
  if (!ctx || (!ctx.target && !ctx.chinese)) {
    errorBox.textContent = "请先生成或填写一条回复，再保存为话术。";
    errorBox.classList.remove("hidden");
    return;
  }
  pendingSave = ctx;
  document.getElementById("scene-name").value = ctx.sceneName || "";
  document.getElementById("scene-notes").value = "";
  document.getElementById("preview-target").textContent = ctx.target || "—";
  document.getElementById("preview-chinese").textContent = ctx.chinese || "—";
  saveDialog.showModal();
}

async function saveCurrentScenario() {
  if (!pendingSave) return;
  const sceneName = document.getElementById("scene-name").value.trim();
  if (!sceneName) return;

  const response = await fetch(`${API_BASE}/api/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: pendingSave.productId,
      scene_name: sceneName,
      stage: pendingSave.stage,
      trigger_examples: pendingSave.trigger ? [pendingSave.trigger] : [],
      correct_understanding: pendingSave.understanding,
      external_reply_target: pendingSave.target,
      external_reply_chinese: pendingSave.chinese,
      internal_guidance: pendingSave.internal_guidance,
      required_variables: pendingSave.required_variables,
      notes: document.getElementById("scene-notes").value.trim()
    })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "保存失败");
  saveDialog.close();
  archivePanel.classList.remove("hidden");
  await loadArchive();
}

async function postRewrite(payload) {
  const response = await fetch(`${API_BASE}/api/rewrite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(65000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "双语回复生成失败。");
  return body;
}

// 板块 A 的改写：中文意图→双语，或外语→中文校对。
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
    const body = await postRewrite({
      direction,
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      operatorGoal: operatorGoalInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: replyChineseInput.value.trim()
    });
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

// 板块 B 的回译核对：外语→中文。
async function translateProReply() {
  if (!serviceOnline) {
    freeStatus.textContent = "千问服务尚未连接。";
    freeStatus.classList.remove("hidden");
    return;
  }
  const target = replyTargetProInput.value.trim();
  if (!target) {
    replyTargetProInput.focus();
    return;
  }

  const originalText = translateProButton.textContent;
  translateProButton.disabled = true;
  translateProButton.textContent = "正在回译…";

  try {
    const body = await postRewrite({
      direction: "target_to_chinese",
      message: "",
      productId: productSelect.value,
      replyTarget: target
    });
    replyChineseProInput.value =
      body.reply_chinese || replyChineseProInput.value;
  } catch (error) {
    freeStatus.textContent =
      error.name === "TimeoutError" ? "回译超时，请稍后重试。" : error.message;
    freeStatus.classList.remove("hidden");
  } finally {
    translateProButton.disabled = false;
    translateProButton.textContent = originalText;
  }
}

// 手动新增话术（所有成员可用）：空白表单直接填写并保存为新话术。
function openNewArchiveForm() {
  const box = document.getElementById("new-archive-form");
  box.classList.remove("hidden");
  box.replaceChildren();

  const card = document.createElement("article");
  card.className = "archive-item editing";

  const heading = document.createElement("h3");
  heading.textContent = "手动新增话术";
  card.appendChild(heading);

  const mkField = (labelText, rows, placeholder) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const field = rows
      ? document.createElement("textarea")
      : document.createElement("input");
    if (rows) field.rows = rows;
    if (placeholder) field.placeholder = placeholder;
    card.append(label, field);
    return field;
  };

  const nameField = mkField("场景名称", 0, "例如：催初稿（礼貌版）");
  const targetField = mkField("外语回复", 4, "可留空");
  const chineseField = mkField("中文回复 / 说明", 4, "");
  const notesField = mkField("运营备注", 2, "适用条件、注意事项");

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存新话术";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    box.replaceChildren();
    box.classList.add("hidden");
  });
  saveBtn.addEventListener("click", async () => {
    const sceneName = nameField.value.trim();
    if (!sceneName) {
      nameField.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      const response = await fetch(`${API_BASE}/api/archive`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          product_id: productSelect.value,
          scene_name: sceneName,
          external_reply_target: targetField.value.trim(),
          external_reply_chinese: chineseField.value.trim(),
          notes: notesField.value.trim()
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存失败。");
      box.replaceChildren();
      box.classList.add("hidden");
      await loadArchive(archiveSearch.value.trim());
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存新话术";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      card.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  card.appendChild(actions);
  box.appendChild(card);
}

// 导入：上传导出过的 JSON，逐条作为新话术加入（去掉 id 避免覆盖已有）。
async function handleImportFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    window.alert("这个文件不是有效的 JSON，请选择导出备份生成的文件。");
    return;
  }
  const records = Array.isArray(data) ? data : data.records || [];
  if (!records.length) {
    window.alert("文件里没有可导入的话术。");
    return;
  }
  let ok = 0;
  for (const r of records) {
    try {
      const response = await fetch(`${API_BASE}/api/archive`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          product_id: r.product_id || "generic",
          scene_name: r.scene_name || "导入话术",
          stage: r.stage || "",
          trigger_examples: r.trigger_examples || [],
          correct_understanding: r.correct_understanding || "",
          external_reply_target: r.external_reply_target || "",
          external_reply_chinese: r.external_reply_chinese || "",
          internal_guidance: r.internal_guidance || {},
          required_variables: r.required_variables || [],
          notes: r.notes || ""
        })
      });
      if (response.ok) ok += 1;
    } catch {
      // 单条失败跳过，继续导入其余。
    }
  }
  window.alert(`导入完成：成功 ${ok} / ${records.length} 条。`);
  await loadArchive(archiveSearch.value.trim());
}

async function loadPlaybook() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/playbook`, {
      headers: authHeaders()
    });
    const data = await response.json();
    playbook = Array.isArray(data) ? data : [];
  } catch {
    playbook = [];
  }
}

function openPlaybookPicker(target) {
  playbookTarget = target;
  const stages = [...new Set(playbook.map((e) => e.stage))];
  playbookStage.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部阶段";
  playbookStage.appendChild(all);
  for (const s of stages) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    playbookStage.appendChild(o);
  }
  playbookSearch.value = "";
  renderPlaybookList();
  playbookDialog.showModal();
}

function renderPlaybookList() {
  const product = productSelect.value;
  const stage = playbookStage.value;
  const q = playbookSearch.value.trim().toLowerCase();
  const items = playbook.filter((e) => {
    if (e.product !== "通用" && e.product !== product) return false;
    if (stage && e.stage !== stage) return false;
    if (
      q &&
      !e.name.toLowerCase().includes(q) &&
      !JSON.stringify(e.texts).toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
  playbookList.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "archive-meta";
    p.textContent = "没有匹配的话术。换个产品 / 阶段，或清空搜索再试。";
    playbookList.appendChild(p);
    return;
  }
  for (const e of items) playbookList.appendChild(buildPlaybookItem(e));
}

function buildPlaybookItem(entry) {
  const item = document.createElement("article");
  item.className = "archive-item";
  const h = document.createElement("h3");
  h.textContent = entry.name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  meta.textContent = `${entry.product} · ${entry.stage} · ${Object.keys(entry.texts).join(" / ")}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = "选用";
  btn.addEventListener("click", () => expandPlaybookItem(item, entry));
  item.append(h, meta, btn);
  return item;
}

function expandPlaybookItem(item, entry) {
  item.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = entry.name;
  item.appendChild(h);

  const langs = Object.keys(entry.texts);
  let chosenLang = langs[0];

  const preview = document.createElement("div");
  preview.className = "playbook-preview";
  preview.textContent = entry.texts[chosenLang];

  const langRow = document.createElement("div");
  langRow.className = "playbook-langs";
  const chips = [];
  for (const l of langs) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = `lang-chip${l === chosenLang ? " active" : ""}`;
    c.textContent = l;
    c.addEventListener("click", () => {
      chosenLang = l;
      chips.forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      preview.textContent = entry.texts[l];
    });
    chips.push(c);
    langRow.appendChild(c);
  }
  item.appendChild(langRow);

  const varInputs = {};
  if (entry.variables.length) {
    const vbox = document.createElement("div");
    vbox.className = "playbook-vars";
    for (const v of entry.variables) {
      const lab = document.createElement("label");
      lab.textContent = v;
      const inp = document.createElement("input");
      inp.placeholder = `填写${v}`;
      varInputs[v] = inp;
      vbox.append(lab, inp);
    }
    item.appendChild(vbox);
  }

  item.appendChild(preview);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  apply.textContent = "用这条（填进回复框）";
  apply.addEventListener("click", () =>
    applyPlaybook(entry, chosenLang, varInputs)
  );
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary";
  back.textContent = "返回";
  back.addEventListener("click", () => item.replaceWith(buildPlaybookItem(entry)));
  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  actions.append(apply, back);
  item.appendChild(actions);
}

function substituteVars(text, varInputs) {
  let t = text || "";
  for (const [k, inp] of Object.entries(varInputs)) {
    const val = inp.value.trim();
    if (!val) continue;
    t = t
      .split(`{{${k}}}`).join(val)
      .split(`【${k}】`).join(val)
      .split(`{${k}}`).join(val)
      .split(`[${k}]`).join(val);
    if (k === "价格") t = t.replace(/XXXX|XXX/g, val);
  }
  return t;
}

function applyPlaybook(entry, lang, varInputs) {
  const text = substituteVars(entry.texts[lang] || "", varInputs);
  const zh = substituteVars(entry.texts["中文"] || "", varInputs);
  if (playbookTarget === "proactive") {
    replyTargetProInput.value = text;
    replyChineseProInput.value = lang === "中文" ? "" : zh;
    lastProScene = entry.name;
    lastProCategory = entry.stage;
    resultPro.classList.remove("hidden");
    switchMode("proactive");
    resultPro.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    replyTargetInput.value = text;
    replyChineseInput.value = lang === "中文" ? "" : zh;
    emptyState.classList.add("hidden");
    result.classList.remove("hidden");
    switchMode("reactive");
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  playbookDialog.close();
}

async function exportArchive() {
  const response = await fetch(`${API_BASE}/api/archive/export`, {
    method: "POST",
    headers: authHeaders()
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
      headers: authHeaders({ "Content-Type": "application/json" }),
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
      headers: authHeaders({ "Content-Type": "application/json" }),
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

tabReactive.addEventListener("click", () => switchMode("reactive"));
tabProactive.addEventListener("click", () => switchMode("proactive"));
document.getElementById("analyze").addEventListener("click", analyze);
generateTemplateButton.addEventListener("click", generateQuickTemplate);
generateFreeButton.addEventListener("click", generateFreeReply);
translateProButton.addEventListener("click", translateProReply);
document
  .getElementById("open-playbook-reactive")
  .addEventListener("click", () => openPlaybookPicker("reactive"));
document
  .getElementById("open-playbook-proactive")
  .addEventListener("click", () => openPlaybookPicker("proactive"));
document
  .getElementById("playbook-close")
  .addEventListener("click", () => playbookDialog.close());
playbookStage.addEventListener("change", renderPlaybookList);
playbookSearch.addEventListener("input", renderPlaybookList);
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
document
  .getElementById("save-scenario")
  .addEventListener("click", () => openSaveDialog(reactiveSaveCtx()));
document
  .querySelectorAll(".save-trigger")
  .forEach((button) =>
    button.addEventListener("click", () => openSaveDialog(reactiveSaveCtx()))
  );
document
  .querySelectorAll(".save-trigger-pro")
  .forEach((button) =>
    button.addEventListener("click", () => openSaveDialog(proactiveSaveCtx()))
  );
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
archiveSearch.addEventListener("input", () => {
  clearTimeout(archiveSearchTimer);
  archiveSearchTimer = setTimeout(() => loadArchive(archiveSearch.value.trim()), 300);
});
document.getElementById("export-archive").addEventListener("click", exportArchive);
document
  .getElementById("new-archive")
  .addEventListener("click", openNewArchiveForm);
document.getElementById("import-archive").addEventListener("click", () => {
  document.getElementById("import-file").click();
});
document.getElementById("import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await handleImportFile(file);
});
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

// 服务器设置：填本机或团队 VPS 地址 + 团队口令，保存到 chrome.storage.local。
const serverAddressInput = document.getElementById("server-address");
const serverTokenInput = document.getElementById("server-token");
const serverAdminInput = document.getElementById("server-admin");
const saveServerButton = document.getElementById("save-server");
const serverSettingsStatus = document.getElementById("server-settings-status");

function fillServerSettings() {
  if (serverAddressInput) serverAddressInput.value = API_BASE;
  if (serverTokenInput) serverTokenInput.value = API_TOKEN;
  if (serverAdminInput) serverAdminInput.value = API_ADMIN;
}

if (saveServerButton) {
  saveServerButton.addEventListener("click", async () => {
    const apiBase = serverAddressInput.value.trim().replace(/\/+$/, "");
    const token = serverTokenInput.value.trim();
    const adminToken = serverAdminInput ? serverAdminInput.value.trim() : "";
    if (!apiBase) {
      serverAddressInput.focus();
      return;
    }
    API_BASE = apiBase;
    API_TOKEN = token;
    API_ADMIN = adminToken;
    await chrome.storage.local.set({
      kolConfig: { apiBase, token, adminToken }
    });
    serverSettingsStatus.textContent = "已保存，正在重新连接服务……";
    serverSettingsStatus.classList.remove("hidden");
    await checkService();
    serverSettingsStatus.textContent = serviceOnline
      ? "已连接到该服务器。"
      : "保存了，但暂时连不上，请检查地址、口令和服务器防火墙。";
  });
}

loadConfig().then(() => {
  fillServerSettings();
  loadPendingMessage();
  checkService();
});
