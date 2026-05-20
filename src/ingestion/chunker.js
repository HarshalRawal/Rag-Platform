// src/ingestion/chunker.js
//
// Stage 2 — Parse sdmp_cleaned.txt and produce structured chunk objects.
//
// Usage:
//   node src/ingestion/chunker.js                        # writes chunks.json
//   node src/ingestion/chunker.js --dry-run              # prints stats only, no file
//   node src/ingestion/chunker.js --out ./my-chunks.json # custom output path
//
// Output: JSON array of chunk objects matching metadata_schema.json
// Each chunk: { chunk_id, chunk_text, chunk_tokens, chapter, section_number,
//               section_title, section_type, department, covers_disaster_types,
//               covers_phases, source_line_range_start, source_line_range_end,
//               ...document-level metadata }
//
// Requirements:  npm install tiktoken uuid

import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { get_encoding } from "tiktoken";

// ── Config ────────────────────────────────────────────────────────────────────

const INPUT_FILE  = process.env.SDMP_CLEANED || "./public/sdmp_cleaned.txt";
const OUTPUT_FILE = process.env.CHUNKS_OUT   || "./src/ingestion/chunks.json";

// Token limits (from chunking_recipe.md)
const TARGET_TOKENS = 800;
const MAX_TOKENS    = 1300;  // soft cap; 1200 target but allow up to 1300 for cohesive sections
const MAX_TOKENS_CH6 = 1500;   // Ch VI SOPs are allowed to be bigger
const MIN_TOKENS    = 100;
const OVERLAP_TOKENS = 100;

// cl100k_base = tokenizer used by text-embedding-3-small / text-embedding-3-large
const enc = get_encoding("cl100k_base");

// ── Document-level metadata (from metadata_schema.json) ───────────────────────

const DOC_META = {
  document_source:       "Odisha_SDMP_2019",
  document_filename:     "Odisha_SDMP_2019.pdf",
  document_year:         2019,
  document_month:        6,
  publisher:             "Revenue_DM_Dept_GoO",
  issuing_authority:     "State_Government",
  legal_basis:           "DM_Act_2005_Section_23",
  document_role:         "framework",
  geographic_scope:      "odisha_state",
  geographic_specificity:"state_level",
  temporal_validity:     "pre_fani",
  language:              "en",
};

// ── Chapter boundaries (real line numbers from grep) ─────────────────────────
// Format: { lineStart, lineEnd, number, romanNumeral, title }
// lineStart/lineEnd are 1-based (matching the file's actual lines)

const CHAPTERS = [
  { number: "I",    roman: "I",    arabic: "1",  lineStart: 264,  lineEnd: 973,  title: "Introduction" },
  { number: "II",   roman: "II",   arabic: "2",  lineStart: 974,  lineEnd: 1735, title: "Vulnerability Assessment and Risk Analysis" },
  { number: "III",  roman: "III",  arabic: "3",  lineStart: 1736, lineEnd: 2663, title: "Preventive Measures" },
  { number: "IV",   roman: "IV",   arabic: "4",  lineStart: 2664, lineEnd: 3196, title: "Mainstreaming DRR and CCA" },
  { number: "V",    roman: "V",    arabic: "5",  lineStart: 3197, lineEnd: 4362, title: "Preparedness" },
  { number: "VI",   roman: "VI",   arabic: "6",  lineStart: 4363, lineEnd: 6574, title: "Response" },
  { number: "VII",  roman: "VII",  arabic: "7",  lineStart: 6575, lineEnd: 7689, title: "Capacity Building" },
  { number: "VIII", roman: "VIII", arabic: "8",  lineStart: 7690, lineEnd: 7933, title: "Knowledge Management" },
  { number: "IX",   roman: "IX",   arabic: "9",  lineStart: 7934, lineEnd: 8736, title: "Financial Management" },
  { number: "X",    roman: "X",    arabic: "10", lineStart: 8737, lineEnd: 99999, title: "Implementation and Review" },
];

// Lines to SKIP entirely (1-based, inclusive)
const SKIP_RANGES = [
  [1, 263],   // Foreword, Exec Summary, TOC, Abbreviations — all before Ch I
];

