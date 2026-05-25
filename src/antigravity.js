import puppeteer from 'puppeteer-core';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import https from 'https';

dotenv.config();

let baseDir = process.cwd();
if (process.execPath && !process.execPath.toLowerCase().endsWith('node.exe') && !process.execPath.toLowerCase().endsWith('node')) {
    baseDir = path.dirname(process.execPath);
}

const httpsAgent = new https.Agent({  
    rejectUnauthorized: false
});

const debugUploads = process.env.DEBUG_UPLOADS === 'true';

function logUpload(message) {
    if (debugUploads) {
        console.log(message);
    }
}

async function processLocalAttachments(text) {
    if (!text) return text;
    
    // Catch any URL inside markdown image syntax: ![alt](url)
    const markdownImageRegex = /!\[.*?\]\(([^)]+)\)/g;
    
    let modifiedText = text;
    const uploadsDir = path.join(baseDir, 'uploads');
    
    try {
        await fs.mkdir(uploadsDir, { recursive: true });
    } catch (e) {
        console.error('[Uploads] Failed to create uploads directory:', e.message);
    }
    
    const matches = [...text.matchAll(markdownImageRegex)];
    for (const m of matches) {
        const url = m[1];
        
        // 1. Check if it is a local localhost web URL
        if (/^(https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)/.test(url)) {
            try {
                logUpload(`[Uploads] Intercepted local web image: ${url}`);
                const response = await axios.get(url, { 
                    responseType: 'arraybuffer',
                    httpsAgent
                });
                
                const buffer = Buffer.from(response.data);
                const fileHash = crypto.createHash('md5').update(buffer).digest('hex');
                
                const contentType = response.headers['content-type'] || '';
                let ext = '.png';
                if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
                else if (contentType.includes('gif')) ext = '.gif';
                else if (contentType.includes('webp')) ext = '.webp';
                else if (contentType.includes('svg')) ext = '.svg';
                else {
                    try {
                        const parsedUrl = new URL(url);
                        const urlExt = path.extname(parsedUrl.pathname).toLowerCase();
                        if (urlExt) ext = urlExt;
                    } catch (e) {}
                }
                
                const fileName = `${fileHash}${ext}`;
                const destPath = path.join(uploadsDir, fileName);
                
                if (!existsSync(destPath)) {
                    await fs.writeFile(destPath, buffer);
                    logUpload(`[Uploads] Saved downloaded web image: ${destPath}`);
                }
                
                const publicUrl = `/uploads/${fileName}`;
                modifiedText = modifiedText.replaceAll(url, publicUrl);
            } catch (err) {
                console.error(`[Uploads] Failed to download local web image: ${url}. Error:`, err.message);
            }
        }
        // 2. Check if it is a local physical file path
        else if (url.includes(':/') || url.includes(':\\') || url.includes('%5C') || url.includes('file:///')) {
            try {
                const decodedPath = decodeURIComponent(url);
                const driveIndex = decodedPath.search(/[A-Za-z]:/);
                let cleanPath = decodedPath;
                if (driveIndex !== -1) {
                    cleanPath = decodedPath.substring(driveIndex);
                }
                
                let normalizedPath = path.resolve(cleanPath);
                
                if (!existsSync(normalizedPath)) {
                    const fixedPath = cleanPath.replace(/david\.gemini/i, 'DAVID/.gemini');
                    const normalizedFixed = path.resolve(fixedPath);
                    if (existsSync(normalizedFixed)) {
                        normalizedPath = normalizedFixed;
                    }
                }
                
                if (existsSync(normalizedPath)) {
                    const fileHash = crypto.createHash('md5').update(normalizedPath).digest('hex');
                    const ext = path.extname(normalizedPath).toLowerCase();
                    const fileName = `${fileHash}${ext}`;
                    const destPath = path.join(uploadsDir, fileName);
                    
                    if (!existsSync(destPath)) {
                        await fs.copyFile(normalizedPath, destPath);
                        logUpload(`[Uploads] Copied physical attachment: ${normalizedPath} -> ${destPath}`);
                    }
                    
                    const publicUrl = `/uploads/${fileName}`;
                    modifiedText = modifiedText.replaceAll(url, publicUrl);
                }
            } catch (err) {
                console.error(`[Uploads] Error processing physical attachment: ${url}. Error:`, err.message);
            }
        }
    }
    
    return modifiedText;
}

