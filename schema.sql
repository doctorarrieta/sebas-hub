-- Tablas actuales de la base D1 "hub-salud" (copiadas de producción el 2026-10-18)
CREATE TABLE IF NOT EXISTS alertas (fecha TEXT PRIMARY KEY, nivel TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS apple_diario (fecha TEXT NOT NULL, metrica TEXT NOT NULL, unidad TEXT, valor REAL, actualizado TEXT, PRIMARY KEY (fecha, metrica));
