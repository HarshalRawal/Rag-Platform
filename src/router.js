// src/router.js
//
// Stage 5 — Query Router
//
// Takes a user question and returns results from the right data source(s):
//   "vector"  → Qdrant semantic search only
//   "sql"     → Postgres exact lookup only
//   "hybrid"  → both Qdrant + Postgres, merged
//
// Exported API:
//   route(question)  → { mode, vectorResults?, sqlResults?, tables?, reasoning }
//
// Used by: src/query.js (Stage 6)

import "dotenv/config";
import OpenAI from "openai";

// ── Shared connections from config (initialised once at boot in index.js) ─────
import pool from "./config/postgres.js";
import qdrant, { COLLECTION } from "./config/qdrant.js";

// ── Config ────────────────────────────────────────────────────────────────────

const EMBED_MODEL = "text-embedding-3-small";
const TOP_K       = 5;   // Qdrant results to fetch

// ── Clients ───────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Routing keyword lists (from metadata_schema.json retrieval_hints) ─────────

const SQL_KEYWORDS = [
  "how many", "how much", "total", "count of", "amount",
  "rate", "rupees", "rs.", "number of", "which district",
  "list all", "statistics", "data on", "figures for",
  "percentage", "percent", "km", "kilometres",
];

const VECTOR_KEYWORDS = [
  "how to", "what is the procedure", "who is responsible",
  "explain", "describe", "what should", "why", "what are",
  "responsibilities", "role of", "sop", "protocol",
  "steps", "measures", "guidelines", "plan for",
];

// ── Table registry ─────────────────────────────────────────────────────────────
// Maps each Postgres table to its columns and keyword hints.
// Used by the SQL generator to build the right query.

