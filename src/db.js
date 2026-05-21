import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determinar el directorio base para guardar archivos persistentes (DB, logs)
// Si está compilado (por ejemplo, con Bun), se utiliza el directorio donde reside el ejecutable (.exe).
// Si está en desarrollo, se utiliza el directorio de ejecución actual (process.cwd()).
let baseDir = process.cwd();
if (process.execPath && !process.execPath.toLowerCase().endsWith('node.exe') && !process.execPath.toLowerCase().endsWith('node')) {
    baseDir = path.dirname(process.execPath);
}

const DB_PATH = path.join(baseDir, 'chat_history.json');

// Helper to load db
async function loadDb() {
    try {
        const content = await fs.readFile(DB_PATH, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        return {};
    }
}

// Helper to save db
async function saveDb(data) {
    try {
        await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error('[DB] Failed to save chat history:', e.message);
        return false;
    }
}

/**
 * Gets conversation history for a given project/window title.
 * @param {string} title 
 * @returns {Promise<Array>}
 */
export async function getHistory(title) {
    if (!title) return [];
    const db = await loadDb();
    return db[title] || [];
}

/**
 * Seeds or overrides conversation history for a project/window title.
 * @param {string} title 
 * @param {Array} messages 
 * @returns {Promise<boolean>}
 */
export async function setHistory(title, messages) {
    if (!title) return false;
    const db = await loadDb();
    db[title] = messages.map(m => ({
        role: m.role || 'assistant',
        text: m.text,
        timestamp: m.timestamp || new Date().toISOString()
    }));
    return await saveDb(db);
}

/**
 * Appends a new message to the conversation history.
 * Prevents exact consecutive duplicate logs.
 * @param {string} title 
 * @param {string} role 'user' or 'assistant'
 * @param {string} text 
 * @returns {Promise<boolean>}
 */
export async function appendMessage(title, role, text) {
    if (!title || !text) return false;
    const db = await loadDb();
    if (!db[title]) {
        db[title] = [];
    }
    
    const len = db[title].length;
    if (len > 0) {
        const lastMsg = db[title][len - 1];
        if (lastMsg.role === role && lastMsg.text === text) {
            return true; // Already stored
        }
    }
    
    db[title].push({
        role,
        text,
        timestamp: new Date().toISOString()
    });
    
    return await saveDb(db);
}
