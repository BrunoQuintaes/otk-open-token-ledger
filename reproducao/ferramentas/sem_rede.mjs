// Trava de rede para a reprodução: carregada com `node --import ./reproducao/ferramentas/sem_rede.mjs`.
// Bloqueia conexão TCP/TLS e fetch para qualquer endereço que não seja a própria máquina (127.0.0.1, ::1, localhost),
// e bloqueia consulta DNS. Se algum script tentar usar a internet, ele falha com SEM_REDE em vez de conectar.
import net from 'node:net';
import dns from 'node:dns';
const LOCAL = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']);
const negar = (alvo) => { const e = new Error(`SEM_REDE: tentativa de conexão para ${alvo} bloqueada na reprodução`); e.code = 'SEM_REDE'; return e; };
const hostDe = (args) => { const a = args[0]; if (Array.isArray(a)) return hostDe(a); if (a && typeof a === 'object') return a.host ?? a.hostname ?? (a.path ? 'ipc' : 'localhost'); if (typeof a === 'string' && !/^\d+$/.test(a)) return 'ipc'; return typeof args[1] === 'string' ? args[1] : 'localhost'; };
const original = net.Socket.prototype.connect;
const LOOPBACK_IP = (a) => /^127\./.test(a) || a === '::1' || a === '::ffff:127.0.0.1';
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const h = String(hostDe(args)).replace(/^\[|\]$/g, '');
  // DNS falso dos testes (opção lookup): permitido só se o endereço resolvido for da própria máquina
  if (o && typeof o === 'object' && typeof o.lookup === 'function' && !LOCAL.has(h) && h !== 'ipc') {
    const lk = o.lookup;
    o.lookup = (host, opts, cb) => lk(host, opts, (err, addr, fam) => {
      if (err) return cb(err, addr, fam);
      const lista = Array.isArray(addr) ? addr.map((x) => x.address) : [addr];
      if (!lista.every((a) => LOOPBACK_IP(String(a)))) return cb(negar(`${host} -> ${lista.join(',')}`));
      return cb(err, addr, fam);
    });
    return original.apply(this, args);
  }
  if (h !== 'ipc' && !LOCAL.has(h) && !LOOPBACK_IP(h)) { const e = negar(h); process.nextTick(() => this.destroy(e)); return this; }
  return original.apply(this, args);
};
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const o = dns[k]; dns[k] = function (host, ...rest) { if (LOCAL.has(host)) return o.call(this, host, ...rest); const cb = rest.find((x) => typeof x === 'function'); const e = negar(host); if (cb) process.nextTick(() => cb(e)); else throw e; };
}
if (typeof globalThis.fetch === 'function') {
  const f = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const u = new URL(typeof input === 'string' ? input : input.url ?? String(input)); if (!LOCAL.has(u.hostname.replace(/^\[|\]$/g, ''))) throw negar(u.hostname); return f(input, init); };
}
