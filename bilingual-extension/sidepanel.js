let API_BASE = "http://106.54.206.174:3210";
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
// 记住「我主动发」上次用的输出语言，下次默认它
chrome.storage.local.get("kolProactiveLang").then((s) => {
  if (s.kolProactiveLang) targetLanguage.value = s.kolProactiveLang;
});
targetLanguage.addEventListener("change", () => {
  chrome.storage.local.set({ kolProactiveLang: targetLanguage.value });
});
const generateTemplateButton = document.getElementById("generate-template");
const templateStatus = document.getElementById("template-status");

// 板块切换 + 主动发板块（B）相关元素
const tabReactive = document.getElementById("tab-reactive");
const tabProactive = document.getElementById("tab-proactive");
const tabChat = document.getElementById("tab-chat");
const panelReactive = document.getElementById("panel-reactive");
const panelProactive = document.getElementById("panel-proactive");
const panelChat = document.getElementById("panel-chat");
const freeIntentInput = document.getElementById("free-intent");
const generateFreeButton = document.getElementById("generate-free");
const freeStatus = document.getElementById("free-status");
const resultPro = document.getElementById("result-pro");
const replyTargetProInput = document.getElementById("reply-target-pro");
const replyChineseProInput = document.getElementById("reply-zh-pro");
const translateProButton = document.getElementById("translate-pro");

// 选话术（多语言话术库）相关元素
const playbookDialog = document.getElementById("playbook-dialog");
const playbookProduct = document.getElementById("playbook-product");
const playbookStage = document.getElementById("playbook-stage");
const playbookSearch = document.getElementById("playbook-search");
const playbookList = document.getElementById("playbook-list");
const PRODUCT_LABEL = {
  rythmix: "Rythmix",
  recco: "Recco",
  vivavideo: "VivaVideo",
  vivacut: "VivaCut",
  aicatch: "AICatch",
  通用: "通用（所有产品）"
};
const ALL_PRODUCTS = ["rythmix", "recco", "vivavideo", "vivacut", "aicatch", "通用"];

const assetsPanel = document.getElementById("assets-panel");
const assetsProduct = document.getElementById("assets-product");
const assetForm = document.getElementById("asset-form");
const assetsList = document.getElementById("assets-list");
let assets = [];

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
  if (!["reactive", "proactive", "chat"].includes(mode)) mode = "reactive";
  tabReactive.classList.toggle("active", mode === "reactive");
  tabProactive.classList.toggle("active", mode === "proactive");
  tabChat.classList.toggle("active", mode === "chat");
  panelReactive.classList.toggle("hidden", mode !== "reactive");
  panelProactive.classList.toggle("hidden", mode !== "proactive");
  panelChat.classList.toggle("hidden", mode !== "chat");
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

