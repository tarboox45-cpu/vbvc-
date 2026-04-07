// api/chat.js - GLM-5 Professional Chat API with Image Support
import { createHash } from 'crypto';

// Cache management
let cachedNonce = null;
let nonceTimestamp = 0;
const NONCE_TTL = 60 * 60 * 1000;

// Session storage (in-memory with persistence)
const sessions = new Map();

// Image storage (base64 or URL)
const imageStorage = new Map();

// Helper: Get nonce from GLM site
async function fetchNonce() {
  const response = await fetch('https://glm-ai.chat/chat/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
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

// Process image uploads
export async function processImage(imageBase64, sessionId) {
  const imageId = createHash('md5').update(imageBase64 + Date.now()).digest('hex');
  imageStorage.set(imageId, {
    data: imageBase64,
    sessionId,
    timestamp: Date.now()
  });
  return imageId;
}

// Send message to GLM with image context
async function sendToGLM(message, sessionId, images = [], agentMode = true, stream = false) {
  let conversationHistory = sessions.get(sessionId) || [];
  
  // Add user message with images
  const userMessage = {
    role: 'user',
    content: message,
    images: images,
    timestamp: Date.now()
  };
  
  const newHistory = [...conversationHistory, userMessage];
  sessions.set(sessionId, newHistory);
  
  // Prepare history for API
  const historyForAPI = newHistory.slice(-20).map(msg => ({
    role: msg.role,
    content: msg.role === 'user' && msg.images?.length ? 
      `${msg.content}\n[User attached ${msg.images.length} image(s)]` : msg.content
  }));
  
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
                const assistantMessage = {
                  role: 'assistant',
                  content: fullContent,
                  thinking: thinking,
                  timestamp: Date.now()
                };
                const updatedHistory = [...newHistory, assistantMessage];
                sessions.set(sessionId, updatedHistory);
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
                    
                    // Check if content contains website generation request
                    if (agentMode && (fullContent.includes('create a website') || fullContent.includes('build a site'))) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'site_generation', detected: true })}\n\n`));
                    }
                    
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
    
    const assistantMessage = {
      role: 'assistant',
      content: fullContent,
      thinking: thinking,
      timestamp: Date.now()
    };
    const updatedHistory = [...newHistory, assistantMessage];
    sessions.set(sessionId, updatedHistory);
    
    return { content: fullContent, thinking };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { message, session_id, agent_mode = true, stream = false, images = [] } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  
  const sessionId = session_id || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      const streamResponse = await sendToGLM(message, sessionId, images, agent_mode, true);
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
      const result = await sendToGLM(message, sessionId, images, agent_mode, false);
      res.status(200).json({
        success: true,
        content: result.content,
        thinking: result.thinking,
        session_id: sessionId
      });
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Failed to get response', details: error.message });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};
