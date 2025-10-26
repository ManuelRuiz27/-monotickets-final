BEGIN;

ALTER TABLE events
    ADD CONSTRAINT events_organizer_id_fkey
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE RESTRICT;

ALTER TABLE guests
    ADD CONSTRAINT guests_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;

ALTER TABLE invites
    ADD CONSTRAINT invites_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;

ALTER TABLE invites
    ADD CONSTRAINT invites_guest_id_fkey
    FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE;

ALTER TABLE scan_logs
    ADD CONSTRAINT scan_logs_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;

ALTER TABLE scan_logs
    ADD CONSTRAINT scan_logs_guest_id_fkey
    FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE;

ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_organizer_id_fkey
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE;

ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;

ALTER TABLE delivery_logs
    ADD CONSTRAINT delivery_logs_guest_id_fkey
    FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE SET NULL;

ALTER TABLE ticket_ledger
    ADD CONSTRAINT ticket_ledger_organizer_id_fkey
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE;

ALTER TABLE ticket_ledger
    ADD CONSTRAINT ticket_ledger_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;

ALTER TABLE payments
    ADD CONSTRAINT payments_organizer_id_fkey
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS invites_code_unique ON invites (code);

CREATE INDEX IF NOT EXISTS idx_events_organizer ON events (organizer_id);
CREATE INDEX IF NOT EXISTS idx_guests_event_status ON guests (event_id, status);
CREATE INDEX IF NOT EXISTS idx_invites_event_guest ON invites (event_id, guest_id);
CREATE INDEX IF NOT EXISTS idx_scan_logs_event_ts ON scan_logs (event_id, ts);
CREATE INDEX IF NOT EXISTS idx_scan_logs_guest_ts ON scan_logs (guest_id, ts);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_status_created_at ON delivery_logs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_event_created_at ON delivery_logs (event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_guest_created_at ON delivery_logs (guest_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_session_created_at ON delivery_logs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_ledger_org_created_at ON ticket_ledger (organizer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_organizer_created_at ON payments (organizer_id, created_at);

COMMIT;
