import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import labcorePkg from 'labcore-tunnel';
const { createTunnel } = labcorePkg;
import fs from 'fs/promises';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startWebServer(agController, port = 8080) {
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
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login === WEB_USERNAME && password === WEB_PASSWORD) {
            return next();
        }
        res.writeHead(401);
        res.end();
    });

    app.use(express.static(path.join(__dirname, 'public')));
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
        const messages = await agController.getAllMessages();
        res.json({ messages });
    });

    app.post('/api/set_project', async (req, res) => {
        const { id } = req.body;
        const success = await agController.setProject(id);
        res.json({ success });
    });

    // Safety check to prevent reading sensitive system files or credentials
    const isPathAllowed = (targetPath) => {
        const absPath = path.resolve(targetPath).toLowerCase();
        const forbidden = [
            'c:\\windows',
            'c:\\program files',
            'c:\\programdata',
            '\\appdata',
            '\\.ssh',
            '/etc',
            '/var',
            '/root'
        ];
        return !forbidden.some(f => absPath.includes(f));
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
                            console.log("AG_DEBUG_DUMP:" + JSON.stringify({error: e.message}));
                        }
                        return null;
                    });
                    
                    // Hook to read the console message
                    agController.page.on('console', async msg => {
                        if (msg.text().startsWith('AG_DEBUG_DUMP:')) {
                            const data = msg.text().replace('AG_DEBUG_DUMP:', '');
                            try {
                                await fs.writeFile(path.join(__dirname, '../../debug.json'), data, 'utf-8');
                            } catch(e) {}
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
                        } catch (e) {}

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
        console.log('[Socket] Web client connected');
        // Send initial history if a project is selected
        const msgs = await agController.getAllMessages();
        socket.emit('history', msgs);
    });

    // Modify Antigravity's callback to emit to Socket.IO
    agController.setOnNewMessageCallback((text) => {
        io.emit('new_message', { text, role: 'assistant' });
    });

    agController.setOnRetryCallback(() => {
        io.emit('retry_action', { message: 'The Watcher has automatically triggered the "Retry" button.' });
    });

    // Auto-start primary tunnel
    createTunnel({ port, protocol: 'http' }).then(tunnel => {
        activeTunnels.push({ instance: tunnel, url: tunnel.url, port, isPrimary: true });
        console.log(`🚀 [TUNNEL] Primary external URL active: ${tunnel.url}`);
    }).catch(e => {
        console.error('[ERROR] Failed to establish primary tunnel:', e.message);
    });

    httpServer.listen(port, () => {
        console.log(`🌐 [WEB] OmniBridge Server live at http://localhost:${port}`);
    });
}
