/**
 * Dana Bulletin Ingestion Script
 * Downloads IMD Cyclone Dana bulletins (Oct 2024), parses them into
 * timestamped chunks, and upserts into Qdrant with full metadata.
 *
 * Stack: Node.js + pdf-parse + OpenAI embeddings + Qdrant
 *
 * Usage:
 *   node ingestDanaBulletins.js
 *   node ingestDanaBulletins.js --dry-run   (parse only, no upsert)
 */

// pdf-parse v1 is CJS-only — use createRequire to load it in an ESM context.
// v1 exports a single async function: pdfParse(buffer) → { text, numpages, ... }
// If you have v2 installed, downgrade: npm install pdf-parse@1.1.1
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

// ─── SHARED CONFIG ────────────────────────────────────────────────────────────
// Single pool + client shared across the entire app — no duplicate connections.

import { connectPostgres, query } from "../config/postgres.js";
import qdrantClient, { COLLECTION, connectQdrant } from "../config/qdrant.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

// ─── URL MAP ──────────────────────────────────────────────────────────────────
// All 31 Dana bulletin URLs confirmed from links.txt (download.php format).
// This format bypasses hash-in-path issues — the server resolves the file by
// the path= query param. Filenames use spaces (not %20) in this endpoint.

const DOWNLOAD_BASE = "https://rsmcnewdelhi.imd.gov.in/download.php?path=uploads/archive/1/";

const BULLETIN_URLS = {
  "SM1": `${DOWNLOAD_BASE}1_f05df7_1.Special Message No 1-20Oct2024_0830IST.pdf`,
  "SM2": `${DOWNLOAD_BASE}1_f6d9bc_2.Special Message No 2-21Oct2024_0830IST.pdf`,
  "SM3": `${DOWNLOAD_BASE}1_ba3068_3.Special Message No 3-21Oct2024_1130IST.pdf`,
  1:     `${DOWNLOAD_BASE}1_3537f0_1.National Bulletin No 1-22Oct2024_0530IST.pdf`,
  2:     `${DOWNLOAD_BASE}1_e500de_2.National Bulletin No 2-22Oct2024_0830IST.pdf`,
  3:     `${DOWNLOAD_BASE}1_a055a8_3.National Bulletin No 3-22Oct2024_1130IST.pdf`,
  4:     `${DOWNLOAD_BASE}1_a2de84_4.National Bulletin No 4-22Oct2024_1730IST.pdf`,
  5:     `${DOWNLOAD_BASE}1_f2aaa9_5.National Bulletin No 5-22Oct2024_2330IST.pdf`,
  6:     `${DOWNLOAD_BASE}1_69e42d_6.National Bulletin No 6-23Oct2024_0530IST.pdf`,
  7:     `${DOWNLOAD_BASE}1_785b63_7.National Bulletin No 7-23Oct2024_0830IST.pdf`,
  8:     `${DOWNLOAD_BASE}1_0775e4_8.National Bulletin No 8-23Oct2024_1130IST.pdf`,
  9:     `${DOWNLOAD_BASE}1_4c1a3c_9.National Bulletin No 9-23Oct2024_1430IST.pdf`,
  10:    `${DOWNLOAD_BASE}1_1dcc4d_10.National Bulletin No 10-23Oct2024_1730IST.pdf`,
  11:    `${DOWNLOAD_BASE}1_ff10f6_11.National Bulletin No 11-23Oct2024_2030IST.pdf`,
  12:    `${DOWNLOAD_BASE}1_cc7ffd_12.National Bulletin No 12-23Oct2024_2330IST.pdf`,
  13:    `${DOWNLOAD_BASE}1_a64af8_13.National Bulletin No 13-24Oct2024_0530IST.pdf`,
  14:    `${DOWNLOAD_BASE}1_f46427_14.National Bulletin No 14-24Oct2024_0530IST.pdf`,
  15:    `${DOWNLOAD_BASE}1_d4d420_15.National Bulletin No 15-24Oct2024_0830IST.pdf`,
  16:    `${DOWNLOAD_BASE}1_485fc5_16.National Bulletin No 16-24Oct2024_1130IST.pdf`,
  17:    `${DOWNLOAD_BASE}1_48ad02_17.National Bulletin No 17-24Oct2024_1430IST.pdf`,
  18:    `${DOWNLOAD_BASE}1_b68cb8_18.National Bulletin No 18-24Oct2024_1730IST.pdf`,
  19:    `${DOWNLOAD_BASE}1_850bd4_19.National Bulletin No 19-24Oct2024_2030IST.pdf`,
  21:    `${DOWNLOAD_BASE}1_b89e9b_21.National Bulletin No 21-25Oct2024_0230IST.pdf`,
  22:    `${DOWNLOAD_BASE}1_c90ce9_22.National Bulletin No 22-25Oct2024_0530IST.pdf`,
  23:    `${DOWNLOAD_BASE}1_c9d7f7_23.National Bulletin No 23-25Oct2024_0830IST.pdf`,
  24:    `${DOWNLOAD_BASE}1_63f0a7_24.National Bulletin No 24-25Oct2024_1130IST.pdf`,
  25:    `${DOWNLOAD_BASE}1_50726d_25.National Bulletin No 25-25Oct2024_1430IST.pdf`,
  26:    `${DOWNLOAD_BASE}1_7e71ca_26.National Bulletin No 26-25Oct2024_1730IST.pdf`,
  27:    `${DOWNLOAD_BASE}1_9b905e_27.National Bulletin No 27-25Oct2024_2330IST.pdf`,
  28:    `${DOWNLOAD_BASE}1_72c69d_28.National Bulletin No 28-26Oct2024_0530IST.pdf`,
};

