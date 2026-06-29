/* Browser flight-time helper (mirror of lib/tz.js). window.TZ.flightTimeLabel(dateISO,'HH:MM',fromCity,toCity)
   → "02:10 IST · 16:40 −1 ET". A flight time is entered in the ORIGIN city's local time;
   shown in IST + the relevant US zone (DST-correct via Intl). */
(function(){
  var IST='Asia/Kolkata';
  function cityTz(city){
    var c=String(city||'').toLowerCase();
    if(/new york|jfk|newark|ewr|philadelph|phl|boston|\bbos\b|atlanta|atl|miami|mia|washington|iad|dca/.test(c)) return 'America/New_York';
    if(/chicago|ord|dallas|dfw|houston|iah|austin|aus/.test(c)) return 'America/Chicago';
    if(/denver|den|phoenix|phx/.test(c)) return 'America/Denver';
    if(/los angeles|lax|san francisco|sfo|san jose|sjc|seattle|sea|las vegas|las/.test(c)) return 'America/Los_Angeles';
    return IST;
  }
  var US_ABBR={'America/New_York':'ET','America/Chicago':'CT','America/Denver':'MT','America/Los_Angeles':'PT'};
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
    var usTz=oTz!==IST?oTz:(cityTz(to)!==IST?cityTz(to):null);
    var us=usTz?(hm(inst,usTz)+dayTag(inst,usTz,dateISO)+' '+(US_ABBR[usTz]||'US')):null;
    return {ist:ist, us:us};
  }
  function flightTimeLabel(dateISO,hhmm,from,to){ var t=flightTimes(dateISO,hhmm,from,to); return t?(t.ist+(t.us?' · '+t.us:'')):''; }
  window.TZ={cityTz:cityTz, flightTimes:flightTimes, flightTimeLabel:flightTimeLabel};
})();
