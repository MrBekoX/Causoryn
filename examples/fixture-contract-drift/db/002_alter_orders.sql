-- v2 degisiklikleri (drift fixture):
-- ADD COLUMN note        -> backward-safe ekleme adayi
-- DROP COLUMN currency   -> breaking_candidate adayi (T 11: DB kolon kaldirma -> tuketici etkisi)
-- RENAME COLUMN amount   -> rename tanima dilimi
ALTER TABLE orders ADD COLUMN note VARCHAR(256);
ALTER TABLE orders DROP COLUMN currency;
ALTER TABLE orders RENAME COLUMN amount TO amount_minor;
