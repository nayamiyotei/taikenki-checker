/**
 * rule-engine.js
 * ---------------------------------------------------------
 * 「AIに指示しても従うとは限らない」ルールを、コード側で100%確実に処理するための
 * 決定的（deterministic）ロジック集。
 *
 * 設計方針：
 *   1. LLMへの指示は「絶対に守られる」ものではなく「守られやすくなる」だけ。
 *      100%守らせたいルールは、AIに頼らずコードで検出・修正する。
 *   2. AIの出力（suggested文字列）も無条件には信用せず、必ずこのファイルの
 *      正規化関数を通してから画面表示する（後段強制）。
 *   3. rule-engineが検出した指摘と、AIが検出した指摘は、由来（source）を
 *      明示して区別する。ユーザーはどちらの指摘か常に判別できる。
 * ---------------------------------------------------------
 */

const RuleEngine = (() => {

  const FULLWIDTH_DIGITS = "０１２３４５６７８９";
  const HALFWIDTH_DIGITS = "0123456789";

  /* ---------- 数字の全角・半角 ---------- */

  // 全角数字→半角数字（判定を統一するための前処理）
  function toHalfWidthDigits(str) {
    return String(str).replace(/[０-９]/g, ch => HALFWIDTH_DIGITS[FULLWIDTH_DIGITS.indexOf(ch)]);
  }

  // 半角数字→全角数字
  function toFullWidthDigits(str) {
    return String(str).replace(/[0-9]/g, ch => FULLWIDTH_DIGITS[HALFWIDTH_DIGITS.indexOf(ch)]);
  }

  /**
   * 「1桁の数字は全角、2桁以上は半角」ルールを強制的に適用する。
   * 全角/半角が混在していても、まず半角に統一してから桁数で判定し直すため、
   * 入力状態に関わらず必ず同じ結果になる（＝AIの出力ゆらぎを吸収する）。
   *
   * 小数点・カンマ区切りは1つの数値のまとまりとして桁数を判定する
   * （例：「1.5」は2桁扱い→半角のまま／「5」は1桁扱い→全角に変換）。
   */
  function normalizeNumberWidth(text) {
    if (!text) return text;
    const unified = toHalfWidthDigits(text);
    return unified.replace(/[0-9]+(?:[.,][0-9]+)*/g, (match) => {
      const digitOnly = match.replace(/[.,]/g, "");
      return digitOnly.length === 1 ? toFullWidthDigits(match) : match;
    });
  }

  /**
   * 数字表記ルール違反を検出する（AIが指摘し忘れても、こちらで必ず拾うための独立チェック）。
   * 「全角の2桁以上」「半角の単独1桁」の両方を違反として報告する。
   */
  function findNumberWidthViolations(text) {
    if (!text) return [];
    const violations = [];

    (text.match(/[０-９]{2,}/g) || []).forEach(m => {
      violations.push({
        category: "数字表記",
        original: m,
        suggested: normalizeNumberWidth(m),
        reason: "2桁以上の数字は半角にする必要があります（全角のまま残っています）",
        source: "rule-engine"
      });
    });

    // 半角の「単独1桁」を検出（前後が数字・小数点・カンマでないもの）
    const singleDigitRegex = /(?<![0-9０-９.,])[0-9](?![0-9０-９.,])/g;
    let m;
    while ((m = singleDigitRegex.exec(text)) !== null) {
      violations.push({
        category: "数字表記",
        original: m[0],
        suggested: toFullWidthDigits(m[0]),
        reason: "1桁の数字は全角にする必要があります（半角のまま残っています）",
        source: "rule-engine"
      });
    }
    return violations;
  }

  /* ---------- 辞書ベースの完全一致検出（NG講師名・表記統一・用語） ---------- */

  /** wrong が、正しい表記(correct)の一部として使われているだけの出現を除いて、まだ出現するか（例：「モチベーション」の中の「モチベ」は除く） */
  function occursOutsideCorrect(text, wrong, correct) {
    let from = 0, pos;
    while ((pos = text.indexOf(wrong, from)) !== -1) {
      from = pos + 1;
      let inside = false, j = -1;
      while ((j = correct.indexOf(wrong, j + 1)) !== -1) {
        if (pos - j >= 0 && text.substr(pos - j, correct.length) === correct) { inside = true; break; }
      }
      if (!inside) return true;
    }
    return false;
  }

  function findLiteralPairViolations(text, pairs, category, reasonSuffix) {
    if (!text) return [];
    const issues = [];
    pairs.forEach(([wrong, correct]) => {
      if (wrong && occursOutsideCorrect(text, wrong, correct)) {
        issues.push({
          category,
          original: wrong,
          suggested: normalizeNumberWidth(correct),   // 1桁の数字は全角（例：「一番」→「１番」）
          reason: `${category}の統一ルールに一致しました${reasonSuffix || ""}`,
          source: "rule-engine"
        });
      }
    });
    return issues;
  }

  function findNgTeacherViolations(text) {
    if (!text) return [];
    return LITERAL_RULES.ngTeachers
      .filter(name => text.includes(name))
      .map(name => ({
        category: "講師名",
        original: name,
        suggested: "",
        reason: "NG講師名リストに一致しました。削除を検討してください",
        source: "rule-engine"
      }));
  }

  /** 「，」「､」→「、」、「．」「｡」→「。」。文字の種類ごとに1件だけ報告する */
  function findPunctuationViolations(text) {
    if (!text) return [];
    const rules = [
      [/[，､]/g, "、", "読点は「、」に統一します"],
      [/(?<=[\u3040-\u30ff\u4e00-\u9fff]),/g, "、", "日本語の文中の「,」は「、」にします"],
      [/[．｡]/g, "。", "句点は「。」に統一します"]
    ];
    const seen = new Set(), out = [];
    rules.forEach(([re, to, why]) => {
      let m;
      while ((m = re.exec(text)) !== null) {
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        out.push({ category: "句読点", original: m[0], suggested: to, reason: why, source: "rule-engine" });
      }
    });
    return out;
  }

  /** 長い指摘の範囲に完全に含まれる短い指摘を除く（例：「高速マスター基礎力養成講座」と「高速マスター」） */
  function dropContainedIssues(issues, text) {
    const spans = (s) => { const r = []; let i = -1; while ((i = text.indexOf(s, i + 1)) !== -1) r.push([i, i + s.length]); return r; };
    const info = issues.map((is) => ({ is, sp: is.original ? spans(is.original) : [] }));
    return info.filter((a) => !info.some((b) =>
      b !== a && a.is.original && b.is.original && b.is.original.length > a.is.original.length &&
      a.sp.length && a.sp.every(([s, e]) => b.sp.some(([bs, be]) => bs <= s && e <= be))
    )).map((x) => x.is);
  }

  /**
   * 決定的ルール（数字表記・NG講師名・コンテンツ名・用語・句読点）をまとめて実行する。
   * このファイル単体でAI無しでも一次スクリーニングができる。
   */
  function runDeterministicChecks(text) {
    if (!text) return [];
    return dropContainedIssues([
      ...findNgTeacherViolations(text),
      ...findLiteralPairViolations(text, LITERAL_RULES.contentNamePairs, "コンテンツ名"),
      ...findLiteralPairViolations(text, LITERAL_RULES.wordPairs, "用語"),
      ...findPunctuationViolations(text),
      ...findNumberWidthViolations(text)
    ], text);
  }

  /* ---------- AI出力の後段強制（ここが今回のバグの直接対策） ---------- */

  /**
   * AIが返してきたissue配列に対し、suggestedフィールドを必ず数字幅ルールに従わせる。
   * 「プロンプトで指示したのに従われない」問題は、この後処理で構造的に解消する。
   */
  function enforceOnAiIssues(aiIssues) {
    if (!Array.isArray(aiIssues)) return [];
    return aiIssues.map(it => ({
      ...it,
      suggested: typeof it.suggested === "string" ? normalizeNumberWidth(it.suggested) : it.suggested,
      source: "ai"
    }));
  }

  const NFKC = (s) => String(s || "").normalize("NFKC");
  const cleanText = (s) => typeof s === "string"
    ? s.replace(/<\s*\/?\s*br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "")
    : s;

  /**
   * AIが返した指摘を整える。
   *  ・<br> などのHTMLタグは、改行にする／除く
   *  ・original が本文に存在しない指摘を捨てる（AIが全角・半角などを勝手に直して写したもの）
   *  ・修正前後が実質同じ（NFKCで同じ）指摘を捨てる（全角↔半角、句読点の見た目の違いだけ）
   * @param {(issue)=>string} getSource その指摘の元になった文章を返す関数
   */
  function cleanAiIssues(aiIssues, getSource) {
    return aiIssues
      .map((it) => ({ ...it, original: cleanText(it.original),
      // 修正案に紛れ込んだ「（※…）」の注釈は、本文に入れる文字列ではないので除く
      suggested: typeof it.suggested === "string" ? cleanText(it.suggested).replace(/\s*[（(]※[^）)]*[）)]/g, "").trim() : it.suggested,
      reason: cleanText(it.reason) }))
      .filter((it) => {
        const o = it.original || "";
        if (!o) return false;
        // 数字の全角／半角（および算用数字への統一）は、システム側で処理済み。AIの数字幅の指摘は捨てる
        if (/[0-9０-９]/.test(o) && /全角|半角|算用数字/.test(it.reason || "")) return false;
        const src = getSource ? getSource(it) : "";
        if (src && !src.includes(o)) return false;
        const s = typeof it.suggested === "string" ? it.suggested : "";
        return NFKC(s) !== NFKC(o);
      });
  }

  /** タイトル案などAI生成テキスト全般にも同じ強制を適用する */
  function enforceOnText(text) {
    return normalizeNumberWidth(text || "");
  }

  /* ---------- ルールエンジン指摘とAI指摘の統合（重複を防ぐ） ---------- */

  /**
   * 同じ箇所を rule-engine と AI が両方指摘した場合、rule-engine側（＝確実な方）を優先し、
   * AI側の重複を間引く。originalテキストの一致（部分一致）で重複と判定する。
   */
  function mergeIssues(ruleIssues, aiIssues) {
    const deduped = aiIssues.filter(ai => {
      if (typeof ai.original !== "string" || !ai.original) return true;
      return !ruleIssues.some(rule =>
        rule.original && (ai.original.includes(rule.original) || rule.original.includes(ai.original))
      );
    });
    return [...ruleIssues, ...deduped];
  }

  /* ---------- AI応答の最低限のバリデーション ---------- */

  function validateIssuesShape(data) {
    if (!data || !Array.isArray(data.issues)) {
      throw new Error("AI応答の形式が不正です（issues配列がありません）");
    }
    return data.issues.filter(it => it && typeof it === "object");
  }

  /* ---------- 自己テスト（画面上のQAパネルから実行できる軽量アサーション） ---------- */

  function selfTest() {
    const origins = (t) => runDeterministicChecks(t).map((h) => h.original);
    const cases = [
      { input: "5個の講座を受けました", expected: "５個の講座を受けました", run: (t) => normalizeNumberWidth(t) },
      { input: "１２個の講座", expected: "12個の講座", run: (t) => normalizeNumberWidth(t) },
      { input: "1.5倍伸びた", expected: "1.5倍伸びた", run: (t) => normalizeNumberWidth(t) },
      { input: "1番好きな講座", expected: "１番好きな講座", run: (t) => normalizeNumberWidth(t) },
      { input: "モチベが上がった", expected: "「モチベ」を検出", run: (t) => origins(t).includes("モチベ") ? "「モチベ」を検出" : "検出なし" },
      { input: "モチベーションが上がった", expected: "検出なし", run: (t) => origins(t).includes("モチベ") ? "誤検出" : "検出なし" },
      { input: "高速マスター基礎力養成講座を使った", expected: "1件（長い方だけ）", run: (t) => origins(t).length + "件" + (origins(t).length === 1 ? "（長い方だけ）" : "") },
      { input: "志望校対策を早めに始めた", expected: "検出なし（文脈判断はAI）", run: (t) => origins(t).includes("志望校対策") ? "誤検出" : "検出なし（文脈判断はAI）" },
      { input: "勉強，睡眠", expected: "「，」を検出", run: (t) => origins(t).includes("，") ? "「，」を検出" : "検出なし" },
      { input: "勉強、睡眠", expected: "検出なし", run: (t) => origins(t).filter((o) => /[，,､]/.test(o)).length ? "誤検出" : "検出なし" },
      { input: "AIが返した <br> 入りの案", expected: "タグを除く", run: () => {
          const r = cleanAiIssues([{ original: "良い。", suggested: "あ</br>い", reason: "r" }], () => "良い。");
          return r.length && !/br/.test(r[0].suggested) ? "タグを除く" : "残っている";
        } },
      { input: "本文に無い original（全角に直して写された「６０」）", expected: "捨てる", run: () =>
          cleanAiIssues([{ original: "６０", suggested: "60" }], () => "点数は60点").length ? "残っている" : "捨てる" }
    ];
    return cases.map((c) => {
      const actual = c.run(c.input);
      return { input: c.input, expected: c.expected, actual, pass: actual === c.expected };
    });
  }

  return {
    normalizeNumberWidth,
    findNumberWidthViolations,
    findNgTeacherViolations,
    findLiteralPairViolations,
    findPunctuationViolations,
    dropContainedIssues,
    cleanAiIssues,
    runDeterministicChecks,
    enforceOnAiIssues,
    enforceOnText,
    mergeIssues,
    validateIssuesShape,
    selfTest
  };
})();
