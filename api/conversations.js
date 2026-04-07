// api/conversations.js - Conversation Management
const conversations = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { method } = req;
  const { id } = req.query;
  
  if (method === 'GET') {
    if (id) {
      const conv = conversations.get(id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      return res.status(200).json(conv);
    }
    
    const allConvs = Array.from(conversations.entries()).map(([id, data]) => ({
      id,
      name: data.name,
      messageCount: data.messages.length,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    }));
    return res.status(200).json(allConvs);
  }
  
  if (method === 'POST') {
    const { name } = req.body;
    const id = Date.now().toString();
    conversations.set(id, {
      id,
      name: name || 'New Conversation',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    return res.status(201).json({ id, name: name || 'New Conversation' });
  }
  
  if (method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'ID required' });
    const deleted = conversations.delete(id);
    if (!deleted) return res.status(404).json({ error: 'Conversation not found' });
    return res.status(200).json({ success: true });
  }
  
  if (method === 'PUT') {
    if (!id) return res.status(400).json({ error: 'ID required' });
    const conv = conversations.get(id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    
    const { name } = req.body;
    if (name) conv.name = name;
    conv.updatedAt = Date.now();
    conversations.set(id, conv);
    return res.status(200).json(conv);
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}
