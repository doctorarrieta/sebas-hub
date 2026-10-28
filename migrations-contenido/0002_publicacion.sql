-- Publicación automática en X, Threads y LinkedIn (vía Ayrshare)
ALTER TABLE piezas ADD COLUMN programada_para TEXT;
ALTER TABLE piezas ADD COLUMN publicar_intentos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE piezas ADD COLUMN publicar_error TEXT;
ALTER TABLE piezas ADD COLUMN ayrshare_id TEXT;
CREATE INDEX IF NOT EXISTS piezas_programadas ON piezas (estado, programada_para);
