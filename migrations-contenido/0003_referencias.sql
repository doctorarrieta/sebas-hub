-- Todo post de X, Threads y LinkedIn lleva su referencia bibliográfica con enlace
ALTER TABLE piezas ADD COLUMN referencia TEXT;
ALTER TABLE piezas ADD COLUMN referencia_url TEXT;
ALTER TABLE piezas ADD COLUMN ref_id TEXT;
ALTER TABLE piezas ADD COLUMN ref_intentos INTEGER NOT NULL DEFAULT 0;
