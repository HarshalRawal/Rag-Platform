# Report Structure Reference
## A Multi-Agent RAG Platform for Disaster Management Decision Support
**IIIT Bhubaneswar | Harshal Rawal (B122049) & Abhiram (B122040)**
**Supervisor: Dr. Puspanjali Mohapatra | May 2026**

> **How to use this file:** This is the single source of truth for what goes in each chapter.
> Before writing any section, check here first. Every section has a clear purpose statement,
> bullet list of content, and notes on what to avoid. Results tables in Ch 5 are left blank —
> fill them after the Fani Replay and Dana Operational Test are complete.

---

## Stack (for reference throughout)
| Component | Tool |
|---|---|
| Embeddings | OpenAI `text-embedding-3-small` |
| Generation | Claude Sonnet 4.5 |
| Vector DB | Qdrant (single collection, 502 points) |
| Structured DB | PostgreSQL (29 tables, 806 rows) |
| Agent framework | OpenAI Agents SDK |
| Backend | Node.js, Docker |
| Frontend | Vite + React + shadcn/ui |

---

## Chapter 1 — Introduction

**Purpose:** Establish the problem and motivate every engineering decision that follows.
This chapter ends with the reader understanding exactly why a basic LLM fails, why basic
RAG fails, and what the three concrete engineering contributions of this work are.

### 1.1 The Operational Gap
- A District Collector during a cyclone cannot query a 400-page PDF in real time
- The information exists — SDMP, DDMP, shelter directories — but is locked in unqueryable documents
- Telephonic chains are slow and error-prone under pressure
- The specific failure mode: right answer in the wrong document, no way to find it fast

### 1.2 Why Standalone LLMs Fail
- GPT-4 and peers have no grounded knowledge of the Odisha SDMP, Puri DDMP, or SDRF tables
- They hallucinate rather than admit ignorance — include the concrete example:
  asked about Fani evacuations without the JRNA in context, system returned ~1.2M
  (actually a Phailin figure from 2013)
- High apparent confidence on wrong answers is operationally dangerous

### 1.3 Why Basic RAG Is Not Enough
- RAG addresses grounding but not cross-event contamination
- If the retriever fetches a Phailin chunk for a Fani question, the generator uses it without complaint
- Phailin (2013) and Fani (2019) are similar in track and intensity — a careless retriever
  will reliably confuse them
- This is the dominant failure mode in a multi-event disaster corpus

### 1.4 What This Platform Contributes
Three concrete engineering claims (state each in one sentence):
1. A section-aware, document-type-aware ingestion pipeline that preserves the structure
   of Indian government disaster documents across 7 sources into a hybrid Qdrant + PostgreSQL
   knowledge base
2. A multi-agent architecture with a CRAG evaluator that eliminates cross-event contamination
   and produces zero hallucinations on planning queries under temporal constraint
3. A two-tier evaluation protocol (historical replay + operational readiness test) that
   provides honest, non-synthetic evidence of system performance

### 1.5 Report Organisation
- One paragraph, one sentence per chapter describing what it contains

> **Do not include:** Long background on Odisha geography, disaster statistics, or government
> structure. That material belongs in the corpus description (Ch 3), not the introduction.

---

## Chapter 2 — Related Work

**Purpose:** Position this work precisely. Cite only papers that directly shaped an
architectural decision. No survey padding.
**Target length:** 3–4 pages maximum.

### 2.1 Retrieval-Augmented Generation
- Lewis et al. (2020) — the foundational formulation: P(y|x) = Σ P(y|x,z)·P(z|x)
- Standard in QA and dialogue, but fragile: topically adjacent but irrelevant documents
  get used by the generator without complaint
- This fragility is the direct motivation for CRAG

### 2.2 Corrective RAG (CRAG)
- Yan et al. (2024) — adds a retrieval evaluator: CORRECT / AMBIGUOUS / INCORRECT
- Under INCORRECT, falls back to web search (their version) or structured refusal (our adaptation)
- Our adaptation: second signal is event_id metadata consistency, not just cosine threshold
- This is the key adaptation that catches cross-event contamination

