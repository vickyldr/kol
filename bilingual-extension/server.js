const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const HOST = process.env.KOL_ASSISTANT_HOST || "127.0.0.1";
const PORT = Number(process.env.KOL_ASSISTANT_PORT || 3210);
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-flash";
// 团队口令：部署到 VPS 给团队用时设置，未设置则为本机单人模式（不校验）。
const AUTH_TOKEN = process.env.KOL_ASSISTANT_TOKEN || "";
// 管理员口令：设置后，只有带正确管理员口令的请求才能编辑/删除已有话术。
const ADMIN_TOKEN = process.env.KOL_ASSISTANT_ADMIN_TOKEN || "";
const ROOT = __dirname;
const KNOWLEDGE_PATH = path.join(ROOT, "data", "knowledge-base.json");
const PRODUCTS_PATH = path.join(ROOT, "data", "products.json");
const ARCHIVE_PATH = path.join(ROOT, "data", "scenario-archive.json");
const QUICK_TEMPLATES_PATH = path.join(ROOT, "data", "quick-templates.json");

const REPLY_STYLE = `统一回复风格（生成任何对外回复时必须严格遵守）：
- 简洁：只说必要的话，不堆砌客套、不重复，一般 2-4 句，能短不长。
- 专业：符合商务沟通习惯，准确可信。
- 易懂：用对方容易理解的表达，不绕弯、不用生僻说法。
- 有逻辑：先说重点，再补充必要信息，条理清楚。
- 有礼貌：友好、尊重，但不卑微、不过度道歉、不夸张吹捧。
- 忠于原意：严格按照运营给出的中文意图或草稿来写，绝不自行添加运营没有表达的承诺、理由、数字或信息；运营写得简略时只做自然润色与补全礼貌用语，不擅自扩写内容。`;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-KOL-Token, X-KOL-Admin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function compactKnowledge(records, message) {
  const words = String(message || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);

  return records
    .map((record) => {
      const haystack = JSON.stringify(record).toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (haystack.includes(word) ? 1 : 0),
        0
      );
      return { record, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ record }) => record);
}

function parseJsonText(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function findProduct(productId) {
  const products = loadJson(PRODUCTS_PATH, []);
  return (
    products.find((product) => product.id === productId) ||
    products.find((product) => product.id === "generic") ||
    null
  );
}

function sanitizeCandidates(records, product) {
  if (!product || product.id !== "generic") return records;

  return records.map((record) => ({
    source: record.source,
    stable_id: record.stable_id,
    scene: record.scene,
    note:
      "仅参考该记录的沟通流程和场景分类。禁止复用其中的品牌名、产品介绍、账号、链接、平台数量、视频时长、价格、授权期限或付款承诺。"
  }));
}

function normalizeAnalysis(value) {
  const analysis = value?.output_contract || value?.analysis || value;
  const guidance = analysis?.internal_guidance || {};

  return {
    detected_language: analysis?.detected_language || "未知",
    literal_chinese:
      analysis?.literal_chinese || analysis?.chinese_translation || "",
    implied_meaning: analysis?.implied_meaning || "无明显言外之意",
    implication_confidence: analysis?.implication_confidence || "low",
    intent: analysis?.intent || "待判断",
    stage: analysis?.stage || "待判断",
    matched_source: analysis?.matched_source || "新场景",
    match_type: ["exact", "partial", "new_scenario"].includes(
      analysis?.match_type
    )
      ? analysis.match_type
      : "new_scenario",
    reply_target: analysis?.reply_target || "",
    reply_chinese: analysis?.reply_chinese || "",
    alternative_target: analysis?.alternative_target || "",
    alternative_chinese: analysis?.alternative_chinese || "",
    required_variables:
      analysis?.required_variables || analysis?.missing_information || [],
    mentioned_items: Array.isArray(analysis?.mentioned_items)
      ? analysis.mentioned_items.map((item) => ({
          term: String(item?.term || ""),
          plain_explanation: String(item?.plain_explanation || ""),
          previous_context:
            ["yes", "no", "unknown"].includes(item?.previous_context)
              ? item.previous_context
              : "unknown",
          attention: String(item?.attention || ""),
          suggested_action: String(item?.suggested_action || "")
        }))
      : [],
    internal_guidance: {
      level: ["info", "confirm", "block"].includes(guidance.level)
        ? guidance.level
        : "confirm",
      explanation: guidance.explanation || "",
      question_for_tl: guidance.question_for_tl || "",
      temporary_reply_target: guidance.temporary_reply_target || "",
      temporary_reply_chinese: guidance.temporary_reply_chinese || "",
      operator_reminders: guidance.operator_reminders || []
    },
    risk_warning: analysis?.risk_warning || ""
  };
}

async function callQwen({ system, user, maxTokens = 1200, temperature = 0.1 }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    const error = new Error("尚未配置阿里云百炼 API Key。");
    error.code = "MISSING_DASHSCOPE_KEY";
    throw error;
  }

  const response = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(55000)
    }
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      body?.error?.message || `百炼请求失败：${response.status}`
    );
  }
  return parseJsonText(body?.choices?.[0]?.message?.content);
}

