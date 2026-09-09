/* Utilization dashboard — assertions against the SHIPPED inline script.
 *
 * Run: node tests/utilization.test.js
 *
 * These cover the three defects Andrew caught by reading the live page on
 * 2026-09-09, all of which were arithmetically consistent and silently wrong:
 * an over-capacity column that could never fire, a panel that ignored the
 * filters above it, and an exited market landing in "Unknown".
 */
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require('path').join(__dirname,'..','caregiver_utilization_v2.html'),'utf8');
const src=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const els={};
const el=id=>els[id]||(els[id]={id,value:'',innerHTML:'',textContent:'',style:{},appendChild(){},addEventListener(){}});
const ctx={console,Date,Math,JSON,Set,Array,String,Number,isNaN,parseInt,parseFloat,setTimeout,
  document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){},createElement:()=>({style:{}})},
  window:{addEventListener(){},location:{search:''}},fetch:async()=>({ok:false})};
ctx.window=ctx;ctx.globalThis=ctx;vm.createContext(ctx);
try{vm.runInContext(src,ctx,{timeout:5000});}catch(e){}
const seed=(a,r)=>vm.runInContext('_BASE_ACTIVE='+JSON.stringify(a)+';_BASE_RESTRICT='+JSON.stringify(r||[])+';null',ctx);

let pass=0,fail=0;const t=(n,c)=>{c?pass++:(fail++,console.log('  FAIL: '+n));};
const R=(o)=>Object.assign({first:'A',last:'B',market:'Baltimore',state:'Maryland',primType:0,
  svcType:'Long Hours',desired:40,worked:20,dayDisp:['Y','Y','N','N','N','N','N'],
  dayAvail:[1,1,0,0,0,0,0],ptoHrs:0,tuDays:0},o);

// --- Virginia / exited market ---
t('Northern-VA is recognised as exited', ctx.isExitedMarket('Boston, Northern-VA')===true);
t('a VA-free tag is not', ctx.isExitedMarket('Baltimore, med-tech')===false);
t('case-insensitive', ctx.isExitedMarket('NORTHERN-VA')===true);
t('empty/null tags are safe', ctx.isExitedMarket('')===false && ctx.isExitedMarket(null)===false);
t('exited rows dropped before bucketing', /isExitedMarket\(tags\)\)\{exitedCount\+\+;continue\}/.test(html));

// --- capacity panel honours the filters ---
seed([R({first:'Balt',market:'Baltimore',state:'Maryland'}),
      R({first:'Bost',market:'Boston',state:'Massachusetts',primType:1})]);
el('f-st').value='';el('f-mk').value='';el('f-tp').value='';
t('unfiltered shows everyone', ctx.capacityRows().length===2);
el('f-mk').value='Baltimore';
t('market filter narrows it', ctx.capacityRows().length===1);
el('f-mk').value='';el('f-st').value='Massachusetts';
t('state filter narrows it', ctx.capacityRows().length===1);
el('f-st').value='';el('f-tp').value='1';
t('service-type filter narrows it', ctx.capacityRows().length===1);
el('f-tp').value='';
t('clearing filters restores everyone', ctx.capacityRows().length===2);

// --- Andrew's headroom definition: desired - timeOff - worked ---
t('over when worked exceeds desired', ctx.overHeadroom(R({desired:40,worked:48}))<0);
t('not over when under desired', ctx.overHeadroom(R({desired:40,worked:30}))>0);
t('time off shrinks the target into overage', ctx.overHeadroom(R({desired:40,worked:30,ptoHrs:16}))<0);
t('temp-unavailable days shrink it too',
  ctx.overHeadroom(R({desired:40,worked:30,dayAvail:[1,1,1,1,0,0,0],tuDays:2}))<0);
t('no desired hours yields null, not a false positive', ctx.overHeadroom(R({desired:0,worked:30}))===null);
t('target floors at zero, never negative capacity', ctx.overHeadroom(R({desired:8,worked:0,ptoHrs:40}))===0);
t('live-in excluded from the count', ctx.overDesiredCount([R({desired:112,worked:168,isLI:'Yes'})])===0);
t('non-live-in overrun IS counted', ctx.overDesiredCount([R({desired:40,worked:60})])===1);
t('the old impossible test is gone', !/r\.adjCap>0&&r\.worked>r\.adjCap/.test(html));
t('column renamed from Over 100%', !/Over 100%/.test(html) && /Over Desired/.test(html));

console.log((fail?'\n':'')+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
