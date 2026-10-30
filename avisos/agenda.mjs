// avisos-agenda-v1
// Programa en ntfy los recordatorios de la agenda del panel para que lleguen a su hora exacta, con el panel cerrado.
// Lo ejecuta GitHub Actions: cada vez que el panel sube cambios y, de respaldo, cada 3 horas.
// ntfy guarda cada aviso y lo entrega a la hora indicada. Cada aviso lleva un ID propio (recordatorio + dia),
// asi que volver a correr esto lo reemplaza en vez de duplicarlo, y si borraste un recordatorio se cancela.
// Lee avisos/agenda.json (lo sube el panel, cifrado con el nombre del canal de ntfy).
import fs from 'node:fs';
import crypto from 'node:crypto';

const ARCHIVO = 'avisos/agenda.json';
const prueba = String(process.env.PRUEBA || '') === 'true';
const topic = String(process.env.NTFY_TOPIC || '').replace(/[^A-Za-z0-9_-]/g, '');
const UTC_AR = 3;          // Argentina es UTC-3 todo el año
const DIAS_ADELANTE = 2;   // hoy, mañana y pasado (ntfy permite programar hasta 3 días)

const dos = (n) => String(n).padStart(2, '0');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const limpiaId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
const diaNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
function desdeDiaNum(n) { const d = new Date(n * 86400000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
function hoyAR() {
  const d = new Date(Date.now() - UTC_AR * 3600000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// Mismo criterio que la agenda del panel (recOcurreEn): fecha original y cada repetición desde ahí.
function ocurre(it, n) {
  const f = String(it.f || '').split('-').map(Number);
  if (f.length !== 3 || f.some(isNaN)) return false;
  const fn = diaNum(f[0], f[1], f[2]);
  if (n === fn) return true;
  if (!it.r || n < fn) return false;
  const c = desdeDiaNum(n);
  if (it.r === 'diario') return true;
  if (it.r === 'semanal') return (n - fn) % 7 === 0;
  if (it.r === 'mensual') return f[2] === c.d;
  if (it.r === 'anual') return f[2] === c.d && f[1] === c.m;
  return false;
}

async function ntfy(cuerpo) {
  for (let intento = 0; intento < 3; intento++) {
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, ...cuerpo }), signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return;
    if (res.status === 429 && intento < 2) { await esperar(6000); continue; }
    throw new Error('ntfy respondio ' + res.status);
  }
}
async function cancelar(seq) {
  try { await fetch('https://ntfy.sh/' + topic + '/' + encodeURIComponent(seq), { method: 'DELETE', signal: AbortSignal.timeout(15000) }); } catch (e) { /* si no existe, no pasa nada */ }
}

function leer() {
  let crudo;
  try { crudo = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch (e) { return { falta: true }; }
  if (crudo && crudo.plano) return { datos: crudo.plano };
  try {
    const key = crypto.pbkdf2Sync(topic, Buffer.from(crudo.s, 'base64'), 100000, 32, 'sha256');
    const buf = Buffer.from(crudo.d, 'base64');
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(crudo.i, 'base64'));
    dec.setAuthTag(buf.subarray(buf.length - 16));
    const txt = Buffer.concat([dec.update(buf.subarray(0, buf.length - 16)), dec.final()]).toString('utf8');
    return { datos: JSON.parse(txt) };
  } catch (e) { return { noLee: true }; }
}

async function main() {
  if (!topic) { console.log('Falta el secreto NTFY_TOPIC en GitHub.'); process.exit(1); }
  const r = leer();
  if (r.falta) {
    console.log('Todavia no hay avisos/agenda.json: el panel lo sube al instalar o al tocar "Actualizar ahora".');
    if (prueba) await ntfy({ title: 'Aviso de agenda: falta sincronizar', message: 'GitHub todavia no tiene tus recordatorios. Abri el panel (Recordatorios > Agenda) y toca "Actualizar ahora".', priority: 3, tags: ['warning'] });
    return;
  }
  if (r.noLee) {
    console.log('No se pudo descifrar: el canal del panel y el secreto NTFY_TOPIC no coinciden.');
    await ntfy({ title: 'Aviso de agenda: no puedo leerla', message: 'El canal de ntfy del panel y el secreto NTFY_TOPIC de GitHub no son el mismo. Corregilo y toca "Actualizar ahora" en el panel.', priority: 3, tags: ['warning'] });
    return;
  }
  const d = r.datos || {};
  const horaDef = Math.max(0, Math.min(23, parseInt(d.hora, 10) || 9));
  const antes = Math.max(0, Math.min(720, parseInt(d.antes, 10) || 0));
  const items = Array.isArray(d.items) ? d.items : [];
  const h = hoyAR(), hoyN = diaNum(h.y, h.m, h.d);
  const ahora = Date.now(), tope = ahora + 2.95 * 86400000;

  // 1) cancelar lo que se borro del panel
  const borrados = (Array.isArray(d.cancelar) ? d.cancelar : []).map(limpiaId).filter(Boolean);
  let nCancel = 0;
  for (const id of borrados) {
    for (let k = -1; k <= DIAS_ADELANTE; k++) {
      const f = desdeDiaNum(hoyN + k);
      await cancelar('agenda-' + id + '-' + f.y + dos(f.m) + dos(f.d));
      nCancel++; await esperar(120);
    }
  }

  // 2) programar los de hoy, mañana y pasado
  const lista = [];
  for (const it of items) {
    const id = limpiaId(it.i); if (!id || !it.t) continue;
    for (let k = 0; k <= DIAS_ADELANTE; k++) {
      const n = hoyN + k;
      if (!ocurre(it, n)) continue;
      const f = desdeDiaNum(n);
      let hh = horaDef, mm = 0, conHora = false;
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(it.h || ''));
      if (m) { hh = +m[1]; mm = +m[2]; conHora = true; }
      let momento = Date.UTC(f.y, f.m - 1, f.d, hh + UTC_AR, mm);
      if (conHora && antes) momento -= antes * 60000;
      if (momento < ahora + 12000 || momento > tope) continue; // ya pasó, o todavía no se puede programar
      lista.push({ id, it, f, hh, mm, conHora, momento });
    }
  }
  lista.sort((a, b) => a.momento - b.momento);
  console.log('Recordatorios cargados: ' + items.length + ' | a programar (próx. 3 días): ' + lista.length + ' | cancelaciones: ' + nCancel);

  let ok = 0;
  for (const x of lista) {
    const hora = dos(x.hh) + ':' + dos(x.mm);
    const titulo = x.conHora ? (antes ? 'En ' + antes + ' min (' + hora + ')' : hora + ' · Recordatorio') : '⏰ Recordatorio de hoy';
    try {
      await ntfy({
        title: titulo, message: String(x.it.t), priority: x.conHora ? 4 : 3, tags: ['alarm_clock'],
        delay: String(Math.floor(x.momento / 1000)),
        sequence_id: 'agenda-' + x.id + '-' + x.f.y + dos(x.f.m) + dos(x.f.d),
      });
      ok++;
    } catch (e) { console.log('No se pudo programar "' + x.it.t + '": ' + e.message); }
    await esperar(250);
  }
  console.log('Programados en ntfy: ' + ok + ' de ' + lista.length);

  if (prueba) {
    const prox = lista.slice(0, 5).map((x) => dos(x.f.d) + '/' + dos(x.f.m) + ' ' + dos(x.hh) + ':' + dos(x.mm) + ' - ' + x.it.t).join('\n');
    await ntfy({
      title: 'Prueba OK: avisos de agenda',
      message: 'Tengo ' + items.length + ' recordatorios cargados y ' + ok + ' programados para los próximos días.' + (prox ? '\nPróximos:\n' + prox : '\nNo hay ninguno programado en los próximos días.'),
      priority: 3, tags: ['white_check_mark'],
    });
  }
}
main().catch((e) => { console.log('Falló el aviso de agenda: ' + e.message); process.exit(1); });