async function analyzeWithQwen(payload) {
  const product = findProduct(payload.productId);
  const archiveRecords = loadJson(ARCHIVE_PATH, []).filter(
    (record) =>
      record.status === "active" &&
      (!record.product_id ||
        record.product_id === "generic" ||
        record.product_id === payload.productId)
  );
  const candidates = sanitizeCandidates(compactKnowledge(
    [
      ...archiveRecords.map((record) => ({
        source: "运营确认存档",
        stable_id: record.id,
        scene: record.scene_name,
        fields: {
          trigger_examples: record.trigger_examples,
          correct_understanding: record.correct_understanding,
          external_reply_target: record.external_reply_target,
          external_reply_chinese: record.external_reply_chinese,
          internal_guidance: record.internal_guidance,
          required_variables: record.required_variables
        }
      })),
      ...loadJson(KNOWLEDGE_PATH, [])
    ],
    payload.message
  ), product);

  const systemPrompt = `你是一个服务于中国 KOL 运营团队的多语言沟通助手，主要处理 Instagram 和邮件中的海外创作者合作。

你必须严格区分两种内容：
A. 对外回复：允许直接复制给红人，只能包含自然、礼貌的沟通内容。
B. 内部处理建议：仅供运营查看，包括询问 TL、预算上限、操作步骤、教程提醒、风险和判断依据。内部内容绝不能泄漏到对外回复。

工作规则：
1. 准确翻译红人消息，同时分别说明“字面意思”和“可能的言外之意”。言外之意必须标注不确定性，不可把猜测当事实。
1a. 必须先识别句子的施事者、接收者和动作方向，明确“谁让谁做什么”。祈使句默认是说话者要求收信人执行动作。例如“请发送发票给我”绝不能翻译或理解成“我已收到你的发票”。
1b. 原文没有说“已收到、已完成、已同意、已付款”等事实时，禁止自行补成既成事实。上下文为空时，必须把消息视为突然出现的独立消息，不得虚构此前沟通。
2. 判断合作阶段和红人意图，从候选话术中匹配最合适场景。
3. 产品资料只用于当前产品；不得把其他产品的名称、账号、Brief 或规则混入回复。
4. 不得编造价格、币种、视频数量、日期、平台、授权期限、付款时间、链接或合同条件。
5. 缺少关键变量时，列入 required_variables，并生成可安全暂时发送的回复。
6. 涉及价格、广告授权、二次使用、合同、付款承诺、删帖重发、强制好评等事项时，判断是否必须问 TL。
7. internal_guidance.level 只能是 info、confirm 或 block：
   - info：操作提醒，不阻止发送；
   - confirm：建议问 TL，但可先发临时回复；
   - block：必须问 TL，禁止发送承诺性正式回复。
8. internal_guidance.question_for_tl 要写成运营可以直接复制给 TL 的中文问题。
9. 如果需要问 TL，temporary_reply_target 和 temporary_reply_chinese 提供等待确认期间可以先发给红人的安全回复。
10. 语言规则（最重要，必须严格执行）：reply_target、alternative_target、internal_guidance.temporary_reply_target 必须使用红人原消息所用的语言，也就是 detected_language。红人说泰语就用泰语，说日语就用日语，说西班牙语就用西班牙语。绝对禁止在红人没有用英语时把回复写成英语。只有当红人本人就用英语沟通时才用英语。每条外语回复都要附准确中文对照。
11. matched_source 使用人类可读场景名，不使用行号。
12. 返回的 JSON 顶层必须直接包含 detected_language、literal_chinese、intent 等字段。不得增加 output_contract、analysis、result 等外层包装。
13. 当 selected_product.id 为 generic 时，禁止出现 Recco 或候选话术中的任何具体品牌、账号、链接、视频时长、平台数量和商务条件；缺失内容必须作为变量或澄清问题。
14. 提取消息中新出现的业务事项、文件、费用、平台功能或专业术语到 mentioned_items。不要只重复翻译，要用中国运营能懂的白话解释它在当前语境可能是什么。
15. 对每个 mentioned_item 核对 conversation_context：
   - 明确在上下文出现过：previous_context=yes；
   - 上下文非空且未出现：previous_context=no；
   - 没有提供上下文或无法判断：previous_context=unknown。
   不得在没有完整历史时断言“之前没有聊过”，只能说“当前提供的上下文中未看到”或“无法判断”。
16. 专业词可能存在地区差异时必须提醒。例如 invoice / billing document / เอกสารวางบิล 可能指请款单、账单、形式发票、税务发票或付款所需资料，不能默认等同于中国增值税发票，应建议确认具体文件类型。

${REPLY_STYLE}`;

  const outputContract = {
    detected_language: "语言",
    literal_chinese: "中文准确意译",
    implied_meaning: "可能的言外之意；没有则写无明显言外之意",
    implication_confidence: "high|medium|low",
    intent: "红人意图",
    stage: "合作阶段",
    matched_source: "匹配场景名",
    match_type: "exact|partial|new_scenario",
    reply_target: "正式外语回复；若 block 则使用安全临时回复",
    reply_chinese: "正式回复中文对照",
    alternative_target: "备选外语回复",
    alternative_chinese: "备选回复中文对照",
    required_variables: ["需要运营填写的变量"],
    mentioned_items: [
      {
        term: "原文提到的事项或术语",
        plain_explanation: "结合语境的白话解释，而不是简单重复中文词",
        previous_context: "yes|no|unknown",
        attention: "为什么值得注意",
        suggested_action: "建议运营下一步怎么确认"
      }
    ],
    internal_guidance: {
      level: "info|confirm|block",
      explanation: "为什么需要或不需要内部确认",
      question_for_tl: "可直接发给 TL 的中文问题；不需要则为空字符串",
      temporary_reply_target: "等待 TL 时先发给红人的外语回复；不需要则为空字符串",
      temporary_reply_chinese: "临时回复中文对照；不需要则为空字符串",
      operator_reminders: ["仅内部可见的操作提醒"]
    },
    risk_warning: "发送前风险提示"
  };

  const userPrompt = JSON.stringify({
    output_contract: outputContract,
    selected_product: product,
    channel: payload.channel || "Instagram",
    conversation_context: payload.context || "",
    creator_message: payload.message,
    operator_goal: payload.operatorGoal || "",
    knowledge_candidates: candidates
  });

  return normalizeAnalysis(
    await callQwen({
      system: systemPrompt,
      user: userPrompt,
      maxTokens: 1500,
      temperature: 0.15
    })
  );
}

