// 测 Gist 通道。URL 硬编码 api.github.com，没有真 token 时跑不了真实往返，
// 这里验三件能验的事：
//   1. 缺 token / gistId 时报错清楚，不是静默失败
//   2. 请求体结构对不对（files / base64 / public:false）—— 拦 fetch 看发出去的 body
//   3. 403/404 这类远端错误会不会被当成成功
const S = await import("file:///D:/dsh-plugins/dsh-studio/lib/sync.js");
const M = await import("file:///D:/dsh-plugins/dsh-studio/lib/snapshot.js");

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};

// ── 1. 缺字段 ────────────────────────────────────────────────────────
console.log("=== 缺字段报错 ===");
const snap = await M.createSnapshot("gisttest");
for (const [label, cfg] of [
  ["缺 token", {}],
  ["缺 gistId（pull 时才有意义）", { token: "ghp_x" }]
]) {
  try {
    await S.pullSnapshot("gist", cfg, "t");
    ok(label + " 应该报错", false);
  } catch (e) {
    ok(label, /需要/.test(e.message), e.message.slice(0, 60));
  }
}
try {
  await S.pushSnapshot("gist", {}, snap.id);
  ok("push 缺 token 应该报错", false);
} catch (e) {
  ok("push 缺 token", /需要/.test(e.message), e.message.slice(0, 60));
}

// ── 2. 请求体结构（拦 fetch）──────────────────────────────────────────
console.log("\n=== 请求体结构 ===");
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null, headers: init.headers ?? {} });
  // 假装建了个 Gist
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ id: "newgist123" })
  };
};
try {
  const r = await S.pushSnapshot("gist", { token: "ghp_faketoken" }, snap.id);
  ok("首次 push 走 POST /gists", calls[0]?.method === "POST" && calls[0]?.url === "https://api.github.com/gists", calls[0]?.url);
  ok("返回了 gistId", r.gistId === "newgist123" && r.created === true, JSON.stringify({ gistId: r.gistId, created: r.created }));
  const body = JSON.parse(calls[0]?.body ?? "{}");
  ok("body.public 是 false", body.public === false);
  ok("三个文件都在", ["config.tar.gz", "manifest.json", "LATEST"].every((k) => body.files?.[k] !== undefined), Object.keys(body.files ?? {}).join(", "));
  ok("config.tar.gz 是 base64", (() => {
    const c = body.files?.["config.tar.gz"]?.content ?? "";
    if (c === "") return false;
    const back = Buffer.from(c, "base64");
    return back.length === snap.archiveBytes;
  })(), "解回 " + Buffer.from(body.files?.["config.tar.gz"]?.content ?? "", "base64").length + " 字节");
  ok("LATEST 是快照 id", (body.files?.LATEST?.content ?? "").trim() === snap.id);
  ok("Authorization 带 token", String(calls[0]?.headers?.Authorization ?? "").includes("ghp_faketoken"));
} finally {
  globalThis.fetch = realFetch;
  calls.length = 0;
}

// ── 3. 远端报错不当成功 ──────────────────────────────────────────────
console.log("\n=== 远端错误处理 ===");
globalThis.fetch = async () => ({
  ok: false,
  status: 401,
  text: async () => "Bad credentials"
});
try {
  await S.pushSnapshot("gist", { token: "bad", gistId: "g1" }, snap.id);
  ok("401 应该抛错", false);
} catch (e) {
  ok("401 抛错且带状态码", /401/.test(e.message), e.message.slice(0, 60));
}
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ files: {} })
});
try {
  await S.pullSnapshot("gist", { token: "t", gistId: "g1" }, "t");
  ok("Gist 里没 config.tar.gz 时应该报错", false);
} catch (e) {
  ok("缺 config.tar.gz 时报错", /没有 config\.tar\.gz/.test(e.message), e.message.slice(0, 60));
}
globalThis.fetch = realFetch;

// 清场
import { rmSync } from "node:fs";
rmSync(M.snapshotsDir() + "/" + snap.id, { recursive: true, force: true });
console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