/** Return confirmed download URL for a bulletin key, or null if unknown. */
function buildUrl(key) {
  return BULLETIN_URLS[key] ?? null;
}

// ─── DANA BULLETIN MANIFEST ───────────────────────────────────────────────────
// Complete set: 3 Special Messages + 28 National Bulletins = 31 total
// Covers: 20 Oct (pre-watch) → 26 Oct (post-landfall weakening)
// Only scheduling/classification data here. All operational facts (wind speed,
// position, districts, surge) are extracted from the PDF text at runtime.
//
// Phase classification:
//   pre_watch      SM1–SM3   20–21 Oct  LPA / Well-marked low / Depression forming
//   watch          1–5       22 Oct     Deep Depression; Yellow Warning
//   orange_warning 6–12      23 Oct     Cyclonic Storm Dana; Orange Warning
//   red_warning    13–19     24 Oct     Severe Cyclonic Storm; Red Warning
//   landfall       20–21     25 Oct 0030–0230 IST  Eye crossing Dhamra coast
//   post_landfall  22–28     25–26 Oct  Weakening inland; relief phase

const DANA_BULLETINS = [
  // ── Special Messages ─────────────────────────────────────────────────────
  { bulletin_no: "SM1", valid_as_of: "2024-10-20T08:30:00+05:30", phase: "pre_watch",      warning_level: "YELLOW" },
  { bulletin_no: "SM2", valid_as_of: "2024-10-21T08:30:00+05:30", phase: "pre_watch",      warning_level: "YELLOW" },
  { bulletin_no: "SM3", valid_as_of: "2024-10-21T11:30:00+05:30", phase: "pre_watch",      warning_level: "YELLOW" },

  // ── National Bulletins 1–5 (Yellow Watch, 22 Oct) ───────────────────────
  { bulletin_no: 1,  valid_as_of: "2024-10-22T05:30:00+05:30", phase: "watch",          warning_level: "YELLOW" },
  { bulletin_no: 2,  valid_as_of: "2024-10-22T08:30:00+05:30", phase: "watch",          warning_level: "YELLOW" },
  { bulletin_no: 3,  valid_as_of: "2024-10-22T11:30:00+05:30", phase: "watch",          warning_level: "YELLOW" },
  { bulletin_no: 4,  valid_as_of: "2024-10-22T17:30:00+05:30", phase: "watch",          warning_level: "YELLOW" },
  { bulletin_no: 5,  valid_as_of: "2024-10-22T23:30:00+05:30", phase: "watch",          warning_level: "YELLOW" },

  // ── National Bulletins 6–12 (Orange Warning, 23 Oct) ────────────────────
  { bulletin_no: 6,  valid_as_of: "2024-10-23T05:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE", is_key_eval_bulletin: true },
  { bulletin_no: 7,  valid_as_of: "2024-10-23T08:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE" },
  { bulletin_no: 8,  valid_as_of: "2024-10-23T11:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE", is_key_eval_bulletin: true },
  { bulletin_no: 9,  valid_as_of: "2024-10-23T14:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE" },
  { bulletin_no: 10, valid_as_of: "2024-10-23T17:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE" },
  { bulletin_no: 11, valid_as_of: "2024-10-23T20:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE" },
  { bulletin_no: 12, valid_as_of: "2024-10-23T23:30:00+05:30", phase: "orange_warning", warning_level: "ORANGE", is_key_eval_bulletin: true },

  // ── National Bulletins 13–19 (Red Warning, 24 Oct) ──────────────────────
  { bulletin_no: 13, valid_as_of: "2024-10-24T05:30:00+05:30", phase: "red_warning",    warning_level: "RED" },
  { bulletin_no: 14, valid_as_of: "2024-10-24T05:30:00+05:30", phase: "red_warning",    warning_level: "RED",    is_key_eval_bulletin: true },
  { bulletin_no: 15, valid_as_of: "2024-10-24T08:30:00+05:30", phase: "red_warning",    warning_level: "RED" },
  { bulletin_no: 16, valid_as_of: "2024-10-24T11:30:00+05:30", phase: "red_warning",    warning_level: "RED" },
  { bulletin_no: 17, valid_as_of: "2024-10-24T14:30:00+05:30", phase: "red_warning",    warning_level: "RED",    is_key_eval_bulletin: true },
  { bulletin_no: 18, valid_as_of: "2024-10-24T17:30:00+05:30", phase: "red_warning",    warning_level: "RED" },
  { bulletin_no: 19, valid_as_of: "2024-10-24T20:30:00+05:30", phase: "red_warning",    warning_level: "RED",    is_key_eval_bulletin: true },

  // ── Landfall Bulletins 20–21 (25 Oct 0030–0230 IST) ─────────────────────
  // Note: bulletin 20 is missing from links.txt — 21 is the first post-midnight one
  { bulletin_no: 21, valid_as_of: "2024-10-25T02:30:00+05:30", phase: "landfall",       warning_level: "RED",    is_key_eval_bulletin: true },

  // ── Post-landfall Bulletins 22–28 (25–26 Oct) ───────────────────────────
  { bulletin_no: 22, valid_as_of: "2024-10-25T05:30:00+05:30", phase: "post_landfall",  warning_level: "ORANGE" },
  { bulletin_no: 23, valid_as_of: "2024-10-25T08:30:00+05:30", phase: "post_landfall",  warning_level: "ORANGE" },
  { bulletin_no: 24, valid_as_of: "2024-10-25T11:30:00+05:30", phase: "post_landfall",  warning_level: "YELLOW" },
  { bulletin_no: 25, valid_as_of: "2024-10-25T14:30:00+05:30", phase: "post_landfall",  warning_level: "YELLOW" },
  { bulletin_no: 26, valid_as_of: "2024-10-25T17:30:00+05:30", phase: "post_landfall",  warning_level: "YELLOW" },
  { bulletin_no: 27, valid_as_of: "2024-10-25T23:30:00+05:30", phase: "post_landfall",  warning_level: "YELLOW" },
  { bulletin_no: 28, valid_as_of: "2024-10-26T05:30:00+05:30", phase: "post_landfall",  warning_level: "GREEN"  },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// ─── PDF TEXT PARSER ─────────────────────────────────────────────────────────
// Extracts structured operational facts from raw IMD bulletin text.
// All values come from the actual PDF — nothing is hardcoded or assumed.

const ODISHA_DISTRICTS = [
  "Balasore", "Bhadrak", "Kendrapara", "Jagatsinghpur", "Puri", "Khorda",
  "Cuttack", "Jajpur", "Mayurbhanj", "Keonjhar", "Dhenkanal", "Angul",
  "Nayagarh", "Ganjam", "Gajapati", "Rayagada", "Koraput", "Malkangiri",
  "Nabarangpur", "Kalahandi", "Kandhamal", "Bolangir", "Bargarh", "Jharsuguda",
  "Sambalpur", "Sundergarh", "Kendujhar", "Nuapada", "Boudh", "Subarnapur",
];

const WB_DISTRICTS = [
  "East Medinipur", "West Medinipur", "South 24 Parganas", "North 24 Parganas",
  "Howrah", "Hooghly", "Kolkata", "Bankura", "Jhargram", "Purba Medinipur",
  "Paschim Medinipur",
];

function parseBulletinText(text) {
  if (!text) return {};

  const facts = {};

  // ── Special case: final dissipation bulletin (e.g. bulletin 28) ──────────
  // These have "Warnings: NIL" and no forecast table — system has dissipated.
  if (/Warnings:\s*NIL/i.test(text) || /weakened into a well marked low pressure/i.test(text)) {
    facts.system_dissipated = true;
    facts.phase_note = "System dissipated — last bulletin";
    // Still try to extract any district mentions for completeness
    const allDistricts = [...ODISHA_DISTRICTS, ...WB_DISTRICTS];
    const found = allDistricts.filter(d => new RegExp(`\\b${d}\\b`, "i").test(text));
    if (found.length > 0) facts.districts_affected = found;
    return facts;
  }

  // ── Current wind speed ────────────────────────────────────────────────────
  // IMD bulletins have a forecast table where the FIRST row = current position.
  // Pattern: "DD.MM.YY/HHMM  LAT/LON  WINDLO-WINDHI gusting to GUST  CATEGORY"
  //
  // CRITICAL EDGE CASE (Bulletin 21 — landfall bulletin):
  // The table's first row timestamp (24.10.24/2330) is the PREVIOUS observation,
  // not the bulletin issue time (0450 IST 25 Oct). This is because IMD backdates
  // the first row to the last clean fix before landfall.
  // For landfall bulletins, the authoritative wind is in the narrative:
  // "crossed ... as a severe cyclonic storm with a wind speed of 100-110 kmph gusting to 120 kmph"
  // We detect this with the "crossed" keyword and use that wind instead.

  // First try: landfall narrative (takes priority for crossed/landfall bulletins)
  const crossedWindMatch = text.match(
    /crossed[^.]*?wind speed of (\d+)[-–](\d+)\s*kmph\s+gusting\s+to\s+(\d+)\s*kmph/i
  );
  if (crossedWindMatch) {
    facts.wind_speed_kmph     = parseInt(crossedWindMatch[1]);
    facts.wind_speed_max_kmph = parseInt(crossedWindMatch[2]);
    facts.wind_gust_kmph      = parseInt(crossedWindMatch[3]);
    facts.is_landfall_wind    = true;
  } else {
    // Normal case: read wind from first forecast table row
    const tableRowMatch = text.match(
      /\d{2}\.\d{2}\.\d{2}\/\d{4}\s+[\d.]+\/[\d.]+\s+(\d+)[-–](\d+)\s*gusting\s+to\s+(\d+)/i
    );
    if (tableRowMatch) {
      facts.wind_speed_kmph     = parseInt(tableRowMatch[1]);
      facts.wind_speed_max_kmph = parseInt(tableRowMatch[2]);
      facts.wind_gust_kmph      = parseInt(tableRowMatch[3]);
    } else {
      // Fallback: scan narrative lines, skip forecast language
      for (const line of text.split("\n")) {
        if (/very likely|will intensify|expected|likely to|morning of|night of/i.test(line)) continue;
        const m = line.match(/(\d+)[-–](\d+)\s*kmph(?:\s+gusting(?:\s+to)?\s+(\d+)\s*kmph)?/i);
        if (m) {
          facts.wind_speed_kmph     = parseInt(m[1]);
          facts.wind_speed_max_kmph = parseInt(m[2]);
          if (m[3]) facts.wind_gust_kmph = parseInt(m[3]);
          break;
        }
      }
    }
  }

  // ── Distance from Paradip ─────────────────────────────────────────────────
  const paradipMatch =
    text.match(/(\d{2,4})\s*km\s+\w[\w\s-]*of\s+Paradip/i) ||
    text.match(/Paradip[^.]{0,60}?(\d{3,4})\s*km/i);
  if (paradipMatch) facts.distance_from_paradip_km = parseInt(paradipMatch[1]);

  // ── Storm surge ───────────────────────────────────────────────────────────
  const surgeMatch = text.match(/storm surge[^.]*?(\d+(?:\.\d+)?)\s*(?:to\s*(\d+(?:\.\d+)?)\s*)?m(?:eter)?/i);
  if (surgeMatch) facts.storm_surge_m = parseFloat(surgeMatch[2] || surgeMatch[1]);

  // ── Current position (lat/lon) ────────────────────────────────────────────
  // "lay centred at HH30 hrs IST ... near latitude X N longitude Y E"
  // Bulletin 21 has two "lay centred" lines (0230 and 0330 fixes).
  // We want the FIRST one (earliest/primary fix at bulletin issue time).
  const posMatch =
    text.match(/lay centred[^.]*?latitude\s+(\d+(?:\.\d+)?)[°\s]*N[^\d]*longitude\s+(\d+(?:\.\d+)?)[°\s]*E/i) ||
    text.match(/near\s+latitude\s+(\d+(?:\.\d+)?)[°\s]*N[^\d]*longitude\s+(\d+(?:\.\d+)?)[°\s]*E/i);
  if (posMatch) facts.position = `${posMatch[1]}N/${posMatch[2]}E`;

  // ── Landfall location ─────────────────────────────────────────────────────
  // Confirmed landfall (bulletin 21):
  //   "crossed north Odisha coast close to Habalikhati Nature Camp (Bhitarkanika) and Dhamara"
  //   → extract the parenthetical name (Bhitarkanika) + "and Dhamara"
  // Future landfall (bulletins 1–19):
  //   "cross ... between Puri and Sagar Island" / "close to Bhitarkanika and Dhamara"
  const crossedMatch = text.match(
    /crossed[^.]*?close\s+to\s+[A-Z][^(]*\(([A-Z][a-zA-Z]+)\)[^.]*?and\s+([A-Z][a-zA-Z]+)/i
  ) || text.match(
    /crossed[^.]*?close\s+to\s+([A-Z][a-zA-Z]+)(?:[^.]*?and\s+([A-Z][a-zA-Z]+))?/i
  );
  const futureMatch = text.match(
    /cross\s+[^.]*?(?:between|near|close to)\s+([A-Z][a-zA-Z]+)(?:[^.]*?and\s+([A-Z][a-zA-Z]+))?/i
  );
  if (crossedMatch) {
    facts.landfall_location = crossedMatch[2]
      ? `${crossedMatch[1].trim()}-${crossedMatch[2].trim()}`
      : crossedMatch[1].trim();
    facts.landfall_confirmed = true;
  } else if (futureMatch && futureMatch[2]) {
    facts.landfall_location = `${futureMatch[1].trim()}-${futureMatch[2].trim()}`;
  } else if (futureMatch) {
    facts.landfall_location = futureMatch[1].trim();
  }

  // ── Affected districts ────────────────────────────────────────────────────
  const allDistricts = [...ODISHA_DISTRICTS, ...WB_DISTRICTS];
  const found = allDistricts.filter(d =>
    new RegExp(`\\b${d}\\b`, "i").test(text)
  );
  if (found.length > 0) facts.districts_affected = found;

  return facts;
}

function buildBulletinText(bulletin, parsedText, facts = {}) {
  /**
   * Constructs the embedding text for a bulletin.
   * Operational facts (wind, districts, surge, position) come from
   * parseBulletinText() applied to the real PDF — never from hardcoded values.
   */
  const wind = facts.wind_speed_kmph
    ? `${facts.wind_speed_kmph}${facts.wind_speed_max_kmph ? `–${facts.wind_speed_max_kmph}` : ""} kmph${facts.wind_gust_kmph ? ` gusting ${facts.wind_gust_kmph} kmph` : ""}`
    : "Not yet assessed";

  const meta = [
    `IMD CYCLONE DANA NATIONAL BULLETIN NO. ${bulletin.bulletin_no}`,
    `Issue Time: ${bulletin.valid_as_of}`,
    `Warning Level: ${bulletin.warning_level}`,
    `Phase: ${bulletin.phase.replace(/_/g, " ").toUpperCase()}`,
    `Wind Speed: ${wind}`,
    facts.distance_from_paradip_km != null ? `Distance from Paradip: ${facts.distance_from_paradip_km} km` : null,
    facts.position ? `Position: ${facts.position}` : null,
    facts.storm_surge_m ? `Storm Surge: ${facts.storm_surge_m}m above astronomical tide` : null,
    facts.landfall_location ? `Landfall: ${facts.landfall_location}` : null,
    facts.districts_affected?.length ? `Affected Districts: ${facts.districts_affected.join(", ")}` : null,
    "",
    "--- BULLETIN TEXT ---",
    parsedText || "(PDF text extraction pending — using metadata stub)",
  ]
    .filter(Boolean)
    .join("\n");

  return meta;
}

function chunkText(text, chunkSize = 800, overlap = 150) {
  /**
   * Splits bulletin text into overlapping chunks for embedding.
   * 800 tokens ≈ 600 words — matches our FAISS/Qdrant chunk strategy.
   */
  const words = text.split(/\s+/);
  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

async function getEmbedding(text, openai) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });
  return response.data[0].embedding;
}

