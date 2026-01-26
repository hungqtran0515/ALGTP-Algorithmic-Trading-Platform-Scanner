// server.js
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, ".env") });
import { createMassiveRest } from "./src/massive/rest.js";
import * as normalize from "./src/massive/normalize.js";
import { buildFromMovers } from "./src/builders/movers.js";
import { buildFromSnapshotAll } from "./src/builders/snapshotAll.js";
import { buildPremarket } from "./src/builders/premarket.js";
import { buildAftermarket } from "./src/builders/aftermarket.js";
import { createMiniChartService } from "./src/massive/miniChart.js";
import { createAMWebSocketService } from "./src/massive/ws-am.js";
import { makeApiRouter } from "./src/routes/api.js";
import { makeUiRouter } from "./src/routes/ui.js";
import ws from "ws";

const app = express();
app.use(express.json());

const config = {
  port: Number(process.env.PORT || 3000),
  debug: String(process.env.DEBUG || "true").toLowerCase() === "true",
  enableSnapshotAll: String(process.env.ENABLE_SNAPSHOT_ALL || "false").toLowerCase() === "true",
  enable5mIndicators: String(process.env.ENABLE_5M_INDICATORS || "true").toLowerCase() === "true",
  enableAmWs: String(process.env.ENABLE_AM_WS || "true").toLowerCase() === "true",
  enableHaltWs: String(process.env.ENABLE_HALT_WS || "true").toLowerCase() === "true",
  snapConcurrency: Math.max(1, Math.min(10, Number(process.env.SNAP_CONCURRENCY || 4))),
};

const api = createMassiveRest({
  apiKey: process.env.MASSIVE_API_KEY,
  authType: process.env.MASSIVE_AUTH_TYPE,
  queryKeyName: process.env.MASSIVE_QUERY_KEYNAME,
  moverUrl: process.env.MASSIVE_MOVER_URL,
  tickerSnapshotUrl: process.env.MASSIVE_TICKER_SNAPSHOT_URL,
  snapshotAllUrl: process.env.MASSIVE_SNAPSHOT_ALL_URL,
  aggsUrl: process.env.MASSIVE_AGGS_URL,
  dividendsUrl: process.env.MASSIVE_DIVIDENDS_URL,
  includeOtc: String(process.env.INCLUDE_OTC || "false").toLowerCase() === "true",
});

const builders = { buildFromMovers, buildFromSnapshotAll };

// mini chart service
const miniService = createMiniChartService({ api, ttlMs: Number(process.env.MINI_CACHE_TTL_MS || 15000) });

// AM WS service (fallback pre/after)
const amService = createAMWebSocketService({
  wsLib: ws,
  wsUrl: process.env.MASSIVE_WS_URL || "wss://socket.massive.com/stocks",
  apiKey: process.env.MASSIVE_API_KEY,
  subs: process.env.AM_WS_SUBS || "AM.*",
  enabled: config.enableAmWs,
  cacheMax: Number(process.env.AM_CACHE_MAX || 8000),
  api,
  enrichLimit: Number(process.env.AM_ENRICH_LIMIT || 200),
  enrichTtlMs: Number(process.env.AM_ENRICH_TTL_MS || 60000),
});
amService.start();

// UI routes
app.use("/", makeUiRouter());

// API routes (wire mini + pre/after builders)
app.use(
  "/",
  makeApiRouter({
    api,
    normalize,
    builders,
    config,
    buildMiniChart: ({ symbol, tf }) => miniService.buildMiniChart({ symbol, tf }),
    buildPremarket: async ({ cap, limit }) => buildPremarket({ config, api, snapshotAllBuilder: builders.buildFromSnapshotAll, amService, cap, limit }),
    buildAftermarket: async ({ cap, limit }) => buildAftermarket({ config, api, snapshotAllBuilder: builders.buildFromSnapshotAll, amService, cap, limit }),
  })
);

app.listen(config.port, () => {
  const base = `http://localhost:${config.port}`;
  console.log(`\n✅ ALGTP Scanner running`);
  console.log(`UI: ${base}/ui`);
  console.log(`List: ${base}/list?group=topGainers&cap=all&limit=50`);
  console.log(`Pre: ${base}/premarket?cap=small&limit=200`);
  console.log(`After: ${base}/aftermarket?cap=small&limit=200`);
  console.log(`Mini: ${base}/mini-chart?symbol=AAPL&tf=1`);
  console.log("");
});