async function translateFaithfully(text) {
  const result = await callQwen({
    system: `你是聊天消息翻译器。只做忠实翻译，不分析、不回复、不补充上下文。
必须准确保留主语、宾语、动作方向、时态、否定、疑问和祈使语气，特别明确“谁让谁做什么”。
原文没有说已发生的事情，不得翻译成已发生。例如“请把发票发给我”只能翻译为请求对方发送发票，不能写成“已收到发票”。
品牌名、人名、金额、日期、链接按原文保留。
如果原文已经是中文，也原样返回。
遇到专业词、地区性商务词或直译后仍难懂的词时，额外给出白话解释。例：billing document / เอกสารวางบิล 不要只写“发票”，应说明它通常泛指用于请款或付款结算的文件，具体可能是账单、请款单、形式发票或税务发票，需要向对方确认。
只返回 JSON：{"translation":"中文翻译","source_language":"语言","uncertain":false,"term_notes":[{"term":"原词或中文术语","explanation":"白话解释"}]}。`,
    user: JSON.stringify({ message: text }),
    maxTokens: 350,
    temperature: 0
  });

  return {
    translation: String(result.translation || "").trim(),
    source_language: result.source_language || "未知",
    uncertain: Boolean(result.uncertain),
    term_notes: Array.isArray(result.term_notes)
      ? result.term_notes
          .map((item) => ({
            term: String(item?.term || "").trim(),
            explanation: String(item?.explanation || "").trim()
          }))
          .filter((item) => item.term && item.explanation)
      : []
  };
}

