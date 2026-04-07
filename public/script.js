// public/script.js - Advanced Chat Logic
class GLM5Chat {
    constructor() {
        this.currentSessionId = null;
        this.isStreaming = false;
        this.abortController = null;
        this.images = [];
        this.agentMode = true;
        this.isDarkMode = true;
        
        this.init();
    }
    
    init() {
        this.loadPreferences();
        this.loadConversations();
        this.setupEventListeners();
        this.loadSuggestions();
        this.setupTheme();
        
        // Create new session if none exists
        if (!this.currentSessionId) {
            this.createNewConversation();
        }
    }
    
    loadPreferences() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            this.isDarkMode = false;
            document.documentElement.setAttribute('data-theme', 'light');
        }
        
        const savedAgentMode = localStorage.getItem('agentMode');
        if (savedAgentMode !== null) {
            this.agentMode = savedAgentMode === 'true';
            document.getElementById('agentToggle').checked = this.agentMode;
        }
    }
    
    setupTheme() {
        const themeToggle = document.getElementById('themeToggle');
        themeToggle.addEventListener('click', () => {
            this.isDarkMode = !this.isDarkMode;
            document.documentElement.setAttribute('data-theme', this.isDarkMode ? 'dark' : 'light');
            localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
            this.showToast(`تم التبديل إلى الوضع ${this.isDarkMode ? 'الليلي' : 'النهاري'}`, 'success');
        });
    }
    
    async loadConversations() {
        try {
            const response = await fetch('/api/conversations');
            const conversations = await response.json();
            
            const container = document.getElementById('conversationsList');
            if (conversations.length === 0) {
                container.innerHTML = '<div class="empty-state">لا توجد محادثات بعد</div>';
                return;
            }
            
            container.innerHTML = conversations.map(conv => `
                <div class="conversation-item" data-id="${conv.id}">
                    <div class="conversation-name">${this.escapeHtml(conv.name)}</div>
                    <div class="conversation-date">${new Date(conv.updatedAt).toLocaleDateString('ar')}</div>
                </div>
            `).join('');
            
            // Add click handlers
            document.querySelectorAll('.conversation-item').forEach(item => {
                item.addEventListener('click', () => this.loadConversation(item.dataset.id));
            });
        } catch (error) {
            console.error('Failed to load conversations:', error);
        }
    }
    
    async loadConversation(sessionId) {
        this.currentSessionId = sessionId;
        await this.loadMessages(sessionId);
        this.showMessagesArea();
    }
    
    async loadMessages(sessionId) {
        try {
            const response = await fetch(`/api/conversations?id=${sessionId}`);
            const conversation = await response.json();
            
            const messagesArea = document.getElementById('messagesArea');
            messagesArea.innerHTML = conversation.messages.map(msg => this.renderMessage(msg)).join('');
            messagesArea.scrollTop = messagesArea.scrollHeight;
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }
    
    async createNewConversation() {
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'محادثة جديدة' })
            });
            const data = await response.json();
            this.currentSessionId = data.id;
            this.showWelcomeScreen();
            await this.loadConversations();
            this.showToast('تم إنشاء محادثة جديدة', 'success');
        } catch (error) {
            console.error('Failed to create conversation:', error);
        }
    }
    
    async loadSuggestions() {
        const suggestions = [
            { title: 'شرح الذكاء الاصطناعي', prompt: 'اشرح لي الذكاء الاصطناعي بشكل مبسط' },
            { title: 'كتابة دالة بايثون', prompt: 'اكتب دالة بايثون لفرز قائمة باستخدام quicksort' },
            { title: 'إنشاء موقع ويب', prompt: 'قم بإنشاء موقع ويب كامل لشركة تقنية مع تصميم عصري' },
            { title: 'نصائح للتسويق', prompt: 'قدم لي نصائح احترافية للتسويق الرقمي' },
            { title: 'تحليل بيانات', prompt: 'كيف يمكن تحليل البيانات باستخدام بايثون؟' },
            { title: 'تصميم UX/UI', prompt: 'ما هي أفضل ممارسات تصميم واجهات المستخدم؟' }
        ];
        
        const container = document.getElementById('suggestionsGrid');
        container.innerHTML = suggestions.map(suggestion => `
            <div class="suggestion-card" data-prompt="${this.escapeHtml(suggestion.prompt)}">
                <strong>${this.escapeHtml(suggestion.title)}</strong>
                <p style="font-size: 0.875rem; margin-top: 0.5rem; color: var(--text-secondary);">
                    ${this.escapeHtml(suggestion.prompt.substring(0, 60))}...
                </p>
            </div>
        `).join('');
        
        document.querySelectorAll('.suggestion-card').forEach(card => {
            card.addEventListener('click', () => {
                const prompt = card.dataset.prompt;
                document.getElementById('messageInput').value = prompt;
                this.sendMessage();
            });
        });
    }
    
    setupEventListeners() {
        // Send message
        document.getElementById('sendBtn').addEventListener('click', () => this.sendMessage());
        document.getElementById('messageInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        
        // Auto-resize textarea
        document.getElementById('messageInput').addEventListener('input', (e) => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
        });
        
        // New chat
        document.getElementById('newChatBtn').addEventListener('click', () => this.createNewConversation());
        
        // Menu toggle for mobile
        document.getElementById('menuToggle').addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('closed');
        });
        
        // Agent mode toggle
        document.getElementById('agentToggle').addEventListener('change', (e) => {
            this.agentMode = e.target.checked;
            localStorage.setItem('agentMode', this.agentMode);
            this.showToast(`تم ${this.agentMode ? 'تفعيل' : 'تعطيل'} وضع الوكيل`, 'success');
        });
        
        // Image upload
        document.getElementById('attachBtn').addEventListener('click', () => {
            document.getElementById('imageInput').click();
        });
        
        document.getElementById('imageInput').addEventListener('change', (e) => this.handleImageUpload(e));
        
        // Search conversations
        document.getElementById('searchConversations').addEventListener('input', (e) => {
            this.searchConversations(e.target.value);
        });
    }
    
    async handleImageUpload(event) {
        const files = Array.from(event.target.files);
        
        for (const file of files) {
            if (file.size > 5 * 1024 * 1024) {
                this.showToast('حجم الصورة يجب أن لا يتجاوز 5 ميجابايت', 'error');
                continue;
            }
            
            const reader = new FileReader();
            reader.onload = async (e) => {
                const imageData = e.target.result;
                this.images.push(imageData);
                this.addImagePreview(imageData);
            };
            reader.readAsDataURL(file);
        }
        
        event.target.value = '';
    }
    
    addImagePreview(imageData) {
        const previewArea = document.getElementById('imagePreviewArea');
        const previewId = Date.now();
        
        const preview = document.createElement('div');
        preview.className = 'image-preview';
        preview.innerHTML = `
            <img src="${imageData}" alt="Preview">
            <button class="image-preview-remove" data-id="${previewId}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>
        `;
        
        previewArea.appendChild(preview);
        
        preview.querySelector('.image-preview-remove').addEventListener('click', () => {
            const index = this.images.findIndex(img => img === imageData);
            if (index !== -1) this.images.splice(index, 1);
            preview.remove();
        });
    }
    
    async sendMessage() {
        const input = document.getElementById('messageInput');
        const message = input.value.trim();
        
        if (!message && this.images.length === 0) return;
        
        // Clear input and images
        input.value = '';
        input.style.height = 'auto';
        this.clearImagePreviews();
        
        // Show user message
        this.showWelcomeScreen(false);
        this.addMessage('user', message, this.images);
        
        // Prepare for streaming
        this.isStreaming = true;
        this.toggleSendStop(true);
        
        const messagesArea = document.getElementById('messagesArea');
        const assistantMessageId = this.addMessage('assistant', '', [], true);
        
        try {
            this.abortController = new AbortController();
            
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: message,
                    session_id: this.currentSessionId,
                    agent_mode: this.agentMode,
                    stream: true,
                    images: this.images
                }),
                signal: this.abortController.signal
            });
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let thinkingContent = '';
            let isGeneratingSite = false;
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    
                    if (data === '[DONE]') {
                        this.isStreaming = false;
                        this.toggleSendStop(false);
                        
                        // Check if site generation was requested
                        if (isGeneratingSite || fullContent.includes('إنشاء موقع') || fullContent.includes('create a website')) {
                            await this.generateWebsite(fullContent);
                        }
                        break;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        
                        if (parsed.type === 'thinking') {
                            thinkingContent += parsed.content;
                            this.updateMessage(assistantMessageId, thinkingContent, fullContent, true);
                        } else if (parsed.type === 'content') {
                            fullContent += parsed.content;
                            this.updateMessage(assistantMessageId, thinkingContent, fullContent, false);
                            
                            // Detect site generation request
                            if (fullContent.includes('سأقوم بإنشاء موقع') || fullContent.includes("I'll create a website")) {
                                isGeneratingSite = true;
                            }
                        } else if (parsed.type === 'site_generation') {
                            isGeneratingSite = true;
                        }
                    } catch (e) {}
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Streaming error:', error);
                this.showToast('حدث خطأ في الاتصال', 'error');
                this.updateMessage(assistantMessageId, '', 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.', false);
            }
        } finally {
            this.isStreaming = false;
            this.toggleSendStop(false);
            this.images = [];
        }
    }
    
    async generateWebsite(description) {
        this.showToast('جاري إنشاء الموقع...', 'success');
        
        try {
            const response = await fetch('/api/generate-site', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    description: description,
                    requirements: 'موقع احترافي متجاوب مع تصميم عصري'
                })
            });
            
            const result = await response.json();
            
            if (result.success) {
                const siteMessage = `
                    <div class="site-preview-card">
                        <strong>✅ تم إنشاء موقعك بنجاح!</strong>
                        <div style="margin-top: 0.5rem;">
                            <a href="${result.url}" target="_blank" class="site-preview-link">
                                🚀 عرض الموقع
                            </a>
                        </div>
                        <p style="margin-top: 0.5rem; font-size: 0.875rem;">
                            يمكنك مشاركة الرابط: ${result.url}
                        </p>
                    </div>
                `;
                
                this.addMessage('assistant', siteMessage, [], false, true);
                this.showToast('تم إنشاء الموقع بنجاح!', 'success');
            }
        } catch (error) {
            console.error('Site generation failed:', error);
            this.showToast('فشل إنشاء الموقع', 'error');
        }
    }
    
    addMessage(role, content, images = [], isLoading = false, isHtml = false) {
        const messagesArea = document.getElementById('messagesArea');
        const messageId = `msg_${Date.now()}_${Math.random()}`;
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        messageDiv.id = messageId;
        
        const avatarIcon = role === 'user' 
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
        
        let imagesHtml = '';
        if (images.length > 0) {
            imagesHtml = '<div class="message-images">' + 
                images.map(img => `<img src="${img}" style="max-width: 200px; border-radius: 0.5rem; margin: 0.5rem 0;">`).join('') +
                '</div>';
        }
        
        messageDiv.innerHTML = `
            <div class="message-avatar">${avatarIcon}</div>
            <div class="message-content">
                ${imagesHtml}
                <div class="message-text">${isHtml ? content : this.escapeHtml(content)}</div>
                ${isLoading ? '<div class="loading-dots"><span></span><span></span><span></span></div>' : ''}
            </div>
        `;
        
        messagesArea.appendChild(messageDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        
        return messageId;
    }
    
    updateMessage(messageId, thinking, content, isThinking) {
        const messageDiv = document.getElementById(messageId);
        if (!messageDiv) return;
        
        const contentDiv = messageDiv.querySelector('.message-text');
        
        if (isThinking && thinking) {
            contentDiv.innerHTML = `
                <div style="color: var(--text-secondary); font-style: italic;">
                    🤔 ${this.escapeHtml(thinking)}
                </div>
                ${content ? '<div style="margin-top: 0.5rem;">' + this.escapeHtml(content) + '</div>' : ''}
                <span class="typing-cursor"></span>
            `;
        } else {
            contentDiv.innerHTML = this.escapeHtml(content) + '<span class="typing-cursor"></span>';
        }
        
        const messagesArea = document.getElementById('messagesArea');
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }
    
    renderMessage(message) {
        const avatarIcon = message.role === 'user'
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
        
        let imagesHtml = '';
        if (message.images && message.images.length > 0) {
            imagesHtml = '<div class="message-images">' + 
                message.images.map(img => `<img src="${img}" style="max-width: 200px; border-radius: 0.5rem; margin: 0.5rem 0;">`).join('') +
                '</div>';
        }
        
        return `
            <div class="message ${message.role}">
                <div class="message-avatar">${avatarIcon}</div>
                <div class="message-content">
                    ${imagesHtml}
                    <div class="message-text">${this.escapeHtml(message.content)}</div>
                    ${message.thinking ? `<div class="message-thinking" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem;">💭 ${this.escapeHtml(message.thinking)}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    toggleSendStop(isStreaming) {
        const sendBtn = document.getElementById('sendBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        if (isStreaming) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
            
            stopBtn.onclick = () => {
                if (this.abortController) {
                    this.abortController.abort();
                    this.isStreaming = false;
                    this.toggleSendStop(false);
                    this.showToast('تم إيقاف التوليد', 'warning');
                }
            };
        } else {
            sendBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
        }
    }
    
    clearImagePreviews() {
        const previewArea = document.getElementById('imagePreviewArea');
        previewArea.innerHTML = '';
    }
    
    showWelcomeScreen(show) {
        const welcomeScreen = document.getElementById('welcomeScreen');
        const messagesArea = document.getElementById('messagesArea');
        
        if (show) {
            welcomeScreen.style.display = 'flex';
            messagesArea.style.display = 'none';
        } else {
            welcomeScreen.style.display = 'none';
            messagesArea.style.display = 'flex';
        }
    }
    
    showMessagesArea() {
        this.showWelcomeScreen(false);
    }
    
    searchConversations(query) {
        const items = document.querySelectorAll('.conversation-item');
        items.forEach(item => {
            const name = item.querySelector('.conversation-name').textContent;
            if (name.toLowerCase().includes(query.toLowerCase())) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    }
    
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type} show`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the app
const app = new GLM5Chat();
