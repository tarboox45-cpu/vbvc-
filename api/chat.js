import { Redis } from '@upstash/redis';
import { v4 as uuidv4 } from 'uuid';

// ===============================
// التكوينات الأساسية
// ===============================
const REDIS = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
const NONCE_TTL = 60 * 60 * 1000; // 1 hour
const SESSION_TTL = 60 * 60 * 24; // 24 hours (بالثواني لـ Redis)
const MAX_HISTORY_LENGTH = 20;
const STREAM_CHUNK_DELAY = 0; // تأخير اختياري بين الأجزاء (مللي ثانية)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');
const BLOCKED_WORDS = (process.env.BLOCKED_WORDS || '').split(',').filter(w => w);
const ENABLE_COST_ESTIMATE = true;

// ===============================
// أدوات مساعدة
// ===============================
function estimateCost(model, inputTokens, outputTokens) {
  if (!ENABLE_COST_ESTIMATE) return null;
  const rates = {
    'glm-4': { input: 0.0001, output: 0.0002 },
    'glm-3': { input: 0.00005, output: 0.0001 },
    'glm-130b': { input: 0.0002, output: 0.0004 },
  };
  const rate = rates[model] || rates['glm-3'];
  return (inputTokens * rate.input + outputTokens * rate.output).toFixed(6);
}

function filterBlockedWords(text) {
  let filtered = text;
  for (const word of BLOCKED_WORDS) {
    const regex = new RegExp(word, 'gi');
    filtered = filtered.replace(regex, '[ممنوع]');
  }
  return filtered;
}

async function translateText(text, targetLang = 'en') {
  // مثال بسيط - يمكن استبدال بـ DeepL أو Google Translate API
  if (targetLang === 'ar') return text; // افتراض أن النص عربي
  // هنا يمكن إضافة تكامل حقيقي
  return `[Translated to ${targetLang}]: ${text}`;
}

// ===============================
// إدارة الجلسات في Redis
// ===============================
class SessionManager {
  async getHistory(sessionId) {
    const key = `chat:${sessionId}:history`;
    let history = await REDIS.lrange(key, 0, -1);
    history = history.map(item => JSON.parse(item));
    // تحديث TTL لكل عملية
    await REDIS.expire(key, SESSION_TTL);
    return history;
  }

  async addMessage(sessionId, role, content, reasoning = null, metadata = {}) {
    const key = `chat:${sessionId}:history`;
    const message = { role, content, reasoning, timestamp: Date.now(), ...metadata };
    await REDIS.rpush(key, JSON.stringify(message));
    // الحفاظ على الحد الأقصى للطول
    const len = await REDIS.llen(key);
    if (len > MAX_HISTORY_LENGTH) {
      await REDIS.ltrim(key, len - MAX_HISTORY_LENGTH, -1);
    }
    await REDIS.expire(key, SESSION_TTL);
    return message;
  }

  async setTitle(sessionId, title) {
    await REDIS.set(`chat:${sessionId}:title`, title, { ex: SESSION_TTL });
  }

  async getTitle(sessionId) {
    return await REDIS.get(`chat:${sessionId}:title`);
  }

  async getAllSessions(userId = 'anonymous') {
    const keys = await REDIS.keys(`chat:*:history`);
    // تحليل معرفات الجلسات
    const sessions = [];
    for (const key of keys) {
      const match = key.match(/chat:(.+):history/);
      if (match) sessions.push(match[1]);
    }
    return sessions;
  }
}