// Table IDs to strip from narrative text (they live in CSVs already)
// We strip lines that look like table rows for these tables
const CSV_TABLE_IDS = [
  "1.1", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6",
  "5.3", "5.7", "7.1", "9.3",
];

// ── Ch VI department boundaries (actual from file, verified by grep) ─────────
// line numbers are 1-based

const CH6_DEPARTMENTS = [
  { section: "6.2",  title: "EOC Standard Operating Procedure",         lineStart: 4375, lineEnd: 4408  },
  { section: "6.3.1", title: "Agriculture and Farmers Empowerment",     lineStart: 4409, lineEnd: 4508  },
  { section: "6.3.2", title: "Water Resource Department",               lineStart: 4509, lineEnd: 4756  },
  { section: "6.3.3", title: "Health and Family Welfare",               lineStart: 4757, lineEnd: 5046  },
  { section: "6.3.4", title: "Factories and Boilers",                   lineStart: 5047, lineEnd: 5124  },
  { section: "6.3.5", title: "Food Supplies and Consumer Welfare",      lineStart: 5125, lineEnd: 5223  },
  { section: "6.3.6", title: "Forest and Environment",                  lineStart: 5224, lineEnd: 5286  },
  { section: "6.3.7", title: "Fisheries and ARD",                       lineStart: 5287, lineEnd: 5428  },
  { section: "6.3.8", title: "Home Department",                         lineStart: 5429, lineEnd: 5510  },
  { section: "6.3.9", title: "Steel and Mines",                         lineStart: 5511, lineEnd: 5696  },
  { section: "6.3.10", title: "Panchayati Raj and Drinking Water",      lineStart: 5697, lineEnd: 6510  },
  { section: "6.4",  title: "Incident Response System",                 lineStart: 6511, lineEnd: 6574  },
];

// Disaster type keywords → for tagging chunks automatically
const DISASTER_KEYWORDS = {
  cyclone:     ["cyclone", "storm", "landfall", "wind speed", "coastal"],
  flood:       ["flood", "inundation", "waterlogging", "river"],
  drought:     ["drought", "rainfall deficit", "dry spell"],
  earthquake:  ["earthquake", "seismic", "tremor"],
  tsunami:     ["tsunami", "tidal wave"],
  heat_wave:   ["heat wave", "heatwave", "temperature"],
  lightning:   ["lightning", "thunderstorm"],
  fire:        ["fire", "wildfire", "conflagration"],
  industrial:  ["industrial", "chemical", "factory", "hazmat", "mah"],
  drowning:    ["drowning", "boat accident"],
  snakebite:   ["snake bite", "snakebite", "venomous"],
  tornado:     ["tornado"],
  heavy_rain:  ["heavy rain", "cloudburst"],
};

// Phase keywords
const PHASE_KEYWORDS = {
  prevention:    ["prevention", "mitigation", "reduce risk"],
  preparedness:  ["preparedness", "training", "mock drill", "early warning", "capacity"],
  response:      ["response", "rescue", "evacuation", "relief", "sop", "emergency"],
  recovery:      ["recovery", "rehabilitation", "reconstruction", "restoration"],
};

// ── Token counting ────────────────────────────────────────────────────────────

function countTokens(text) {
  return enc.encode(text).length;
}

// ── Text utilities ────────────────────────────────────────────────────────────

function cleanLine(line) {
  // Remove Source: attribution lines
  if (/^\s*\(?\s*Source\s*:/i.test(line)) return "";
  // Remove lone page numbers
  if (/^\s*\d{1,3}\s*$/.test(line)) return "";
  // Remove lines that are just dashes/underscores
  if (/^[\s\-_=*]{3,}$/.test(line)) return "";
  return line;
}

function extractDisasterTypes(text) {
  const lower = text.toLowerCase();
  return Object.entries(DISASTER_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
    .map(([type]) => type);
}

function extractPhases(text) {
  const lower = text.toLowerCase();
  return Object.entries(PHASE_KEYWORDS)
    .filter(([, keywords]) => keywords.some((kw) => lower.includes(kw)))
    .map(([phase]) => phase);
}

function deptToKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/g, "");
}

// ── Core: split text into token-aware chunks with overlap ────────────────────

