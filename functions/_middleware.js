// 定数時間で比較（タイミング攻撃対策）
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diff === 0;
}

export async function onRequest({ request, env, next }) {
  if (!env.BASIC_USER || !env.BASIC_PASS) {
    return new Response("認証の設定がありません", { status: 500 });
  }

  const auth = request.headers.get("Authorization") || "";
  const [scheme, encoded] = auth.split(" ");

  if (scheme === "Basic" && encoded) {
    try {
      const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      const i = decoded.indexOf(":");
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      if (safeEqual(user, env.BASIC_USER) && safeEqual(pass, env.BASIC_PASS)) {
        return next();
      }
    } catch (e) {}
  }
  
  return new Response("認証が必要です", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="一次チェックツール", charset="UTF-8"' },
  });
}
