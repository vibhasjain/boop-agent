import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { registerIntegration, type IntegrationModule } from "./registry.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";

function restHeaders(prefer = "return=representation"): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: prefer,
  };
}

async function sbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("nutrition: SUPABASE_URL or SUPABASE_SERVICE_KEY not set");
  }
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      ...restHeaders(),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

function textResult(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function buildNutritionMcp(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "nutrition",
    version: "0.1.0",
    tools: [
      tool(
        "log_meal",
        `Insert a meal row into Supabase. Use after estimating macros. Vibhas is on America/New_York; convert before passing date/time. Units: cal (not kcal). Six nutrients only: calories, protein, sat_fat, added_sugar, sodium, fiber.`,
        {
          name: z.string().describe("Title Case meal name, e.g. 'Tofu Rice Bowl'."),
          date: z.string().describe("YYYY-MM-DD in America/New_York."),
          time: z.string().describe("HH:MM 24-hour in America/New_York."),
          macros: z
            .object({
              calories: z.number(),
              protein: z.number(),
              sat_fat: z.number(),
              added_sugar: z.number(),
              sodium: z.number(),
              fiber: z.number(),
            })
            .describe("Six nutrients. calories in cal; protein/sat_fat/added_sugar/fiber in g; sodium in mg."),
          photo_paths: z
            .array(z.string())
            .optional()
            .default([])
            .describe("Storage paths in meal-photos bucket, hero first. e.g. ['2026/05/22/2121-bowl.webp']."),
          notes: z.string().optional().describe("Only set if context worth preserving; usually null."),
        },
        async (args) => {
          const row = {
            date: args.date,
            time: args.time,
            name: args.name,
            macros: args.macros,
            photo_paths: args.photo_paths ?? [],
            notes: args.notes ?? null,
          };
          const resp = await sbFetch("/rest/v1/meals", {
            method: "POST",
            body: JSON.stringify(row),
          });
          if (!resp.ok) {
            const body = await resp.text();
            return textResult(`log_meal failed ${resp.status}: ${body}`);
          }
          const data = (await resp.json()) as Array<{ id: string }>;
          return textResult(
            `Logged "${args.name}" — ${args.macros.calories} cal, ${args.macros.protein}g protein. id=${data[0]?.id ?? "?"}`,
          );
        },
      ),

      tool(
        "find_meal",
        "Look up meals by date and optional name partial. Use to re-log a past meal (reuse its photo_paths + macros verbatim).",
        {
          date: z.string().describe("YYYY-MM-DD"),
          name_partial: z.string().optional().describe("ILIKE on meal name, e.g. 'ragu'."),
        },
        async (args) => {
          const params = new URLSearchParams({
            select: "id,date,time,name,macros,photo_paths,notes",
            date: `eq.${args.date}`,
            order: "time.asc",
          });
          if (args.name_partial) params.set("name", `ilike.*${args.name_partial}*`);
          const resp = await sbFetch(`/rest/v1/meals?${params}`);
          if (!resp.ok) return textResult(`find_meal failed ${resp.status}: ${await resp.text()}`);
          const rows = (await resp.json()) as unknown[];
          return textResult(JSON.stringify(rows, null, 2));
        },
      ),

      tool(
        "list_favorites",
        "List all favorites (the product database). Check this first whenever a meal references a known item — reuse its photo_path and per-serving macros.",
        {},
        async () => {
          const resp = await sbFetch(`/rest/v1/favorites?select=slug,name,photo_path,serving,macros&order=slug.asc`);
          if (!resp.ok) return textResult(`list_favorites failed ${resp.status}: ${await resp.text()}`);
          const rows = (await resp.json()) as unknown[];
          return textResult(JSON.stringify(rows, null, 2));
        },
      ),

      tool(
        "upload_meal_photo",
        `Fetch an image from a URL (typically a Sendblue MMS media_url), optimize to WebP ≤720px long-side q55, upload to the meal-photos bucket at YYYY/MM/DD/HHMM-slug.webp, and return the storage path. Use this whenever the user attaches a photo to a meal.`,
        {
          image_url: z.string().describe("Publicly fetchable URL (Sendblue media_url or similar)."),
          date: z.string().describe("YYYY-MM-DD — used to build the path."),
          time: z.string().describe("HHMM (4 digits, e.g. '2121') — used as filename prefix."),
          slug: z.string().describe("Short slug for the photo, e.g. 'bowl', 'pan'. Letters/digits/hyphens only."),
        },
        async (args) => {
          const sharp = (await import("sharp")).default;
          const fetched = await fetch(args.image_url);
          if (!fetched.ok) return textResult(`upload_meal_photo: fetch failed ${fetched.status}`);
          const inputBuf = Buffer.from(await fetched.arrayBuffer());
          const webp = await sharp(inputBuf)
            .rotate()
            .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 55 })
            .toBuffer();
          const [yyyy, mm, dd] = args.date.split("-");
          const path = `${yyyy}/${mm}/${dd}/${args.time}-${args.slug}.webp`;
          const up = await fetch(`${SUPABASE_URL}/storage/v1/object/meal-photos/${path}`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_SERVICE_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
              "Content-Type": "image/webp",
              "x-upsert": "true",
            },
            body: new Uint8Array(webp),
          });
          if (!up.ok && up.status !== 200) {
            return textResult(`upload failed ${up.status}: ${await up.text()}`);
          }
          return textResult(`uploaded ${path} (${webp.byteLength} bytes)`);
        },
      ),

      tool(
        "save_favorite",
        "Upsert a favorite (product database row). Use when first researching a new ingredient/product so it never gets re-researched.",
        {
          slug: z.string().describe("url-safe lowercase-hyphenated"),
          name: z.string().describe("Title Case display name"),
          photo_path: z.string().optional().describe("favorites/<slug>.webp"),
          serving: z
            .object({ amount: z.number(), unit: z.string() })
            .optional()
            .describe("Omit for composed-meal snapshots; set for per-100g/100ml/per-unit products."),
          macros: z.object({
            calories: z.number(),
            protein: z.number(),
            sat_fat: z.number(),
            added_sugar: z.number(),
            sodium: z.number(),
            fiber: z.number(),
          }),
        },
        async (args) => {
          const resp = await sbFetch(`/rest/v1/favorites?on_conflict=slug`, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify(args),
          });
          if (!resp.ok) return textResult(`save_favorite failed ${resp.status}: ${await resp.text()}`);
          return textResult(`saved favorite "${args.slug}"`);
        },
      ),
    ],
  });
}

export const nutritionIntegration: IntegrationModule = {
  name: "nutrition",
  description:
    "Vibhas's self-hosted nutrition tracker. Log meals + photos to Supabase, look up favorites, find past meals. Always check favorites first; convert to America/New_York; six nutrients only.",
  requiredEnv: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
  createServer: async () => buildNutritionMcp(),
};

export function registerNutrition(): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log("[nutrition] disabled — SUPABASE_URL / SUPABASE_SERVICE_KEY not set");
    return;
  }
  registerIntegration(nutritionIntegration);
  console.log("[nutrition] registered");
}
