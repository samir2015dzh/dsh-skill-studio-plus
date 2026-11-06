// 真机测 Gist 通道：用 ~/.git-credentials 里的真实 token 建一个 private Gist，
// 跑 push → pull 往返，最后把它删掉。会真的调用 api.github.com。
//
// 跑法：node scripts/test-gist-live.mjs
// token 从 git 凭据读，不打印明文；建出来的 Gist id 会打出来，方便你去 GitHub 上核对。
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";

const cred = readFileSync(process.env.USERPROFILE + "\\.git-credentials", "utf8").trim();
const m = cred.match(/^https:\/\/([^:]+):([^@]+)@github\.com/);
if (!m) {
  console.log("git 凭据格式不认识，跳过");
  process.exit(0);
}
const token = m[2];

const S = await import("file:///D:/dsh-plugins/dsh-studio/lib/sync.js");
const M = await import("file:///D:/dsh-plugins/dsh-studio/lib/snapshot.js");

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};

console.log("建测试快照…");
const snap = await M.createSnapshot("gistlive");
console.log("  快照:", snap.id, "·", snap.files.length, "文件 ·", Math.round(snap.archiveBytes / 1024) + " KB");

let gistId = "";
try {
  // ── push（首次，会自动建 Gist）───────────────────────────────────
  console.log("\n=== push（首次建 Gist）===");
  const pushed = await S.pushSnapshot("gist", { token }, snap.id);
  gistId = pushed.gistId ?? "";
  ok("push 成功", pushed.pushed === true);
  ok("建出了 Gist", gistId !== "", gistId);
  ok("标记为新建", pushed.created === true);

  // ── 用 API 核对远端内容 ─────────────────────────────────────────
  console.log("\n=== 远端核对 ===");
  const gh = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dsh-studio-test" };
  const meta = await (await fetch(`https://api.github.com/gists/${gistId}`, { headers: gh })).json();
  ok("Gist 是 private", meta.public === false);
  ok("三个文件都在", ["config.tar.gz", "manifest.json", "LATEST"].every((k) => meta.files?.[k] !== undefined), Object.keys(meta.files ?? {}).join(", "));
  const big = meta.files?.["config.tar.gz"];
  // Gist 存的是 base64 文本，size 是那个文本的字符数（约 archiveBytes 的 4/3）
  const expectB64 = Buffer.from(String(big?.content ?? ""), "base64").length;
  ok("远端 config.tar.gz 的大小是 base64 后的长度", (big?.size ?? 0) >= snap.archiveBytes, `${big?.size} vs ${snap.archiveBytes}（base64 膨胀约 4/3）`);
  ok("LATEST 内容正确", (meta.files?.LATEST?.content ?? "").trim() === snap.id);
  console.log(`  truncated: ${big?.truncated}（当前 ${Math.round(snap.archiveBytes / 1024)} KB，超过 ~1 MB 才是 true）`);

  // ── pull ────────────────────────────────────────────────────────
  console.log("\n=== pull ===");
  const pulled = await S.pullSnapshot("gist", { token, gistId }, "from-gist-live");
  ok("pull 成功", typeof pulled.id === "string" && pulled.id !== "");
  ok("字节往返一致", pulled.bytes === snap.archiveBytes, `${pulled.bytes} vs ${snap.archiveBytes}`);
  ok("remoteId 对得上", pulled.remoteId === snap.id, pulled.remoteId);
  // 内容真的一不一样：解开拉回来的包，比文件清单
  const back = M.unpackSession ? null : null;
  const backRows = (await import("node:fs")).readFileSync(M.snapshotsDir() + "/" + pulled.id + "/config.tar.gz");
  const orig = readFileSync(M.snapshotsDir() + "/" + snap.id + "/config.tar.gz");
  ok("包内容逐字节相同", backRows.equals(orig), `${backRows.length} vs ${orig.length} 字节`);

  // ── 再 push 一次（内容没变，应该更新同一个 Gist）─────────────────
  console.log("\n=== 再 push（应复用同一个 Gist）===");
  const again = await S.pushSnapshot("gist", { token, gistId }, snap.id);
  ok("复用原 Gist", again.gistId === gistId, `${again.gistId} vs ${gistId}`);
  ok("不是新建", again.created === false);
} catch (e) {
  ok("整体流程", false, e.message.slice(0, 200));
} finally {
  // ── 清场：删 Gist + 删本地测试快照 ──────────────────────────────
  console.log("\n=== 清场 ===");
  if (gistId !== "") {
    const del = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "dsh-studio-test" }
    });
    ok("删掉测试 Gist", del.status === 204, "HTTP " + del.status);
  }
  for (const s of await M.listSnapshots()) {
    if (s.label === "gistlive" || s.label === "from-gist-live") {
      rmSync(M.snapshotsDir() + "/" + s.id, { recursive: true, force: true });
    }
  }
  console.log("  本地测试快照已清");
}

console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