async function askQwen(payload) {
  const product = findProduct(payload.productId);
  const result = await callQwen({
    system: `你是中国 KOL 运营人员的问答助手。回答用户针对当前红人消息提出的问题。
必须忠于原文，特别检查主语、宾语、动作方向、时态和祈使句，不能把“对方要求我方发送”说成“对方已经发送/我方已经收到”。
原文没有提供的上下文必须明确说不知道，不得虚构此前聊过什么。
产品资料只能作为背景，不得编造价格、日期、授权或付款条件。
用简洁中文回答；如用户要求，可给出目标语言回复。
只返回 JSON：{"answer":"回答内容"}。`,
    user: JSON.stringify({
      creator_message: payload.message || "",
      conversation_context: payload.context || "",
      selected_product: product,
      previous_analysis: payload.analysis || null,
      question: payload.question || ""
    }),
    maxTokens: 900,
    temperature: 0.15
  });
  return { answer: String(result.answer || "").trim() };
}

async function rewriteReply(payload) {
  const product = findProduct(payload.productId);
  const direction = payload.direction;

  if (direction === "target_to_chinese") {
    const result = await callQwen({
      system: `你是 KOL 商务沟通翻译校对助手。
将运营提供的外语回复忠实翻译成自然中文，供运营核对。
严格保留价格、日期、数量、平台、授权、否定和语气，不得增加原文没有的承诺。
只返回 JSON：{"reply_target":"原外语不变","reply_chinese":"中文翻译"}。`,
      user: JSON.stringify({
        reply_target: payload.replyTarget || "",
        creator_message: payload.message || ""
      }),
      maxTokens: 700,
      temperature: 0
    });
    return {
      reply_target: String(result.reply_target || payload.replyTarget || ""),
      reply_chinese: String(result.reply_chinese || "")
    };
  }

  const replyLanguage =
    String(payload.replyLanguage || "").trim() ||
    String(payload.detectedLanguage || "").trim();

  const result = await callQwen({
    system: `你是中国 KOL 运营人员的双语回复编辑器。
运营会在中文框中输入两类内容之一：
1. 可以直接发送的大致中文回复；
2. 简略的写作意图，例如“对方不愿意修改，我要委婉劝他，给出几点理由”。

你必须智能判断是哪一种，并结合红人原话、上下文、产品资料和运营目标，生成自然、专业、像真人的正式回复。

【输出语言规则，最重要】
- 如果提供了 reply_language，外语版本必须使用 reply_language。
- 如果没有提供 reply_language，则使用 creator_message（红人原消息）所用的语言。
- 红人说泰语就用泰语、说日语就用日语，绝不能在红人没用英语时擅自改成英语。
- reply_target 必须是完整的外语回复，绝对不能为空，绝对不能只返回中文。
- reply_chinese 必须是 reply_target 的准确中文对照，而不是重复运营的简略指令。

必须准确区分谁让谁做什么，不得虚构此前发生的事情。
不得自行编造价格、日期、授权期限、付款承诺、平台、产品账号或链接。
信息不足时使用安全的澄清表达，不要脑补。

${REPLY_STYLE}

只返回 JSON：{"reply_target":"最终外语回复（不能为空）","reply_chinese":"最终中文对照"}。`,
    user: JSON.stringify({
      creator_message: payload.message || "",
      conversation_context: payload.context || "",
      selected_product: product,
      reply_language: replyLanguage,
      current_reply_target: payload.replyTarget || "",
      chinese_draft_or_instruction: payload.replyChinese || "",
      operator_goal: payload.operatorGoal || ""
    }),
    maxTokens: 1000,
    temperature: 0.25
  });

  return {
    reply_target: String(result.reply_target || ""),
    reply_chinese: String(result.reply_chinese || "")
  };
}