const TABLE_REGISTRY = {
  sdmp_table_1_1_agro_climatic_zones: {
    description: "10 agro-climatic zones of Odisha with districts, climate, rainfall, soil groups",
    columns: ["zone_no", "zone_name", "districts", "climate", "mean_annual_rainfall_mm", "soil_groups"],
    keywords: ["agro", "climatic zone", "zone", "rainfall", "soil", "climate", "agricultural"],
  },
  sdmp_table_2_1_hazard_vulnerability_pct: {
    description: "Percentage of Odisha area vulnerable to flood, cyclone, earthquake",
    columns: ["hazard_type", "category", "percentage"],
    keywords: ["vulnerable", "vulnerability", "flood prone", "cyclone prone", "earthquake risk", "percentage"],
  },
  sdmp_table_2_2_disaster_timeline: {
    description: "Year-by-year major calamities in Odisha 1996-2015",
    columns: ["year", "calamity", "remarks"],
    keywords: ["timeline", "history", "calamit", "year", "when did", "past disaster", "occurred"],
  },
  sdmp_table_2_3_disaster_statistics: {
    description: "Disaster statistics 2006-2018: deaths, affected population, houses damaged, crop damage",
    columns: ["disaster", "year", "districts_affected", "villages_affected", "deaths",
              "affected_population", "livestock_loss", "houses_damaged", "crop_damage_hectares"],
    keywords: ["deaths", "killed", "affected", "houses damaged", "livestock", "crop damage",
               "statistics", "data", "people affected", "casualties"],
  },
  sdmp_table_2_4_rainfall_frequency_by_decade: {
    description: "Frequency of annual rainfall intervals per decade 1950s-1990s",
    columns: ["rainfall_interval_mm", "1950s", "1960s", "1970s", "1980s", "1990s"],
    keywords: ["rainfall frequency", "rainfall decade", "annual rainfall", "mm rainfall"],
  },
  sdmp_table_2_5_seismic_zones_by_district: {
    description: "All 30 Odisha districts classified by seismic zone II or III",
    columns: ["district", "seismic_zone"],
    keywords: ["seismic", "earthquake zone", "zone ii", "zone iii", "zone-ii", "zone-iii",
               "seismic zone", "earthquake risk district"],
  },
  sdmp_table_2_6_industrial_hazard_areas: {
    description: "Industrial hazard areas by district with chemicals and hazard type",
    columns: ["sl_no", "area", "district", "chemicals_handled", "hazard_type"],
    keywords: ["industrial hazard", "chemical", "factory hazard", "explosion risk",
               "lpg", "petroleum", "paradeep", "industrial accident"],
  },
  sdmp_cvi_risk_classes_by_parameter: {
    description: "Coastal Vulnerability Index risk class lengths (km) by parameter",
    columns: ["parameter", "very_low_km", "low_km", "medium_km", "high_km", "very_high_km"],
    keywords: ["coastal vulnerability", "cvi", "shoreline", "coastal slope",
               "coastal elevation", "tidal", "wave height", "coastal risk"],
  },
  sdmp_cvi_odisha_summary: {
    description: "Total Odisha coastline by CVI vulnerability class",
    columns: ["cvi_class", "length_km", "pct_of_length"],
    keywords: ["coastline", "coastal length", "cvi class", "very high vulnerability",
               "coast vulnerability summary"],
  },
  sdmp_mah_factories_by_district: {
    description: "Count of Major Accident Hazard (MAH) factories per district",
    columns: ["district", "mah_factories", "factories_2cb"],
    keywords: ["mah", "major accident hazard", "factory", "factories", "industrial unit",
               "2cb", "jagatsinghpur", "angul", "jharsuguda"],
  },
  sdmp_table_5_3_trained_volunteers_2016_17: {
    description: "Count of trained disaster response volunteers by category 2016-17",
    columns: ["sl_no", "training_category", "number_trained"],
    keywords: ["volunteer", "trained", "aapda mitra", "odraf", "civil defence",
               "ncc", "nss", "home guard", "training count"],
  },
  sdmp_table_5_7_satellite_phones: {
    description: "Satellite phone numbers for District Collectors, ODRAF, SEOC, OSDMA",
    columns: ["sl_no", "holder", "designation", "satellite_phone_number"],
    keywords: ["satellite phone", "sat phone", "phone number", "contact", "collector phone",
               "emergency contact", "odraf phone", "seoc", "osdma phone"],
    access_policy: "operator_only",
  },
  sdmp_table_7_1_training_institutions: {
    description: "Disaster management training institutions in Odisha",
    columns: ["institution", "area_of_intervention", "target_audience"],
    keywords: ["training institution", "training centre", "capacity building institution",
               "ias training", "disaster training"],
  },
  sdmp_table_9_3_sdrf_norms_of_assistance: {
    description: "SDRF/NDRF relief norms: ex-gratia, disability, clothing, livelihood rates",
    columns: ["category", "item", "norm_of_assistance"],
    keywords: ["ex-gratia", "relief norm", "sdrf", "ndrf", "compensation",
               "assistance amount", "death relief", "disability relief",
               "clothing relief", "livelihood assistance", "rs.", "lakh"],
  },
};

// ── Signal detection ──────────────────────────────────────────────────────────

function detectSignals(question) {
  const q = question.toLowerCase();

  const sqlScore = SQL_KEYWORDS.filter((kw) => q.includes(kw)).length;
  const vectorScore = VECTOR_KEYWORDS.filter((kw) => q.includes(kw)).length;

  return { sqlScore, vectorScore, q };
}

// Identify which Postgres tables the question is likely targeting
function identifyTables(question) {
  const q = question.toLowerCase();
  const matches = [];

  for (const [tableName, meta] of Object.entries(TABLE_REGISTRY)) {
    const score = meta.keywords.filter((kw) => q.includes(kw.toLowerCase())).length;
    if (score > 0) {
      matches.push({ tableName, score, meta });
    }
  }

  // Sort by keyword match score descending
  return matches.sort((a, b) => b.score - a.score);
}

// ── Mode decision ─────────────────────────────────────────────────────────────

function decideMode(sqlScore, vectorScore, tableCardHits) {
  const hasSqlSignal    = sqlScore > 0 || tableCardHits.length > 0;
  const hasVectorSignal = vectorScore > 0;

  if (hasSqlSignal && hasVectorSignal) return "hybrid";
  if (hasSqlSignal)                    return "sql";
  if (hasVectorSignal)                 return "vector";

  // Default: vector (semantic search handles most general questions)
  return "vector";
}

