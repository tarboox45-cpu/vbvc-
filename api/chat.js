// utils/rateLimit.js - بدون setInterval
class RateLimiter {
  constructor(windowMs = 60000, maxRequests = 15) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  isAllowed(identifier) {
    const now = Date.now();
    const timestamps = this.requests.get(identifier) || [];
    // إزالة الطلبات القديمة عند كل فحص (لن نحتاج setInterval منفصل)
    const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
    if (validTimestamps.length >= this.maxRequests) return false;
    validTimestamps.push(now);
    this.requests.set(identifier, validTimestamps);
    return true;
  }

  // تنظيف اختياري - يمكن استدعاؤه مرة كل 100 طلب مثلاً
  cleanIfNeeded() {
    if (Math.random() < 0.01) { // 1% من الطلبات
      const now = Date.now();
      for (const [id, timestamps] of this.requests.entries()) {
        const valid = timestamps.filter(ts => now - ts < this.windowMs);
        if (valid.length === 0) this.requests.delete(id);
        else this.requests.set(id, valid);
      }
    }
  }
}

// إدارة الجلسات - بدون setInterval
class SessionManager {
  constructor(ttl = 30 * 60 * 1000) {
    this.sessions = new Map();
    this.ttl = ttl;
  }

  getHistory(sessionId) {
    this.cleanupExpired(); // تنظيف كسول (lazy cleanup)
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    session.lastUsed = Date.now();
    return session.history;
  }

  addMessage(sessionId, role, content, reasoning = null) {
    this.cleanupExpired();
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { history: [], lastUsed: Date.now() };
      this.sessions.set(sessionId, session);
    }
    session.lastUsed = Date.now();
    const message = { role, content };
    if (reasoning && role === 'assistant') message.reasoning = reasoning;
    session.history.push(message);
    return session.history;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastUsed > this.ttl) {
        this.sessions.delete(id);
      }
    }
  }
}

// إدارة nonce (بدون تغيير)
let cachedNonce = null;
let nonceTimestamp = 0;
const NONCE_TTL = 60 * 60 * 1000;

async function fetchNonceWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('https://glm-ai.chat/chat/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const match = html.match(/"nonce":"([^"]+)"/);
      if (match) return match[1];
      throw new Error('Nonce not found');
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

async function getNonce() {
  const now = Date.now();
  if (cachedNonce && now - nonceTimestamp < NONCE_TTL) {
    return cachedNonce;
  }
  cachedNonce = await fetchNonceWithRetry();
  nonceTimestamp = now;
  return cachedNonce;
}

async function callGlmApi(message, historyArray, nonce, sessionId) {
  const historyJson = JSON.stringify(historyArray);
  const formData = new URLSearchParams();
  formData.append('action', 'glm_chat_stream');
  formData.append('nonce', nonce);
  formData.append('message', message);
  formData.append('history', historyJson);
  formData.append('agent_mode', '1');

  const response = await fetch('https://glm-ai.chat/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `glm_session_id=guest_${sessionId}`,
      Origin: 'https://glm-ai.chat',
      Referer: 'https://glm-ai.chat/chat/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: formData.toString(),
  });

  if (!response.ok) throw new Error(`GLM API error: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let fullReasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.replace('data:', '').trim();
      if (dataStr === '[DONE]') break;
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
        if (delta?.content) fullContent += delta.content;
      } catch (err) { /* تجاهل */ }
    }
  }
  return { content: fullContent, reasoning: fullReasoning };
}

// إنشاء الكائنات على مستوى الوحدة (مرة واحدة لكل instances)
const sessionManager = new SessionManager();
const rateLimiter = new RateLimiter();

// Handler الرئيسي لـ Vercel
export default async function handler(req, res) {
  // إعداد CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // استخراج المعاملات
    let message = '', sessionId = 'default', prompt = '';
    if (req.method === 'GET') {
      message = req.query.request || '';
      sessionId = req.query.session_id || 'default';
      prompt = req.query.prompt || '';
    } else if (req.method === 'POST') {
      message = req.body.request || '';
      sessionId = req.body.session_id || 'default';
      prompt = req.body.prompt || '';
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!message) {
      return res.status(400).json({ error: 'Missing "request" field' });
    }

    // Rate limiting - استخدام IP من Vercel
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const rateKey = `${ip}:${sessionId}`;
    if (!rateLimiter.isAllowed(rateKey)) {
      return res.status(429).json({ error: 'Too many requests. Try later.' });
    }
    rateLimiter.cleanIfNeeded(); // تنظيف عشوائي خفيف

    // جلب nonce
    let nonce;
    try {
      nonce = await getNonce();
    } catch (err) {
      console.error('Nonce fetch failed:', err);
      return res.status(502).json({ error: 'Could not fetch nonce from upstream' });
    }

    // جلب التاريخ
    let history = sessionManager.getHistory(sessionId);
    if (prompt && history.length === 0) {
      history.push({ role: 'user', content: prompt });
    }

    // استدعاء GLM
    const { content, reasoning } = await callGlmApi(message, history, nonce, sessionId);

    // حفظ الرد
    sessionManager.addMessage(sessionId, 'assistant', content, reasoning);

    return res.status(200).json({
      thinking: reasoning,
      content: content,
      session_id: sessionId,
    });
  } catch (error) {
    console.error('Unhandled error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
    });
  }
}
