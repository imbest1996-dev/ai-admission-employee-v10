# AI Admission Employee V10.0 — Live Pilot Candidate

V10 keeps the verified V9.4 admission, memory, tenant-isolation and safety engine, and adds pilot operations needed before hosting.

## V10 additions
- Persistent storage path via `DATA_DIR`.
- SQLite WAL mode and 5-second busy timeout for a small live pilot.
- Database-aware `/api/health` endpoint.
- Authenticated pilot operations status (`/api/ops/status`).
- Authenticated institute-scoped JSON export (`/api/export`) for backup/recovery.
- Structured JSON operational/error logging.
- UI controls for pilot status and owner data export.
- Deployment checklist in `DEPLOYMENT.md`.

## Verification
- Existing core regression: 7/7 PASS.
- Single-turn stress suite: 30/30 PASS.
- Multi-turn memory suite: 45/45 PASS.
- Memory architecture: 8/8 PASS.
- Adversarial/safety suite: 30/30 PASS.
- 50-student isolation suite: PASS.
- 3,000-message memory-aware simulation: PASS.
- V10 static operational checks: 12/12 PASS.
- `node --check server.js`: PASS.

`npm install` could not be completed in the build environment because package download timed out, so a live Express HTTP smoke test was not claimed here. Run `npm install` on the deployment host before `npm start`.

Real WhatsApp delivery and real payment charging remain deliberately sandboxed. OpenAI is optional; without an API key, the verified deterministic engine runs offline.
