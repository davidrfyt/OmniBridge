import 'dotenv/config';
import { AntigravityController } from './src/antigravity.js';
import { startWebServer } from './src/web.js';

async function bootstrap() {
    console.log('\n=================================================');
    console.log(' 🌐 OMNIBRIDGE INITIALIZING... ');
    console.log('=================================================\n');
    console.log('>> [BOOT] Starting OmniBridge...');

    const agController = new AntigravityController();

    const isConnected = await agController.connect();

    if (!isConnected) {
        console.warn('⚠️ [WARNING] Failed to connect to Antigravity Core. Server will start, but CDP connection is missing.');
    }

    startWebServer(agController, process.env.WEB_PORT || 8080);

    process.once('SIGINT', () => process.exit(0));
    process.once('SIGTERM', () => process.exit(0));
}

bootstrap().catch(console.error);