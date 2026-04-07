// pages/api/chat.js أو api/chat.js
import { createHash } from 'crypto';

// ======================== الإعدادات الجديدة ========================
const EMAIL_API_BASE = 'http://fi11.bot-hosting.net:20971';  // API البريد الجديد
const HTMLPUB_BASE = 'https://htmlpub.com';
const MAX_ATTEMPTS = 30;               // عدد محاولات فحص البريد
const POLL_INTERVAL = 3000;            // 3 ثوانٍ بين كل فحص
const PING_INTERVAL = 4000;            // 4 ثوانٍ بين كل نبضة
const FALLBACK_CSRF = '0ce3ae7fbc30f663e116f935f2d7dafc94177c70dcc4f7def2089816f69bcabb';

// ======================== دوال مساعدة ========================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sendSSE = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// جلب CSRF token
async function fetchCsrfToken() {
  try {
    const res = await fetch(`${HTMLPUB_BASE}/api/auth/csrf`);
    if (res.ok) {
      const data = await res.json();
      return data.csrfToken;
    }
  } catch (e) {
    console.error('CSRF fetch error:', e);
  }
  return FALLBACK_CSRF;
}

// إنشاء بريد مؤقت باستخدام API الجديد
async function createTempEmail() {
  const res = await fetch(`${EMAIL_API_BASE}/newemail`);
  const data = await res.json();
  if (!data.success || !data.email) {
    throw new Error('Failed to create email: ' + (data.message || 'Unknown error'));
  }
  return data.email;
}

// فحص البريد مع ping
async function pollForMagicLink(email, res, signal) {
  let attempts = 0;
  let lastPing = Date.now();

  while (attempts < MAX_ATTEMPTS) {
    if (signal.aborted) throw new Error('Client aborted');

    const now = Date.now();
    if (now - lastPing >= PING_INTERVAL) {
      sendSSE(res, 'ping', {
        attempts: attempts + 1,
        max: MAX_ATTEMPTS,
        message: 'Waiting for email...'
      });
      lastPing = now;
    }

    try {
      const fetchRes = await fetch(`${EMAIL_API_BASE}/getmessage/${email}`, { signal });
      if (fetchRes.ok) {
        const data = await fetchRes.json();
        if (data.success && data.messages && data.messages.length > 0) {
          for (const msg of data.messages) {
            const content = msg.content || '';
            // البحث عن رابط التحقق في محتوى الرسالة
            const match = content.match(/(https:\/\/htmlpub\.com\/api\/auth\/callback\/[^\s"'\n]+)/);
            if (match) return match[0];
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    attempts++;
    const waitStart = Date.now();
    while (Date.now() - waitStart < POLL_INTERVAL) {
      if (signal.aborted) throw new Error('Client aborted');
      await delay(500);
    }
  }

  return null;
}

// ======================== معالج API ========================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required and must be a string' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    // 1. بريد مؤقت
    sendSSE(res, 'status', { step: 'email', message: 'Creating temporary email...' });
    const email = await createTempEmail();
    sendSSE(res, 'status', { step: 'email', email, message: `Email created: ${email}` });

    // 2. CSRF
    sendSSE(res, 'status', { step: 'csrf', message: 'Fetching CSRF token...' });
    const csrfToken = await fetchCsrfToken();

    // 3. إرسال رابط الدخول
    sendSSE(res, 'status', { step: 'login', message: 'Sending magic link...' });
    const loginPayload = new URLSearchParams({
      email,
      csrfToken,
      callbackUrl: '/edit',
      json: 'true'
    });

    const loginRes = await fetch(`${HTMLPUB_BASE}/api/auth/signin/nodemailer`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': HTMLPUB_BASE,
        'Referer': `${HTMLPUB_BASE}/auth/signin`,
        'x-auth-return-redirect': '1'
      },
      body: loginPayload.toString(),
      signal: abortController.signal
    });

    if (!loginRes.ok) throw new Error(`Failed to send magic link (${loginRes.status})`);
    sendSSE(res, 'status', { step: 'login', message: 'Magic link sent. Waiting for email...' });

    // 4. استطلاع البريد
    const magicLink = await pollForMagicLink(email, res, abortController.signal);
    if (!magicLink) throw new Error('Magic link not found after maximum attempts');
    sendSSE(res, 'status', { step: 'verify', message: 'Magic link found, verifying...' });

    // 5. التحقق وجلب الكوكيز
    const verifyRes = await fetch(magicLink, {
      redirect: 'manual',
      signal: abortController.signal
    });

    const cookies = verifyRes.headers.get('set-cookie');
    if (!cookies) throw new Error('No session cookie received');
    const cookieHeader = cookies.split(',').map(c => c.split(';')[0]).join('; ');

    sendSSE(res, 'status', { step: 'ai', message: 'Logged in. Starting AI generation...' });

    // 6. إنشاء محادثة
    const convRes = await fetch(`${HTMLPUB_BASE}/api/ai/conversations`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      signal: abortController.signal
    });
    if (!convRes.ok) throw new Error('Failed to create AI conversation');
    const convData = await convRes.json();
    const conversationId = convData.id;

    // 7. إرسال prompt
    const aiRes = await fetch(`${HTMLPUB_BASE}/api/ai/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: prompt,
        deviceInfo: { type: 'tablet', screenWidth: 980, screenHeight: 1832, touch: true }
      }),
      signal: abortController.signal
    });

    if (!aiRes.ok) throw new Error(`AI request failed (${aiRes.status})`);

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let pageInfo = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            if (data.type === 'text_delta' && data.text) {
              fullText += data.text;
              sendSSE(res, 'text', { content: data.text });
            }
            if (data.type === 'tool_result' && data.name === 'create_page') {
              pageInfo = JSON.parse(data.result);
            }
          } catch (e) {}
        }
      }
    }

    // 8. جلب HTML الصفحة
    let savedFile = null;
    if (pageInfo?.slug) {
      try {
        const sourceRes = await fetch(`${HTMLPUB_BASE}/api/pages/${pageInfo.slug}/source`, {
          headers: { 'Cookie': cookieHeader },
          signal: abortController.signal
        });
        if (sourceRes.ok) {
          const sourceData = await sourceRes.json();
          savedFile = {
            title: sourceData.title || pageInfo.title,
            html: sourceData.html,
            url: pageInfo.url
          };
        }
      } catch (e) {}
    }

    sendSSE(res, 'done', {
      success: true,
      pageUrl: pageInfo?.url,
      pageTitle: pageInfo?.title,
      savedFile: savedFile ? {
        title: savedFile.title,
        url: savedFile.url,
        htmlPreview: savedFile.html?.substring(0, 200) + '...'
      } : null
    });

  } catch (error) {
    console.error('API Error:', error);
    sendSSE(res, 'error', { message: error.message });
  } finally {
    res.end();
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
    responseLimit: false,
    externalResolver: true
  }
};
