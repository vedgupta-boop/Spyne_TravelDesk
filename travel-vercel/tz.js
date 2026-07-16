/* Browser flight-time helper (mirror of lib/tz.js). window.TZ.flightTimeLabel(dateISO,'HH:MM',fromCity,toCity)
   → "02:10 IST · 16:40 −1 ET". A flight time is entered in the ORIGIN city's local time;
   shown in IST + the relevant US zone (DST-correct via Intl). */
(function(){
  var IST='Asia/Kolkata';
  function cityTz(city){
    var c=String(city||'').toLowerCase();
    if(/new york|jfk|newark|ewr|philadelph|phl|boston|\bbos\b|atlanta|atl|miami|mia|washington|iad|dca|orlando|mco/.test(c)) return 'America/New_York';
    if(/chicago|ord|dallas|dfw|houston|iah|austin|\baus\b|minneapolis|msp/.test(c)) return 'America/Chicago';
    if(/denver|den|phoenix|phx|salt lake|slc/.test(c)) return 'America/Denver';
    if(/los angeles|lax|san francisco|sfo|san jose|sjc|seattle|sea|las vegas|\blas\b|san diego/.test(c)) return 'America/Los_Angeles';
    if(/london|heathrow|lhr|gatwick|lgw|manchester|united kingdom|\buk\b|england|dublin|\bdub\b|ireland/.test(c)) return 'Europe/London';
    if(/paris|\bcdg\b|orly|france|frankfurt|\bfra\b|munich|\bmuc\b|germany|amsterdam|\bams\b|madrid|\bmad\b|barcelona|\bbcn\b|rome|\bfco\b|milan|zurich|\bzrh\b|geneva|\bgva\b|brussels|\bbru\b/.test(c)) return 'Europe/Paris';
    if(/dubai|\bdxb\b|abu dhabi|\bauh\b|sharjah|\buae\b|united arab/.test(c)) return 'Asia/Dubai';
    if(/singapore|\bsin\b/.test(c)) return 'Asia/Singapore';
    if(/hong kong|\bhkg\b/.test(c)) return 'Asia/Hong_Kong';
    if(/tokyo|haneda|\bhnd\b|narita|\bnrt\b|osaka|\bkix\b|japan/.test(c)) return 'Asia/Tokyo';
    if(/sydney|\bsyd\b|melbourne|\bmel\b|australia/.test(c)) return 'Australia/Sydney';
    return IST;
  }
  var FRIENDLY={'Asia/Kolkata':'IST','Asia/Dubai':'GST','Asia/Singapore':'SGT','Asia/Hong_Kong':'HKT','Asia/Tokyo':'JST'};
  function tzAbbr(tz,inst){
    var n=''; try{ new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'short'}).formatToParts(inst).forEach(function(p){ if(p.type==='timeZoneName') n=p.value; }); }catch(e){}
    if(n && !/^(GMT|UTC)[+\-−]/.test(n)) return n; // EST/EDT/PST/PDT/CST/MST/GMT/BST…
    return FRIENDLY[tz]||n||'';
  }
  function offMin(tz,date){
    var p={}; new Intl.DateTimeFormat('en-US',{timeZone:tz,hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(date).forEach(function(x){p[x.type]=x.value;});
    var asUTC=Date.UTC(+p.year,+p.month-1,+p.day,+(p.hour%24),+p.minute,+p.second);
    return (asUTC-date.getTime())/60000;
  }
  function toInstant(dateISO,hhmm,tz){
    var d=String(dateISO).split('-').map(Number), t=String(hhmm).split(':').map(Number);
    if(d.length<3||isNaN(d[0])) return null;
    var guess=Date.UTC(d[0],d[1]-1,d[2],t[0]||0,t[1]||0);
    return new Date(guess-offMin(tz,new Date(guess))*60000);
  }
  function hm(inst,tz){ return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(inst); }
  function dayTag(inst,tz,base){ var dd=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(inst); return dd===base?'':(dd>base?' +1':' −1'); }
  function flightTimes(dateISO,hhmm,from,to){
    if(!dateISO||!hhmm) return null;
    var oTz=cityTz(from), inst=toInstant(dateISO,hhmm,oTz);
    if(!inst||isNaN(inst)) return null;
    var ist=hm(inst,IST)+dayTag(inst,IST,dateISO)+' IST';
    var otherTz=oTz!==IST?oTz:(cityTz(to)!==IST?cityTz(to):null);
    var us=otherTz?(hm(inst,otherTz)+dayTag(inst,otherTz,dateISO)+' '+tzAbbr(otherTz,inst)):null;
    return {ist:ist, us:us};
  }
  function flightTimeLabel(dateISO,hhmm,from,to){ var t=flightTimes(dateISO,hhmm,from,to); return t?(t.ist+(t.us?' · '+t.us:'')):''; }
  window.TZ={cityTz:cityTz, flightTimes:flightTimes, flightTimeLabel:flightTimeLabel};
})();
