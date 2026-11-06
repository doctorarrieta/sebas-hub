-- Buzón de láminas: dónde quedó en Drive cada lámina aprobada (imagen + copy)
ALTER TABLE piezas ADD COLUMN drive_enlace TEXT;
ALTER TABLE piezas ADD COLUMN drive_error TEXT;
