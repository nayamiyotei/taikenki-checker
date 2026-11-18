/**
 * logger.js — 利用の記録（誰が・いつ・どの機能を・何件）
 * ---------------------------------------------------------
 * 記録するのは「名前・日時・ツール名・機能・件数」だけ。体験記の本文や画像は送りません。
 * 送信先は Google Apps Script（ウェブアプリ）。README の手順で作成し、その URL を下に貼ります。
 * LOG_URL が空のままなら、何も送信しません（記録機能はオフ）。
 */
const LOGGER_CONFIG = {
  LOG_URL: "",                        // 例："https://script.google.com/macros/s/xxxxxxxx/exec"
  TOOL_NAME: "一次チェックツール",
  NAME_KEY: "checker-user-name"
};

const UsageLogger = (() => {
  const getName = () => { try { return localStorage.getItem(LOGGER_CONFIG.NAME_KEY) || ""; } catch (_) { return ""; } };
  const setName = (v) => { try { localStorage.setItem(LOGGER_CONFIG.NAME_KEY, v); } catch (_) {} };

  /** @returns {Promise<boolean>} 送信したら true */
  async function log(action, count) {
    if (!LOGGER_CONFIG.LOG_URL) return false;
    const payload = {
      name: getName().trim() || "（未入力）",
      tool: LOGGER_CONFIG.TOOL_NAME,
      action: action,
      count: count,
      ts: new Date().toISOString()
    };
    try {
      await fetch(LOGGER_CONFIG.LOG_URL, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      return true;
    } catch (_) { return false; }   // 記録に失敗しても、チェックの結果には影響させない
  }
  return { log, getName, setName };
})();
