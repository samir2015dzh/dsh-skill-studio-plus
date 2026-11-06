// 本地假服务器：同时模拟 WebDAV 与 S3 的 PUT/GET，记录每个请求的格式。
//
// 目的不是验证「远端存对了没」，而是验证 studio 发出去的请求本身：
//   - URL 拼得对不对（base + /config.tar.gz）
//   - WebDAV 的 Basic auth、S3 的 SigV4 Authorization 头长什么样
//   - 写进去的字节出来还是不是原样
//
// 用法：node _sync-test-server.mjs <port>
import http from "node:http";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 18899);
const store = new Map();
const log = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = req.url ?? "";
    log.push({
      method: req.method,
      url,
      headers: {
        "content-type": req.headers["content-type"] ?? null,
        authorization: req.headers["authorization"] ?? null,
        "x-amz-date": req.headers["x-amz-date"] ?? null,
        "x-amz-content-sha256": req.headers["x-amz-content-sha256"] ?? null,
        host: req.headers["host"] ?? null
      },
      bytes: body.length
    });
    // 记录状态供测试脚本读
    if (url === "/__log") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(log, null, 2));
      return;
    }
    if (url === "/__reset") {
      log.length = 0;
      store.clear();
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "PUT") {
      store.set(url, body);
      res.writeHead(200).end("");
      return;
    }
    if (req.method === "GET") {
      const data = store.get(url);
      if (data === undefined) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(data);
      return;
    }
    res.writeHead(405).end("method not allowed");
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("listening on http://127.0.0.1:" + port);
});
