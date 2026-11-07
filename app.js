const GITHUB_OWNER = "YOUR_GITHUB_USERNAME";
const GITHUB_REPO = "YOUR_MODEL_REPO";
const GITHUB_BRANCH = "main";
const GITHUB_MODEL_DIR = "models";

const STORAGE = {
  temp: "qxeai_temp_entries",
  pin: p => "qxeai_pin_" + p,
  current: "qxeai_current_pin",
  manifest: "qxeai_manifest",
  manifestTs: "qxeai_manifest_ts",
};

const MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/manifest.json`;
const MANIFEST_TTL = 5 * 60 * 1000;

let currentPin = "";
let tempEntries = [];
let pinCache = {};
let manifest = [];
let busy = false;

function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) { return false; }
}

function lsRemove(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

const SKILL_RE = /^###\s*(.+?)\s*$/;
const ASK_RE = /^-\s*(\d+)\.\s*(.+?)\s*$/;

function parseKb(text) {
  const entries = [];
  let skill = "未分类", ask = null, lines = [], counter = 0;
  function flush() {
    if (ask !== null) {
      counter++;
      entries.push({ skill, ask, answer: lines.join("\n").trim(), index: counter });
    }
    ask = null; lines = [];
  }
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const mSkill = line.match(SKILL_RE);
    if (mSkill) { flush(); skill = mSkill[1].trim(); continue; }
    const mAsk = line.match(ASK_RE);
    if (mAsk) { flush(); ask = mAsk[2].trim(); continue; }
    if (ask !== null) {
      if (lines.length === 0 && line.trim() === "") continue;
      lines.push(line);
    }
  }
  flush();
  return entries;
}

const SYNONYMS = {
  "如何": "怎么", "怎样": "怎么", "咋": "怎么", "咋样": "怎么", "咋办": "怎么",
  "为啥": "为什么", "什么原因": "为什么", "为何": "为什么",
  "倒过来": "反转", "反过来": "反转", "颠倒": "反转", "翻转": "反转",
  "移除": "删除", "去掉": "删除", "删掉": "删除", "清除": "删除",
  "新建": "创建", "建立": "创建", "生成": "创建", "做出": "创建",
  "看看": "查看", "显示": "查看", "展示": "查看",
  "更改": "修改", "改动": "修改", "换成": "修改",
  "报错": "错误", "异常": "错误", "出错": "错误", "bug": "错误",
  "变慢": "性能", "很慢": "性能", "卡顿": "性能",
  "电脑": "计算机", "pc": "计算机",
  "数组": "列表", "array": "列表", "list": "列表",
  "映射": "字典", "map": "字典", "dict": "字典",
  "方法": "函数", "method": "函数", "function": "函数",
};

const SYN_PHRASES = Object.entries(SYNONYMS).sort((a, b) => b[0].length - a[0].length);

function normalizeText(s) {
  s = s.toLowerCase();
  for (const [k, v] of SYN_PHRASES) {
    if (s.includes(k)) s = s.split(k).join(v);
  }
  return s;
}

function tokenize(s) {
  s = normalizeText(s);
  const en = new Set(s.match(/[a-z0-9_]+/g) || []);
  const zhChars = [...s].filter(c => /[\u4e00-\u9fff]/.test(c));
  const zh = new Set();
  for (let i = 0; i < zhChars.length; i++) {
    zh.add(zhChars[i]);
    if (i < zhChars.length - 1) zh.add(zhChars[i] + zhChars[i + 1]);
  }
  return new Set([...en, ...zh]);
}

function score(query, entry) {
  const q = query.trim().toLowerCase();
  const a = entry.ask.trim().toLowerCase();
  if (!q) return 0;
  if (q === a) return 100;
  const qn = normalizeText(q), an = normalizeText(a);
  if (qn === an) return 95;
  if (qn.includes(an) || an.includes(qn)) return 88;
  const qt = tokenize(q), at = tokenize(a);
  const inter = new Set([...qt].filter(x => at.has(x)));
  const union = new Set([...qt, ...at]);
  const jac = union.size === 0 ? 0 : inter.size / union.size;
  const fuzzy = (typeof fuzz !== "undefined") ? fuzz.token_set_ratio(qn, an) / 100 : 0;
  return 60 * jac + 40 * fuzzy;
}

function search(entries, query, topK = 3, minScore = 20) {
  if (!entries.length || !query.trim()) return [];
  const scored = entries.map(e => ({ score: score(query, e), entry: e }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(x => x.score >= minScore);
}

function loadMineaiFromObject(data) {
  if (!data || data.format !== "mineai") throw new Error("不是有效的 .qxeai 文件");
  if (!Array.isArray(data.entries)) throw new Error("entries 字段损坏");
  const entries = data.entries
    .filter(d => d && typeof d === "object")
    .map((d, i) => ({
      skill: String(d.skill || "未分类"),
      ask: String(d.ask || "").trim(),
      answer: String(d.answer || ""),
      index: i + 1,
    }))
    .filter(e => e.ask);
  entries.forEach((e, i) => e.index = i + 1);
  return entries;
}

function buildMineaiPayload(entries) {
  return {
    format: "mineai",
    version: 1,
    app: "MineAi",
    exported_at: new Date().toISOString().slice(0, 19),
    count: entries.length,
    skills: [...new Set(entries.map(e => e.skill))].sort(),
    entries: entries.map(e => ({ ...e })),
  };
}

async function fetchPinEntries(pin) {
  const url = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_MODEL_DIR}/${pin}.qxeai`;
  const resp = await fetch(url);
  if (resp.status === 404) throw new Error(`未找到模型：${pin}`);
  if (!resp.ok) throw new Error(`拉取失败 (${resp.status})`);
  const data = await resp.json();
  return loadMineaiFromObject(data);
}

