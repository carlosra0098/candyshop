/** Enrutador HTTP minimalista con soporte de parámetros :id */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:([A-Za-z_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$'
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: route.handler, params };
    }
    return null;
  }
}

/** Helpers para respuestas JSON. */
export const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

export const ok = (res, data) => json(res, 200, data);
export const created = (res, data) => json(res, 201, data);
export const fail = (res, status, message, extra = {}) =>
  json(res, status, { error: message, ...extra });

/** Lee y parsea el cuerpo JSON de una petición. */
export function readBody(req, limit = 1e6) {
  return readRaw(req, limit).then((raw) => {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      const err = new Error('JSON inválido');
      err.statusCode = 400;
      throw err;
    }
  });
}

/**
 * Lee y parsea un cuerpo application/x-www-form-urlencoded (OAuth 2.0, RFC 6749).
 * Si el cliente envía JSON, también lo acepta (conveniencia para APIs/tests).
 */
export function readForm(req, limit = 1e6) {
  return readRaw(req, limit).then((raw) => {
    if (!raw) return {};
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) {
      try {
        return JSON.parse(raw);
      } catch {
        const err = new Error('JSON inválido');
        err.statusCode = 400;
        throw err;
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('Payload demasiado grande');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', reject);
  });
}