### 2.3 Multi-Agent LLM Orchestration
- Drammeh (2025) — single-agent vs multi-agent for incident response
  multi-agent produced actionable recommendations on essentially all test incidents,
  single-agent managed under 2%
- Specialist agents with focused prompts and smaller toolsets outperform monolithic agents
- Direct motivation for the Triage Agent + four specialist architecture

### 2.4 LLMs in Disaster Management
- Addison et al. (2024) — RAG for flood risk in Trinidad: 2 PDFs, Llama2-7B, pure cosine
  Does not address structured corpora, multi-agent reasoning, or formal evaluation
- Martelo & Wang (2024) — GPT-4 for flood risk, interpretability focus
- Zhu et al. (2024) — GIS-integrated flood LLM
- Yasuno (2025) — RAPTOR-AI: hierarchical multimodal RAG, OODA loop structure
- None of the above: (a) uses a real Indian government corpus, (b) addresses cross-event
  contamination, (c) evaluates against a real historical disaster as ground truth

### 2.5 The Gap This Work Fills
- One paragraph: the combination of hybrid retrieval + CRAG + multi-agent +
  real Indian corpus + honest two-tier evaluation is not present in any prior work

---

## Chapter 3 — Document Corpus and Ingestion Pipeline

**Purpose:** The first of the two under-served chapters in the old report. Every engineering
decision about how documents were processed — chunking strategy, metadata schema,
Qdrant/PostgreSQL split — goes here. A reader should be able to re-implement the
ingestion pipeline from this chapter alone.

### 3.1 Corpus Design
- 7 documents, each with a distinct role — show the table:

| Document | Year | Role |
|---|---|---|
| Odisha SDMP | 2019 | Master plan: SOPs, SDRF norms, institutional structure |
| Puri DDMP Vol I | 2017–18 | District plan: shelter directory, evacuation procedures, contacts |
| Puri DDMP Vol II | 2017–18 | Operational data: rescue boats, health infra, NGOs, telecom |
| Cyclone Phailin RDNA | 2013 | Post-event damage and needs assessment |
| UNDP Phailin DRM Survey | 2013 | Independent evaluation of Phailin response |
| Cyclone Fani JRNA | 2019 | Post-event needs assessment — **held-out ground truth** |
| UNICEF Fani SitRep 2 | 2019 | Post-event situation report — **held-out ground truth** |

- The closed-loop logic: planning documents (SDMP, DDMP) can be evaluated against
  Fani post-event documents because Fani hit the same geography the DDMP covers
- Why Phailin reports are in the corpus: historical analogue for learning, and deliberate
  contamination source to test CRAG

### 3.2 Chunking Strategy
**This is the most important section in the chapter. Explain every decision.**

#### Why Fixed-Window Chunking Fails Here
- Indian government documents are heavily structured: numbered chapters, departmental
  SOP tables, annexures of compensation norms
- Fixed 512-token windows destroy this structure — produce fragments spanning half
  of one section and half of another
- A query about Agriculture Department SOPs should return a coherent Agriculture SOP
  chunk, not a window that starts mid-shelter-directory and ends mid-SOP

#### Per-Document Approach
Each document got a different chunking strategy based on its structure:

**Odisha SDMP 2019 — Section-aware chunking**
- Boundaries follow numbered chapter and section headers
- Target: ~500 tokens per narrative chunk
- Tables extracted separately to PostgreSQL (13 tables, 290 rows)
- Operator-only gate: Table 5.7 (satellite phone numbers) tagged `access_policy: operator_only`

**Puri DDMP Vol I — 4-Track Hybrid**
- Track 1: Structured tables → PostgreSQL (shelters_mcs: 182 rows, contacts: 141 rows)
- Track 2: SOP chapters (Ch 8.6) → section-aware chunks + `departments_mentioned` tag
- Track 3: Narrative sections → 500-word chunks, 60-word overlap
- Track 4: Synthetic table-reference chunks → one per Track 1 table, carries
  `retrieval_hint: prefer_sql_for_lookups` so the vector store routes lookup
  queries to SQL instead of attempting semantic retrieval