function splitIntoChunks(text, maxTokens = MAX_TOKENS, overlap = OVERLAP_TOKENS) {
  const paragraphs = text.split(/\n{2,}/);   // split on blank lines
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const cleaned = para.trim();
    if (!cleaned) continue;
    const paraTokens = countTokens(cleaned);

    // If this single paragraph already exceeds max, hard-split it by sentences
    if (paraTokens > maxTokens) {
      // Flush current buffer first
      if (current.length > 0) {
        chunks.push(current.join("\n\n"));
        // Keep last overlap_tokens worth of text for next chunk
        current = keepTail(current, overlap);
        currentTokens = countTokens(current.join("\n\n"));
      }
      // Now split the giant paragraph by sentences
      const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
      let sentBuf = [];
      let sentTokens = 0;
      for (const sent of sentences) {
        const st = countTokens(sent);
        if (sentTokens + st > maxTokens && sentBuf.length > 0) {
          chunks.push(sentBuf.join(" "));
          sentBuf = keepTailStr(sentBuf, overlap);
          sentTokens = countTokens(sentBuf.join(" "));
        }
        sentBuf.push(sent.trim());
        sentTokens += st;
      }
      if (sentBuf.length > 0) {
        current = [sentBuf.join(" ")];
        currentTokens = countTokens(current[0]);
      }
      continue;
    }

    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      chunks.push(current.join("\n\n"));
      current = keepTail(current, overlap);
      currentTokens = countTokens(current.join("\n\n"));
    }

    current.push(cleaned);
    currentTokens += paraTokens;
  }

  if (current.length > 0 && countTokens(current.join("\n\n")) >= MIN_TOKENS) {
    chunks.push(current.join("\n\n"));
  }

  return chunks;
}

// Keep the tail of a paragraph array up to `targetTokens` for overlap
function keepTail(paragraphs, targetTokens) {
  const result = [];
  let tokens = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const t = countTokens(paragraphs[i]);
    if (tokens + t > targetTokens) break;
    result.unshift(paragraphs[i]);
    tokens += t;
  }
  return result;
}

function keepTailStr(sentences, targetTokens) {
  const result = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = countTokens(sentences[i]);
    if (tokens + t > targetTokens) break;
    result.unshift(sentences[i]);
    tokens += t;
  }
  return result;
}

// ── Build a chunk object ──────────────────────────────────────────────────────

function makeChunk(text, { chapter, sectionNumber, sectionTitle, sectionType, department, lineStart, lineEnd }) {
  const tokens = countTokens(text);
  return {
    ...DOC_META,
    chunk_id:               uuidv4(),
    chunk_text:             text,
    chunk_tokens:           tokens,
    chapter,
    section_number:         sectionNumber || null,
    section_title:          sectionTitle  || null,
    section_type:           sectionType   || "narrative",
    department:             department    || null,
    covers_disaster_types:  extractDisasterTypes(text),
    covers_phases:          extractPhases(text),
    source_line_range_start: lineStart,
    source_line_range_end:   lineEnd,
  };
}

// ── Table card chunks (one per CSV, for SQL query routing) ───────────────────