async function generateQuickTemplate(payload) {
  const product = findProduct(payload.productId);
  const templates = loadJson(QUICK_TEMPLATES_PATH, []);
  const template = templates.find((item) => item.id === payload.templateId);
  if (!template) throw new Error("未找到该快捷话术。");

  const variables = payload.variables || {};
  const missingVariables = template.required_variables.filter(
    (name) => !String(variables[name] || "").trim()
  );
  const filledIntent = template.chinese_intent.replace(
    /\{\{([a-zA-Z0-9_]+)\}\}/g,
    (_, name) =>
      String(variables[name] || "").trim() || `【请填写：${name}】`
  );

  const result = await callQwen({
    system: `你是中国 KOL 运营团队的主动话术生成器。
filled_chinese_intent 是已经把运营填写的变量替换好的中文写作意图，请严格按它来生成回复。
其中只有形如【请填写：变量名】的占位符才表示该信息缺失，必须原样保留、不能由你猜测。
凡是 variables 里已经给出的值（例如产品名、数量、日期、链接等），必须如实体现在最终回复中，绝不能遗漏或忽略。
目标语言由 target_language 指定；如果是英语则使用自然、友好、专业的英语。
不得自行编造价格、日期、数量、平台、账号、链接、授权期限或付款时间。
回复适合 Instagram 私信，除非 channel 指定 Email。

${REPLY_STYLE}

只返回 JSON：{"reply_target":"目标语言回复","reply_chinese":"准确中文对照","required_variables":["仍需填写的变量"]}。`,
    user: JSON.stringify({
      scene_name: template.name,
      scene_category: template.category,
      filled_chinese_intent: filledIntent,
      filled_variables: variables,
      selected_product: product,
      target_language: payload.targetLanguage || "英语",
      channel: payload.channel || "Instagram",
      missing_variables: missingVariables
    }),
    maxTokens: 1000,
    temperature: 0.2
  });

  return {
    template_id: template.id,
    scene_name: template.name,
    category: template.category,
    reply_target: String(result.reply_target || ""),
    reply_chinese: String(result.reply_chinese || ""),
    required_variables: Array.isArray(result.required_variables)
      ? result.required_variables
      : missingVariables
  };
}