- Contact directory: 141 rows tagged `access_policy: operator_only`

**Cyclone Fani JRNA 2019 — Sector-boundary chunking with sub-splitting**
- Boundaries follow natural sector structure (B.1 WASH, B.2 Shelter, B.3 Food...)
- A query about shelter should return a coherent shelter chunk, not a window
  spanning half-shelter and half-WASH
- Max 380 words (~512 tokens) to fit embedding context
- Oversized sections sub-split on: paragraph → bullet → sentence, with ~30-word
  overlap carried forward
- Chunk ID format: `fani-2019-jrna-008-a` — the `-a/-b` suffix tracks sub-splits
- **Map-description chunks:** Pages 21–22 were cyclone track maps; OCR returned nothing.
  Described from visual inspection, stored as `chunk_type: map-description`.
  Contains real retrievable content (storm surge height, evacuation numbers,
  district geography) rather than being dropped.
- **Semantic enrichment tags** (rule-based, no LLM calls):
  `content_type`, `actionability` (high/medium/low), `time_phase`
  (pre-landfall / immediate-response / recovery / unspecified)
  These drive agent routing: Alert-Generator filters for `actionability: high`,
  Resource-Planner filters for `content_type: statistics`

**UNICEF Fani SitRep 2019 — Section-boundary chunking**
- Target: 200–400 words per chunk (SitRep sections are shorter than JRNA sectors)
- One chunk per JRNA sector finding, tagged with `sector` metadata
- "Immediate humanitarian needs" split into two chunks on hazard tag difference
  (heatwave+WASH vs other sectors) — not just size, but metadata correctness
- Source inconsistency preserved: livestock casualties appear as 3.73M in sidebar
  and 3.45M in narrative; both kept with explicit note rather than silently picking one

**UNDP Phailin DRM Survey — Section-aware**
- Standard section-boundary chunking, 500 tokens
- Tagged `document_role: lessons_learned` to distinguish from damage assessment docs

### 3.3 Structured Extraction: The Qdrant / PostgreSQL Split
**The core principle:** structured, lookup-queryable data goes to PostgreSQL. Everything
else goes to Qdrant. Never embed a table as prose.

| What | Where | Why |
|---|---|---|
| SDRF compensation norms | PostgreSQL | Exact figures, SQL lookup is precise |
| Cyclone shelter directory (182 rows) | PostgreSQL | Block/capacity/location lookups |
| Rescue boats, health infra, NGOs | PostgreSQL | Operational resource queries |
| Contact directories | PostgreSQL | Exact phone number lookup |
| SOP prose, assessment narratives | Qdrant | Semantic queries |
| Table-reference chunks | Qdrant | Routing hints to SQL |

**Final corpus statistics:**

| Document | Vector points | Structured rows / tables |
|---|---|---|
| Odisha SDMP 2019 | 154 | 13 tables |
| Puri DDMP Vol I 2017–18 | 135 | 4 tables (incl. 182 shelters) |
| Cyclone Phailin RDNA 2013 | 40 | 3 tables |
| UNDP Phailin DRM Survey 2013 | 105 | 1 table |
| Cyclone Fani JRNA 2019 | 39 | 2 tables |
| UNICEF Fani SitRep 2019 | 29 | 1 table |
| **Subtotal (core corpus)** | **502** | **24 tables / 705 rows** |
| Puri DDMP Vol II 2017–18 | — | 5 tables / 101 rows |
| **Total** | **502** | **29 tables / 806 rows** |

### 3.4 Metadata Schema
**Every chunk and every PostgreSQL row carries these fields.** The metadata is what makes
retrieval precision and the temporal filter possible.

