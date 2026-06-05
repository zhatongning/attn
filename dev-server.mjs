import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  discoverCodexSessions,
  jumpToSession,
  sourceHealth,
} from "./scripts/codexSessionsDevSource.mjs";

const port = 1420;
const root = process.cwd();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/sessions") {
    return sendJson(res, discoverCodexSessions());
  }

  if (url.pathname === "/api/source-health") {
    return sendJson(res, sourceHealth());
  }

  if (url.pathname === "/api/jump" && req.method === "POST") {
    return readJsonBody(req)
      .then(({ sessionId }) => jumpToSession(sessionId))
      .then((result) => sendJson(res, result))
      .catch((error) => {
        res.statusCode = 500;
        sendJson(res, {
          sessionId: "",
          availability: "unavailable",
          target: "unknown",
          message: error instanceof Error ? error.message : "Jump command failed.",
        });
      });
  }

  const filePath = staticFilePath(url.pathname);
  if (!filePath) {
    res.statusCode = 404;
    return res.end("Not found");
  }

  res.statusCode = 200;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", contentType(filePath));
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Agent Session Inbox preview: http://127.0.0.1:${port}/`);
});

function staticFilePath(pathname) {
  if (pathname === "/") return existingFile(path.join(root, "dist", "index.html"), path.join(root, "index.html"));

  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    path.join(root, "dist", normalized),
    path.join(root, normalized),
    path.join(root, "src", normalized.replace(/^\/src\//, "")),
    path.join(root, "public", normalized),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function existingFile(...candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".ts") || filePath.endsWith(".js")) {
    return "application/javascript";
  }
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, payload) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
