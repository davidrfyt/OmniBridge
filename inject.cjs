
const rceditModule = require('rcedit');
const inject = rceditModule.default || rceditModule;

inject('OmniBridge.exe', { icon: 'logo.ico' })
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Detalle del error de rcedit:', err);
        process.exit(1);
    });
