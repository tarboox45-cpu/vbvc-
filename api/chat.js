// api/chat.js – GLM-5 Professional API with Full Site Features
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// ============================
// 1. الإعدادات العامة والتخزين
// ============================

// تخزين الـ nonce (مؤقت)
let cachedNonce = null;
let nonceTimestamp = 0;
const NONCE_TTL = 60 * 60 * 1000; // 1 hour

// مسار تخزين الجلسات (في Vercel /tmp يعمل عبر الطلبات لكنه مؤقت)
const SESSIONS_DIR = '/tmp/glm_sessions';
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');

// قوالب الاقتراحات (مستخلصة من موقع GLM)
const SUGGESTIONS = [
  { title: "Explain quantum computing in simple terms", prompt: "Explain quantum computing in simple terms" },
  { title: "Write a Python function to sort a list using quicksort", prompt: "Write a Python function to sort a list using quicksort" },
  { title: "What are the latest trends in AI for 2026?", prompt: "What are the latest trends in AI for 2026?" },
  { title: "Help me write a professional email to my manager about a project delay", prompt: "Help me write a professional email to my manager about a project delay" }
];

// ============================
// 2. دوال مساعدة للتخزين (قراءة/كتابة الجلسات)
// ============================

async function ensureSessionsDir() {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
  } catch (e) {}
}

async function loadSessions() {
  await ensureSessionsDir();
  try {
    const data = await readFile(SESSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return {}; // sessions object: { sessionId: { name, messages, createdAt, updatedAt } }
  }
}

async function saveSessions(sessions) {
  await ensureSessionsDir();
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// إضافة أو تحديث جلسة
async function updateSession(sessionId, messages, name = null) {
  const sessions = await loadSessions();
  const now = Date.now();
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      id: sessionId,
      name: name || `Chat ${Object.keys(sessions).length + 1}`,
      messages: [],
      createdAt: now,
      updatedAt: now
    };
  }
  if (messages) sessions[sessionId].messages = messages;
  if (name) sessions[sessionId].name = name;
  sessions[sessionId].updatedAt = now;
  await saveSessions(sessions);
  return sessions[sessionId];
}

// الحصول على جلسة
async function getSession(sessionId) {
  const sessions = await loadSessions();
  return sessions[sessionId] || null;
}

// حذف جلسة
async function deleteSession(sessionId) {
  const sessions = await loadSessions();
  if (sessions[sessionId]) {
    delete sessions[sessionId];
    await saveSessions(sessions);
    return true;
  }
  return false;
}

// ============================
// 3. دوال الاتصال بـ GLM-5 (nonce, chat)
// ============================

