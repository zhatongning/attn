import { afterEach, describe, expect, it } from "vitest";
import { createPreviewServer } from "../dev-server.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("preview server", () => {
  it("forwards request follow-up duration values without changing normalization inputs", async () => {
    const receivedValues = [];
    const server = await listen(createPreviewServer({
      source: {
        discoverCodexSessions({ followUpToIdleMinutes }) {
          receivedValues.push(followUpToIdleMinutes);
          return [];
        },
      },
    }));

    await fetchJson(server, "/api/sessions");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=%20%20%20");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=45");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=12");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=45.8");
    await fetchJson(server, "/api/sessions?followUpToIdleMinutes=invalid");

    expect(receivedValues).toEqual([
      undefined,
      undefined,
      undefined,
      45,
      12,
      45.8,
      Number.NaN,
    ]);
  });

  it("uses the session source's latest snapshot health", async () => {
    const health = {
      sourceName: "Codex sessions",
      status: "degraded",
      capabilities: [{
        name: "Thread discovery",
        availability: "unavailable",
        detail: "SQLite thread discovery failed; JSONL fallback used.",
      }],
    };
    const source = {
      discoverCodexSessions() {
        return [];
      },
      sourceHealth() {
        return health;
      },
    };
    const server = await listen(createPreviewServer({ source }));

    expect(await fetchJson(server, "/api/sessions")).toEqual([]);
    expect(await fetchJson(server, "/api/source-health")).toEqual(health);
  });
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function fetchJson(server, requestPath) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${requestPath}`);
  return response.json();
}