// ─── PDF LOADING ─────────────────────────────────────────────────────────────
// Strategy (in order):
//   1. Local file  — if LOCAL_BULLETINS_DIR env var is set, look for the PDF
//                    in that folder by bulletin number. Fastest, no network.
//   2. Remote URL  — fetch from RSMC download endpoint. Works from your Mac;
//                    blocked from some cloud/sandbox IPs (RSMC IP allowlist).
//   3. Stub        — if both fail, build a metadata-only chunk (no PDF text).
//
// To use local files, set the env var before running:
//   export LOCAL_BULLETINS_DIR=/Users/harshalrawal/Downloads
//   node src/ingestion/ingestDanaBulletins.js

import fs from "fs";
import path from "path";

const LOCAL_DIR = process.env.LOCAL_BULLETINS_DIR || null;

/** Find a local PDF file for a bulletin key by scanning LOCAL_DIR for the hash prefix */
function findLocalPDF(bulletinKey) {
  if (!LOCAL_DIR) return null;
  try {
    const files = fs.readdirSync(LOCAL_DIR);
    // Match any file containing the bulletin's hash (first 6 chars after "1_")
    const url = BULLETIN_URLS[bulletinKey];
    if (!url) return null;
    const hashMatch = url.match(/1_([a-f0-9]+)_/i);
    if (!hashMatch) return null;
    const hash = hashMatch[1];
    const match = files.find(f => f.includes(hash));
    return match ? path.join(LOCAL_DIR, match) : null;
  } catch {
    return null;
  }
}