async function fetchNonce() {
  const response = await fetch('https://glm-ai.chat/chat/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch chat page: ${response.status}`);
  const html = await response.text();
  let match = html.match(/["']nonce["']:\s*["']([^"']+)["']/);
  if (!match) match = html.match(/var\s+nonce\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error('Nonce not found');
  return match[1];
}

async function getNonce() {
  const now = Date.now();
  if (cachedNonce && (now - nonceTimestamp) < NONCE_TTL) return cachedNonce;
  cachedNonce = await fetchNonce();
  nonceTimestamp = now;
  return cachedNonce;
}

// إرسال رسالة إلى GLM-5 مع دعم التدفق أو بدونه
async function sendToGLM(message, sessionId, agentMode = true, stream = false) {
  // تحميل تاريخ الجلسة الحالي
  let session = await getSession(sessionId);
  let conversationHistory = session?.messages || [];
  
  // إضافة رسالة المستخدم الحالية
  const newHistory = [...conversationHistory, { role: 'user', content: message }];
  
  // تحديث الجلسة بالتاريخ المؤقت (سيتم تحديث الرد لاحقاً)
  await updateSession(sessionId, newHistory);
  
  const historyForAPI = newHistory.slice(-20); // آخر 20 رسالة
  const historyJson = JSON.stringify(historyForAPI);
  const nonce = await getNonce();
  
  const formData = new URLSearchParams();
  formData.append('action', 'glm_chat_stream');
  formData.append('nonce', nonce);
  formData.append('message', message);
  formData.append('history', historyJson);
  formData.append('agent_mode', agentMode ? '1' : '0');
  
  const response = await fetch('https://glm-ai.chat/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `glm_session_id=guest_${sessionId}`,
      'Origin': 'https://glm-ai.chat',
      'Referer': 'https://glm-ai.chat/chat/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: formData.toString()
  });
  
  if (!response.ok) throw new Error(`GLM API error: ${response.status}`);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  
  if (stream) {
    // إرجاع ReadableStream للتجهيز المباشر
    return new ReadableStream({
      async start(controller) {
        let fullContent = '';
        let thinking = '';
        const encoder = new TextEncoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const jsonData = line.slice(5).trim();
              if (jsonData === '[DONE]') {
                // حفظ الرد الكامل في الجلسة
                const updatedHistory = [...newHistory, { role: 'assistant', content: fullContent, thinking }];
                await updateSession(sessionId, updatedHistory);
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                controller.close();
                return;
              }
              try {
                const parsed = JSON.parse(jsonData);
                const delta = parsed?.choices?.[0]?.delta;
                if (delta) {
                  if (delta.reasoning_content) {
                    thinking += delta.reasoning_content;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking', content: delta.reasoning_content })}\n\n`));
                  }
                  if (delta.content) {
                    fullContent += delta.content;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'content', content: delta.content })}\n\n`));
                  }
                }
              } catch (e) {}
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    });
  } else {
    // تجميع الرد كاملاً
    let fullContent = '';
    let thinking = '';
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const jsonData = line.slice(5).trim();
        if (jsonData === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonData);
          const delta = parsed?.choices?.[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) thinking += delta.reasoning_content;
            if (delta.content) fullContent += delta.content;
          }
        } catch (e) {}
      }
    }
    const updatedHistory = [...newHistory, { role: 'assistant', content: fullContent, thinking }];
    await updateSession(sessionId, updatedHistory);
    return { content: fullContent, thinking };
  }
}

// ============================
// 4. دوال WordPress REST API (proxy)
// ============================

async function proxyWordPress(endpoint, params = {}) {
  const url = new URL(endpoint, 'https://glm-ai.chat');
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'GLM-API-Proxy/1.0' }
  });
  if (!res.ok) throw new Error(`WordPress API error: ${res.status}`);
  return res.json();
}

// ============================
// 5. معالج الطلبات الرئيسي (Vercel Handler)
// ============================

export default async function handler(req, res) {
  // إعدادات CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { method, url } = req;
  const path = url.split('?')[0]; // المسار بدون query
  
  try {
    // ------------------- مسار الدردشة الرئيسي -------------------
    if (path === '/api/chat' && method === 'POST') {
      const { message, session_id, agent_mode = true, stream = false } = req.body;
      if (!message) return res.status(400).json({ error: 'message is required' });
      const sessionId = session_id || `session_${Date.now()}`;
      
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const streamResponse = await sendToGLM(message, sessionId, agent_mode, true);
        const reader = streamResponse.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          res.end();
        }
      } else {
        const result = await sendToGLM(message, sessionId, agent_mode, false);
        res.status(200).json({
          success: true,
          content: result.content,
          thinking: result.thinking,
          session_id: sessionId
        });
      }
    }
    
    // ------------------- إدارة الجلسات (المحادثات) -------------------
    else if (path === '/api/conversations' && method === 'GET') {
      const sessions = await loadSessions();
      const list = Object.values(sessions).map(s => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      }));
      res.status(200).json(list);
    }
    else if (path === '/api/conversations' && method === 'POST') {
      const { name } = req.body;
      const newId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      await updateSession(newId, [], name || 'New Chat');
      res.status(201).json({ id: newId, name: name || 'New Chat' });
    }
    else if (path.startsWith('/api/conversations/') && method === 'DELETE') {
      const id = path.split('/')[3];
      const deleted = await deleteSession(id);
      if (!deleted) return res.status(404).json({ error: 'Session not found' });
      res.status(200).json({ success: true });
    }
    else if (path.startsWith('/api/conversations/') && method === 'PUT') {
      const id = path.split('/')[3];
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const session = await getSession(id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      await updateSession(id, session.messages, name);
      res.status(200).json({ success: true });
    }
    else if (path.startsWith('/api/conversations/') && path.endsWith('/messages') && method === 'GET') {
      const id = path.split('/')[3];
      const session = await getSession(id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.status(200).json(session.messages);
    }
    
    // ------------------- الاقتراحات -------------------
    else if (path === '/api/suggestions' && method === 'GET') {
      res.status(200).json(SUGGESTIONS);
    }
    
    // ------------------- معلومات النموذج -------------------
    else if (path === '/api/models' && method === 'GET') {
      // يمكن استخراج النماذج المتاحة من ووردبريس أو إرجاع افتراضي
      res.status(200).json([
        { id: 'glm-5', name: 'GLM-5', description: 'Latest GLM model' }
      ]);
    }
    
    // ------------------- واجهات WordPress REST API (وكيل) -------------------
    else if (path === '/api/wp-page' && method === 'GET') {
      const data = await proxyWordPress('/wp-json/wp/v2/pages/11');
      res.status(200).json(data);
    }
    else if (path === '/api/wp-oembed' && method === 'GET') {
      const { url, format = 'json' } = req.query;
      if (!url) return res.status(400).json({ error: 'url parameter required' });
      const data = await proxyWordPress('/wp-json/oembed/1.0/embed', { url, format });
      res.status(200).json(data);
    }
    
    // ------------------- نموذج الاتصال (Contact Form 7) -------------------
    else if (path === '/api/contact' && method === 'POST') {
      const { name, email, message } = req.body;
      if (!name || !email || !message) {
        return res.status(400).json({ error: 'name, email, message are required' });
      }
      // إرسال إلى WordPress Contact Form 7 (محاكاة)
      const formData = new URLSearchParams();
      formData.append('your-name', name);
      formData.append('your-email', email);
      formData.append('your-message', message);
      const response = await fetch('https://glm-ai.chat/wp-json/contact-form-7/v1/contact-forms/1/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData
      });
      const result = await response.json();
      res.status(response.ok ? 200 : 500).json(result);
    }
    
    // ------------------- الحصول على nonce جديد (للتصحيح) -------------------
    else if (path === '/api/refresh-nonce' && method === 'GET') {
      const newNonce = await fetchNonce();
      cachedNonce = newNonce;
      nonceTimestamp = Date.now();
      res.status(200).json({ nonce: newNonce });
    }
    
    else {
      res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

// تكوين Vercel (زيادة المهلة)
export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
    externalResolver: true
  }
};
