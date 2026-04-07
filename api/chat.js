// pages/api/htmlpub.js أو api/htmlpub.js
import { createHash } from 'crypto';

// تكوين مؤقت
const EMAIL_API = 'https://api.internal.temp-mail.io/api/v3/email';
const HTMLPUB_BASE = 'https://htmlpub.com';
const MAX_ATTEMPTS = 30;
const POLL_INTERVAL = 3000; // 3 ثواني

// دالة مساعدة للتأخير
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// دالة لجلب CSRF token
async function fetchCsrfToken() {
  try {
    const res = await fetch(`${HTMLPUB_BASE}/api/auth/csrf`);
    if (res.ok) {
      const data = await res.json();
      return data.csrfToken;
    }
  } catch (e) {}
  // fallback token من الكود الأصلي
  return '0ce3ae7fbc30f663e116f935f2d7dafc94177c70dcc4f7def2089816f69bcabb';
}

// دالة لإنشاء بريد مؤقت
async function createTempEmail() {
  const res = await fetch(`${EMAIL_API}/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ min_name_length: 10, max_name_length: 10 })
  });
  const data = await res.json();
  return data.email;
}

// دالة لاستطلاع البريد الإلكتروني للحصول على رابط التحقق
async function pollForMagicLink(email, signal) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    try {
      const res = await fetch(`${EMAIL_API}/${email}/messages`, { signal });
      if (res.ok) {
        const messages = await res.json();
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const body = (msg.body_text || '') + (msg.body_html || '');
            const match = body.match(/(https:\/\/htmlpub\.com\/api\/auth\/callback\/[^\s"']+)/);
            if (match) return match[0];
          }
        }
      }
    } catch (e) {}
    await delay(POLL_INTERVAL);
  }
  return null;
}

export default async function handler(req, res) {
  // السماح بـ CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // إعداد SSE للرد
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // إنشاء AbortController للتحكم في الطلبات إذا انقطع الاتصال
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    // 1. إنشاء بريد مؤقت
    sendEvent('status', { step: 'email', message: 'Creating temporary email...' });
    const email = await createTempEmail();
    sendEvent('status', { step: 'email', email, message: `Email created: ${email}` });

    // 2. جلب CSRF token
    sendEvent('status', { step: 'csrf', message: 'Fetching CSRF token...' });
    const csrfToken = await fetchCsrfToken();

    // 3. إرسال رابط تسجيل الدخول
    sendEvent('status', { step: 'login', message: 'Sending magic link...' });
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

    if (!loginRes.ok) {
      throw new Error(`Login request failed: ${loginRes.status}`);
    }
    sendEvent('status', { step: 'login', message: 'Magic link sent. Waiting for email...' });

    // 4. استطلاع البريد للحصول على الرابط
    const magicLink = await pollForMagicLink(email, abortController.signal);
    if (!magicLink) {
      throw new Error('Magic link not found after multiple attempts');
    }
    sendEvent('status', { step: 'verify', message: 'Magic link found, verifying...' });

    // 5. زيارة الرابط السحري لاستلام الكوكيز
    const verifyRes = await fetch(magicLink, {
      redirect: 'manual', // نتعامل يدويًا مع إعادة التوجيه
      signal: abortController.signal
    });

    // استخراج الكوكيز من الـ response headers
    const cookies = verifyRes.headers.get('set-cookie');
    if (!cookies) {
      throw new Error('No session cookie received');
    }
    // تجهيز الكوكيز للاستخدام في الطلبات القادمة
    const cookieHeader = cookies.split(',').map(c => c.split(';')[0]).join('; ');

    sendEvent('status', { step: 'ai', message: 'Logged in. Starting AI generation...' });

    // 6. إنشاء محادثة AI
    const convRes = await fetch(`${HTMLPUB_BASE}/api/ai/conversations`, {
      method: 'POST',
      headers: {
        'Cookie': cookieHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      signal: abortController.signal
    });
    if (!convRes.ok) {
      throw new Error('Failed to create conversation');
    }
    const convData = await convRes.json();
    const conversationId = convData.id;

    // 7. إرسال الـ prompt واستقبال الرد المتدفق
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

    if (!aiRes.ok) {
      throw new Error(`AI request failed: ${aiRes.status}`);
    }

    // معالجة التدفق
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
            // إرسال النص المتدفق إلى العميل
            if (data.type === 'text_delta') {
              fullText += data.text || '';
              sendEvent('text', { content: data.text });
            }
            // البحث عن معلومات الصفحة
            if (data.type === 'tool_result' && data.name === 'create_page') {
              pageInfo = JSON.parse(data.result);
            }
          } catch (e) {}
        }
      }
    }

    // 8. إذا وُجدت صفحة، جلب HTML وحفظه (اختياري)
    let savedFile = null;
    if (pageInfo && pageInfo.slug) {
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
    }

    sendEvent('done', {
      success: true,
      pageUrl: pageInfo?.url,
      pageTitle: pageInfo?.title,
      savedFile
    });

  } catch (error) {
    sendEvent('error', { message: error.message });
  } finally {
    res.end();
  }
}
