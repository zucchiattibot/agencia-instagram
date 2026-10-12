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

async function publicar(d, token, uid) {
  if (!d.media || !fs.existsSync(d.media)) throw new Error('El archivo de la publicación ya no está en el repositorio.');
  const url = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + d.media;
  for (let i = 0; i < 6; i++) { try { const h = await fetch(url, { method: 'HEAD' }); if (h.ok) break; } catch (e) { break; } await dormir(2000); }
  const esVideo = d.tipo === 'video';
  const params = { caption: d.fmt === 'historia' ? '' : (d.caption || '') };
  if (esVideo) { params.video_url = url; params.media_type = d.fmt === 'historia' ? 'STORIES' : 'REELS'; if (d.fmt !== 'historia') params.share_to_feed = 'true'; }
  else { params.image_url = url; if (d.fmt === 'historia') params.media_type = 'STORIES'; }
  const cont = await ig('POST', uid + '/media', params, token);
  const intentos = esVideo ? 60 : 12;
  let listo = false;
  for (let n = 0; n < intentos; n++) {
    const st = await ig('GET', cont.id, { fields: 'status_code' }, token);
    if (st.status_code === 'FINISHED') { listo = true; break; }
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar el archivo (' + st.status_code + ').');
    await dormir(esVideo ? 3000 : 1500);
  }
  if (!listo) throw new Error('Instagram tardó demasiado en procesar el archivo.');
  const pub = await ig('POST', uid + '/media_publish', { creation_id: cont.id }, token);
  let permalink = '';
  try { permalink = (await ig('GET', pub.id, { fields: 'permalink' }, token)).permalink || ''; } catch (e) {}
  return { id: pub.id, permalink };
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
        const r = await publicar(d, token, uid);
        escribir(path.join(BASE, 'done', f), { ...d, estado: 'publicada', publicadoEl: new Date().toISOString(), permalink: r.permalink });
        fs.unlinkSync(archivo);
        try { fs.unlinkSync(d.media); } catch (e) {}
        console.log('Publicada', d.id, r.permalink);
      } catch (e) {
        d.intentos = (d.intentos || 0) + 1; d.ultimoError = e.message;
        if (d.intentos >= MAX_INTENTOS) {
          escribir(path.join(BASE, 'failed', f), { ...d, estado: 'fallida' });
          fs.unlinkSync(archivo);
          try { fs.unlinkSync(d.media); } catch (e2) {}
        } else escribir(archivo, d);
        console.log('Falló', d.id, e.message);
      }
    }
  } else if (estado.tokenRenovado) {
    token = await renovarToken(token || '', estado);
  }
  if (JSON.stringify(estado) !== JSON.stringify(estado0)) escribir(estadoF, estado);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