async function loadManifest(force = false) {
  const cached = lsGet(STORAGE.manifest);
  const ts = lsGet(STORAGE.manifestTs, 0);
  const fresh = Date.now() - ts < MANIFEST_TTL;
  if (cached && fresh && !force) return cached;
  try {
    const resp = await fetch(MANIFEST_URL + "?t=" + Date.now());
    if (!resp.ok) throw new Error("manifest " + resp.status);
    const data = await resp.json();
    lsSet(STORAGE.manifest, data);
    lsSet(STORAGE.manifestTs, Date.now());
    return data;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function activatePin(pin, announce = true) {
  pin = String(pin).trim().toLowerCase();
  if (!pin) return;
  if (!pinCache[pin]) {
    const cached = lsGet(STORAGE.pin(pin));
    if (cached) {
      pinCache[pin] = cached;
    } else {
      const entries = await fetchPinEntries(pin);
      pinCache[pin] = entries;
      lsSet(STORAGE.pin(pin), entries);
    }
  }
  currentPin = pin;
  lsSet(STORAGE.current, pin);
  renderKbMeta();
  renderModelList();
  if (announce) toast("已切换到模型：" + pin);
}

function deactivatePin() {
  currentPin = "";
  lsRemove(STORAGE.current);
  renderKbMeta();
  renderModelList();
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg) {
  const el = document.getElementById("pinStatus");
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
}

function appendMessage(role, text, meta) {
  document.getElementById("emptyHint").style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    wrap.querySelector(".bubble").appendChild(m);
  }
  const box = document.getElementById("messages");
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

function renderModelList() {
  const el = document.getElementById("modelList");
  if (!el) return;
  if (!manifest.length) {
    el.innerHTML = `<div class="hint">未发现可用模型</div>`;
    return;
  }
  el.innerHTML = manifest.map(m => {
    const active = currentPin === m.pin;
    const loaded = !!pinCache[m.pin] || !!lsGet(STORAGE.pin(m.pin));
    return `<div class="model-item${active ? " active" : ""}" data-pin="${escapeHtml(m.pin)}">
      <div class="model-name">${escapeHtml(m.pin)}</div>
      <div class="model-meta">${m.count} 条 · ${m.skills} 组${loaded ? " · 已缓存" : ""}</div>
    </div>`;
  }).join("");
  el.querySelectorAll(".model-item").forEach(node => {
    node.addEventListener("click", () => applyPinName(node.dataset.pin));
  });
}

async function applyPinName(pin) {
  document.getElementById("pinStatus").textContent = "加载中…";
  try {
    await activatePin(pin);
  } catch (e) {
    document.getElementById("pinStatus").textContent = e.message;
  }
}

async function applyPin() {
  const pin = document.getElementById("pinInput").value.trim().toLowerCase();
  if (!pin) return;
  await applyPinName(pin);
}

async function refreshModels() {
  document.getElementById("pinStatus").textContent = "刷新中…";
  try {
    const data = await loadManifest(true);
    manifest = data.models || [];
    renderModelList();
    toast(`已刷新：${manifest.length} 个模型`);
  } catch (e) {
    toast("刷新失败：" + e.message);
  }
}

function getActiveEntries() {
  if (currentPin && pinCache[currentPin]) return pinCache[currentPin];
  return tempEntries;
}

function renderKbMeta() {
  const entries = getActiveEntries();
  const skills = {};
  entries.forEach(e => (skills[e.skill] = skills[e.skill] || []).push(e));
  const lines = [];
  for (const [skill, items] of Object.entries(skills)) {
    lines.push(`### ${skill}`);
    items.forEach(it => lines.push(`-${it.index}. ${it.ask}`));
    lines.push("");
  }
  const source = currentPin ? "pin:" + currentPin : (entries.length ? "导入/临时" : "空");
  document.getElementById("kbMeta").innerHTML =
    `共 <strong>${entries.length}</strong> 条 · 来源：${escapeHtml(source)}` +
    (lines.length ? `<pre>${escapeHtml(lines.join("\n"))}</pre>` : "");
}

async function send() {
  if (busy) return;
  const input = document.getElementById("query");
  const text = input.value.trim();
  if (!text) return;
  busy = true;
  document.getElementById("sendBtn").disabled = true;
  input.value = ""; input.style.height = "auto";
  appendMessage("user", text);
  try {
    const entries = getActiveEntries();
    if (!entries.length) {
      appendMessage("assistant", "知识库为空。请先选择模型，或导入知识库。");
      return;
    }
    const results = search(entries, text, 3, 20);
    if (!results.length) {
      appendMessage("assistant", "在当前知识库中未找到相关内容。");
    } else {
      const best = results[0];
      const meta = [];
      if (currentPin) meta.push("模型：" + currentPin);
      if (best.entry.skill) meta.push("技能：" + best.entry.skill);
      meta.push("相关度：" + best.score.toFixed(1));
      appendMessage("assistant", best.entry.answer, meta.join(" · "));
    }
  } catch (e) {
    appendMessage("assistant", "出错了：" + e.message);
  } finally {
    busy = false;
    document.getElementById("sendBtn").disabled = false;
    input.focus();
  }
}

async function importFile() {
  const fileInput = document.getElementById("importFile");
  const file = fileInput.files[0];
  if (!file) return toast("请先选择文件");
  const replace = document.getElementById("replaceKb").checked;
  if (replace) tempEntries = [];
  try {
    const text = await file.text();
    let newEntries;
    if (file.name.endsWith(".qxeai") || file.name.endsWith(".mineai")) {
      newEntries = loadMineaiFromObject(JSON.parse(text));
    } else {
      newEntries = parseKb(text);
    }
    const existing = new Set(tempEntries.map(e => e.ask.trim().toLowerCase()));
    let added = 0;
    for (const e of newEntries) {
      const k = e.ask.trim().toLowerCase();
      if (k && !existing.has(k)) { tempEntries.push(e); existing.add(k); added++; }
    }
    tempEntries.forEach((e, i) => e.index = i + 1);
    lsSet(STORAGE.temp, tempEntries);
    deactivatePin();
    renderKbMeta();
    toast(`导入完成：新增 ${added} 条，共 ${tempEntries.length} 条`);
  } catch (e) {
    toast("导入失败：" + e.message);
  }
  fileInput.value = "";
}

function exportKb() {
  const entries = getActiveEntries();
  if (!entries.length) return toast("知识库为空");
  const payload = buildMineaiPayload(entries);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (currentPin || "qxeai_model") + ".qxeai";
  a.click();
  URL.revokeObjectURL(url);
}

function clearAll() {
  if (!confirm("清空所有本地缓存（包括导入的知识库和模型缓存）？")) return;
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith("qxeai_"))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  tempEntries = [];
  pinCache = {};
  currentPin = "";
  renderKbMeta();
  renderModelList();
  toast("已清空本地缓存");
}

async function preloadAll() {
  if (!manifest.length) return toast("没有可加载的模型");
  let ok = 0, fail = 0;
  for (const m of manifest) {
    if (pinCache[m.pin] || lsGet(STORAGE.pin(m.pin))) { ok++; continue; }
    try {
      const entries = await fetchPinEntries(m.pin);
      pinCache[m.pin] = entries;
      lsSet(STORAGE.pin(m.pin), entries);
      ok++;
      renderModelList();
    } catch (e) {
      fail++;
    }
  }
  renderModelList();
  toast(`预加载完成：成功 ${ok}，失败 ${fail}`);
}

async function init() {
  tempEntries = lsGet(STORAGE.temp, []);
  try {
    const data = await loadManifest();
    manifest = data.models || [];
  } catch (e) {
    console.warn("manifest 加载失败", e);
  }
  renderModelList();
  renderKbMeta();

  const lastPin = lsGet(STORAGE.current, "");
  if (lastPin) {
    try {
      await activatePin(lastPin, false);
    } catch (e) {
      console.warn("自动加载 pin 失败", e);
      deactivatePin();
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
