here// utils/rateLimit.js (يمكن دمجه في الملف الرئيسي)
class RateLimiter {
  constructor(windowMs = 60000, maxRequests = 10) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  isAllowed(identifier) {
    const now = Date.now();
    const timestamps = this.requests.get(identifier) || [];
    const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
    if (validTimestamps.length >= this.maxRequests) return false;
    validTimestamps.push(now);
    this.requests.set(identifier, validTimestamps);
    return true;
  }

  // تنظيف الخريطة دوريًا (اختياري)
  startCleanup(intervalMs = 60000) {
    setInterval(() => {
      const now = Date.now();
      for (const [id, timestamps] of this.requests.entries()) {
        const valid = timestamps.filter(ts => now - ts < this.windowMs);
        if (valid.length === 0) this.requests.delete(id);
        else this.requests.set(id, valid);
      }
    }, intervalMs);
  }
}

// إدارة الجلسات (history لكل مستخدم)
class SessionManager {
  constructor(ttl = 30 * 60 * 1000) { // 30 دقيقة
    this.sessions = new Map();
    this.ttl = ttl;
  }

  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // تحديث آخر استخدام
    session.lastUsed = Date.now();
    return session.history;
  }

  addMessage(sessionId, role, content, reasoning = null) {
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

  // تنظيف الجلسات منتهية الصلاحية
  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastUsed > this.ttl) {
        this.sessions.delete(id);
      }
    }
  }
}

// إدارة nonce مع TTL وإعادة المحاولة
let cachedNonce = null;
let nonceTimestamp = 0;
const NONCE_TTL = 60 * 60 * 1000; // ساعة واحدة

async function fetchNonceWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('https://glm-ai.chat/chat/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const html = await res.text();
      const match = html.match(/"nonce":"([^"]+)"/);
      if (match) return match[1];
      throw new Error('Nonce pattern not found');
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

// دالة استدعاء GLM API
async function callGlmApi(message, historyArray, nonce, sessionId) {
  // تحويل مصفوفة history إلى الصيغة المطلوبة: [{"role":"user","content":"..."}, ...]
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

  if (!response.ok) {
    throw new Error(`GLM API responded with status ${response.status}`);
  }

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
        if (!delta) continue;

        if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
        if (delta.content) fullContent += delta.content;
      } catch (err) {
        // تجاهل أخطاء JSON الجزئية
      }
    }
  }

  return { content: fullContent, reasoning: fullReasoning };
}

// تهيئة المديرين
const sessionManager = new SessionManager();
const rateLimiter = new RateLimiter(60000, 15); // 15 طلب لكل دقيقة لكل معرف
// تنظيف الجلسات كل 10 دقائق
setInterval(() => sessionManager.cleanup(), 10 * 60 * 1000);

// Handler الرئيسي (Next.js API route)
export default async function handler(req, res) {
  // إعداد CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // استخراج المعاملات (GET أو POST)
  let message = '';
  let sessionId = 'default';
  let prompt = ''; // للتوجيه المبدئي (اختياري)

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

  // التحقق من وجود الرسالة
  if (!message) {
    return res.status(400).json({ error: 'Missing required field: request' });
  }

  // Rate Limiting (باستخدام IP + sessionId)
  const clientId = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const rateKey = `${clientId}:${sessionId}`;
  if (!rateLimiter.isAllowed(rateKey)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  try {
    // الحصول على nonce صالح
    const nonce = await getNonce();

    // جلب history الجلسة الحالية
    let history = sessionManager.getHistory(sessionId);

    // إذا وُجد prompt (توجيه أولي) ولم يكن هناك تاريخ، نضيفه كنظام أو رسالة مستخدم
    if (prompt && history.length === 0) {
      // يمكن معاملة الـ prompt كرسالة نظام أو user message
      // نضيفها كرسالة user لتوجيه النموذج
      history.push({ role: 'user', content: prompt });
      // إضافة رد مساعد فارغ أو placeholder (اختياري حسب منطق GLM)
      // لكن الأفضل تركها كما هي، GLM سيتعامل معها
    }

    // إضافة رسالة المستخدم الحالية إلى التاريخ قبل الإرسال
    const updatedHistory = [...history, { role: 'user', content: message }];

    // استدعاء GLM API
    const { content, reasoning } = await callGlmApi(message, updatedHistory, nonce, sessionId);

    // تخزين الرد في الجلسة
    sessionManager.addMessage(sessionId, 'assistant', content, reasoning);

    // إرجاع النتيجة
    return res.status(200).json({
      thinking: reasoning,
      content: content,
      session_id: sessionId,
    });
  } catch (error) {
    console.error('GLM Proxy Error:', error);
    return res.status(500).json({
      error: 'Failed to process request',
      details: error.message,
    });
  }
}