const TABLE_CARDS = [
  {
    table_name: "sdmp_table_1_1_agro_climatic_zones",
    text: `Table card: sdmp_table_1_1_agro_climatic_zones
This table lists the 10 agro-climatic zones of Odisha with columns: zone_no, zone_name, districts, climate, mean_annual_rainfall_mm, soil_groups.
Covers all major zones including East and South Eastern Coastal Plain, North Eastern Coastal Plain, and interior zones.
Source: Odisha SDMP 2019, Chapter I.
For specific zone data, query SQL table sdmp_table_1_1_agro_climatic_zones.`,
    chapter: "I", section: "1.1",
  },
  {
    table_name: "sdmp_table_2_1_hazard_vulnerability_pct",
    text: `Table card: sdmp_table_2_1_hazard_vulnerability_pct
This table shows the percentage of Odisha state area vulnerable to different hazards: flood (categories: highly flood prone, flood prone, medium flood prone), cyclone (severe, very severe), and earthquake (moderate, low damage risk zone).
Source: Odisha SDMP 2019, Chapter II Table 2.1.
For specific percentages, query SQL table sdmp_table_2_1_hazard_vulnerability_pct.`,
    chapter: "II", section: "2.1",
  },
  {
    table_name: "sdmp_table_2_2_disaster_timeline",
    text: `Table card: sdmp_table_2_2_disaster_timeline
This table lists major calamities in Odisha year by year from 1996 to 2015, with columns: year, calamity_type, remarks.
Covers floods, cyclones, droughts, earthquakes, and other events.
Source: Odisha SDMP 2019, Chapter II Table 2.2.
For specific years or disaster types, query SQL table sdmp_table_2_2_disaster_timeline.`,
    chapter: "II", section: "2.2",
  },
  {
    table_name: "sdmp_table_2_3_disaster_statistics",
    text: `Table card: sdmp_table_2_3_disaster_statistics
This table lists major disasters in Odisha from 2006-07 to 2017-18, with columns: disaster (type), year, districts_affected, villages_affected, deaths, affected_population, livestock_loss, houses_damaged, crop_damage_hectares.
Covers 13 disaster types: Flood, Drought, Fire, Hail Storm, Cyclone, Pest Attack, Lightning, Heat Wave, Tornado, Heavy Rain, Boat Accidents, Drowning, Snake Bite.
Source: Office of the Special Relief Commissioner, Odisha SDMP 2019.
For specific counts or statistics, query SQL table sdmp_table_2_3_disaster_statistics.`,
    chapter: "II", section: "2.3",
  },
  {
    table_name: "sdmp_table_2_4_rainfall_frequency_by_decade",
    text: `Table card: sdmp_table_2_4_rainfall_frequency_by_decade
This table shows frequency of annual rainfall intervals (in mm) per decade from the 1950s to the 1990s in Odisha.
Columns: rainfall_interval_mm, 1950s, 1960s, 1970s, 1980s, 1990s.
Source: Odisha SDMP 2019, Chapter II Table 2.4.
For specific frequency data, query SQL table sdmp_table_2_4_rainfall_frequency_by_decade.`,
    chapter: "II", section: "2.4",
  },
  {
    table_name: "sdmp_table_2_5_seismic_zones_by_district",
    text: `Table card: sdmp_table_2_5_seismic_zones_by_district
This table classifies all 30 Odisha districts by seismic zone: Zone II (low damage risk) or Zone III (moderate damage risk).
Columns: district, seismic_zone.
Source: Odisha SDMP 2019, Chapter II Table 2.5.
To find the seismic zone for a specific district, or to list all districts in a particular zone, query SQL table sdmp_table_2_5_seismic_zones_by_district.`,
    chapter: "II", section: "2.5",
  },
  {
    table_name: "sdmp_table_2_6_industrial_hazard_areas",
    text: `Table card: sdmp_table_2_6_industrial_hazard_areas
This table lists major industrial hazard areas in Odisha by district, including chemicals handled and type of hazard (explosion, toxic release, etc.).
Columns: sl_no, area, district, chemicals_handled, hazard_type.
Source: Odisha SDMP 2019, Chapter II Table 2.6.
For hazard details by location, query SQL table sdmp_table_2_6_industrial_hazard_areas.`,
    chapter: "II", section: "2.6",
  },
  {
    table_name: "sdmp_cvi_risk_classes_by_parameter",
    text: `Table card: sdmp_cvi_risk_classes_by_parameter
This table shows Coastal Vulnerability Index (CVI) risk class lengths in kilometres by parameter along the Odisha coast.
Columns: parameter, very_low_km, low_km, medium_km, high_km, very_high_km.
Parameters: Shoreline Change Rate, Coastal Slope, Coastal Elevation, Geomorphology, Sea Level Change Rate, Mean Significant Wave Height, Tidal Range.
Source: Odisha SDMP 2019, Chapter II CVI section.
For specific parameter risk data, query SQL table sdmp_cvi_risk_classes_by_parameter.`,
    chapter: "II", section: "2.7",
  },
  {
    table_name: "sdmp_cvi_odisha_summary",
    text: `Table card: sdmp_cvi_odisha_summary
This table summarises total Odisha coastline length (496 km) by CVI vulnerability class: Low, Medium, High, Very High, Total.
Columns: cvi_class, length_km, pct_of_length.
Source: Odisha SDMP 2019, Chapter II CVI section.
For coastline vulnerability distribution, query SQL table sdmp_cvi_odisha_summary.`,
    chapter: "II", section: "2.7",
  },
  {
    table_name: "sdmp_mah_factories_by_district",
    text: `Table card: sdmp_mah_factories_by_district
This table lists the count of Major Accident Hazard (MAH) factories and 2(cb) factories per district in Odisha.
Columns: district, mah_factories, factories_2cb.
Source: Odisha SDMP 2019, Chapter II page 39.
For factory counts by district, query SQL table sdmp_mah_factories_by_district.`,
    chapter: "II", section: "2.8",
  },
  {
    table_name: "sdmp_table_5_3_trained_volunteers_2016_17",
    text: `Table card: sdmp_table_5_3_trained_volunteers_2016_17
This table shows count of trained disaster response volunteers in Odisha by training category, as of 2016-17.
Includes Aapda Mitra, ODRAF, Civil Defence, NCC, NSS, Home Guards, and other trained personnel.
Source: Odisha SDMP 2019, Chapter V Table 5.3.
For volunteer counts by category or district, query SQL table sdmp_table_5_3_trained_volunteers_2016_17.`,
    chapter: "V", section: "5.3",
  },
  {
    table_name: "sdmp_table_5_7_satellite_phones",
    text: `Table card: sdmp_table_5_7_satellite_phones
This table lists satellite phone numbers for District Collectors (all 30 districts), ODRAF units, State Fire service, SEOC, CMO, and OSDMA officials.
Columns: sl_no, holder, designation, satellite_phone_number.
Source: Odisha SDMP 2019, Chapter V Table 5.7.
Note: access restricted to operator role — do not surface in citizen-facing responses.
For emergency contact numbers, query SQL table sdmp_table_5_7_satellite_phones.`,
    chapter: "V", section: "5.7",
  },
  {
    table_name: "sdmp_table_7_1_training_institutions",
    text: `Table card: sdmp_table_7_1_training_institutions
This table lists disaster management training institutions in Odisha with their areas of intervention and target audience.
Columns: institution, area_of_intervention, target_audience.
Source: Odisha SDMP 2019, Chapter VII Table 7.1.
For training institution details, query SQL table sdmp_table_7_1_training_institutions.`,
    chapter: "VII", section: "7.1",
  },
  {
    table_name: "sdmp_table_9_3_sdrf_norms_of_assistance",
    text: `Table card: sdmp_table_9_3_sdrf_norms_of_assistance
This table lists SDRF and NDRF relief norms of assistance including ex-gratia for deaths (Rs. 4 lakh per deceased), disability relief, hospitalisation costs, clothing, household items, livelihood assistance, and search & rescue rates.
Columns: category, item, unit, amount_rs.
Source: Odisha SDMP 2019, Chapter IX Table 9.3.
For specific relief amounts or ex-gratia rates, query SQL table sdmp_table_9_3_sdrf_norms_of_assistance.`,
    chapter: "IX", section: "9.3",
  },
];

