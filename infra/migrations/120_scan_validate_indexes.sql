BEGIN;

CREATE INDEX IF NOT EXISTS idx_invites_code_event ON invites (code, event_id);
CREATE INDEX IF NOT EXISTS idx_guests_status_event ON guests (status, event_id);

COMMIT;