export class AntigravityController {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cdpPort = process.env.CDP_PORT || 9222;
        this.watcherInterval = null;
        this.lastKnownMessage = "";
        this.activeIndex = null; // Track the active project
        this.onNewMessageCallback = null;
        this.onStreamingCallback = null;
        this.onRetryCallback = null;
        
        // DOM Selectors (might require adjustment depending on Antigravity version)
        this.SELECTORS = {
            chatInput: 'div.cursor-text[contenteditable="true"]', // Selector for Antigravity's input
            messages: '.leading-relaxed.select-text.text-sm' // Selector for assistant messages
        };
    }

    setOnNewMessageCallback(cb) {
        this.onNewMessageCallback = cb;
    }

    setOnStreamingCallback(cb) {
        this.onStreamingCallback = cb;
    }

    setOnRetryCallback(callback) {
        this.onRetryCallback = callback;
    }

    async connect() {
        if (this.browser && this.browser.isConnected()) return true;
        try {
            console.log(`[CDP] Attempting to connect to Antigravity on port ${this.cdpPort}...`);
            this.browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${this.cdpPort}`,
                defaultViewport: null,
            });

            const pages = await this.browser.pages();
            // Find Antigravity's main page or any active valid page
            this.page = pages.find(p => p.url().includes('workbench.html')) || pages.find(p => !p.url().startsWith('devtools://') && p.url() !== 'about:blank') || pages[0];
            
            console.log('[CDP] Successfully connected to Antigravity Core!');
            
            this.browser.on('disconnected', () => {
                console.log('[CDP] Antigravity Core disconnected.');
                this.browser = null;
                this.page = null;
                if (this.watcherInterval) {
                    clearInterval(this.watcherInterval);
                    this.watcherInterval = null;
                }
            });

            this.lastKnownMessage = (await this.getLastResponse()) || "";
            this.startWatcher();
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to connect to Antigravity. Ensure it is open with the CDP port enabled.', error.message);
            return false;
        }
    }

    startWatcher() {
        if (this.watcherInterval) return;
        
        let stableCount = 0;
        let lastDraft = "";

        this.watcherInterval = setInterval(async () => {
            if (!this.browser) return;
            try {
                const pages = await this.browser.pages();
                let agPages = pages.filter(p => p.url().includes('workbench.html'));
                if (agPages.length === 0) {
                    agPages = pages.filter(p => p.url().includes('localhost') || p.url().includes('127.0.0.1') || p.url().startsWith('file://'));
                }

                // 1. Check for Retry ON ALL OPEN PAGES
                for (const p of agPages) {
                    try {
                        const retryClicked = await p.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button, div.cursor-pointer, [role="button"]'));
                            // Look for any button containing 'retry' in its text, ignoring spaces
                            const retryBtn = buttons.find(b => b.textContent && b.textContent.toLowerCase().trim().includes('retry'));
                            if (retryBtn) {
                                retryBtn.click();
                                return true;
                            }
                            return false;
                        });
                        
                        if (retryClicked) {
                            const title = await p.title().catch(() => 'Desconocido');
                            console.log(`[Watcher] Auto-Retry triggered on instance: ${title}`);
                            if (this.onRetryCallback) this.onRetryCallback();
                            if (this.page && p === this.page) {
                                stableCount = 0;
                            }
                        }
                    } catch (e) {
                        // Silence error for this specific tab
                    }
                }

                // 2. Check if there is a new or updated message ONLY ON THE SELECTED PROJECT
                if (!this.page) return;

                const currentText = await this.getLastResponse();
                if (!currentText) return;

                if (currentText !== this.lastKnownMessage) {
                    if (currentText !== lastDraft) {
                        // Message is still generating (it is changing)
                        lastDraft = currentText;
                        stableCount = 0;
                        if (this.onStreamingCallback) {
                            this.onStreamingCallback(currentText);
                        }
                    } else {
                        // Message stopped changing
                        stableCount++;
                        if (stableCount >= 4) { // 4 seconds passed (4 ticks of 1000ms) without changes -> assume completion
                            this.lastKnownMessage = currentText;
                            if (this.onNewMessageCallback) {
                                this.onNewMessageCallback(currentText);
                            }
                        }
                    }
                }
            } catch (error) {
                // Silence typical destroyed context errors (e.g., when page reloads)
            }
        }, 1000);
    }

    async getProjects() {
        if (!this.browser || !this.browser.isConnected()) {
            await this.connect();
        }
        if (!this.browser || !this.browser.isConnected()) return [];
        try {
            const pages = await this.browser.pages();
            let agPages = pages.filter(p => p.url().includes('workbench.html'));
            if (agPages.length === 0) {
                agPages = pages.filter(p => p.url().includes('localhost') || p.url().includes('127.0.0.1') || p.url().startsWith('file://'));
            }
            
            const projects = [];
            for (let i = 0; i < agPages.length; i++) {
                const title = await agPages[i].title();
                projects.push({ id: i, title: title });
            }
            return projects;
        } catch (error) {
            console.error('[ERROR] Fetching projects failed:', error);
            return [];
        }
    }

    async setProject(index) {
        if (!this.browser) return false;
        try {
            const pages = await this.browser.pages();
            let agPages = pages.filter(p => p.url().includes('workbench.html'));
            if (agPages.length === 0) {
                agPages = pages.filter(p => p.url().includes('localhost') || p.url().includes('127.0.0.1') || p.url().startsWith('file://'));
            }
            if (index >= 0 && index < agPages.length) {
                this.page = agPages[index];
                this.activeIndex = index;
                await this.page.bringToFront();
                
                this.lastKnownMessage = (await this.getLastResponse()) || "";
                
                // If the watcher wasn't running, start it
                this.startWatcher();
                
                // Force an immediate retry check upon switching projects
                try {
                    const retryClicked = await this.page.evaluate(() => {
                        const buttons = Array.from(document.querySelectorAll('button, div.cursor-pointer, [role="button"]'));
                        const retryBtn = buttons.find(b => b.textContent && b.textContent.toLowerCase().trim().includes('retry'));
                        if (retryBtn) {
                            retryBtn.click();
                            return true;
                        }
                        return false;
                    });
                    if (retryClicked) {
                        console.log('[Auto-Retry] Triggered upon project switch.');
                        if (this.onRetryCallback) this.onRetryCallback();
                    }
                } catch (e) {}

                return true;
            }
            return false;
        } catch (error) {
            console.error('[ERROR] Switching project failed:', error);
            return false;
        }
    }

    async sendInstruction(text, imagesArray = []) {
        if (!this.browser || !this.browser.isConnected()) {
            await this.connect();
        }
        if (!this.page) throw new Error('No connection to Antigravity Core.');

        try {
            // Find the main input of Antigravity (Wait up to 30 seconds in case it's currently generating)
            await this.page.waitForSelector(this.SELECTORS.chatInput, { timeout: 30000 });
            
            // Click input to focus naturally
            await this.page.click(this.SELECTORS.chatInput);

            // Select all existing text and delete using keyboard shortcuts
            // This prevents breaking the React state of the editor (which happens if we use innerText = '')
            const isMac = process.platform === 'darwin';
            await this.page.keyboard.down(isMac ? 'Meta' : 'Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up(isMac ? 'Meta' : 'Control');
            await this.page.keyboard.press('Backspace');

            if (imagesArray && imagesArray.length > 0) {
                // Dispatch paste event with all images
                await this.page.evaluate(async (selector, base64Array) => {
                    const input = document.querySelector(selector);
                    if (!input) return;
                    
                    const dataTransfer = new DataTransfer();
                    
                    for (let i = 0; i < base64Array.length; i++) {
                        const fetchRes = await fetch(base64Array[i]);
                        const blob = await fetchRes.blob();
                        const file = new File([blob], `pasted_image_${i}.png`, { type: blob.type });
                        dataTransfer.items.add(file);
                    }
                    
                    const pasteEvent = new ClipboardEvent('paste', {
                        clipboardData: dataTransfer,
                        bubbles: true,
                        cancelable: true
                    });
                    input.dispatchEvent(pasteEvent);
                }, this.SELECTORS.chatInput, imagesArray);
                
                // Wait briefly for the UI to attach and process all image files
                await new Promise(r => setTimeout(r, 1000 * imagesArray.length));
            }

            if (text) {
                // Inyectar el texto instantáneamente de forma segura e inmune a restricciones de Trusted Types
                await this.page.evaluate((txt, selector) => {
                    const input = document.querySelector(selector);
                    if (!input) return;

                    // Método A: Simular evento "paste" de texto plano (Moderno, Seguro y compatible con Trusted Types)
                    try {
                        const dataTransfer = new DataTransfer();
                        dataTransfer.setData('text/plain', txt);
                        
                        const pasteEvent = new ClipboardEvent('paste', {
                            clipboardData: dataTransfer,
                            bubbles: true,
                            cancelable: true
                        });
                        input.dispatchEvent(pasteEvent);
                        
                        // Si el pegado funcionó, la longitud del texto habrá incrementado
                        if (input.innerText.trim().length > 0) {
                            return;
                        }
                    } catch (e) {
                        // Continuar con los fallbacks si falla
                    }

                    // Método B: Usar selección y NodeText directo en el cursor (Inmune a Trusted Types)
                    try {
                        input.focus();
                        const selection = window.getSelection();
                        if (selection.rangeCount) {
                            selection.deleteFromDocument();
                            const range = selection.getRangeAt(0);
                            const textNode = document.createTextNode(txt);
                            range.insertNode(textNode);
                            range.setStartAfter(textNode);
                            range.setEndAfter(textNode);
                            selection.removeAllRanges();
                            selection.addRange(range);
                            
                            // Notificar a frameworks como React/Vue de la actualización
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            return;
                        }
                    } catch (e) {
                        // Continuar con fallback C
                    }

                    // Método C: Fallback clásico de execCommand con soporte dinámico para Trusted Types
                    try {
                        const escapeHTML = (string) => {
                            return string
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;')
                                .replace(/"/g, '&quot;')
                                .replace(/'/g, '&#039;');
                        };
                        const normalizedText = txt.replace(/\r\n/g, '\n');
                        const html = escapeHTML(normalizedText).replace(/\n/g, '<br>');
                        
                        let trustedHtml = html;
                        if (window.trustedTypes) {
                            try {
                                const policy = window.trustedTypes.defaultPolicy || 
                                               window.trustedTypes.createPolicy('omnibridge-policy', {
                                                   createHTML: (string) => string
                                               });
                                trustedHtml = policy.createHTML(html);
                            } catch (e) {
                                // Continuar con html normal si falla la política
                            }
                        }
                        
                        document.execCommand('insertHTML', false, trustedHtml);
                    } catch (e) {
                        // Si todo falla, escritura directa (last resort)
                        input.innerText = txt;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, text, this.SELECTORS.chatInput);
            }

            // Press Enter to send
            await this.page.keyboard.press('Enter');
            
            console.log('[CDP] Instruction successfully dispatched.');
            return true;
        } catch (error) {
            console.error('[ERROR] Dispatching instruction failed:', error.message);
            throw error;
        }
    }

    // Attempt to start a new chat, clearing context
    async startNewChat() {
        if (!this.page) return false;
        try {
            // Find and click the '+' button for a new conversation in the UI
            await this.page.evaluate(() => {
                // Búsqueda resiliente: Por aria-label o título
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], .cursor-pointer'));
                const newChatBtn = buttons.find(el => {
                    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                    return label.includes('new chat') || label.includes('nuevo chat');
                });
                if (newChatBtn) {
                    newChatBtn.click();
                    return;
                }

                // Fallback: Por SVG
                const svgs = document.querySelectorAll('svg path');
                for (const path of svgs) {
                    const d = path.getAttribute('d') || '';
                    // This is the exact SVG path of the '+' button in Antigravity
                    if (d === 'M12 4.5v15m7.5-7.5h-15' || (d.includes('15') && d.includes('h-15'))) {
                        const btn = path.closest('.cursor-pointer') || path.closest('button') || path.parentElement;
                        if (btn && btn.click) {
                            btn.click();
                            return;
                        }
                    }
                }
            });
            
            console.log('[CDP] New Chat (+) button clicked via DOM.');
            return true;
        } catch (error) {
            console.error('[ERROR] Clicking new chat failed:', error);
            return false;
        }
    }

    async getLastResponse() {
        if (!this.page) return null;
        
        try {
            // Extract the text of the last assistant message, filtering out thoughts and capturing attachments
            const lastMessage = await this.page.evaluate((selectors) => {
                const elements = Array.from(document.querySelectorAll(selectors.messages));
                
                // Filter out blocks inside the "Thoughts" container
                const realMessages = elements.filter(el => {
                    return !el.closest('.max-h-\\[200px\\]');
                });
                
                if (realMessages.length === 0) return null;
                const messageEl = realMessages[realMessages.length - 1];
                
                // Helper to extract text and dynamically parse attachments/images from elements
                let text = messageEl.innerText;
                
                // 1. Search for actual <img> tags
                const imgs = Array.from(messageEl.querySelectorAll('img'));
                imgs.forEach(img => {
                    const src = img.getAttribute('src');
                    const alt = img.getAttribute('alt') || 'Image';
                    if (src && !text.includes(src)) {
                        text += `\n\n![${alt}](${src})`;
                    }
                });
                
                // 2. Search for local file links/anchors or elements with path data
                const links = Array.from(messageEl.querySelectorAll('a, [data-path], [data-uri], [data-resource]'));
                links.forEach(el => {
                    const href = el.getAttribute('href') || el.getAttribute('data-path') || el.getAttribute('data-uri') || el.getAttribute('data-resource');
                    if (href && (href.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(href))) {
                        const isImage = /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(href);
                        if (isImage && !text.includes(href)) {
                            const alt = el.innerText.replace(/Review\n/g, '').trim() || 'Attachment';
                            text += `\n\n![${alt}](${href})`;
                        }
                    }
                });
                
                // 3. Deep scanner of all data attributes for hidden image links
                const subEls = Array.from(messageEl.querySelectorAll('*'));
                subEls.forEach(el => {
                    if (!el.attributes) return;
                    for (let i = 0; i < el.attributes.length; i++) {
                        const attr = el.attributes[i];
                        const val = attr.value;
                        if (val && (val.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(val))) {
                            const isImage = /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(val);
                            if (isImage && !text.includes(val)) {
                                text += `\n\n![Attachment](${val})`;
                            }
                        }
                    }
                });
                
                return text;
            }, this.SELECTORS);
            
            return await processLocalAttachments(lastMessage);
        } catch (error) {
            if (!error.message.includes('detached Frame')) {
                console.error('[ERROR] Reading response failed:', error);
            }
            return null;
        }
    }

    async getAllMessages() {
        if (!this.browser || !this.browser.isConnected()) {
            await this.connect();
        }
        if (!this.page) return [];
        try {
            const rawMessages = await this.page.evaluate((selectors) => {
                const elements = Array.from(document.querySelectorAll(selectors.messages));
                const realMessages = elements.filter(el => !el.closest('.max-h-\\[200px\\]'));
                
                return realMessages.map(messageEl => {
                    let text = messageEl.innerText;
                    
                    // 1. Search for actual <img> tags
                    const imgs = Array.from(messageEl.querySelectorAll('img'));
                    imgs.forEach(img => {
                        const src = img.getAttribute('src');
                        const alt = img.getAttribute('alt') || 'Image';
                        if (src && !text.includes(src)) {
                            text += `\n\n![${alt}](${src})`;
                        }
                    });
                    
                    // 2. Search for local file links/anchors or elements with path data
                    const links = Array.from(messageEl.querySelectorAll('a, [data-path], [data-uri], [data-resource]'));
                    links.forEach(el => {
                        const href = el.getAttribute('href') || el.getAttribute('data-path') || el.getAttribute('data-uri') || el.getAttribute('data-resource');
                        if (href && (href.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(href))) {
                            const isImage = /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(href);
                            if (isImage && !text.includes(href)) {
                                const alt = el.innerText.replace(/Review\n/g, '').trim() || 'Attachment';
                                text += `\n\n![${alt}](${href})`;
                            }
                        }
                    });
                    
                    // 3. Deep scanner of all data attributes for hidden image links
                    const subEls = Array.from(messageEl.querySelectorAll('*'));
                    subEls.forEach(el => {
                        if (!el.attributes) return;
                        for (let i = 0; i < el.attributes.length; i++) {
                            const attr = el.attributes[i];
                            const val = attr.value;
                            if (val && (val.startsWith('file:///') || /^[A-Za-z]:[\\/]/.test(val))) {
                                const isImage = /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(val);
                                if (isImage && !text.includes(val)) {
                                    text += `\n\n![Attachment](${val})`;
                                }
                            }
                        }
                    });
                    
                    return { role: 'assistant', text };
                });
            }, this.SELECTORS);

            const processedMessages = [];
            for (const m of rawMessages) {
                processedMessages.push({
                    role: m.role,
                    text: await processLocalAttachments(m.text)
                });
            }
            return processedMessages;
        } catch (error) {
            if (!error.message.includes('detached Frame')) {
                console.error('[ERROR] Fetching all messages failed:', error);
            }
            return [];
        }
    }

    // Active wait until the new message generates completely
    async awaitNewResponse(previousText, timeoutMs = 600000) {
        if (!this.page) return null;
        
        try {
            let lastText = "";
            let stableCount = 0;
            let isNewMessageStarted = false;
            
            // Check every second
            for (let i = 0; i < (timeoutMs / 1000); i++) {
                // ALWAYS check if there's a "Retry" button and press it
                const retryClicked = await this.page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, div.cursor-pointer, [role="button"]'));
                    const retryBtn = buttons.find(b => b.textContent && b.textContent.toLowerCase().includes('retry'));
                    if (retryBtn) {
                        retryBtn.click();
                        return true;
                    }
                    return false;
                });
                
                if (retryClicked) {
                    console.log('[Watcher] Retry triggered automatically during await.');
                    stableCount = 0; // Reset counter
                    // Allow some time for UI to react
                    await new Promise(r => setTimeout(r, 2000));
                    continue; 
                }

                const currentText = await this.getLastResponse();
                
                // If the text remains the same (or null), keep waiting for it to start
                if (!currentText || currentText === previousText) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                
                isNewMessageStarted = true;

                // If a new message started, check if it stopped changing
                if (currentText === lastText) {
                    stableCount++;
                    if (stableCount >= 4) { // 4 seconds without changing -> assume completed
                        return currentText;
                    }
                } else {
                    stableCount = 0;
                    lastText = currentText;
                }
                
                await new Promise(r => setTimeout(r, 1000));
            }
            return lastText; // Return whatever is there if timeout depletes
        } catch (error) {
            console.error('[ERROR] Awaiting response failed:', error);
            return null;
        }
    }

    async getHistory(loadAll = false) {
        if (!this.page) return null;
        try {
            await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], .cursor-pointer'));
                const historyBtn = buttons.find(el => {
                    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                    return label.includes('history') || label.includes('historial') || label.includes('chats');
                });
                if (historyBtn) { historyBtn.click(); return; }

                const svgs = document.querySelectorAll('svg path');
                for (const path of svgs) {
                    const d = path.getAttribute('d') || '';
                    if (d.includes('M3 12a9 9') || d.includes('a9 9 0 1 0 9-9')) {
                        const btn = path.closest('.cursor-pointer') || path.parentElement;
                        if (btn && btn.click) { btn.click(); return; }
                    }
                }
            });
            await new Promise(r => setTimeout(r, 1000));
            
            let maxClicks = loadAll ? 10 : 0;
            for (let i = 0; i < maxClicks; i++) {
                const clicked = await this.page.evaluate(() => {
                    const els = Array.from(document.querySelectorAll('div')).filter(e => e.className && typeof e.className === 'string' && e.className.includes('cursor-pointer'));
                    const moreBtn = els.find(e => e.innerText && e.innerText.includes('Show') && e.innerText.includes('more'));
                    if (moreBtn) {
                        moreBtn.click();
                        return true;
                    }
                    return false;
                });
                if (clicked) {
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    break;
                }
            }
            
            const items = await this.page.$$eval('div', els => {
                const validEls = els.filter(e => e.className && typeof e.className === 'string' && e.className.includes('px-2.5') && e.className.includes('cursor-pointer'));
                return validEls.map(e => e.innerText.split('\n')[0]).filter(t => t && !t.includes('Show') && !t.includes('more'));
            });
            
            await this.page.keyboard.press('Escape');
            return items;
        } catch (error) {
            console.error('[ERROR] Fetching history failed:', error);
            return null;
        }
    }

    async loadHistoryItem(index) {
        if (!this.page) return false;
        try {
            await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], .cursor-pointer'));
                const historyBtn = buttons.find(el => {
                    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                    return label.includes('history') || label.includes('historial') || label.includes('chats');
                });
                if (historyBtn) { historyBtn.click(); return; }

                const svgs = document.querySelectorAll('svg path');
                for (const path of svgs) {
                    const d = path.getAttribute('d') || '';
                    if (d.includes('M3 12a9 9') || d.includes('a9 9 0 1 0 9-9')) {
                        const btn = path.closest('.cursor-pointer') || path.parentElement;
                        if (btn && btn.click) { btn.click(); return; }
                    }
                }
            });
            await new Promise(r => setTimeout(r, 1000));
            
            for (let i = 0; i < 10; i++) {
                const shouldClickMore = await this.page.evaluate((idx) => {
                    const els = Array.from(document.querySelectorAll('div')).filter(e => e.className && typeof e.className === 'string' && e.className.includes('px-2.5') && e.className.includes('cursor-pointer'));
                    const validEls = els.filter(e => {
                        const text = e.innerText;
                        return text && !text.includes('Show') && !text.includes('more');
                    });
                    
                    if (validEls[idx]) return false;
                    
                    const allEls = Array.from(document.querySelectorAll('div')).filter(e => e.className && typeof e.className === 'string' && e.className.includes('cursor-pointer'));
                    const moreBtn = allEls.find(e => e.innerText && e.innerText.includes('Show') && e.innerText.includes('more'));
                    
                    if (moreBtn) {
                        moreBtn.click();
                        return true;
                    }
                    return false;
                }, index);
                
                if (shouldClickMore) {
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    break;
                }
            }
            
            const success = await this.page.evaluate((idx) => {
                const els = Array.from(document.querySelectorAll('div')).filter(e => e.className && typeof e.className === 'string' && e.className.includes('px-2.5') && e.className.includes('cursor-pointer'));
                const validEls = els.filter(e => {
                    const text = e.innerText;
                    return text && !text.includes('Show') && !text.includes('more');
                });
                if (validEls[idx]) {
                    validEls[idx].click();
                    return true;
                }
                return false;
            }, index);
            
            if (!success) {
                await this.page.keyboard.press('Escape');
            }
            return success;
        } catch (error) {
            console.error('[ERROR] Loading history item failed:', error);
            return false;
        }
    }
}
