// 真机测 S3：对着 Bitiful（S3 兼容）跑 push → pull 往返。
//
// 凭据从环境变量读，不落盘、不打印：
//   S3_ENDPOINT / S3_BUCKET / S3_REGION / S3_AK / S3_SK
// 跑法：$env:S3_SK='...'; node scripts/test-s3-live.mjs
//
// 会真的往远端写 config.tar.gz / manifest.json / LATEST，跑完删掉。
import { readFileSync, rmSync } from "node:fs";

const config = {
  endpoint: process.env.S3_ENDPOINT ?? "",
  bucket: process.env.S3_BUCKET ?? "",
  region: process.env.S3_REGION ?? "",
  accessKey: process.env.S3_AK ?? "",
  secretKey: process.env.S3_SK ?? ""
};
if (config.endpoint === "" || config.bucket === "" || config.secretKey === "") {
  console.log("需要 S3_ENDPOINT / S3_BUCKET / S3_REGION / S3_AK / S3_SK");
  process.exit(1);
}

const S = await import("file:///D:/dsh-plugins/dsh-studio/lib/sync.js");
const M = await import("file:///D:/dsh-plugins/dsh-studio/lib/snapshot.js");

const fails = [];
const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " · " + extra : ""}`);
  if (!cond) fails.push(name);
};

console.log("远端:", config.endpoint, "· 桶:", config.bucket, "· 区域:", config.region);
console.log("建测试快照…");
const snap = await M.createSnapshot("s3live");
console.log("  快照:", snap.id, "·", snap.files.length, "文件 ·", Math.round(snap.archiveBytes / 1024) + " KB");

try {
  // ── push ────────────────────────────────────────────────────────
  console.log("\n=== push ===");
  const pushed = await S.pushSnapshot("s3", config, snap.id);
  ok("push 成功", pushed.pushed === true);

  // ── pull ────────────────────────────────────────────────────────
  console.log("\n=== pull ===");
  const pulled = await S.pullSnapshot("s3", config, "from-s3-live");
  ok("pull 成功", typeof pulled.id === "string" && pulled.id !== "");
  ok("字节往返一致", pulled.bytes === snap.archiveBytes, `${pulled.bytes} vs ${snap.archiveBytes}`);
  ok("remoteId 对得上", pulled.remoteId === snap.id, pulled.remoteId);
  const back = readFileSync(M.snapshotsDir() + "/" + pulled.id + "/config.tar.gz");
  const orig = readFileSync(M.snapshotsDir() + "/" + snap.id + "/config.tar.gz");
  ok("包内容逐字节相同", back.equals(orig), `${back.length} vs ${orig.length} 字节`);
  // pullSnapshot 返回的 files 是清单**条数**，不是 manifest 对象
  ok("manifest 清单数对得上", pulled.files === snap.files.length, `${pulled.files} vs ${snap.files.length}`);

  // ── 再 push 一次（覆盖）──────────────────────────────────────────
  console.log("\n=== 再 push（覆盖）===");
  const again = await S.pushSnapshot("s3", config, snap.id);
  ok("覆盖 push 成功", again.pushed === true);
} catch (e) {
  ok("整体流程", false, e.message.slice(0, 220));
} finally {
  // 清场：用 lib 自己的签名把远端三个对象删掉
  console.log("\n=== 清场 ===");
  const crypto = await import("node:crypto");
  const sha256hex = (d) => crypto.createHash("sha256").update(d).digest("hex");
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const region = config.region === "" ? "us-east-1" : config.region;
  async function del(key) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const url = new URL(`${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${key}`);
    const payloadHash = sha256hex("");
    const ch = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const sh = "host;x-amz-content-sha256;x-amz-date";
    const cr = ["DELETE", url.pathname, "", ch, sh, payloadHash].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(cr)].join("\n");
    let k = hmac("AWS4" + config.secretKey, dateStamp);
    k = hmac(k, region); k = hmac(k, "s3"); k = hmac(k, "aws4_request");
    const sig = crypto.createHmac("sha256", k).update(sts).digest("hex");
    const r = await fetch(url, {
      method: "DELETE",
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${sh}, Signature=${sig}`
      }
    });
    console.log(`  DELETE ${key}: ${r.status}`);
  }
  for (const name of ["config.tar.gz", "manifest.json", "LATEST"]) await del(name);
  for (const s of await M.listSnapshots()) {
    if (s.label === "s3live" || s.label === "from-s3-live") {
      rmSync(M.snapshotsDir() + "/" + s.id, { recursive: true, force: true });
    }
  }
  console.log("  本地测试快照已清");
}

console.log("\n" + (fails.length === 0 ? "全部通过" : "失败 " + fails.length + " 项: " + fails.join(", ")));
process.exit(fails.length === 0 ? 0 : 1);