// ── SQL builder ───────────────────────────────────────────────────────────────
// Builds a safe, parameterised SQL query for a given table and question.
// No dynamic SQL injection — all table/column names are from our registry.

function buildSql(tableName, question) {
  const meta = TABLE_REGISTRY[tableName];
  if (!meta) return null;

  const q = question.toLowerCase();
  const cols = meta.columns.map((c) => `"${c}"`).join(", ");

  // ── Table-specific query patterns ──────────────────────────────────────────

  // Seismic zones — filter by zone if mentioned
  if (tableName === "sdmp_table_2_5_seismic_zones_by_district") {
    if (q.includes("zone iii") || q.includes("zone-iii") || q.includes("moderate")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(seismic_zone) LIKE '%iii%' ORDER BY district`,
        params: [],
        intent: "districts in seismic Zone-III",
      };
    }
    if (q.includes("zone ii") || q.includes("zone-ii") || q.includes("low")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(seismic_zone) LIKE '%zone-ii%' AND LOWER(seismic_zone) NOT LIKE '%iii%' ORDER BY district`,
        params: [],
        intent: "districts in seismic Zone-II",
      };
    }
    // Specific district lookup
    const districtMatch = question.match(/\b(puri|cuttack|bhubaneswar|khurda|kendrapara|jagatsinghpur|balasore|bhadrak|ganjam|gajapati|koraput|rayagada|malkangiri|nabarangpur|kalahandi|nuapada|bolangir|bargarh|sambalpur|jharsuguda|sundargarh|keonjhar|mayurbhanj|jajpur|dhenkanal|angul|nayagarh|kandhamal|boudh|sonepur|subarnapur)\b/i);
    if (districtMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(district) LIKE $1`,
        params: [`%${districtMatch[1].toLowerCase()}%`],
        intent: `seismic zone for district ${districtMatch[1]}`,
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY seismic_zone, district`,
      params: [],
      intent: "all districts with seismic zones",
    };
  }

  // SDRF norms — filter by category keyword
  if (tableName === "sdmp_table_9_3_sdrf_norms_of_assistance") {
    if (q.includes("death") || q.includes("deceased") || q.includes("ex-gratia") || q.includes("gratia")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(item) LIKE '%death%' OR LOWER(item) LIKE '%deceased%' OR LOWER(category) LIKE '%gratuitous%'`,
        params: [],
        intent: "ex-gratia relief for death",
      };
    }
    if (q.includes("disability") || q.includes("injured")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(item) LIKE '%disab%' OR LOWER(item) LIKE '%injur%'`,
        params: [],
        intent: "disability/injury relief norms",
      };
    }
    if (q.includes("clothing") || q.includes("clothes") || q.includes("utensil")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(item) LIKE '%cloth%' OR LOWER(item) LIKE '%utensil%'`,
        params: [],
        intent: "clothing/utensil relief norms",
      };
    }
    if (q.includes("livelihood") || q.includes("daily") || q.includes("per day")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(item) LIKE '%livelihood%' OR LOWER(item) LIKE '%per day%'`,
        params: [],
        intent: "livelihood assistance norms",
      };
    }
    // Return all norms
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY _id`,
      params: [],
      intent: "all SDRF relief norms",
    };
  }

  // Disaster statistics — filter by disaster type and/or year
  if (tableName === "sdmp_table_2_3_disaster_statistics") {
    const disasterTypes = ["flood", "cyclone", "drought", "lightning", "fire",
                           "hail storm", "tornado", "heat wave", "drowning", "snake bite"];
    const matchedDisaster = disasterTypes.find((d) => q.includes(d));

    const yearMatch = question.match(/\b(20\d{2}[-–]\d{2,4}|20\d{2})\b/);

    if (matchedDisaster && yearMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(disaster) LIKE $1 AND year LIKE $2`,
        params: [`%${matchedDisaster}%`, `%${yearMatch[1]}%`],
        intent: `${matchedDisaster} statistics for ${yearMatch[1]}`,
      };
    }
    if (matchedDisaster) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(disaster) LIKE $1 ORDER BY year`,
        params: [`%${matchedDisaster}%`],
        intent: `all statistics for ${matchedDisaster}`,
      };
    }
    if (yearMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE year LIKE $1`,
        params: [`%${yearMatch[1]}%`],
        intent: `all disaster statistics for ${yearMatch[1]}`,
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY year, disaster LIMIT 20`,
      params: [],
      intent: "disaster statistics overview",
    };
  }

  // Satellite phones — filter by district/holder name
  if (tableName === "sdmp_table_5_7_satellite_phones") {
    const districtMatch = question.match(/\b(puri|cuttack|bhubaneswar|khurda|kendrapara|jagatsinghpur|balasore|bhadrak|ganjam|koraput|rayagada|sambalpur|sundargarh|keonjhar|mayurbhanj|jajpur|angul)\b/i);
    if (districtMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(holder) LIKE $1 OR LOWER(designation) LIKE $1`,
        params: [`%${districtMatch[1].toLowerCase()}%`],
        intent: `satellite phone for ${districtMatch[1]}`,
      };
    }
    if (q.includes("odraf")) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(holder) LIKE '%odraf%' OR LOWER(designation) LIKE '%odraf%'`,
        params: [],
        intent: "ODRAF satellite phones",
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY _id`,
      params: [],
      intent: "all satellite phone contacts",
    };
  }

  // MAH factories — filter by district
  if (tableName === "sdmp_mah_factories_by_district") {
    const districtMatch = question.match(/\b(jagatsinghpur|angul|jharsuguda|sundargarh|sambalpur|cuttack|khurda|ganjam|kendrapara|balasore)\b/i);
    if (districtMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(district) LIKE $1`,
        params: [`%${districtMatch[1].toLowerCase()}%`],
        intent: `MAH factories in ${districtMatch[1]}`,
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY CAST(mah_factories AS INTEGER) DESC NULLS LAST`,
      params: [],
      intent: "all districts by MAH factory count",
    };
  }

  // Disaster timeline — filter by year or disaster type
  if (tableName === "sdmp_table_2_2_disaster_timeline") {
    const yearMatch = question.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE year = $1`,
        params: [yearMatch[1]],
        intent: `disasters in ${yearMatch[1]}`,
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}" ORDER BY year`,
      params: [],
      intent: "full disaster timeline",
    };
  }

  // Hazard vulnerability percentages
  if (tableName === "sdmp_table_2_1_hazard_vulnerability_pct") {
    const hazards = ["flood", "cyclone", "earthquake"];
    const matched = hazards.find((h) => q.includes(h));
    if (matched) {
      return {
        sql: `SELECT ${cols} FROM "${tableName}" WHERE LOWER(hazard_type) LIKE $1`,
        params: [`%${matched}%`],
        intent: `${matched} vulnerability percentage`,
      };
    }
    return {
      sql: `SELECT ${cols} FROM "${tableName}"`,
      params: [],
      intent: "all hazard vulnerability percentages",
    };
  }

  // Default: return all rows from the table
  return {
    sql: `SELECT ${cols} FROM "${tableName}" LIMIT 50`,
    params: [],
    intent: `all data from ${tableName}`,
  };
}

