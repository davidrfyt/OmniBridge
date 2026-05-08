import puppeteer from 'puppeteer-core';

async function test() {
    const browser = await puppeteer.connect({
        browserURL: `http://localhost:9222`,
        defaultViewport: null,
    });
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('workbench.html'));
    
    // Open history
    await page.evaluate(() => {
        const svgs = document.querySelectorAll('svg path');
        for (const path of svgs) {
            const d = path.getAttribute('d') || '';
            if (d.includes('M3 12a9 9') || d.includes('a9 9 0 1 0 9-9')) {
                const btn = path.closest('.cursor-pointer') || path.parentElement;
                if (btn && btn.click) { btn.click(); return; }
            }
        }
    });
    await new Promise(r => setTimeout(r, 1000));
    
    // Check if "Show 25 more..." exists and click it multiple times if necessary
    for (let i = 0; i < 5; i++) {
        const clicked = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('div')).filter(e => e.className && typeof e.className === 'string' && e.className.includes('cursor-pointer'));
            const moreBtn = els.find(e => e.innerText && e.innerText.includes('Show 25 more'));
            if (moreBtn) {
                moreBtn.click();
                return true;
            }
            return false;
        });
        if (clicked) {
            console.log("Clicked Show 25 more...");
            await new Promise(r => setTimeout(r, 1000));
        } else {
            break;
        }
    }
    
    // get items
    const items = await page.$$eval('div', els => {
        const items = els.filter(e => e.className && typeof e.className === 'string' && e.className.includes('px-2.5') && e.className.includes('cursor-pointer'));
        return items.map(e => e.innerText.split('\n')[0]).filter(t => t && !t.includes('Show 25 more'));
    });
    console.log("Total items:", items.length);
    // console.log(items);
    
    await browser.disconnect();
}
test().catch(console.error);
