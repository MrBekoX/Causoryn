-- Orders tablosunun v1 sozlesmesi (contract-drift fixture, D1 keif).
CREATE TABLE orders (
    id INTEGER NOT NULL,
    amount NUMERIC NOT NULL,
    currency VARCHAR(3),
    created_at TIMESTAMP NOT NULL
);
