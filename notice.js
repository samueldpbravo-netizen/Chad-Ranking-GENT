/* Chad Ranking: ❗ notice button + warning pop-up
 * Add to index.html, just before </body>:   <script src="notice.js"></script>
 * Optional: put <span id="noticeSlot"></span> in your header to place the button there.
 * Without it, the button sits fixed in the top-right corner.
 */
(function () {
  var KEY = 'cr-notice-seen';
  var SNAP = 'samuel_dpbravo';

  function seen() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(KEY, '1'); } catch (e) {} }

  function init() {
    var css = document.createElement('style');
    css.textContent = [
      '.cr-notice{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));right:12px;z-index:60;width:44px;height:44px;padding:0;border-radius:50%;border:2px solid #ef4444;background:rgba(30,20,20,.9);font-size:22px;line-height:1;display:grid;place-items:center;cursor:pointer;animation:crPulse 1.6s ease-out infinite}',
      '.cr-notice.inline{position:static;flex:none}',
      '.cr-notice:focus-visible{outline:2px solid #fff;outline-offset:3px}',
      '.cr-notice.seen{animation:none;filter:grayscale(1);opacity:.55;border-color:#6b6b6b}',
      '@keyframes crPulse{0%{transform:scale(1);box-shadow:0 0 0 0 rgba(239,68,68,.75)}70%{transform:scale(1.14);box-shadow:0 0 0 16px rgba(239,68,68,0)}100%{transform:scale(1);box-shadow:0 0 0 0 rgba(239,68,68,0)}}',
      '@media (prefers-reduced-motion:reduce){.cr-notice:not(.seen){animation:none;box-shadow:0 0 0 5px rgba(239,68,68,.45)}}',
      '.cr-dlg{width:min(520px,92vw);max-height:90vh;overflow:auto;padding:0;border:2px solid #ef4444;border-radius:16px;background:#1f1a16;color:#f3ece3;font:inherit}',
      '.cr-dlg::backdrop{background:rgba(0,0,0,.72)}',
      '.cr-in{padding:26px 24px 22px;text-align:center;display:grid;gap:14px}',
      '.cr-icon{font-size:64px;line-height:1}',
      '.cr-lead{margin:0;font-size:clamp(24px,6vw,32px);line-height:1.15;font-weight:800}',
      '.cr-in p{margin:0;font-size:17px;line-height:1.5}',
      '.cr-in b{color:#ef7b6b}',
      '.cr-snap{display:inline-block;margin-top:2px;padding:10px 18px;border-radius:10px;background:#fffc00;color:#111;font-weight:800;text-decoration:none}',
      '.cr-snap:focus-visible,.cr-ok:focus-visible{outline:2px solid #fff;outline-offset:3px}',
      '.cr-ok{justify-self:center;margin-top:4px;padding:10px 26px;border-radius:10px;border:1px solid #3a312a;background:#28211c;color:inherit;font:inherit;font-weight:600;cursor:pointer}'
    ].join('');
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'crNoticeBtn';
    btn.className = 'cr-notice' + (seen() ? ' seen' : '');
    btn.setAttribute('aria-label', 'Belangrijke mededeling');
    btn.textContent = '\u2757';

    var dlg = document.createElement('dialog');
    dlg.className = 'cr-dlg';
    dlg.setAttribute('aria-label', 'Waarschuwing');
    dlg.innerHTML =
      '<div class="cr-in">' +
        '<div class="cr-icon" aria-hidden="true">\u2757</div>' +
        '<p class="cr-lead">Neem dit niet serieus, dit is puur voor de fun en mijn skills te developen!</p>' +
        '<p>Je uiterlijk hangt niet af van wat hier gegeven word en gepest word niet toegelaten.</p>' +
        '<p>Als je van de generale lijst of school lijst wilt weggehaald worden <b>KAN DAT ZEKER</b>. ' +
        'Ook voor naam of bijnaam aanpassing of wil je je snap toevoegen voor <b>IEDEREEN DIE DE LINK HEEFT</b>.</p>' +
        '<p>Stuur me via snapchat:<br><a class="cr-snap" href="https://www.snapchat.com/add/' + SNAP + '" target="_blank" rel="noopener">' + SNAP + '</a></p>' +
        '<button type="button" class="cr-ok">Begrepen</button>' +
      '</div>';

    var slot = document.getElementById('noticeSlot');
    if (slot) { btn.classList.add('inline'); slot.appendChild(btn); } else { document.body.appendChild(btn); }
    document.body.appendChild(dlg);

    btn.addEventListener('click', function () {
      dlg.showModal();
      markSeen();
      btn.classList.add('seen');
    });
    dlg.querySelector('.cr-ok').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
