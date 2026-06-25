// KOL 提醒 · 采集脚本（搭便车读屏，绝不碰 IG 账号）
// 只在你自己打开的 Instagram 私信/群聊页面上，读已经渲染出来的对话，
// 记进本地记账本（chrome.storage.local）。不发任何 IG 请求、不替你点/滚/发。
(function () {
  if (!location.hostname.includes("instagram.com")) return;

  const THREADS_KEY = "kolThreads"; // 记账本：每个对话一条
  const SETTINGS_KEY = "kolReminderSettings"; // 身份设置：我的产品 / 产品清单 / 我的号
  const DEFAULT_PREFIXES = ["recco", "rythmix", "aicatch", "vivavideo"];

  let settings = {
    enabled: true,
    myProduct: "",
    myHandle: "",
    productPrefixes: DEFAULT_PREFIXES.slice()
  };

  chrome.storage.local.get(SETTINGS_KEY).then((s) => {
    if (s[SETTINGS_KEY]) settings = { ...settings, ...s[SETTINGS_KEY] };
    maybeAutodetectHandle();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      settings = { ...settings, ...(changes[SETTINGS_KEY].newValue || {}) };
    }
  });

  // —— 工具 —————————————————————————————————————————————

  function log(...args) {
    // 调试用，真机上按需打开
    // console.debug("[KOL提醒]", ...args);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function prefixes() {
    const list = Array.isArray(settings.productPrefixes)
      ? settings.productPrefixes
      : DEFAULT_PREFIXES;
    return list.map((p) => String(p || "").toLowerCase().trim()).filter(Boolean);
  }

  // 账号名是不是「我方同事」（以产品名开头）
  function isColleagueHandle(handle) {
    const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
    if (!h) return false;
    return prefixes().some((p) => h.startsWith(p));
  }

  function isMyHandle(handle) {
    const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
    const mine = String(settings.myHandle || "").toLowerCase().replace(/^@/, "").trim();
    return Boolean(mine) && h === mine;
  }

  // 蓝气泡 / 靠右 = 我自己发的（沿用翻译脚本的判断思路）
  function isBlueLike(color) {
    const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [, r, g, b] = m.map(Number);
    return b > 145 && b > r * 1.18 && b > g * 1.08;
  }
  function isOutgoingBubble(element) {
    let cur = element;
    for (let depth = 0; cur && depth < 7; depth += 1) {
      const style = getComputedStyle(cur);
      if (
        isBlueLike(style.backgroundColor) ||
        style.justifyContent === "flex-end" ||
        style.alignSelf === "flex-end"
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function currentThreadId() {
    const m = location.pathname.match(/\/direct\/t\/([^/]+)/);
    return m ? m[1] : null;
  }
  function inDirect() {
    return location.pathname.startsWith("/direct/");
  }

  // 登录后顺手认出「我自己的号」，自动判出我的产品（读不到就算了，可手填）
  function maybeAutodetectHandle() {
    if (settings.myHandle) return;
    try {
      // 个人头像/菜单里常带 href="/<myhandle>/"，或 IG 注入的全局变量
      const link = document.querySelector('a[href^="/"][role="link"] img[alt*="头像"], a[href^="/"] img[alt*="profile picture"]');
      let handle = "";
      if (link) {
        const a = link.closest('a[href^="/"]');
        const href = a && a.getAttribute("href");
        if (href) handle = href.replace(/\//g, "").trim();
      }
      if (handle && handle.length < 40) {
        const product = prefixes().find((p) => handle.toLowerCase().startsWith(p)) || "";
        const next = { ...settings, myHandle: handle };
        if (product && !settings.myProduct) next.myProduct = product;
        settings = next;
        chrome.storage.local.set({ [SETTINGS_KEY]: next });
        log("自动认出我的号:", handle, "产品:", product);
      }
    } catch (e) {
      /* 读不到就算了 */
    }
  }

  // —— 读「打开的对话」————————————————————————————————

  // 找到对话里每条消息气泡（带文字的最内层），按出现顺序返回 {from,name,text}
  function readOpenConversation() {
    const main = document.querySelector('div[role="main"], main');
    if (!main) return null;

    // 消息气泡：main 里的 [dir='auto'] 文本块（排除导航/按钮）
    const nodes = main.querySelectorAll("div[dir='auto'], span[dir='auto']");
    const seen = new Set();
    const messages = [];

    nodes.forEach((el) => {
      const text = (el.innerText || "").trim();
      if (!text || text.length > 1500) return;
      if (el.closest("nav, header, footer, [role='dialog'], textarea, [role='textbox']")) return;
      // 去掉父子重复（外层和内层文字一样时只取一次）
      const parentAuto = el.parentElement && el.parentElement.closest("[dir='auto']");
      if (parentAuto && parentAuto !== el && (parentAuto.innerText || "").trim() === text) return;
      if (seen.has(text + "@" + messages.length)) return;

      const mine = isOutgoingBubble(el);
      let from, name = "";
      if (mine) {
        from = "me";
      } else {
        name = senderNameFor(el);
        if (isMyHandle(name)) from = "me";
        else if (isColleagueHandle(name)) from = "colleague";
        else from = "creator";
      }
      messages.push({ from, name, text });
    });

    if (!messages.length) return null;

    // 群聊判断：出现过同事，或出现过 2 个以上不同的非我发送者名字
    const incomingNames = new Set(
      messages.filter((m) => m.from !== "me" && m.name).map((m) => m.name)
    );
    const hasColleague = messages.some((m) => m.from === "colleague");
    const isGroup = hasColleague || incomingNames.size > 1;

    // 红人名字：取被判成 creator 的、出现最多的那个名字；否则用对话标题
    const creatorName =
      mostCommon(messages.filter((m) => m.from === "creator").map((m) => m.name)) ||
      conversationTitle() ||
      "";

    return { messages: messages.slice(-14), isGroup, creatorName };
  }

  // 群聊里每条消息上方通常有发送者名字；尽量往上找一个短文本当名字
  function senderNameFor(el) {
    let row = el;
    for (let i = 0; i < 6 && row; i += 1) {
      // 同一「消息行」里找带 username 的小标签
      const label = row.querySelector && row.querySelector("h5, h4, [role='heading']");
      if (label) {
        const t = (label.innerText || "").trim();
        if (t && t.length < 40) return t;
      }
      row = row.parentElement;
    }
    return "";
  }

  function conversationTitle() {
    // 对话顶部标题栏的名字
    const header = document.querySelector('div[role="main"] header, main header');
    if (header) {
      const t = (header.innerText || "").split("\n")[0].trim();
      if (t && t.length < 60) return t;
    }
    return "";
  }

  function mostCommon(arr) {
    const counts = new Map();
    arr.filter(Boolean).forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
    let best = "", n = 0;
    counts.forEach((v, k) => {
      if (v > n) { n = v; best = k; }
    });
    return best;
  }

  // —— 读「收件箱列表」(best-effort) ——————————————————

  function scanInbox() {
    const rows = [];
    const anchors = document.querySelectorAll('a[href*="/direct/t/"]');
    anchors.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/direct\/t\/([^/?]+)/);
      if (!m) return;
      const id = m[1];
      const container = a.closest('[role="listitem"]') || a;
      const text = (container.innerText || "").trim();
      if (!text) return;
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const title = lines[0] || "";
      const preview = lines.slice(1).join(" ").slice(0, 120);
      // 未读启发式：aria 标记 / 行内有蓝色未读小圆点 / 整行字重偏粗
      const unread =
        /未读|Unread|new message/i.test(container.getAttribute("aria-label") || "") ||
        hasUnreadDot(container) ||
        isBold(container);
      // 预览里最后一条是不是"我发的"：IG 会给我方消息加"你:/You:"前缀
      const lastFromMe = /^\s*(you|您|你|me)\s*[:：]/i.test(preview);
      rows.push({ id, title, preview, unread, lastFromMe });
    });
    return rows;
  }

  // 行内找一个蓝色的小圆点（IG 未读指示）
  function hasUnreadDot(container) {
    const els = container.querySelectorAll("div, span");
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < 16 && r.height > 0 && r.height < 16) {
        if (isBlueLike(getComputedStyle(el).backgroundColor)) return true;
      }
    }
    return false;
  }

  function isBold(container) {
    const el = container.querySelector("span, div");
    if (!el) return false;
    const w = getComputedStyle(el).fontWeight;
    return Number(w) >= 600 || w === "bold";
  }

  // —— 记账本读写 ——————————————————————————————————

  async function getThreads() {
    const s = await chrome.storage.local.get(THREADS_KEY);
    return s[THREADS_KEY] || {};
  }
  async function saveThreads(map) {
    await chrome.storage.local.set({ [THREADS_KEY]: map });
  }

  // 更新一条对话记录，并在需要时请求 AI 判断
  async function upsertThread(id, patch, recentForJudge) {
    if (!id) return;
    const map = await getThreads();
    const prev = map[id] || {};
    const rec = { ...prev, ...patch, threadId: id, lastSeenAt: nowIso() };

    // 「第一次发现没回」的锚点：从「不是待回复」变成「待回复」时盖戳
    if (patch.needsReplyRaw && !prev.needsReplyRaw) {
      rec.firstUnrepliedAt = nowIso();
    }
    if (!patch.needsReplyRaw) {
      rec.firstUnrepliedAt = null;
    }

    map[id] = rec;
    await saveThreads(map);

    // 最后一条变了才请求 AI 判断，省调用
    if (recentForJudge && recentForJudge.length) {
      const sig = recentForJudge.map((m) => m.from + ":" + m.text).join("|").slice(-400);
      if (rec.judgeSignature !== sig && !rec.muted) {
        requestJudge(id, {
          messages: recentForJudge,
          isGroup: rec.isGroup,
          creatorName: rec.creatorName,
          productId: settings.myProduct
        }, sig);
      }
    }
  }

  let judging = false;
  const judgeQueue = [];
  async function requestJudge(id, payload, sig) {
    judgeQueue.push({ id, payload, sig });
    if (judging) return;
    judging = true;
    while (judgeQueue.length) {
      const job = judgeQueue.shift();
      try {
        const res = await chrome.runtime.sendMessage({ type: "KOL_JUDGE", payload: job.payload });
        if (res && !res.error) {
          const map = await getThreads();
          if (map[job.id]) {
            map[job.id].judge = res;
            map[job.id].judgeSignature = job.sig;
            map[job.id].judgedAt = nowIso();
            await saveThreads(map);
            maybeRenderDeadlineHint(job.id, res);
          }
        }
      } catch (e) {
        log("判断失败", e);
      }
    }
    judging = false;
  }

  // —— 会话内「该问 DDL」内嵌提示 ————————————————————

  const HINT_ID = "kol-ddl-hint";
  function removeHint() {
    const el = document.getElementById(HINT_ID);
    if (el) el.remove();
  }

  async function maybeRenderDeadlineHint(id, judge) {
    if (id !== currentThreadId()) return; // 只在当前打开的会话里提示
    removeHint();
    if (!judge || !judge.should_ask_deadline) return;

    // 这个会话的这个阶段被「这次不用」过就别再弹
    const map = await getThreads();
    const rec = map[id] || {};
    if (rec.ddlHintDismissedStage && rec.ddlHintDismissedStage === judge.stage) return;

    const box = document.querySelector('div[role="textbox"], textarea[placeholder]');
    const footer = box ? box.closest("form, div") : null;
    const anchor = footer || document.querySelector('div[role="main"]') || document.body;

    const hint = document.createElement("div");
    hint.id = HINT_ID;
    hint.className = "kol-ddl-hint";
    const tip = document.createElement("div");
    tip.className = "kol-ddl-tip";
    tip.textContent = "⏰ 还没和 TA 约交稿时间，顺手问一下吧";
    hint.appendChild(tip);

    const askText =
      judge.suggested_ask_deadline_text ||
      "Hi! When do you think the first draft could be ready?（问初稿时间）";
    const defaultText =
      "Hi! We usually plan around 3 days for the first draft — does that work for you?（默认约 3 天交稿）";

    hint.appendChild(makeHintBtn("插入「问档期」", () => insertIntoBox(askText)));
    hint.appendChild(makeHintBtn("插入「默认3天」", () => insertIntoBox(defaultText)));
    hint.appendChild(
      makeHintBtn("这次不用", async () => {
        removeHint();
        const m2 = await getThreads();
        if (m2[id]) {
          m2[id].ddlHintDismissedStage = judge.stage;
          await saveThreads(m2);
        }
      })
    );

    if (footer && footer.parentElement) {
      footer.parentElement.insertBefore(hint, footer);
    } else {
      anchor.appendChild(hint);
    }
  }

  function makeHintBtn(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kol-ddl-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // 只把话术「填进」IG 输入框，绝不替你发送
  function insertIntoBox(text) {
    const box = document.querySelector('div[role="textbox"], textarea[placeholder]');
    if (!box) return;
    box.focus();
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } catch (e) {
      if ("value" in box) box.value = text;
      else box.textContent = text;
    }
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // —— 主扫描 ————————————————————————————————————————

  async function scan() {
    if (!settings.enabled || !inDirect()) return;
    try {
      // 1) 收件箱列表：把你划过的对话都记一笔。
      //    关键：只在列表里看到「未读」或「最后一条不是我发的」，就算待回复，
      //    不用你点进对话——这样"红人发了、我只瞄了一眼没点开"也能提醒。
      const inbox = scanInbox();
      const openId = currentThreadId();
      if (inbox.length) {
        const map = await getThreads();
        let changed = false;
        inbox.forEach((row) => {
          // 当前正打开的那条交给第 2 步精读，这里不用列表的粗判覆盖它
          if (row.id === openId) return;
          const prev = map[row.id] || {};
          // 列表判待回复：未读，或预览显示最后一条不是我发的
          const inboxNeedsReply =
            Boolean(row.unread) || (Boolean(row.preview) && !row.lastFromMe);
          const next = {
            ...prev,
            threadId: row.id,
            title: row.title || prev.title || "",
            inboxPreview: row.preview || prev.inboxPreview || "",
            lastMsgPreview: row.preview || prev.lastMsgPreview || "",
            unread: row.unread,
            needsReplyRaw: inboxNeedsReply,
            lastSeenAt: nowIso()
          };
          // 「第一次发现没回」锚点：从"不是待回复"变成"待回复"时盖戳
          if (inboxNeedsReply && !prev.needsReplyRaw) next.firstUnrepliedAt = nowIso();
          if (!inboxNeedsReply) next.firstUnrepliedAt = null;
          map[row.id] = next;
          changed = true;
        });
        if (changed) await saveThreads(map);
      }

      // 2) 当前打开的对话：精读消息，判断待回复 + 触发 AI 判断
      const id = currentThreadId();
      if (id) {
        const conv = readOpenConversation();
        if (conv && conv.messages.length) {
          const msgs = conv.messages;
          // 待回复(原始启发式)：最后一条 creator 之后，没有我(me)的回复
          let lastCreatorIdx = -1;
          msgs.forEach((m, i) => {
            if (m.from === "creator") lastCreatorIdx = i;
          });
          const myReplyAfter =
            lastCreatorIdx >= 0 &&
            msgs.slice(lastCreatorIdx + 1).some((m) => m.from === "me");
          const needsReplyRaw = lastCreatorIdx >= 0 && !myReplyAfter;
          const last = msgs[msgs.length - 1];

          await upsertThread(
            id,
            {
              isGroup: conv.isGroup,
              creatorName: conv.creatorName,
              title: conv.creatorName || conversationTitle() || "",
              lastMsgFrom: last.from,
              lastMsgPreview: last.text.slice(0, 120),
              needsReplyRaw,
              unread: false // 打开了就不算未读
            },
            msgs
          );

          // 若已有判断结果，刷新会话内 DDL 提示
          const map2 = await getThreads();
          if (map2[id] && map2[id].judge) maybeRenderDeadlineHint(id, map2[id].judge);
        }
      } else {
        removeHint();
      }
    } catch (e) {
      log("扫描出错", e);
    }
  }

  // —— 触发时机：搭便车，不主动滚 ——————————————————————

  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  let lastPath = location.pathname;
  function watchUrl() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      removeHint();
      scheduleScan();
    }
  }

  scheduleScan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("scroll", scheduleScan, true);
  window.addEventListener("focus", scheduleScan);
  setInterval(watchUrl, 800); // IG 是单页应用，靠轮询察觉换会话
})();
