// avisos-venc-v1
// Avisa por ntfy los vencimientos de servicios e impuestos que se acercan.
// Lo ejecuta GitHub Actions todos los días, con el panel cerrado.
// Lee avisos/vencimientos.json (lo sube el panel, cifrado con el nombre del canal de ntfy).
import fs from 'node:fs';
import crypto from 'node:crypto';

const TZ = 'America/Argentina/Buenos_Aires';
const ARCHIVO = 'avisos/vencimientos.json';
const prueba = String(process.env.PRUEBA || '') === 'true';
const topic = String(process.env.NTFY_TOPIC || '').replace(/[^A-Za-z0-9_-]/g, '');

function hoyAR() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}
const diaNum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dos = (n) => String(n).padStart(2, '0');

// Proxima fecha de un gasto fijo mensual (mismo criterio que el panel): este mes si no paso, si no el mes que viene.
function proxima(diaMes, h) {
  let y = h.y, m = h.m;
  let d = Math.min(diaMes, ultimoDia(y, m));
  if (diaNum(y, m, d) < diaNum(h.y, h.m, h.d)) { m += 1; if (m > 12) { m = 1; y += 1; } d = Math.min(diaMes, ultimoDia(y, m)); }
  return { y, m, d };
}

async function ntfy(titulo, mensaje, prioridad, tags) {
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title: titulo, message: mensaje, priority: prioridad, tags }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('ntfy respondio ' + res.status);
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

const fmtMonto = (n) => '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });

async function main() {
  if (!topic) { console.log('Falta el secreto NTFY_TOPIC en GitHub.'); process.exit(1); }
  const r = leer();
  if (r.falta) {
    console.log('Todavía no hay avisos/vencimientos.json: el panel lo sube al abrirlo.');
    if (prueba) await ntfy('Aviso de vencimientos: falta sincronizar', 'GitHub todavía no tiene tus vencimientos. Abrí el panel (pestaña Vencimientos) y tocá "Actualizar ahora".', 3, ['warning']);
    return;
  }
  if (r.noLee) {
    console.log('No se pudo descifrar: el canal del panel y el secreto NTFY_TOPIC no coinciden.');
    await ntfy('Aviso de vencimientos: no puedo leerlos', 'El canal de ntfy del panel y el secreto NTFY_TOPIC de GitHub no son el mismo. Corregilo y tocá "Actualizar ahora" en el panel.', 3, ['warning']);
    return;
  }
  const dias = Math.max(0, Math.min(30, parseInt(r.datos.dias, 10) || 3));
  const h = hoyAR(), hoyN = diaNum(h.y, h.m, h.d);
  const lista = [];
  for (const it of (r.datos.items || [])) {
    let f = null;
    if (it.r) f = proxima(parseInt(it.r, 10), h);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(it.f || '')) { const q = it.f.split('-').map(Number); f = { y: q[0], m: q[1], d: q[2] }; }
    if (!f) continue;
    lista.push({ n: String(it.n || 'Vencimiento'), m: it.m, dias: diaNum(f.y, f.m, f.d) - hoyN, f });
  }
  lista.sort((a, b) => a.dias - b.dias);
  const cerca = lista.filter((x) => x.dias >= 0 && x.dias <= dias);
  console.log('Cargados: ' + lista.length + ' | dentro de ' + dias + ' día(s): ' + cerca.length);
  if (!cerca.length) {
    if (prueba) {
      const sig = lista.find((x) => x.dias >= 0);
      await ntfy('Prueba OK: sin vencimientos cerca', 'No hay vencimientos en los próximos ' + dias + ' día(s). Tengo ' + lista.length + ' cargados' + (sig ? '; el próximo es ' + sig.n + ' (' + dos(sig.f.d) + '/' + dos(sig.f.m) + ').' : '.'), 3, ['white_check_mark']);
    }
    return;
  }
  const rotulo = (x) => (x.dias === 0 ? 'HOY' : x.dias === 1 ? 'Mañana' : 'En ' + x.dias + ' días');
  let lineas = cerca.map((x) => rotulo(x) + ' (' + dos(x.f.d) + '/' + dos(x.f.m) + ') - ' + x.n + (x.m ? ' - ' + fmtMonto(x.m) : ''));
  const pie = '\nSi ya lo pagaste, sacalo del panel (Vencimientos) y deja de avisar.';
  let msg = lineas.join('\n') + pie;
  while (Buffer.byteLength(msg) > 3900 && lineas.length > 1) { lineas.pop(); msg = lineas.join('\n') + '\n... y ' + (cerca.length - lineas.length) + ' más' + pie; }
  const hoy = cerca.filter((x) => x.dias === 0).length;
  const titulo = (hoy ? 'VENCE HOY: ' : 'Vencimientos: ') + cerca.length + (cerca.length === 1 ? ' pendiente' : ' pendientes');
  await ntfy(titulo, msg, cerca.some((x) => x.dias <= 1) ? 4 : 3, ['alarm_clock']);
  console.log('Aviso enviado.');
}
main().catch((e) => { console.log('Falló el aviso: ' + e.message); process.exit(1); });
