-- Rendimiento de videos para el Tablero del equipo (lo escribe la revisión diaria; el equipo lo lee sin cuenta)
CREATE TABLE IF NOT EXISTS rendimiento (
  coleccion TEXT NOT NULL,          -- videos, dias, aprendizajes
  id TEXT NOT NULL,
  fecha TEXT,                       -- AAAA-MM-DD (publicación del video o día del resumen)
  datos TEXT NOT NULL,              -- JSON
  actualizada TEXT NOT NULL,
  PRIMARY KEY (coleccion, id)
);
CREATE INDEX IF NOT EXISTS rendimiento_fecha ON rendimiento (coleccion, fecha);