| Field | Type | Purpose |
|---|---|---|
| `chunk_id` | string | Unique identifier, e.g. `fani-2019-jrna-008-a` |
| `event_id` | string | `cyclone_fani_2019`, `cyclone_phailin_2013` — the CRAG contamination signal |
| `disaster_type` | string | `cyclone`, `flood`, `generic` |
| `document_role` | string | `SOP`, `assessment`, `directory`, `lessons_learned` |
| `valid_as_of` | date | Publication date — enables the temporal hard filter |
| `access_policy` | string | `public` or `operator_only` — enforced before retrieval |
| `region` | string | `odisha_state`, `puri_district`, `block_level` |
| `sector` | string | `water-sanitation-hygiene`, `shelter-and-housing`, etc. |
| `time_phase` | list | `pre-landfall`, `immediate-response`, `recovery`, etc. |
| `actionability` | string | `high` / `medium` / `low` |
| `content_type` | string | `statistics`, `recommendation`, `action-taken`, etc. |
| `source_authority` | string | `state`, `national`, `inter-agency` |

> **Why the metadata matters:** Without `event_id`, CRAG cannot detect cross-event
> contamination. Without `valid_as_of`, the temporal filter cannot enforce the pre-event
> constraint. Without `access_policy`, contact directories leak to citizen-facing queries.
> The metadata is not bookkeeping — it is load-bearing architecture.

---

## Chapter 4 — System Architecture

**Purpose:** The full technical blueprint. Diagrams first, prose explains decisions not
visible in diagrams. A reader should understand why each component exists, not just
what it does.

### 4.1 Four-Layer Overview
Include the layer diagram (TikZ from existing report, keep it):
- Layer 1: Knowledge Base & Hybrid RAG
- Layer 2: Multi-Agent LLM Reasoning
- Layer 3: Resource Allocation
- Layer 4: Interface (in progress)

Note: Layers 1–3 fully implemented and evaluated. Layer 4 exists (React dashboard) but
is not an engineering contribution — mention in one sentence only.

### 4.2 Hybrid Retrieval

**The routing decision:**
- "How many shelters are in Puri?" → `query_postgres`
- "What should the Agriculture Department do during a VSCS warning?" → `search_qdrant`
- "How many shelters are in Puri and what are the SOPs for opening them?" → both,
  agent makes two tool calls and synthesises

**Scoring:**
```
score_final(z) = sim(x, z) · λ^(t_current − t_document)
```
- λ ∈ (0,1) chosen so a five-year-old document receives ~half the weight of a current one
- This is a **soft preference** — recency influences ranking but does not exclude documents
- The temporal filter in Ch 5 is a **hard constraint** — it excludes post-event documents entirely

**Why not metadata filters alone?**
- Metadata filters narrow the candidate set but run alongside similarity computation
- A contaminating chunk that scores 0.91 similarity and then gets filtered still consumed
  the top-k budget
- CRAG is needed as a second gate after retrieval

### 4.3 Context Engineering
**The second under-served section in the old report. The full 6-stage pipeline:**

**Stage 1 — Role-based access filtering**
- User role (`operator` / `public`) determines which chunks are eligible before any search
- `operator_only` chunks (contact directories, sensitive tables) never appear in public queries
- The access gate is applied to the retrieval filter, not post-hoc

**Stage 2 — Triage Agent routing**
- Reads query, classifies into one of four categories, hands off to specialist
- Calls no tools — routing only
- The specialist's system prompt is already part of the context before retrieval begins
- Each specialist agent's system prompt encodes domain-specific constraints:
  e.g. Resource Allocation Agent: "NGO queries must fetch all NGOs in a block before
  filtering by specialisation, since specialisation strings are not standardised"

**Stage 3 — Hybrid retrieval with recency scoring**
- `search_qdrant`: cosine similarity modulated by recency decay
- `query_postgres`: exact SQL for structured data
- Results from both assembled together when query requires both

**Stage 4 — CRAG evaluation**
- Top-k chunks pass through CRAG before reaching the LLM context
- Two signals: cosine threshold + `event_id` consistency
- RELEVANT → proceed; PARTIALLY RELEVANT → proceed with low-confidence flag;
  IRRELEVANT → no chunks reach context, structured refusal returned