// ── Qdrant search ─────────────────────────────────────────────────────────────

async function vectorSearch(question, topK = TOP_K) {
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: question,
  });
  const vector = response.data[0].embedding;

  const results = await qdrant.search(COLLECTION, {
    vector,
    limit: topK,
    with_payload: true,
    with_vector:  false,
  });

  return results;
}

// ── Postgres query ────────────────────────────────────────────────────────────

async function sqlSearch(tableName, question) {
  const built = buildSql(tableName, question);
  if (!built) return { rows: [], intent: "unknown", sql: null };

  const client = await pool.connect();
  try {
    const result = await client.query(built.sql, built.params);
    return {
      rows:   result.rows,
      intent: built.intent,
      sql:    built.sql,
      table:  tableName,
    };
  } finally {
    client.release();
  }
}

// ── Main router function ──────────────────────────────────────────────────────

export async function route(question) {
  // Guard — ensure question is always a string
  if (!question || typeof question !== "string") {
    throw new Error(`route() expected a string, got ${typeof question}`);
  }

  // Step 1: keyword signal detection
  const { sqlScore, vectorScore, q } = detectSignals(question);

  // Step 2: lightweight Qdrant probe — get top-3 to check for table cards
  // This is a cheap call (3 results) that improves routing accuracy
  const probeResults = await vectorSearch(question, 3);
  const tableCardHits = probeResults.filter(
    (r) => r.payload?.section_type === "table_summary" && r.score > 0.55
  );

  // Step 3: decide mode
  const mode = decideMode(sqlScore, vectorScore, tableCardHits);

  // Step 4: identify target tables for SQL
  const keywordTableMatches = identifyTables(question);

  // Merge table card hits with keyword matches (table cards take priority)
  const tableCardTableNames = tableCardHits.map((r) => r.payload?.sql_table_name).filter(Boolean);
  const keywordTableNames   = keywordTableMatches.slice(0, 2).map((m) => m.tableName);

  // Deduplicated, table card matches first
  const targetTables = [...new Set([...tableCardTableNames, ...keywordTableNames])];

  // Build reasoning string for debugging
  const reasoning = [
    `mode=${mode}`,
    `sqlScore=${sqlScore}`,
    `vectorScore=${vectorScore}`,
    `tableCardHits=${tableCardHits.length}`,
    `targetTables=[${targetTables.join(", ")}]`,
  ].join("  ");

  // Step 5: execute based on mode
  let vectorResults = null;
  let sqlResults    = null;

  if (mode === "vector" || mode === "hybrid") {
    // Full vector search (top-K)
    const topK = mode === "hybrid" ? TOP_K : TOP_K;
    vectorResults = await vectorSearch(question, topK);

    // Filter out table_summary chunks from vector results in hybrid mode
    // (they're handled by SQL; no need to send them to the LLM as context)
    if (mode === "hybrid") {
      vectorResults = vectorResults.filter(
        (r) => r.payload?.section_type !== "table_summary"
      );
    }
  }

  if (mode === "sql" || mode === "hybrid") {
    if (targetTables.length === 0) {
      // No table identified — fall back to vector
      console.warn(`[router] SQL mode but no table identified — falling back to vector`);
      vectorResults = await vectorSearch(question, TOP_K);
      return {
        mode: "vector",
        vectorResults,
        sqlResults: null,
        tables: [],
        reasoning: reasoning + "  fallback=vector(no_table_identified)",
      };
    }

    // Query each identified table (usually 1, sometimes 2 for hybrid)
    sqlResults = [];
    for (const tableName of targetTables.slice(0, 2)) {
      try {
        const result = await sqlSearch(tableName, question);
        if (result.rows.length > 0) {
          sqlResults.push(result);
        }
      } catch (err) {
        console.warn(`[router] SQL error on ${tableName}: ${err.message}`);
      }
    }

    // If SQL returned nothing, fall back to vector
    if (sqlResults.length === 0) {
      console.warn(`[router] SQL returned 0 rows — falling back to vector`);
      vectorResults = await vectorSearch(question, TOP_K);
      return {
        mode: "vector",
        vectorResults,
        sqlResults: null,
        tables: targetTables,
        reasoning: reasoning + "  fallback=vector(sql_empty)",
      };
    }
  }

  return {
    mode,
    vectorResults,   // array of Qdrant hits (each has .payload.chunk_text + metadata)
    sqlResults,      // array of { rows, intent, sql, table }
    tables: targetTables,   
    reasoning,
  };
}

// ── Cleanup export (call on server shutdown) ──────────────────────────────────

export async function closeRouter() {
  // pool is managed by index.js — do not close here
}

export default route;