import express from 'express';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// تخزين الجلسات
const SESSIONS_DIR = '/tmp/htmlpub_sessions';
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');
let sessionsCache = {};

// إعدادات API
const API_CONFIG = {
  tempMail: 'https://api.internal.temp-mail.io/api/v3',
  htmlpub: 'https://htmlpub.com',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
};

// دوال مساعدة للتخزين
async function ensureSessionsDir() {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
  } catch (e) {}
}

async function loadSessions() {
  await ensureSessionsDir();
  try {
    const fs = await import('fs/promises');
    const data = await fs.readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

async function saveSessions(sessions) {
  await ensureSessionsDir();
  const fs = await import('fs/promises');
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// إنشاء بريد إلكتروني مؤقت
async function createTempEmail() {
  const response = await axios.post(
    `${API_CONFIG.tempMail}/email/new`,
    { min_name_length: 10, max_name_length: 10 }
  );
  return response.data.email;
}

// الحصول على CSRF Token
async function getCSRFToken(session) {
  try {
    const response = await session.get(`${API_CONFIG.htmlpub}/api/auth/csrf`);
    if (response.status === 200) {
      return response.data.csrfToken;
    }
  } catch (e) {}
  return "0ce3ae7fbc30f663e116f935f2d7dafc94177c70dcc4f7def2089816f69bcabb";
}

// إرسال رابط تسجيل الدخول
async function sendMagicLink(session, email, csrfToken) {
  const payload = {
    email: email,
    csrfToken: csrfToken,
    callbackUrl: "/edit",
    json: 'true'
  };
  
  const headers = {
    'User-Agent': API_CONFIG.userAgent,
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': API_CONFIG.htmlpub,
    'Referer': `${API_CONFIG.htmlpub}/auth/signin`,
    'x-auth-return-redirect': '1'
  };
  
  const response = await session.post(
    `${API_CONFIG.htmlpub}/api/auth/signin/nodemailer`,
    new URLSearchParams(payload).toString(),
    { headers, maxRedirects: 0, validateStatus: status => status < 400 }
  );
  
  return response;
}

// انتظار وصول البريد
async function waitForMagicLink(email, maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(
        `${API_CONFIG.tempMail}/email/${email}/messages`,
        { timeout: 5000 }
      );
      
      if (response.status === 200 && response.data.length > 0) {
        for (const msg of response.data) {
          const body = (msg.body_text || '') + (msg.body_html || '');
          const linkPattern = /(https:\/\/htmlpub\.com\/api\/auth\/callback\/[^\s"']+)/;
          const match = body.match(linkPattern);
          if (match) return match[0];
        }
      }
    } catch (e) {}
    
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return null;
}

// إنشاء محادثة AI
async function createAIConversation(session) {
  const response = await session.post(
    `${API_CONFIG.htmlpub}/api/ai/conversations`,
    {}
  );
  return response.data.id;
}

// إرسال رسالة إلى AI
async function sendAIMessage(session, conversationId, prompt, stream = false) {
  const response = await session.post(
    `${API_CONFIG.htmlpub}/api/ai/conversations/${conversationId}/messages`,
    {
      message: prompt,
      deviceInfo: {
        type: "tablet",
        screenWidth: 980,
        screenHeight: 1832,
        touch: true
      }
    },
    { responseType: stream ? 'stream' : 'json' }
  );
  
  return response;
}

// حفظ الصفحة المنشأة
async function saveGeneratedPage(session, pageSlug, pageTitle) {
  try {
    const response = await session.get(
      `${API_CONFIG.htmlpub}/api/pages/${pageSlug}/source`
    );
    
    if (response.status === 200) {
      const html = response.data.html;
      const filename = pageTitle
        .replace(/[^\w\s-]/g, '')
        .replace(/[-\s]+/g, '_') + `_${pageSlug}.html`;
      
      const pagesDir = join(process.cwd(), 'generated_pages');
      await mkdir(pagesDir, { recursive: true });
      await writeFile(join(pagesDir, filename), html, 'utf8');
      
      return { filename, html };
    }
  } catch (e) {}
  return null;
}

// ============= API Routes =============

// إنشاء جلسة جديدة
app.post('/api/session/create', async (req, res) => {
  try {
    const sessionId = `session_${Date.now()}_${randomBytes(8).toString('hex')}`;
    const session = axios.create({
      timeout: 30000,
      headers: { 'User-Agent': API_CONFIG.userAgent }
    });
    
    // إنشاء بريد إلكتروني
    const email = await createTempEmail();
    
    // الحصول على CSRF Token
    const csrfToken = await getCSRFToken(session);
    
    // إرسال رابط تسجيل الدخول
    await sendMagicLink(session, email, csrfToken);
    
    // حفظ الجلسة
    sessionsCache[sessionId] = {
      id: sessionId,
      email,
      session,
      csrfToken,
      createdAt: Date.now(),
      status: 'pending',
      conversations: []
    };
    
    await saveSessions(sessionsCache);
    
    res.status(201).json({
      session_id: sessionId,
      email,
      status: 'pending',
      message: 'Magic link sent. Call /api/session/verify to complete login.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// التحقق من البريد وإكمال تسجيل الدخول
app.post('/api/session/verify', async (req, res) => {
  try {
    const { session_id } = req.body;
    const sessionData = sessionsCache[session_id];
    
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    // انتظار رابط التسجيل
    const magicLink = await waitForMagicLink(sessionData.email);
    
    if (!magicLink) {
      return res.status(408).json({ error: 'Magic link timeout' });
    }
    
    // تنشيط الرابط
    await sessionData.session.get(magicLink);
    
    // استخراج التوكن
    let token = null;
    if (sessionData.session.defaults.jar) {
      const cookies = sessionData.session.defaults.jar.getCookies(API_CONFIG.htmlpub);
      for (const cookie of cookies) {
        if (cookie.key.includes('__Secure-authjs.session-token')) {
          token = cookie.value;
          break;
        }
      }
    }
    
    sessionData.status = 'active';
    sessionData.token = token;
    sessionData.verifiedAt = Date.now();
    
    await saveSessions(sessionsCache);
    
    res.json({
      success: true,
      session_id,
      status: 'active',
      token
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// إنشاء صفحة جديدة
app.post('/api/generate', async (req, res) => {
  try {
    const { session_id, prompt, stream = false } = req.body;
    
    if (!session_id || !prompt) {
      return res.status(400).json({ error: 'session_id and prompt required' });
    }
    
    const sessionData = sessionsCache[session_id];
    if (!sessionData || sessionData.status !== 'active') {
      return res.status(401).json({ error: 'Invalid or inactive session' });
    }
    
    // إنشاء محادثة
    const conversationId = await createAIConversation(sessionData.session);
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const response = await sendAIMessage(
        sessionData.session,
        conversationId,
        prompt,
        true
      );
      
      let fullContent = '';
      let pageInfo = null;
      
      response.data.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'text_delta') {
                fullContent += data.text;
                res.write(`data: ${JSON.stringify({ type: 'text', content: data.text })}\n\n`);
              } else if (data.type === 'tool_result' && data.name === 'create_page') {
                pageInfo = JSON.parse(data.result);
                res.write(`data: ${JSON.stringify({ type: 'page', info: pageInfo })}\n\n`);
              }
            } catch (e) {}
          }
        }
      });
      
      response.data.on('end', async () => {
        if (pageInfo) {
          const saved = await saveGeneratedPage(
            sessionData.session,
            pageInfo.slug,
            pageInfo.title
          );
          
          // حفظ في السجلات
          const logsDir = join(process.cwd(), 'logs');
          await mkdir(logsDir, { recursive: true });
          const fs = await import('fs/promises');
          await fs.appendFile(
            join(logsDir, 'pages.txt'),
            `${new Date().toISOString()} - ${prompt.substring(0, 50)}... - ${pageInfo.url}\n`
          );
          
          res.write(`data: ${JSON.stringify({ type: 'saved', file: saved?.filename })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
    } else {
      const response = await sendAIMessage(
        sessionData.session,
        conversationId,
        prompt,
        false
      );
      
      // استخراج معلومات الصفحة
      let pageInfo = null;
      let fullContent = '';
      
      if (typeof response.data === 'object') {
        // معالجة البيانات حسب الحاجة
        fullContent = response.data;
      }
      
      // حفظ الصفحة
      let savedFile = null;
      if (pageInfo) {
        savedFile = await saveGeneratedPage(
          sessionData.session,
          pageInfo.slug,
          pageInfo.title
        );
      }
      
      res.json({
        success: true,
        conversation_id: conversationId,
        content: fullContent,
        page: pageInfo,
        saved_file: savedFile?.filename
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// إنشاء صفحة بسرعة (عملية كاملة)
app.post('/api/quick-generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }
    
    // إنشاء جلسة مؤقتة
    const session = axios.create({
      timeout: 30000,
      headers: { 'User-Agent': API_CONFIG.userAgent }
    });
    
    const email = await createTempEmail();
    const csrfToken = await getCSRFToken(session);
    await sendMagicLink(session, email, csrfToken);
    
    const magicLink = await waitForMagicLink(email, 20);
    if (!magicLink) {
      return res.status(408).json({ error: 'Login timeout' });
    }
    
    await session.get(magicLink);
    
    // إنشاء المحتوى
    const conversationId = await createAIConversation(session);
    const response = await sendAIMessage(session, conversationId, prompt, false);
    
    res.json({
      success: true,
      email_used: email,
      conversation_id: conversationId,
      response: response.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// حذف جلسة
app.delete('/api/session/:id', async (req, res) => {
  const { id } = req.params;
  
  if (sessionsCache[id]) {
    delete sessionsCache[id];
    await saveSessions(sessionsCache);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// الحصول على قائمة الجلسات
app.get('/api/sessions', async (req, res) => {
  const list = Object.values(sessionsCache).map(s => ({
    id: s.id,
    email: s.email,
    status: s.status,
    createdAt: s.createdAt,
    conversations: s.conversations?.length || 0
  }));
  res.json(list);
});

// معلومات API
app.get('/api/info', (req, res) => {
  res.json({
    name: 'HTMLPub AI API',
    version: '1.0.0',
    endpoints: [
      'POST /api/session/create - Create new session',
      'POST /api/session/verify - Verify email and complete login',
      'POST /api/generate - Generate HTML page',
      'POST /api/quick-generate - Quick one-shot generation',
      'GET /api/sessions - List all sessions',
      'DELETE /api/session/:id - Delete session'
    ]
  });
});

// بدء الخادم
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  sessionsCache = await loadSessions();
  console.log(`🚀 HTMLPub AI API running on port ${PORT}`);
  console.log(`📡 Endpoints:`);
  console.log(`   POST /api/session/create`);
  console.log(`   POST /api/generate`);
  console.log(`   POST /api/quick-generate`);
});

export default app;