// ── Main ingestion logic ──────────────────────────────────────────────────────

function shouldSkipLine(lineNum) {
  return SKIP_RANGES.some(([start, end]) => lineNum >= start && lineNum <= end);
}

function isNoiseLine(line) {
  const cleaned = cleanLine(line);
  return cleaned === "";
}

function getChapterForLine(lineNum) {
  return CHAPTERS.find((ch) => lineNum >= ch.lineStart && lineNum <= ch.lineEnd);
}

function processNonCh6Chapter(chapter, allLines) {
  const chunks = [];

  // Extract lines for this chapter, skip noise
  const lines = [];
  for (let i = chapter.lineStart - 1; i < Math.min(chapter.lineEnd, allLines.length); i++) {
    const lineNum = i + 1;
    if (shouldSkipLine(lineNum)) continue;
    const cleaned = cleanLine(allLines[i]);
    if (cleaned !== "") lines.push({ text: cleaned, lineNum });
  }

  if (lines.length === 0) return chunks;

  // Find section boundaries within this chapter.
  // Regex is chapter-aware: only matches section numbers that START with the
  // chapter's own arabic number (e.g. Ch III only matches "3.x" or "3.x.y").
  // This prevents false matches on:
  //   - decimal stats like "0.78 in 2001…"
  //   - SDG/Sendai targets like "1.5 By 2030…", "6.6 By 2020…"
  //   - mid-sentence numbers like "72.99 percent"
  const sectionBoundaries = [];
  const chNum = CHAPTERS.find((c) => c.roman === chapter.roman)?.arabic;
  // Build regex: ^<chapterNumber>.<digit(s)>(.<digit(s)>)?  <Title starting with capital>
  const SECTION_RE = new RegExp(
    `^(${chNum}\\.\\d+(?:\\.\\d+)?)\\s+([A-Z][^\\n]{2,})$`
  );

  for (const { text, lineNum } of lines) {
    const m = text.match(SECTION_RE);
    if (m) {
      // Extra guard: skip if the "title" part looks like a sentence fragment
      // (starts with "By 20", "of ", "in ", "percent", etc.)
      const title = m[2].trim();
      const looksLikeSentence = /^(By \d|of |in |percent|lakh|km\/h|\d)/.test(title);
      if (!looksLikeSentence) {
        sectionBoundaries.push({ sectionNum: m[1], title, lineNum });
      }
    }
  }

  // Split text into sections
  if (sectionBoundaries.length === 0) {
    // No sub-sections found — chunk the whole chapter as one block
    const text = lines.map((l) => l.text).join("\n");
    const rawChunks = splitIntoChunks(text, MAX_TOKENS, OVERLAP_TOKENS);
    for (const rc of rawChunks) {
      if (countTokens(rc) < MIN_TOKENS) continue;
      chunks.push(makeChunk(rc, {
        chapter: chapter.roman,
        sectionNumber: null,
        sectionTitle: chapter.title,
        sectionType: getSectionType(chapter.roman, null),
        lineStart: chapter.lineStart,
        lineEnd: chapter.lineEnd,
      }));
    }
    return chunks;
  }

  // Merge tiny sections (< MIN_TOKENS) forward into the next section.
  // Prevents isolated stubs like "1.1 Vision" from becoming undersized chunks.
  const mergedSections = [];
  let pendingText = "";
  let pendingLineStart = null;
  let pendingSectionNum = null;
  let pendingTitle = null;

  for (let i = 0; i < sectionBoundaries.length; i++) {
    const sec = sectionBoundaries[i];
    const nextSec = sectionBoundaries[i + 1];

    const secLines = lines.filter(
      (l) => l.lineNum >= sec.lineNum &&
             (!nextSec || l.lineNum < nextSec.lineNum)
    );
    const sectionText = secLines.map((l) => l.text).join("\n");

    const combined = pendingText ? pendingText + "\n\n" + sectionText : sectionText;

    if (countTokens(combined) < MIN_TOKENS) {
      pendingText = combined;
      if (pendingLineStart === null) pendingLineStart = sec.lineNum;
      if (pendingSectionNum === null) pendingSectionNum = sec.sectionNum;
      if (pendingTitle === null) pendingTitle = sec.title;
      continue;
    }

    mergedSections.push({
      sectionNum: pendingSectionNum ?? sec.sectionNum,
      title:      pendingTitle      ?? sec.title,
      text:       combined,
      lineStart:  pendingLineStart  ?? sec.lineNum,
      lineEnd:    nextSec ? nextSec.lineNum - 1 : chapter.lineEnd,
    });
    pendingText = "";
    pendingLineStart = null;
    pendingSectionNum = null;
    pendingTitle = null;
  }

  // Flush any leftover pending text into the last merged section
  if (pendingText) {
    if (mergedSections.length > 0) {
      mergedSections[mergedSections.length - 1].text += "\n\n" + pendingText;
    } else if (countTokens(pendingText) >= MIN_TOKENS) {
      mergedSections.push({
        sectionNum: pendingSectionNum,
        title: pendingTitle ?? chapter.title,
        text: pendingText,
        lineStart: pendingLineStart ?? chapter.lineStart,
        lineEnd: chapter.lineEnd,
      });
    }
  }

  // Chunk each merged section
  for (const sec of mergedSections) {
    if (!sec.text || countTokens(sec.text) < MIN_TOKENS) continue;
    const rawChunks = splitIntoChunks(sec.text, MAX_TOKENS, OVERLAP_TOKENS);
    for (const rc of rawChunks) {
      if (countTokens(rc) < MIN_TOKENS) continue;
      chunks.push(makeChunk(rc, {
        chapter: chapter.roman,
        sectionNumber: sec.sectionNum,
        sectionTitle: sec.title,
        sectionType: getSectionType(chapter.roman, sec.sectionNum),
        lineStart: sec.lineStart,
        lineEnd: sec.lineEnd,
      }));
    }
  }

  return chunks;
}