- This is the hard gate that eliminates cross-event contamination at the context level

**Stage 5 — Context assembly**
Four components assembled in order:
1. Specialist system prompt (domain constraints, output schema, citation requirement)
2. Ranked vector chunks (ordered by `score_final`, each carrying source metadata)
3. SQL rows (formatted structured data, included as grounded factual context)
4. Citation anchors (every response must cite ≥1 chunk or row — enforced at prompt level)

**Stage 6 — Constrained generation (Claude Sonnet 4.5)**
- Fixed output schema: answer + confidence (HIGH/MEDIUM/LOW) + citations
- Grounding before generation: no parametric memory answers — every claim must
  be traceable to a retrieved chunk or SQL row
- Refuse rather than guess: when CRAG returns IRRELEVANT, the agent returns
  a structured LOW-confidence refusal naming the constraint explicitly

### 4.4 Multi-Agent Orchestration
Include the agent diagram (TikZ from existing report):

| Agent | Handles | Primary tools |
|---|---|---|
| Triage Agent | Classification and routing only | None |
| Disaster Response Agent | SOPs, evacuation, historical events | Qdrant + Postgres |
| Relief & Finance Agent | SDRF norms, ex-gratia, packages | Postgres (primary) |
| Preparedness Agent | Shelters, early warning, training | Qdrant + Postgres |
| Resource Allocation Agent | Boats, medical, NGOs, camp plans | Postgres (all 5 Vol II tables) |

**Why four specialists, not one monolithic agent?**
- Drammeh (2025): multi-agent vs single-agent gap is striking in operational contexts
- Focused system prompt + smaller toolset = more reliable per-query performance
- Each agent's prompt is tailored to its domain — the Preparedness Agent knows
  the shelter directory schema; the Relief Agent knows the SDRF table structure

**Resource Allocation Agent — the Vol II tables it uses:**

| Table | Rows | Contents |
|---|---|---|
| `rescue_boats` | 10 | Power boats per block, 27 total district-wide |
| `health_infrastructure` | 11 | PHCs, CHCs, ambulances, blood banks per block |
| `medical_personnel` | 11 | Doctors, paramedical staff, ANMs, ASHAs per block |
| `telecom_stations` | 12 | VHF and IMD/CWD stations per block |
| `ngos` | 56 | NGO/CBO names, blocks, specialisations |

### 4.5 CRAG Evaluator
**Two signals, three labels:**

Signal 1 — Maximum cosine similarity in the retrieval set
- Below threshold → evidence is weak → IRRELEVANT

Signal 2 — `event_id` metadata consistency
- Query is about Fani, every chunk has `event_id = cyclone_phailin_2013` →
  IRRELEVANT regardless of similarity scores
- This is the cross-event contamination check — it cannot be replicated by
  metadata filters alone because similarity scores are computed before filters

**What each label produces:**
- RELEVANT → chunks proceed to context assembly
- PARTIALLY RELEVANT → chunks proceed, LOW-confidence flag attached to output
- IRRELEVANT → zero chunks reach context; agent returns:
  "The retrieved information pertains to Cyclone Phailin, not Cyclone Fani;
  declining to answer." — this refusal is scored as CORRECT behaviour in evaluation

**Why refusal is the right behaviour:**
A system that produces zero confident wrong answers is operationally safer than one
with a marginally higher average score. In a government crisis context, a confident
wrong answer is not a tolerable failure mode.

### 4.6 Audit Trail
Every agent decision written to a PostgreSQL audit table. Each row records:
- The query
- The agent that handled it
- The tools called and in what order
- The documents/rows returned and their similarity scores
- The CRAG decision
- The full system prompt used
- The raw response
- The confidence level
- A timestamp

**Why this is non-negotiable:**
In a government decision-support context, an operator must be able to inspect why the
system said what it said. The audit trail is not logging — it is accountability infrastructure.
It is also what makes the Fani Replay evaluation reproducible.

---

## Chapter 5 — Evaluation

