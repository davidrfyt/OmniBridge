import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';

import net from 'net';
import dgram from 'dgram';

export default function startTunnel({ port, proto = 'http', subdomain = null, host = 'localhost' }) {
    return new Promise((resolve, reject) => {
        const TUNNEL_SERVER = 'wss://tunnel.labcore.es';
        const LOCAL_HOST = host;
        const PROTO = proto.toLowerCase();
        
        const tunnelEmitter = new EventEmitter();
        let ws;
        let isReconnecting = false;

        let tcpSockets = new Map();
        let udpSockets = new Map();

        function connect() {
            ws = new WebSocket(TUNNEL_SERVER);
            
            ws.on('open', () => {
                ws.send(JSON.stringify({ type: 'register', proto: PROTO, subdomain }));
            });

            ws.on('message', (message) => {
                let data;
                try { data = JSON.parse(message.toString()); } catch (e) { return; }

                if (data.type === 'error') {
                    if (!tunnelEmitter.url) reject(new Error(data.message));
                    return;
                }

                if (data.type === 'registered') {
                    tunnelEmitter.url = data.url;
                    if (!isReconnecting) {
                        resolve(tunnelEmitter);
                    }
                    isReconnecting = true;
                }

                // HTTP HANDLING
                if (data.type === 'request') {
                    const reqData = data;
                    axios({
                        method: reqData.method,
                        url: `http://${LOCAL_HOST}:${port}${reqData.url}`,
                        headers: reqData.headers,
                        data: reqData.bodyBase64 ? Buffer.from(reqData.bodyBase64, 'base64') : null,
                        responseType: 'arraybuffer',
                        validateStatus: () => true,
                        timeout: 25000
                    }).then(response => {
                        ws.send(JSON.stringify({
                            type: 'response', requestId: reqData.requestId,
                            status: response.status, headers: response.headers,
                            body: response.data ? Buffer.from(response.data).toString('base64') : '',
                            isBase64: true
                        }));
                    }).catch(error => {
                        let errorHtml = `<h2>502 Bad Gateway</h2><p>Error connecting to ${LOCAL_HOST}:${port}</p>`;
                        ws.send(JSON.stringify({ type: 'response', requestId: reqData.requestId, status: 502, headers: { 'Content-Type': 'text/html' }, body: Buffer.from(errorHtml, 'utf-8').toString('base64'), isBase64: true }));
                    });
                }

                // TCP HANDLING
                if (data.type === 'tcp-connect') {
                    console.log(`[TCP] Connecting to ${LOCAL_HOST}:${port}`);
                    const socket = net.createConnection({ port: port, host: LOCAL_HOST === 'localhost' ? '127.0.0.1' : LOCAL_HOST }, () => {});
                    tcpSockets.set(data.connectionId, socket);

                    socket.on('data', (buf) => {
                        ws.send(JSON.stringify({ type: 'tcp-data', connectionId: data.connectionId, data: buf.toString('base64') }));
                    });
                    socket.on('close', () => {
                        ws.send(JSON.stringify({ type: 'tcp-disconnect', connectionId: data.connectionId }));
                        tcpSockets.delete(data.connectionId);
                    });
                    socket.on('error', (err) => {
                        console.error(`[TCP] Error on local socket ${LOCAL_HOST}:${port}:`, err.message);
                        ws.send(JSON.stringify({ type: 'tcp-disconnect', connectionId: data.connectionId }));
                        tcpSockets.delete(data.connectionId);
                    });
                }
                if (data.type === 'tcp-data') {
                    const socket = tcpSockets.get(data.connectionId);
                    if (socket && !socket.destroyed) {
                        socket.write(Buffer.from(data.data, 'base64'));
                    }
                }
                if (data.type === 'tcp-disconnect') {
                    const socket = tcpSockets.get(data.connectionId);
                    if (socket) {
                        socket.destroy();
                        tcpSockets.delete(data.connectionId);
                    }
                }

                // UDP HANDLING
                if (data.type === 'udp-data') {
                    let socket = udpSockets.get(data.clientId);
                    if (!socket) {
                        console.log(`[UDP] New incoming client sending to ${LOCAL_HOST}:${port}`);
                        socket = dgram.createSocket('udp4');
                        udpSockets.set(data.clientId, socket);

                        socket.on('message', (msg) => {
                            ws.send(JSON.stringify({ type: 'udp-data', clientId: data.clientId, data: msg.toString('base64') }));
                        });
                        socket.on('error', (err) => {
                            console.error(`[UDP] Error on local socket ${LOCAL_HOST}:${port}:`, err.message);
                            socket.close();
                            udpSockets.delete(data.clientId);
                        });
                    }
                    socket.send(Buffer.from(data.data, 'base64'), port, LOCAL_HOST === 'localhost' ? '127.0.0.1' : LOCAL_HOST, (err) => {
                        if (err) console.error(`[UDP] Send error to ${LOCAL_HOST}:${port}:`, err.message);
                    });
                }
            });

            ws.on('close', (code, reason) => {
                tunnelEmitter.emit('close');
                for (const socket of tcpSockets.values()) socket.destroy();
                tcpSockets.clear();
                for (const socket of udpSockets.values()) socket.close();
                udpSockets.clear();
                setTimeout(connect, 3000);
            });

            ws.on('error', (err) => {
                if (!tunnelEmitter.url) reject(err);
                tunnelEmitter.emit('error', err);
            });
        }
        
        connect();

        tunnelEmitter.close = () => {
            if (ws) {
                ws.removeAllListeners('close');
                ws.close();
            }
            for (const socket of tcpSockets.values()) socket.destroy();
            tcpSockets.clear();
            for (const socket of udpSockets.values()) socket.close();
            udpSockets.clear();
        };
    });
}
