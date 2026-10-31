// ig-motor-v43
// Publica en Instagram lo que esté programado y ya llegó a su hora.
// Lo ejecuta GitHub Actions cada ~10 minutos (.github/workflows/ig-publicar.yml). No usa librerías externas.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VER = process.env.IG_API_VERSION || 'v26.0';
const BASE = process.env.IG_QUEUE_DIR || 'ig-queue';
const REPO = process.env.GITHUB_REPOSITORY || '';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const MAX_INTENTOS = 3;
const MAX_POR_CORRIDA = 10;

const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };
const escribir = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function ig(metodo, ruta, params, token) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  p.set('access_token', token);
  let url = 'https://graph.instagram.com/' + VER + '/' + ruta;
  const opt = { method: metodo };
  if (metodo === 'GET') url += '?' + p.toString();
  else { opt.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; opt.body = p.toString(); }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error((e.error_user_msg || e.message || 'HTTP ' + r.status) + (e.code ? ' (código ' + e.code + ')' : ''));
  }
  return j;
}


// ---- Facebook (Página): publica lo mismo que en Instagram si el item trae fb:1 y están los secretos FB_PAGE_ID y FB_PAGE_TOKEN ----
const FBVER = process.env.FB_API_VERSION || VER;
async function fb(metodo, ruta, params, token) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  p.set('access_token', token);
  let url = 'https://graph.facebook.com/' + FBVER + '/' + ruta;
  const opt = { method: metodo };
  if (metodo === 'GET') url += '?' + p.toString();
  else { opt.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; opt.body = p.toString(); }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error('Facebook: ' + (e.error_user_msg || e.message || 'HTTP ' + r.status) + (e.code ? ' (código ' + e.code + ')' : ''));
  }
  return j;
}
async function esperarVideoFb(id, token) {
  for (let n = 0; n < 60; n++) {
    const j = await fb('GET', id, { fields: 'status' }, token);
    const s = (j.status && j.status.video_status) || '';
    if (s === 'ready' || s === 'published') return;
    if (s === 'error') throw new Error('Facebook no pudo procesar el video.');
    await dormir(5000);
  }
  throw new Error('Facebook tardó demasiado en procesar el video.');
}
// Reels e historias en video: subida en 3 fases (start, subir por URL, finish).
async function subirVideoFb(tipo, pg, url, descripcion, token) {
  const ini = await fb('POST', pg + '/' + tipo, { upload_phase: 'start' }, token);
  const r = await fetch(ini.upload_url, { method: 'POST', headers: { Authorization: 'OAuth ' + token, file_url: url } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error('Facebook no pudo descargar el video (' + ((j.debug_info && j.debug_info.message) || j.message || 'HTTP ' + r.status) + ').');
  const fin = { video_id: ini.video_id, upload_phase: 'finish' };
  if (tipo === 'video_reels') { fin.video_state = 'PUBLISHED'; fin.description = descripcion || ''; }
  await fb('POST', pg + '/' + tipo, fin, token);
  return ini.video_id;
}
/* Texto para Facebook: sin hashtags y sin frases propias de Instagram (link en la bio, "comentá QUIERO"). */
function fbTexto(c){
  c = String(c == null ? '' : c).replace(/\r/g, '');
  if (!c.trim()) return '';
  var cierre = 'Escribinos por mensaje privado y te contamos.', out = [], puesto = /whatsapp|escribinos|mensaje privado|\d{4}[ -]?\d{2}[ -]?\d{4}/i.test(c), L = c.split('\n');
  for (var i = 0; i < L.length; i++){
    var s = L[i];
    if (/^\s*(#[\p{L}\p{N}_]+[\s,.]*)+$/u.test(s)) continue;
    if (/\b(link|enlace)\s+(en|de)\s+(la\s+|mi\s+)?(bio|biograf[ií]a|perfil)\b|\ben\s+la\s+bio\b|[Cc]oment[aáeé][^\n]*[A-ZÁÉÍÓÚÑ]{4,}/.test(s)){
      if (!puesto){ out.push(cierre); puesto = true; }
      continue;
    }
    s = s.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');
    out.push(s);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Sube el video a Facebook UNA sola vez: apenas se publica se guarda su id (d.fbVideoId); si hay un reintento no se vuelve a subir.
// Si Facebook tarda en confirmar, se da por publicado (ya salió); solo se reintenta si Facebook dice que no pudo procesarlo.
async function subirVideoFbUnaVez(tipo, d, pg, u, txt, tk, guardar) {
  let id = d.fbVideoId || '';
  if (!id) { id = await subirVideoFb(tipo, pg, u, txt, tk); d.fbVideoId = id; if (guardar) guardar(d); }
  try { await esperarVideoFb(id, tk); }
  catch (e) {
    if (/no pudo procesar/.test(e.message)) { delete d.fbVideoId; if (guardar) guardar(d); throw e; }
    console.log('Facebook no confirmó a tiempo; se da por publicado', id, e.message);
  }
  return id;
}
async function publicarFb(d, medias, esCar, esVideo, guardar) {
  const pg = process.env.FB_PAGE_ID, tk = process.env.FB_PAGE_TOKEN, txt = d.fmt === 'historia' ? '' : (d.caption_fb != null ? String(d.caption_fb) : fbTexto(d.caption));
  const urls = [];
  for (const m of medias) { const u = urlPublica(m); await esperarArchivo(u); urls.push(u); }
  // v31: ubicación en Facebook (place = ID de la página del lugar) en fotos y carruseles; si Facebook la rechaza, publica igual sin ella.
  const lugar = (() => { const l = leer(path.join(BASE, 'ubicacion.json'), null); return l && l.on !== false && l.id ? String(l.id).replace(/\D/g, '') : ''; })();
  const conLugar = async (ruta, p) => { if (lugar) { try { return await fb('POST', ruta, Object.assign({}, p, { place: lugar }), tk); } catch (e) { console.log('Facebook: ubicación no aceptada', e.message); } } return await fb('POST', ruta, p, tk); };
  if (esCar) {
    const params = { message: txt };
    let i = 0;
    for (const u of urls) { const f = await fb('POST', pg + '/photos', { url: u, published: 'false' }, tk); params['attached_media[' + (i++) + ']'] = JSON.stringify({ media_fbid: f.id }); }
    const r = await conLugar(pg + '/feed', params);
    return 'https://www.facebook.com/' + r.id;
  }
  const u = urls[0];
  if (d.fmt === 'historia') {
    if (esVideo) { await subirVideoFbUnaVez('video_stories', d, pg, u, '', tk, guardar); return ''; }
    const f = await fb('POST', pg + '/photos', { url: u, published: 'false' }, tk);
    await fb('POST', pg + '/photo_stories', { photo_id: f.id }, tk);
    return '';
  }
  if (esVideo) { const id = await subirVideoFbUnaVez('video_reels', d, pg, u, txt, tk, guardar); return 'https://www.facebook.com/reel/' + id; }
  const r = await conLugar(pg + '/photos', { url: u, caption: txt, published: 'true' });
  return 'https://www.facebook.com/' + (r.post_id || r.id);
}

async function renovarToken(token, estado) {
  if (!estado.tokenRenovado) { estado.tokenRenovado = new Date().toISOString(); return token; }
  const dias = (Date.now() - Date.parse(estado.tokenRenovado)) / 86400000;
  if (dias < 25) { delete estado.avisoToken; return token; }
  if (!process.env.GH_PAT) {
    estado.avisoToken = 'El token de Instagram tiene ' + Math.floor(dias) + ' días y vence a los 60: pegá uno nuevo en el secreto IG_TOKEN.';
    return token;
  }
  try {
    const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
    const j = await r.json();
    if (!j.access_token) throw new Error((j.error && j.error.message) || 'sin token nuevo');
    execFileSync('gh', ['secret', 'set', 'IG_TOKEN', '--body', j.access_token, '--repo', REPO], { env: { ...process.env, GH_TOKEN: process.env.GH_PAT }, stdio: 'pipe' });
    estado.tokenRenovado = new Date().toISOString(); delete estado.avisoToken;
    return j.access_token;
  } catch (e) {
    estado.avisoToken = 'No se pudo renovar el token de Instagram: ' + e.message;
    return token;
  }
}

async function esperarListo(id, token, intentos, pausa) {
  for (let n = 0; n < intentos; n++) {
    const st = await ig('GET', id, { fields: 'status_code' }, token);
    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      const e = new Error('Instagram no pudo procesar el archivo (' + st.status_code + ').');
      e.expirado = st.status_code === 'EXPIRED';
      throw e;
    }
    await dormir(pausa);
  }
  throw new Error('Instagram tardó demasiado en procesar el archivo.');
}
const PROG = 'ig-media-prog';
const enProg = (m) => fs.existsSync(path.join(PROG, m));
const fsm = (m) => (enProg(m) ? path.join(PROG, m) : m);
const urlPublica = (m) => 'https://raw.githubusercontent.com/' + REPO + '/' + (enProg(m) ? PROG : BRANCH) + '/' + m;
async function esperarArchivo(url) {
  for (let i = 0; i < 6; i++) { try { const h = await fetch(url, { method: 'HEAD' }); if (h.ok) return; } catch (e) { return; } await dormir(2000); }
}
function borrarMedias(d) {
  for (const m of (d.medias || (d.media ? [d.media] : []))) { try { fs.unlinkSync(fsm(m)); } catch (e) {} }
}

async function publicarBase(d, token, uid, guardar) {
  const esCar = d.tipo === 'carousel';
  const medias = esCar ? (d.medias || []) : [d.media];
  if (!medias.length || medias.some((m) => !m || !fs.existsSync(fsm(m)))) throw new Error('El archivo de la publicación ya no está en el repositorio.');
  const esVideo = d.tipo === 'video';
  // d.ig === 0: solo Facebook (no toca Instagram).
  if (d.ig === 0) {
    if (!(process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN)) throw new Error('Faltan los secretos FB_PAGE_ID y FB_PAGE_TOKEN en GitHub.');
    for (const m of medias) await esperarArchivo(urlPublica(m));
    const fbLink = await publicarFb(d, medias, esCar, esVideo, guardar);
    return { id: '', permalink: '', fbLink, fbError: '' };
  }
  let creationId = d.creationId || '';
  if (!creationId) {
    let params;
    if (esCar) {
      const hijos = [];
      for (const m of medias) {
        const u = urlPublica(m); await esperarArchivo(u);
        const h = await ig('POST', uid + '/media', { image_url: u, is_carousel_item: 'true' }, token);
        await esperarListo(h.id, token, 12, 1500);
        hijos.push(h.id);
      }
      params = { media_type: 'CAROUSEL', children: hijos.join(','), caption: d.caption || '' };
    } else {
      const url = urlPublica(d.media); await esperarArchivo(url);
      params = { caption: d.fmt === 'historia' ? '' : (d.caption || '') };
      if (esVideo) { params.video_url = url; params.media_type = d.fmt === 'historia' ? 'STORIES' : 'REELS'; if (d.fmt !== 'historia') params.share_to_feed = 'true'; }
      else { params.image_url = url; if (d.fmt === 'historia') params.media_type = 'STORIES'; }
    }
    // v20: colaborador (Collab). d.colab = usuario fijado al programar; si no viene (colas), vale lo guardado en ig-queue/colab.json. Si Instagram lo rechaza, publica igual sin colaborador.
    const cu = (() => { if (d.fmt === 'historia') return ''; if (typeof d.colab === 'string') return d.colab; const c = leer(path.join(BASE, 'colab.json'), null); return c && c.on !== false && c.usuario ? String(c.usuario).replace(/^@/, '') : ''; })();
    // v30: ubicación (etiqueta de lugar). Lee ig-queue/ubicacion.json; si Instagram la rechaza, publica igual sin ella.
    const lu = (() => { if (d.fmt === 'historia') return ''; const l = leer(path.join(BASE, 'ubicacion.json'), null); return l && l.on !== false && l.id ? String(l.id).replace(/\D/g, '') : ''; })();
    let cont = null;
    const intentos = [];
    if (lu && cu) intentos.push({ location_id: lu, collaborators: JSON.stringify([cu]) });
    if (cu) intentos.push({ collaborators: JSON.stringify([cu]) });
    if (lu) intentos.push({ location_id: lu });
    for (const ex of intentos) { try { cont = await ig('POST', uid + '/media', Object.assign({}, params, ex), token); break; } catch (er) { console.log('Colaborador/ubicación no aceptados', d.id, er.message); } }
    if (!cont) cont = await ig('POST', uid + '/media', params, token);
    creationId = cont.id; d.creationId = creationId; if (guardar) guardar(d);
  }
  try { await esperarListo(creationId, token, esVideo ? 60 : 12, esVideo ? 3000 : 1500); }
  catch (e) { if (e.expirado) { delete d.creationId; if (guardar) guardar(d); } throw e; }
  // Si el contenedor ya se había publicado en un intento anterior, Instagram rechaza publicarlo de nuevo: no hay duplicados.
  const pub = await ig('POST', uid + '/media_publish', { creation_id: creationId }, token);
  let permalink = '';
  try { permalink = (await ig('GET', pub.id, { fields: 'permalink' }, token)).permalink || ''; } catch (e) {}
  // Facebook va aparte: si falla, Instagram ya salió y no se reintenta (así no hay duplicados).
  let fbLink = '', fbError = '';
  if (d.fb && process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN) {
    try { fbLink = await publicarFb(d, medias, esCar, esVideo, guardar); }
    catch (e) { fbError = e.message; console.log('Facebook falló', d.id, e.message); }
  } else if (d.fb) { fbError = 'Faltan los secretos FB_PAGE_ID y FB_PAGE_TOKEN en GitHub.'; }
  return { id: pub.id, permalink, fbLink, fbError };
}

// v32: aviso por ntfy (opcional). Si existe el secreto NTFY_TOPIC, avisa al celular de quien comparte con el enlace de Instagram y/o Facebook.
// Las historias no avisan (no se pueden compartir). Si el aviso falla, la publicación no se ve afectada.
async function avisarNtfy(d, r) {
  try {
    const topic = String(process.env.NTFY_TOPIC || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!topic || !r || d.fmt === 'historia') return;
    const ig = r.permalink || '', fbl = r.fbLink || '';
    if (!ig && !fbl) return;
    let t = String(d.caption || '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/\s+/g, ' ').trim();
    if (t.length > 160) t = t.slice(0, 157) + '…';
    const acciones = [];
    if (fbl) acciones.push({ action: 'view', label: 'Abrir Facebook', url: fbl });
    if (ig) acciones.push({ action: 'view', label: 'Abrir Instagram', url: ig });
    const cuerpo = { topic, title: 'Nueva ' + (d.fmt === 'reel' || d.tipo === 'video' ? 'reel' : 'publicación') + ' para compartir', message: t || 'Tocá para abrirla y compartirla.', priority: 4, tags: ['loudspeaker'], click: fbl || ig, actions: acciones };
    const res = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(10000) });
    if (!res.ok) console.log('ntfy respondió', res.status);
  } catch (e) { console.log('ntfy falló', e.message); }
}
async function publicar(d, token, uid, guardar) {
  const r = await publicarBase(d, token, uid, guardar);
  await avisarNtfy(d, r);
  return r;
}

const TZ = 'America/Argentina/Buenos_Aires';
const ahoraAR = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { dia: p.year + '-' + p.month + '-' + p.day, min: +p.hour * 60 + +p.minute }; };
const mezclar = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Cola de historias: a cada franja horaria publica N historias al azar del conjunto elegido en el panel.
// v29: lo mismo no sale en Historias y en Feed/Reels con menos de HORAS_ENTRE_COLAS horas de diferencia (así no quedan dos publicaciones iguales juntas).
const HORAS_ENTRE_COLAS = 24;
function matIdsDeItem(q) { return (q.matIds && q.matIds.length) ? q.matIds : (q.matId ? [q.matId] : []); }
function ultimoEnFeedPorMaterial(estado) {
  const m = {};
  for (const r of ['ig', 'fb']) {
    const c2 = leer(path.join(BASE, 'feed-' + r, 'config.json'), null);
    if (!c2) continue;
    const h = ((estado['fd' + r] || {}).publicadoEn) || {};
    for (const q of (c2.pool || [])) {
      const t = Date.parse(h[q.id] || '');
      if (!Number.isFinite(t)) continue;
      for (const id of matIdsDeItem(q)) if (!m[id] || t > m[id]) m[id] = t;
    }
  }
  return m;
}
function ultimoEnHistoriasPorMaterial(estado) {
  const m = {}, c2 = leer(path.join(BASE, 'stories', 'config.json'), null), h = (estado && estado.stPublicadoEn) || {};
  if (!c2) return m;
  for (const q of (c2.pool || [])) {
    const t = Date.parse(h[q.id] || '');
    if (!Number.isFinite(t) || !q.origen) continue;
    if (!m[q.origen] || t > m[q.origen]) m[q.origen] = t;
  }
  return m;
}
async function colaHistorias(estado, token, uid) {
  const cfg = leer(path.join(BASE, 'stories', 'config.json'), null);
  if (!cfg || cfg.pausada || !(cfg.franjas || []).length || !(cfg.pool || []).length) return;
  const { dia, min } = ahoraAR();
  const hechas = (estado.stFranjas = estado.stFranjas || {});
  for (const k of Object.keys(hechas)) if (k.slice(0, 10) < dia) delete hechas[k];
  estado.stUsados = (estado.stUsados || []).filter((id) => cfg.pool.some((p) => p.id === id));
  // Anti-repetición v21: evita repetir una historia durante 7 días si hay alternativas;
  // y nunca repite el mismo material dos veces en el mismo día, aunque se recicle la cola.
  const stHist = (estado.stPublicadoEn = estado.stPublicadoEn || {});
  const corteReciente = Date.now() - 7 * 86400000;
  for (const id of Object.keys(stHist)) {
    const t = Date.parse(stHist[id]);
    if (!Number.isFinite(t) || Date.now() - t > 30 * 86400000 || !cfg.pool.some((p) => p.id === id)) delete stHist[id];
  }
  const usadosHoy = (estado.stUsadosDia = estado.stUsadosDia || {});
  for (const id of Object.keys(usadosHoy)) if (usadosHoy[id] !== dia) delete usadosHoy[id];
  // Rotación temporal (v19): si el panel eligió un grupo chico (cfg.rotar = { ids, hasta }), por unos días solo se publica entre esas y rotan entre sí (aunque "repetir" esté apagado). El resto de la cola queda guardada y vuelve sola al pasar el día "hasta".
  const rot = (cfg.rotar && Array.isArray(cfg.rotar.ids) && (!cfg.rotar.hasta || cfg.rotar.hasta >= dia)) ? cfg.rotar.ids.filter((id) => cfg.pool.some((p) => p.id === id)) : [];
  const enRot = rot.length > 0;
  const poolAct = enRot ? cfg.pool.filter((p) => rot.includes(p.id)) : cfg.pool;
  const recic = enRot ? true : cfg.reciclar !== false;
  const diaSemH = new Date(dia + 'T12:00:00Z').getUTCDay(); // 0 = domingo ... 6 = sábado
  const franjasHoy = cfg.franjas.filter((fr) => !(Array.isArray(fr.d) && fr.d.length && !fr.d.includes(diaSemH))).map((fr) => ({ ...fr }));
  let franjas = franjasHoy;
  try { franjas = pruebaHistorias(cfg, estado, dia, min, hechas, franjasHoy); } catch (er) { console.log('Prueba de horario (historias) falló', er.message); }
  franjas = franjas.sort((a, b) => String(a.h).localeCompare(String(b.h)));
  const existe = (p) => fs.existsSync(fsm(p.media));
  const enRepo = cfg.pool.filter(existe).length;
  // Diagnóstico visible en el panel: cuándo miró el motor, cuántas historias hay de verdad en el repositorio y qué franjas faltan.
  const pendientes = franjas.filter((fr) => { const [h, m] = String(fr.h).split(':').map(Number); const ini = h * 60 + m; return !['ok', 'omitida', 'vacia', 'fallida'].includes(hechas[dia + ' ' + fr.h]) && min >= ini && min - ini <= 180; }).map((fr) => fr.h);
  estado.stChequeo = { cuando: new Date().toISOString(), cola: cfg.pool.length, enRepo, pendientes };
  for (const fr of franjas) {
    const [h, m] = String(fr.h).split(':').map(Number), ini = h * 60 + m, clave = dia + ' ' + fr.h;
    if (min < ini) continue;
    if (['ok', 'omitida', 'vacia', 'fallida'].includes(hechas[clave])) continue;
    if (min - ini > 180) { hechas[clave] = 'omitida'; continue; }
    const n = Math.min(Number(fr.n) || 1, 10);
    const enFeedAntes = ultimoEnFeedPorMaterial(estado);
    const disponibles = poolAct.filter((p) => existe(p) && !usadosHoy[p.id] && (recic || !estado.stUsados.includes(p.id)) && !(p.origen && enFeedAntes[p.origen] && Date.now() - enFeedAntes[p.origen] < HORAS_ENTRE_COLAS * 3600000));
    // Primero, material que no salió en los últimos 7 días.
    const frescas = disponibles.filter((p) => !Number.isFinite(Date.parse(stHist[p.id] || '')) || Date.parse(stHist[p.id]) < corteReciente);
    let elegidas = mezclar(frescas).sort((a, b) => (stHist[a.id] ? Date.parse(stHist[a.id]) || 0 : 0) - (stHist[b.id] ? Date.parse(stHist[b.id]) || 0 : 0)).slice(0, n); // v27: primero las nunca publicadas, luego las que hace más no salen
    // Si faltan, permite reutilizar la historia más antigua, pero nunca una ya publicada hoy.
    // Así no se repite en el mismo día y se prioriza variedad siempre que haya material.
    if (elegidas.length < n && recic) {
      const tomadas = elegidas.map((p) => p.id);
      const antiguas = disponibles.filter((p) => !tomadas.includes(p.id) && !frescas.some((q) => q.id === p.id))
        .sort((a, b) => (Date.parse(stHist[a.id] || 0) || 0) - (Date.parse(stHist[b.id] || 0) || 0));
      elegidas = elegidas.concat(antiguas.slice(0, n - elegidas.length));
      if (elegidas.length) estado.stVueltas = (estado.stVueltas || 0) + 1;
    }
    let ok = 0, fallos = 0;
    for (const p of elegidas) {
      try { await publicar({ id: p.id, tipo: p.tipo === 'video' ? 'video' : 'image', fmt: 'historia', media: p.media, fb: cfg.fb ? 1 : 0, ig: cfg.ig === 0 ? 0 : 1 }, token, uid, null); if (!estado.stUsados.includes(p.id)) estado.stUsados.push(p.id); estado.stUltimaId = p.id; stHist[p.id] = new Date().toISOString(); usadosHoy[p.id] = dia; ok++; }
      catch (e) { fallos++; estado.stError = e.message; console.log('Historia falló', p.id, e.message); }
    }
    // Si no salió ninguna por un error, se vuelve a intentar en la próxima corrida (hasta 3 veces); antes se daba la franja por hecha y quedaba sin publicar.
    const intentos = (typeof hechas[clave] === 'object' && hechas[clave] ? hechas[clave].intentos : 0) + 1;
    if (elegidas.length && !ok && intentos < 3) hechas[clave] = { intentos };
    else if (!elegidas.length) delete hechas[clave]; /* v40: sin material la franja queda pendiente hasta 3 h (igual que Feed): si sube publicidad nueva, sale igual */
    else hechas[clave] = ok ? 'ok' : 'fallida';
    if (elegidas.length) estado.stUltima = { cuando: new Date().toISOString(), franja: fr.h, ok, fallos };
    if (ok) delete estado.stError;
    if (ok && estado.stPrueba && estado.stPrueba.dia === dia && estado.stPrueba.h === fr.h) (estado.stPruebaRec = estado.stPruebaRec || []).push({ t: new Date().toISOString(), tramo: estado.stPrueba.tramo });
    if (!elegidas.length) estado.stAviso = (!recic && enRepo > 0) ? 'Ya salieron todas las historias de la cola: no se publica nada hasta que agregues más o actives repetir.' : 'No hay historias para publicar: en la cola hay ' + cfg.pool.length + ' pero solo ' + enRepo + ' están en el repositorio. Quitalas y volvé a agregarlas.';
    else if (!recic && poolAct.filter((p) => existe(p) && !estado.stUsados.includes(p.id)).length === 0) estado.stAviso = 'Ya salieron todas las historias de la cola: agregá más o activá repetir.';
    else delete estado.stAviso;
  }
}

// Cola de feed y Reels (v14, con archivos en la rama ig-media-prog sin historial): una cola por red (ig / fb), cada una con sus franjas, su material, sus textos y su control de repetidas.
// Libera el espacio: cuando una publicación de la cola ya salió y no se va a repetir, borra su archivo del repositorio (si ninguna otra cola lo necesita).
function liberarFeed(p, red, cfg, estado) {
  if (cfg.reciclar !== false) return;
  for (const r of ['ig', 'fb']) {
    const c2 = r === red ? cfg : leer(path.join(BASE, 'feed-' + r, 'config.json'), null);
    if (!c2) continue;
    const usados = ((estado['fd' + r] || {}).usados) || [];
    const otras = (c2.pool || []).filter((q) => q.media === p.media && q.id !== p.id);
    if (otras.some((q) => !usados.includes(q.id))) return;
    if (r !== red && otras.length && c2.reciclar !== false) return;
  }
  for (const x of (p.medias || [p.media])) { try { fs.unlinkSync(fsm(x)); } catch (e) {} }
}

// v34: carga automática. Reparte en el día las salidas (sin amontonar) y alterna proveedores. Sumar o quitar salidas lo deciden las ESTADÍSTICAS
// (misma regla del optimizador: días con 2+ publicaciones vs. días con 1); el material acumulado solo es el permiso para subir, nunca el motivo.
// Reglas: sin datos suficientes no se suma nada; máximo 1 cambio por día y 3 días de espera entre cambios; tope 4 por día (3 en Facebook).
// Regla compartida con el optimizador: cociente entre el alcance mediano de los días con 2+ publicaciones y el de los días con 1. null = sin muestra.
function ratioCargaMotor(items) {
  const porDia = {};
  for (const p of items) { if (!(p.score > 0)) continue; const d = new Date(p.t); if (!Number.isFinite(d.getTime())) continue; (porDia[new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)] ||= []).push(p.score); }
  const uno = [], varios = [];
  for (const a of Object.values(porDia)) { if (a.length >= 2) varios.push(medianaMotor(a)); else if (a.length === 1) uno.push(medianaMotor(a)); }
  if (uno.length < 5 || varios.length < 5) return null;
  return medianaMotor(varios) / (medianaMotor(uno) || 1);
}
// Publicaciones con métricas maduras (más de 72 h) de la red, tal como las usa el optimizador.
function itemsCargaMotor(red) {
  const D = leer(path.join(BASE, 'stats', 'datos.json'), null);
  if (!D) return [];
  const lim = Date.now() - 72 * 3600000, maduro = (t) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms < lim; };
  if (red === 'fb') return (D.fbposts || []).filter((p) => maduro(p.t)).map((p) => ({ t: p.t, score: +(p.r || 0) + 2 * (+(p.c || 0)) + 3 * (+(p.s || 0)) }));
  return (D.posts || []).filter((p) => maduro(p.timestamp)).map((p) => ({ t: p.timestamp, score: +(p.reach || 0) }));
}
// v37: tope de Reels para no saturar la cuenta. Cuenta las salidas diarias de las franjas fijadas en 'reel'; el motor no pasa más franjas a Reel ni suma extras de Reel sobre ese tope.
const MAX_REELS_DIA = 2;
// Reels por día: máximo de Reels que caen el mismo día de la semana (0 = domingo ... 6 = sábado). Con 'extra' (una franja que pasaría a Reel) mira solo los días en que esa franja corre.
function reelsDia(franjas, extra) {
  const lista = (franjas || []).filter((f) => f && f.f === 'reel'); if (extra) lista.push(extra);
  const corre = (f, d) => !(Array.isArray(f.d) && f.d.length) || f.d.includes(d);
  let max = 0;
  for (let d = 0; d < 7; d++) {
    if (extra && !corre(extra, d)) continue;
    max = Math.max(max, lista.reduce((a, f) => a + (corre(f, d) ? Math.min(Number(f.n) || 1, 5) : 0), 0));
  }
  return max;
}
// v38: el interruptor de autoajuste del panel (ig-queue/auto-ajuste.json, { on: false } lo apaga) también manda sobre las salidas extra del día.
function autoAjusteOn() { try { const aj = leer(path.join(BASE, 'auto-ajuste.json'), null); return !aj || aj.on !== false; } catch (e) { return true; } }
function frMin(h) { const [a, b] = String(h).split(':').map(Number); return a * 60 + (b || 0); }
function frTxt(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function alternarProv(orden, ultima) {
  const out = [], r = orden.slice(); let prev = ultima || '';
  while (r.length) { let i = r.findIndex((p) => !p.prov || p.prov !== prev); if (i < 0) i = 0; const p = r.splice(i, 1)[0]; out.push(p); if (p.prov) prev = p.prov; }
  return out;
}
// v41: PRUEBAS AUTOMÁTICAS DE HORARIO. El motor no solo optimiza los horarios que ya usás: cada 2 días prueba un tramo del día en el que todavía
// tiene pocos datos (ej. la mañana), moviendo UNA salida de ese día (no suma publicaciones: la cantidad por día no cambia). Cuando un tramo junta
// MIN_MUESTRA_TRAMO publicaciones con métricas maduras, deja de probarlo y el optimizador semanal compara tramos y mueve franjas al que mejor rinde.
// Se apaga con el mismo interruptor de autoajuste del panel (o con "pruebas": false en la config de la cola).
const TRAMOS_PRUEBA = [['primera mañana', 8], ['mañana', 10.5], ['mediodía', 13], ['tarde', 17], ['noche temprana', 20], ['noche', 21.5]];
const MIN_MUESTRA_TRAMO = 5, DIAS_ENTRE_PRUEBAS = 2;
function pruebaDeHorario(cfg, e, dia, min, out, red) {
  if (cfg.pruebas === false || !autoAjusteOn()) return;
  const p = (e.prueba = e.prueba || {});
  if (p.dia !== dia) {
    p.dia = dia; p.h = ''; p.de = ''; p.tramo = '';
    const rec = (e.pruebaRec = (e.pruebaRec || []).filter((x) => Date.now() - Date.parse(x.t) < 72 * 3600000));
    const ult = e.pruebaUlt ? Math.round((Date.parse(dia) - Date.parse(e.pruebaUlt)) / 86400000) : 99;
    if (ult < DIAS_ENTRE_PRUEBAS) return;
    const cuenta = {};
    for (const it of itemsCargaMotor(red)) { if (!(it.score > 0)) continue; const h = horaLocalMotor(it.t); const tr = h == null ? '' : tramoMotor(h); if (tr) cuenta[tr] = (cuenta[tr] || 0) + 1; }
    for (const r of rec) cuenta[r.tramo] = (cuenta[r.tramo] || 0) + 1; // lo recién publicado en prueba todavía no tiene métricas maduras
    const trDe = (s) => tramoMotor(horaNumMotor(s.h));
    const cands = TRAMOS_PRUEBA.filter(([tr]) => (cuenta[tr] || 0) < MIN_MUESTRA_TRAMO && !out.some((s) => trDe(s) === tr))
      .sort((a, b) => (cuenta[a[0]] || 0) - (cuenta[b[0]] || 0));
    const reemplazables = out.filter((s) => frMin(s.h) > min + 10 && !e.franjas[dia + ' ' + s.h])
      .sort((a, b) => (cuenta[trDe(b)] || 0) - (cuenta[trDe(a)] || 0));
    for (const [tr, h0] of cands) {
      for (const s of reemplazables) {
        const otros = out.filter((x) => x !== s).map((x) => frMin(x.h));
        const hx = [h0, h0 + .5, h0 - .5, h0 + 1, h0 - 1].map(horaTextoMotor).find((v) => tramoMotor(horaNumMotor(v)) === tr && frMin(v) > min + 10 && otros.every((m) => Math.abs(m - frMin(v)) >= 120));
        if (hx) { p.h = hx; p.de = s.h; p.tramo = tr; e.pruebaUlt = dia; break; }
      }
      if (p.h) break;
    }
  }
  if (p.h && p.de) { const s = out.find((x) => x.h === p.de); if (s) { s.h = p.h; s.prueba = true; } }
}
// v42: PRUEBAS AUTOMÁTICAS DE HORARIO EN HISTORIAS (Instagram y Facebook salen de la MISMA cola, así que comparten horarios).
// Igual que en Feed/Reels: cada 2 días mueve UNA tanda del día a un tramo con pocos datos. No suma ni quita historias.
// En Historias cada tanda (varias historias seguidas) cuenta como UNA sola muestra, porque salen juntas. La medición sale de Instagram (alcance);
// Facebook no entrega métricas de historias, así que sigue los horarios que mejor rinden en Instagram.
function itemsHistoriasMotor() {
  const D = leer(path.join(BASE, 'stats', 'datos.json'), null);
  if (!D) return [];
  const lim = Date.now() - 26 * 3600000;
  const todas = Object.values(D.historias || {}).map((p) => ({ t: p.t, ms: Date.parse(p.t), score: +(p.a || 0) })).filter((p) => Number.isFinite(p.ms) && p.ms < lim).sort((a, b) => a.ms - b.ms);
  const out = []; let ult = -Infinity;
  for (const p of todas) { if (p.ms - ult > 45 * 60000) out.push({ t: p.t, score: p.score }); ult = p.ms; }
  return out;
}
function primerasTandaMotor(a) {
  const o = a.slice().sort((x, y) => Date.parse(x.t) - Date.parse(y.t)), r = []; let ult = -Infinity;
  for (const p of o) { const ms = Date.parse(p.t); if (ms - ult > 45 * 60000) r.push(p); ult = ms; }
  return r;
}
function pruebaHistorias(cfg, estado, dia, min, hechas, franjas) {
  if (cfg.pruebas === false || !autoAjusteOn()) { delete estado.stInfoPrueba; return franjas; }
  const p = (estado.stPrueba = estado.stPrueba || {});
  if (p.dia !== dia) {
    p.dia = dia; p.h = ''; p.de = ''; p.tramo = '';
    const rec = (estado.stPruebaRec = (estado.stPruebaRec || []).filter((x) => Date.now() - Date.parse(x.t) < 30 * 3600000));
    const ult = estado.stPruebaUlt ? Math.round((Date.parse(dia) - Date.parse(estado.stPruebaUlt)) / 86400000) : 99;
    if (ult >= DIAS_ENTRE_PRUEBAS) {
      const cuenta = {};
      for (const it of itemsHistoriasMotor()) { if (!(it.score > 0)) continue; const h = horaLocalMotor(it.t); const tr = h == null ? '' : tramoMotor(h); if (tr) cuenta[tr] = (cuenta[tr] || 0) + 1; }
      for (const r of rec) cuenta[r.tramo] = (cuenta[r.tramo] || 0) + 1; // lo recién publicado en prueba todavía no tiene métricas maduras
      const trDe = (s) => tramoMotor(horaNumMotor(s.h));
      const cands = TRAMOS_PRUEBA.filter(([tr]) => (cuenta[tr] || 0) < MIN_MUESTRA_TRAMO && !franjas.some((s) => trDe(s) === tr))
        .sort((a, b) => (cuenta[a[0]] || 0) - (cuenta[b[0]] || 0));
      const reemplazables = franjas.filter((s) => frMin(s.h) > min + 10 && !hechas[dia + ' ' + s.h])
        .sort((a, b) => (cuenta[trDe(b)] || 0) - (cuenta[trDe(a)] || 0));
      for (const [tr, h0] of cands) {
        for (const s of reemplazables) {
          const otros = franjas.filter((x) => x !== s).map((x) => frMin(x.h));
          const hx = [h0, h0 + .5, h0 - .5, h0 + 1, h0 - 1].map(horaTextoMotor).find((v) => tramoMotor(horaNumMotor(v)) === tr && frMin(v) > min + 10 && !hechas[dia + ' ' + v] && otros.every((m) => Math.abs(m - frMin(v)) >= 120));
          if (hx) { p.h = hx; p.de = s.h; p.tramo = tr; estado.stPruebaUlt = dia; break; }
        }
        if (p.h) break;
      }
    }
  }
  if (p.h && p.de) { const s = franjas.find((x) => x.h === p.de); if (s) { s.h = p.h; s.prueba = true; } }
  if (p.dia === dia && p.h) estado.stInfoPrueba = 'Prueba de horario hoy: ' + p.h + ' (' + p.tramo + ') en lugar de ' + p.de + '.'; else delete estado.stInfoPrueba;
  return franjas;
}
// v43: AGENDA INICIAL AUTOMÁTICA. Solo si una cola tiene material pero NINGUNA franja (nunca pisa una agenda existente), el motor arma una de partida
// repartida en distintos tramos del día. Desde ahí las pruebas de horario y el ajuste semanal la van corrigiendo con las estadísticas.
// Se apaga con el interruptor de autoajuste o con "agendaAuto": false en la config de la cola. La cantidad de salidas por día es chica a propósito.
const AGENDA_INICIAL = {
  'stories/config.json': [{ h: '10:30', n: 3, f: '' }, { h: '17:00', n: 3, f: '' }, { h: '21:00', n: 3, f: '' }],
  'feed-ig/config.json': [{ h: '12:30', n: 1, f: '' }, { h: '17:30', n: 1, f: '' }, { h: '20:30', n: 1, f: '' }],
  'feed-fb/config.json': [{ h: '12:30', n: 1, f: '' }, { h: '19:00', n: 1, f: '' }]
};
function agendaInicialAuto() {
  if (!autoAjusteOn()) return;
  for (const [ruta, franjas] of Object.entries(AGENDA_INICIAL)) {
    try {
      const cfg = leer(path.join(BASE, ruta), null);
      if (!cfg || cfg.pausada || cfg.agendaAuto === false || !(cfg.pool || []).length || (cfg.franjas || []).length) continue;
      const antes = JSON.parse(JSON.stringify(cfg));
      cfg.franjas = franjas.map((f) => ({ ...f })); cfg.agendaAuto = 'inicial';
      escribirConfigOptimizada(ruta, antes, cfg, 'Agenda inicial automática (la cola no tenía horarios): ' + franjas.map((f) => f.h + (f.n > 1 ? ' x' + f.n : '')).join(', ') + '.');
    } catch (er) { console.log('Agenda inicial falló', ruta, er.message); }
  }
}
function slotsHoy(cfg, e, dia, diaSem, pend, red) {
  const tope = red === 'fb' ? 3 : 4, SEP = 150, out = [];
  for (const fr of cfg.franjas) {
    if (Array.isArray(fr.d) && fr.d.length && !fr.d.includes(diaSem)) continue;
    const n = Math.min(Number(fr.n) || 1, 5), b = frMin(fr.h);
    for (let k = 0; k < n; k++) { let t = b + k * SEP; if (t > 23 * 60 + 30) t = b - k * SEP; if (t < 7 * 60) t = b; const h = frTxt(t); if (!out.some((s) => s.h === h)) out.push({ h, n: 1, f: fr.f || '', d: fr.d }); }
  }
  // El límite diario se aplica también a las franjas ya configuradas, no solo a los extras automáticos.
  out.sort((a, b) => String(a.h).localeCompare(String(b.h)));
  const recortadas = Math.max(0, out.length - tope);
  if (recortadas) out.splice(tope);
  try { pruebaDeHorario(cfg, e, dia, ahoraAR().min, out, red); } catch (er) { console.log('Prueba de horario falló', er.message); }
  const c = (e.carga = e.carga || { nivel: 0, dia: '', extras: [] });
  c.nivel = Math.min(Math.max(0, Number(c.nivel) || 0), Math.max(0, tope - out.length));
  if (c.dia !== dia) {
    c.dia = dia; const total = out.length + (c.nivel || 0), nivel0 = c.nivel || 0;
    let ratio = null; try { ratio = ratioCargaMotor(itemsCargaMotor(red)); } catch (er) {}
    const espera = c.cambio ? Math.round((Date.parse(dia) - Date.parse(c.cambio)) / 86400000) : 99; // días desde el último cambio
    let paso = 0, motivo = '';
    if (ratio === null) { if (nivel0 > 0) { paso = -1; motivo = 'sin estadísticas suficientes que respalden salidas extra'; } else motivo = 'sin estadísticas suficientes: se mantiene tu ritmo'; }
    else if (ratio < 0.70 && nivel0 > 0) { paso = -1; motivo = 'las salidas extra bajan el alcance por publicación ' + Math.round((1 - ratio) * 100) + '%'; }
    else if (ratio >= 0.90 && pend > total * 2 && total < tope) { if (espera >= 3) { paso = 1; motivo = 'hay material acumulado y publicar más no baja el alcance por publicación (' + Math.round(ratio * 100) + '%)'; } else motivo = 'esperando que maduren las publicaciones del último cambio'; }
    else motivo = 'las estadísticas no justifican cambiar la cantidad';
    if (paso !== 0 && paso > 0 && espera < 3) paso = 0;
    if (paso !== 0 && !autoAjusteOn()) { motivo = 'propuesta: ' + (paso > 0 ? 'sumar' : 'quitar') + ' una salida extra (' + motivo + '). Autoajuste apagado: no lo aplico solo'; paso = 0; }
    c.nivel = Math.max(0, nivel0 + paso);
    if (paso !== 0) c.cambio = dia;
    c.motivo = motivo;
    c.extras = [];
    for (let i = 0; i < c.nivel; i++) {
      let mejor = null, dm = 0; const ocup = out.map((s) => frMin(s.h)).concat(c.extras.map(frMin));
      for (let m = 8 * 60; m <= 22 * 60; m += 30) { const d = ocup.length ? Math.min(...ocup.map((x) => Math.abs(x - m))) : 999; if (d > dm) { dm = d; mejor = m; } }
      if (mejor !== null && dm >= 120) c.extras.push(frTxt(mejor));
    }
  }
  const reelsHoy = out.filter((s) => s.f === 'reel').length; // cuenta antes de sumar extras
  for (const h of c.extras || []) if (!out.some((s) => s.h === h)) out.push({ h, n: 1, f: reelsHoy >= MAX_REELS_DIA ? 'feed' : '' });
  e.infoCarga = out.length + ' salida' + (out.length === 1 ? '' : 's') + ' hoy' + (c.extras && c.extras.length ? ' (' + c.extras.length + ' sumada' + (c.extras.length === 1 ? '' : 's') + ' por estadísticas)' : '') + ', separadas al menos 2 h; ' + pend + ' esperando' + (c.motivo ? ' (' + c.motivo + ')' : '') + '.' + (recortadas ? ' Tus franjas suman más del tope de ' + tope + ' por día: ' + recortadas + ' no se usan.' : '') + (reelsHoy > MAX_REELS_DIA ? ' Hay ' + reelsHoy + ' Reels programados hoy (recomendado hasta ' + MAX_REELS_DIA + ').' : '');
  if (e.prueba && e.prueba.dia === dia && e.prueba.h) e.infoCarga += ' Prueba de horario hoy: ' + e.prueba.h + ' (' + e.prueba.tramo + ') en lugar de ' + e.prueba.de + '.';
  return out.sort((a, b) => String(a.h).localeCompare(String(b.h)));
}
async function colaFeed(estado, token, uid, red) {
  const cfg = leer(path.join(BASE, 'feed-' + red, 'config.json'), null);
  if (!cfg || cfg.pausada || !(cfg.franjas || []).length || !(cfg.pool || []).length) return;
  const { dia, min } = ahoraAR(), K = 'fd' + red;
  const e = (estado[K] = estado[K] || { franjas: {}, usados: [] });
  for (const k of Object.keys(e.franjas)) if (k.slice(0, 10) < dia) delete e.franjas[k];
  e.usados = e.usados.filter((id) => cfg.pool.some((p) => p.id === id));
  // Anti-repetición v22: en Feed/Reels prioriza material no publicado en los últimos 7 días,
  // y evita publicar el mismo ítem más de una vez por día dentro de esta cola.
  const fdHist = (e.publicadoEn = e.publicadoEn || {});
  const fdCorte = Date.now() - 7 * 86400000;
  for (const id of Object.keys(fdHist)) {
    const t = Date.parse(fdHist[id]);
    if (!Number.isFinite(t) || Date.now() - t > 30 * 86400000 || !cfg.pool.some((p) => p.id === id)) delete fdHist[id];
  }
  const fdHoy = (e.usadosDia = e.usadosDia || {});
  for (const id of Object.keys(fdHoy)) if (fdHoy[id] !== dia) delete fdHoy[id];
  const existe = (p) => (p.medias || [p.media]).every((x) => fs.existsSync(fsm(x)));
  const diaSem = new Date(dia + 'T12:00:00Z').getUTCDay(); // 0 = domingo ... 6 = sábado (fecha de Argentina)
  const pendCola = cfg.pool.filter((p) => existe(p) && !e.usados.includes(p.id)).length;
  for (const fr of slotsHoy(cfg, e, dia, diaSem, pendCola, red)) {
    const [h, m] = String(fr.h).split(':').map(Number), ini = h * 60 + m, clave = dia + ' ' + fr.h;
    if (Array.isArray(fr.d) && fr.d.length && !fr.d.includes(diaSem)) continue; // franja solo para ciertos días de la semana
    if (min < ini) continue;
    if (['ok', 'omitida', 'vacia', 'fallida'].includes(e.franjas[clave])) continue;
    if (min - ini > 180) { e.franjas[clave] = 'omitida'; continue; }
    const enHistAntes = ultimoEnHistoriasPorMaterial(estado);
    const cand = cfg.pool.filter((p) => existe(p) && (!fr.f || p.fmt === fr.f) && !matIdsDeItem(p).some((id) => enHistAntes[id] && Date.now() - enHistAntes[id] < HORAS_ENTRE_COLAS * 3600000));
    // Nunca repetir el mismo ítem en dos franjas del mismo día. Entre alternativas,
    // priorizar primero las que no salieron en los últimos 7 días.
    const noHoy = cand.filter((p) => fdHoy[p.id] !== dia);
    const frescas = noHoy.filter((p) => !Number.isFinite(Date.parse(fdHist[p.id] || '')) || Date.parse(fdHist[p.id]) < fdCorte);
    let libres = frescas.filter((p) => !e.usados.includes(p.id));
    if (!libres.length && cfg.reciclar !== false) {
      libres = frescas.length ? frescas.slice() : noHoy.slice().sort((a, b) => (Date.parse(fdHist[a.id] || 0) || 0) - (Date.parse(fdHist[b.id] || 0) || 0));
    }
    const orden = cfg.orden === 'nuevo' ? libres.slice().sort((a, b) => (b.ord || 0) - (a.ord || 0)) : mezclar(libres);
    const elegidas = (cfg.alternar === false ? orden : alternarProv(orden, e.ultimaProv)).slice(0, Math.min(Number(fr.n) || 1, 5));
    // Sin nada nuevo la franja queda pendiente (hasta 3 h): si el panel suma material en ese rato, sale igual.
    if (!elegidas.length) { e.aviso = 'No hay material nuevo para publicar: cuando cargues publicidad nueva y abras el panel, se suma sola.'; continue; }
    let ok = 0, fallos = 0;
    for (const p of elegidas) {
      try { await publicar({ id: p.id, tipo: p.medias && p.medias.length > 1 ? 'carousel' : (p.tipo === 'video' ? 'video' : 'image'), fmt: p.fmt === 'reel' ? 'reel' : 'feed', media: p.media, medias: p.medias, caption: p.caption || '', ig: red === 'ig' ? 1 : 0, fb: red === 'fb' ? 1 : 0 }, token, uid, null); if (!e.usados.includes(p.id)) e.usados.push(p.id); fdHist[p.id] = new Date().toISOString(); fdHoy[p.id] = dia; ok++; liberarFeed(p, red, cfg, estado); }
      catch (er) { fallos++; e.error = er.message; console.log('Feed ' + red + ' falló', p.id, er.message); }
    }
    if (ok) { const u = elegidas.filter((p) => e.usados.includes(p.id)).pop(); if (u && u.prov) e.ultimaProv = u.prov; }
    const intentos = (typeof e.franjas[clave] === 'object' && e.franjas[clave] ? e.franjas[clave].intentos : 0) + 1;
    if (elegidas.length && !ok && intentos < 3) e.franjas[clave] = { intentos };
    else e.franjas[clave] = !elegidas.length ? 'vacia' : (ok ? 'ok' : 'fallida');
    e.ultima = { cuando: new Date().toISOString(), franja: fr.h, ok, fallos };
    if (ok && e.prueba && e.prueba.dia === dia && e.prueba.h === fr.h) (e.pruebaRec = e.pruebaRec || []).push({ t: new Date().toISOString(), tramo: e.prueba.tramo });
    if (ok) delete e.error;
    delete e.aviso;
  }
}

// Estadísticas: una vez por hora guarda historias (mientras están activas), cuenta y últimas publicaciones.
// Ajuste autónomo semanal de días (conservador): usa métricas maduras y solo mueve una franja
// que ya tenga días explícitos. Si toda la agenda es diaria (sin fr.d), no altera la frecuencia.
function diaLocal(fecha) {
  const d = new Date(fecha);
  if (!Number.isFinite(d.getTime())) return -1;
  const x = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[x] ?? -1;
}
function medianaMotor(a) {
  const x = a.filter(Number.isFinite).sort((u, v) => u - v);
  if (!x.length) return 0;
  const i = Math.floor(x.length / 2);
  return x.length % 2 ? x[i] : (x[i - 1] + x[i]) / 2;
}
function datosDiaMotor(items) {
  const formatos = {};
  for (const p of items) {
    if (p.score > 0) (formatos[p.fmt || 'foto'] ||= []).push(p.score);
  }
  const escalas = Object.fromEntries(Object.entries(formatos).map(([k, a]) => [k, medianaMotor(a) || 1]));
  const grupos = Array.from({ length: 7 }, () => []);
  for (const p of items) {
    const d = diaLocal(p.t);
    if (d >= 0 && p.score > 0) grupos[d].push(p.score / (escalas[p.fmt || 'foto'] || 1));
  }
  const validos = grupos.map((a, d) => ({ d, n: a.length, med: medianaMotor(a) })).filter(x => x.n >= 6);
  if (validos.length < 4) return null;
  validos.sort((a, b) => b.med - a.med);
  const mejor = validos[0], peor = validos[validos.length - 1];
  if (!(peor.med > 0) || mejor.med / peor.med < 1.4) return null;
  return { mejor: mejor.d, peor: peor.d, diferencia: Math.round((mejor.med / peor.med - 1) * 100), nMejor: mejor.n, nPeor: peor.n };
}
// Registro y respaldo antes de cada ajuste automático. Permite auditar el cambio y recuperar la configuración anterior.
function guardarRespaldoAuto(ruta, cfgAnterior, cfgNueva, detalle) {
  const archivo = path.join(BASE, 'stats', 'auto-ajustes.json');
  const historial = leer(archivo, { cambios: [] });
  historial.cambios = Array.isArray(historial.cambios) ? historial.cambios : [];
  historial.cambios.unshift({ fecha: new Date().toISOString(), ruta, detalle, anterior: cfgAnterior, nueva: cfgNueva });
  historial.cambios = historial.cambios.slice(0, 30);
  escribir(archivo, historial);
}
function escribirConfigOptimizada(ruta, cfgAntes, cfgDespues, detalle) {
  guardarRespaldoAuto(ruta, cfgAntes, cfgDespues, detalle);
  escribir(path.join(BASE, ruta), cfgDespues);
}

function optimizarDiasCola(ruta, items, estado, etiqueta) {
  const cfgPath = path.join(BASE, ruta);
  const cfg = leer(cfgPath, null);
  if (!cfg || cfg.pausada || !Array.isArray(cfg.franjas) || !cfg.franjas.length) return null;
  const res = datosDiaMotor(items);
  if (!res) return { red: etiqueta, estado: 'sin-muestra', detalle: 'No hay muestra suficiente o la diferencia entre días es menor al 40%; no se cambia la agenda.' };
  // Solo mover franjas configuradas explícitamente por día. Una franja sin "d" corre todos los días;
  // convertirla automáticamente alteraría la frecuencia semanal y no es seguro.
  const idx = cfg.franjas.findIndex(f => Array.isArray(f.d) && f.d.length && f.d.includes(res.peor) && !f.d.includes(res.mejor));
  if (idx < 0) return { red: etiqueta, estado: 'sin-franja-compatible', detalle: `Mejor ${res.mejor}, más flojo ${res.peor} (${res.diferencia}%, muestra ${res.nMejor}/${res.nPeor}); no hay una franja con días explícitos que pueda moverse sin cambiar la frecuencia general.` };
  const cfgAntes = JSON.parse(JSON.stringify(cfg));
  const anterior = cfg.franjas[idx].d.slice();
  cfg.franjas[idx].d = anterior.filter(d => d !== res.peor).concat(res.mejor).filter((d, i, a) => a.indexOf(d) === i).sort((a, b) => a - b);
  const detalle = `Moví una franja ${cfg.franjas[idx].h || ''} del día ${res.peor} al ${res.mejor} según medianas normalizadas (${res.diferencia}%; muestras ${res.nMejor}/${res.nPeor}).`;
  escribirConfigOptimizada(ruta, cfgAntes, cfg, detalle);
  return { red: etiqueta, estado: 'ajustado', detalle, anterior, nueva: cfg.franjas[idx].d };
}
function horaLocalMotor(fecha) {
  const d = new Date(fecha);
  if (!Number.isFinite(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return (+p.hour) + (+p.minute) / 60;
}
function horaNumMotor(s) { const [a, b] = String(s).split(':').map(Number); return a + (b || 0) / 60; }
function tramoMotor(h) { return h >= 6 && h < 9 ? 'primera mañana' : h >= 9 && h < 12 ? 'mañana' : h >= 12 && h < 15 ? 'mediodía' : h >= 15 && h < 19 ? 'tarde' : h >= 19 && h < 21 ? 'noche temprana' : h >= 21 ? 'noche' : ''; }
function horaTextoMotor(h) { h = Math.max(6, Math.min(23.5, Math.round(h * 2) / 2)); const hh = Math.floor(h), mm = h - hh ? '30' : '00'; return String(hh).padStart(2, '0') + ':' + mm; }
function optimizarRestoCola(ruta, items, etiqueta) {
  const cfgPath = path.join(BASE, ruta), cfg = leer(cfgPath, null);
  if (!cfg || cfg.pausada || !Array.isArray(cfg.franjas) || !cfg.franjas.length) return null;
  const cfgInicial = JSON.parse(JSON.stringify(cfg));
  const usable = items.map(p => ({ ...p, h: horaLocalMotor(p.t), d: diaLocal(p.t) })).filter(p => p.h !== null && p.score > 0);
  if (usable.length < 12) return { red: etiqueta, estado: 'sin-muestra', detalle: 'Menos de 12 publicaciones/historias con métricas maduras; no se modifica la agenda.' };
  const formato = {};
  for (const p of usable) (formato[p.fmt || 'foto'] ||= []).push(p.score);
  const medFmt = Object.fromEntries(Object.entries(formato).map(([k, a]) => [k, medianaMotor(a) || 1]));
  const norm = usable.map(p => ({ ...p, norm: p.score / (medFmt[p.fmt || 'foto'] || 1) }));
  // 1) Horarios: exige 5 datos por franja del día y una ventaja de al menos 33%.
  const bloques = {};
  const baseHor = ruta.startsWith('stories/') ? primerasTandaMotor(norm) : norm; // v42: en Historias cada tanda es UNA muestra de horario
  for (const p of baseHor) { const b = tramoMotor(p.h); if (b) (bloques[b] ||= []).push(p); }
  const bmed = {};
  for (const [b, a] of Object.entries(bloques)) if (a.length >= MIN_MUESTRA_TRAMO) bmed[b] = medianaMotor(a.map(p => p.norm));
  const bs = Object.keys(bmed).sort((a,b) => bmed[b]-bmed[a]);
  if (bs.length >= 2) {
    const mejor = bs[0];
    for (const fr of cfg.franjas) {
      const [hh, mm] = String(fr.h || '').split(':').map(Number), h = hh + (mm || 0)/60, actual = tramoMotor(h);
      if (!actual || bmed[actual] == null || actual === mejor || bmed[actual] > bmed[mejor] * 0.65) continue;
      const grupo = bloques[mejor], medH = medianaMotor(grupo.map(p => p.h));
      const usados = new Set(cfg.franjas.filter(x => x !== fr).map(x => x.h));
      const opciones = [medH, medH + .5, medH - .5].map(horaTextoMotor).filter((v,i,a) => a.indexOf(v) === i && ![...usados].some(u => Math.abs(horaNumMotor(u) - horaNumMotor(v)) < 2) && tramoMotor(+v.slice(0,2)+(+v.slice(3))/60) === mejor);
      if (opciones.length) { const antes = fr.h; fr.h = opciones[0]; const detalle = `Horario ${antes} → ${fr.h}: el tramo ${actual} rindió ${Math.round((1-bmed[actual]/bmed[mejor])*100)}% menos que ${mejor}.`; escribirConfigOptimizada(ruta, cfgInicial, cfg, detalle); return {red:etiqueta,estado:'ajustado',detalle}; }
    }
  }
  // 2) Formato: cambia una sola franja cuando hay al menos 4 piezas por formato y diferencia >=40%.
  if (!ruta.startsWith('stories/')) {
    const vs = usable.filter(p => /video|reel/i.test(p.fmt || '')).map(p => p.score), fscores = usable.filter(p => !/video|reel/i.test(p.fmt || '')).map(p => p.score);
    if (vs.length >= 6 && fscores.length >= 6) {
      const mv = medianaMotor(vs), mf = medianaMotor(fscores), mejor = mv >= mf*1.4 ? 'reel' : (mf >= mv*1.4 ? 'feed' : '');
      if (mejor) { const peor = mejor === 'reel' ? 'feed' : 'reel', fr = mejor === 'reel' ? cfg.franjas.find(x => x.f === peor && reelsDia(cfg.franjas, x) <= MAX_REELS_DIA) : cfg.franjas.find(x => x.f === peor); if (fr) { fr.f = mejor; const detalle = `Formato de la franja ${fr.h}: ${peor} → ${mejor}; diferencia mediana de al menos 40% con ${vs.length} videos y ${fscores.length} fotos.`; escribirConfigOptimizada(ruta, cfgInicial, cfg, detalle); return {red:etiqueta,estado:'ajustado',detalle}; } }
    }
  }
  // 3) Cantidad de posts: solo reduce si los días con 2+ publicaciones rinden <70% por pieza.
  if (!ruta.startsWith('stories/')) {
    const ratio = ratioCargaMotor(usable);
    if (ratio !== null) {
      if (ratio < .70) { const fr=cfg.franjas.find(x => (+x.n||1)>=2); if(fr){ const antes=fr.n; fr.n=Math.max(1,(+fr.n||1)-1); const detalle = `Cantidad de ${fr.h}: ${antes} → ${fr.n}; los días con 2+ publicaciones rindieron ${Math.round((1-ratio)*100)}% menos por pieza en la muestra.`; escribirConfigOptimizada(ruta, cfgInicial, cfg, detalle); return {red:etiqueta,estado:'ajustado',detalle}; } }
    }
  } else {
    // Historias: agrupa tandas separadas por 45 minutos y solo ajusta con cinco tandas comparables.
    const ordered=usable.slice().sort((a,b)=>Date.parse(a.t)-Date.parse(b.t)), batches=[]; let last=-Infinity;
    for(const p of ordered){ if(Date.parse(p.t)-last>45*60000)batches.push([]); batches[batches.length-1].push(p); last=Date.parse(p.t); }
    for(const fr of cfg.franjas){ const n=+fr.n||1; if(n<2)continue; const h=+(String(fr.h).split(':')[0]||0)+(+String(fr.h).split(':')[1]||0)/60;
      const rs=batches.filter(b=>b.length>=n && Math.abs(b[0].h-h)<=.75).map(b=>b[0].score>0?b[n-1].score/b[0].score:0);
      if(rs.length>=8){ const r=medianaMotor(rs); if(r>=.8&&n<8){fr.n=n+1;const detalle=`Historias ${fr.h}: ${n} → ${fr.n}; la última de la tanda conserva ${Math.round(r*100)}% del alcance de la primera.`;escribirConfigOptimizada(ruta,cfgInicial,cfg,detalle);return {red:etiqueta,estado:'ajustado',detalle};} if(r<.5&&n>3){fr.n=n-1;const detalle=`Historias ${fr.h}: ${n} → ${fr.n}; la última de la tanda llega a ${Math.round(r*100)}% de la primera.`;escribirConfigOptimizada(ruta,cfgInicial,cfg,detalle);return {red:etiqueta,estado:'ajustado',detalle};} }
    }
  }
  return {red:etiqueta,estado:'sin-cambio',detalle:'La muestra no justifica un cambio seguro en horarios, formato o cantidad.'};
}

function optimizarSemanaAutomatica(estado) {
  const ahora = Date.now(), DIA = 86400000;
  if (estado.autoOptimizacionUltimoChequeo && ahora - Date.parse(estado.autoOptimizacionUltimoChequeo) < 7 * DIA) return;
  const D = leer(path.join(BASE, 'stats', 'datos.json'), null);
  if (!D) return;
  const maduro = (t, h) => { const ms = Date.parse(t); return Number.isFinite(ms) && ms < ahora - h * 3600000; };
  const igItems = (D.posts || []).filter(p => maduro(p.timestamp, 72)).map(p => ({ t: p.timestamp, score: +(p.reach || 0), fmt: /VIDEO|REEL/i.test(p.media_type || '') ? 'video' : 'foto' }));
  const fbItems = (D.fbposts || []).filter(p => maduro(p.t, 72)).map(p => ({ t: p.t, score: +(p.r || 0) + 2 * (+(p.c || 0)) + 3 * (+(p.s || 0)), fmt: /video|reel/i.test(p.tipo || '') ? 'video' : 'foto' }));
  const stItems = Object.values(D.historias || {}).filter(p => maduro(p.t, 26)).map(p => ({ t: p.t, score: +(p.a || 0), fmt: /VIDEO/i.test(p.tipo || '') ? 'video' : 'foto' }));
  // v27: un ajuste por cola, pausa de 14 días para medir el efecto, y reversión si el alcance mediano cae más de 30%.
  const base = (estado.autoBase = estado.autoBase || {}), pausa = (estado.autoPausa = estado.autoPausa || {});
  const resultados = [];
  for (const [ruta, items, etiqueta] of [
    ['feed-ig/config.json', igItems, 'Instagram Feed/Reels'],
    ['feed-fb/config.json', fbItems, 'Facebook Feed/Reels'],
    ['stories/config.json', stItems, 'Historias']
  ]) {
    try {
      if (pausa[ruta] && ahora < Date.parse(pausa[ruta])) { resultados.push({ red: etiqueta, estado: 'en-pausa', detalle: 'En pausa hasta ' + pausa[ruta].slice(0, 10) + ' por una reversión reciente.' }); continue; }
      const bl = base[ruta];
      if (bl) {
        const dias = (ahora - Date.parse(bl.t)) / DIA;
        if (dias < 14) { resultados.push({ red: etiqueta, estado: 'en-observacion', detalle: 'Último ajuste hace ' + Math.floor(dias) + ' días: espero 14 para medir el efecto.' }); continue; }
        const despues = items.filter(p => Date.parse(p.t) > Date.parse(bl.t) + 3600000).map(p => p.score).filter(Number.isFinite);
        if (despues.length < 6 && dias < 28) { resultados.push({ red: etiqueta, estado: 'en-observacion', detalle: 'Faltan publicaciones con datos para medir el ajuste anterior.' }); continue; }
        if (despues.length >= 6 && bl.med > 0 && medianaMotor(despues) < bl.med * 0.7) {
          const cfg = leer(path.join(BASE, ruta), null);
          if (cfg && Array.isArray(bl.franjas)) {
            const cfgAntes = JSON.parse(JSON.stringify(cfg)); cfg.franjas = bl.franjas;
            const detalle = 'Reversión: el alcance mediano bajó ' + Math.round((1 - medianaMotor(despues) / bl.med) * 100) + '% después del último ajuste; vuelvo a los horarios anteriores.';
            escribirConfigOptimizada(ruta, cfgAntes, cfg, detalle);
            resultados.push({ red: etiqueta, estado: 'revertido', detalle });
          }
          delete base[ruta]; pausa[ruta] = new Date(ahora + 28 * DIA).toISOString(); continue;
        }
        delete base[ruta]; // el ajuste no empeoró: se cierra el control
      }
      const antes = JSON.parse(JSON.stringify((leer(path.join(BASE, ruta), {}) || {}).franjas || []));
      let r = optimizarDiasCola(ruta, items, estado, etiqueta);
      if (!r || r.estado !== 'ajustado') r = optimizarRestoCola(ruta, items, etiqueta) || r;
      if (r && r.estado === 'ajustado') {
        const rec = items.slice().sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).slice(0, 12).map(p => p.score).filter(Number.isFinite);
        base[ruta] = { t: new Date(ahora).toISOString(), med: medianaMotor(rec), franjas: antes };
      }
      if (r) resultados.push(r);
    } catch (e) { resultados.push({ red: etiqueta, estado: 'error', detalle: e.message }); }
  }
  estado.autoOptimizacionUltimoChequeo = new Date(ahora).toISOString();
  estado.autoOptimizacionUltimoResultado = resultados;
  if (resultados.some(r => r.estado === 'ajustado' || r.estado === 'revertido')) estado.autoOptimizacionUltimoAjuste = new Date(ahora).toISOString();
}

async function estadisticas(estado, token, uid) {
  const ahora = Date.now();
  if (estado.statsEl && ahora - Date.parse(estado.statsEl) < 55 * 60000) return;
  const f = path.join(BASE, 'stats', 'datos.json');
  const D = leer(f, {}); D.historias = D.historias || {}; D.seguidores = D.seguidores || {};
  const errs = [], val = (x) => (x.total_value ? x.total_value.value : x.values && x.values[0] ? x.values[0].value : 0);
  const insights = async (id, lista, extra) => { for (const m of lista) { try { const r = await ig('GET', id + '/insights', { metric: m, ...(extra || {}) }, token); const o = {}; for (const x of r.data || []) o[x.name] = val(x); return o; } catch (e) { if (m === lista[lista.length - 1]) errs.push(e.message); } } return {}; };
  try {
    const l = (await ig('GET', uid + '/stories', { fields: 'id,timestamp,media_type', limit: 50 }, token)).data || [];
    for (const s of l) { const m = await insights(s.id, ['reach,views', 'reach']); const a = D.historias[s.id] || {}; D.historias[s.id] = { t: s.timestamp, tipo: s.media_type, a: m.reach != null ? m.reach : a.a, v: m.views != null ? m.views : a.v }; }
    for (const id of Object.keys(D.historias)) if (ahora - Date.parse(D.historias[id].t) > 120 * 86400000) delete D.historias[id];
  } catch (e) { errs.push('historias: ' + e.message); }
  try { const p = await ig('GET', uid, { fields: 'username,followers_count,follows_count,media_count' }, token); D.cuenta = { ...p, el: new Date().toISOString() }; D.seguidores[ahoraAR().dia] = p.followers_count; } catch (e) { errs.push('cuenta: ' + e.message); }
  try { const fin = Math.floor(ahora / 1000); D.res30 = await insights(uid, ['reach,views,profile_views,accounts_engaged', 'reach,views', 'reach'], { period: 'day', metric_type: 'total_value', since: fin - 30 * 86400, until: fin }); } catch (e) { errs.push('alcance: ' + e.message); }
  try {
    const md = (await ig('GET', uid + '/media', { fields: 'id,timestamp,media_type,permalink,like_count,comments_count,caption', limit: 25 }, token)).data || [];
    const previos = new Map((D.posts || []).map((x) => [x.id, x])), nuevos = [];
    for (const p of md) { const o = previos.get(p.id), joven = ahora - Date.parse(p.timestamp) < 8 * 86400000; const m = (o && o.reach != null && !joven) ? {} : await insights(p.id, ['reach,views,saved,shares', 'reach']); nuevos.push({ ...o, ...p, ...m }); previos.delete(p.id); }
    D.posts = nuevos.concat([...previos.values()].filter((x) => ahora - Date.parse(x.timestamp) < 120 * 86400000)).slice(0, 150); // v27: guarda historial (antes solo las últimas 25)
  } catch (e) { errs.push('publicaciones: ' + e.message); }
  try {
    if (!D.aud || ahora - Date.parse(D.aud.el) > 20 * 3600000) {
      const dem = {};
      for (const [k, br] of [['edad', 'age,gender'], ['ciudades', 'city'], ['paises', 'country']]) {
        const r = await ig('GET', uid + '/insights', { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: br }, token);
        const bd = ((((r.data || [])[0] || {}).total_value || {}).breakdowns || [])[0];
        dem[k] = ((bd && bd.results) || []).map((x) => ({ d: x.dimension_values, v: x.value }));
      }
      D.aud = { ...dem, el: new Date().toISOString() };
    }
  } catch (e) { errs.push('audiencia: ' + e.message); }
  try {
    D.dias = D.dias || {}; let n = 0;
    for (let i = 1; i <= 30 && n < 12; i++) {
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ahora - i * 86400000));
      if (D.dias[dia]) continue;
      const since = Date.parse(dia + 'T03:00:00Z') / 1000;
      const m = await insights(uid, ['reach,views', 'reach'], { period: 'day', metric_type: 'total_value', since, until: since + 86400 });
      n++;
      if (m.reach != null) D.dias[dia] = { a: m.reach, v: m.views };
    }
    for (const k of Object.keys(D.dias)) if (ahora - Date.parse(k) > 400 * 86400000) delete D.dias[k];
  } catch (e) { errs.push('días: ' + e.message); }
  // Facebook (Página): últimas publicaciones con reacciones, comentarios y compartidos (para el análisis de horarios del panel).
  try {
    if (process.env.FB_PAGE_ID && process.env.FB_PAGE_TOKEN) {
      const campos = 'id,created_time,status_type,reactions.summary(true).limit(0),comments.summary(true).limit(0),shares';
      let r; // 50 por pedido; si Facebook rechaza el volumen de datos, reintenta con 25.
      try { r = await fb('GET', process.env.FB_PAGE_ID + '/posts', { fields: campos, limit: 50 }, process.env.FB_PAGE_TOKEN); }
      catch (e1) { r = await fb('GET', process.env.FB_PAGE_ID + '/posts', { fields: campos, limit: 25 }, process.env.FB_PAGE_TOKEN); }
      const anteriores = new Map((D.fbposts || []).map((p) => [p.id, p]));
      const recientes = (r.data || []).map((p) => ({ ...(anteriores.get(p.id) || {}), id: p.id, t: p.created_time, tipo: p.status_type || '', r: ((p.reactions || {}).summary || {}).total_count || 0, c: ((p.comments || {}).summary || {}).total_count || 0, s: (p.shares || {}).count || 0 }));
      const idsRecientes = new Set(recientes.map((p) => p.id));
      // Historial acumulado: lo nuevo + lo guardado de hasta 120 días, ordenado del más nuevo al más viejo, máximo 150.
      D.fbposts = recientes.concat([...anteriores.values()].filter((p) => !idsRecientes.has(p.id) && ahora - Date.parse(p.t) < 120 * 86400000))
        .sort((x, y) => (Date.parse(y.t) || 0) - (Date.parse(x.t) || 0)).slice(0, 150);
    }
  } catch (e) { errs.push('facebook: ' + e.message); }
  D.actualizado = new Date().toISOString(); escribir(f, D); estado.statsEl = D.actualizado;
  if (errs.length) estado.errorStats = errs.slice(0, 2).join(' | '); else delete estado.errorStats;
}

export async function main() {
  const estadoF = path.join(BASE, 'estado.json');
  const estado0 = leer(estadoF, {});
  const estado = { ...estado0 };
  const pendDir = path.join(BASE, 'pending');
  const archivos = fs.existsSync(pendDir) ? fs.readdirSync(pendDir).filter((f) => f.endsWith('.json')) : [];
  const ahora = Date.now();
  const vencidos = archivos
    .map((f) => ({ f, d: leer(path.join(pendDir, f), null) }))
    .filter((x) => x.d && Date.parse(x.d.when) <= ahora)
    .sort((a, b) => Date.parse(a.d.when) - Date.parse(b.d.when))
    .slice(0, MAX_POR_CORRIDA);

  let token = process.env.IG_TOKEN, uid = process.env.IG_USER_ID;
  if (!estado.latido || ahora - Date.parse(estado.latido) > 20 * 86400000) estado.latido = new Date(ahora).toISOString(); // actividad en el repo: evita que GitHub apague el horario
  if (vencidos.length && (!token || !uid)) {
    estado.ultimoError = 'Faltan los secretos IG_TOKEN e IG_USER_ID en Settings > Secrets and variables > Actions.';
    console.log(estado.ultimoError);
  } else if (vencidos.length) {
    token = await renovarToken(token, estado);
    delete estado.ultimoError;
    for (const { f, d } of vencidos) {
      const archivo = path.join(pendDir, f);
      try {
        const r = await publicar(d, token, uid, (x) => escribir(archivo, x));
        escribir(path.join(BASE, 'done', f), { ...d, estado: 'publicada', publicadoEl: new Date().toISOString(), permalink: r.permalink, fbPermalink: r.fbLink || '', fbError: r.fbError || '' });
        fs.unlinkSync(archivo);
        borrarMedias(d);
        console.log('Publicada', d.id, r.permalink);
      } catch (e) {
        d.intentos = (d.intentos || 0) + 1; d.ultimoError = e.message;
        if (d.intentos >= MAX_INTENTOS) {
          escribir(path.join(BASE, 'failed', f), { ...d, estado: 'fallida' });
          fs.unlinkSync(archivo);
          borrarMedias(d);
        } else escribir(archivo, d);
        console.log('Falló', d.id, e.message);
      }
    }
  } else if (estado.tokenRenovado) {
    token = await renovarToken(token || '', estado);
  }
  if (token && uid) {
    agendaInicialAuto();
    try { await colaHistorias(estado, token, uid); } catch (e) { estado.stError = e.message; }
    for (const r of ['ig', 'fb']) { try { await colaFeed(estado, token, uid, r); } catch (e) { (estado['fd' + r] = estado['fd' + r] || {}).error = e.message; } }
    try { await estadisticas(estado, token, uid); } catch (e) { estado.errorStats = e.message; }
    // Respeta el interruptor del panel (ig-queue/auto-ajuste.json: { on: false } lo apaga). Sin archivo = encendido.
    try { const aj = leer(path.join(BASE, 'auto-ajuste.json'), null); if (!aj || aj.on !== false) optimizarSemanaAutomatica(estado); } catch (e) { estado.autoOptimizacionError = e.message; }
  }
  // El chequeo cambia en cada corrida: solo se guarda si pasaron 30 min o si hay algo nuevo, para no llenar el repositorio de commits.
  const soloChequeo = JSON.stringify({ ...estado, stChequeo: 0 }) === JSON.stringify({ ...estado0, stChequeo: 0 });
  if (soloChequeo && estado0.stChequeo && estado.stChequeo && Date.parse(estado.stChequeo.cuando) - Date.parse(estado0.stChequeo.cuando) < 30 * 60000) estado.stChequeo = estado0.stChequeo;
  if (JSON.stringify(estado) !== JSON.stringify(estado0)) escribir(estadoF, estado);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