// 入口二：自由输入中文 → 忠实翻译 或 润色生成双语（复用 /api/rewrite）。
async function generateFree(direction) {
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
  const faithful = direction === "faithful";
  const button = faithful
    ? document.getElementById("free-faithful")
    : generateFreeButton;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = faithful ? "正在翻译…" : "正在生成…";
  freeStatus.textContent = faithful
    ? `正在用${targetLanguage.value}忠实翻译……`
    : `正在用${targetLanguage.value}润色你的话……`;
  freeStatus.classList.remove("hidden");

  try {
    const body = await postRewrite({
      direction,
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
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function checkService() {
  statusButton.textContent = "检测中";
  statusButton.className = "status";
  try {
    const response = await fetch(`${API_BASE}/health`);
    const health = await response.json();
    // 验证团队口令是否正确（/health 不校验口令，需另探一个受保护接口）。
    const probe = await fetch(`${API_BASE}/api/products`, {
      headers: authHeaders()
    });
    if (probe.status === 401) {
      serviceOnline = false;
      statusButton.textContent = "口令不正确";
      statusButton.className = "status offline";
      statusButton.title = "团队口令与服务器不一致，请在「服务器设置」里更正";
      return;
    }
    serviceOnline = response.ok && health.ok;
    statusButton.textContent = health.ai_configured ? "千问已连接" : "待配置 Key";
    statusButton.className = `status ${health.ai_configured ? "online" : "offline"}`;
    statusButton.title = `${health.provider} · ${health.model}`;
    await loadProducts();
    await loadQuickTemplates();
    await loadPlaybook();
    await loadAssets();
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
  // 回复由快接口(/api/reply)负责并渲染到分屏；这里只在回复还空着时兜底填上。
  if (analysis.reply_target && !replyTargetInput.value) {
    setValue("reply-target", analysis.reply_target);
    setValue("reply-zh", analysis.reply_chinese);
    renderBilingualSplit(analysis.reply_target, analysis.reply_chinese);
  }
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

// 把一段文字按句切分（中英标点 + 换行），用于左右分屏逐句对齐
function splitSentences(s) {
  return String(s || "")
    .split(/(?<=[。.!?！？；;\n])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// 渲染「外语 | 中文」左右分屏：逐句一行，悬停整行高亮；外语可直接改。
function renderBilingualSplit(target, chinese) {
  const box = document.getElementById("bi-split");
  if (!box) return;
  box.replaceChildren();
  const ts = splitSentences(target);
  const zs = splitSentences(chinese);
  const n = Math.max(ts.length, zs.length, 1);
  for (let i = 0; i < n; i += 1) {
    const row = document.createElement("div");
    row.className = "bi-row";
    const left = document.createElement("div");
    left.className = "bi-cell bi-target";
    left.contentEditable = "true";
    left.spellcheck = false;
    left.textContent = ts[i] || "";
    left.addEventListener("input", syncTargetFromSplit);
    const right = document.createElement("div");
    right.className = "bi-cell bi-zh";
    right.textContent = zs[i] || "";
    row.append(left, right);
    box.appendChild(row);
  }
}

// 外语格被编辑后，把整条外语回复同步回隐藏数据载体（供复制/保存/改写）
function syncTargetFromSplit() {
  const cells = document.querySelectorAll("#bi-split .bi-target");
  const joined = Array.from(cells)
    .map((c) => c.textContent.trim())
    .filter(Boolean)
    .join(" ");
  replyTargetInput.value = joined;
  if (lastAnalysis) lastAnalysis.reply_target = joined;
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
    headers: authHeaders({ "Content-Type": "application/json" }),
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
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(65000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "双语回复生成失败。");
  return body;
}

// 改写/生成（合并原来的「润色生成」「让 AI 改这条」）：
// 有回复就按你写的改；还没回复就把你写的当中文意图生成双语。结果更新到上方分屏。
async function rewriteGo() {
  const box = document.getElementById("rewrite-box");
  const text = box.value.trim();
  if (!text) { box.focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = document.getElementById("rewrite-go");
  const status = document.getElementById("rewrite-status");
  const orig = button.textContent;
  button.disabled = true;
  button.textContent = "AI 处理中…";
  status.classList.add("hidden");
  status.classList.remove("error");
  try {
    const hasReply = replyTargetInput.value.trim();
    const body = await postRewrite({
      direction: hasReply ? "refine" : "chinese_to_target",
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      operatorGoal: operatorGoalInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: hasReply ? replyChineseInput.value.trim() : text,
      modification: text
    });
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;
    renderBilingualSplit(replyTargetInput.value, replyChineseInput.value);
    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
    box.value = "";
    status.textContent = "已更新 ↑";
    status.classList.remove("hidden", "error");
  } catch (error) {
    status.textContent = error.name === "TimeoutError" ? "超时，请重试。" : error.message;
    status.classList.remove("hidden");
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = orig;
  }
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
      : direction === "faithful"
        ? document.getElementById("faithful-from-chinese")
        : document.getElementById("generate-from-chinese");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent =
    direction === "chinese_to_target" ? "正在生成双语回复…" : "正在翻译…";
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

// 板块 A 的“让 AI 改这条”：在当前回复基础上按修改要求迭代。
async function refineReply() {
  const refineInput = document.getElementById("refine-input");
  const modification = refineInput.value.trim();
  if (!modification) {
    refineInput.focus();
    return;
  }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = document.getElementById("refine-reply");
  const refineStatus = document.getElementById("refine-status");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在修改…";
  refineStatus.classList.add("hidden");
  refineStatus.classList.remove("error");
  try {
    const body = await postRewrite({
      direction: "refine",
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: replyChineseInput.value.trim(),
      modification
    });
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;
    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
    refineInput.value = "";
    refineStatus.textContent = "已按你的要求改好 ↑ 见上方「外语/中文回复」。";
    refineStatus.classList.remove("hidden", "error");
    // 把更新后的外语回复滚动到视野，避免“看不到生成”。
    replyTargetInput.scrollIntoView({ behavior: "smooth", block: "center" });
    replyTargetInput.classList.add("flash");
    setTimeout(() => replyTargetInput.classList.remove("flash"), 1200);
  } catch (error) {
    refineStatus.textContent =
      error.name === "TimeoutError" ? "修改超时，请稍后重试。" : error.message;
    refineStatus.classList.remove("hidden");
    refineStatus.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// 逐句对照：把当前外语回复按句拆开，每句给中文对照，方便核对哪句翻错。
async function alignReplyAction() {
  const alignBtn = document.getElementById("align-reply");
  const alignList = document.getElementById("align-list");
  const target = replyTargetInput.value.trim();
  if (!target) {
    replyTargetInput.focus();
    return;
  }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const orig = alignBtn.textContent;
  alignBtn.disabled = true;
  alignBtn.textContent = "对照中…";
  try {
    const response = await fetch(`${API_BASE}/api/align`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        replyTarget: target,
        replyChinese: replyChineseInput.value.trim()
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "对照失败。");
    alignList.replaceChildren();
    if ((body.pairs || []).length) {
      const head = document.createElement("div");
      head.className = "align-row align-head";
      const ht = document.createElement("p");
      ht.className = "align-target";
      ht.textContent = "外语（鼠标放上去）";
      const hc = document.createElement("p");
      hc.className = "align-chinese";
      hc.textContent = "中文对照";
      head.append(ht, hc);
      alignList.appendChild(head);
    }
    for (let i = 0; i < (body.pairs || []).length; i += 1) {
      const p = body.pairs[i];
      const row = document.createElement("div");
      row.className = "align-row";
      const t = document.createElement("p");
      t.className = "align-target";
      t.textContent = `${i + 1}. ${p.target}`;
      const c = document.createElement("p");
      c.className = "align-chinese";
      c.textContent = p.chinese;
      row.append(t, c);
      alignList.appendChild(row);
    }
  } catch (error) {
    alignList.replaceChildren();
    const tip = document.createElement("p");
    tip.className = "request-error";
    tip.textContent =
      error.name === "TimeoutError" ? "对照超时，请重试。" : error.message;
    alignList.appendChild(tip);
  } finally {
    alignBtn.disabled = false;
    alignBtn.textContent = orig;
  }
}

// 板块 B 的回译核对：外语→中文。
// 我主动发：生成后「让 AI 改这条」
async function rewriteGoPro() {
  const box = document.getElementById("rewrite-box-pro");
  const text = box.value.trim();
  if (!text) { box.focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const target = replyTargetProInput.value.trim();
  if (!target) { replyTargetProInput.focus(); return; }
  const button = document.getElementById("rewrite-go-pro");
  const status = document.getElementById("rewrite-status-pro");
  const orig = button.textContent;
  button.disabled = true;
  button.textContent = "AI 处理中…";
  status.classList.add("hidden");
  status.classList.remove("error");
  try {
    const body = await postRewrite({
      direction: "refine",
      message: "",
      productId: productSelect.value,
      detectedLanguage: "",
      replyTarget: target,
      replyChinese: replyChineseProInput.value.trim(),
      modification: text
    });
    replyTargetProInput.value = body.reply_target || replyTargetProInput.value;
    replyChineseProInput.value = body.reply_chinese || replyChineseProInput.value;
    box.value = "";
    status.textContent = "已按你的要求改好 ↑";
    status.classList.remove("hidden", "error");
  } catch (error) {
    status.textContent = error.name === "TimeoutError" ? "超时，请重试。" : error.message;
    status.classList.remove("hidden");
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = orig;
  }
}

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
  // 产品筛选：默认“全部产品”，避免只看到通用话术。
  const prods = [...new Set(playbook.map((e) => e.product))];
  playbookProduct.replaceChildren();
  const pAll = document.createElement("option");
  pAll.value = "";
  pAll.textContent = "全部产品";
  playbookProduct.appendChild(pAll);
  for (const p of prods) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    playbookProduct.appendChild(o);
  }
  if (prods.includes(productSelect.value)) playbookProduct.value = productSelect.value;

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
  const product = playbookProduct.value;
  const stage = playbookStage.value;
  const q = playbookSearch.value.trim().toLowerCase();
  const items = playbook.filter((e) => {
    // 选了具体产品时显示“该产品 + 通用”；选“通用”只看通用；不选则全部。
    if (product === "通用" && e.product !== "通用") return false;
    if (product && product !== "通用" && e.product !== product && e.product !== "通用") {
      return false;
    }
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

// ===================== 物料库 =====================
async function loadAssets() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/assets`, {
      headers: authHeaders()
    });
    const data = await response.json();
    assets = Array.isArray(data) ? data : [];
  } catch {
    assets = [];
  }
}

async function fetchAssetBlob(id) {
  const response = await fetch(`${API_BASE}/api/assets/file/${id}`, {
    headers: authHeaders()
  });
  if (!response.ok) throw new Error("图片加载失败");
  return response.blob();
}

function renderAssetsProductFilter() {
  const prods = [...new Set(assets.map((a) => a.product))];
  assetsProduct.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部产品";
  assetsProduct.appendChild(all);
  for (const p of prods) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    assetsProduct.appendChild(o);
  }
}

function renderAssets() {
  const product = assetsProduct.value;
  assetsList.replaceChildren();
  const items = assets.filter((a) => !product || a.product === product);
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "archive-meta";
    p.textContent = isAdminUser()
      ? "还没有物料，点右上「+ 上传物料」添加。"
      : "该产品暂无物料。";
    assetsList.appendChild(p);
    return;
  }
  for (const a of items) assetsList.appendChild(buildAssetItem(a));
}

function buildAssetItem(asset) {
  const item = document.createElement("article");
  item.className = "archive-item";
  const title = document.createElement("h3");
  const icon =
    asset.type === "image"
      ? "📷 "
      : asset.type === "video"
        ? "🎬 "
        : asset.type === "link"
          ? "🔗 "
          : "📝 ";
  title.textContent = icon + asset.name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  meta.textContent = PRODUCT_LABEL[asset.product] || asset.product;
  item.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";

  if (asset.type === "image" || asset.type === "video") {
    const isVideo = asset.type === "video";
    const mediaWrap = document.createElement("div");
    item.appendChild(mediaWrap);

    let blob = null;
    let blobUrl = "";
    let expanded = false;
    async function ensureBlob() {
      if (!blob) {
        blob = await fetchAssetBlob(asset.id);
        blobUrl = URL.createObjectURL(blob);
      }
      return blob;
    }

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "secondary";
    viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
    viewBtn.addEventListener("click", async () => {
      if (expanded) {
        mediaWrap.replaceChildren();
        expanded = false;
        viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
        return;
      }
      viewBtn.disabled = true;
      viewBtn.textContent = "加载中…";
      try {
        await ensureBlob();
        mediaWrap.replaceChildren();
        const media = document.createElement(isVideo ? "video" : "img");
        if (isVideo) {
          media.className = "asset-video";
          media.controls = true;
        } else {
          media.className = "asset-thumb";
          media.alt = asset.name;
        }
        media.src = blobUrl;
        mediaWrap.appendChild(media);
        expanded = true;
        viewBtn.textContent = "收起";
      } catch {
        mediaWrap.textContent = "（加载失败）";
      } finally {
        viewBtn.disabled = false;
        if (!expanded && viewBtn.textContent === "加载中…") {
          viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
        }
      }
    });

    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "secondary";
    dl.textContent = isVideo ? "下载视频" : "下载图片";
    dl.addEventListener("click", async () => {
      dl.disabled = true;
      try {
        await ensureBlob();
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${asset.name}.${asset.ext || (isVideo ? "mp4" : "png")}`;
        link.click();
      } catch {
        dl.textContent = "下载失败";
      } finally {
        dl.disabled = false;
      }
    });
    actions.append(viewBtn, dl);

    if (!isVideo) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary";
      copy.textContent = "复制图片";
      copy.addEventListener("click", async () => {
        try {
          await ensureBlob();
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          copy.textContent = "已复制";
          setTimeout(() => (copy.textContent = "复制图片"), 1000);
        } catch {
          copy.textContent = "改用下载";
        }
      });
      actions.append(copy);
    }
  } else if (asset.type === "link") {
    const url = document.createElement("p");
    url.className = "asset-url";
    url.textContent = asset.url;
    item.appendChild(url);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制链接";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(asset.url);
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制链接"), 1000);
    });
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "打开";
    open.addEventListener("click", () => window.open(asset.url, "_blank"));
    actions.append(copy, open);
  } else {
    const text = document.createElement("p");
    text.className = "asset-note";
    text.textContent = asset.text;
    item.appendChild(text);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制文字";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(asset.text);
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制文字"), 1000);
    });
    actions.append(copy);
  }

  if (isAdminUser()) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "archive-delete";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteAssetRecord(asset));
    actions.appendChild(del);
  }
  item.appendChild(actions);
  return item;
}

function openNewAssetForm() {
  assetForm.classList.remove("hidden");
  assetForm.replaceChildren();
  const card = document.createElement("article");
  card.className = "archive-item editing";

  const heading = document.createElement("h3");
  heading.textContent = "上传物料";
  card.appendChild(heading);

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "类型";
  const typeSel = document.createElement("select");
  for (const [v, t] of [["image", "📷 图片"], ["video", "🎬 视频"], ["link", "🔗 链接"], ["note", "📝 文字说明"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    typeSel.appendChild(o);
  }
  card.append(typeLabel, typeSel);

  const prodLabel = document.createElement("label");
  prodLabel.textContent = "所属产品";
  const prodSel = document.createElement("select");
  for (const p of ALL_PRODUCTS) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    prodSel.appendChild(o);
  }
  card.append(prodLabel, prodSel);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "名称";
  const nameInput = document.createElement("input");
  nameInput.placeholder = "例如：Rythmix Logo / 如何获取 User ID";
  card.append(nameLabel, nameInput);

  // 动态字段：图片→文件；链接→URL；说明→文本
  const fieldWrap = document.createElement("div");
  card.appendChild(fieldWrap);
  function renderField() {
    fieldWrap.replaceChildren();
    const lab = document.createElement("label");
    if (typeSel.value === "image" || typeSel.value === "video") {
      const isVideo = typeSel.value === "video";
      lab.textContent = isVideo ? "选择视频文件（约 33MB 内）" : "选择图片文件";
      const f = document.createElement("input");
      f.type = "file";
      f.accept = isVideo ? "video/*" : "image/*";
      f.id = "asset-file";
      fieldWrap.append(lab, f);
      if (isVideo) {
        const tip = document.createElement("small");
        tip.className = "editor-tip";
        tip.textContent = "大视频建议改用「🔗 链接」（贴云盘/YouTube 链接），更快更稳。";
        fieldWrap.append(tip);
      }
    } else if (typeSel.value === "link") {
      lab.textContent = "链接地址";
      const u = document.createElement("input");
      u.id = "asset-url";
      u.placeholder = "https://...";
      fieldWrap.append(lab, u);
    } else {
      lab.textContent = "文字内容";
      const t = document.createElement("textarea");
      t.id = "asset-text";
      t.rows = 4;
      t.placeholder = "例如：打开 app → 设置 → 底部复制 User ID 发给我们";
      fieldWrap.append(lab, t);
    }
  }
  typeSel.addEventListener("change", renderField);
  renderField();

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    assetForm.replaceChildren();
    assetForm.classList.add("hidden");
  });
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      await saveAsset(typeSel.value, name, prodSel.value);
      assetForm.replaceChildren();
      assetForm.classList.add("hidden");
      await loadAssets();
      renderAssetsProductFilter();
      renderAssets();
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      card.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  card.appendChild(actions);
  assetForm.appendChild(card);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function saveAsset(type, name, product) {
  const payload = { type, name, product };
  if (type === "image" || type === "video") {
    const file = document.getElementById("asset-file").files?.[0];
    if (!file) throw new Error(type === "video" ? "请选择视频文件。" : "请选择图片文件。");
    if (type === "video" && file.size > 34 * 1024 * 1024) {
      throw new Error("视频太大（约 33MB 内），请压缩或改用「🔗 链接」。");
    }
    payload.dataBase64 = await readFileAsBase64(file);
    payload.ext = (
      file.name.split(".").pop() || (type === "video" ? "mp4" : "png")
    ).toLowerCase();
  } else if (type === "link") {
    payload.url = document.getElementById("asset-url").value.trim();
    if (!payload.url) throw new Error("请填写链接。");
  } else {
    payload.text = document.getElementById("asset-text").value.trim();
    if (!payload.text) throw new Error("请填写文字内容。");
  }
  const response = await fetch(`${API_BASE}/api/assets`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "上传失败。");
}

async function deleteAssetRecord(asset) {
  if (!window.confirm(`确定删除物料「${asset.name}」？`)) return;
  try {
    const response = await fetch(`${API_BASE}/api/assets/delete`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: asset.id })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "删除失败。");
    await loadAssets();
    renderAssetsProductFilter();
    renderAssets();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
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
  analyzeButton.textContent = serviceOnline ? "生成回复中…" : "离线匹配中…";

  if (!serviceOnline) {
    renderAnalysis(localFallback(message));
    errorBox.textContent =
      "千问服务未启动，当前显示离线结果。请双击 start-assistant.cmd 后重试。";
    errorBox.classList.remove("hidden");
    analyzeButton.disabled = false;
    analyzeButton.textContent = "分析并建议回复";
    return;
  }

  const payload = {
    message,
    productId: productSelect.value,
    context: contextInput.value.trim(),
    operatorGoal: operatorGoalInput.value.trim(),
    replyLanguage: replyLanguageSelect?.value || "",
    channel: "Instagram"
  };

  // 清空旧结果，先把结果区露出来 + 显示"生成中"
  replyTargetInput.value = "";
  replyChineseInput.value = "";
  const biBox = document.getElementById("bi-split");
  if (biBox) biBox.innerHTML = '<div class="bi-loading">正在生成回复…</div>';
  const summary = document.getElementById("analysis-summary");
  if (summary) summary.textContent = "识别 & 内部提醒（分析中…）";
  emptyState.classList.add("hidden");
  result.classList.remove("hidden");

  // 阶段 1：快出「外语回复 + 中文」（追求 3-5 秒）
  const replyP = fetch(`${API_BASE}/api/reply`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  })
    .then((r) => r.json())
    .then((b) => {
      if (b && b.reply_target) {
        replyTargetInput.value = b.reply_target;
        replyChineseInput.value = b.reply_chinese || "";
        renderBilingualSplit(b.reply_target, b.reply_chinese || "");
      }
    })
    .catch(() => {});

  // 阶段 2：完整分析（后台补到下方折叠区，不阻塞回复）
  fetch(`${API_BASE}/api/analyze`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(65000)
  })
    .then((r) => r.json())
    .then((b) => {
      if (b && !b.error) renderAnalysis(b);
      if (summary) summary.textContent = "识别 & 内部提醒";
    })
    .catch(() => {
      if (summary) summary.textContent = "识别 & 内部提醒（分析未完成）";
    });

  try {
    await replyP; // 回复一出来就解禁按钮
    if (!replyTargetInput.value && biBox) {
      biBox.innerHTML = '<div class="bi-loading">回复生成较慢，分析结果会稍后补上…</div>';
    }
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "分析并建议回复";
  }
}