**Purpose:** Honest, rigorous evidence that the platform works — and honest accounting
of where it does not. Two distinct evaluation modes with a clear logical progression.

### 5.1 Evaluation Design

**Model choices:**
- Embeddings: OpenAI `text-embedding-3-small` (well-calibrated, stable)
- Generation: Claude Sonnet 4.5 (replaces GPT-4o from the previous iteration)
- Rationale for the split: embedding quality and generation quality are separable concerns;
  Claude Sonnet produces more careful, better-cited prose and handles structured
  refusals more reliably

**Scoring rubric (per query, max 9/9):**

| Dimension | 0 | 1–2 | 3 |
|---|---|---|---|
| Factual Grounding | Contradicts corpus / hallucinates | Partially grounded | Consistent with corpus/ground truth |
| SOP Alignment | Contradicts SDMP/DDMP SOPs | Partially aligned | Fully aligned |
| Appropriate Uncertainty | Confident wrong answer (hallucination) | Inconsistent confidence | Confident correct OR correct refusal |

> A confident correct answer scores 3/3 on Uncertainty.
> A low-confidence refusal of an unanswerable question also scores 3/3.
> A confident wrong answer scores 0/3 and is flagged as a hallucination.

**Query design principles:**
- Every query must test a specific engineering property of the system
- No padding queries that any retrieval system would answer correctly
- Queries are designed to expose specific failure modes: cross-event contamination,
  operator-only data leakage, questions with no corpus support

### 5.2 Fani Replay

**Purpose:** Test historical accuracy and cross-event contamination prevention.
Simulate the morning of 2 May 2019 (day before landfall). Corpus restricted to
`valid_as_of ≤ 2019-05-02`. Post-event documents (Fani JRNA, UNICEF SitRep)
held out as ground truth.

**Why Fani specifically:**
1. The pre-event corpus (SDMP, DDMP, Phailin reports) was genuinely available before Fani
2. Two clean post-event assessments provide verifiable ground truth
3. Phailin and Fani are similar in track and intensity — a careless retriever will confuse them,
   which is exactly the failure CRAG is designed to catch

**Configuration A (temporal filter + CRAG active):**
Documents with `valid_as_of > 2019-05-02` excluded from search entirely.

**Configuration B (no temporal filter, CRAG active):**
Full corpus accessible. Control condition to isolate the temporal filter's contribution.

**Query categories:**
- Planning queries (P1–P5): pre-event SOPs, SDRF norms, shelter locations, early warning
- Impact queries (I1–I6): post-event damage figures — system should refuse these under Config A
- Cross-contamination queries (C1–C3): questions about Fani designed to retrieve Phailin content

> **Results table — fill after evaluation:**

| Query | Category | Agent | Config A score | Config B score | Notes |
|---|---|---|---|---|---|
| P1 | Planning | Disaster Response | /9 | /9 | |
| P2 | Planning | Relief & Finance | /9 | /9 | |
| P3 | Planning | Preparedness | /9 | /9 | |
| P4 | Planning | Resource Allocation | /9 | /9 | |
| P5 | Planning | Disaster Response | /9 | /9 | |
| I1 | Impact | Disaster Response | /9 | /9 | |
| I2 | Impact | Relief & Finance | /9 | /9 | |
| I3 | Impact | Disaster Response | /9 | /9 | |
| C1 | Cross-contamination | Disaster Response | /9 | /9 | |
| C2 | Cross-contamination | Preparedness | /9 | /9 | |
| **Total** | | | **/9** | **/9** | |
| **Hallucinations** | | | **0?/N** | **?/N** | |

**Key findings to report (fill after evaluation):**
- [ ] Did Config A achieve 0 hallucinations?
- [ ] Did CRAG correctly fire on cross-contamination queries?
- [ ] Did impact queries produce correct refusals under Config A?
- [ ] What is the gap between Config A and Config B?

### 5.3 Dana Operational Readiness Test

