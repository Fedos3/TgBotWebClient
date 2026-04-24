import crypto from 'node:crypto';

const SESSION_COOKIE = 'panel_sid';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const REMEMBER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const sign = (payload, secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
};

const verify = (token, secret) => {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (!data.exp || data.exp < Date.now()) return null;
  return data;
};

export const createAuth = ({ password, secret }) => {
  if (!password) throw new Error('PANEL_PASSWORD is required');
  if (!secret) throw new Error('SESSION_SECRET is required');

  const login = (pwd, remember) => {
    if (typeof pwd !== 'string') return null;
    const a = Buffer.from(pwd);
    const b = Buffer.from(password);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    const maxAge = remember ? REMEMBER_MAX_AGE_MS : SESSION_MAX_AGE_MS;
    return {
      token: sign({ exp: Date.now() + maxAge }, secret),
      maxAge,
      remember: Boolean(remember),
    };
  };

  const middleware = (req, res, next) => {
    const data = getSession(req);
    if (!data) return res.status(401).json({ error: 'unauthorized' });
    req.session = data;
    next();
  };

  const getSession = (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    return verify(token, secret);
  };

  const isAuthorized = (req) => Boolean(getSession(req));

  const setCookie = (res, token, options = {}) => {
    const { remember = false, maxAge } = options;
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      ...(remember ? { maxAge } : {}),
      path: '/',
    });
  };
  const clearCookie = (res) => res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });

  return { login, middleware, setCookie, clearCookie, getSession, isAuthorized };
};