async function parsePDFBuffer(buffer) {
  const data = await pdfParse(buffer);
  return data.text.trim();
}

async function fetchAndParsePDF(bulletinKey) {
  // ── 1. Try local file ────────────────────────────────────────────────────
  const localPath = findLocalPDF(bulletinKey);
  if (localPath) {
    try {
      console.log(`  → Reading local file: ${path.basename(localPath)}`);
      const buffer = fs.readFileSync(localPath);
      return await parsePDFBuffer(buffer);
    } catch (err) {
      console.warn(`  ✗ Local read failed: ${err.message}`);
    }
  }

  // ── 2. Try remote URL ────────────────────────────────────────────────────
  const url = BULLETIN_URLS[bulletinKey];
  if (!url) return null;

  try {
    console.log(`  → Fetching ${url.slice(0, 90)}...`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://rsmcnewdelhi.imd.gov.in/",
        "Accept": "application/pdf,*/*",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`  ✗ HTTP ${res.status} — ${res.status === 403 ? "IP blocked by RSMC (set LOCAL_BULLETINS_DIR)" : "server error"}`);
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("pdf") && !ct.includes("octet")) {
      console.warn(`  ✗ Unexpected content-type: ${ct}`);
      return null;
    }
    return await parsePDFBuffer(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn(`  ✗ Fetch failed: ${err.message}`);
    return null;
  }
}

