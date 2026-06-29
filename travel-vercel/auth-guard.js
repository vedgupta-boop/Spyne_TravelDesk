/* Shared client-side auth guard. Server APIs enforce roles too — this is for UX. */
(function () {
  // Inject the shared polish stylesheet + favicon on every page that loads this guard.
  (function injectTheme(){
    try {
      var head = document.head || document.getElementsByTagName('head')[0];
      if (head && !document.getElementById('trf-theme-css')) {
        var l = document.createElement('link'); l.id = 'trf-theme-css'; l.rel = 'stylesheet'; l.href = '/theme.css'; head.appendChild(l);
      }
      if (head && !document.querySelector('link[rel~="icon"]')) {
        var f = document.createElement('link'); f.rel = 'icon'; f.type = 'image/svg+xml'; f.href = '/favicon.svg'; head.appendChild(f);
      }
    } catch (e) { /* non-fatal */ }
  })();
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function login(){ location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); }

  function navlink(href,label,active){
    return '<a href="'+href+'" style="text-decoration:none;font-size:12px;font-weight:700;padding:5px 11px;border-radius:14px;'
      + (active?'background:#E8232A;color:#fff;':'background:rgba(255,255,255,.08);color:#cdd5e0;')+'">'+label+'</a>';
  }

  window.renderUserbar = function (me) {
    var el = document.getElementById('trf-userbar'); if(!el) return;
    var p = location.pathname;
    var isFin = me.roles.indexOf('finance')>-1; // finance = superuser: sees all dashboards
    var nav = [ navlink('/','Form', p==='/'||p==='/index.html') ];
    nav.push(navlink('/my','My Requests', p.indexOf('/my')>-1));
    nav.push(navlink('/reimbursement','Trip Reimbursement', p.indexOf('reimburs')>-1));
    if (['hod','ceo','finance'].some(function(r){return me.roles.indexOf(r)>-1;})) nav.push(navlink('/hod','Approvals', p.indexOf('hod')>-1));
    if (me.roles.indexOf('hod')>-1 || me.roles.indexOf('ceo')>-1) nav.push(navlink('/department','Department', p.indexOf('department')>-1));
    if (isFin) nav.push(navlink('/finance','Finance', p.indexOf('finance')>-1));
    if (isFin) nav.push(navlink('/budget-actual','Budget vs Actual', p.indexOf('budget-actual')>-1));
    if (isFin) nav.push(navlink('/reconciliation','Reconcile', p.indexOf('reconcil')>-1));
    // Admin & Forex: shown to their role holders AND to Finance (superuser, e.g. accounts@spyne.ai) — but NOT to pure HOD/CEO. Users: Finance only.
    if (me.roles.indexOf('admin')>-1 || isFin) nav.push(navlink('/admin','Admin', p.indexOf('admin')>-1 && p.indexOf('admin-users')<0));
    if (me.roles.indexOf('forex')>-1 || isFin) nav.push(navlink('/forex','Forex', p.indexOf('forex')>-1));
    if (isFin) nav.push(navlink('/admin-users','Users', p.indexOf('admin-users')>-1));
    el.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">'
      + nav.join('')
      + '<div style="position:relative;">'
        + '<button id="trf-bell" type="button" title="Notifications" style="position:relative;background:rgba(255,255,255,.08);border:none;color:#cdd5e0;border-radius:14px;padding:5px 9px;font-size:14px;cursor:pointer;line-height:1;">🔔'
          + '<span id="trf-bell-badge" style="display:none;position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;line-height:16px;text-align:center;background:#E8232A;color:#fff;border-radius:8px;font-size:10px;font-weight:800;padding:0 3px;"></span></button>'
        + '<div id="trf-notif" style="display:none;position:absolute;right:0;top:36px;width:330px;max-height:430px;overflow:auto;background:#fff;border:1px solid #D6DCE8;border-radius:10px;box-shadow:0 14px 34px rgba(13,27,42,.28);z-index:60;text-align:left;"></div>'
      + '</div>'
      + '<a href="/spyne-travel-policy.pdf" target="_blank" rel="noopener" title="View the Spyne Travel Policy" style="text-decoration:none;font-size:12px;font-weight:700;padding:5px 11px;border-radius:14px;background:rgba(255,255,255,.08);color:#cdd5e0;">📄 Policy</a>'
      + '<span style="font-size:11px;color:#8A97AA;margin-left:4px;">'+esc(me.email)+'</span>'
      + '<a href="/api/auth/logout" style="text-decoration:none;font-size:11px;font-weight:700;color:#E8232A;">Sign out</a></div>';
    NOTIF.email = me.email || '';
    var bell = document.getElementById('trf-bell'); if (bell) bell.onclick = toggleNotif;
    fetchNotifications();
  };

  // ---- 🔔 notifications: tab badges (live counts) + bell dropdown with read/unread ----
  var NOTIF = { email:'', items:[], data:null };
  function readSet(){ try { return new Set(JSON.parse(localStorage.getItem('trf_notif_read_'+NOTIF.email)||'[]')); } catch(e){ return new Set(); } }
  function saveRead(set){ try { localStorage.setItem('trf_notif_read_'+NOTIF.email, JSON.stringify(Array.from(set))); } catch(e){} }
  function unreadCount(){ var rd=readSet(); return NOTIF.items.filter(function(i){return !rd.has(i.key);}).length; }
  function tabBadge(href,n){ n=Number(n||0); if(n<=0) return; var a=document.querySelector('#trf-userbar a[href="'+href+'"]'); if(!a||a.querySelector('.nbadge')) return;
    var s=document.createElement('span'); s.className='nbadge';
    s.style.cssText='display:inline-block;min-width:17px;height:17px;line-height:17px;text-align:center;background:#fff;color:#E8232A;border-radius:9px;font-size:10px;font-weight:800;margin-left:6px;padding:0 4px;box-shadow:0 0 0 1px rgba(232,35,42,.4);';
    s.textContent=n; a.appendChild(s); }
  function refreshBell(){ var b=document.getElementById('trf-bell-badge'); if(!b) return; var n=unreadCount();
    if(n>0){ b.style.display='inline-block'; b.textContent=n; } else b.style.display='none';
    var base=document.title.replace(/^\(\d+\)\s*/,''); document.title=(n>0?('('+n+') '):'')+base; }
  function fetchNotifications(){
    fetch('/api/me?counts=1',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(c){
      if(!c) return; NOTIF.data=c; NOTIF.items=(c.items||[]);
      tabBadge('/hod',c.approvals); tabBadge('/department',c.department); tabBadge('/finance',c.finance); tabBadge('/admin',c.admin); tabBadge('/forex',c.forex);
      refreshBell();
    }).catch(function(){});
  }
  function toggleNotif(e){ if(e) e.stopPropagation(); var d=document.getElementById('trf-notif'); if(!d) return; var show=(d.style.display==='none'); d.style.display=show?'block':'none'; if(show) renderNotif(); }
  function renderNotif(){
    var d=document.getElementById('trf-notif'); if(!d) return; var rd=readSet();
    var head='<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #EDF1F7;font-weight:800;color:#0D1B2A;font-size:13px;">Notifications'
      +(NOTIF.items.length?'<button type="button" id="trf-markall" style="background:none;border:none;color:#2563EB;font-size:11px;font-weight:700;cursor:pointer;">Mark all read</button>':'')+'</div>';
    if(!NOTIF.items.length){ d.innerHTML=head+'<div style="padding:22px 12px;color:#8A97AA;font-size:12px;text-align:center;">Nothing pending — you’re all caught up.</div>'; return; }
    d.innerHTML=head+NOTIF.items.map(function(i){ var unread=!rd.has(i.key);
      return '<div class="trf-nrow" data-key="'+esc(i.key)+'" data-href="'+esc(i.href)+'" style="display:flex;gap:9px;padding:10px 12px;border-bottom:1px solid #F4F6FA;'+(unread?'background:#F0F6FF;':'')+'cursor:pointer;">'
        +'<span class="trf-ndot" data-key="'+esc(i.key)+'" title="'+(unread?'Mark read':'Mark unread')+'" style="flex-shrink:0;width:9px;height:9px;border-radius:50%;margin-top:4px;'+(unread?'background:#E8232A;':'border:1.5px solid #C7CED9;')+'"></span>'
        +'<div style="min-width:0;"><div style="font-weight:700;color:#0D1B2A;font-size:12.5px;">'+esc(i.title)+'</div><div style="font-size:11px;color:#5a6b80;overflow:hidden;text-overflow:ellipsis;">'+esc(i.id)+(i.sub?(' · '+esc(i.sub)):'')+'</div></div></div>';
    }).join('');
    var ma=document.getElementById('trf-markall'); if(ma) ma.onclick=function(ev){ ev.stopPropagation(); var s=readSet(); NOTIF.items.forEach(function(i){s.add(i.key);}); saveRead(s); refreshBell(); renderNotif(); };
    Array.prototype.forEach.call(d.querySelectorAll('.trf-ndot'), function(dot){ dot.onclick=function(ev){ ev.stopPropagation(); var k=dot.getAttribute('data-key'); var s=readSet(); if(s.has(k)) s.delete(k); else s.add(k); saveRead(s); refreshBell(); renderNotif(); }; });
    Array.prototype.forEach.call(d.querySelectorAll('.trf-nrow'), function(row){ row.onclick=function(){ var k=row.getAttribute('data-key'); var s=readSet(); s.add(k); saveRead(s); refreshBell(); location.href=row.getAttribute('data-href'); }; });
  }
  document.addEventListener('click', function(e){ var d=document.getElementById('trf-notif'); var b=document.getElementById('trf-bell'); if(d && d.style.display!=='none' && !d.contains(e.target) && b && !b.contains(e.target)) d.style.display='none'; });

  // No access to this view → send the user straight to the travel form (everyone can use it),
  // rather than showing a dead-end "Access denied" wall.
  function denied(me, role){
    if (location.pathname === '/' || location.pathname === '/index.html') return; // already on the form — avoid any loop
    location.replace('/');
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
