// btc-alertas-v1
// Lee las reglas que carga el panel (alertas/btc-reglas.json), mira el precio actual de BTC/ETH
// y avisa por ntfy cuando una regla se cumple. Cada regla avisa UNA vez; se vuelve a armar desde el panel.
import fs from 'node:fs';

const RUTA_REGLAS = 'alertas/btc-reglas.json';
const RUTA_ESTADO = 'alertas/btc-estado.json';
const TOPIC = (process.env.NTFY_TOPIC || '').replace(/[^A-Za-z0-9_-]/g, '');
const REGISTRAR_PRECIO_CADA_MS = 6 * 60 * 60 * 1000;

function leer(ruta, defecto){ try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch(e){ return defecto; } }
async function pedir(url){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'agencia-alertas' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
const FUENTES = {
  BTC: [
    async () => Number((await pedir('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount),
    async () => { const j = await pedir('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'); return Number(Object.values(j.result)[0].c[0]); },
    async () => Number((await pedir('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')).bitcoin.usd)
  ],
  ETH: [
    async () => Number((await pedir('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount),
    async () => { const j = await pedir('https://api.kraken.com/0/public/Ticker?pair=ETHUSD'); return Number(Object.values(j.result)[0].c[0]); },
    async () => Number((await pedir('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')).ethereum.usd)
  ]
};
async function precio(moneda){
  for (const f of FUENTES[moneda] || []){
    try { const p = await f(); if (isFinite(p) && p > 0) return p; } catch(e){ /* probamos la siguiente fuente */ }
  }
  return null;
}
const usd = n => 'USD ' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
async function avisar(titulo, mensaje){
  if (!TOPIC){ console.log('Sin NTFY_TOPIC: no se puede avisar —', titulo); return false; }
  try {
    const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: TOPIC, title: titulo, message: mensaje, priority: 4, tags: ['chart_with_upwards_trend'] }) });
    return r.ok;
  } catch(e){ return false; }
}

const reglas = (leer(RUTA_REGLAS, { reglas: [] }).reglas || []).filter(r => r && r.activa !== false && isFinite(r.precio) && FUENTES[r.moneda]);
const estado = leer(RUTA_ESTADO, {}); estado.precios = estado.precios || {}; estado.disparadas = estado.disparadas || {};
const antes = JSON.stringify(estado);

const pendientes = reglas.filter(r => !(estado.disparadas[r.id] && estado.disparadas[r.id].rev === (r.rev || 1)));
const monedas = [...new Set(pendientes.map(r => r.moneda))];
const hoy = Date.now();
for (const m of monedas){
  const p = await precio(m);
  if (p === null){ console.log('No se pudo leer el precio de ' + m); continue; }
  const previo = estado.precios[m];
  if (!previo || hoy - Date.parse(previo.ts || 0) > REGISTRAR_PRECIO_CADA_MS) estado.precios[m] = { usd: p, ts: new Date(hoy).toISOString() };
  for (const r of pendientes.filter(x => x.moneda === m)){
    const sube = r.dir === 'up';
    if (!(sube ? p >= r.precio : p <= r.precio)) continue;
    const titulo = (m === 'BTC' ? '₿ Bitcoin' : 'Ξ Ethereum') + (sube ? ' subió a ' : ' bajó a ') + usd(p);
    const msg = 'Tu alerta: ' + (sube ? 'que suba a ' : 'que baje a ') + usd(r.precio) + '. Precio ahora: ' + usd(p) + '.';
    const ok = await avisar(titulo, msg);
    console.log((ok ? 'Avisado: ' : 'NO se pudo avisar: ') + titulo);
    if (ok) { estado.disparadas[r.id] = { rev: r.rev || 1, ts: new Date(hoy).toISOString(), precio: p }; estado.precios[m] = { usd: p, ts: new Date(hoy).toISOString() }; }
  }
}
// Limpia estados de reglas que ya no existen (se borraron desde el panel)
const ids = new Set((leer(RUTA_REGLAS, { reglas: [] }).reglas || []).map(r => r.id));
for (const id of Object.keys(estado.disparadas)) if (!ids.has(id)) delete estado.disparadas[id];
if (JSON.stringify(estado) !== antes){ fs.mkdirSync('alertas', { recursive: true }); fs.writeFileSync(RUTA_ESTADO, JSON.stringify(estado, null, 2)); }