// ─── POSTGRES REGISTRY ────────────────────────────────────────────────────────

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS realtime_feed (
      id            SERIAL PRIMARY KEY,
      source        TEXT NOT NULL,
      event_id      TEXT NOT NULL,
      bulletin_no   TEXT,
      fetched_at    TIMESTAMPTZ DEFAULT NOW(),
      valid_as_of   TIMESTAMPTZ NOT NULL,
      raw_content   TEXT,
      embedded      BOOLEAN DEFAULT FALSE,
      qdrant_ids    TEXT[],
      warning_level TEXT,
      phase         TEXT,
      expires_at    TIMESTAMPTZ,
      UNIQUE(source, event_id, bulletin_no)
    );
    -- Migrate existing INTEGER column to TEXT if needed (idempotent)
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'realtime_feed'
          AND column_name = 'bulletin_no'
          AND data_type = 'integer'
      ) THEN
        ALTER TABLE realtime_feed ALTER COLUMN bulletin_no TYPE TEXT USING bulletin_no::TEXT;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_realtime_expires ON realtime_feed(expires_at);
    CREATE INDEX IF NOT EXISTS idx_realtime_embedded ON realtime_feed(embedded);
  `);
  console.log("✓ Postgres schema ready");
}

async function isAlreadyIngested(bulletinNo) {
  const rows = await query(
    "SELECT id FROM realtime_feed WHERE source = 'imd_dana' AND bulletin_no = $1 AND embedded = TRUE",
    [bulletinNo]
  );
  return rows.length > 0;
}

async function recordIngestion(bulletin, qdrantIds, rawText) {
  await query(
    `INSERT INTO realtime_feed 
      (source, event_id, bulletin_no, valid_as_of, raw_content, embedded, qdrant_ids, warning_level, phase, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source, event_id, bulletin_no) DO UPDATE
       SET embedded = TRUE, qdrant_ids = $7, fetched_at = NOW()`,
    [
      "imd_dana",
      "cyclone_dana_2024",
      bulletin.bulletin_no,
      bulletin.valid_as_of,
      rawText?.substring(0, 2000) || null,
      true,
      qdrantIds,
      bulletin.warning_level,
      bulletin.phase,
      null, // Dana bulletins are historical — no TTL expiry
    ]
  );
}

// ─── QDRANT UPSERT ────────────────────────────────────────────────────────────

async function ensureQdrantCollection() {
  try {
    await qdrantClient.getCollection(COLLECTION);
    console.log(`✓ Qdrant collection '${COLLECTION}' exists`);
  } catch {
    await qdrantClient.createCollection(COLLECTION, {
      vectors: { size: 1536, distance: "Cosine" },
    });
    console.log(`✓ Created Qdrant collection '${COLLECTION}'`);
  }
}

async function upsertChunks(chunks, bulletin, facts = {}) {
  const points = chunks.map((chunkText, idx) => ({
    id: uuidv4(),
    vector: chunkText._embedding,
    payload: {
      // ── Content ──────────────────────────────────────────────────
      text: chunkText.text,
      chunk_index: idx,
      total_chunks: chunks.length,

      // ── Temporal ─────────────────────────────────────────────────
      valid_as_of: bulletin.valid_as_of,
      source_date: bulletin.valid_as_of,

      // ── Source authority (used by CRAG evaluator) ─────────────────
      source: "imd_dana",
      source_authority: "verified_gov",
      source_type: "realtime_bulletin",
      document_id: `dana_bulletin_${bulletin.bulletin_no}`,
      event_id: "cyclone_dana_2024",

      // ── Disaster metadata ─────────────────────────────────────────
      disaster_type: "cyclone",
      region: "odisha",
      country: "india",
      bulletin_no: bulletin.bulletin_no,
      phase: bulletin.phase,
      warning_level: bulletin.warning_level,
      is_key_eval_bulletin: bulletin.is_key_eval_bulletin || false,

      // ── Operational facts extracted from PDF ──────────────────────
      // These are null when the PDF was unavailable (metadata stub)
      districts_affected:        facts.districts_affected        ?? null,
      wind_speed_kmph:           facts.wind_speed_kmph           ?? null,
      wind_speed_max_kmph:       facts.wind_speed_max_kmph       ?? null,
      wind_gust_kmph:            facts.wind_gust_kmph            ?? null,
      distance_from_paradip_km:  facts.distance_from_paradip_km  ?? null,
      storm_surge_m:             facts.storm_surge_m             ?? null,
      position:                  facts.position                  ?? null,
      landfall_location:         facts.landfall_location         ?? null,
      landfall_confirmed:        facts.landfall_confirmed        ?? false,
      system_dissipated:         facts.system_dissipated         ?? false,
      pdf_parsed:                Object.keys(facts).length > 0,

      // ── Retrieval scoring ─────────────────────────────────────────
      recency_weight: 1.0,
      ttl_hours: null,
    },
  }));

  await qdrantClient.upsert(COLLECTION, { points });
  return points.map((p) => p.id);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  Cyclone Dana — IMD Bulletin Ingestion Script");
  console.log("  Disaster RAG Platform — Real-time Data Layer");
  console.log("=".repeat(60));
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no upsert)" : "LIVE"}\n`);

  // ── Init clients via shared config ────────────────────────────────────────
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  if (!DRY_RUN) {
    await connectPostgres();       // verifies pool; throws if DB unreachable
    await connectQdrant();         // warns if collection missing, does not throw
    await ensureSchema();
    await ensureQdrantCollection();
  }

  // ── Process each bulletin ─────────────────────────────────────────────────
  const results = { ingested: 0, skipped: 0, failed: 0 };

  for (const bulletin of DANA_BULLETINS) {
    console.log(`\nBulletin ${bulletin.bulletin_no} | ${bulletin.warning_level} | ${bulletin.valid_as_of}`);

    // Deduplication check
    if (!DRY_RUN) {
      const already = await isAlreadyIngested(bulletin.bulletin_no);
      if (already) {
        console.log(`  ↷ Already ingested — skipping`);
        results.skipped++;
        continue;
      }
    }

    // Load PDF: tries local file first, then RSMC remote URL
    const pdfText = await fetchAndParsePDF(bulletin.bulletin_no);

    // Extract operational facts from PDF text (wind, districts, surge, etc.)
    const facts = parseBulletinText(pdfText);
    const factCount = Object.keys(facts).length;
    const fullText = buildBulletinText(bulletin, pdfText, facts);

    // Chunk text
    const rawChunks = chunkText(fullText);
    console.log(`  ✓ ${rawChunks.length} chunks from ${pdfText ? `PDF text (${factCount} facts extracted)` : "metadata stub"}`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would embed ${rawChunks.length} chunks and upsert to Qdrant`);
      console.log(`  Sample chunk:\n  "${rawChunks[0].substring(0, 200)}..."`);
      continue;
    }

    // Embed each chunk
    const embeddedChunks = [];
    for (const [i, chunk] of rawChunks.entries()) {
      try {
        const embedding = await getEmbedding(chunk, openai);
        embeddedChunks.push({ text: chunk, _embedding: embedding });
      } catch (err) {
        console.error(`  ✗ Embedding failed for chunk ${i}: ${err.message}`);
        results.failed++;
        continue;
      }
    }

    // Upsert to Qdrant
    const qdrantIds = await upsertChunks(embeddedChunks, bulletin, facts);
    console.log(`  ✓ Upserted ${qdrantIds.length} vectors to Qdrant`);

    // Record in Postgres
    await recordIngestion(bulletin, qdrantIds, pdfText);
    console.log(`  ✓ Recorded in Postgres registry`);

    results.ingested++;

    // Rate limit: 1 bulletin per 2 seconds to avoid API throttling
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`  INGESTION COMPLETE`);
  console.log(`  Ingested: ${results.ingested}  |  Skipped: ${results.skipped}  |  Failed: ${results.failed}`);
  console.log("=".repeat(60));

  if (!DRY_RUN) {
    // Pool is shared — do not call pool.end() here; let the process exit naturally.
    console.log("\n✓ Dana bulletins ready in Qdrant.");
    console.log("  Run Dana Replay with: node danaReplay.js");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});