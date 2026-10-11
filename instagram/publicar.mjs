// Publicador de Instagram del panel "Agencia". Lo corre GitHub Actions (no lo toques a mano).
// Lee instagram/queue.json, publica lo que ya llegó a su hora y guarda el resultado.
// Sin dependencias: solo Node 20+.
const GRAPH = process.env.GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const GH_API = process.env.GH_API_BASE || 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;            // usuario/repo
const GH_TOKEN = process.env.GITHUB_TOKEN;
const IG_USER = process.env.IG_USER_ID;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const MODO = (process.env.MODO || 'publicar').trim();   // publicar | diagnostico
const MAX_INTENTOS = 3;

const ghH = { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'panel-ig' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gh(method, path, body) {
  const r = await fetch(GH_API + '/repos/' + REPO + '/' + path, { method, headers: { ...ghH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, json: j };
}
async function leerArchivo(ruta) {
  const r = await gh('GET', 'contents/' + ruta);
  if (!r.ok) return { sha: null, texto: null, branch: null };
  return { sha: r.json.sha, texto: Buffer.from(r.json.content, 'base64').toString('utf8') };
}
async function escribirArchivo(ruta, texto, sha, msg) {
  return gh('PUT', 'contents/' + ruta, { message: msg, content: Buffer.from(texto, 'utf8').toString('base64'), ...(sha ? { sha } : {}) });
}
async function borrarArchivo(ruta, msg) {
  const a = await gh('GET', 'contents/' + ruta);
  if (!a.ok) return;
  await gh('DELETE', 'contents/' + ruta, { message: msg, sha: a.json.sha });
}
// Lee queue.json, deja que "cambiar" modifique solo lo que publicamos, y lo guarda (reintenta si el panel escribió en el medio).
async function actualizarCola(cambiar, msg) {
  for (let i = 0; i < 5; i++) {
    const a = await leerArchivo('instagram/queue.json');
    let q = { items: [] }; try { q = JSON.parse(a.texto || '{"items":[]}'); } catch (e) {}
    if (!Array.isArray(q.items)) q.items = [];
    cambiar(q);
    const w = await escribirArchivo('instagram/queue.json', JSON.stringify(q, null, 1), a.sha, msg);
    if (w.ok) return q;
    if (w.status !== 409 && w.status !== 422) throw new Error('No pude guardar la cola: ' + w.status);
    await sleep(1500);
  }
  throw new Error('No pude guardar la cola (conflicto repetido)');
}

async function graph(method, path, params) {
  const u = new URL(GRAPH + '/' + path);
  const body = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const r = method === 'GET' ? await fetch(u + '?' + body) : await fetch(u, { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.code = j.error && j.error.code; throw e; }
  return j;
}

async function diagnostico() {
  const estado = { chequeado: new Date().toISOString(), ok: false };
  try {
    if (!IG_USER || !IG_TOKEN) throw new Error('Faltan los secrets IG_USER_ID y/o IG_ACCESS_TOKEN en GitHub.');
    const j = await graph('GET', IG_USER, { fields: 'username,name,followers_count' });
    estado.ok = true; estado.usuario = j.username; estado.seguidores = j.followers_count;
  } catch (e) { estado.error = e.message; }
  const a = await leerArchivo('instagram/estado.json');
  await escribirArchivo('instagram/estado.json', JSON.stringify(estado, null, 1), a.sha, 'Instagram: diagnóstico');
  console.log(estado.ok ? 'Conectado como @' + estado.usuario : 'ERROR: ' + estado.error);
  if (!estado.ok) process.exitCode = 1;
}

async function publicarItem(it, urlBase) {
  const imageUrl = urlBase + '/' + it.imagen;
  const chk = await fetch(imageUrl, { method: 'HEAD' });
  if (!chk.ok) throw new Error('La foto todavía no está disponible en GitHub (' + chk.status + ')');
  const cont = await graph('POST', IG_USER + '/media', { image_url: imageUrl, caption: it.caption || '' });
  for (let i = 0; i < 12; i++) {
    const s = await graph('GET', cont.id, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar la foto (' + s.status_code + ')');
    await sleep(5000);
  }
  const pub = await graph('POST', IG_USER + '/media_publish', { creation_id: cont.id });
  let permalink = '';
  try { permalink = (await graph('GET', pub.id, { fields: 'permalink' })).permalink || ''; } catch (e) {}
  return { mediaId: pub.id, permalink };
}

async function publicar() {
  if (!IG_USER || !IG_TOKEN) { console.log('Faltan los secrets IG_USER_ID / IG_ACCESS_TOKEN.'); process.exitCode = 1; return; }
  const repoInfo = await gh('GET', '');
  const branch = repoInfo.ok ? repoInfo.json.default_branch : 'main';
  if (repoInfo.ok && repoInfo.json.private) { console.log('El repositorio es PRIVADO: Instagram no puede leer las fotos. Hacelo público.'); process.exitCode = 1; return; }
  const urlBase = (process.env.RAW_BASE || 'https://raw.githubusercontent.com') + '/' + REPO + '/' + branch;
  const a = await leerArchivo('instagram/queue.json');
  let q = { items: [] }; try { q = JSON.parse(a.texto || '{"items":[]}'); } catch (e) {}
  const ahora = Date.now();
  const lista = (q.items || []).filter(it => it.estado === 'pendiente' && it.imagen && new Date(it.cuando).getTime() <= ahora)
    .sort((x, y) => new Date(x.cuando) - new Date(y.cuando)).slice(0, 5);
  if (!lista.length) { console.log('Nada para publicar ahora.'); return; }
  let fallo = false;
  for (const it of lista) {
    let res = null, err = null, tokenMalo = false;
    try { res = await publicarItem(it, urlBase); }
    catch (e) { err = e.message; tokenMalo = e.code === 190; console.log('Error con ' + it.id + ': ' + err); }
    if (res) {
      console.log('Publicado ' + it.id + ' ' + res.permalink);
      await actualizarCola(c => { const x = c.items.find(i => i.id === it.id); if (x) { x.estado = 'publicado'; x.publicadoEn = new Date().toISOString(); x.permalink = res.permalink; x.mediaId = res.mediaId; delete x.error; } }, 'Instagram: publicado ' + it.id);
      await borrarArchivo('instagram/' + it.imagen.replace(/^\/+/, ''), 'Instagram: limpiar foto ' + it.id);
    } else {
      fallo = true;
      await actualizarCola(c => { const x = c.items.find(i => i.id === it.id); if (x) { x.intentos = (x.intentos || 0) + 1; x.error = err; if (tokenMalo || x.intentos >= MAX_INTENTOS) x.estado = 'error'; } }, 'Instagram: error en ' + it.id);
      if (tokenMalo) break; // el token no sirve: no insistir con el resto
    }
  }
  if (fallo) process.exitCode = 1; // así GitHub te avisa por mail que algo falló
}

(MODO === 'diagnostico' ? diagnostico() : publicar()).catch(e => { console.error(e); process.exit(1); });
