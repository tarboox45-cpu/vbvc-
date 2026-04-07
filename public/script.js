// public/script.js - GLM-5 Pro Stable Version
class GLM5Chat {
    constructor() {
        this.currentSessionId = null;
        this.isStreaming = false;
        this.abortController = null;
        this.images = [];
        this.agentMode = true;
        this.isDarkMode = true;
        this.conversations = [];
        this.isLoadingMessages = false;
        
        this.init();
    }
    
    init() {
        this.loadPreferences();
        this.setupEventListeners();
        this.setupTheme();
        this.loadSuggestions();
        
        // Start with a clean new session
        this.createNewConversation();
    }
    
    loadPreferences() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            this.isDarkMode = false;
            document.documentElement.setAttribute('data-theme', 'light');
            const themeIcon = document.querySelector('#themeToggle .sun-icon');
            const moonIcon = document.querySelector('#themeToggle .moon-icon');
            if (themeIcon && moonIcon) {
                themeIcon.style.display = 'none';
                moonIcon.style.display = 'block';
            }
        }
        
        const savedAgentMode = localStorage.getItem('agentMode');
        if (savedAgentMode !== null) {
            this.agentMode = savedAgentMode === 'true';
            const agentToggle = document.getElementById('agentToggle');
            if (agentToggle) agentToggle.checked = this.agentMode;
        }
    }
    
    setupTheme() {
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                this.isDarkMode = !this.isDarkMode;
                document.documentElement.setAttribute('data-theme', this.isDarkMode ? 'dark' : 'light');
                localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
                
                const sunIcon = themeToggle.querySelector('.sun-icon');
                const moonIcon = themeToggle.querySelector('.moon-icon');
                if (sunIcon && moonIcon) {
                    if (this.isDarkMode) {
                        sunIcon.style.display = 'block';
                        moonIcon.style.display = 'none';
                    } else {
                        sunIcon.style.display = 'none';
                        moonIcon.style.display = 'block';
                    }
                }
                
                this.showToast(`تم التبديل إلى الوضع ${this.isDarkMode ? 'الليلي' : 'النهاري'}`, 'success');
            });
        }
    }
    
    async loadConversations() {
        try {
            const response = await fetch('/api/conversations');
            if (!response.ok) throw new Error('Failed to load');
            this.conversations = await response.json();
            this.renderConversationsList();
        } catch (error) {
            console.error('Failed to load conversations:', error);
            this.conversations = [];
        }
    }
    
    renderConversationsList() {
        const container = document.getElementById('conversationsList');
        if (!container) return;
        
        if (!this.conversations || this.conversations.length === 0) {
            container.innerHTML = '<div class="empty-state" style="text-align: center; padding: 2rem; color: var(--text-secondary);">لا توجد محادثات بعد</div>';
            return;
        }
        
        container.innerHTML = this.conversations.map(conv => `
            <div class="conversation-item" data-id="${conv.id}">
                <div class="conversation-name">${this.escapeHtml(conv.name || 'محادثة جديدة')}</div>
                <div class="conversation-date">${this.formatDate(conv.updatedAt || conv.createdAt)}</div>
            </div>
        `).join('');
        
        // Add click handlers
        document.querySelectorAll('.conversation-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                if (id) this.loadConversation(id);
            });
        });
    }
    
    formatDate(timestamp) {
        if (!timestamp) return 'تاريخ غير معروف';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 3600000) return 'منذ قليل';
        if (diff < 86400000) return `اليوم ${date.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}`;
        return date.toLocaleDateString('ar', { year: 'numeric', month: 'numeric', day: 'numeric' });
    }
    
    async loadConversation(sessionId) {
        if (this.isLoadingMessages) return;
        this.isLoadingMessages = true;
        
        try {
            const response = await fetch(`/api/conversations?id=${sessionId}`);
            if (!response.ok) throw new Error('Failed to load conversation');
            
            const conversation = await response.json();
            this.currentSessionId = sessionId;
            
            // Clear messages area
            const messagesArea = document.getElementById('messagesArea');
            if (messagesArea) {
                messagesArea.innerHTML = '';
                messagesArea.style.display = 'flex';
            }
            
            // Hide welcome screen
            const welcomeScreen = document.getElementById('welcomeScreen');
            if (welcomeScreen) welcomeScreen.style.display = 'none';
            
            // Render messages
            if (conversation.messages && conversation.messages.length > 0) {
                conversation.messages.forEach(msg => {
                    this.renderMessageToDOM(msg);
                });
            }
            
            // Scroll to bottom
            messagesArea.scrollTop = messagesArea.scrollHeight;
            
            // Highlight active conversation
            document.querySelectorAll('.conversation-item').forEach(item => {
                item.classList.remove('active');
                if (item.dataset.id === sessionId) {
                    item.classList.add('active');
                }
            });
            
        } catch (error) {
            console.error('Failed to load conversation:', error);
            this.showToast('فشل تحميل المحادثة', 'error');
        } finally {
            this.isLoadingMessages = false;
        }
    }
    
    renderMessageToDOM(message) {
        const messagesArea = document.getElementById('messagesArea');
        if (!messagesArea) return;
        
        const avatarIcon = message.role === 'user' 
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
        
        let imagesHtml = '';
        if (message.images && message.images.length > 0) {
            imagesHtml = '<div class="message-images" style="margin-bottom: 0.5rem;">' + 
                message.images.map(img => `<img src="${img}" style="max-width: 150px; max-height: 150px; border-radius: 0.5rem; margin: 0.25rem; object-fit: cover;">`).join('') +
                '</div>';
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${message.role}`;
        messageDiv.innerHTML = `
            <div class="message-avatar">${avatarIcon}</div>
            <div class="message-content">
                ${imagesHtml}
                <div class="message-text">${this.formatMessageContent(message.content)}</div>
                ${message.thinking ? `<div class="message-thinking" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">💭 ${this.escapeHtml(message.thinking)}</div>` : ''}
            </div>
        `;
        
        messagesArea.appendChild(messageDiv);
    }
    
    formatMessageContent(content) {
        if (!content) return '';
        // Convert markdown-like syntax
        let formatted = this.escapeHtml(content);
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        formatted = formatted.replace(/\*(.*?)\*/g, '<em>$1</em>');
        formatted = formatted.replace(/`(.*?)`/g, '<code style="background: var(--bg-primary); padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-family: monospace;">$1</code>');
        formatted = formatted.replace(/\n/g, '<br>');
        return formatted;
    }
    
    async createNewConversation() {
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: `محادثة جديدة` })
            });
            
            if (!response.ok) throw new Error('Failed to create');
            
            const data = await response.json();
            this.currentSessionId = data.id;
            
            // Clear messages
            const messagesArea = document.getElementById('messagesArea');
            if (messagesArea) {
                messagesArea.innerHTML = '';
                messagesArea.style.display = 'none';
            }
            
            // Show welcome screen
            const welcomeScreen = document.getElementById('welcomeScreen');
            if (welcomeScreen) welcomeScreen.style.display = 'flex';
            
            // Clear input
            const messageInput = document.getElementById('messageInput');
            if (messageInput) messageInput.value = '';
            
            // Clear images
            this.images = [];
            const previewArea = document.getElementById('imagePreviewArea');
            if (previewArea) previewArea.innerHTML = '';
            
            // Reload conversations list
            await this.loadConversations();
            
            this.showToast('تم إنشاء محادثة جديدة', 'success');
        } catch (error) {
            console.error('Failed to create conversation:', error);
            this.showToast('فشل إنشاء محادثة جديدة', 'error');
        }
    }
    
    async deleteConversation(sessionId) {
        if (!confirm('هل أنت متأكد من حذف هذه المحادثة؟')) return;
        
        try {
            const response = await fetch(`/api/conversations?id=${sessionId}`, {
                method: 'DELETE'
            });
            
            if (!response.ok) throw new Error('Failed to delete');
            
            if (this.currentSessionId === sessionId) {
                await this.createNewConversation();
            }
            
            await this.loadConversations();
            this.showToast('تم حذف المحادثة', 'success');
        } catch (error) {
            console.error('Failed to delete:', error);
            this.showToast('فشل حذف المحادثة', 'error');
        }
    }
    
    async loadSuggestions() {
        const suggestions = [
            { title: 'شرح الذكاء الاصطناعي', prompt: 'اشرح لي الذكاء الاصطناعي بشكل مبسط مع أمثلة' },
            { title: 'إنشاء موقع ويب', prompt: 'قم بإنشاء موقع ويب كامل لشركة تقنية مع تصميم عصري ومتجاوب' },
            { title: 'كتابة دالة بايثون', prompt: 'اكتب دالة بايثون لفرز قائمة باستخدام خوارزمية Quicksort' },
            { title: 'نصائح للتسويق', prompt: 'قدم لي نصائح احترافية للتسويق الرقمي على وسائل التواصل' },
            { title: 'تحليل بيانات', prompt: 'كيف يمكن تحليل البيانات باستخدام مكتبة Pandas في بايثون؟' },
            { title: 'تصميم UX/UI', prompt: 'ما هي أفضل ممارسات تصميم واجهات المستخدم وتجربة المستخدم؟' }
        ];
        
        const container = document.getElementById('suggestionsGrid');
        if (!container) return;
        
        container.innerHTML = suggestions.map(suggestion => `
            <div class="suggestion-card" data-prompt="${this.escapeHtml(suggestion.prompt)}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 16v-4M12 8h.01"/>
                </svg>
                <div>
                    <strong>${this.escapeHtml(suggestion.title)}</strong>
                    <p style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem;">
                        ${this.escapeHtml(suggestion.prompt.substring(0, 50))}...
                    </p>
                </div>
            </div>
        `).join('');
        
        document.querySelectorAll('.suggestion-card').forEach(card => {
            card.addEventListener('click', () => {
                const prompt = card.dataset.prompt;
                const input = document.getElementById('messageInput');
                if (input && prompt) {
                    input.value = prompt;
                    input.focus();
                    this.sendMessage();
                }
            });
        });
    }
    
    setupEventListeners() {
        // Send message
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => this.sendMessage());
        }
        
        const messageInput = document.getElementById('messageInput');
        if (messageInput) {
            messageInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
            
            messageInput.addEventListener('input', (e) => {
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 150) + 'px';
            });
        }
        
        // New chat
        const newChatBtn = document.getElementById('newChatBtn');
        if (newChatBtn) {
            newChatBtn.addEventListener('click', () => this.createNewConversation());
        }
        
        // Menu toggle for mobile
        const menuToggle = document.getElementById('menuToggle');
        const sidebar = document.getElementById('sidebar');
        if (menuToggle && sidebar) {
            menuToggle.addEventListener('click', () => {
                sidebar.classList.toggle('closed');
            });
        }
        
        // Agent mode toggle
        const agentToggle = document.getElementById('agentToggle');
        if (agentToggle) {
            agentToggle.addEventListener('change', (e) => {
                this.agentMode = e.target.checked;
                localStorage.setItem('agentMode', this.agentMode);
                this.showToast(`تم ${this.agentMode ? 'تفعيل' : 'تعطيل'} وضع الوكيل`, 'success');
            });
        }
        
        // Image upload
        const attachBtn = document.getElementById('attachBtn');
        const imageInput = document.getElementById('imageInput');
        if (attachBtn && imageInput) {
            attachBtn.addEventListener('click', () => {
                imageInput.click();
            });
            
            imageInput.addEventListener('change', (e) => this.handleImageUpload(e));
        }
        
        // Close sidebar on overlay click (mobile)
        const sidebarOverlay = document.getElementById('sidebar-overlay');
        if (sidebarOverlay && sidebar) {
            sidebarOverlay.addEventListener('click', () => {
                sidebar.classList.add('closed');
            });
        }
    }
    
    async handleImageUpload(event) {
        const files = Array.from(event.target.files);
        
        for (const file of files) {
            if (file.size > 5 * 1024 * 1024) {
                this.showToast('حجم الصورة يجب أن لا يتجاوز 5 ميجابايت', 'error');
                continue;
            }
            
            if (!file.type.startsWith('image/')) {
                this.showToast('الرجاء اختيار ملف صورة فقط', 'error');
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
        if (!previewArea) return;
        
        const previewId = Date.now() + Math.random();
        
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
        
        const removeBtn = preview.querySelector('.image-preview-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                const index = this.images.findIndex(img => img === imageData);
                if (index !== -1) this.images.splice(index, 1);
                preview.remove();
            });
        }
    }
    
    async sendMessage() {
        const input = document.getElementById('messageInput');
        const message = input.value.trim();
        
        if (!message && this.images.length === 0) return;
        
        // Disable send button during sending
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.disabled = true;
        
        // Clear input and images
        input.value = '';
        input.style.height = 'auto';
        
        const imagesToSend = [...this.images];
        this.clearImagePreviews();
        this.images = [];
        
        // Hide welcome screen if visible
        const welcomeScreen = document.getElementById('welcomeScreen');
        const messagesArea = document.getElementById('messagesArea');
        if (welcomeScreen && welcomeScreen.style.display !== 'none') {
            welcomeScreen.style.display = 'none';
            if (messagesArea) messagesArea.style.display = 'flex';
        }
        
        // Add user message
        this.addMessageToUI('user', message, imagesToSend);
        
        // Prepare for streaming
        this.isStreaming = true;
        this.toggleSendStop(true);
        
        const assistantMessageId = this.addMessageToUI('assistant', '', [], true);
        
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
                    images: imagesToSend
                }),
                signal: this.abortController.signal
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let thinkingContent = '';
            
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
                        break;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        
                        if (parsed.type === 'thinking') {
                            thinkingContent += parsed.content;
                            this.updateAssistantMessage(assistantMessageId, thinkingContent, fullContent, true);
                        } else if (parsed.type === 'content') {
                            fullContent += parsed.content;
                            this.updateAssistantMessage(assistantMessageId, thinkingContent, fullContent, false);
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('Streaming error:', error);
                this.showToast('حدث خطأ في الاتصال بالخادم', 'error');
                this.updateAssistantMessage(assistantMessageId, '', 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.', false);
            }
        } finally {
            this.isStreaming = false;
            this.toggleSendStop(false);
            if (sendBtn) sendBtn.disabled = false;
            
            // Reload conversations to update
            await this.loadConversations();
        }
    }
    
    addMessageToUI(role, content, images = [], isLoading = false) {
        const messagesArea = document.getElementById('messagesArea');
        if (!messagesArea) return null;
        
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const avatarIcon = role === 'user' 
            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
        
        let imagesHtml = '';
        if (images && images.length > 0) {
            imagesHtml = '<div class="message-images" style="margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem;">' + 
                images.map(img => `<img src="${img}" style="max-width: 120px; max-height: 120px; border-radius: 0.5rem; object-fit: cover;">`).join('') +
                '</div>';
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;
        messageDiv.id = messageId;
        messageDiv.innerHTML = `
            <div class="message-avatar">${avatarIcon}</div>
            <div class="message-content">
                ${imagesHtml}
                <div class="message-text">${isLoading ? '<div class="loading-dots"><span></span><span></span><span></span></div>' : this.formatMessageContent(content)}</div>
            </div>
        `;
        
        messagesArea.appendChild(messageDiv);
        messagesArea.scrollTop = messagesArea.scrollHeight;
        
        return messageId;
    }
    
    updateAssistantMessage(messageId, thinking, content, isThinking) {
        const messageDiv = document.getElementById(messageId);
        if (!messageDiv) return;
        
        const contentDiv = messageDiv.querySelector('.message-text');
        if (!contentDiv) return;
        
        if (isThinking && thinking) {
            contentDiv.innerHTML = `
                <div style="color: var(--text-secondary); font-style: italic; font-size: 0.875rem;">
                    💭 ${this.escapeHtml(thinking)}
                </div>
                ${content ? '<div style="margin-top: 0.75rem;">' + this.formatMessageContent(content) + '</div>' : ''}
                <span class="typing-cursor"></span>
            `;
        } else {
            contentDiv.innerHTML = this.formatMessageContent(content) + '<span class="typing-cursor"></span>';
        }
        
        const messagesArea = document.getElementById('messagesArea');
        if (messagesArea) messagesArea.scrollTop = messagesArea.scrollHeight;
    }
    
    toggleSendStop(isStreaming) {
        const sendBtn = document.getElementById('sendBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        if (!sendBtn || !stopBtn) return;
        
        if (isStreaming) {
            sendBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
            
            const oldStopHandler = stopBtn.onclick;
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
        if (previewArea) previewArea.innerHTML = '';
    }
    
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        if (!toast) return;
        
        toast.textContent = message;
        toast.className = `toast ${type}`;
        toast.classList.add('show');
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }
    
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new GLM5Chat();
});