**Purpose:** Test operational utility during a live disaster scenario.
Uses actual IMD bulletin data from Cyclone Dana (October 2024) as system input,
simulating a District Collector querying the platform while the disaster is actively unfolding.

**What this tests that the Fani Replay does not:**
- The Fani Replay tests the system on structured, clean post-event reports as ground truth
- The Dana test feeds raw operational data — wind speeds, landfall coordinates, storm surge
  forecasts, time-to-landfall figures — and asks whether the system can cross-reference
  this against SDMP SOPs and DDMP resources to produce actionable output
- There is no "correct answer" file — evaluation is against: did the system retrieve the
  right SOP? Did it correctly refuse impact questions (no damage data exists yet)? Did it
  produce a useful synthesis?

**Bulletin input:** IMD Dana bulletin (October 2024 landfall)
- Include key bulletin parameters: category, wind speed, predicted track, affected districts,
  time to landfall as used in the test

**Query design for Dana:**
- Operational queries grounded in bulletin data, e.g.:
  "Given Puri district is in the predicted landfall zone with Category 3 intensity,
   which blocks should be prioritised for evacuation and how many shelters are available?"
- SOP activation queries: "What should the Health Department activate in the next 12 hours
   per the SDMP?"
- Resource queries: "What NDRF resources are pre-positioned and where?"
- Impact queries the system should refuse: "How many people have been affected by Dana?"
  (no data exists yet — correct behaviour is a structured refusal)

> **Results table — fill after evaluation:**

| Query | Type | Agent | Score | Correct refusal? | Notes |
|---|---|---|---|---|---|
| D1 | Operational | Preparedness | /9 | — | |
| D2 | Operational | Disaster Response | /9 | — | |
| D3 | Operational | Resource Allocation | /9 | — | |
| D4 | Operational | Relief & Finance | /9 | — | |
| D5 | Impact (should refuse) | Disaster Response | /9 | Y/N | |
| D6 | Impact (should refuse) | Relief & Finance | /9 | Y/N | |
| **Total** | | | **/9** | | |

**Key findings to report (fill after evaluation):**
- [ ] Could the system synthesise bulletin data with SDMP SOPs correctly?
- [ ] Did it correctly refuse impact questions for which no data exists?
- [ ] Did the Resource Allocation Agent return useful block-level data?
- [ ] Response latency under operational conditions

### 5.4 Cross-Cutting Findings
**Write this section last, after both evaluations are complete.**

Cover:
- Zero hallucinations claim: what the numbers actually show
- CRAG's contribution independent of the temporal filter
- Calibrated refusals vs confident wrong answers — the operational safety argument
- Where the system correctly declines vs where it should decline but does not
- Comparison of Fani vs Dana performance — what differs between historical and live-data queries

---

## Chapter 6 — Discussion

**Purpose:** Synthesise results honestly. Explain failures as clearly as successes.

### 6.1 Why Configuration A is Operationally Safer Than Configuration B
- The gap between configs is small overall, but concentrated in impact queries
- Config A correctly refuses questions the system cannot answer; Config B sometimes guesses
- In a crisis context, a confident wrong answer about evacuation numbers or resource counts
  is not a tolerable failure — refusal is the correct behaviour

### 6.2 Failure Modes
Document each failure honestly:

**NGO free-text filter failure:**
- SQL filter on `specialisation` column returned 0 results for Brahmagiri NGOs
- Root cause: specialisation strings in the database are varied and unstandardised
- Fix: fetch all NGOs in a block, let Claude do semantic filtering in text
- General principle: SQL filters on free-text fields should never be used when
  values are not standardised

**Map pages with no OCR:**
- Pages 21–22 of Fani JRNA were cyclone track maps — OCR returned nothing
- Resolution: described from visual inspection, stored as `chunk_type: map-description`
- Limitation: map-description quality depends on manual visual inspection accuracy

**Source inconsistency in the SitRep:**
- UNICEF SitRep reports livestock casualties as 3.73M (sidebar) and 3.45M (narrative)
- Both figures preserved with explicit note rather than silently resolving
- Downstream consumers must be aware: figures from SitReps should be verified
  against the final JRNA

