import puppeteer from 'puppeteer-core';

async function testHistory() {
    const browser = await puppeteer.connect({
        browserURL: `http://localhost:9222`,
        defaultViewport: null,
    });

    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('workbench.html'));
    
    if (page) {
        // Encontrar y clicar el boton de historial
        await page.evaluate(() => {
            const svgs = document.querySelectorAll('svg path');
            for (const path of svgs) {
                const d = path.getAttribute('d') || '';
                // Este es el path tipico de un reloj/historial (suele tener "a9 9")
                if (d.includes('M3 12a9 9') || d.includes('a9 9 0 1 0 9-9')) {
                    const btn = path.closest('.cursor-pointer') || path.parentElement;
                    if (btn && btn.click) {
                        btn.click();
                        return;
                    }
                }
            }
        });
        
        console.log('Botón de historial presionado. Esperando 1 segundo...');
        await new Promise(r => setTimeout(r, 1000));
        
        // Extraer los items de historial que acaban de aparecer
        const historyItems = await page.$$eval('div', els => {
            return els.map(e => ({
                text: e.innerText,
                className: e.className
            })).filter(e => e.className && typeof e.className === 'string' && (
                e.className.includes('history-item') || 
                e.className.includes('menu-item') ||
                e.className.includes('chat-history') ||
                e.className.includes('cursor-pointer')
            ) && e.text && e.text.length > 3 && e.text.length < 100);
        });
        
        console.log("Posibles items de historial encontrados:");
        // Filtrar algunos duplicados o ruidosos
        const uniqueItems = [];
        const seen = new Set();
        historyItems.forEach(item => {
            if(!seen.has(item.text)) {
                seen.add(item.text);
                uniqueItems.push(item);
            }
        });
        
        uniqueItems.slice(0, 20).forEach(i => console.log(JSON.stringify(i)));
        
        // Cerrar el historial haciendo click en otro lado (escape a veces no funciona si no hay foco)
        await page.keyboard.press('Escape');
    }
    
    await browser.disconnect();
}

testHistory().catch(console.error);
