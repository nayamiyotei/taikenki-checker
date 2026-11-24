/**
 * gemini-client.js
 * ---------------------------------------------------------
 * Gemini APIとの通信のみを担当する。プロンプト内容やUIロジックは持たない。
 * responseSchemaでJSON構造を強制し、想定外の形式が返ってきた場合は
 * 呼び出し側（app.js）でエラーとして扱えるようにする。
 * ---------------------------------------------------------
 */

const GeminiClient = (() => {

  const ISSUES_SCHEMA = {
    type: "object",
    properties: {
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            original: { type: "string" },
            suggested: { type: "string" },
            reason: { type: "string" },
            index: { type: "integer" },
            question: { type: "string" },
            actionOnPublish: { type: "boolean" }
          },
          required: ["category", "original", "reason"]
        }
      }
    },
    required: ["issues"]
  };

  const TITLES_SCHEMA = {
    type: "object",
    properties: {
      titles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            basis: { type: "string" },
            priorityMatched: { type: "string" }
          },
          required: ["text"]
        }
      }
    },
    required: ["titles"]
  };

  /**
   * HTTPヘッダーの値はISO-8859-1（Latin-1）の範囲でなければならない。
   * IMEオンでの入力・貼り付けや、他アプリからのコピペで全角文字や
   * ゼロ幅文字が紛れ込むと、fetchがこの範囲外の文字を拒否してエラーになる。
   * ここで正規化・除去・検証を行い、原因不明のTypeErrorではなく
   * 分かりやすいエラーメッセージを返せるようにする。
   */
  function toHeaderSafeAscii(value, label) {
    let v = String(value == null ? "" : value)
      .normalize("NFKC")                         // 全角英数字・記号を半角に正規化
      .replace(/[​-‍﻿ ]/g, "") // ゼロ幅文字・BOM・ノーブレークスペース除去
      .trim();
    if (/[^\x00-\xFF]/.test(v)) {
      throw new Error(
        `${label}に全角文字や日本語など、通信ヘッダーで使用できない文字が含まれています。` +
        `コピー元によって見えない文字が紛れ込むことがあるため、一度メモ帳等に貼り付けてから改めてコピーし直し、` +
        `IME（日本語入力）をオフにした状態で貼り付け直してみてください。`
      );
    }
    if (v.length === 0) {
      throw new Error(`${label}が空です。入力してください。`);
    }
    return v;
  }

  function extractJson(raw) {
    let s = String(raw).trim();
    s = s.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("JSON部分が見つかりませんでした。モデルの応答:\n" + raw.slice(0, 500));
    }
    return JSON.parse(s.slice(start, end + 1));
  }

  /** 429（無料枠の上限）のエラー文から、待ち時間（秒）と「1日の上限か」を読み取る */
  function parseQuota(errText) {
    const t = String(errText || "");
    let sec = null;
    const m = t.match(/retry in ([\d.]+)\s*s/i) || t.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
    if (m) sec = Math.ceil(parseFloat(m[1]));
    const daily = /PerDay/i.test(t) || /per day/i.test(t);
    return { sec, daily };
  }

  /**
   * 1回だけ呼び出す（再試行なし）
   * @param {string} apiKey
   * @param {string} model
   * @param {string} prompt
   * @param {"issues"|"titles"} schemaKind - 期待する出力スキーマ
   */
  async function callOnce(apiKey, model, prompt, schemaKind = "issues") {
    const safeApiKey = toHeaderSafeAscii(apiKey, "APIキー");
    const safeModel = toHeaderSafeAscii(model, "モデル名");
    const schema = schemaKind === "titles" ? TITLES_SCHEMA : ISSUES_SCHEMA;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": safeApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema
          }
        })
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      const q = res.status === 429 ? parseQuota(errText) : null;
      const hint = res.status === 429
        ? `\n\n※429は、Googleの無料枠の上限（回数・文字量）です。${q.daily ? "「1日の上限」に達している可能性があります。明日になるか、別のモデルに切り替えてください。" : "1分ほど待ってから、もう一度押してください。続く場合は「モデル」を別のものに切り替えてください。"}`
        : `\n\n※404の場合はモデル名が廃止されている可能性があります。エラー本文中の推奨モデル名に「モデル」欄のvalue値を書き換えてください。`;
      const err = new Error(`APIエラー（${res.status}）: ${errText.slice(0, 400)}${hint}`);
      err.status = res.status;
      if (q) { err.retrySec = q.sec; err.daily = q.daily; }
      throw err;
    }
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!raw) throw new Error("モデルから応答テキストを取得できませんでした。");
    return extractJson(raw);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 一時的な混雑（500/502/503/504）は、2秒・5秒・10秒待って最大3回やり直す。
   * 429（無料枠の上限）は、1日の上限ならすぐ諦め、1分あたりの上限なら、
   * Googleが指定した秒数（最大65秒）だけ待って、1回だけやり直す。
   */
  const BUSY_STATUS = [500, 502, 503, 504];
  const BUSY_WAITS = [2000, 5000, 10000];

  async function call(apiKey, model, prompt, schemaKind = "issues") {
    let busyTry = 0, quotaTry = 0;
    for (;;) {
      try {
        return await callOnce(apiKey, model, prompt, schemaKind);
      } catch (e) {
        const st = e && e.status;
        if (BUSY_STATUS.includes(st) && busyTry < BUSY_WAITS.length) {
          await sleep(BUSY_WAITS[busyTry++]);
          continue;
        }
        if (st === 429 && !e.daily && quotaTry < 1) {
          quotaTry++;
          const sec = Math.min(Math.max((e.retrySec || 30) + 2, 5), 65);
          if (typeof GeminiClient !== "undefined" && GeminiClient.onWait) GeminiClient.onWait(sec);
          await sleep(sec * 1000);
          continue;
        }
        throw e;
      }
    }
  }

  return { call, onWait: null };
})();
