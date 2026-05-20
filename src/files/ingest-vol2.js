// ingest-vol2.js
//
// Ingests all 5 DDMP Vol II tables into Postgres.
// Run from your project root:
//   docker compose exec backend node ingest-vol2.js
//
// Tables created:
//   rescue_boats         — power boats per block (Annexure 12)
//   health_infrastructure — PHCs, CHCs, ambulances per block (Section 2.2)
//   medical_personnel    — doctors, ANMs, ASHAs per block (Section 2.3)
//   telecom_stations     — VHF and IMD station locations (Annexure 10)
//   ngos                 — NGOs/CBOs per block with specialisation (Annexure 5)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";
import { connectPostgres, query, default as pool } from "../config/postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CSV_DIR = path.join(__dirname);

// ── Helpers ───────────────────────────────────────────────────────────────────

function readCsv(filename) {
  const raw = fs.readFileSync(path.join(CSV_DIR, filename), "utf-8");
  return parse(raw, { columns: true, skip_empty_lines: true, trim: true });
}

async function run(label, sql) {
  try {
    await pool.query(sql);
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    throw err;
  }
}

// ── Table definitions ─────────────────────────────────────────────────────────

async function createTables() {
  console.log("\n[1/2] Creating tables...");

  await run("rescue_boats", `
    CREATE TABLE IF NOT EXISTS rescue_boats (
      id            SERIAL PRIMARY KEY,
      block         TEXT NOT NULL,
      quantity      INTEGER,
      boat_ids      TEXT,
      source_section TEXT,
      document_id   TEXT DEFAULT 'Puri_DDMP_Vol2_2017_18'
    )
  `);

  await run("health_infrastructure", `
    CREATE TABLE IF NOT EXISTS health_infrastructure (
      id                          SERIAL PRIMARY KEY,
      block                       TEXT NOT NULL,
      health_sub_centers          INTEGER,
      phcs                        INTEGER,
      chcs                        INTEGER,
      homeopathic_ayurvedic_hospitals INTEGER,
      subdivisional_hospitals     INTEGER,
      district_private_hospitals  INTEGER,
      mhus                        INTEGER,
      ambulances_108              INTEGER,
      blood_banks                 INTEGER,
      source_section              TEXT,
      document_id                 TEXT DEFAULT 'Puri_DDMP_Vol2_2017_18'
    )
  `);

  await run("medical_personnel", `
    CREATE TABLE IF NOT EXISTS medical_personnel (
      id                SERIAL PRIMARY KEY,
      block             TEXT NOT NULL,
      doctors           INTEGER,
      paramedical_staff INTEGER,
      anms              INTEGER,
      ashas             INTEGER,
      source_section    TEXT,
      document_id       TEXT DEFAULT 'Puri_DDMP_Vol2_2017_18'
    )
  `);

  await run("telecom_stations", `
    CREATE TABLE IF NOT EXISTS telecom_stations (
      id                        SERIAL PRIMARY KEY,
      block                     TEXT NOT NULL,
      vhf_station_location      TEXT,
      imd_cwd_location          TEXT,
      osdma_vhf_installed_at    TEXT,
      additional_vhf_required   TEXT,
      source_section            TEXT,
      document_id               TEXT DEFAULT 'Puri_DDMP_Vol2_2017_18'
    )
  `);

  await run("ngos", `
    CREATE TABLE IF NOT EXISTS ngos (
      id              SERIAL PRIMARY KEY,
      block           TEXT NOT NULL,
      ngo_name        TEXT NOT NULL,
      specialisation  TEXT,
      source_section  TEXT,
      document_id     TEXT DEFAULT 'Puri_DDMP_Vol2_2017_18'
    )
  `);
}

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadData() {
  console.log("\n[2/2] Loading data...");

  // rescue_boats
  const boats = readCsv("rescue_boats.csv");
  for (const row of boats) {
    await pool.query(
      `INSERT INTO rescue_boats (block, quantity, boat_ids, source_section)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [row.block, parseInt(row.quantity), row.boat_ids, row.source_section]
    );
  }
  console.log(`  ✓ rescue_boats — ${boats.length} rows`);

  // health_infrastructure
  const health = readCsv("health_infrastructure.csv");
  for (const row of health) {
    await pool.query(
      `INSERT INTO health_infrastructure
         (block, health_sub_centers, phcs, chcs, homeopathic_ayurvedic_hospitals,
          subdivisional_hospitals, district_private_hospitals, mhus, ambulances_108,
          blood_banks, source_section)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        row.block,
        parseInt(row.health_sub_centers),
        parseInt(row.phcs),
        parseInt(row.chcs),
        parseInt(row.homeopathic_ayurvedic_hospitals),
        parseInt(row.subdivisional_hospitals),
        parseInt(row.district_private_hospitals),
        parseInt(row.mhus),
        parseInt(row.ambulances_108),
        parseInt(row.blood_banks),
        row.source_section,
      ]
    );
  }
  console.log(`  ✓ health_infrastructure — ${health.length} rows`);

  // medical_personnel
  const medical = readCsv("medical_personnel.csv");
  for (const row of medical) {
    await pool.query(
      `INSERT INTO medical_personnel
         (block, doctors, paramedical_staff, anms, ashas, source_section)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [
        row.block,
        parseInt(row.doctors),
        parseInt(row.paramedical_staff),
        parseInt(row.anms),
        parseInt(row.ashas),
        row.source_section,
      ]
    );
  }
  console.log(`  ✓ medical_personnel — ${medical.length} rows`);

  // telecom_stations
  const telecom = readCsv("telecom_stations.csv");
  for (const row of telecom) {
    await pool.query(
      `INSERT INTO telecom_stations
         (block, vhf_station_location, imd_cwd_location, osdma_vhf_installed_at,
          additional_vhf_required, source_section)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [
        row.block,
        row.vhf_station_location || null,
        row.imd_cwd_location || null,
        row.osdma_vhf_installed_at || null,
        row.additional_vhf_required || null,
        row.source_section,
      ]
    );
  }
  console.log(`  ✓ telecom_stations — ${telecom.length} rows`);

  // ngos
  const ngos = readCsv("ngos.csv");
  for (const row of ngos) {
    await pool.query(
      `INSERT INTO ngos (block, ngo_name, specialisation, source_section)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [row.block, row.ngo_name, row.specialisation, row.source_section]
    );
  }
  console.log(`  ✓ ngos — ${ngos.length} rows`);
}

// ── Verify ────────────────────────────────────────────────────────────────────

async function verify() {
  console.log("\n[Verification]");
  const tables = [
    "rescue_boats",
    "health_infrastructure",
    "medical_personnel",
    "telecom_stations",
    "ngos",
  ];
  for (const t of tables) {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`  ${t}: ${rows[0].count} rows`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== DDMP Vol II — Postgres Ingest ===");
  try {
    await connectPostgres();
    await createTables();
    await loadData();
    await verify();
    console.log("\n✅ Done. All 5 tables loaded.");
  } catch (err) {
    console.error("\n❌ Failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();