import 'dotenv/config';
import { AntigravityController } from './src/antigravity.js';
import { startWebServer } from './src/web.js';
import readline from 'readline';

// Suppress internal tunnel package and Socket.IO console noise
const originalLog = console.log;
console.log = function(...args) {
    if (args[0] && typeof args[0] === 'string') {
        const msg = args[0];
        const ignoreList = [
            'Receiving traffic...',
            '[>>]',
            '[<<]',
            '[Socket] Web client connected'
        ];
        if (ignoreList.some(item => msg.includes(item))) {
            return;
        }
    }
    originalLog.apply(console, args);
};

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function bootstrap() {
    try {
        process.title = 'OmniBridge';
        process.stdout.write('\x1b]0;OmniBridge\x07');
    } catch (e) {}

    process.on('uncaughtException', (err) => {
        console.error('\n🚨 [CRITICAL ERROR] Uncaught Exception:', err);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('\n🚨 [CRITICAL ERROR] Unhandled Promise Rejection at:', promise, 'reason:', reason);
    });

    console.clear();
    console.log('\x1b[36m=================================================');
    console.log('       🌐 OMNIBRIDGE INITIALIZATION 🌐       ');
    console.log('=================================================\x1b[0m\n');

    console.log('\x1b[33m>> Select the network mode for OmniBridge:\x1b[0m\n');
    console.log('  \x1b[32m[1] 🔒 Local Mode (Localhost only)\x1b[0m');
    console.log('      - 100% private and secure execution on your machine.');
    console.log('      - No ports exposed to the outside.');
    console.log('      - Ideal for maximum speed and private development.\n');
    console.log('  \x1b[34m[2] 🚀 Public Mode (External Tunnel)\x1b[0m');
    console.log('      - Establishes a secure HTTPS tunnel via Labcore.');
    console.log('      - Allows remote access to OmniBridge from anywhere.');
    console.log('      - Perfect for external webhooks and remote control.\n');

    const input = await askQuestion('\x1b[35m👉 Select an option [1 or 2] (Default 2): \x1b[0m');
    const launchLocalOnly = input.trim() === '1';

    console.log('\n=================================================');
    console.log('          🛠️  OMNIBRIDGE BOOTSTRAP  🛠️          ');
    console.log('=================================================\n');

    if (launchLocalOnly) {
        console.log('>> [BOOT] Launching in LOCAL mode (secure)...');
    } else {
        console.log('>> [BOOT] Launching in PUBLIC mode (tunnel)...');
    }

    const agController = new AntigravityController();
    const isConnected = await agController.connect();

    if (!isConnected) {
        console.warn('⚠️ [WARNING] Failed to connect to Antigravity Core. Server will start, but CDP connection is missing.');
    }

    startWebServer(agController, process.env.WEB_PORT || 8080, launchLocalOnly);

    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));
}

bootstrap().catch(console.error);