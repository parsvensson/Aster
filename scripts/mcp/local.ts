/** Who may talk to the bridge: the computer it runs on, asked for by a local name. */
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Only the computer the server runs on may talk to the bridge, whatever `--host` says. */
export const isLocal = (req: Pick<IncomingMessage, 'socket' | 'headers'>) => {
	const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return (
		LOOPBACK.has(req.socket.remoteAddress ?? '') &&
		(host === 'localhost' || LOOPBACK.has(host) || host.endsWith('.localhost'))
	);
};

/**
 * A page of another site, open in the same browser, can reach a local port; its requests carry
 * its own origin. Requests without one (not from a browser) and same-origin ones pass.
 */
export const sameOrigin = (req: Pick<IncomingMessage, 'headers'>) => {
	const origin = req.headers.origin;
	return origin === undefined || origin === `http://${req.headers.host ?? ''}`;
};
