-- Tablas actuales de la base D1 "hub-salud" (copiadas de producción el 2026-10-18)
CREATE TABLE IF NOT EXISTS alertas (fecha TEXT PRIMARY KEY, nivel TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS apple_diario (fecha TEXT NOT NULL, metrica TEXT NOT NULL, unidad TEXT, valor REAL, actualizado TEXT, PRIMARY KEY (fecha, metrica));

-- ===== Espacio "contenido" (base D1 "hub-contenido", Worker sebas-contenido) =====
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creada TEXT NOT NULL,
  actualizada TEXT NOT NULL,
  fuente TEXT NOT NULL,            -- x, instagram, tiktok, blueprint, paper, podcast, noticia, manual, otro
  enlace TEXT UNIQUE,              -- link original (evita duplicados)
  autor TEXT,
  texto TEXT,                      -- texto, transcripción o resumen
  tema TEXT,
  estado TEXT NOT NULL DEFAULT 'nueva', -- nueva, verificando, verificada, descartada, en_produccion, usada
  prioridad TEXT NOT NULL DEFAULT 'banco', -- banco, esta_semana, grabar_hoy (la novedad)
  veredicto TEXT,                  -- conclusión de la verificación
  estudio TEXT,                    -- JSON con el estudio verificado
  notas TEXT
);
CREATE INDEX IF NOT EXISTS ideas_estado ON ideas (estado, id);
CREATE INDEX IF NOT EXISTS ideas_prioridad ON ideas (prioridad, id);

CREATE TABLE IF NOT EXISTS piezas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creada TEXT NOT NULL,
  actualizada TEXT NOT NULL,
  idea_id INTEGER REFERENCES ideas(id),
  formato TEXT NOT NULL,           -- radio, reel, reel_herida, linkedin, threads, x, carrusel, youtube, otro
  titulo TEXT,
  gancho TEXT,
  ruta_gancho TEXT,
  texto TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'por_aprobar', -- borrador, por_aprobar, aprobada, rechazada, programada, publicada
  comentario TEXT,                 -- comentario de aprobación o rechazo
  fecha_publicacion TEXT,
  enlace_publicado TEXT,
  metricas TEXT,                   -- JSON
  notas TEXT
);
CREATE INDEX IF NOT EXISTS piezas_estado ON piezas (estado, formato, id);
CREATE INDEX IF NOT EXISTS piezas_idea ON piezas (idea_id);
