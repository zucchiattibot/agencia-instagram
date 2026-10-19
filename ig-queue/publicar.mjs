// ig-motor-v11
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
  if (esCar) {
    const params = { message: txt };
    let i = 0;
    for (const u of urls) { const f = await fb('POST', pg + '/photos', { url: u, published: 'false' }, tk); params['attached_media[' + (i++) + ']'] = JSON.stringify({ media_fbid: f.id }); }
    const r = await fb('POST', pg + '/feed', params, tk);
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
  const r = await fb('POST', pg + '/photos', { url: u, caption: txt, published: 'true' }, tk);
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
const urlPublica = (m) => 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + m;
async function esperarArchivo(url) {
  for (let i = 0; i < 6; i++) { try { const h = await fetch(url, { method: 'HEAD' }); if (h.ok) return; } catch (e) { return; } await dormir(2000); }
}
function borrarMedias(d) {
  for (const m of (d.medias || (d.media ? [d.media] : []))) { try { fs.unlinkSync(m); } catch (e) {} }
}

async function publicar(d, token, uid, guardar) {
  const esCar = d.tipo === 'carousel';
  const medias = esCar ? (d.medias || []) : [d.media];
  if (!medias.length || medias.some((m) => !m || !fs.existsSync(m))) throw new Error('El archivo de la publicación ya no está en el repositorio.');
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
    const cont = await ig('POST', uid + '/media', params, token);
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

const TZ = 'America/Argentina/Buenos_Aires';
const ahoraAR = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return { dia: p.year + '-' + p.month + '-' + p.day, min: +p.hour * 60 + +p.minute }; };
const mezclar = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Cola de historias: a cada franja horaria publica N historias al azar del conjunto elegido en el panel.
async function colaHistorias(estado, token, uid) {
  const cfg = leer(path.join(BASE, 'stories', 'config.json'), null);
  if (!cfg || cfg.pausada || !(cfg.franjas || []).length || !(cfg.pool || []).length) return;
  const { dia, min } = ahoraAR();
  const hechas = (estado.stFranjas = estado.stFranjas || {});
  for (const k of Object.keys(hechas)) if (k.slice(0, 10) < dia) delete hechas[k];
  estado.stUsados = (estado.stUsados || []).filter((id) => cfg.pool.some((p) => p.id === id));
  const franjas = cfg.franjas.slice().sort((a, b) => String(a.h).localeCompare(String(b.h)));
  const existe = (p) => fs.existsSync(p.media);
  const enRepo = cfg.pool.filter(existe).length;
  // Diagnóstico visible en el panel: cuándo miró el motor, cuántas historias hay de verdad en el repositorio y qué franjas faltan.
  const pendientes = franjas.filter((fr) => { const [h, m] = String(fr.h).split(':').map(Number); const ini = h * 60 + m; return !['ok', 'omitida', 'vacia'].includes(hechas[dia + ' ' + fr.h]) && min >= ini && min - ini <= 180; }).map((fr) => fr.h);
  estado.stChequeo = { cuando: new Date().toISOString(), cola: cfg.pool.length, enRepo, pendientes };
  for (const fr of franjas) {
    const [h, m] = String(fr.h).split(':').map(Number), ini = h * 60 + m, clave = dia + ' ' + fr.h;
    if (min < ini) continue;
    if (hechas[clave] === 'ok' || hechas[clave] === 'omitida' || hechas[clave] === 'vacia') continue;
    if (min - ini > 180) { hechas[clave] = 'omitida'; continue; }
    const n = Math.min(Number(fr.n) || 1, 10);
    const libres = cfg.pool.filter((p) => existe(p) && !estado.stUsados.includes(p.id));
    let elegidas = mezclar(libres).slice(0, n);
    // Si quedan menos de N sin publicar y se puede repetir: primero salen las que sobraban y recién después empieza otra vuelta (sin repetir las que acaban de salir).
    if (elegidas.length < n && cfg.reciclar !== false) {
      const tomadas = elegidas.map((p) => p.id);
      estado.stUsados = []; estado.stVueltas = (estado.stVueltas || 0) + 1;
      elegidas = elegidas.concat(mezclar(cfg.pool.filter((p) => existe(p) && !tomadas.includes(p.id))).slice(0, n - elegidas.length));
    }
    let ok = 0, fallos = 0;
    for (const p of elegidas) {
      try { await publicar({ id: p.id, tipo: p.tipo === 'video' ? 'video' : 'image', fmt: 'historia', media: p.media, fb: cfg.fb ? 1 : 0, ig: cfg.ig === 0 ? 0 : 1 }, token, uid, null); estado.stUsados.push(p.id); ok++; }
      catch (e) { fallos++; estado.stError = e.message; console.log('Historia falló', p.id, e.message); }
    }
    // Si no salió ninguna por un error, se vuelve a intentar en la próxima corrida (hasta 3 veces); antes se daba la franja por hecha y quedaba sin publicar.
    const intentos = (typeof hechas[clave] === 'object' && hechas[clave] ? hechas[clave].intentos : 0) + 1;
    if (elegidas.length && !ok && intentos < 3) hechas[clave] = { intentos };
    else hechas[clave] = elegidas.length ? 'ok' : 'vacia';
    estado.stUltima = { cuando: new Date().toISOString(), franja: fr.h, ok, fallos };
    if (ok) delete estado.stError;
    if (!elegidas.length) estado.stAviso = (cfg.reciclar === false && enRepo > 0) ? 'Ya salieron todas las historias de la cola: no se publica nada hasta que agregues más o actives repetir.' : 'No hay historias para publicar: en la cola hay ' + cfg.pool.length + ' pero solo ' + enRepo + ' están en el repositorio. Quitalas y volvé a agregarlas.';
    else if (cfg.reciclar === false && cfg.pool.filter((p) => existe(p) && !estado.stUsados.includes(p.id)).length === 0) estado.stAviso = 'Ya salieron todas las historias de la cola: agregá más o activá repetir.';
    else delete estado.stAviso;
  }
}

// Estadísticas: una vez por hora guarda historias (mientras están activas), cuenta y últimas publicaciones.
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
    D.posts = [];
    for (const p of md) { const m = await insights(p.id, ['reach,views,saved,shares', 'reach']); D.posts.push({ ...p, ...m }); }
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
    try { await colaHistorias(estado, token, uid); } catch (e) { estado.stError = e.message; }
    try { await estadisticas(estado, token, uid); } catch (e) { estado.errorStats = e.message; }
  }
  // El chequeo cambia en cada corrida: solo se guarda si pasaron 30 min o si hay algo nuevo, para no llenar el repositorio de commits.
  const soloChequeo = JSON.stringify({ ...estado, stChequeo: 0 }) === JSON.stringify({ ...estado0, stChequeo: 0 });
  if (soloChequeo && estado0.stChequeo && estado.stChequeo && Date.parse(estado.stChequeo.cuando) - Date.parse(estado0.stChequeo.cuando) < 30 * 60000) estado.stChequeo = estado0.stChequeo;
  if (JSON.stringify(estado) !== JSON.stringify(estado0)) escribir(estadoF, estado);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
