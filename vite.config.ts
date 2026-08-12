import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import {
  createCodexSessionsDevSource,
  defaultCodexSessionsRoot,
  defaultCodexStateDbPath,
  sourceHealth,
} from "./scripts/codexSessionsDevSource.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const previewSource = createCodexSessionsDevSource();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), codexSessionsDevApi()],
  test: {
    environment: "jsdom",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

function codexSessionsDevApi() {
  return {
    name: "codex-sessions-dev-api",
    configureServer(server: any) {
      server.middlewares.use("/api/sessions", (req: any, res: any) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        sendJson(res, previewSource.discoverCodexSessions({
          followUpToIdleMinutes: followUpToIdleMinutesFromRequestValue(
            url.searchParams.get("followUpToIdleMinutes"),
          ),
        }));
      });

      server.middlewares.use("/api/source-health", (_req: any, res: any) => {
        sendJson(res, sourceHealth());
      });

      server.middlewares.use("/api/jump", (req: any, res: any) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("Method not allowed");
          return;
        }

        return readJsonBody(req)
          .then(({ sessionId, followUpToIdleMinutes }) => previewSource.jumpToSession(sessionId, {
            followUpToIdleMinutes: followUpToIdleMinutesFromRequestValue(followUpToIdleMinutes),
          }))
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
      });
    },
  };
}

function followUpToIdleMinutesFromRequestValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return Number(value);
}

function sendJson(res: any, payload: unknown) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
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

export { defaultCodexSessionsRoot, defaultCodexStateDbPath };
