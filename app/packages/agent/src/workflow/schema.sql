CREATE TABLE IF NOT EXISTS frozen_inputs (
 owner_id TEXT NOT NULL, content_hash TEXT NOT NULL, input_json TEXT NOT NULL, checksum TEXT NOT NULL,
 PRIMARY KEY(owner_id,content_hash)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, content_hash TEXT NOT NULL, mode TEXT NOT NULL,
 context_json TEXT NOT NULL, run_json TEXT, checksum TEXT, revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,run_id), FOREIGN KEY(owner_id,content_hash) REFERENCES frozen_inputs(owner_id,content_hash)
);
CREATE TABLE IF NOT EXISTS model_calls (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 request_hash TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
 response_json TEXT, checksum TEXT,
 PRIMARY KEY(owner_id,run_id,call_id), UNIQUE(owner_id,run_id,ordinal),
 FOREIGN KEY(owner_id,run_id) REFERENCES workflow_runs(owner_id,run_id)
);
CREATE TABLE IF NOT EXISTS analysis_cache (
 owner_id TEXT NOT NULL, cache_key TEXT NOT NULL, data_json TEXT NOT NULL, checksum TEXT NOT NULL,
 PRIMARY KEY(owner_id,cache_key)
);
CREATE TABLE IF NOT EXISTS workflow_leases (
 owner_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, lease_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(owner_id,run_id) REFERENCES workflow_runs(owner_id,run_id)
);
CREATE TABLE IF NOT EXISTS export_profiles (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, export_id TEXT NOT NULL, profile_hash TEXT NOT NULL,
 data_json TEXT NOT NULL, checksum TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,export_id), FOREIGN KEY(owner_id,run_id) REFERENCES workflow_runs(owner_id,run_id)
);
