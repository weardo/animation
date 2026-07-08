// Force IPv4 for all outbound connections in this process.
//
// WHY: Node 17+ resolves DNS `verbatim` and Google's APIs return an AAAA (IPv6) record first.
// undici (the engine behind global `fetch`) then attempts the IPv6 address. On an IPv4-only host
// (no global IPv6 route) that address black-holes and every request dies with ETIMEDOUT — while
// `curl` works because it silently falls back to IPv4. `dns.setDefaultResultOrder('ipv4first')`
// only REORDERS the list; undici still sees the v6 entry and tries it. So we go one level deeper
// and make `dns.lookup` itself never hand back a v6 address — undici literally cannot try the dead
// route. Import this module for its side effect BEFORE any network call.
//
// Safe on this box (IPv4-only); if a genuinely v6-only host is ever needed, gate this behind an env.
import dns from 'node:dns';

type LookupFn = typeof dns.lookup;

const original = dns.lookup.bind(dns) as LookupFn;

// dns.lookup(hostname, [options|family], callback) — normalize every call to force family:4.
const forced = ((hostname: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === 'function' ? options : callback) as
    | ((...a: unknown[]) => void)
    | undefined;
  const base =
    typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {};
  const opts = { ...base, family: 4 };
  return (original as (...a: unknown[]) => unknown)(hostname, opts, cb);
}) as unknown as LookupFn;

(dns as { lookup: LookupFn }).lookup = forced;
