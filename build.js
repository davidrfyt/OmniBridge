import fs from 'fs';
import { execSync } from 'child_process';

console.log('\n=================================================');
console.log(' 📦 INICIANDO COMPILACIÓN OMNIBRIDGE (TODO EN 1)');
console.log('=================================================\n');

try {
    const html = fs.readFileSync('./src/public/index.html', 'utf8');
    const webJsPath = './src/web.js';
    let webJs = fs.readFileSync(webJsPath, 'utf8');

    const staticRoute = `app.use(express.static(path.join(__dirname, 'public')));`;
    const bundledRoute = `app.get('/', (req, res) => res.send(${JSON.stringify(html)}));`;

    let modified = false;
    if (webJs.includes(staticRoute)) {
        fs.writeFileSync(webJsPath, webJs.replace(staticRoute, bundledRoute));
        modified = true;
        console.log('[+] Interfaz HTML leída e incrustada directamente en el código base.');
    }

    console.log('[+] Ejecutando Bun Compiler...\n');

    try {
        execSync('npx --yes bun build ./index.js --compile --outfile OmniBridge', { stdio: 'inherit' });
        console.log('\n✅ ¡COMPILACIÓN EXITOSA!');
        
        if (fs.existsSync('./logo.ico')) {
            console.log('\n[+] Archivo logo.ico detectado. Inyectando icono en el ejecutable automáticamente...');
            try {
                if (!fs.existsSync('./node_modules/rcedit')) {
                    console.log('    Instalando inyector de iconos...');
                    execSync('npm install rcedit --no-save', { stdio: 'ignore' });
                }
                const injectCode = `
import('rcedit').then(async (rceditModule) => {
    try {
        const inject = rceditModule.rcedit || rceditModule.default || rceditModule;
        if (typeof inject !== 'function') {
            console.error('rcedit no exportó una función:', rceditModule);
            process.exit(1);
        }
        await inject('OmniBridge.exe', {
            icon: 'logo.ico',
            'version-string': {
                CompanyName: 'LabCore',
                FileDescription: 'OmniBridge Control Interface',
                ProductName: 'OmniBridge',
                OriginalFilename: 'OmniBridge.exe',
                LegalCopyright: 'Copyright © 2026 LabCore'
            }
        });
        process.exit(0);
    } catch (e) {
        console.error('Detalle del fallo de inyección:', e);
        process.exit(1);
    }
}).catch(e => {
    console.error('Fallo al importar rcedit:', e);
    process.exit(1);
});
`;
                fs.writeFileSync('inject.mjs', injectCode);
                execSync('node inject.mjs', { stdio: 'inherit' });
                fs.unlinkSync('inject.mjs');
                console.log('✅ ¡Icono inyectado en OmniBridge.exe a la perfección!');
            } catch (err) {
                console.log('⚠️ Error inyectando el icono:', err.message);
            }
        }

        console.log('🚀 Archivo "OmniBridge.exe" generado. Ya contiene TODO el HTML y dependencias.');
    } catch (error) {
        console.error('\n❌ Error durante la compilación con Bun:', error.message);
    } finally {
        if (modified) {
            console.log('[+] Restaurando archivos al modo desarrollador...');
            fs.writeFileSync(webJsPath, webJs);
        }
    }
} catch (e) {
    console.error('\n❌ Error catastrófico:', e.message);
}
