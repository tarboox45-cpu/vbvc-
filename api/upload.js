// api/upload.js - Image Upload Handler
import { randomBytes } from 'crypto';

const imageStore = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { image, sessionId } = req.body;
  
  if (!image) {
    return res.status(400).json({ error: 'Image data is required' });
  }
  
  const imageId = randomBytes(16).toString('hex');
  imageStore.set(imageId, {
    data: image,
    sessionId,
    timestamp: Date.now()
  });
  
  // Clean old images (older than 1 hour)
  const now = Date.now();
  for (const [key, value] of imageStore.entries()) {
    if (now - value.timestamp > 3600000) {
      imageStore.delete(key);
    }
  }
  
  res.status(200).json({
    success: true,
    imageId: imageId,
    url: `/api/image/${imageId}`
  });
}
