import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import localtunnel from 'localtunnel';

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
        res.json({ tunnels: activeTunnels.map(t => ({ url: t.url, port: t.port, isPrimary: t.isPrimary })) });
    });

    app.post('/api/tunnel', async (req, res) => {
        const tunnelPort = req.body.port || port;
        try {
            const tunnel = await localtunnel({ port: tunnelPort });
            activeTunnels.push({ instance: tunnel, url: tunnel.url, port: tunnelPort });
            
            tunnel.on('close', () => {
                activeTunnels = activeTunnels.filter(t => t.url !== tunnel.url);
            });
            
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
        res.json({ projects });
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
    localtunnel({ port }).then(tunnel => {
        activeTunnels.push({ instance: tunnel, url: tunnel.url, port, isPrimary: true });
        console.log(`🚀 [TUNNEL] Primary external URL active: ${tunnel.url}`);
        tunnel.on('close', () => {
            activeTunnels = activeTunnels.filter(t => t.url !== tunnel.url);
        });
    }).catch(e => {
        console.error('[ERROR] Failed to establish primary tunnel:', e.message);
    });

    httpServer.listen(port, () => {
        console.log(`🌐 [WEB] OmniBridge Server live at http://localhost:${port}`);
    });
}
