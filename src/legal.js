// Páginas públicas de privacidad y condiciones que piden TikTok, Meta, Google y LinkedIn para las apps propias del hub.
const estilo = "font-family:system-ui;max-width:42rem;margin:6vh auto;padding:0 16px;line-height:1.6;color:#222";
const PAGINAS = {
  privacidad: [
    "Política de privacidad",
    `<p>Esta herramienta es de uso interno de Dr. Sebastián Arrieta (DOCTORARRIETA.COM E.I.R.L., Lima, Perú). Sirve para publicar el contenido que él aprueba en sus propias cuentas y para leer las estadísticas de esas mismas cuentas.</p>
<p><b>Qué datos usa:</b> datos de perfil y estadísticas públicas o de rendimiento (vistas, me gusta, comentarios, compartidos y similares) de las cuentas de redes sociales que el propio titular conecta. No recopila datos de otras personas ni los vende o comparte con terceros.</p>
<p><b>Cómo se guardan:</b> los permisos de acceso se guardan cifrados en la infraestructura de Cloudflare y solo se usan para las funciones descritas.</p>
<p><b>Cómo revocar:</b> el titular puede quitar el acceso en cualquier momento desde la configuración de aplicaciones conectadas de cada red social.</p>
<p><b>Contacto:</b> sebastian@doctorarrieta.com</p>`,
  ],
  terminos: [
    "Condiciones de servicio",
    `<p>Esta herramienta es privada y la usa únicamente Dr. Sebastián Arrieta (DOCTORARRIETA.COM E.I.R.L.) para gestionar sus propias cuentas de redes sociales: publicar el contenido que él aprueba y leer sus estadísticas.</p>
<p>No se ofrece al público. Su uso respeta las condiciones y políticas de cada plataforma conectada.</p>
<p><b>Contacto:</b> sebastian@doctorarrieta.com</p>`,
  ],
};
export function legalHttp(url) {
  const p = PAGINAS[url.pathname.replace(/^\/legal\/|\/$/g, "")];
  if (!p) return new Response("No encontrado", { status: 404 });
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p[0]}</title><body style="${estilo}"><h1>${p[0]}</h1>${p[1]}</body>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