// ===================== 问 AI（通用聊天）=====================
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
let chatHistory = [];

function renderChat() {
  chatMessages.replaceChildren();
  if (!chatHistory.length) {
    const hint = document.createElement("p");
    hint.className = "chat-hint";
    hint.textContent =
      "问我任何问题：翻译、砍价思路、合作流程、某句话怎么说、某个红人值不值得合作……像聊天一样问就行。";
    chatMessages.appendChild(hint);
    return;
  }
  for (const m of chatHistory) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${m.role}`;
    bubble.textContent = m.content;
    chatMessages.appendChild(bubble);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) {
    chatInput.focus();
    return;
  }
  if (!serviceOnline) {
    chatHistory.push({ role: "assistant", content: "千问服务尚未连接。" });
    renderChat();
    return;
  }
  chatHistory.push({ role: "user", content: text });
  chatInput.value = "";
  renderChat();
  const sendBtn = document.getElementById("chat-send");
  sendBtn.disabled = true;
  sendBtn.textContent = "思考中…";
  const thinking = document.createElement("div");
  thinking.className = "chat-bubble assistant";
  thinking.textContent = "正在思考…";
  chatMessages.appendChild(thinking);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  try {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ messages: chatHistory }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "回答失败。");
    chatHistory.push({ role: "assistant", content: body.answer });
  } catch (error) {
    chatHistory.push({
      role: "assistant",
      content:
        error.name === "TimeoutError" ? "回答超时，请重试。" : error.message
    });
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "发送";
    renderChat();
  }
}

tabReactive.addEventListener("click", () => switchMode("reactive"));
tabProactive.addEventListener("click", () => switchMode("proactive"));
tabChat.addEventListener("click", () => switchMode("chat"));
document.getElementById("chat-send").addEventListener("click", sendChat);
document.getElementById("chat-clear").addEventListener("click", () => {
  chatHistory = [];
  renderChat();
});
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
});
document.getElementById("analyze").addEventListener("click", analyze);
generateTemplateButton.addEventListener("click", generateQuickTemplate);
generateFreeButton.addEventListener("click", () => generateFree("chinese_to_target"));
document
  .getElementById("free-faithful")
  .addEventListener("click", () => generateFree("faithful"));
translateProButton.addEventListener("click", translateProReply);
document.getElementById("rewrite-go-pro").addEventListener("click", rewriteGoPro);
document
  .getElementById("open-playbook-reactive")
  .addEventListener("click", () => openPlaybookPicker("reactive"));
document
  .getElementById("open-playbook-proactive")
  .addEventListener("click", () => openPlaybookPicker("proactive"));
document
  .getElementById("playbook-close")
  .addEventListener("click", () => playbookDialog.close());
playbookProduct.addEventListener("change", renderPlaybookList);
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
document.getElementById("rewrite-go").addEventListener("click", rewriteGo);
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
document.getElementById("open-assets").addEventListener("click", async () => {
  assetsPanel.classList.toggle("hidden");
  if (!assetsPanel.classList.contains("hidden")) {
    document.getElementById("new-asset").classList.remove("hidden");
    assetForm.classList.add("hidden");
    assetsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      await loadAssets();
      renderAssetsProductFilter();
      renderAssets();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  }
});
document.getElementById("new-asset").addEventListener("click", openNewAssetForm);
assetsProduct.addEventListener("change", renderAssets);
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

// 新手指引：首次打开显示，点"知道了"永久收起，顶部"❓"可再调出。
const guideCard = document.getElementById("guide-card");
async function initGuide() {
  try {
    const { kolGuideDismissed } = await chrome.storage.local.get(
      "kolGuideDismissed"
    );
    guideCard.classList.toggle("hidden", Boolean(kolGuideDismissed));
  } catch {
    guideCard.classList.remove("hidden");
  }
}
document.getElementById("guide-dismiss").addEventListener("click", async () => {
  guideCard.classList.add("hidden");
  try {
    await chrome.storage.local.set({ kolGuideDismissed: true });
  } catch {
    // 忽略存储失败。
  }
});
document.getElementById("open-guide").addEventListener("click", () => {
  guideCard.classList.remove("hidden");
  guideCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

loadConfig().then(() => {
  fillServerSettings();
  loadPendingMessage();
  checkService();
});
initGuide();

// ====================== KOL 提醒面板 ======================
(function () {
  const DEFAULT_PREFIXES = ["recco", "rythmix", "aicatch", "vivavideo"];
  const SETTINGS_KEY = "kolReminderSettings";
  const panel = document.getElementById("reminder-panel");
  if (!panel) return;

  const openBtn = document.getElementById("open-reminders");
  const closeBtn = document.getElementById("reminder-close");
  const listEl = document.getElementById("reminder-list");
  const mutedEl = document.getElementById("muted-list");
  const myProductSel = document.getElementById("my-product");
  const myHandleInput = document.getElementById("my-handle");
  const prefixInput = document.getElementById("product-prefixes");
  const enabledInput = document.getElementById("reminder-enabled");
  const settingsStatus = document.getElementById("reminder-settings-status");

  function nowIso() { return new Date().toISOString(); }
  function daysSince(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }
  function threadUrl(id) { return `https://www.instagram.com/direct/t/${id}/`; }
  // 优先复用已打开的 IG 标签页（导航过去并聚焦），没有才开新标签
  function openConversationTab(url) {
    try {
      chrome.tabs.query({ url: "*://*.instagram.com/*" }, (tabs) => {
        if (tabs && tabs.length) {
          chrome.tabs.update(tabs[0].id, { url, active: true });
          if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          chrome.tabs.create({ url });
        }
      });
    } catch (e) {
      chrome.tabs.create({ url });
    }
  }

  async function getLocal(keys) { return chrome.storage.local.get(keys); }
  async function setLocal(obj) { return chrome.storage.local.set(obj); }

  // —— 身份设置 ——
  async function loadSettings() {
    const s = (await getLocal(SETTINGS_KEY))[SETTINGS_KEY] || {};
    const prefixes = (s.productPrefixes && s.productPrefixes.length)
      ? s.productPrefixes
      : DEFAULT_PREFIXES;
    // 我的产品下拉：直接来自产品前缀清单（recco/rythmix/aicatch/vivavideo）
    myProductSel.replaceChildren();
    const blank = document.createElement("option");
    blank.value = ""; blank.textContent = "（未选）";
    myProductSel.appendChild(blank);
    prefixes.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p; opt.textContent = p;
      myProductSel.appendChild(opt);
    });
    myProductSel.value = s.myProduct || "";
    myHandleInput.value = s.myHandle || "";
    prefixInput.value = prefixes.join(", ");
    enabledInput.checked = s.enabled !== false;
  }

  document.getElementById("save-reminder-settings").addEventListener("click", async () => {
    const prefixes = prefixInput.value.split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const next = {
      enabled: enabledInput.checked,
      myProduct: myProductSel.value || "",
      myHandle: myHandleInput.value.trim().replace(/^@/, ""),
      productPrefixes: prefixes.length ? prefixes : DEFAULT_PREFIXES.slice()
    };
    await setLocal({ [SETTINGS_KEY]: next });
    settingsStatus.textContent = "已保存 ✓";
    settingsStatus.classList.remove("hidden");
    setTimeout(() => settingsStatus.classList.add("hidden"), 1500);
  });

  // —— 计算提醒清单（与后台一致） ——
  function computeItems(threads, todos) {
    const items = [];
    Object.entries(threads || {}).forEach(([recKey, rec]) => {
      if (!rec || rec.muted) return;
      const j = rec.judge || {};
      // 名字优先；抓不到名字时用消息预览，绝不甩一串对话 ID 给用户
      const looksLikeId = (x) => /^\d{6,}$/.test(String(x || ""));
      let title = rec.title || rec.creatorName || recKey || "";
      if (looksLikeId(title)) title = "";
      if (!title) title = (rec.inboxPreview || rec.lastMsgPreview || "").slice(0, 24);
      if (!title) title = "未命名对话";
      const sig = rec.judgeSignature || "";
      if (rec.needsReplyRaw && j.is_pleasantry !== true && rec.replyDismissedSig !== sig) {
        items.push({
          kind: "reply", key: recKey, threadId: rec.threadId, isGroup: rec.isGroup, title,
          label: rec.needsReplyReason || j.reminder_label || `等你回复`,
          ai: j.ai_note || "",
          meta: `已搁置约 ${daysSince(rec.firstUnrepliedAt || rec.lastSeenAt)} 天 · 上次看到 ${fmt(rec.lastSeenAt)}`
        });
      }
      if (j.needs_follow_up && j.is_pleasantry !== true && rec.followDismissedSig !== sig) {
        const threshold = Number.isFinite(Number(j.follow_up_after_days)) ? Number(j.follow_up_after_days) : 2;
        const elapsed = daysSince(rec.judgedAt || rec.lastSeenAt);
        if (elapsed >= threshold) {
          items.push({
            kind: "follow", key: recKey, threadId: rec.threadId, isGroup: rec.isGroup, title,
            label: j.reminder_label || `该跟进：${j.waiting_for || ""}`,
            ai: j.ai_note || "",
            meta: `在等：${j.waiting_for || "—"} · 已 ${elapsed} 天`
          });
        }
      }
    });
    (todos || []).forEach((t) => {
      if (!t || t.done || t.dismissed) return;
      const due = Date.parse(t.dueAt);
      if (Number.isFinite(due) && due <= Date.now()) {
        items.push({ kind: "todo", todoId: t.id, threadId: t.threadId || "", title: t.text, label: "", meta: `到点：${fmt(t.dueAt)}` });
      }
    });
    return items;
  }

  function fmt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // —— 渲染 ——
  async function render() {
    const store = await getLocal(["kolThreads", "kolTodos"]);
    const threads = store.kolThreads || {};
    const items = computeItems(threads, store.kolTodos || []);
    listEl.replaceChildren();

    if (!items.length) {
      const p = document.createElement("p");
      p.className = "reminder-empty";
      p.textContent = "暂无提醒。打开 IG 私信刷一刷，这里会自动出现「待回复 / 待跟进」。";
      listEl.appendChild(p);
    } else {
      const groups = [
        ["reply", "📥 待回复（红人发了我没回）"],
        ["follow", "⏳ 待跟进（口头答应没推进 / 该催）"],
        ["todo", "📝 待办"]
      ];
      groups.forEach(([kind, name]) => {
        const sub = items.filter((i) => i.kind === kind);
        if (!sub.length) return;
        const h = document.createElement("div");
        h.className = "reminder-group-title";
        h.textContent = `${name} · ${sub.length}`;
        listEl.appendChild(h);
        sub.forEach((it) => listEl.appendChild(card(it)));
      });
    }

    // 静音群列表
    mutedEl.replaceChildren();
    const muted = Object.entries(threads).filter(([, r]) => r && r.muted);
    if (!muted.length) {
      const p = document.createElement("div");
      p.className = "muted-row";
      p.textContent = "（没有静音的群）";
      mutedEl.appendChild(p);
    } else {
      muted.forEach(([recKey, r]) => {
        const row = document.createElement("div");
        row.className = "muted-row";
        const span = document.createElement("span");
        span.textContent = r.title || r.creatorName || recKey;
        const btn = document.createElement("button");
        btn.textContent = "取消静音";
        btn.addEventListener("click", async () => { await patchThread(recKey, { muted: false }); });
        row.append(span, btn);
        mutedEl.appendChild(row);
      });
    }
  }

  function card(it) {
    const el = document.createElement("div");
    el.className = `reminder-card ${it.kind}`;
    const t = document.createElement("div");
    t.className = "rc-title";
    t.textContent = (it.kind === "todo" ? "📝 " : "") + (it.title || "");
    el.appendChild(t);
    if (it.label) {
      const l = document.createElement("div");
      l.className = "rc-label";
      l.textContent = it.label;
      el.appendChild(l);
    }
    if (it.ai) {
      const a = document.createElement("div");
      a.className = "rc-ai";
      a.textContent = "🤖 " + it.ai;
      el.appendChild(a);
    }
    const m = document.createElement("div");
    m.className = "rc-meta";
    m.textContent = it.meta || "";
    el.appendChild(m);

    const actions = document.createElement("div");
    actions.className = "rc-actions";
    if (it.kind !== "todo") {
      // 有数字ID就深链到对话；没有(只在列表见过、没点开过)就打开私信收件箱
      const url = it.threadId ? threadUrl(it.threadId) : "https://www.instagram.com/direct/inbox/";
      actions.appendChild(btn("打开对话", () => openConversationTab(url)));
    }
    if (it.kind === "reply") {
      actions.appendChild(btn("不用提醒了", () => dismissThread(it.key, "reply")));
    } else if (it.kind === "follow") {
      actions.appendChild(btn("不用提醒了", () => dismissThread(it.key, "follow")));
    } else if (it.kind === "todo") {
      actions.appendChild(btn("完成", () => patchTodo(it.todoId, { done: true })));
      actions.appendChild(btn("删除", () => patchTodo(it.todoId, { dismissed: true })));
    }
    if (it.isGroup && it.key) {
      actions.appendChild(btn("🔕 这个群别再提醒", () => patchThread(it.key, { muted: true })));
    }
    el.appendChild(actions);
    return el;
  }

  function btn(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  async function patchThread(id, patch) {
    const store = await getLocal("kolThreads");
    const map = store.kolThreads || {};
    if (map[id]) { map[id] = { ...map[id], ...patch }; await setLocal({ kolThreads: map }); }
  }
  async function dismissThread(id, kind) {
    const store = await getLocal("kolThreads");
    const map = store.kolThreads || {};
    if (map[id]) {
      const sig = map[id].judgeSignature || "";
      map[id][kind === "reply" ? "replyDismissedSig" : "followDismissedSig"] = sig;
      await setLocal({ kolThreads: map });
    }
  }
  async function patchTodo(id, patch) {
    const store = await getLocal("kolTodos");
    const todos = store.kolTodos || [];
    const next = todos.map((t) => (t.id === id ? { ...t, ...patch } : t));
    await setLocal({ kolTodos: next });
  }

  // —— 加待办 ——
  document.getElementById("add-todo").addEventListener("click", async () => {
    const text = document.getElementById("todo-text").value.trim();
    const dueRaw = document.getElementById("todo-due").value;
    if (!text) return;
    let dueAt = nowIso();
    if (dueRaw) { const d = new Date(dueRaw); if (!isNaN(d)) dueAt = d.toISOString(); }
    const store = await getLocal("kolTodos");
    const todos = store.kolTodos || [];
    todos.push({ id: "t" + Date.now(), text, dueAt, done: false, dismissed: false });
    await setLocal({ kolTodos: todos });
    document.getElementById("todo-text").value = "";
    document.getElementById("todo-due").value = "";
  });

  // 智能加待办：打一句话，AI 解析出事项 + 时间
  document.getElementById("add-todo-smart").addEventListener("click", async () => {
    const input = document.getElementById("todo-smart");
    const sentence = input.value.trim();
    if (!sentence) { input.focus(); return; }
    const btn = document.getElementById("add-todo-smart");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "解析中…";
    try {
      const res = await fetch(`${API_BASE}/api/parse-todo`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sentence, now: new Date().toISOString() }),
        signal: AbortSignal.timeout(20000)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "解析失败");
      // 用解析出的本地日期时间拼 dueAt
      let dueAt = nowIso();
      if (body.date) {
        const d = new Date(`${body.date}T${(body.time || "10:00")}:00`);
        if (!isNaN(d)) dueAt = d.toISOString();
      }
      const store = await getLocal("kolTodos");
      const todos = store.kolTodos || [];
      todos.push({ id: "t" + Date.now(), text: body.text || sentence, dueAt, done: false, dismissed: false });
      await setLocal({ kolTodos: todos });
      input.value = "";
      btn.textContent = "已加 ✓";
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch (e) {
      btn.textContent = "解析失败,改手动";
      setTimeout(() => { btn.textContent = orig; }, 1800);
    } finally {
      btn.disabled = false;
    }
  });

  // —— 开关面板 ——
  function openPanel() { panel.classList.remove("hidden"); loadSettings(); render(); panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
  openBtn && openBtn.addEventListener("click", () => panel.classList.contains("hidden") ? openPanel() : panel.classList.add("hidden"));
  closeBtn && closeBtn.addEventListener("click", () => panel.classList.add("hidden"));
  const popoutBtn = document.getElementById("reminder-popout");
  popoutBtn && popoutBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "KOL_OPEN_TODO_WINDOW" }));

  // 记账本一变就重渲染（实时反映采集结果）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.kolThreads || changes.kolTodos) && !panel.classList.contains("hidden")) {
      render();
    }
  });
})();
