import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createSendblueRouter } from "./sendblue.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "12mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  // Direct meal-logging endpoint for the native iOS app.
  // Auth: X-Nutrition-Token header must match NUTRITION_LOG_MEAL_TOKEN.
  app.post("/log-meal", async (req, res) => {
    const expected = process.env.NUTRITION_LOG_MEAL_TOKEN;
    if (!expected) {
      res.status(500).json({ error: "server not configured: NUTRITION_LOG_MEAL_TOKEN unset" });
      return;
    }
    if (req.header("X-Nutrition-Token") !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { text, imageBase64, imageMimeType, conversationId } = req.body ?? {};
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text required" });
      return;
    }
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SB_URL || !SB_KEY) {
      res.status(500).json({ error: "supabase not configured" });
      return;
    }
    const convId = (typeof conversationId === "string" && conversationId) || "ios:nutrition";
    let uploadedPath: string | undefined;
    if (typeof imageBase64 === "string" && imageBase64.length > 0) {
      try {
        const sharp = (await import("sharp")).default;
        const inputBuf = Buffer.from(imageBase64, "base64");
        const webp = await sharp(inputBuf)
          .rotate()
          .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 55 })
          .toBuffer();
        const now = new Date();
        const yyyy = String(now.getUTCFullYear());
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const stem = `${Date.now().toString(36)}-ios`;
        uploadedPath = `${yyyy}/${mm}/${dd}/${stem}.webp`;
        const up = await fetch(`${SB_URL}/storage/v1/object/meal-photos/${uploadedPath}`, {
          method: "POST",
          headers: {
            apikey: SB_KEY,
            Authorization: `Bearer ${SB_KEY}`,
            "Content-Type": "image/webp",
            "x-upsert": "true",
          },
          body: new Uint8Array(webp),
        });
        if (!up.ok && up.status !== 200) {
          const body = await up.text();
          res.status(502).json({ error: `photo upload failed ${up.status}`, detail: body });
          return;
        }
      } catch (err) {
        res.status(500).json({ error: `photo processing failed: ${String(err)}` });
        return;
      }
    }
    const lines: string[] = [];
    lines.push("Log this meal to my nutrition tracker.");
    lines.push("");
    lines.push(text);
    if (uploadedPath) {
      lines.push("");
      lines.push(`Photo already uploaded to meal-photos bucket at: ${uploadedPath}`);
      lines.push(`Pass this as the first entry in photo_paths when you call log_meal — no need to re-upload.`);
    }
    void imageMimeType; // captured for future use if needed
    const content = lines.join("\n");
    try {
      const reply = await handleUserMessage({ conversationId: convId, content });
      res.json({ ok: true, reply, photoPath: uploadedPath ?? null });
    } catch (err) {
      console.error("[log-meal] handler error", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/sendblue", createSendblueRouter());
  app.use("/composio", createComposioRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
