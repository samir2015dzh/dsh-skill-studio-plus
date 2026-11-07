// 专门验 raw_url 这条路：超过 ~1 MB 的 Gist 文件 GitHub 只给 truncated content，
// 要走 raw_url。raw_url 返回的是**原始字节**，不是 base64 —— 这两种输入必须分开处理。
const S = await import(new URL("../lib/sync.js", import.meta.url).href);
const M = await import(new URL("../lib/snapshot.js", import.meta.url).href);

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};

const snap = await M.createSnapshot("rawurltest");
const realArchive = (await import("node:fs")).readFileSync(M.snapshotsDir() + "/" + snap.id + "/config.tar.gz");
console.log("测试快照:", snap.id, "·", realArchive.length, "字节");

const realFetch = globalThis.fetch;

// 情形 A：小文件，content 里有完整 base64
console.log("\n=== A. 小文件（content 是 base64）===");
globalThis.fetch = async (url) => {
  if (String(url).includes("/gists/")) {
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        files: {
          "config.tar.gz": { content: realArchive.toString("base64"), truncated: false },
          "manifest.json": { content: JSON.stringify({ files: [{ rel: "x" }] }) },
          LATEST: { content: snap.id + "\n" }
        }
      })
    };
  }
  throw new Error("不该走 raw_url：" + url);
};
try {
  const r = await S.pullSnapshot("gist", { token: "t", gistId: "g" }, "a");
  ok("走 content 分支", r.bytes === realArchive.length, r.bytes + " vs " + realArchive.length);
} catch (e) { ok("走 content 分支", false, e.message.slice(0, 60)); }

// 情形 B：大文件，truncated=true，raw_url 给原始字节
console.log("\n=== B. 大文件（truncated，raw_url 给原始字节）===");
let rawHit = false;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/gists/")) {
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        files: {
          "config.tar.gz": { content: "截断掉的一段base64", truncated: true, raw_url: "https://raw.example/config.tar.gz" },
          "manifest.json": { content: JSON.stringify({ files: [{ rel: "x" }] }) },
          LATEST: { content: snap.id + "\n" }
        }
      })
    };
  }
  if (u === "https://raw.example/config.tar.gz") {
    rawHit = true;
    // 关键：这里返回的是原始二进制，不是 base64 文本
    const ab = realArchive.buffer.slice(realArchive.byteOffset, realArchive.byteOffset + realArchive.byteLength);
    return { ok: true, status: 200, arrayBuffer: async () => ab };
  }
  throw new Error("意外的 URL: " + u);
};
try {
  const r = await S.pullSnapshot("gist", { token: "t", gistId: "g" }, "b");
  ok("走了 raw_url", rawHit === true);
  ok("字节数正确（不再把二进制当 base64）", r.bytes === realArchive.length, r.bytes + " vs " + realArchive.length);
} catch (e) { ok("走 raw_url 分支", false, e.message.slice(0, 80)); }

// 情形 C：raw_url 也失败
console.log("\n=== C. raw_url 返回错误 ===");
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/gists/")) {
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        files: {
          "config.tar.gz": { content: "x", truncated: true, raw_url: "https://raw.example/x" },
          "manifest.json": { content: "{}" },
          LATEST: { content: "id\n" }
        }
      })
    };
  }
  return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
};
try {
  await S.pullSnapshot("gist", { token: "t", gistId: "g" }, "c");
  ok("raw_url 500 应该抛错", false);
} catch (e) {
  ok("raw_url 500 抛错", /raw_url|500/.test(e.message), e.message.slice(0, 60));
}

globalThis.fetch = realFetch;
(await import("node:fs")).rmSync(M.snapshotsDir() + "/" + snap.id, { recursive: true, force: true });
console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
