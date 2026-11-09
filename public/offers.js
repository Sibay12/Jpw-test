/* JPW offers: popup banner + "Offers" section. Shared by index.html and mobile_app.html.
   The page defines window.OFFER_BUY(amount, coins) (starts the normal payment) and may define <div id="offers-section">. */
(function () {
    var SEEN_KEY = 'jpw_offers_seen';
    function seen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch (e) { return []; } }
    function markSeen(id) { try { var a = seen(); if (a.indexOf(id) < 0) a.push(id); localStorage.setItem(SEEN_KEY, JSON.stringify(a.slice(-50))); } catch (e) {} }

    var css = document.createElement('style');
    css.textContent =
        '.jo-card{background:rgba(255,255,255,.04);border:1px solid rgba(251,191,36,.35);border-radius:16px;overflow:hidden;margin-bottom:12px;text-align:left}' +
        '.jo-card img,.jo-pop img{display:block;width:100%;max-height:220px;object-fit:cover}' +
        '.jo-body{padding:12px 14px}.jo-name{font-weight:800;font-size:15px;color:#fbbf24}.jo-text{font-size:12px;color:#cbd5e1;margin:6px 0 10px;white-space:pre-wrap;word-break:break-word}' +
        '.jo-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;margin-top:6px;background:rgba(15,23,42,.7);border:1px solid rgba(255,255,255,.08);border-radius:12px;font-size:13px;color:#e8eefc}' +
        '.jo-row b{color:#34d399}.jo-buy{background:#f59e0b;color:#0f172a;border:0;border-radius:10px;padding:7px 14px;font-weight:800;font-size:12px;cursor:pointer}' +
        '.jo-ov{position:fixed;inset:0;z-index:99999;background:rgba(2,6,23,.78);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.jo-pop{position:relative;width:100%;max-width:380px;max-height:92vh;overflow:auto;background:#0f172a;border:1px solid rgba(251,191,36,.6);border-radius:20px;box-shadow:0 0 40px rgba(251,191,36,.25)}' +
        '.jo-x{position:absolute;top:8px;right:8px;z-index:2;width:30px;height:30px;border-radius:50%;border:0;background:rgba(2,6,23,.8);color:#fff;font-size:16px;cursor:pointer}' +
        '.jo-tag{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.5px;color:#0f172a;background:#fbbf24;border-radius:999px;padding:2px 9px;margin-bottom:6px}';
    document.head.appendChild(css);

    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
    function buy(a, c, after) { if (typeof window.OFFER_BUY === 'function') { if (after) after(); window.OFFER_BUY(a, c); } else alert('Please login first!'); }

    function fmt(d) { return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) + ' (IST)'; }
    function build(o, inPopup, closeFn) {
        var root = el('div', inPopup ? 'jo-pop' : 'jo-card');
        if (inPopup) { var x = el('button', 'jo-x', '✕'); x.onclick = closeFn; root.appendChild(x); }
        if (o.imageUrl) { var im = el('img'); im.src = o.imageUrl; im.alt = o.name; im.loading = 'lazy'; root.appendChild(im); }
        var body = el('div', 'jo-body');
        body.appendChild(el('span', 'jo-tag', '🎁 SPECIAL OFFER'));
        body.appendChild(el('div', 'jo-name', o.name));
        if (o.text) body.appendChild(el('div', 'jo-text', o.text));
        var upcoming = o.status === 'upcoming';
        if (o.startAt || o.endAt) {
            var w = el('div', 'jo-when'); w.style.cssText = 'font-size:11px;color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:10px;padding:6px 10px;margin-bottom:8px;line-height:1.6';
            if (o.startAt) w.appendChild(document.createTextNode('📅 Starts: ' + fmt(o.startAt)));
            if (o.startAt && o.endAt) w.appendChild(el('br'));
            if (o.endAt) w.appendChild(document.createTextNode('⏳ Ends: ' + fmt(o.endAt)));
            body.appendChild(w);
        }
        (o.packages || []).forEach(function (p) {
            var r = el('div', 'jo-row');
            var l = el('span'); l.appendChild(document.createTextNode('₹' + p.amount + ' ➡️ ')); l.appendChild(el('b', '', p.coins + ' Coins')); r.appendChild(l);
            var b = el('button', 'jo-buy', upcoming ? 'SOON' : 'BUY');
            if (upcoming) { b.disabled = true; b.style.opacity = '.5'; b.style.cursor = 'not-allowed'; } else b.onclick = function () { buy(p.amount, p.coins, inPopup ? closeFn : null); };
            r.appendChild(b);
            body.appendChild(r);
        });
        root.appendChild(body);
        return root;
    }

    var popupShown = false;
    function showPopup(o) {
        if (popupShown || document.querySelector('.jo-ov')) return;
        popupShown = true;
        var ov = el('div', 'jo-ov');
        function close() { markSeen(o.id); if (ov.parentNode) ov.parentNode.removeChild(ov); }
        ov.onclick = function (e) { if (e.target === ov) close(); };
        ov.appendChild(build(o, true, close));
        document.body.appendChild(ov);
    }

    function render(list) {
        var sec = document.getElementById('offers-section');
        if (sec) {
            sec.innerHTML = '';
            if (list.length) {
                var h = el('h3', '', '🎁 Offers'); h.style.cssText = 'margin:14px 0 8px;color:#fbbf24;font-size:14px;font-weight:800;text-align:left';
                sec.appendChild(h);
                list.forEach(function (o) { sec.appendChild(build(o, false)); });
            }
        }
        var s = seen();
        for (var i = 0; i < list.length; i++) { if (list[i].popup !== false && list[i].status !== 'upcoming' && s.indexOf(list[i].id) < 0) { showPopup(list[i]); break; } }
    }
    function load() {
        fetch('/api/offers', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { if (d && d.success) render(d.offers || []); }).catch(function () {});
    }
    window.JPW_OFFERS_RELOAD = load;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
    setInterval(load, 5 * 60 * 1000);
})();
