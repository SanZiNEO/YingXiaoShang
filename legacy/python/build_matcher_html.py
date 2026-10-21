"""Build a self-contained HTML viewer for tagged marketing news.

Inputs:
  data/marketing_news/wscn/normalized/news_articles.json
  data/marketing_textbook/ch03-05/knowledge_points.json
Output:
  data/marketing_news/wscn/normalized/matcher.html
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEWS_PATH = ROOT / "data" / "marketing_news" / "wscn" / "normalized" / "news_articles_all_tagged.json"
if not NEWS_PATH.exists():
    NEWS_PATH = ROOT / "data" / "marketing_news" / "wscn" / "normalized" / "news_articles_full_tagged.json"
KP_PATH = ROOT / "data" / "marketing_textbook" / "ch03-05" / "knowledge_points.json"
QUESTIONS_PATH = ROOT / "data" / "marketing_news" / "wscn" / "normalized" / "news_questions_all.json"
if not QUESTIONS_PATH.exists():
    QUESTIONS_PATH = ROOT / "data" / "marketing_news" / "wscn" / "normalized" / "news_questions.json"
OUT_PATH = ROOT / "data" / "marketing_news" / "wscn" / "normalized" / "matcher.html"

NEWS_JSON = json.dumps(json.loads(NEWS_PATH.read_text(encoding="utf-8")), ensure_ascii=False).replace("</", "<\\/")
KP_JSON = json.dumps(json.loads(KP_PATH.read_text(encoding="utf-8")), ensure_ascii=False).replace("</", "<\\/")
QUESTIONS_JSON = json.dumps(json.loads(QUESTIONS_PATH.read_text(encoding="utf-8")), ensure_ascii=False).replace("</", "<\\/")

HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>营销新闻 × 知识点匹配台</title>
<style>
  :root {
    --bg: #f5f7fb;
    --surface: #ffffff;
    --surface-2: #fbfcfe;
    --border: #e5e7eb;
    --text: #111827;
    --muted: #6b7280;
    --faint: #9ca3af;
    --accent: #4f46e5;
    --accent-2: #2563eb;
    --accent-soft: #eef2ff;
    --green: #047857;
    --green-soft: #ecfdf5;
    --orange: #c2410c;
    --orange-soft: #fff7ed;
    --rose: #be123c;
    --rose-soft: #fff1f2;
    --radius: 16px;
    --shadow: 0 10px 30px rgba(17, 24, 39, .06);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--text);
    background:
      radial-gradient(1100px 520px at 8% -10%, #e0e7ff 0%, rgba(224,231,255,0) 60%),
      radial-gradient(900px 480px at 100% 0%, #fce7f3 0%, rgba(252,231,243,0) 55%),
      var(--bg);
    min-height: 100vh;
  }
  .app { max-width: 1440px; margin: 0 auto; padding: 28px 24px 48px; }
  .hero {
    display: flex; justify-content: space-between; gap: 24px; align-items: flex-end;
    margin-bottom: 20px;
  }
  .eyebrow {
    font-size: 11px; letter-spacing: .16em; font-weight: 700;
    color: var(--accent); text-transform: uppercase; margin-bottom: 8px;
  }
  h1 { margin: 0; font-size: clamp(24px, 3vw, 36px); letter-spacing: -.02em; line-height: 1.15; }
  .sub { margin: 8px 0 0; color: var(--muted); font-size: 14px; line-height: 1.6; max-width: 680px; }
  .stats { display: flex; gap: 10px; flex-shrink: 0; }
  .stat {
    background: rgba(255,255,255,.72); backdrop-filter: blur(10px);
    border: 1px solid rgba(229,231,235,.9); border-radius: 14px;
    padding: 12px 16px; min-width: 84px; text-align: center; box-shadow: var(--shadow);
  }
  .stat span { display: block; font-size: 22px; font-weight: 750; letter-spacing: -.02em; }
  .stat small { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; }
  .toolbar {
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
    background: rgba(255,255,255,.82); backdrop-filter: blur(10px);
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px; box-shadow: var(--shadow); margin-bottom: 12px;
  }
  .search {
    flex: 1; min-width: 240px; border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; font-size: 14px; outline: none; background: var(--surface);
    transition: border-color .15s, box-shadow .15s;
  }
  .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79,70,229,.12); }
  select {
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
    font-size: 14px; background: var(--surface); color: var(--text); outline: none;
    max-width: 260px;
  }
  button {
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px;
    background: var(--surface); color: var(--text); font-size: 14px; cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  button:hover { background: var(--accent-soft); border-color: #c7d2fe; }
  .result-count { margin-left: auto; color: var(--muted); font-size: 13px; white-space: nowrap; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px; }
  .chip {
    border: 1px solid var(--border); background: rgba(255,255,255,.8);
    border-radius: 999px; padding: 6px 10px; font-size: 12px; color: var(--muted);
    cursor: pointer; transition: all .15s;
  }
  .chip:hover { border-color: #c7d2fe; color: var(--accent); background: var(--accent-soft); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip b { font-weight: 650; margin-left: 4px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(380px, .92fr); gap: 18px; align-items: start; }
  .layout > * { min-width: 0; }
  .panel {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
    min-width: 0;
  }
  .panel-head {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 18px; border-bottom: 1px solid var(--border); background: var(--surface-2);
  }
  .panel-head h2 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
  .hint { color: var(--faint); font-size: 12px; }
  .news-list { max-height: calc(100vh - 260px); overflow: auto; }
  .news-card {
    padding: 16px 18px; border-bottom: 1px solid var(--border); cursor: pointer;
    transition: background .15s; position: relative;
  }
  .news-card:last-child { border-bottom: 0; }
  .news-card:hover { background: #f8faff; }
  .news-card.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
  .news-top { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .dot.consumer { background: #10b981; }
  .dot.b2b { background: #f59e0b; }
  .dot.anta { background: #ef4444; }
  .news-title { font-size: 14px; font-weight: 650; line-height: 1.55; letter-spacing: -.01em; }
  .news-summary {
    margin-top: 7px; color: var(--muted); font-size: 12.5px; line-height: 1.65;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .news-meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 9px; color: var(--faint); font-size: 11.5px; }
  .mini-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
  .mini-tag {
    font-size: 11px; color: #3730a3; background: #eef2ff; border-radius: 6px;
    padding: 3px 6px; white-space: nowrap;
  }
  .detail-panel { position: sticky; top: 18px; }
  .detail-body { max-height: calc(100vh - 120px); overflow: auto; padding: 20px; overflow-wrap: anywhere; }
  .fulltext, .question-card, .summary-box, .q-text, .q-bg { overflow-wrap: anywhere; }
  .detail-title { margin: 0 0 10px; font-size: 20px; line-height: 1.35; letter-spacing: -.02em; }
  .detail-meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-bottom: 14px; }
  .detail-meta a { color: var(--accent-2); text-decoration: none; }
  .detail-meta a:hover { text-decoration: underline; }
  .summary-box {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px; color: #374151; font-size: 13.5px; line-height: 1.8; white-space: pre-wrap;
  }
  .status {
    display: inline-flex; align-items: center; border-radius: 6px;
    padding: 2px 6px; font-size: 10.5px; font-weight: 650;
  }
  .status.full { background: var(--green-soft); color: var(--green); }
  .status.partial { background: var(--orange-soft); color: var(--orange); }
  .status.error { background: var(--rose-soft); color: var(--rose); }
  .fulltext {
    max-height: 460px; overflow: auto; white-space: pre-wrap;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px; color: #374151; font-size: 12.5px; line-height: 1.85;
  }
  .question-card {
    border: 1px solid var(--border); border-radius: 14px; padding: 16px;
    margin-top: 12px; background: #fff;
  }
  .q-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
  .q-index { font-size: 10.5px; font-weight: 750; color: var(--accent); letter-spacing: .1em; }
  .q-type {
    font-size: 10.5px; color: var(--muted); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; white-space: nowrap;
  }
  .q-title { margin: 0 0 8px; font-size: 15px; line-height: 1.5; letter-spacing: -.01em; }
  .q-bg { margin: 0 0 10px; color: var(--muted); font-size: 12.5px; line-height: 1.75; }
  .q-label { margin: 10px 0 4px; font-size: 10.5px; font-weight: 750; color: var(--accent); letter-spacing: .08em; }
  .q-text { margin: 0; font-size: 12.5px; color: #374151; line-height: 1.75; }
  .q-dims { display: flex; flex-wrap: wrap; gap: 6px; }
  .q-dim {
    font-size: 11px; color: #374151; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px;
  }
  .q-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
  .q-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .question-card, .q-grid, .q-grid > * { min-width: 0; }
  .q-text, .q-bg, .q-dim, .mini-tag { overflow-wrap: anywhere; word-break: break-word; }
  @media (max-width: 700px) { .q-grid { grid-template-columns: 1fr; } }
  .section-title {
    display: flex; align-items: center; gap: 8px; margin: 22px 0 10px;
    font-size: 12px; font-weight: 750; color: var(--muted); letter-spacing: .08em; text-transform: uppercase;
  }
  .section-title::after { content: ""; height: 1px; flex: 1; background: var(--border); }
  .tag-row { display: flex; flex-wrap: wrap; gap: 7px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; border-radius: 8px;
    padding: 5px 8px; font-size: 11.5px; line-height: 1.2; border: 1px solid transparent;
  }
  .badge em { font-style: normal; opacity: .65; font-size: 10.5px; }
  .badge.kp { background: #eef2ff; color: #3730a3; border-color: #e0e7ff; }
  .badge.comp { background: var(--green-soft); color: var(--green); border-color: #d1fae5; }
  .badge.dec { background: var(--orange-soft); color: var(--orange); border-color: #ffedd5; }
  .badge.role-core { box-shadow: inset 0 0 0 1px rgba(79,70,229,.18); }
  .badge.role-example { border-style: dashed; }
  .badge.role-mention { opacity: .72; }
  .kp-card {
    border: 1px solid var(--border); border-radius: 12px; padding: 13px;
    margin-top: 10px; background: var(--surface-2);
  }
  .kp-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  .kp-name { font-size: 13.5px; font-weight: 700; }
  .kp-id { font-size: 10.5px; color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .kp-def { margin: 7px 0 0; color: #4b5563; font-size: 12.5px; line-height: 1.7; }
  .kp-meta { margin-top: 7px; color: var(--muted); font-size: 11.5px; line-height: 1.6; }
  .kp-ex { margin-top: 7px; font-size: 11.5px; color: var(--muted); line-height: 1.65; }
  .kp-ex b { color: #374151; font-weight: 650; }
  .empty { padding: 40px 20px; text-align: center; color: var(--faint); font-size: 13px; line-height: 1.7; }
  .footer { margin-top: 18px; color: var(--faint); font-size: 11.5px; text-align: center; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 999px; border: 3px solid var(--surface); }
  ::-webkit-scrollbar-track { background: transparent; }
  @media (max-width: 980px) {
    .hero { flex-direction: column; align-items: flex-start; }
    .layout { grid-template-columns: 1fr; }
    .detail-panel { position: static; }
    .news-list { max-height: 520px; }
    .detail-body { max-height: none; }
  }
</style>
</head>
<body>
<div class="app">
  <header class="hero">
    <div>
      <div class="eyebrow">Marketing News × Knowledge Points</div>
      <h1>营销新闻 × 知识点匹配台</h1>
      <p class="sub">用第 3–5 章的 84 个知识点，对照查看新闻的匹配结果与配套题目。左侧选新闻，右侧看命中知识点、原文与题目。</p>
    </div>
    <div class="stats">
      <div class="stat"><span id="stat-articles">0</span><small>新闻</small></div>
      <div class="stat"><span id="stat-tags">0</span><small>标签</small></div>
      <div class="stat"><span id="stat-questions">0</span><small>题目</small></div>
      <div class="stat"><span id="stat-kps">0</span><small>知识点</small></div>
    </div>
  </header>

  <section class="toolbar">
    <input id="search" class="search" type="search" placeholder="搜索标题、摘要、知识点…">
    <select id="query-filter">
      <option value="全部">全部来源</option>
      <option value="消费">消费类</option>
      <option value="B2B">B2B 类</option>
      <option value="安踏">安踏</option>
    </select>
    <select id="kp-filter">
      <option value="全部">全部知识点</option>
    </select>
    <button id="reset" type="button">清空筛选</button>
    <span id="result-count" class="result-count"></span>
  </section>

  <div id="kp-chips" class="chips"></div>

  <main class="layout">
    <section class="panel">
      <div class="panel-head">
        <h2>新闻</h2>
        <span class="hint">点击查看匹配</span>
      </div>
      <div id="news-list" class="news-list"></div>
    </section>

    <aside class="panel detail-panel">
      <div id="detail" class="detail-body"></div>
    </aside>
  </main>

  <div class="footer">数据：华尔街见闻搜索摘要 · 知识点：市场营销学（第5版）第3–5章 · 标签为规则预标，待人工复核</div>
</div>

<script id="news-data" type="application/json">__NEWS_JSON__</script>
<script id="kp-data" type="application/json">__KP_JSON__</script>
<script id="questions-data" type="application/json">__QUESTIONS_JSON__</script>
<script>
(() => {
  const newsPayload = JSON.parse(document.getElementById("news-data").textContent);
  const kps = JSON.parse(document.getElementById("kp-data").textContent);
  const questionsByArticle = JSON.parse(document.getElementById("questions-data").textContent);
  const articles = newsPayload.articles || [];
  const kpById = Object.fromEntries(kps.map(k => [k.kp_id, k]));
  const tagCount = articles.reduce((n, a) => n + (a.tags || []).length, 0);
  const questionCount = Object.values(questionsByArticle).reduce((n, qs) => n + qs.length, 0);
  const compNames = {
    comp_insight: "市场与消费者洞察",
    comp_strategy: "营销策略与组合",
    comp_brand: "品牌与定位",
    comp_data: "数据与效果",
    comp_communication: "创意与沟通",
    comp_ethics: "伦理与可持续",
  };

  const state = {
    search: "",
    query: "全部",
    kp: "全部",
    selected: articles[0] ? articles[0].article_id : null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  const kpTags = (a) => (a.tags || []).filter(t => t.tag_type === "knowledge_point");

  function kpCounts() {
    const counts = new Map();
    for (const a of articles) {
      for (const t of kpTags(a)) counts.set(t.tag_key, (counts.get(t.tag_key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function renderKpFilter() {
    const counts = kpCounts();
    const select = $("kp-filter");
    select.innerHTML = '<option value="全部">全部知识点</option>' + counts.map(([key, n]) => {
      const kp = kpById[key];
      const name = kp ? kp.name : key;
      return `<option value="${esc(key)}">${esc(name)} (${n})</option>`;
    }).join("");

    const chips = counts.slice(0, 10).map(([key, n]) => {
      const kp = kpById[key];
      const name = kp ? kp.name : key;
      return `<button class="chip" data-kp="${esc(key)}" type="button">${esc(name)}<b>${n}</b></button>`;
    }).join("");
    $("kp-chips").innerHTML = chips;
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    return articles.filter(a => {
      if (state.query !== "全部" && a.query !== state.query) return false;
      if (state.kp !== "全部" && !kpTags(a).some(t => t.tag_key === state.kp)) return false;
      if (!q) return true;
      const hay = [
        a.title, a.summary, a.content,
        ...(a.tags || []).map(t => t.tag_name),
        ...(a.tags || []).map(t => t.tag_key),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  }

  function renderList() {
    const rows = filtered();
    $("result-count").textContent = `${rows.length} / ${articles.length} 条`;
    if (!rows.length) {
      state.selected = null;
      $("news-list").innerHTML = '<div class="empty">没有匹配的新闻。<br>试试清空筛选或换一个关键词。</div>';
      return;
    }
    if (!rows.some(a => a.article_id === state.selected)) state.selected = rows[0].article_id;
    $("news-list").innerHTML = rows.map(a => {
      const kp = kpTags(a).slice(0, 3);
      const active = a.article_id === state.selected ? " active" : "";
      const dot = a.query === "B2B" ? "b2b" : a.query === "安踏" ? "anta" : "consumer";
      return `<article class="news-card${active}" data-id="${esc(a.article_id)}">
        <div class="news-top">
          <span class="dot ${dot}"></span>
          <span class="hint">${esc(a.query)}</span>
          <span class="hint">${esc(String(a.published_at).slice(0, 10))}</span>
        </div>
        <div class="news-title">${esc(a.title)}</div>
        <div class="news-summary">${esc(a.summary || "")}</div>
        <div class="mini-tags">${kp.map(t => `<span class="mini-tag">${esc(t.tag_name)}</span>`).join("")}</div>
        <div class="news-meta">
          <span>${esc(a.source || "")}</span>
          <span>${esc(a.author || "")}</span>
          ${a.is_paid ? "<span>付费内容</span>" : ""}
        </div>
      </article>`;
    }).join("");
  }

  function tagBadge(t) {
    const cls = t.tag_type === "knowledge_point" ? "kp" : t.tag_type === "competency" ? "comp" : "dec";
    const role = t.tag_role ? ` role-${t.tag_role}` : "";
    return `<span class="badge ${cls}${role}">${esc(t.tag_name || t.tag_key)} <em>${esc(t.tag_role || "")} · ${Number(t.confidence || 0).toFixed(2)}</em></span>`;
  }

  function kpCard(tag) {
    const kp = kpById[tag.tag_key];
    if (!kp) return "";
    const examples = (kp.examples || []).slice(0, 2).map(esc).join("；");
    const nonExamples = (kp.non_examples || []).slice(0, 2).map(esc).join("；");
    const comps = (kp.competencies || []).join(" / ");
    const decs = (kp.decisions || []).join(" / ");
    return `<div class="kp-card">
      <div class="kp-head">
        <span class="kp-name">${esc(kp.name)}</span>
        <span class="kp-id">${esc(kp.kp_id)}</span>
      </div>
      <p class="kp-def">${esc(kp.definition || "")}</p>
      <div class="kp-meta">能力：${esc(comps || "—")}${decs ? " · 决策：" + esc(decs) : ""}</div>
      ${examples ? `<div class="kp-ex"><b>正例</b> ${examples}</div>` : ""}
      ${nonExamples ? `<div class="kp-ex"><b>反例</b> ${nonExamples}</div>` : ""}
    </div>`;
  }

  function renderQuestion(q, index) {
    const kpNames = (q.kps || []).map(k => (kpById[k] ? kpById[k].name : k));
    const comps = (q.competencies || []).map(c => compNames[c] || c);
    return `<div class="question-card">
      <div class="q-head">
        <span class="q-index">题目 ${index + 1}</span>
        <span class="q-type">${esc(q.type || "案例分析")}</span>
      </div>
      <h3 class="q-title">${esc(q.title)}</h3>
      <p class="q-bg">${esc(q.background || "")}</p>
      <div class="q-label">作业要求</div>
      <p class="q-text">${esc(q.task || "")}</p>
      <div class="q-label">分析维度</div>
      <div class="q-dims">${(q.dimensions || []).map(d => `<span class="q-dim">${esc(d)}</span>`).join("")}</div>
      <div class="q-grid">
        <div><div class="q-label">交付物</div><p class="q-text">${esc(q.deliverable || "")}</p></div>
        <div><div class="q-label">评价重点</div><p class="q-text">${esc(q.evaluation || "")}</p></div>
      </div>
      <div class="q-tags">
        ${kpNames.map(n => `<span class="mini-tag">${esc(n)}</span>`).join("")}
        ${comps.map(n => `<span class="mini-tag" style="background:#ecfdf5;color:#047857">${esc(n)}</span>`).join("")}
      </div>
    </div>`;
  }

  function renderDetail() {
    const a = articles.find(x => x.article_id === state.selected);
    if (!a) {
      $("detail").innerHTML = '<div class="empty">左侧选择一条新闻，查看它命中的知识点。</div>';
      return;
    }
    const tags = a.tags || [];
    const kp = tags.filter(t => t.tag_type === "knowledge_point");
    const comp = tags.filter(t => t.tag_type === "competency");
    const dec = tags.filter(t => t.tag_type === "decision");
    const full = a.content_full || a.content || "";
    const status = a.content_status || "snippet";
    const statusLabel = status === "full" ? "全文" : status === "partial" ? "原文预览" : "摘要";
    const qs = questionsByArticle[a.article_id] || [];
    $("detail").innerHTML = `
      <h2 class="detail-title">${esc(a.title)}</h2>
      <div class="detail-meta">
        <span>${esc(String(a.published_at).replace("T", " ").slice(0, 16))}</span>
        <span>${esc(a.source || "")}</span>
        <span>${esc(a.query)}</span>
        <span class="status ${esc(status)}">${statusLabel}</span>
        <span>${Number(a.content_length || full.length || 0).toLocaleString()} 字</span>
        ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">原文 ↗</a>` : ""}
      </div>
      <div class="summary-box">${esc(a.summary || "（无摘要）")}</div>

      <div class="section-title">命中知识点</div>
      <div class="tag-row">${kp.length ? kp.map(tagBadge).join("") : '<span class="hint">无</span>'}</div>

      <div class="section-title">能力 / 决策</div>
      <div class="tag-row">${[...comp, ...dec].map(tagBadge).join("") || '<span class="hint">无</span>'}</div>

      <div class="section-title">原文全文</div>
      ${full ? `<div class="fulltext">${esc(full)}</div>` : '<div class="empty">未取到原文。</div>'}

      <div class="section-title">配套题目</div>
      ${qs.length ? qs.map(renderQuestion).join("") : '<div class="empty">这条新闻暂无配套题目。</div>'}

      <div class="section-title">知识点对照</div>
      ${kp.map(kpCard).join("") || '<div class="empty">没有可对照的知识点。</div>'}
    `;
  }

  function render() {
    renderList();
    renderDetail();
  }

  $("stat-articles").textContent = articles.length;
  $("stat-tags").textContent = tagCount;
  $("stat-questions").textContent = questionCount;
  $("stat-kps").textContent = kps.length;
  renderKpFilter();
  render();

  $("search").addEventListener("input", e => { state.search = e.target.value; render(); });
  $("query-filter").addEventListener("change", e => { state.query = e.target.value; render(); });
  $("kp-filter").addEventListener("change", e => { state.kp = e.target.value; render(); });
  $("reset").addEventListener("click", () => {
    state.search = "";
    state.query = "全部";
    state.kp = "全部";
    $("search").value = "";
    $("query-filter").value = "全部";
    $("kp-filter").value = "全部";
    document.querySelectorAll("#kp-chips .chip").forEach(el => el.classList.remove("active"));
    render();
  });
  $("news-list").addEventListener("click", e => {
    const card = e.target.closest(".news-card");
    if (!card) return;
    state.selected = card.dataset.id;
    render();
  });
  $("kp-chips").addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const key = chip.dataset.kp;
    state.kp = state.kp === key ? "全部" : key;
    $("kp-filter").value = state.kp;
    render();
    document.querySelectorAll("#kp-chips .chip").forEach(el => {
      el.classList.toggle("active", el.dataset.kp === state.kp);
    });
  });
})();
</script>
</body>
</html>
"""

html = HTML.replace("__NEWS_JSON__", NEWS_JSON).replace("__KP_JSON__", KP_JSON).replace("__QUESTIONS_JSON__", QUESTIONS_JSON)
OUT_PATH.write_text(html, encoding="utf-8")
print(f"written: {OUT_PATH}")
print(f"size: {OUT_PATH.stat().st_size / 1024:.1f} KB")
