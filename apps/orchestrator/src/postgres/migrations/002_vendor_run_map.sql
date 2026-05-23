-- Schema v2: vendor ↔ run id mapping for webhook ingestion routing.

CREATE TABLE IF NOT EXISTS vendor_run_map (
	vendor          text     NOT NULL,
	vendor_run_id   text     NOT NULL,
	run_id          text     NOT NULL,
	created_at      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (vendor, vendor_run_id)
);

CREATE INDEX IF NOT EXISTS vendor_run_map_run_idx ON vendor_run_map (run_id);
