// 测 WebDAV 与 S3 两条通道：对着本地假服务器跑 push / pull 往返。
//
// 不验远端语义（那是真服务器的活），验的是：
//   - URL 拼接（base + /config.tar.gz、S3 的 path-style /<bucket>/<key>）
//   - 认证头（WebDAV Basic、S3 的 SigV4 Authorization 结构）
//   - 字节往返一致
//   - 缺字段时报错清楚
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PORT = 18899;
const server = spawn(process.execPath, ["scripts/test-sync-server.mjs", String(PORT)], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  stdio: ["ignore", "pipe", "pipe"]
});
await new Promise((r) => setTimeout(r, 700));

const S = await import("file:///D:/dsh-plugins/dsh-studio/lib/sync.js");
const M = await import("file:///D:/dsh-plugins/dsh-studio/lib/snapshot.js");

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};

const base = `http://127.0.0.1:${PORT}`;
const fetchLog = async () => (await fetch(base + "/__log")).json();

// 造一份快照
rmSync("D:\\杂七杂八\\_sync-fixture", { recursive: true, force: true });
mkdirSync("D:\\杂七杂八\\_sync-fixture", { recursive: true });
const snap = await M.createSnapshot("synctest");
console.log("测试快照:", snap.id, "·", snap.files.length, "文件");

// ── WebDAV ────────────────────────────────────────────────────────────
console.log("\n=== WebDAV ===");
await fetch(base + "/__reset");
const webdavCfg = { url: base + "/dav", username: "alice", password: "s3cret" };
const pushed = await S.pushSnapshot("webdav", webdavCfg, snap.id);
ok("push 成功", pushed.pushed === true);
let entries = await fetchLog();
const putPaths = entries.filter((e) => e.method === "PUT").map((e) => e.url);
ok("URL 拼成 base + /文件名", putPaths.includes("/dav/config.tar.gz") && putPaths.includes("/dav/manifest.json") && putPaths.includes("/dav/LATEST"), putPaths.join(", "));
const auth = entries.find((e) => e.method === "PUT")?.headers.authorization ?? "";
const expectAuth = "Basic " + Buffer.from("alice:s3cret").toString("base64");
ok("Basic auth 正确", auth === expectAuth);
const latestBytes = entries.find((e) => e.url === "/dav/LATEST")?.bytes ?? 0;
ok("LATEST 写了内容", latestBytes > 0, latestBytes + " 字节");

const pulled = await S.pullSnapshot("webdav", webdavCfg, "from-webdav");
ok("pull 成功", typeof pulled.id === "string" && pulled.id !== "");
// 跟源快照档案里的字节数比，不是跟 push 的返回值（那是布尔）
ok("字节往返一致", pulled.bytes === snap.archiveBytes, `${pulled.bytes} vs ${snap.archiveBytes}`);
ok("remoteId 对得上", pulled.remoteId === snap.id, pulled.remoteId);

// ── S3 ────────────────────────────────────────────────────────────────
console.log("\n=== S3 ===");
await fetch(base + "/__reset");
const s3Cfg = { endpoint: base, bucket: "mybucket", region: "us-east-1", accessKey: "AKIAEXAMPLE", secretKey: "secretkey" };
const s3p = await S.pushSnapshot("s3", s3Cfg, snap.id);
ok("push 成功", s3p.pushed === true);
entries = await fetchLog();
const s3Paths = entries.filter((e) => e.method === "PUT").map((e) => e.url);
ok("path-style 路径", s3Paths.includes("/mybucket/config.tar.gz") && s3Paths.includes("/mybucket/LATEST"), s3Paths.join(", "));
const s3auth = entries.find((e) => e.method === "PUT")?.headers.authorization ?? "";
ok("Authorization 以 AWS4-HMAC-SHA256 开头", s3auth.startsWith("AWS4-HMAC-SHA256 "));
ok("含 Credential / SignedHeaders / Signature 三段", /Credential=[^/]+\/\d{8}\/us-east-1\/s3\/aws4_request/.test(s3auth) && s3auth.includes("SignedHeaders=") && /Signature=[0-9a-f]{64}/.test(s3auth), s3auth.slice(0, 90) + "…");
const s3date = entries.find((e) => e.method === "PUT")?.headers["x-amz-date"] ?? "";
ok("x-amz-date 是 ISO 基本格式", /^\d{8}T\d{6}Z$/.test(s3date), s3date);
const s3hash = entries.find((e) => e.method === "PUT")?.headers["x-amz-content-sha256"] ?? "";
ok("x-amz-content-sha256 是 sha256", /^[0-9a-f]{64}$/.test(s3hash));

const s3pulled = await S.pullSnapshot("s3", s3Cfg, "from-s3");
ok("pull 成功", typeof s3pulled.id === "string");
ok("字节往返一致", s3pulled.bytes === snap.archiveBytes, `${s3pulled.bytes} vs ${snap.archiveBytes}`);

// ── 缺字段的报错 ──────────────────────────────────────────────────────
console.log("\n=== 缺字段报错 ===");
for (const [label, fn] of [
  ["WebDAV 缺 url", () => S.pushSnapshot("webdav", {}, snap.id)],
  ["S3 缺 bucket", () => S.pushSnapshot("s3", { endpoint: base, accessKey: "a", secretKey: "b" }, snap.id)],
  ["S3 缺密钥", () => S.pushSnapshot("s3", { endpoint: base, bucket: "b" }, snap.id)],
  ["未知通道", () => S.pushSnapshot("ftp", {}, snap.id)]
]) {
  try { await fn(); ok(label + " 应该报错", false); }
  catch (e) { ok(label, /需要|未知通道|unknown/.test(e.message), e.message.slice(0, 50)); }
}

// 清场
server.kill();
rmSync("D:\\杂七杂八\\_sync-fixture", { recursive: true, force: true });
for (const s of await M.listSnapshots()) {
  if (s.label === "synctest" || s.label.startsWith("from-") || s.label === "pulled") {
    rmSync(M.snapshotsDir() + "/" + s.id, { recursive: true, force: true });
  }
}
console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
