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

    console.log('\x1b[33m>> Seleccione el modo de red para OmniBridge:\x1b[0m\n');
    console.log('  \x1b[32m[1] 🔒 Modo Local (Localhost only)\x1b[0m');
    console.log('      - Ejecución 100% privada y segura en tu máquina.');
    console.log('      - No se expone ningún puerto al exterior.');
    console.log('      - Ideal para máxima velocidad y desarrollo privado.\n');
    console.log('  \x1b[34m[2] 🚀 Modo Público (Túnel Exterior)\x1b[0m');
    console.log('      - Crea un túnel HTTPS seguro usando Labcore Tunnel.');
    console.log('      - Permite acceder a OmniBridge desde cualquier lugar.');
    console.log('      - Ideal para integraciones externas y control remoto.\n');

    const input = await askQuestion('\x1b[35m👉 Seleccione una opción [1 o 2] (Por defecto 2): \x1b[0m');
    const launchLocalOnly = input.trim() === '1';

    console.log('\n=================================================');
    console.log('          🛠️  OMNIBRIDGE BOOTSTRAP  🛠️          ');
    console.log('=================================================\n');

    if (launchLocalOnly) {
        console.log('>> [BOOT] Iniciando en modo LOCAL (seguro)...');
    } else {
        console.log('>> [BOOT] Iniciando en modo PÚBLICO (túnel)...');
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