/**
 * app.js  — 体験記チェッカー（一次チェック専用・単独版）
 * ---------------------------------------------------------
 * 画面操作・プロンプト組み立て・結果表示を担当する。
 *   ルール定義     : rules.js（変更はここだけ）
 *   決定的チェック : rule-engine.js
 *   AI通信         : gemini-client.js
 *
 * 設定（必要ならここだけ変更）
 * ---------------------------------------------------------
 */
const CONFIG = {
  // true: 「伏せ字にしました」にチェックを入れるまで、AIチェックを実行できない
  REQUIRE_MASK_CONFIRM: true,
  // タイトルの文字数目安（rules.js の titleRules.format と合わせる）
  TITLE_IDEAL: 20,
  TITLE_MAX: 30
};

(() => {
  "use strict";

  /* ============================================================
     小さなユーティリティ
     ============================================================ */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

  function setStatus(el, msg, busy) {
    el.textContent = msg || "";
    el.classList.toggle("busy", !!busy);
  }

  function safeStorage(op, key, value) {
    try {
      if (op === "get") return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (_) { /* 保存できない環境では何もしない */ }
    return null;
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (__) {}
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "コピーしました";
      setTimeout(() => { btn.textContent = old; }, 1400);
    }
  }

  /* ============================================================
     テーマ・タブ・設定
     ============================================================ */
  const root = document.documentElement;
  const savedTheme = safeStorage("get", "checker-theme");
  if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;

  $("#themeBtn").addEventListener("click", () => {
    const cur = root.dataset.theme ||
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    safeStorage("set", "checker-theme", next);
  });

  function showTab(name) {
    $$(".mode").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
    if (name === "all" && typeof renderCopyPanel === "function") renderCopyPanel();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $$(".mode").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  const getApiKey = () => $("#apiKey").value;
  const getModel  = () => $("#model").value;
  // 混み合っているとき、順に試す予備のモデル（選択肢のうち、選んでいないもの。proは除く）
  const getFallbacks = () => $$("#model option").map((o) => o.value).filter((v) => v && v !== getModel() && !/pro/i.test(v));
  // 再試行・モデル切り替え中の様子を、いま動いている処理の表示欄に出す
  let activeStatus = null;
  GeminiClient.onProgress = (msg) => { if (activeStatus) setStatus(activeStatus, msg, true); };

  /* ============================================================
     プロンプト
     ============================================================ */
  const bullets = (arr) => arr.map((s) => "・" + s).join("\n");

  const COMMON_NOTE =
`【システム側で別途処理するため、指摘不要のもの】
・数字の全角／半角の統一（1桁は全角・2桁以上は半角）。数字の幅は、あなたは判断しない
・句読点の種類（「、」と「，」など）
・NG講師名の検出
・コンテンツ名・用語の表記統一（辞書にあるもの）
これら以外の、文脈の判断が必要なミスだけを指摘してください。`;

  const OUTPUT_NOTE =
`【出力のきまり】
・JSONのみを返す。形式は {"issues":[{category, original, suggested, reason, index, question, actionOnPublish}]}
・original は、対象の文章の中にある文字列を一字一句そのまま写す（言い換えない）
・suggested は修正案。削除すべきものは空文字にする
・reason は、なぜ直すのかを1〜2文で
・actionOnPublish は、掲載前に「削除」が必要なものだけ true
・迷う場合は、削除対象として指摘し、reason に迷った点を書く（ただし、講座名・コンテンツ名の疑いは下の決まりに従う）
・講座名・コンテンツ名が正式名称でない可能性がある場合は、削除を提案しない。category を必ず「講座名の確認」にし、suggested には、確実に分かる正式名称がある場合だけ書く（推測では書かない。分からなければ空文字）。reason に、なぜ疑ったかを書く
・指摘がなければ issues は空配列
・創作や、元の文章にない内容の追加はしない
・original は、本文の文字を、全角・半角も含めて一字一句そのまま写す（直して写さない）
・suggested には、本文に入れる文字列だけを書く。HTMLタグ（<br>など）、注釈、括弧書きの説明は入れず、説明は reason に書く
・修正前と同じ内容（全角・半角、句読点の見た目だけの違い）の指摘は出さない
・短い語句の指摘に対して、長い文章を新しく書き足す案は出さない`;

  /** 文章の語尾（です・ます／だ・である）をシステムが数えた結果を、AIに伝える */
  function styleNote(text) {
    const st = RuleEngine.docStyle(text);
    const nm = (k) => (k === "desu" ? "です・ます" : "だ・である");
    return `【語尾の集計（システムが数えた結果）】
です・ます調 ${st.desu}文／だ・である調 ${st.da}文
${st.major ? `→ この文章は「${nm(st.major)}調」が多数派。語尾の指摘は、少数派の文だけにし、修正案は「${nm(st.major)}調」に合わせる。` : ""}
全体がほぼ統一されている場合は、語尾の指摘をしない。「他の部分で混在している可能性」のような推測では指摘しない。`;
  }

  const AMBIGUOUS_NOTE =
`【文脈で判断するコンテンツ名（講座名として書かれているときだけ指摘する。一般的な意味で使われているだけなら指摘しない）】
${LITERAL_RULES.ambiguousContentNames.map(([w, c, n]) => `・「${w}」→「${c}」（${n}）`).join("\n")}`;

  // ※ このブロックは、関数の外（ここ）に置く。buildSurveyPrompt の中に入れると文法エラーになる
  const DIFFICULTY_NOTE =
`【最優先のチェック：模試の難しさの書き方】
「東進の模試は共通テスト本番より難しい（難度・難易度・レベルが高い）」という趣旨の文は、誤字（例：「何度が高い」→「難度が高い」）を直すだけで済ませない。
・この趣旨の文は、誤字の指摘より、この指摘を優先する（同じ箇所を2つ指摘しない）
・category は「模試の難しさ」にする
・suggested は、次のどちらかにする。
　（A）その部分を削除する（空文字）
　（B）「本番と同じレベルの東進の模試を受けるのがおすすめです」のように、「本番と同レベル」に書き換えた文（元の文の他の内容は変えない）
・reason に、「東進の模試が本番より難しいと書くのは掲載しない決まりのため、削除か、本番と同レベルへの書き換えが必要」と書く
・迷う場合は（A）より（B）を優先する（文章の意味が残るため）
・actionOnPublish は、（A）のときだけ true`;

  function buildSurveyPrompt(items) {
    const list = items
      .map((it) => `[${it.index}] 質問：${it.question}\n回答：${it.answer || "（空欄）"}`)
      .join("\n\n");
    return `あなたは、大学受験予備校の「合格体験記」の一次チェック担当です。
下の「アンケート回答」を、ルールに沿って確認し、直すべき箇所だけを指摘してください。

【削除対象（掲載前に削除を検討するもの）】
${bullets(RULES.deleteItems)}

【文体・表記のルール】
${bullets(RULES.styleRules)}

【アンケート特有のルール】
${bullets(RULES.surveyRules)}

${COMMON_NOTE}

${AMBIGUOUS_NOTE}

${DIFFICULTY_NOTE}

${styleNote(items.map((it) => it.answer).join("\n"))}

${OUTPUT_NOTE}
・index は、指摘した項目の番号（[ ] の中の数字）。question は、その項目の質問文

【アンケート回答】
${list}`;
  }

  function buildProofPrompt(text) {
    return `あなたは、大学受験予備校の「合格体験記」の一次チェック担当です。
下の「本文」を、ルールに沿って確認し、直すべき箇所だけを指摘してください。

【削除対象（掲載前に削除を検討するもの）】
${bullets(RULES.deleteItems)}

【文体・表記のルール】
${bullets(RULES.styleRules)}

${COMMON_NOTE}

${AMBIGUOUS_NOTE}

${DIFFICULTY_NOTE}

${styleNote(text)}

${OUTPUT_NOTE}
・index と question は、使わない（省略してよい）

【本文】
${text}`;
  }

  function buildTitlePrompt(text) {
    return `あなたは、大学受験予備校の「合格体験記」のタイトルを付ける担当です。
下の「本文」から、タイトル案を5つ出してください。

【優先順位（上ほど優先）】
${RULES.titleRules.priority.map((s, i) => `${i + 1}. ${s}`).join("\n")}

【形式】
${RULES.titleRules.format}

【出力のきまり】
・JSONのみを返す。形式は {"titles":[{text, basis, priorityMatched}]}
・text は、タイトル案そのもの。必ず20字以内にする（どうしても収まらない場合のみ最大30字）。出力する前に、自分で文字数を数えて確認すること
・20字以内の案を、5案のうち4案以上にする。30字を超える案は、1つも出力しない
・basis は、本文のどの部分から抜き出したか（本文の該当箇所を短く）
・priorityMatched は、上の優先順位のどれに当たるか
・同じ観点に偏らず、バランスよく選ぶ

【本文】
${text}`;
  }

  /* ============================================================
     アンケートの分割
     ============================================================ */
  function parseSurvey(raw) {
    const lines = String(raw || "").replace(/\r/g, "").split("\n").map((l) => l.trim());
    // 先頭の見出し「アンケート結果」は、項目ではないので捨てる
    const firstIdx = lines.findIndex((l) => l !== "");
    if (firstIdx !== -1 && lines[firstIdx] === "アンケート結果") lines.splice(firstIdx, 1);

    const items = [];
    let buf = [];
    const flush = () => {
      const l = buf.filter((x) => x !== "");
      buf = [];
      if (!l.length) return;
      items.push({ index: items.length + 1, question: l[0], answer: l.slice(1).join("\n") });
    };
    for (const line of lines) {
      if (line === "掲載する") { flush(); continue; }
      buf.push(line);
    }
    flush();
    return items;
  }

  /* ============================================================
     結果の描画
     ============================================================ */
  const SRC = {
    "rule-engine": { cls: "engine", label: "ルールエンジン（確実）" },
    "ai":          { cls: "ai",     label: "AI判断" }
  };

  /** 判断（採用／不採用／要相談／未判断）を設定して、集計と「修正後の本文」を更新する */
  function setJudge(el, j) {
    $$(".judge button", el).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.j === j)));
    el.classList.remove("is-adopt", "is-reject", "is-ask");
    el.dataset.judge = j || "";
    if (j) el.classList.add("is-" + j);
    const c = el.closest(".results");
    updateTally(c);
    if (c) c.dispatchEvent(new CustomEvent("judgechange"));
  }

  function makeIssueCard(issue) {
    const src = SRC[issue.source] || SRC.ai;
    const hasFix = typeof issue.suggested === "string" && issue.suggested.trim() !== "";
    const isCheck = issue.category === "講座名の確認";          // 削除ではなく「正式名称を調べる」指摘
    const el = document.createElement("article");
    el.className = "issue src-" + (issue.source || "ai") + (isCheck && !hasFix ? " no-adopt" : "");
    el.dataset.original = issue.original || "";
    el.dataset.suggested = hasFix ? issue.suggested : "";

    el.innerHTML =
      `<div class="tags">
         <span class="tag cat">${esc(issue.category || "指摘")}</span>
         <span class="tag ${src.cls}">${src.label}</span>
         ${isCheck ? '<span class="tag del">要確認</span>' : (issue.actionOnPublish || !hasFix ? '<span class="tag del">削除を検討</span>' : "")}
       </div>
       <div class="diff">
         <span class="orig">${esc(issue.original)}</span>
         <span class="arrow">→</span>
         ${isCheck
            ? (hasFix ? `<span class="fix">候補：${esc(issue.suggested)}</span>` : '<span class="none">正式名称を調べてください</span>')
            : (hasFix ? `<span class="fix">${esc(issue.suggested)}</span>` : '<span class="none">（削除）</span>')}
       </div>
       ${issue.reason ? `<p class="reason">${esc(issue.reason)}</p>` : ""}
       ${isCheck ? `<p class="reason chk-note">${hasFix ? "AIが示した名称は推測の可能性があります。" : ""}東進の公式ページで、正式な講座名を確認してください。
           <a class="chk-link" href="https://www.google.com/search?q=${encodeURIComponent("site:toshin.com " + (issue.original || ""))}" target="_blank" rel="noopener noreferrer">東進のサイト内で検索 ＞</a>
           ${typeof COURSE_LIST_URL === "string" && COURSE_LIST_URL ? `<a class="chk-link" href="${esc(COURSE_LIST_URL)}" target="_blank" rel="noopener noreferrer">講座一覧を開く ＞</a>` : ""}</p>` : ""}
       <div class="judge" role="group" aria-label="判断">
         <button type="button" data-j="adopt"  aria-pressed="false">採用</button>
         <button type="button" data-j="reject" aria-pressed="false">不採用</button>
         <button type="button" data-j="ask"    aria-pressed="false">要相談</button>
         <span class="applied">✔ 修正後の本文に反映しました</span>
       </div>`;

    $$(".judge button", el).forEach((btn) => {
      btn.addEventListener("click", () => {
        const already = btn.getAttribute("aria-pressed") === "true";
        setJudge(el, already ? "" : btn.dataset.j);
      });
    });
    return el;
  }

  function updateTally(container) {
    if (!container) return;
    const cards = $$(".issue", container);
    const count = (j) => cards.filter((c) => c.dataset.judge === j).length;
    const t = $(".tally", container);
    if (t) {
      t.innerHTML =
        `<span class="t-adopt">採用 ${count("adopt")}</span>` +
        `<span class="t-reject">不採用 ${count("reject")}</span>` +
        `<span class="t-ask">要相談 ${count("ask")}</span>` +
        `<span>未判断 ${cards.length - count("adopt") - count("reject") - count("ask")}</span>`;
    }
  }

  function renderSummary(container, total, kinds) {
    const sum = document.createElement("div");
    sum.className = "summary";
    sum.innerHTML =
      `<div class="big">${total}<small>件の指摘</small></div>
       <div class="hint" style="margin:0">${esc(kinds)}</div>
       <div class="tally"></div>`;
    container.appendChild(sum);

    const bar = document.createElement("div");
    bar.className = "copybar";
    bar.innerHTML =
      `<button type="button" class="ghost accent" data-bulk="adoptAll">すべて採用</button>
       <button type="button" class="ghost" data-bulk="rejectRest">未判断を不採用に</button>
       <button type="button" class="ghost" data-bulk="undo">元に戻す</button>`;
    container.appendChild(bar);
    $$("button[data-bulk]", bar).forEach((b) => b.addEventListener("click", () => {
      $$(".issue", container).forEach((c) => {
        const j = c.dataset.judge || "";
        if (b.dataset.bulk === "adoptAll") { if (!c.classList.contains("no-adopt")) setJudge(c, "adopt"); }
        else if (b.dataset.bulk === "rejectRest") { if (!j) setJudge(c, "reject"); }
        else setJudge(c, "");
      });
    }));
  }

  function renderError(container, err) {
    container.innerHTML = `<div class="raw-error">${esc(err && err.message ? err.message : String(err))}</div>`;
  }

  function renderLoading(container) {
    container.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  }

  /* ---------- 本文のハイライト ---------- */
  function renderHighlighted(text, issues) {
    const ranges = [];
    issues.forEach((is) => {
      const o = is.original;
      if (!o || typeof o !== "string") return;
      RuleEngine.findOccurrences(text, o).forEach(({ s, e }) => ranges.push({ s, e, src: is.source }));
    });
    ranges.sort((a, b) => a.s - b.s || b.e - a.e);
    const kept = [];
    let last = -1;
    ranges.forEach((r) => { if (r.s >= last) { kept.push(r); last = r.e; } });

    let html = "", cur = 0;
    kept.forEach((r) => {
      html += esc(text.slice(cur, r.s));
      html += `<mark class="${r.src === "rule-engine" ? "m-engine" : ""}">${esc(text.slice(r.s, r.e))}</mark>`;
      cur = r.e;
    });
    html += esc(text.slice(cur));
    return html;
  }

  /* ============================================================
     ① アンケート
     ============================================================ */
  let surveyItems = [];

  function renderParsePreview() {
    const box = $("#surveyParsePreview");
    if (!surveyItems.length) { box.innerHTML = ""; return; }
    const blanks = surveyItems.filter((i) => !i.answer).length;
    box.innerHTML =
      `<div class="parsed-wrap">
         <p class="parse-count"><b>${surveyItems.length}</b> 項目に分割しました${blanks ? `（うち回答が空欄：${blanks}件）` : ""}</p>
         <div class="table-box">
           <table class="parsed">
             <thead><tr><th>No.</th><th>質問</th><th>回答</th></tr></thead>
             <tbody>
               ${surveyItems.map((i) =>
                 `<tr><td class="no">${i.index}</td><td class="q">${esc(i.question)}</td>` +
                 (i.answer ? `<td>${esc(i.answer).replace(/\n/g, "<br>")}</td>` : '<td class="blank">（空欄）</td>') +
                 `</tr>`).join("")}
             </tbody>
           </table>
         </div>
       </div>`;
  }

  function updateSurveyButtons() {
    const has = surveyItems.length > 0;
    $("#surveyRuleBtn").disabled = !has;
    $("#surveyRunBtn").disabled = !has;
  }

  $("#parseBtn").addEventListener("click", () => {
    surveyItems = parseSurvey($("#surveyInput").value);
    renderParsePreview();
    updateSurveyButtons();
    setStatus($("#surveyStatus"), surveyItems.length ? "" : "項目が見つかりませんでした。貼り付け内容を確認してください。");
  });

  $("#surveyInput").addEventListener("input", () => { surveyItems = []; renderParsePreview(); updateSurveyButtons(); });

  function renderSurveyResults(ruleByIndex, aiByIndex, usedAi) {
    const out = $("#surveyResults");
    out.innerHTML = "";

    // 項目ごとに、ルールエンジン指摘とAI指摘を統合する
    const groups = [];
    surveyItems.forEach((it) => {
      const rule = (ruleByIndex[it.index] || []);
      const ai = (aiByIndex[it.index] || []);
      const merged = RuleEngine.mergeIssues(rule, ai);
      if (merged.length) groups.push({ it, merged });
    });
    // どの項目にも当てはまらないAI指摘（index不明）
    const orphans = (aiByIndex[0] || []);

    const total = groups.reduce((n, g) => n + g.merged.length, 0) + orphans.length;
    if (!total) {
      out.innerHTML = `<div class="empty-ok">指摘はありませんでした。${usedAi ? "" : "（ルールのみのチェックです）"}</div>`;
      return;
    }
    renderSummary(out, total, usedAi ? "ルールエンジン＋AI判断" : "ルールのみ（送信なし）");

    groups.forEach(({ it, merged }) => {
      const g = document.createElement("section");
      g.className = "group";
      g.innerHTML = `<div class="group-head"><span class="gno">No.${it.index}</span><span class="gq">${esc(it.question)}</span></div>`;
      merged.forEach((is) => g.appendChild(makeIssueCard(is)));
      out.appendChild(g);
    });
    if (orphans.length) {
      const g = document.createElement("section");
      g.className = "group";
      g.innerHTML = '<div class="group-head"><span class="gq">項目を特定できなかった指摘</span></div>';
      orphans.forEach((is) => g.appendChild(makeIssueCard(is)));
      out.appendChild(g);
    }
    updateTally(out);
  }

  function surveyRuleChecks() {
    const byIndex = {};
    surveyItems.forEach((it) => {
      const hits = RuleEngine.runDeterministicChecks(it.answer).map((h) => ({
        ...h, index: it.index, question: it.question
      }));
      if (hits.length) byIndex[it.index] = hits;
    });
    return byIndex;
  }

  $("#surveyRuleBtn").addEventListener("click", () => {
    renderSurveyResults(surveyRuleChecks(), {}, false);
    setStatus($("#surveyStatus"), "ルールのみでチェックしました（送信なし）");
    track("アンケート（ルールのみ）");
  });

  async function runSurveyAI() {
    const btn = $("#surveyRunBtn"), status = $("#surveyStatus"), out = $("#surveyResults");
    btn.disabled = true;
    activeStatus = status;
    setStatus(status, "AIが読んでいます", true);
    renderLoading(out);
    try {
      const raw = await GeminiClient.call(getApiKey(), getModel(), buildSurveyPrompt(surveyItems), "issues", getFallbacks());
      const allAnswers = surveyItems.map((i) => i.answer).join("\n");
      const aiIssues = RuleEngine.dropWrongContextIssues(RuleEngine.dropWrongStyleIssues(RuleEngine.cleanAiIssues(
        RuleEngine.enforceOnAiIssues(RuleEngine.validateIssuesShape(raw)),
        (is) => { const it = surveyItems.find((i) => i.index === is.index);
                  return it ? it.answer : allAnswers; }), allAnswers), allAnswers);
      const aiByIndex = {};
      aiIssues.forEach((is) => {
        const idx = surveyItems.some((i) => i.index === is.index) ? is.index : 0;
        (aiByIndex[idx] = aiByIndex[idx] || []).push(is);
      });
      renderSurveyResults(surveyRuleChecks(), aiByIndex, true);
      setStatus(status, "完了しました");
      track("アンケート");
    } catch (e) {
      renderError(out, e);
      setStatus(status, "エラーが発生しました");
      trackError("アンケート", e);   // 本文校正／タイトル案では、それぞれの名前に
      return false;
    } finally {
      updateSurveyButtons();
    }
    return true;
  }
  $("#surveyRunBtn").addEventListener("click", runSurveyAI);

  async function trackError(action, e) {
    const msg = String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 150);
    await UsageLogger.log("エラー：" + action, 1, msg);
  }

  /* ============================================================
     ② 本文校正
     ============================================================ */
  const inputText = $("#inputText");
  // 文字数は自動カウントのみ（上限の判定はしない）
  function countInfo(t) {
    const total = Array.from(t).length;
    const noSpace = Array.from(t.replace(/\s/g, "")).length;
    const paras = t.split(/\n+/).filter((x) => x.trim() !== "").length;
    return { total, noSpace, paras };
  }
  function updateCount() {
    const c = countInfo(inputText.value);
    $("#charCount").innerHTML =
      `<span class="big">${c.total.toLocaleString("ja-JP")}<small>文字</small></span>` +
      `<span class="sub">空白・改行を除く${c.noSpace.toLocaleString("ja-JP")}文字／${c.paras}段落</span>`;
  }
  inputText.addEventListener("input", updateCount);

  let fixedText = "";
  let proofSourceText = "";
  function renderProofResults(text, issues, usedAi) {
    proofSourceText = text;
    const out = $("#results");
    out.innerHTML = "";

    const preview = document.createElement("div");
    preview.innerHTML =
      `<div class="preview-ttl">プレビュー</div>
       <div class="preview-box">${renderHighlighted(text, issues)}</div>`;
    out.appendChild(preview);

    if (!issues.length) {
      out.insertAdjacentHTML("beforeend",
        `<div class="empty-ok">指摘はありませんでした。${usedAi ? "" : "（ルールのみのチェックです）"}</div>`);
      return;
    }
    renderSummary(out, issues.length, usedAi ? "ルールエンジン＋AI判断" : "ルールのみ（送信なし）");
    issues.forEach((is) => out.appendChild(makeIssueCard(is)));
    updateTally(out);

    // 「修正後の本文」：採用した指摘をその場で反映して表示する
    const fixed = document.createElement("div");
    fixed.className = "fixed-panel";
    fixed.innerHTML =
      `<div class="fixed-head"><b>修正後の本文</b><span class="hint" style="margin:0">採用した指摘が反映されます</span><span class="sp"></span>
         <button type="button" class="ghost" id="copyFixedBtn">本文をコピー</button></div>
       <div class="fixed-body" id="fixedBody"></div>`;
    out.appendChild(fixed);
    const refresh = () => {
      const adopted = $$(".issue", out).filter((c) => c.dataset.judge === "adopt" && !c.classList.contains("no-adopt"));
      const r = buildFixed(text, adopted.map((c) => ({ original: c.dataset.original, suggested: c.dataset.suggested })));
      $("#fixedBody", out).innerHTML = r.html.replace(/\n/g, "<br>");
      fixedText = r.text;
    };
    out.addEventListener("judgechange", refresh);
    $("#copyFixedBtn", out).addEventListener("click", (e) => copyText(fixedText, e.currentTarget));
    fixedText = text;
    refresh();
  }

  /** 採用された指摘を本文に反映した結果（表示用HTMLと、コピー用テキスト）を作る */
  function buildFixed(text, adopted) {
    const ranges = [];
    adopted.forEach((a) => {
      if (!a.original) return;
      // 同じ語は、本文中のすべての箇所を直す（数字は、ひとまとまりの数として一致する箇所だけ）
      RuleEngine.findOccurrences(text, a.original).forEach(({ s, e }) => ranges.push({ s, e, to: a.suggested || "" }));
    });
    ranges.sort((x, y) => x.s - y.s);
    let html = "", out = "", cur = 0;
    ranges.forEach((r) => {
      if (r.s < cur) return;                   // 重なる指摘は先のものを優先
      html += esc(text.slice(cur, r.s)) + `<del>${esc(text.slice(r.s, r.e))}</del>` + (r.to ? `<ins>${esc(r.to)}</ins>` : "");
      out += text.slice(cur, r.s) + r.to;
      cur = r.e;
    });
    html += esc(text.slice(cur)); out += text.slice(cur);
    return { html, text: out };
  }

  $("#textRuleBtn").addEventListener("click", () => {
    const text = inputText.value;
    if (!text.trim()) { setStatus($("#statusText"), "本文を貼り付けてください"); return; }
    renderProofResults(text, RuleEngine.runDeterministicChecks(text), false);
    setStatus($("#statusText"), "ルールのみでチェックしました（送信なし）");
    track("本文校正（ルールのみ）");
  });

  function updateTextButtons() {
    $("#runBtn").disabled = false;
  }

  async function runProofAI() {
    const text = inputText.value;
    const status = $("#statusText"), out = $("#results"), btn = $("#runBtn");
    if (!text.trim()) { setStatus(status, "本文を貼り付けてください"); return; }
    btn.disabled = true;
    activeStatus = status;
    setStatus(status, "AIが読んでいます", true);
    renderLoading(out);
    try {
      const raw = await GeminiClient.call(getApiKey(), getModel(), buildProofPrompt(text), "issues", getFallbacks());
      const ai = RuleEngine.dropWrongContextIssues(RuleEngine.dropWrongStyleIssues(RuleEngine.cleanAiIssues(
        RuleEngine.enforceOnAiIssues(RuleEngine.validateIssuesShape(raw)), () => text), text), text);
      const merged = RuleEngine.mergeIssues(RuleEngine.runDeterministicChecks(text), ai);
      renderProofResults(text, merged, true);
      setStatus(status, "完了しました");
      track("本文校正");
    } catch (e) {
      renderError(out, e);
      setStatus(status, "エラーが発生しました");
      trackError("本文校正", e);   // 本文校正／タイトル案では、それぞれの名前に
      return false;
    } finally {
      updateTextButtons();
    }
    return true;
  }
  $("#runBtn").addEventListener("click", runProofAI);

  /* ============================================================
     ③ タイトル案
     ============================================================ */
  const titleInput = $("#titleInput");
  titleInput.addEventListener("input", () => {
    $("#titleCount").textContent = titleInput.value.length.toLocaleString("ja-JP") + "文字";
  });
  function updateTitleButtons() {
    $("#titleRunBtn").disabled = false;
  }

  function renderTitles(titles) {
    const out = $("#titleResults");
    out.innerHTML = "";
    if (!titles.length) {
      out.innerHTML = '<div class="placeholder">タイトル案が返ってきませんでした。もう一度お試しください。</div>';
      return;
    }
    out.insertAdjacentHTML("beforeend",
      `<div class="note-box">タイトルは<b>本人の文章から抜き出す</b>のが決まりです。AIの案が創作になっていないか、本文と見比べて確認してください。</div>`);
    titles.forEach((t, i) => {
      const text = RuleEngine.enforceOnText(t.text || "");
      const n = Array.from(text).length;
      const lenCls = n > CONFIG.TITLE_MAX ? "long" : n > CONFIG.TITLE_IDEAL ? "over" : "";
      const lenTxt = n > CONFIG.TITLE_MAX ? `${n}字（長すぎ）` : n > CONFIG.TITLE_IDEAL ? `${n}字（文字数多め）` : `${n}字`;
      const card = document.createElement("article");
      card.className = "title-card";
      card.innerHTML =
        `<div class="rank">${String(i + 1).padStart(2, "0")}</div>
         <div class="tt">${esc(text)}</div>
         <div class="len ${lenCls}">${lenTxt}</div>
         <div class="meta">
           ${t.priorityMatched ? `<div>優先順位：<b>${esc(t.priorityMatched)}</b></div>` : ""}
           ${t.basis ? `<div>根拠：<b>${esc(t.basis)}</b></div>` : ""}
         </div>
         <div class="acts"><button type="button" class="ghost">タイトルをコピー</button></div>`;
      $(".ghost", card).addEventListener("click", (e) => { chosenTitle = text; copyText(text, e.currentTarget); });
      out.appendChild(card);
    });
  }

  async function runTitleAI() {
    const text = titleInput.value;
    const status = $("#titleStatus"), out = $("#titleResults"), btn = $("#titleRunBtn");
    if (!text.trim()) { setStatus(status, "本文を貼り付けてください"); return; }
    btn.disabled = true;
    activeStatus = status;
    setStatus(status, "AIが読んでいます", true);
    renderLoading(out);
    try {
      const pick = (raw) => Array.isArray(raw && raw.titles) ? raw.titles.filter((t) => t && t.text) : [];
      const len = (t) => Array.from(RuleEngine.enforceOnText(t.text || "")).length;

      let titles = pick(await GeminiClient.call(getApiKey(), getModel(), buildTitlePrompt(text), "titles", getFallbacks()));

      // 30字を超える案が混ざっている、または20字以内の案が3つ未満なら、1回だけやり直す
      if (titles.some((t) => len(t) > CONFIG.TITLE_MAX) ||
          titles.filter((t) => len(t) <= CONFIG.TITLE_IDEAL).length < 3) {
        const retryPrompt = buildTitlePrompt(text) +
          `\n\n【やり直し】前回の案は長すぎました。次の案は使わず、すべて${CONFIG.TITLE_IDEAL}字以内（どうしても収まらない場合のみ最大${CONFIG.TITLE_MAX}字）で作り直してください。\n` +
          titles.map((t) => `・${t.text}（${len(t)}字）`).join("\n");
        const retry = pick(await GeminiClient.call(getApiKey(), getModel(), retryPrompt, "titles", getFallbacks()));
        if (retry.length) titles = retry;
      }
      // 最終的に、上限を超える案は表示しない。短い案を上に並べる
      titles = titles.filter((t) => len(t) <= CONFIG.TITLE_MAX).sort((a, b) => len(a) - len(b));
      renderTitles(titles);
      setStatus(status, "完了しました");
      track("タイトル案");
    } catch (e) {
      renderError(out, e);
      setStatus(status, "エラーが発生しました");
      trackError("タイトル案", e);   // 本文校正／タイトル案では、それぞれの名前に
      return false;
    } finally {
      updateTitleButtons();
    }
    return true;
  }
  $("#titleRunBtn").addEventListener("click", runTitleAI);

  /* ============================================================
     利用の記録（名前・日時・機能・件数だけ。本文は送らない）
     ============================================================ */
  let suppressLog = false;
  let chosenTitle = "";
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<i>✓</i><div>${esc(msg)}</div>`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  async function track(action, count = 1) {
    if (suppressLog) return;
    if (await UsageLogger.log(action, count)) toast("利用を記録しました");
  }
  const userName = $("#userName");
  userName.value = UsageLogger.getName();
  userName.addEventListener("input", () => UsageLogger.setName(userName.value));

  /* ============================================================
     ⓪ まるごと貼り付け
     ============================================================ */
  const HEADS = [
    { key: "survey", re: /^(アンケート結果|アンケート)$/ },
    { key: "text",   re: /^(本文|体験記本文|体験記)$/ },
    { key: "title",  re: /^(タイトル案|タイトル)$/ }
  ];
  /** 見出し行を目印に、アンケート／本文／タイトル案へ分ける（見出しが無い部分は捨てない） */
  function splitAll(raw) {
    const lines = String(raw || "").replace(/\r/g, "").split("\n");
    const out = { survey: null, text: null, title: null };
    let cur = null, buf = [];
    const flush = () => { if (cur && out[cur] === null) out[cur] = buf.join("\n").trim(); buf = []; };
    for (const line of lines) {
      const h = HEADS.find((x) => x.re.test(line.trim()));
      if (h) { flush(); cur = h.key; continue; }
      if (cur) buf.push(line);
    }
    flush();
    return out;
  }

  let allParts = { survey: null, text: null, title: null };

  function renderDetect() {
    const box = $("#allDetect");
    if (!$("#allInput").value.trim()) { box.innerHTML = ""; return; }
    const row = (ok, name, ct, hint) =>
      `<div class="detect-row ${ok ? "" : "warn"}"><span class="ok">${ok ? "✓" : "!"}</span><span class="nm">${name}</span><span class="ct">${ct}${hint ? `<br><small>${hint}</small>` : ""}</span></div>`;
    const sv = allParts.survey, tx = allParts.text, tt = allParts.title;
    let h = "";
    if (sv) {
      const items = parseSurvey(sv); const blanks = items.filter((i) => !i.answer).length;
      h += row(items.length > 0, "アンケート結果", `<b>${items.length}</b>項目（空欄${blanks}件）`);
    } else h += row(false, "アンケート結果", "見つかりません", "見出し「アンケート結果」の行が必要です");
    if (tx) h += row(true, "本文", `<b>${countInfo(tx).total.toLocaleString("ja-JP")}</b>文字`);
    else h += row(false, "本文", "見つかりません", "見出し「本文」の行が必要です");
    h += tt
      ? row(true, "タイトル案", "見つかりました")
      : row(true, "タイトル案", "AIが本文から作成します");
    box.innerHTML = h;
  }

  function applyAllParts() {
    allParts = splitAll($("#allInput").value);
    // 各タブの入力欄に振り分ける
    $("#surveyInput").value = allParts.survey || "";
    surveyItems = allParts.survey ? parseSurvey(allParts.survey) : [];
    renderParsePreview(); updateSurveyButtons();
    inputText.value = allParts.text || "";
    updateCount();
    titleInput.value = allParts.text || "";
    titleInput.dispatchEvent(new Event("input"));
    chosenTitle = allParts.title ? allParts.title.split("\n").map((x) => x.trim()).find(Boolean) || "" : "";
    renderDetect();
    updateAllButtons();
  }
  function updateAllButtons() {
    const has = !!(allParts.survey || allParts.text);
    $("#allRuleBtn").disabled = !has;
    $("#allRunBtn").disabled = !has;
  }
  $("#allInput").addEventListener("input", applyAllParts);

  const countIssues = (sel) => $$(".issue", $(sel)).length;

  function renderAllSummary(usedAi) {
    const out = $("#allResults");
    out.innerHTML =
      `<div class="all-links">
         <button type="button" class="ghost" data-go="survey">アンケートの結果を見る（${countIssues("#surveyResults")}件）</button>
         <button type="button" class="ghost" data-go="text">本文の結果を見る（${countIssues("#results")}件）</button>
         ${usedAi ? '<button type="button" class="ghost" data-go="title">タイトル案を見る</button>' : ""}
       </div>
       <div class="card" id="copyPanel"></div>`;
    $$("[data-go]", out).forEach((b) => b.addEventListener("click", () => showTab(b.dataset.go)));
    renderCopyPanel();
  }

  /** 管理画面へ入力するための、項目別コピー欄 */
  function renderCopyPanel() {
    const panel = $("#copyPanel");
    if (!panel) return;
    const rows = [];
    surveyItems.forEach((it) => { if (it.answer) rows.push({ lbl: it.question, val: it.answer }); });
    const body = fixedText || inputText.value;
    if (body.trim()) rows.push({ lbl: fixedText ? "本文（修正後）" : "本文", val: body });
    if (chosenTitle) rows.push({ lbl: "タイトル", val: chosenTitle });
    panel.innerHTML = `<div class="card-ttl">管理画面へ入力（コピー）</div><div class="copylist">${
      rows.map((r, i) =>
        `<div class="row"><span class="lbl">${esc(r.lbl)}</span><span class="val">${esc(r.val.replace(/\s+/g, " "))}</span><button type="button" class="ghost" data-i="${i}">コピー</button></div>`
      ).join("") || '<div class="placeholder">コピーできる項目がありません。</div>'}</div>`;
    $$("button[data-i]", panel).forEach((b) => b.addEventListener("click", async () => {
      await copyText(rows[Number(b.dataset.i)].val, null);
      b.textContent = "コピー済み"; b.classList.add("done");
    }));
  }

  async function runAll(useAi) {
    const status = $("#allStatus"), runBtn = $("#allRunBtn"), ruleBtn = $("#allRuleBtn");
    runBtn.disabled = ruleBtn.disabled = true;
    suppressLog = true;
    try {
      if (useAi) {
        setStatus(status, "アンケートを確認しています", true);
        if (surveyItems.length) await runSurveyAI();
        setStatus(status, "本文を確認しています", true);
        if (inputText.value.trim()) await runProofAI();
        setStatus(status, "タイトル案を作っています", true);
        if (titleInput.value.trim()) await runTitleAI();
        setStatus(status, "完了しました");
      } else {
        if (surveyItems.length) $("#surveyRuleBtn").click();
        if (inputText.value.trim()) $("#textRuleBtn").click();
        setStatus(status, "ルールのみでチェックしました（送信なし）");
      }
      renderAllSummary(useAi);
    } finally {
      suppressLog = false;
      updateAllButtons();
    }
    track(useAi ? "まるごと" : "まるごと（ルールのみ）");
  }
  $("#allRunBtn").addEventListener("click", () => runAll(true));
  $("#allRuleBtn").addEventListener("click", () => runAll(false));

  /* ============================================================
     ルールエンジン自己テスト
     ============================================================ */
  $("#selfTestBtn").addEventListener("click", () => {
    const panel = $("#qaPanel");
    const rows = RuleEngine.selfTest();
    const ok = rows.filter((r) => r.pass).length;
    panel.hidden = false;
    panel.innerHTML =
      `<strong>ルールエンジン自己テスト</strong>　${ok} / ${rows.length} 合格
       <table>
         <tr><th>入力</th><th>期待</th><th>結果</th><th></th></tr>
         ${rows.map((r) =>
           `<tr><td>${esc(r.input)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td>` +
           `<td class="${r.pass ? "qa-pass" : "qa-fail"}">${r.pass ? "PASS" : "FAIL"}</td></tr>`).join("")}
       </table>`;
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* ============================================================
     初期化
     ============================================================ */
  if (!CONFIG.REQUIRE_MASK_CONFIRM) {
    $$(".gate").forEach((g) => { g.hidden = true; });
  }
  updateSurveyButtons();
  updateTextButtons();
  updateTitleButtons();
})();
