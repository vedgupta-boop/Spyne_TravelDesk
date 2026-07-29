/* Shared client-side auth guard. Server APIs enforce roles too — this is for UX. */
(function () {
  // Accessibility layer — additive, no colour/token changes (so it can't break any page's look).
  // Visible keyboard focus, comfortable tap targets, and a reduced-motion guard.
  (function injectA11y(){
    if (document.getElementById('exp-a11y-css')) return;
    var css = ''
      + 'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{'
      +   'outline:2px solid #E8232A;outline-offset:2px;border-radius:6px;}'
      + 'button,select,input[type=checkbox],input[type=radio],a[role=button]{min-height:24px;}'
      + '@media (max-width:640px){button,.btn,a[role=button]{min-height:40px;}}'
      + '::selection{background:#E8232A;color:#fff;}'
      + '@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important;}}';
    var s = document.createElement('style'); s.id = 'exp-a11y-css'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function login(){ location.href = '/api/auth/login?next=' + encodeURIComponent(location.pathname); }

  function navlink(href,label,active){
    return '<a href="'+href+'" style="text-decoration:none;font-size:12px;font-weight:700;padding:5px 11px;border-radius:14px;'
      + (active?'background:#E8232A;color:#fff;':'background:rgba(255,255,255,.08);color:#cdd5e0;')+'">'+label+'</a>';
  }

  window.renderUserbar = function (me) {
    var el = document.getElementById('exp-userbar'); if(!el) return;
    var p = location.pathname, onAppr = p.indexOf('approvals')>-1;
    var asParam = (location.search.match(/as=(\w+)/)||[])[1] || '';
    var isHOD = me.roles.indexOf('hod')>-1, isCEO = me.roles.indexOf('ceo')>-1, isFin = me.roles.indexOf('finance')>-1;
    var nav = [ navlink('/','Form', p==='/'||p==='/index.html'), navlink('/my','My Requests', p.indexOf('/my')>-1), navlink('/budget','Budgets', p.indexOf('budget')>-1) ];
    if (isFin) {
      // Finance = superuser: read-only monitors of each approval stage + its own action queue + the all-seeing dashboard.
      nav.push(navlink('/approvals?as=dept','Department Head', onAppr && asParam==='dept'));
      nav.push(navlink('/approvals?as=ceo','CEO', onAppr && asParam==='ceo'));
      nav.push(navlink('/approvals','Approvals', onAppr && !asParam));
      nav.push(navlink('/finance','Finance', p.indexOf('finance')>-1));
      nav.push(navlink('/exec','Exec', p.indexOf('exec')>-1));
      nav.push(navlink('/access','User Access', p.indexOf('access')>-1));
    } else {
      if (isHOD) nav.push(navlink('/approvals','Department Head', onAppr));
      if (isCEO) { nav.push(navlink('/approvals','CEO', onAppr)); nav.push(navlink('/exec','Exec', p.indexOf('exec')>-1)); }
    }
    el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">'
      + nav.join('')
      + '<span style="font-size:11px;color:#8A97AA;margin-left:4px;">'+esc(me.email)+'</span>'
      + '<a href="/api/auth/logout" style="text-decoration:none;font-size:11px;font-weight:700;color:#E8232A;">Sign out</a></div>';
  };

  function denied(me, role){
    var isFin = me.roles.indexOf('finance')>-1;
    var links = [['/','New Request', true],['/my','My Requests', true]];
    if (isFin) links.push(['/finance','Finance', true]);
    var btns = links.map(function(l){ return '<a href="'+l[0]+'" style="background:#0D1B2A;color:#fff;text-decoration:none;border-radius:8px;padding:9px 15px;font-size:13px;font-weight:700;">'+l[1]+'</a>'; }).join('');
    document.body.innerHTML = '<div style="font-family:-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;max-width:480px;margin:80px auto;background:#fff;border:1px solid #D6DCE8;border-radius:14px;padding:34px;text-align:center;">'
      + '<div style="font-size:42px;">🔒</div>'
      + '<h2 style="color:#0D1B2A;margin:10px 0 6px;">Access denied</h2>'
      + '<p style="color:#3D506A;line-height:1.5;">Signed in as <b>'+esc(me.email)+'</b>.<br>This view requires the <b>'+esc(role)+'</b> role.</p>'
      + '<div style="margin-top:18px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">'+btns+'</div>'
      + '<p style="margin-top:16px;"><a href="/api/auth/logout" style="color:#E8232A;font-size:13px;">Sign out</a></p></div>';
  }

  // Gate the page: ensures sign-in + role(s), then calls onReady(me). `role` may be a string or an array (any-of).
  window.requireView = function (role, onReady) {
    var roleList = role ? (Array.isArray(role) ? role : [role]) : [];
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(me){
        if (!me.authenticated){ login(); return; }
        var ok = roleList.length === 0 || roleList.some(function(rl){ return me.roles.indexOf(rl) > -1; }) || me.roles.indexOf('finance') > -1; // finance = superuser
        if (!ok){ denied(me, roleList.join(' / ')); return; }
        onReady(me);
      })
      .catch(function(){ login(); });
  };
})();