function archiveRecord(payload) {
  const records = loadJson(ARCHIVE_PATH, []);
  const now = new Date().toISOString();
  const id =
    payload.id ||
    `scene_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const existingIndex = records.findIndex((record) => record.id === id);
  const previous = existingIndex >= 0 ? records[existingIndex] : null;

  const record = {
    id,
    version: (previous?.version || 0) + 1,
    status: payload.status === "inactive" ? "inactive" : "active",
    product_id: String(payload.product_id || "generic"),
    scene_name: String(payload.scene_name || "未命名场景").trim(),
    stage: String(payload.stage || "").trim(),
    trigger_examples: Array.isArray(payload.trigger_examples)
      ? payload.trigger_examples.map(String).filter(Boolean)
      : [],
    correct_understanding: String(payload.correct_understanding || "").trim(),
    external_reply_target: String(payload.external_reply_target || "").trim(),
    external_reply_chinese: String(payload.external_reply_chinese || "").trim(),
    internal_guidance: payload.internal_guidance || {},
    required_variables: Array.isArray(payload.required_variables)
      ? payload.required_variables.map(String).filter(Boolean)
      : [],
    notes: String(payload.notes || "").trim(),
    created_at: previous?.created_at || now,
    updated_at: now
  };

  if (existingIndex >= 0) records[existingIndex] = record;
  else records.unshift(record);
  saveJson(ARCHIVE_PATH, records);
  return record;
}

function archiveHasId(id) {
  return loadJson(ARCHIVE_PATH, []).some((record) => record.id === id);
}

function deleteRecord(id) {
  const records = loadJson(ARCHIVE_PATH, []);
  const next = records.filter((record) => record.id !== id);
  saveJson(ARCHIVE_PATH, next);
  return { deleted: records.length - next.length };
}

// 没设置管理员口令时（本机单人模式）视为管理员，保持旧行为；
// 团队部署设置了 KOL_ASSISTANT_ADMIN_TOKEN 后，编辑/删除已有话术需带正确管理员口令。
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers["x-kol-admin"] === ADMIN_TOKEN;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  // 设置了团队口令时，所有 /api/* 必须带正确口令（/health 放行用于连通性检测）。
  if (
    AUTH_TOKEN &&
    req.url.startsWith("/api/") &&
    req.headers["x-kol-token"] !== AUTH_TOKEN
  ) {
    return json(res, 401, {
      error: "团队口令不正确或缺失，请在插件「服务器设置」里填写正确的口令。",
      code: "UNAUTHORIZED"
    });
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        provider: "阿里云百炼",
        model: MODEL,
        ai_configured: Boolean(process.env.DASHSCOPE_API_KEY),
        timeout_seconds: 55
      });
    }

    if (req.method === "GET" && req.url === "/api/products") {
      return json(res, 200, loadJson(PRODUCTS_PATH, []));
    }

    if (req.method === "GET" && req.url === "/api/quick-templates") {
      return json(res, 200, loadJson(QUICK_TEMPLATES_PATH, []));
    }

    if (req.method === "GET" && req.url.startsWith("/api/archive")) {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const query = String(url.searchParams.get("q") || "").toLowerCase();
      const productId = String(url.searchParams.get("product_id") || "");
      const records = loadJson(ARCHIVE_PATH, []).filter((record) => {
        if (productId && record.product_id !== productId) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return json(res, 200, records);
    }

    if (req.method === "POST" && req.url === "/api/archive") {
      const payload = await readBody(req);
      // 编辑已存在的话术需要管理员；新增不需要。
      if (payload.id && archiveHasId(payload.id) && !isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以编辑已保存的话术。",
          code: "FORBIDDEN"
        });
      }
      return json(res, 200, archiveRecord(payload));
    }

    if (req.method === "POST" && req.url === "/api/archive/delete") {
      if (!isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以删除话术。",
          code: "FORBIDDEN"
        });
      }
      const payload = await readBody(req);
      if (!String(payload.id || "").trim()) {
        return json(res, 400, { error: "缺少要删除的话术 id。" });
      }
      return json(res, 200, deleteRecord(payload.id));
    }

    if (req.method === "POST" && req.url === "/api/archive/export") {
      return json(res, 200, {
        exported_at: new Date().toISOString(),
        records: loadJson(ARCHIVE_PATH, [])
      });
    }

    if (req.method === "POST" && req.url === "/api/analyze") {
      const payload = await readBody(req);
      if (!String(payload.message || "").trim()) {
        return json(res, 400, { error: "请先提供红人的消息。" });
      }
      return json(res, 200, await analyzeWithQwen(payload));
    }

    if (req.method === "POST" && req.url === "/api/translate") {
      const payload = await readBody(req);
      const text = String(payload.text || "").trim();
      if (!text) return json(res, 400, { error: "缺少翻译文本。" });
      if (text.length > 1200) {
        return json(res, 400, { error: "单条消息过长。" });
      }
      return json(res, 200, await translateFaithfully(text));
    }

    if (req.method === "POST" && req.url === "/api/ask") {
      const payload = await readBody(req);
      if (!String(payload.question || "").trim()) {
        return json(res, 400, { error: "请输入想问千问的问题。" });
      }
      return json(res, 200, await askQwen(payload));
    }

    if (req.method === "POST" && req.url === "/api/rewrite") {
      const payload = await readBody(req);
      if (
        payload.direction === "target_to_chinese" &&
        !String(payload.replyTarget || "").trim()
      ) {
        return json(res, 400, { error: "请先填写外语回复。" });
      }
      if (
        payload.direction !== "target_to_chinese" &&
        !String(payload.replyChinese || "").trim()
      ) {
        return json(res, 400, { error: "请先在中文框写下回复或大概意图。" });
      }
      return json(res, 200, await rewriteReply(payload));
    }

    if (req.method === "POST" && req.url === "/api/generate-template") {
      const payload = await readBody(req);
      if (!String(payload.templateId || "").trim()) {
        return json(res, 400, { error: "请选择话术场景。" });
      }
      return json(res, 200, await generateQuickTemplate(payload));
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, {
      error: error.message || "服务发生错误。",
      code: error.code || "SERVER_ERROR"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`KOL Assistant is running at http://${HOST}:${PORT}`);
  console.log(`Provider: Alibaba Cloud Model Studio`);
  console.log(`Model: ${MODEL}`);
});
