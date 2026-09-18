/**
 * Startar egress-proxyn. Konfiguration enbart via miljön:
 *   EGRESS_ALLOW  värdnamn:port, kommaseparerat (obligatorisk — inget standardvärde)
 *   PORT          standard 3128
 *   LISTEN_HOST   standard 0.0.0.0 (proxyn ska bara nås från plattformens interna nät)
 * Loggar en rad JSON per beslut — aldrig data ur tunnlarna.
 */
import { createEgressProxy, parseAllowList } from './index.ts';

function fail(message: string): never {
  process.stderr.write(`egress: ${message}\n`);
  process.exit(1);
}

const allowText = process.env['EGRESS_ALLOW'] ?? '';
let allow: Set<string>;
try {
  allow = parseAllowList(allowText);
} catch (error) {
  fail(error instanceof Error ? error.message : 'ogiltig EGRESS_ALLOW');
}

const port = Number(process.env['PORT'] ?? '3128');
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT måste vara ett portnummer.');
const host = process.env['LISTEN_HOST'] ?? '0.0.0.0';

const server = createEgressProxy({
  allow,
  logger: (entry) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`),
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'listening', host, port, allow: [...allow] })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
