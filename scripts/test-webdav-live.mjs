// 真机测 WebDAV：对着 https://cd.ding.cab/dav 跑 push → pull 往返。
//
// 凭据从环境变量读，不落盘、不打印：
//   WEBDAV_URL / WEBDAV_USER / WEBDAV_PASS
// 跑法：$env:WEBDAV_PASS='...'; node scripts/test-webdav-live.mjs
//
// 会真的往远端写 config.tar.gz / manifest.json / LATEST，跑完删掉。
import { readFileSync, rmSync } from "node:fs";

const url = process.env.WEBDAV_URL ?? "";
const user = process.env.WEBDAV_USER ?? "";
const pass = process.env.WEBDAV_PASS ?? "";
if (url === "" || pass === "") {
  console.log("需要 WEBDAV_URL / WEBDAV_USER / WEBDAV_PASS 三个环境变量");
  process.exit(1);
}

const S = await import("file:///D:/dsh-plugins/dsh-studio/lib/sync.js");
const M = await import("file:///D:/dsh-plugins/dsh-studio/lib/snapshot.js");

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};
const auth = "Basic " + Buffer.from(user + ":" + pass, "utf8").toString("base64");
const H = { Authorization: auth };

console.log("远端:", url);
console.log("建测试快照…");
const snap = await M.createSnapshot("webdavlive");
console.log("  快照:", snap.id, "·", snap.files.length, "文件 ·", Math.round(snap.archiveBytes / 1024) + " KB");

try {
  // ── push（目录不存在的话，这里会先 MKCOL）───────────────────────
  console.log("\n=== push ===");
  const pushed = await S.pushSnapshot("webdav", { url, username: user, password: pass }, snap.id);
  ok("push 成功", pushed.pushed === true);

  // ── 远端核对 ────────────────────────────────────────────────────
  console.log("\n=== 远端核对 ===");
  const latest = await (await fetch(url + "/LATEST", { headers: H })).text();
  ok("LATEST 内容是快照 id", latest.trim() === snap.id, latest.trim());
  const remoteArchive = Buffer.from(await (await fetch(url + "/config.tar.gz", { headers: H })).arrayBuffer());
  ok("远端 config.tar.gz 大小对得上", remoteArchive.length === snap.archiveBytes, `${remoteArchive.length} vs ${snap.archiveBytes}`);
  const manifest = JSON.parse(await (await fetch(url + "/manifest.json", { headers: H })).text());
  ok("远端 manifest 里有文件清单", Array.isArray(manifest.files) && manifest.files.length === snap.files.length, `${manifest.files?.length} vs ${snap.files.length}`);

  // ── pull ────────────────────────────────────────────────────────
  console.log("\n=== pull ===");
  const pulled = await S.pullSnapshot("webdav", { url, username: user, password: pass }, "from-webdav-live");
  ok("pull 成功", typeof pulled.id === "string" && pulled.id !== "");
  ok("字节往返一致", pulled.bytes === snap.archiveBytes, `${pulled.bytes} vs ${snap.archiveBytes}`);
  ok("remoteId 对得上", pulled.remoteId === snap.id, pulled.remoteId);
  const back = readFileSync(M.snapshotsDir() + "/" + pulled.id + "/config.tar.gz");
  const orig = readFileSync(M.snapshotsDir() + "/" + snap.id + "/config.tar.gz");
  ok("包内容逐字节相同", back.equals(orig), `${back.length} vs ${orig.length} 字节`);

  // ── 再 push 一次（覆盖，不该报错）────────────────────────────────
  console.log("\n=== 再 push（覆盖同一个目录）===");
  const again = await S.pushSnapshot("webdav", { url, username: user, password: pass }, snap.id);
  ok("覆盖 push 成功", again.pushed === true);
} catch (e) {
  ok("整体流程", false, e.message.slice(0, 200));
} finally {
  console.log("\n=== 清场 ===");
  for (const name of ["config.tar.gz", "manifest.json", "LATEST"]) {
    const r = await fetch(url + "/" + name, { method: "DELETE", headers: H });
    console.log(`  DELETE ${name}: ${r.status}`);
  }
  for (const s of await M.listSnapshots()) {
    if (s.label === "webdavlive" || s.label === "from-webdav-live") {
      rmSync(M.snapshotsDir() + "/" + s.id, { recursive: true, force: true });
    }
  }
  console.log("  本地测试快照已清");
}

console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