function processCh6(allLines) {
  const chunks = [];

  for (const dept of CH6_DEPARTMENTS) {
    const lines = [];
    for (let i = dept.lineStart - 1; i < Math.min(dept.lineEnd, allLines.length); i++) {
      const cleaned = cleanLine(allLines[i]);
      if (cleaned !== "") lines.push(cleaned);
    }

    if (lines.length === 0) continue;
    const text = lines.join("\n");
    if (countTokens(text) < MIN_TOKENS) continue;

    // Ch VI SOPs: keep as one chunk if under 1500 tokens
    // If over 1500, split at the 1500-token hard cap (not the 800 target)
    const tokens = countTokens(text);

    if (tokens <= MAX_TOKENS_CH6) {
      chunks.push(makeChunk(text, {
        chapter: "VI",
        sectionNumber: dept.section,
        sectionTitle: dept.title,
        sectionType: "sop",
        department: deptToKey(dept.title),
        lineStart: dept.lineStart,
        lineEnd: dept.lineEnd,
      }));
    } else {
      // Split but with generous max to keep SOPs intact
      const rawChunks = splitIntoChunks(text, MAX_TOKENS_CH6, OVERLAP_TOKENS);
      for (const rc of rawChunks) {
        if (countTokens(rc) < MIN_TOKENS) continue;
        chunks.push(makeChunk(rc, {
          chapter: "VI",
          sectionNumber: dept.section,
          sectionTitle: dept.title,
          sectionType: "sop",
          department: deptToKey(dept.title),
          lineStart: dept.lineStart,
          lineEnd: dept.lineEnd,
        }));
      }
    }
  }

  return chunks;
}