**Evacuation count inconsistency:**
- SitRep page 4: 1.34 million evacuated; page 5: 14,70,197 (1.47 million)
- Both figures flagged explicitly in chunks rather than one discarded

### 6.3 What the Work Does Not Claim
- No real-time data ingestion — the corpus is static; IMD bulletin data was manually
  ingested for the Dana test, not automatically fetched
- No predictive modelling — the platform retrieves and synthesises; it does not forecast
- Geographic scope: Puri district and Odisha only — the corpus and the DDMP
  shelter/resource tables are Puri-specific
- Scaling to other districts requires replicating the ingestion and agent design

---

## Chapter 7 — Conclusion and Future Work

**Purpose:** Short. Restate engineering claims. Point to concrete next steps.
**Target length:** 2–3 pages.

### 7.1 What This Work Demonstrates
Restate the three engineering claims from Ch 1 now backed by evaluation evidence:
1. The section-aware ingestion pipeline correctly preserves document structure:
   [cite specific planning query results where correct SOP sections were retrieved]
2. CRAG eliminates cross-event contamination: [cite contamination query results]
3. The two-tier evaluation protocol provides honest evidence: [cite hallucination counts]

### 7.2 Future Work
**Multi-collection Qdrant architecture:**
- Current: single collection, 502 points, separation enforced by metadata filters + CRAG
- Proposed: separate collections for `planning_sops`, `event_phailin_2013`,
  `event_fani_2019`, `lessons_learned`
- Benefit: cross-event contamination becomes architecturally impossible for
  single-event queries, not just filtered post-retrieval
- Cost: cross-event comparison queries require two collection searches + synthesis

**Automated IMD bulletin ingestion:**
- Event-triggered pipeline: when IMD publishes a new bulletin (every 6 hours during
  cyclone season), automatically fetch, parse, chunk, embed, and upsert into Qdrant
- `valid_as_of` and recency decay already designed for this — the architecture supports it
- Engineering work: scheduled fetcher + bulletin PDF parser + incremental upsert pipeline

**Geographic expansion:**
- Corpus currently covers Puri district only at DDMP level
- Expanding to all 30 Odisha districts requires replicating the DDMP ingestion pipeline
  per district — significant corpus work but no architectural changes needed
- State-level expansion (other Indian states) requires adapting metadata schema
  to different state DMP structures

---

## What Is Not in This Report

| Topic | Reason excluded |
|---|---|
| Frontend React dashboard | Implementation detail, not an engineering contribution |
| Standalone Resource Allocation chapter | Folded into Ch 4 as an architectural component |
| GPT-4o evaluation results | Superseded by Claude Sonnet 4.5 evaluation |
| 15-query evaluation from old report | Replaced by tighter, purpose-designed query sets |
| Odisha geography background | Not an engineering contribution |
| Long government structure description | Contextual, not technical |

---

## Writing Rules for This Report

1. **Every section earns its place.** If a paragraph cannot answer "what engineering
   decision does this justify?", cut it.
2. **Diagrams first, prose explains.** A reader should be able to follow the architecture
   from diagrams alone; prose adds the "why", not the "what".
3. **Failures as clearly as successes.** The NGO filter failure, the map OCR gap, the
   SitRep inconsistencies — all reported honestly. This is what makes evaluation credible.
4. **No fluency metrics.** BLEU, ROUGE, and perplexity measure fluency, not factual
   correctness. Every evaluation metric in this report measures correctness,
   grounding, and appropriate uncertainty.
5. **Results tables stay blank until evaluation is complete.** Do not fill in expected
   or estimated numbers. Run the evaluation, then fill the tables.
6. **The model change is stated once and clearly.** Embeddings: `text-embedding-3-small`.
   Generation: Claude Sonnet 4.5. Do not refer to GPT-4o anywhere in the final report.

---

*Last updated: Pre-evaluation. Fill Ch 5 results tables after Fani Replay and Dana Operational Test are complete.*  