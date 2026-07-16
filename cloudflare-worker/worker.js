// Cloudflare Worker — free reverse proxy in front of the Render backend.
//
// Gives you a free, globally-reachable URL (https://<name>.<you>.workers.dev)
// that forwards everything (REST + Socket.IO WebSockets) to Render, hiding the
// origin and bypassing networks that block *.onrender.com.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create Worker -> paste this
// -> Deploy. Then use  https://<your-worker>.workers.dev/api/v1  as API_BASE_URL.

const ORIGIN_HOST = 'edubridge-api-s5l4.onrender.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = ORIGIN_HOST;
    url.protocol = 'https:';
    url.port = '';

    // Forward the request as-is. Cloudflare transparently proxies the
    // WebSocket Upgrade too, so Socket.IO (chat / live sessions) passes through.
    const proxied = new Request(url.toString(), request);
    proxied.headers.set('Host', ORIGIN_HOST);
    proxied.headers.set('X-Forwarded-Host', new URL(request.url).host);

    return fetch(proxied);
  },
};
