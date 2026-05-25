import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import labcorePkg from 'labcore-tunnel';
const { createTunnel } = labcorePkg;
import fs from 'fs/promises';
import os from 'os';
import * as db from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determinar el directorio base para guardar archivos persistentes (DB, logs)
let baseDir = process.cwd();
if (process.execPath && !process.execPath.toLowerCase().endsWith('node.exe') && !process.execPath.toLowerCase().endsWith('node')) {
    baseDir = path.dirname(process.execPath);
}

async function getActiveProjectTitle(agController) {
    if (!agController || !agController.page) return null;
    try {
        return await agController.page.title();
    } catch (e) {
        return null;
    }
}

export function startWebServer(agController, port = 8080, launchLocalOnly = false) {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer);

    // Basic Auth Middleware to protect the web interface
    const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
    const WEB_PASSWORD = process.env.WEB_PASSWORD || '1234';
    app.use((req, res, next) => {
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login === WEB_USERNAME && password === WEB_PASSWORD) {
            return next();
        }

        res.set('WWW-Authenticate', 'Basic realm="401"');
        res.status(401).send(`Authentication required. Default user: ${WEB_USERNAME}`);
    });

    // Protect Socket.IO explicitly to prevent direct WS bypass
    io.engine.use((req, res, next) => {
        let b64auth = '';
        if (req.headers.authorization) {
            b64auth = req.headers.authorization.split(' ')[1] || '';
        } else {
            // Soporte para token por query params (ej. ?token=...)
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            b64auth = urlObj.searchParams.get('token') || '';
        }

        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login === WEB_USERNAME && password === WEB_PASSWORD) {
            return next();
        }
        res.writeHead(401);
        res.end();
    });

    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/uploads', express.static(path.join(baseDir, 'uploads')));
    app.use(express.json({ limit: '50mb' }));

    let activeTunnels = [];

    app.get('/api/tunnels', (req, res) => {
        res.json({ tunnels: activeTunnels.map(t => ({ url: t.url, port: t.port, proto: t.proto, host: t.host, isPrimary: t.isPrimary })) });
    });

    app.post('/api/tunnel', async (req, res) => {
        const tunnelPort = parseInt(req.body.port, 10) || port;
        const proto = req.body.proto || 'http';
        const host = req.body.host || 'localhost';
        try {
            const tunnel = await createTunnel({ port: tunnelPort, protocol: proto, host });
            activeTunnels.push({ instance: tunnel, url: tunnel.url, port: tunnelPort, proto, host, isPrimary: false });

            res.json({ url: tunnel.url, port: tunnelPort });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/tunnel/close', (req, res) => {
        const { url } = req.body;
        const index = activeTunnels.findIndex(t => t.url === url);
        if (index !== -1) {
            if (activeTunnels[index].isPrimary) {
                return res.status(403).json({ error: 'Cannot close the primary tunnel' });
            }
            activeTunnels[index].instance.close();
            activeTunnels.splice(index, 1);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Tunnel not found' });
        }
    });

    app.post('/api/send', async (req, res) => {
        const { text, images } = req.body;
        if (!text && (!images || images.length === 0)) return res.status(400).json({ error: 'Missing content' });

        try {
            const title = await getActiveProjectTitle(agController);
            if (title) {
                let logText = text || '';
                if (images && images.length > 0) {
                    logText += `\n\n[Injected ${images.length} Image(s)]`;
                }
                await db.appendMessage(title, 'user', logText);
            }

            await agController.sendInstruction(text, images);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message || 'Dispatch failed' });
        }
    });

    app.get('/api/projects', async (req, res) => {
        const projects = await agController.getProjects();
        res.json({ projects, activeIndex: agController.activeIndex });
    });

    app.get('/api/history', async (req, res) => {
        try {
            let messages = [];
            const title = await getActiveProjectTitle(agController);
            if (title) {
                messages = await db.getHistory(title);
            }
            if (messages.length === 0) {
                messages = await agController.getAllMessages();
                if (title && messages.length > 0) {
                    await db.setHistory(title, messages);
                }
            }
            res.json({ messages });
        } catch (e) {
            console.error('[API] Error loading history:', e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/set_project', async (req, res) => {
        const { id } = req.body;
        const success = await agController.setProject(id);
        res.json({ success });
    });

    // Safety check to prevent reading sensitive system files or credentials
    const isPathAllowed = (targetPath) => {
        if (!targetPath) return false;
        try {
            const resolvedPath = path.resolve(targetPath).toLowerCase().replace(/\\/g, '/');
            
            // 1. Blacklist check (Absolute system blockouts)
            const forbidden = [
                'c:/windows',
                'c:/program files',
                'c:/programdata',
                '/.ssh',
                '/etc',
                '/var',
                '/root'
            ];
            const hasForbidden = forbidden.some(f => resolvedPath.includes(f));
            if (hasForbidden) return false;
            
            // Check appdata specifically: block unless it's the legitimate local Antigravity installation
            const isAntigravityAppPath = resolvedPath.includes('/appdata/local/programs/antigravity');
            if (resolvedPath.includes('/appdata') && !isAntigravityAppPath) {
                return false;
            }
            
            // 2. Whitelist check (Only allow user personal directory or specific development locations)
            const userHome = os.homedir().toLowerCase().replace(/\\/g, '/');
            const omniRoot = path.resolve(baseDir).toLowerCase().replace(/\\/g, '/');
            const antigravityHome = path.join(os.homedir(), 'AppData/Local/Programs/Antigravity').toLowerCase().replace(/\\/g, '/');
            
            const allowedPrefixes = [
                userHome,
                omniRoot,
                'd:/repositorios',
                antigravityHome
            ];
            
            return allowedPrefixes.some(prefix => resolvedPath === prefix || resolvedPath.startsWith(prefix + '/'));
        } catch (e) {
            return false;
        }
    };

    app.get('/api/fs/ls', async (req, res) => {
        let targetDir = req.query.dir;
        if (!targetDir) {
            targetDir = os.homedir();
        }

        targetDir = path.resolve(targetDir);

        if (!isPathAllowed(targetDir)) {
            return res.status(403).json({ error: 'Access to this path is restricted by security policy.' });
        }

        try {
            const files = await fs.readdir(targetDir, { withFileTypes: true });
            const items = files.map(f => ({
                name: f.name,
                isDirectory: f.isDirectory(),
                path: path.join(targetDir, f.name).replace(/\\/g, '/')
            }));

            items.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
                return a.isDirectory ? -1 : 1;
            });

            res.json({ items, pwd: targetDir.replace(/\\/g, '/') });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/fs/read', async (req, res) => {
        try {
            const targetPath = req.query.path;

            if (!isPathAllowed(targetPath)) {
                return res.status(403).json({ error: 'Access to this file is restricted by security policy.' });
            }

            const content = await fs.readFile(targetPath, 'utf-8');
            res.json({ content });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/fs/write', async (req, res) => {
        try {
            const { path: targetPath, content } = req.body;

            if (!isPathAllowed(targetPath)) {
                return res.status(403).json({ error: 'Access to this file is restricted by security policy.' });
            }

            await fs.writeFile(targetPath, content, 'utf-8');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/fs/image', async (req, res) => {
        try {
            const targetPath = req.query.path;

            if (!isPathAllowed(targetPath)) {
                console.error(`[FS SECURITY] Rejected access to image: ${targetPath}`);
                return res.status(403).send('Access restricted by security policy.');
            }

            const ext = path.extname(targetPath).toLowerCase();
            const mimeTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.svg': 'image/svg+xml'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            const content = await fs.readFile(targetPath);
            
            // Set permissive headers for maximum rendering fidelity and quick loading
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Cache-Control', 'public, max-age=31536000');
            res.setHeader('Content-Type', contentType);
            res.send(content);
        } catch (e) {
            console.error(`[FS ERROR] Failed to read image: ${req.query.path}. Error:`, e);
            res.status(500).send(e.message);
        }
    });


    app.get('/api/fs/project-root', async (req, res) => {
        let root = null;
        try {
            if (agController && agController.page) {
                const url = agController.page.url();
                if (url.startsWith('file:///')) {
                    const filePath = decodeURIComponent(url.replace('file:///', ''));
                    root = path.dirname(filePath);
                } else {
                    // Try to extract exact path directly from VS Code DOM
                    const extractedPath = await agController.page.evaluate(() => {
                        const debugData = {};
                        try {
                            // Method A: Internal VS Code configuration
                            if (window.vscodeWindowConfiguration && window.vscodeWindowConfiguration.workspace) {
                                debugData.methodA = window.vscodeWindowConfiguration.workspace;
                                const uri = window.vscodeWindowConfiguration.workspace.uri || window.vscodeWindowConfiguration.workspace.original;
                                if (uri && (uri.path || uri.fsPath)) return uri.path || uri.fsPath;
                            }

                            // Helper to exclude internal IDE installation paths
                            const isUserPath = (p) => {
                                const lower = p.toLowerCase();
                                return !lower.includes('appdata/local/programs') && !lower.includes('program files');
                            };

                            // Check process arguments just in case
                            if (typeof process !== 'undefined' && process.argv) {
                                debugData.argv = process.argv;
                                const folderArg = process.argv.find(a => a.startsWith('--folder-uri='));
                                if (folderArg) {
                                    let cleanArg = folderArg.replace('--folder-uri=', '').replace('file:///', '').replace('vscode-file://vscode-app/', '');
                                    cleanArg = decodeURIComponent(cleanArg);
                                    if (isUserPath(cleanArg)) return cleanArg;
                                }
                            }

                            // Method B: Find elements with absolute Windows paths in their title attribute (Explorer Root)
                            const elements = Array.from(document.querySelectorAll('[title]'));
                            let paths = elements.map(el => el.getAttribute('title')).filter(t => t && /^[A-Za-z]:[\\/][^<>:"|?*]+$/.test(t.split('\n')[0]));
                            paths = paths.filter(isUserPath);
                            debugData.methodB_titles = paths;

                            if (paths.length > 0) {
                                // The shortest path is usually the root workspace folder
                                return paths.reduce((a, b) => a.length <= b.length ? a : b).split('\n')[0];
                            }

                            // Method C: Find VS Code data-uri attributes (files open in tabs)
                            const uriElements = Array.from(document.querySelectorAll('[data-uri], [data-resource]'));
                            const uriPaths = uriElements
                                .map(el => el.getAttribute('data-uri') || el.getAttribute('data-resource'))
                                .filter(uri => uri && (uri.startsWith('file:///') || uri.startsWith('vscode-file://vscode-app/')));

                            debugData.methodC_uris = uriPaths;

                            for (const uri of uriPaths) {
                                let cleanUri = uri.replace('vscode-file://vscode-app/', '').replace('file:///', '');
                                cleanUri = decodeURIComponent(cleanUri);
                                if (/^[A-Za-z]:[\\/]/.test(cleanUri) && isUserPath(cleanUri)) {
                                    return cleanUri;
                                }
                            }

                            // Let's dump this to the console if it fails so backend can read it
                            console.log("AG_DEBUG_DUMP:" + JSON.stringify(debugData));
                        } catch (e) {
                            console.log("AG_DEBUG_DUMP:" + JSON.stringify({ error: e.message }));
                        }
                        return null;
                    });

                    // Hook to read the console message
                    agController.page.on('console', async msg => {
                        if (msg.text().startsWith('AG_DEBUG_DUMP:')) {
                            const data = msg.text().replace('AG_DEBUG_DUMP:', '');
                            try {
                                await fs.writeFile(path.join(baseDir, 'debug.json'), data, 'utf-8');
                            } catch (e) { }
                        }
                    });

                    if (extractedPath) {
                        let cleanPath = extractedPath.replace(/\\/g, '/');
                        if (cleanPath.startsWith('/')) cleanPath = cleanPath.substring(1);

                        // Extract project name from title to find the root boundary
                        let projectName = "";
                        try {
                            const title = await agController.page.title();
                            // Titles look like: "Flowia - Antigravity" or "route.ts - Flowia - Antigravity"
                            const parts = title.split(' - ');
                            for (let i = 0; i < parts.length; i++) {
                                if (parts[i].includes('Antigravity')) {
                                    if (i > 0) {
                                        projectName = parts[i - 1].trim();
                                    }
                                    break;
                                }
                            }
                        } catch (e) { }

                        // If the path is a deep file path, truncate it at the project root folder
                        if (projectName) {
                            const lowerPath = cleanPath.toLowerCase();
                            const lowerProject = projectName.toLowerCase();

                            if (lowerPath.includes('/' + lowerProject + '/')) {
                                const idx = lowerPath.lastIndexOf('/' + lowerProject + '/');
                                cleanPath = cleanPath.substring(0, idx + 1 + projectName.length);
                            } else if (lowerPath.endsWith('/' + lowerProject)) {
                                const idx = lowerPath.lastIndexOf('/' + lowerProject);
                                cleanPath = cleanPath.substring(0, idx + 1 + projectName.length);
                            }
                        }

                        try {
                            const stat = await fs.stat(cleanPath);
                            if (stat.isDirectory()) {
                                root = cleanPath;
                            } else {
                                root = path.dirname(cleanPath);
                            }
                        } catch (e) {
                            // Path doesn't exist or permission error
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[FS] Could not determine project root:', e.message);
        }
        res.json({ root });
    });

    io.on('connection', async (socket) => {
        try {
            let msgs = [];
            const title = await getActiveProjectTitle(agController);
            if (title) {
                msgs = await db.getHistory(title);
            }
            if (msgs.length === 0) {
                msgs = await agController.getAllMessages();
                if (title && msgs.length > 0) {
                    await db.setHistory(title, msgs);
                }
            }
            socket.emit('history', msgs);
        } catch (e) {
            console.error('[Socket] Error loading initial history:', e.message);
            const msgs = await agController.getAllMessages();
            socket.emit('history', msgs);
        }
    });

    // Modify Antigravity's callback to emit to Socket.IO and write to DB
    agController.setOnNewMessageCallback(async (text) => {
        try {
            const title = await getActiveProjectTitle(agController);
            if (title) {
                await db.appendMessage(title, 'assistant', text);
            }
        } catch (e) {
            console.error('[Watcher] Failed to write new message to DB:', e.message);
        }
        io.emit('new_message', { text, role: 'assistant' });
    });

    agController.setOnStreamingCallback((text) => {
        io.emit('streaming_message', { text, role: 'assistant' });
    });

    agController.setOnRetryCallback(() => {
        io.emit('retry_action', { message: 'The Watcher has automatically triggered the "Retry" button.' });
    });

    // Auto-start primary tunnel if not launchLocalOnly
    if (launchLocalOnly) {
        console.log('🔒 [TUNNEL] External exposure disabled. OmniBridge is running exclusively on localhost.');
    } else {
        createTunnel({ port, protocol: 'http' }).then(tunnel => {
            activeTunnels.push({ instance: tunnel, url: tunnel.url, port, isPrimary: true });
        }).catch(e => {
            console.error('[ERROR] Failed to establish primary tunnel:', e.message);
        });
    }

    // Pre-sync history at startup to pre-download all assets
    setTimeout(async () => {
        try {
            console.log('[BOOT] Pre-synchronizing active project message history...');
            const title = await getActiveProjectTitle(agController);
            if (title) {
                // Force a fresh parse and download of all message attachments
                const msgs = await agController.getAllMessages();
                if (msgs.length > 0) {
                    await db.setHistory(title, msgs);
                    console.log(`[BOOT] Pre-synchronized history successfully! Saved ${msgs.length} messages.`);
                }
            }
        } catch (e) {
            console.error('[BOOT] Pre-synchronization failed:', e.message);
        }
    }, 2000);

    httpServer.listen(port, () => {
        console.log(`🌐 [WEB] OmniBridge Server live at http://localhost:${port}`);
    });
}