function getSectionType(chapterRoman, sectionNum) {
  if (chapterRoman === "VI") return "sop";
  if (chapterRoman === "III") return "institutional";
  if (chapterRoman === "IV") return "policy_framework";
  if (chapterRoman === "IX") return "narrative";
  if (sectionNum && sectionNum.startsWith("3.1")) return "institutional";
  return "narrative";
}

function makeTableCardChunks() {
  return TABLE_CARDS.map((card) => ({
    ...DOC_META,
    chunk_id:               uuidv4(),
    chunk_text:             card.text,
    chunk_tokens:           countTokens(card.text),
    chapter:                card.chapter,
    section_number:         card.section,
    section_title:          `Table: ${card.table_name}`,
    section_type:           "table_summary",
    department:             null,
    covers_disaster_types:  extractDisasterTypes(card.text),
    covers_phases:          [],
    source_line_range_start: null,
    source_line_range_end:   null,
    sql_table_name:         card.table_name,   // extra field for query routing
  }));
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(chunks) {
  const issues = [];

  const narrative = chunks.filter((c) => c.section_type !== "table_summary");
  const tableCards = chunks.filter((c) => c.section_type === "table_summary");

  if (narrative.length < 80 || narrative.length > 200) {
    issues.push(`Narrative chunk count ${narrative.length} is outside expected range 80–200`);
  }
  if (tableCards.length !== TABLE_CARDS.length) {
    issues.push(`Expected ${TABLE_CARDS.length} table cards, got ${tableCards.length}`);
  }

  // Hard cap: 1500 for Ch VI SOPs, 1500 for everything else (embedding model supports 8191)
  // Cohesive sections slightly over the target are acceptable — splitting hurts retrieval more
  const HARD_CAP = 1500;
  const oversized = chunks.filter((c) => c.chunk_tokens > HARD_CAP);
  if (oversized.length > 0) {
    issues.push(`${oversized.length} chunk(s) exceed hard cap of ${HARD_CAP} tokens`);
    oversized.forEach((c) =>
      issues.push(`  → ${c.section_number || c.chapter} — ${c.chunk_tokens} tokens`)
    );
  }

  // Min token floor: 50 (not 100) — short section headers are fine to embed
  const undersized = chunks.filter((c) => c.chunk_tokens < 50);
  if (undersized.length > 0) {
    issues.push(`${undersized.length} chunk(s) below hard minimum of 50 tokens`);
  }

  const missingMeta = chunks.filter(
    (c) => !c.document_source || !c.chapter || !c.section_type
  );
  if (missingMeta.length > 0) {
    issues.push(`${missingMeta.length} chunk(s) missing required metadata fields`);
  }

  return issues;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outIdx = args.indexOf("--out");
  const outFile = outIdx !== -1 ? args[outIdx + 1] : OUTPUT_FILE;

  console.log(`\n[chunker] Reading: ${INPUT_FILE}`);
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}\nSet SDMP_CLEANED env var or place file at ${INPUT_FILE}`);
  }

  const raw = fs.readFileSync(INPUT_FILE, "utf8");
  const allLines = raw.split("\n");
  console.log(`[chunker] ${allLines.length} lines read`);

  const chunks = [];

  // Process each chapter
  for (const chapter of CHAPTERS) {
    if (chapter.roman === "VI") {
      const ch6Chunks = processCh6(allLines);
      chunks.push(...ch6Chunks);
      console.log(`[chunker] Ch VI  → ${ch6Chunks.length} SOP chunks`);
    } else {
      const chChunks = processNonCh6Chapter(chapter, allLines);
      chunks.push(...chChunks);
      console.log(`[chunker] Ch ${chapter.roman.padEnd(5)} → ${chChunks.length} chunks`);
    }
  }

  // Add table card chunks
  const tableCards = makeTableCardChunks();
  chunks.push(...tableCards);
  console.log(`[chunker] Table cards → ${tableCards.length} chunks`);

  // Validate
  console.log(`\n[chunker] ── Validation ──────────────────────────`);
  const issues = validate(chunks);
  const narrative = chunks.filter((c) => c.section_type !== "table_summary");
  const avgTokens = Math.round(
    narrative.reduce((s, c) => s + c.chunk_tokens, 0) / narrative.length
  );

  console.log(`[chunker] Total chunks    : ${chunks.length}`);
  console.log(`[chunker] Narrative       : ${narrative.length}`);
  console.log(`[chunker] Table cards     : ${tableCards.length}`);
  console.log(`[chunker] Avg tokens      : ${avgTokens}`);
  console.log(`[chunker] Max tokens seen : ${Math.max(...chunks.map((c) => c.chunk_tokens))}`);
  console.log(`[chunker] Min tokens seen : ${Math.min(...chunks.map((c) => c.chunk_tokens))}`);

  // Token cost estimate for embedding
  const totalTokens = chunks.reduce((s, c) => s + c.chunk_tokens, 0);
  const costSmall   = ((totalTokens / 1_000_000) * 0.02).toFixed(4);   // $0.02 per 1M tokens
  const costLarge   = ((totalTokens / 1_000_000) * 0.13).toFixed(4);   // $0.13 per 1M tokens
  console.log(`\n[chunker] Total tokens to embed : ${totalTokens.toLocaleString()}`);
  console.log(`[chunker] Embedding cost estimate:`);
  console.log(`[chunker]   text-embedding-3-small : ~$${costSmall}`);
  console.log(`[chunker]   text-embedding-3-large : ~$${costLarge}`);

  if (issues.length > 0) {
    console.warn(`\n[chunker] ⚠  ${issues.length} validation issue(s):`);
    issues.forEach((i) => console.warn(`  ${i}`));
  } else {
    console.log(`\n[chunker] ✓  All validation checks passed`);
  }

  if (dryRun) {
    console.log(`\n[chunker] Dry run — no file written.`);
    enc.free();
    return;
  }

  // Write output
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(chunks, null, 2), "utf8");
  console.log(`\n[chunker] ✓  Written → ${outFile}  (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);

  enc.free();
}

main().catch((err) => {
  console.error("[chunker] Fatal:", err.message);
  process.exit(1);
});