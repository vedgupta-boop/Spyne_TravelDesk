/* Shared, self-contained trip-analytics renderer (no CSS dependency — all styles inline).
   Used on the HOD/CEO Department page so approvers see the same analytics as Finance,
   scoped to whatever rows they're allowed to see. window.buildTripAnalytics(rows, cfg) -> HTML. */
(function () {
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function cr(n) { n = Number(n) || 0; if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr'; if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L'; return '₹' + Math.round(n).toLocaleString('en-IN'); }
  function dmy(s) { var p = String(s || '').split('/'); return (p.length === 3) ? new Date(+p[2], +p[1] - 1, +p[0]) : null; }
  function isApproved(s) { s = String(s || ''); return !/reject|withdraw/i.test(s) && /approved|admin|confirm|complet|booking|forex|issued/i.test(s); }
  function isBroken(r) { return /^POLICY BREAK/i.test(String((r && r.flag) || '')); }
  var COLORS = ['#2563EB', '#0F9D58', '#E8232A', '#D97706', '#9B5DE5', '#16C0A6', '#8A97AA', '#F15BB5'];

  function svgPie(data, donut) {
    var pos = data.filter(function (d) { return d.val > 0; });
    var total = pos.reduce(function (s, d) { return s + d.val; }, 0);
    var cx = 70, cy = 70, r = 58, ir = donut ? 34 : 0;
    if (total <= 0) return '<svg viewBox="0 0 140 140" width="118" height="118"><circle cx="70" cy="70" r="58" fill="none" stroke="#EDF1F7" stroke-width="' + (donut ? 24 : 58) + '"/></svg>';
    if (pos.length === 1) { var c = pos[0].color; var inner = donut ? '<circle cx="70" cy="70" r="' + ir + '" fill="#fff"/>' : ''; return '<svg viewBox="0 0 140 140" width="118" height="118"><circle cx="70" cy="70" r="58" fill="' + c + '"/>' + inner + '</svg>'; }
    var a = -Math.PI / 2, paths = '';
    data.forEach(function (d) {
      if (d.val <= 0) return; var frac = d.val / total, a2 = a + frac * 2 * Math.PI;
      var x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a), x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2), lg = frac > 0.5 ? 1 : 0;
      if (donut) { var i1x = cx + ir * Math.cos(a), i1y = cy + ir * Math.sin(a), i2x = cx + ir * Math.cos(a2), i2y = cy + ir * Math.sin(a2);
        paths += '<path d="M' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + lg + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' L' + i2x.toFixed(2) + ' ' + i2y.toFixed(2) + ' A' + ir + ' ' + ir + ' 0 ' + lg + ' 0 ' + i1x.toFixed(2) + ' ' + i1y.toFixed(2) + ' Z" fill="' + d.color + '"/>';
      } else { paths += '<path d="M70 70 L' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + lg + ' 1 ' + x2.toFixed(2) + ' ' + y2.toFixed(2) + ' Z" fill="' + d.color + '"/>'; }
      a = a2;
    });
    return '<svg viewBox="0 0 140 140" width="118" height="118">' + paths + '</svg>';
  }
  function legend(data, total) { return '<div style="display:flex;flex-direction:column;gap:5px;">' + data.filter(function (d) { return d.val > 0; }).map(function (d) { return '<div style="display:flex;align-items:center;gap:7px;font-size:12px;"><span style="width:10px;height:10px;border-radius:3px;background:' + d.color + ';display:inline-block;"></span><span style="color:#3D506A;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(d.label) + '</span><b>' + (total ? Math.round(d.val / total * 100) : 0) + '%</b></div>'; }).join('') + '</div>'; }
  function svgLine(points) {
    var w = 320, h = 132, padX = 28, padTop = 14, padBot = 26;
    var max = Math.max.apply(null, points.map(function (p) { return p.val; }).concat([1]));
    var n = points.length, step = (w - padX * 2) / Math.max(1, n - 1);
    var pts = points.map(function (p, i) { return [padX + i * step, (h - padBot) - (p.val / max) * ((h - padBot) - padTop)]; });
    var poly = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var dots = pts.map(function (p) { return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" fill="#2563EB"/>'; }).join('');
    var labels = points.map(function (p, i) { return '<text x="' + (padX + i * step).toFixed(0) + '" y="' + (h - 8) + '" font-size="9" fill="#94A3B8" text-anchor="middle">' + esc(p.label) + '</text>'; }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '"><polyline points="' + poly + '" fill="none" stroke="#2563EB" stroke-width="2"/>' + dots + labels + '</svg>';
  }

  var card = 'background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:14px 16px;';
  function kpi(label, val, sub, color) {
    return '<div style="' + card + 'min-width:0;"><div style="font-size:11px;color:#64748B;font-weight:700;text-transform:uppercase;letter-spacing:.3px;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:800;color:' + (color || '#0D1B2A') + ';margin-top:4px;">' + val + '</div>' + (sub ? '<div style="font-size:11px;color:#94A3B8;margin-top:2px;">' + sub + '</div>' : '') + '</div>';
  }

  window.buildTripAnalytics = function (rows, cfg) {
    rows = rows || [];
    if (!rows.length) return '<div style="color:#8A97AA;font-size:13px;padding:6px 2px;">No requests in your scope yet.</div>';
    var fx = (cfg && cfg.fx && cfg.fx.USD_INR) || 92;
    var inr = function (t, c) { return String(c || 'INR').toUpperCase() === 'USD' ? Number(t || 0) * fx : Number(t || 0); };
    var now = new Date();
    var pending = 0, approved = 0, rejected = 0, needMine = 0, breaches = 0;
    var pipelineINR = 0, approvedINR = 0, advanceINR = 0, usd = 0;
    var deptSpend = {}, monthMap = {};
    rows.forEach(function (r) {
      var st = String(r.status || ''), rej = /reject|withdraw/i.test(st);
      if (r.pending) needMine++;
      if (rej) rejected++; else if (isApproved(st)) approved++; else pending++;
      if (isBroken(r)) breaches++;
      if (!rej) {
        var v = inr(r.total, r.currency); pipelineINR += v; if (isApproved(st)) approvedINR += v; advanceINR += inr(r.advance, r.currency);
        if (String(r.currency || '').toUpperCase() === 'USD') usd += Number(r.total || 0);
        var dep = r.dept || '—'; deptSpend[dep] = (deptSpend[dep] || 0) + v;
        var sub = dmy(r.submission); if (sub) { var mk = sub.getFullYear() + '-' + sub.getMonth(); monthMap[mk] = (monthMap[mk] || 0) + v; }
      }
    });

    var h = '';
    // Today's action + overview KPIs
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;">'
      + kpi('Awaiting your action', needMine, 'need your approval', needMine ? '#D97706' : '#0F9D58')
      + kpi('Total requests', rows.length, '')
      + kpi('Pending', pending, '')
      + kpi('Approved', approved, '', '#0F9D58')
      + kpi('Pipeline cost', cr(pipelineINR), 'normalised to ₹')
      + kpi('Approved cost', cr(approvedINR), '', '#0F9D58')
      + kpi('Travel advance', cr(advanceINR), 'forex + deposits')
      + kpi('Policy breaches', breaches, '', breaches ? '#E8232A' : '#0F9D58')
      + '</div>';

    // Charts: spend by dept (pie), status (donut), monthly (line)
    var deptArr = Object.keys(deptSpend).map(function (k) { return { label: k, val: deptSpend[k] }; }).sort(function (a, b) { return b.val - a.val; });
    var top = deptArr.slice(0, 5); var others = deptArr.slice(5).reduce(function (s, d) { return s + d.val; }, 0);
    if (others > 0) top.push({ label: 'Others', val: others });
    top.forEach(function (d, i) { d.color = COLORS[i % COLORS.length]; });
    var deptTotal = top.reduce(function (s, d) { return s + d.val; }, 0);
    var statusData = [{ label: 'Pending', val: pending, color: '#D97706' }, { label: 'Approved', val: approved, color: '#0F9D58' }, { label: 'Rejected', val: rejected, color: '#E8232A' }];
    var statusTotal = pending + approved + rejected;
    var months = []; for (var k = 5; k >= 0; k--) { var dd = new Date(now.getFullYear(), now.getMonth() - k, 1); months.push({ label: dd.toLocaleString('en', { month: 'short' }), val: monthMap[dd.getFullYear() + '-' + dd.getMonth()] || 0 }); }
    var chartRow = 'display:flex;align-items:center;gap:14px;';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;">'
      + '<div style="' + card + '"><div style="font-weight:800;color:#0D1B2A;margin-bottom:8px;">Spend by department</div><div style="' + chartRow + '">' + svgPie(top, false) + '<div style="flex:1;min-width:0;">' + legend(top, deptTotal) + '</div></div></div>'
      + '<div style="' + card + '"><div style="font-weight:800;color:#0D1B2A;margin-bottom:8px;">Request status</div><div style="' + chartRow + '">' + svgPie(statusData, true) + '<div style="flex:1;min-width:0;">' + legend(statusData, statusTotal) + '</div></div></div>'
      + '<div style="' + card + 'grid-column:1/-1;"><div style="font-weight:800;color:#0D1B2A;margin-bottom:8px;">Monthly spend (last 6 months, ₹)</div>' + svgLine(months) + '</div>'
      + '</div>';

    // Budget vs approved spend (per department, if budgets configured)
    var budgets = (cfg && cfg.deptBudgets) || {};
    var bkeys = Object.keys(budgets).filter(function (d) { return deptSpend[d] != null || budgets[d]; });
    if (bkeys.length) {
      // HOD sees only their dept(s); show budgets that have spend or are the user's scope.
      var shown = bkeys.filter(function (d) { return deptSpend[d] != null; });
      if (!shown.length) shown = bkeys;
      h += '<div style="' + card + 'margin-top:12px;"><div style="font-weight:800;color:#0D1B2A;margin-bottom:10px;">Budget utilisation (approved ₹ vs annual budget)</div>'
        + shown.map(function (d) {
          var used = deptSpend[d] || 0, bud = Number(budgets[d] || 0), pct = bud ? Math.min(100, Math.round(used / bud * 100)) : 0, over = bud && used > bud;
          return '<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:12px;color:#3D506A;margin-bottom:3px;"><span style="font-weight:700;">' + esc(d) + '</span><span>' + cr(used) + ' / ' + cr(bud) + ' · ' + pct + '%</span></div>'
            + '<div style="height:9px;background:#EDF1F7;border-radius:5px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + (over ? '#E8232A' : '#0F9D58') + ';"></div></div></div>';
        }).join('') + '</div>';
    }
    return h;
  };
})();