// ===============================
// إدارة Nonce (مع تخزين في Redis)
// ===============================
async function getNonce() {
  const cached = await REDIS.get('glm:nonce');
  const timestamp = await REDIS.get('glm:nonce_ts');
  const now = Date.now();
  if (cached && timestamp && (now - parseInt(timestamp)) < NONCE_TTL) {
    return cached;
  }
  // جلب nonce جديد مع إعادة المحاولة
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://glm-ai.chat/chat/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const html = await res.text();
      const match = html.match(/"nonce":"([^"]+)"/);
      if (match) {
        await REDIS.set('glm:nonce', match[1], { ex: Math.floor(NONCE_TTL / 1000) });
        await REDIS.set('glm:nonce_ts', now.toString(), { ex: Math.floor(NONCE_TTL / 1000) });
        return match[1];
      }
      throw new Error('Nonce not found');
    } catch (err) {
      if (i === 2) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// ===============================
// استدعاء GLM API مع دفق أو بدون
// ===============================
async function callGlmApi({
  message,
  history,
  nonce,
  sessionId,
  model = 'glm-4',
  temperature = 0.7,
  top_p = 0.9,
  max_tokens = 2000,
  presence_penalty = 0,
  frequency_penalty = 0,
  stream = false,
  onChunk = null,
  signal = null,
}) {
  const historyJson = JSON.stringify(history);
  const formData = new URLSearchParams();
  formData.append('action', 'glm_chat_stream');
  formData.append('nonce', nonce);
  formData.append('message', message);
  formData.append('history', historyJson);
  formData.append('agent_mode', '1');
  // إضافة معلمات إضافية إذا كان API يدعمها (هنا نضيفها كجزء من الطلب ولكن قد لا تستجيب لها GLM)
  // بعض الواجهات تدعم query params إضافية
  const url = `https://glm-ai.chat/wp-admin/admin-ajax.php?model=${encodeURIComponent(model)}&temperature=${temperature}&top_p=${top_p}&max_tokens=${max_tokens}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `glm_session_id=guest_${sessionId}`,
      Origin: 'https://glm-ai.chat',
      Referer: 'https://glm-ai.chat/chat/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: formData.toString(),
    signal,
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
      if (dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          fullReasoning += delta.reasoning_content;
          if (stream && onChunk) onChunk({ type: 'thinking', content: delta.reasoning_content });
        }
        if (delta?.content) {
          fullContent += delta.content;
          if (stream && onChunk) onChunk({ type: 'content', content: delta.content });
        }
      } catch (err) { /* تجاهل الأجزاء غير المكتملة */ }
    }
  }
  return { content: fullContent, reasoning: fullReasoning };
}

// ===============================
// وظائف Function Calling (مثال)
// ===============================
const availableFunctions = {
  get_weather: async (args) => {
    const { location } = args;
    // محاكاة طقس
    return `الطقس في ${location} مشمس مع درجة حرارة 25°C.`;
  },
  get_time: async () => {
    return new Date().toLocaleTimeString('ar-EG');
  },
};

async function handleFunctionCall(functionName, args) {
  const fn = availableFunctions[functionName];
  if (fn) return await fn(args);
  return `Function ${functionName} غير موجودة.`;
}

// ===============================
// نظام RAG بسيط (مكتبة معرفة)
// ===============================
const knowledgeBase = [
  { keywords: ['مصر', 'القاهرة'], answer: 'مصر دولة عربية عاصمتها القاهرة، وتشتهر بالأهرامات.' },
  { keywords: ['الذكاء الاصطناعي', 'AI'], answer: 'الذكاء الاصطناعي هو محاكاة العمليات الذكية بواسطة الآلات.' },
];
async function searchKnowledge(query) {
  const lowerQuery = query.toLowerCase();
  for (const item of knowledgeBase) {
    if (item.keywords.some(kw => lowerQuery.includes(kw))) {
      return item.answer;
    }
  }
  return null;
}

// ===============================
// نظام توليد عنوان المحادثة
// ===============================
async function generateTitle(sessionManager, sessionId, firstMessage) {
  const existing = await sessionManager.getTitle(sessionId);
  if (existing) return existing;
  // توليد عنوان بسيط: أول 50 حرفًا من أول رسالة
  let title = firstMessage.slice(0, 50);
  if (title.length < 5) title = 'محادثة جديدة';
  await sessionManager.setTitle(sessionId, title);
  return title;
}

// ===============================
// نظام تحليل المشاعر (وهمي)
// ===============================
function analyzeSentiment(text) {
  const positive = ['رائع', 'جميل', 'ممتاز', 'شكرا'];
  const negative = ['سيء', 'فاشل', 'خطأ', 'مشكلة'];
  let score = 0;
  for (const word of positive) if (text.includes(word)) score += 1;
  for (const word of negative) if (text.includes(word)) score -= 1;
  if (score > 0) return 'إيجابي';
  if (score < 0) return 'سلبي';
  return 'محايد';
}

// ===============================
// نظام Rate Limiting باستخدام Redis
// ===============================
class RateLimiter {
  async isAllowed(identifier, limit = 15, windowSec = 60) {
    const key = `rate:${identifier}`;
    const current = await REDIS.incr(key);
    if (current === 1) await REDIS.expire(key, windowSec);
    return current <= limit;
  }
}

// ===============================
// Handler الرئيسي مع SSE
// ===============================
const rateLimiter = new RateLimiter();
const sessionManager = new SessionManager();

export default async function handler(req, res) {
  // CORS ديناميكي
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stream');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // نقطة نهاية الصحة
  if (req.url === '/health') {
    return res.status(200).json({ status: 'ok', timestamp: Date.now() });
  }

  try {
    // استخراج المعاملات
    let message = '', sessionId = 'default', prompt = '', model = 'glm-4', temperature = 0.7, top_p = 0.9, max_tokens = 2000;
    let presence_penalty = 0, frequency_penalty = 0, stream = false, translateTo = null, imageBase64 = null;

    if (req.method === 'GET') {
      message = req.query.request || '';
      sessionId = req.query.session_id || 'default';
      prompt = req.query.prompt || '';
      model = req.query.model || 'glm-4';
      temperature = parseFloat(req.query.temperature) || 0.7;
      top_p = parseFloat(req.query.top_p) || 0.9;
      max_tokens = parseInt(req.query.max_tokens) || 2000;
      presence_penalty = parseFloat(req.query.presence_penalty) || 0;
      frequency_penalty = parseFloat(req.query.frequency_penalty) || 0;
      stream = req.query.stream === 'true';
      translateTo = req.query.translate_to || null;
      imageBase64 = req.query.image || null;
    } else if (req.method === 'POST') {
      message = req.body.request || '';
      sessionId = req.body.session_id || 'default';
      prompt = req.body.prompt || '';
      model = req.body.model || 'glm-4';
      temperature = req.body.temperature ?? 0.7;
      top_p = req.body.top_p ?? 0.9;
      max_tokens = req.body.max_tokens ?? 2000;
      presence_penalty = req.body.presence_penalty ?? 0;
      frequency_penalty = req.body.frequency_penalty ?? 0;
      stream = req.body.stream === true;
      translateTo = req.body.translate_to || null;
      imageBase64 = req.body.image || null;
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!message && !imageBase64) {
      return res.status(400).json({ error: 'Missing "request" or "image" field' });
    }

    // معالجة الصورة إذا وجدت (تحويل إلى نص باستخدام وصف وهمي)
    let imageDescription = '';
    if (imageBase64) {
      // هنا يمكن استدعاء نموذج رؤية حاسوبية (مثل GPT-4V) لكن سنقوم بمحاكاة
      imageDescription = '[صورة مرفوعة تحتوي على محتوى مرئي]';
      message = message ? `${message}\nوصف الصورة: ${imageDescription}` : `وصف الصورة: ${imageDescription}`;
    }

    // فلترة الكلمات الممنوعة
    message = filterBlockedWords(message);

    // Rate Limiting (باستخدام IP)
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const rateKey = `${ip}:${sessionId}`;
    const allowed = await rateLimiter.isAllowed(rateKey, 20, 60);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many requests. Try later.' });
    }

    // جلب nonce
    let nonce;
    try {
      nonce = await getNonce();
    } catch (err) {
      console.error('Nonce error:', err);
      return res.status(502).json({ error: 'Upstream nonce fetch failed' });
    }

    // جلب التاريخ
    let history = await sessionManager.getHistory(sessionId);
    if (prompt && history.length === 0) {
      history.push({ role: 'user', content: prompt });
    }

    // البحث في المعرفة (RAG) إذا كان السؤال استفساريًا
    let ragAnswer = null;
    if (message.includes('ما هو') || message.includes('من هو') || message.includes('شرح')) {
      ragAnswer = await searchKnowledge(message);
      if (ragAnswer) {
        message = `${message}\nمعلومة مساعدة: ${ragAnswer}`;
      }
    }

    // تحليل المشاعر (اختياري للتسجيل)
    const sentiment = analyzeSentiment(message);
    console.log(`[SENTIMENT] ${sessionId}: ${sentiment}`);

    // دفق الردود إذا طلب المستخدم
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders(); // ضروري لـ Vercel

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      let finalContent = '';
      let finalReasoning = '';

      const onChunk = ({ type, content }) => {
        finalContent += content;
        res.write(`data: ${JSON.stringify({ type, content, done: false })}\n\n`);
        if (STREAM_CHUNK_DELAY) setTimeout(() => {}, STREAM_CHUNK_DELAY);
      };

      try {
        const { content, reasoning } = await callGlmApi({
          message,
          history,
          nonce,
          sessionId,
          model,
          temperature,
          top_p,
          max_tokens,
          presence_penalty,
          frequency_penalty,
          stream: true,
          onChunk,
          signal: abortController.signal,
        });
        finalContent = content;
        finalReasoning = reasoning;
      } catch (err) {
        if (err.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ type: 'error', content: 'Stream aborted by user', done: true })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', content: err.message, done: true })}\n\n`);
        }
        return res.end();
      }

      // حفظ الرد في الجلسة
      await sessionManager.addMessage(sessionId, 'user', message, null, { sentiment, model, image: !!imageBase64 });
      await sessionManager.addMessage(sessionId, 'assistant', finalContent, finalReasoning, { model });

      // توليد عنوان إذا كان جديدًا
      if (history.length === 0) await generateTitle(sessionManager, sessionId, message);

      // إرسال إشارة النهاية
      res.write(`data: ${JSON.stringify({ type: 'done', thinking: finalReasoning, content: finalContent, done: true })}\n\n`);
      return res.end();
    }

    // وضع عدم الدفق (JSON عادي)
    const { content, reasoning } = await callGlmApi({
      message,
      history,
      nonce,
      sessionId,
      model,
      temperature,
      top_p,
      max_tokens,
      presence_penalty,
      frequency_penalty,
      stream: false,
    });

    // حفظ الرد
    await sessionManager.addMessage(sessionId, 'user', message, null, { sentiment, model, image: !!imageBase64 });
    await sessionManager.addMessage(sessionId, 'assistant', content, reasoning, { model });

    // توليد عنوان للمحادثة الجديدة
    let title = null;
    if (history.length === 0) title = await generateTitle(sessionManager, sessionId, message);

    // ترجمة الرد إذا طلب المستخدم
    let translatedContent = null;
    if (translateTo && translateTo !== 'ar') {
      translatedContent = await translateText(content, translateTo);
    }

    // تقدير التكلفة (وهمي)
    const inputTokens = Math.ceil(message.length / 4);
    const outputTokens = Math.ceil(content.length / 4);
    const cost = estimateCost(model, inputTokens, outputTokens);

    const responsePayload = {
      thinking: reasoning,
      content: translatedContent || content,
      session_id: sessionId,
      title,
      sentiment,
      model_used: model,
      estimated_cost_usd: cost,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error('Fatal error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message,
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
}
