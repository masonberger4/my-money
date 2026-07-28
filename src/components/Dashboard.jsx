import { useState, useEffect, useCallback, useRef } from "react";
import { getOverview, getSpending, getTransactions, getCashFlow, getAccounts, updateAccount, getAccountTransactions, updateTransaction, getBudgets, setBudget, getRecurringCandidates, searchTransactions, isManualAccount } from "../dataAdapter.js";
import { detectRecurring } from "../recurring.js";
import { unlinkInstitution, askAssistant } from "../plaidClient.js";
import { ERA_CATEGORIES } from "../categoryMap.js";
import { runSync } from "../sync.js";
import CsvImport from "./CsvImport.jsx";
import { getSetting, setSetting } from "../db.js";
import { ASSISTANT_MODELS, EFFORT_LEVELS, DEFAULT_MODEL, DEFAULT_EFFORT, estimateCostRange, formatCents } from "../assistantModels.js";
import { useTheme, readToken, THEME_PREFS } from "../theme.js";
import { chipStyle, markColor, readableInk } from "../paletteContrast.js";

const DEFAULT_COLORS = {
  "Shopping and gear": "#7F77DD", "Health and fitness": "#7F77DD",
  "Entertainment and subscriptions": "#7F77DD", "Travel and vacation": "#7F77DD",
  "Dining out": "#1D9E75", "Childcare": "#1D9E75", "Groceries": "#1D9E75",
  "Pets": "#1D9E75", "Healthcare and pharmacy": "#1D9E75", "Coffee and snacks": "#1D9E75",
  "Vehicle expenses": "#D85A30", "Ride shares": "#D85A30", "Public transit": "#D85A30",
  "Home maintenance and improvement": "#378ADD", "Utilities": "#378ADD",
  "Education": "#FAC775", "Side hustles and business": "#888780",
  "Cash, checks, and misc": "#888780", "Transfers and card payments": "#888780",
  "Return": "#1D9E75",
};

const TX_ICONS = {
  "Dining out":"🍴","Groceries":"🛒","Vehicle expenses":"🚗","Coffee and snacks":"☕",
  "Childcare":"👶","Pets":"🐾","Health and fitness":"💪","Home maintenance and improvement":"🔧",
  "Entertainment and subscriptions":"🎬","Shopping and gear":"🛍","Travel and vacation":"✈️",
  "Healthcare and pharmacy":"💊","Education":"📚","Side hustles and business":"💼",
  "Return":"↩️",
};

const ACCOUNT_COLORS = ["#7F77DD","#1D9E75","#D85A30","#378ADD","#FAC775","#D4537E","#639922","#E24B4A"];

// Three-state theme control: system -> light -> dark -> system. An icon alone
// can't say which of THREE states is active, so each one carries a label too.
const THEME_UI = {
  system: {icon:"◐",label:"Auto"}, light: {icon:"☀",label:"Light"}, dark: {icon:"☾",label:"Dark"},
};

// --- render-time palette contrast --------------------------------------------
// The palette (ACCOUNT_COLORS / DEFAULT_COLORS, and any hex picked with the
// Swatch input) is DATA: the STORED value must never change. But a colour that
// reads on a near-white card is unreadable on a near-black one, so legibility is
// computed AT RENDER against whatever surface the mark actually sits on — which
// also covers arbitrary user-picked colours a second fixed palette never could.
// Surfaces are read from the CSS tokens at runtime (below), so src/ui.css stays
// the single source of truth for their values.

// Memoised: the palette is small and there are ~3 surfaces, so this stays a
// handful of entries even with hundreds of rows on screen, and no row pays for
// the search twice.
const contrastCache = new Map();
function cached(key,compute){
  if(contrastCache.has(key))return contrastCache.get(key);
  const v=compute();
  if(contrastCache.size>400)contrastCache.clear();
  contrastCache.set(key,v);
  return v;
}

// A tinted chip on `surface`: {bg, ink, dot}. With no surface (no stylesheet
// yet — SSR/jsdom) fall back to the historical `color + "22"` look. Nothing here
// may throw: this runs during render and the app has no error boundary.
function chipOn(color,surface){
  if(!color)return {bg:"var(--bg)",ink:"var(--muted)",dot:"var(--muted)"};
  if(!surface)return {bg:color+"22",ink:color,dot:color};
  return cached("c|"+color+"|"+surface,()=>{
    const c=chipStyle(color,surface);
    return {bg:c.bg||color+"22",ink:c.ink||color,dot:c.dot||color};
  });
}
// A non-text mark (donut slice, bar fill, dot, chip border) — WCAG asks 3:1.
function markOn(color,surface){
  if(!color||!surface)return color;
  return cached("m|"+color+"|"+surface,()=>markColor(color,surface)||color);
}
// Text — 4.5:1.
function inkOn(color,surface){
  if(!color||!surface)return color;
  return cached("i|"+color+"|"+surface,()=>readableInk(color,surface)||color);
}

// The surfaces palette colours get drawn on. Read from the tokens rather than
// hardcoded, and re-read whenever the RESOLVED theme moves. readToken never
// throws and returns '' when there is no stylesheet -> null -> the fallbacks
// above.
function readSurfaces(){
  return {card:readToken("--card")||null,bg:readToken("--bg")||null,track:readToken("--track")||null};
}
function useSurfaces(resolved){
  const [surf,setSurf]=useState(readSurfaces);
  useEffect(()=>{
    const next=readSurfaces();
    setSurf(prev=>(prev.card===next.card&&prev.bg===next.bg&&prev.track===next.track)?prev:next);
  },[resolved]);
  return surf;
}

function monthLabel(y, m) { return new Date(y,m-1,1).toLocaleString("default",{month:"long",year:"numeric"}); }
function shortDate(iso) { const [y,m,d]=iso.split("-").map(Number); return new Date(y,m-1,d).toLocaleDateString("default",{month:"short",day:"numeric"}); }
function fmt(n) { return "$"+Number(n).toLocaleString("en-US",{maximumFractionDigits:0}); }
function fmtX(n) { return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }

function Sk({w="100%",h=16,r=6}) {
  return <div style={{width:w,height:h,borderRadius:r,background:"var(--border)",animation:"pulse 1.5s ease-in-out infinite"}} />;
}

function Donut({data,size=130}) {
  const total = data.reduce((s,d)=>s+d.value,0);
  if (!total) return <div style={{width:size,height:size,borderRadius:"50%",background:"var(--border)"}} />;
  let off=0;
  const cx=size/2,cy=size/2,r=size*.38,ir=size*.24;
  const slices = data.map(d=>{const p=d.value/total,s=off;off+=p*360;return{...d,s,e:off};});
  function arc(s,e,or,ir){
    const sa=(s-90)*Math.PI/180,ea=(e-90)*Math.PI/180,lg=e-s>180?1:0;
    const x1=cx+or*Math.cos(sa),y1=cy+or*Math.sin(sa),x2=cx+or*Math.cos(ea),y2=cy+or*Math.sin(ea);
    const x3=cx+ir*Math.cos(ea),y3=cy+ir*Math.sin(ea),x4=cx+ir*Math.cos(sa),y4=cy+ir*Math.sin(sa);
    return `M${x1},${y1} A${or},${or} 0 ${lg},1 ${x2},${y2} L${x3},${y3} A${ir},${ir} 0 ${lg},0 ${x4},${y4} Z`;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* No opacity here: the slice colour is already contrast-corrected against
          the card, and compositing it back toward the card would erode the 3:1
          the correction just bought (measured 2.68:1 for amber in light).
          The card-coloured stroke separates ADJACENT slices, which contrast
          correction cannot: the palette legitimately maps several categories to
          one colour (Groceries / Dining out / Pets are all #1D9E75), so
          neighbours can be a literal 1:1 and would otherwise read as one wedge. */}
      {slices.map((s,i)=><path key={i} d={arc(s.s,s.e,r,ir)} fill={s.color} stroke="var(--card)" strokeWidth="1.5"/>)}
      <circle cx={cx} cy={cy} r={ir-2} fill="var(--card)"/>
    </svg>
  );
}

function Swatch({color,onChange}) {
  const ref=useRef();
  // The fill is the STORED colour, shown truthfully — this is the colour picker,
  // so it must never be contrast-adjusted. The outline is --muted (>=3:1 on the
  // card in both themes) rather than the --border hairline, which disappears
  // against a swatch in either theme.
  return (
    <div onClick={()=>ref.current?.click()} title="Click to change color"
      style={{width:14,height:14,borderRadius:3,background:color,cursor:"pointer",flexShrink:0,
        outline:"1.5px solid var(--muted)",transition:"transform .1s",position:"relative"}}
      onMouseEnter={e=>e.currentTarget.style.transform="scale(1.3)"}
      onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
      <input ref={ref} type="color" value={color} onChange={e=>onChange(e.target.value)}
        style={{position:"absolute",opacity:0,width:1,height:1,pointerEvents:"none"}}/>
    </div>
  );
}

function EditName({name,onSave}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(name);
  const ref=useRef();
  useEffect(()=>{setVal(name);},[name]);
  useEffect(()=>{if(ed)ref.current?.select();},[ed]);
  if(ed) return (
    <input ref={ref} value={val} onChange={e=>setVal(e.target.value)}
      onBlur={()=>{setEd(false);onSave(val.trim()||name);}}
      onKeyDown={e=>{if(e.key==="Enter"){setEd(false);onSave(val.trim()||name);}if(e.key==="Escape"){setEd(false);setVal(name);}}}
      style={{font:"inherit",fontSize:13,fontWeight:500,color:"var(--text)",background:"var(--bg)",
        border:"1px solid var(--border)",borderRadius:4,padding:"1px 6px",width:"100%",outline:"none"}}/>
  );
  return (
    <span onDoubleClick={()=>setEd(true)} title="Double-click to rename"
      style={{display:"flex",alignItems:"center",gap:4,cursor:"text",flex:1,minWidth:0}}>
      <span style={{fontSize:13,fontWeight:500,color:"var(--text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{name}</span>
    </span>
  );
}

// Inline budget editor for a Categories row: shows "/ $400" (or "＋ budget"
// when unset); tap to edit. Enter/blur saves, empty clears, Escape cancels.
function BudgetEdit({limit,onSave}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(limit!=null?String(limit):"");
  const ref=useRef();
  useEffect(()=>{setVal(limit!=null?String(limit):"");},[limit]);
  useEffect(()=>{if(ed)ref.current?.select();},[ed]);
  function commit(){setEd(false);const t=val.trim();onSave(t===""?null:t);}
  if(ed) return (
    <input ref={ref} value={val} inputMode="decimal" placeholder="$/mo"
      onChange={e=>setVal(e.target.value.replace(/[^0-9.]/g,""))}
      onBlur={commit}
      onKeyDown={e=>{if(e.key==="Enter")commit();if(e.key==="Escape"){setEd(false);setVal(limit!=null?String(limit):"");}}}
      style={{font:"inherit",fontSize:16,width:76,color:"var(--text)",background:"var(--bg)",
        border:"1px solid var(--border)",borderRadius:6,padding:"1px 6px",outline:"none",textAlign:"right"}}/>
  );
  return (
    <button onClick={()=>setEd(true)} title={limit!=null?"Tap to change the monthly budget":"Set a monthly budget"}
      style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,
        fontSize:11,color:"var(--muted)",flexShrink:0}}>
      {limit!=null?`/ ${fmt(limit)}`:"＋ budget"}
    </button>
  );
}

// `surface` = the token value of whatever the pill sits on (every pill sits on a
// card today). The tint, the label ink and the dot are all derived from `color`
// against it, so the same stored colour stays legible in either theme.
function Pill({label,color,surface}) {
  const c=chipOn(color,surface);
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,background:c.bg,color:c.ink,
    borderRadius:20,padding:"2px 8px",fontWeight:600}}>
    <span style={{width:5,height:5,borderRadius:"50%",background:c.dot,display:"inline-block"}}/>
    {label}
  </span>;
}

export default function Dashboard({ refreshTick = 0 }) {
  const now = new Date();
  const [year,setYear]=useState(now.getFullYear());
  const [month,setMonth]=useState(now.getMonth()+1);
  const [tab,setTab]=useState("overview");
  const [loading,setLoading]=useState(true);
  const [lastUpd,setLastUpd]=useState(null);
  const [error,setError]=useState(null);
  const [overview,setOverview]=useState(null);
  const [spending,setSpending]=useState(null);
  const [transactions,setTransactions]=useState(null);
  const [cashFlow,setCashFlow]=useState(null);
  const [accounts,setAccounts]=useState([]);
  const [budgets,setBudgets]=useState({});
  const [txAcctFilter,setTxAcctFilter]=useState(null);
  const [searchQ,setSearchQ]=useState("");
  const [searchRes,setSearchRes]=useState(null);
  const [searching,setSearching]=useState(false);
  const searchSeq=useRef(0);
  const [selAcct,setSelAcct]=useState(null);
  const [acctTxs,setAcctTxs]=useState(null);
  const [acctHasMore,setAcctHasMore]=useState(false);
  const [acctLoading,setAcctLoading]=useState(false);
  const [recurring,setRecurring]=useState(null);
  const [recLoading,setRecLoading]=useState(false);
  const [customColors,setCustomColors]=useState({});
  const [customNames,setCustomNames]=useState({});
  const [customCats,setCustomCats]=useState([]);
  const [ready,setReady]=useState(false);
  const [addingCat,setAddingCat]=useState(false);
  const [newName,setNewName]=useState("");
  const [newColor,setNewColor]=useState("#7F77DD");
  const [chatMsgs,setChatMsgs]=useState([]);
  const [chatInput,setChatInput]=useState("");
  const [chatBusy,setChatBusy]=useState(false);
  const [chatError,setChatError]=useState(null);
  const [asstModel,setAsstModel]=useState(DEFAULT_MODEL);
  const [asstEffort,setAsstEffort]=useState(DEFAULT_EFFORT);
  const chatEndRef=useRef(null);
  const didInitialSync=useRef(false);

  // Theme. useTheme owns the persistence (localStorage, NOT the shared
  // `settings` table — that would flip the other person's phone) and the OS
  // listener: it subscribes only while the preference is 'system' and returns
  // the unsubscribe, so an explicit choice is never overridden. Declared BEFORE
  // useSurfaces so its effect applies the theme first and the tokens below are
  // read after the change, not before it.
  const {pref:themePref,resolved:themeResolved,cycleTheme}=useTheme();
  const surf=useSurfaces(themeResolved);
  const themeUi=THEME_UI[themePref]||THEME_UI.system;
  const themeNext=THEME_UI[THEME_PREFS[(THEME_PREFS.indexOf(themePref)+1)%THEME_PREFS.length]]||THEME_UI.system;
  const themeTitle=`Theme: ${themeUi.label}${themePref==="system"?` — following your device, ${themeResolved} right now`:""}. Tap for ${themeNext.label}.`;

  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[chatMsgs,chatBusy]);

  async function sendChat(text){
    const q=(text??chatInput).trim();
    if(!q||chatBusy)return;
    setChatError(null);
    setChatInput("");
    const next=[...chatMsgs,{role:"user",content:q}];
    setChatMsgs(next);
    setChatBusy(true);
    try{
      const res=await askAssistant(next,{model:asstModel,effort:asstEffort});
      setChatMsgs(prev=>[...prev,{role:"assistant",content:res.reply}]);
    }catch(err){
      console.error("assistant failed",err);
      setChatError(err.detail?.message||err.detail?.error||"The assistant couldn't answer — try again.");
    }finally{
      setChatBusy(false);
    }
  }

  useEffect(()=>{
    async function load(){
      try {
        const [c,n,cc,am,ae]=await Promise.all([
          getSetting("dash:colors").catch(()=>null),
          getSetting("dash:names").catch(()=>null),
          getSetting("dash:cats").catch(()=>null),
          getSetting("asst:model").catch(()=>null),
          getSetting("asst:effort").catch(()=>null),
        ]);
        if(c)setCustomColors(JSON.parse(c));
        if(n)setCustomNames(JSON.parse(n));
        if(cc)setCustomCats(JSON.parse(cc));
        if(am&&ASSISTANT_MODELS[am])setAsstModel(am);
        if(ae&&EFFORT_LEVELS.includes(ae))setAsstEffort(ae);
      } catch{}
      setReady(true);
    }
    load();
  },[]);

  const getColor=useCallback((cat)=>customColors[cat]||DEFAULT_COLORS[cat]||"#888780",[customColors]);
  const getName=useCallback((cat)=>customNames[cat]||cat,[customNames]);

  async function saveColors(next){setCustomColors(next);try{await setSetting("dash:colors",JSON.stringify(next));}catch{}}
  async function saveNames(next){setCustomNames(next);try{await setSetting("dash:names",JSON.stringify(next));}catch{}}
  async function saveCats(next){setCustomCats(next);try{await setSetting("dash:cats",JSON.stringify(next));}catch{}}
  function saveAsstModel(m){setAsstModel(m);setSetting("asst:model",m).catch(()=>{});}
  function saveAsstEffort(e){setAsstEffort(e);setSetting("asst:effort",e).catch(()=>{});}

  const isCurrent = year===now.getFullYear()&&month===now.getMonth()+1;
  const canNext = !(year===now.getFullYear()&&month>=now.getMonth()+1);

  function prevMonth(){if(month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1);}
  function nextMonth(){if(!canNext)return;if(month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1);}

  const reloadData=useCallback(async(y,m)=>{
    setError(null);
    const cur=y===now.getFullYear()&&m===now.getMonth()+1;
    try{
      const[ov,sp,tx,cf,ac,bu]=await Promise.all([
        cur?getOverview():Promise.resolve(null),
        getSpending({year:y,month:m}),
        getTransactions({year:y,month:m}),
        getCashFlow({num_periods:6}),
        getAccounts(),
        // Tolerate the budgets table not existing yet (migration lands at merge).
        getBudgets().catch(()=>({budgets:{}})),
      ]);
      setOverview(ov);setSpending(sp);setTransactions(tx);setCashFlow(cf);
      setAccounts(ac.accounts||[]);
      setBudgets(bu.budgets||{});
      setRecurring(null); // recompute lazily on next Recurring-tab visit
      setLastUpd(new Date());
    }catch(err){
      console.error(err);
      setError("Couldn't load data from local cache.");
    }
  },[]);

  const fetchData=useCallback(async(y,m,{sync=false}={})=>{
    setLoading(true);
    if(sync){
      try{ await runSync(); }
      catch(err){ console.error("sync failed",err); setError("Sync with Plaid failed. Showing cached data."); }
    }
    await reloadData(y,m);
    setLoading(false);
  },[reloadData]);

  useEffect(()=>{
    if(!ready)return;
    const syncFirst=!didInitialSync.current;
    if(syncFirst)didInitialSync.current=true;
    fetchData(year,month,{sync:syncFirst});
  },[year,month,ready,refreshTick,fetchData]);

  // Recurring detection is lazy: fetched + computed the first time the tab
  // opens (6-month query), cached until the next data reload.
  useEffect(()=>{
    if(tab!=="recurring"||recurring||recLoading)return;
    setRecLoading(true);
    getRecurringCandidates()
      .then(res=>setRecurring(detectRecurring(res.transactions)))
      .catch(err=>{console.error(err);setRecurring([]);})
      .finally(()=>setRecLoading(false));
  },[tab,recurring,recLoading]);

  // Cross-month search: debounced 300ms, min 2 chars; the sequence id drops
  // stale responses so fast typing can't render out-of-order results.
  useEffect(()=>{
    const q=searchQ.trim();
    const id=++searchSeq.current;
    if(q.length<2){setSearchRes(null);setSearching(false);return;}
    setSearching(true);
    const h=setTimeout(()=>{
      searchTransactions(q)
        .then(res=>{if(searchSeq.current===id){setSearchRes(res);setSearching(false);}})
        .catch(err=>{console.error("search failed",err);if(searchSeq.current===id){setSearchRes({transactions:[],hasMore:false});setSearching(false);}});
    },300);
    return ()=>clearTimeout(h);
  },[searchQ]);

  // Drill-in: load all transactions for the selected account
  useEffect(()=>{
    if(!selAcct){setAcctTxs(null);setAcctHasMore(false);return;}
    let cancelled=false;
    setAcctLoading(true);
    getAccountTransactions(selAcct.id)
      .then(res=>{if(!cancelled){setAcctTxs(res.transactions);setAcctHasMore(res.hasMore);}})
      .catch(err=>{console.error(err);if(!cancelled)setAcctTxs([]);})
      .finally(()=>{if(!cancelled)setAcctLoading(false);});
    return ()=>{cancelled=true;};
  },[selAcct]);

  // Account badge helpers: nickname (or name) + color identify which account
  // a transaction came from, on every tab.
  const acctById=useCallback(id=>accounts.find(a=>a.id===id),[accounts]);
  const acctLabel=useCallback(a=>a?(a.nickname||`${a.name}${a.mask?" ··"+a.mask:""}`):null,[]);
  const acctInst=useCallback(a=>a?.institutions?.display_name||a?.institutions?.name||"",[]);
  const acctColor=useCallback(a=>{
    if(!a)return "#888780";
    if(a.color)return a.color;
    const i=accounts.findIndex(x=>x.id===a.id);
    return ACCOUNT_COLORS[(i>=0?i:0)%ACCOUNT_COLORS.length];
  },[accounts]);

  async function saveAccount(id,fields){
    setAccounts(prev=>prev.map(a=>a.id===id?{...a,...fields}:a));
    if(selAcct?.id===id)setSelAcct(prev=>({...prev,...fields}));
    try{await updateAccount(id,fields);}catch(err){console.error("account update failed",err);}
  }

  const [unlinking,setUnlinking]=useState(false);
  const [togglingHide,setTogglingHide]=useState(false);
  const [selTx,setSelTx]=useState(null);
  const [importing,setImporting]=useState(false);

  // Optimistic transaction edit: update every local copy immediately,
  // persist, then refresh totals in the background.
  async function saveTx(fields){
    if(!selTx)return;
    const id=selTx.id;
    const apply=t=>{
      if(t.id!==id)return t;
      const next={...t,...fields};
      if("user_category" in fields)next.category=fields.user_category||t.auto_category;
      return next;
    };
    setTransactions(prev=>prev?{...prev,transactions:prev.transactions.map(apply)}:prev);
    setAcctTxs(prev=>prev?prev.map(apply):prev);
    setSelTx(prev=>prev?apply(prev):prev);
    try{
      await updateTransaction(id,fields);
    }catch(err){
      console.error("transaction update failed",err);
    }
    reloadData(year,month);
  }

  async function handleToggleHide(){
    if(!selAcct)return;
    setTogglingHide(true);
    try{
      await saveAccount(selAcct.id,{hidden:!selAcct.hidden});
      await reloadData(year,month);
    }finally{
      setTogglingHide(false);
    }
  }

  async function handleUnlink(){
    if(!selAcct)return;
    const siblings=accounts.filter(a=>a.institution_id===selAcct.institution_id);
    const instName=acctInst(selAcct)||"this bank";
    const list=siblings.map(a=>`  • ${acctLabel(a)}`).join("\n");
    const ok=window.confirm(
      `Unlink ${instName}?\n\nThis removes ${siblings.length} account${siblings.length!==1?"s":""} and all their transactions from the app:\n${list}\n\nThe bank connection is also removed from Plaid (freeing a slot). This cannot be undone — re-linking later re-imports history from Plaid.`
    );
    if(!ok)return;
    setUnlinking(true);
    try{
      await unlinkInstitution(selAcct.institution_id);
      setSelAcct(null);
      setTxAcctFilter(null);
      await reloadData(year,month);
    }catch(err){
      console.error("unlink failed",err);
      window.alert(`Unlink failed: ${err.detail?.error||err.message}`);
    }finally{
      setUnlinking(false);
    }
  }

  const cats=spending?.groups||[];
  const txs=transactions?.transactions||[];
  const shownTxs=txAcctFilter?txs.filter(t=>t.account_id===txAcctFilter):txs;
  // While a search is active the Transactions tab renders results across all
  // months instead of the selected month; account chips still filter them.
  const searchActive=searchQ.trim().length>=2;
  const searchTxs=searchRes?.transactions||[];
  const shownSearch=txAcctFilter?searchTxs.filter(t=>t.account_id===txAcctFilter):searchTxs;
  const listTxs=searchActive?shownSearch:shownTxs;
  const cfPs=cashFlow?.periods||[];
  const maxCat=cats[0]?.amount||1;
  const maxSpend=Math.max(...cfPs.map(p=>p.spending?.amount||0),1);
  const totalSpent=cats.reduce((s,c)=>s+c.amount,0);
  const balance=overview?.accounts?.[0]?.balance?.current||0;
  const lastSpent=overview?.last_month?.spending?.amount;
  const delta=lastSpent!=null?totalSpent-lastSpent:null;
  // Donut slices are non-text marks on the card -> 3:1.
  const donutData=cats.slice(0,7).map(c=>({label:getName(c.label),value:c.amount,color:markOn(getColor(c.label),surf.card)}));

  // Budgets read the getSpending() groups (not raw transactions), so when the
  // adapter's effective-category logic changes (transaction-editing branch),
  // budget progress follows automatically. Keys are raw category labels.
  const budgetCount=Object.keys(budgets).length;
  const catRows=[...cats,
    ...Object.keys(budgets).filter(k=>!cats.some(c=>c.label===k))
      .map(k=>({label:k,amount:0,transaction_count:0,percent_of_total:0}))];
  const budgetedSpent=cats.reduce((s,c)=>budgets[c.label]!=null?s+c.amount:s,0);
  const budgetedTotal=Object.values(budgets).reduce((s,v)=>s+v,0);
  const budgetLeft=budgetedTotal-budgetedSpent;

  async function saveBudget(category,val){
    const n=val==null||val===""?NaN:Number(val);
    const next={...budgets};
    if(!Number.isFinite(n)||n<=0)delete next[category];else next[category]=n;
    setBudgets(next);
    try{await setBudget(category,val);}catch(err){console.error("budget save failed",err);}
  }

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",background:"var(--bg)",minHeight:"100vh",
      color:"var(--text)"}}>
      <style>{`
        .nbtn{background:var(--card);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:all .15s;line-height:1;}
        .nbtn:hover:not(:disabled){border-color:var(--text);}
        .nbtn:disabled{opacity:.3;cursor:default;}
        .tx{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);}
        .tx:last-child{border-bottom:none;}
        .overlay{position:fixed;inset:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;z-index:100;}
        .modal{background:var(--card);border-radius:16px;padding:24px;width:320px;border:1px solid var(--border);}
        .bar-bg{flex:1;height:5px;background:var(--track);border-radius:3px;overflow:hidden;}
        .bar-fill{height:100%;border-radius:3px;transition:width .5s ease;}
      `}</style>

      <div style={{maxWidth:720,margin:"0 auto",padding:"24px 16px"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:18}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,letterSpacing:".08em",color:"var(--muted)",textTransform:"uppercase",marginBottom:4}}>Spending Dashboard</div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <button className="nbtn" onClick={prevMonth}>‹</button>
              <h1 style={{fontSize:20,fontWeight:600,letterSpacing:"-.02em",minWidth:190,textAlign:"center",color:"var(--text)"}}>
                {loading&&!lastUpd?<span style={{opacity:.4}}>Loading…</span>:monthLabel(year,month)}
              </h1>
              <button className="nbtn" onClick={nextMonth} disabled={!canNext}>›</button>
            </div>
          </div>
          {/* Header controls. `stretch` against the 40px row gives both buttons a
              40px tap target (.ibtn's own padding is ~26px, too small for a
              thumb); the header wraps this row under the month nav at 390px
              rather than overflowing or squeezing the buttons. */}
          <div style={{display:"flex",alignItems:"stretch",gap:8,minHeight:40,marginLeft:"auto"}}>
            <button className="ibtn" onClick={cycleTheme} title={themeTitle} aria-label={themeTitle}
              style={{padding:"0 12px",flexShrink:0}}>
              <span aria-hidden="true" style={{fontSize:14,lineHeight:1}}>{themeUi.icon}</span>
              {themeUi.label}
            </button>
            <button className="ibtn" onClick={()=>fetchData(year,month,{sync:true})} disabled={loading} style={{padding:"0 12px"}}>
              <span style={{display:"inline-block",animation:loading?"spin 1s linear infinite":"none"}}>↻</span>
              {lastUpd?lastUpd.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"Refresh"}
            </button>
          </div>
        </div>

        {error&&<div style={{background:"var(--danger-bg)",border:"1px solid var(--danger-border)",borderRadius:10,padding:"12px 16px",fontSize:13,color:"var(--danger)",marginBottom:14}}>{error}</div>}

        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {[
            {label:"Total spent",val:loading?null:fmt(totalSpent),sub:isCurrent&&lastSpent!=null?`vs ${fmt(lastSpent)} last month`:monthLabel(year,month)},
            {label:"Card balance",val:loading?null:fmtX(balance),sub:overview?.accounts?.[0]?.name||"Linked account"},
            {label:"vs last month",val:loading||delta==null?null:`${delta>=0?"+":""}${fmt(delta)}`,sub:delta==null?"—":delta>=0?"↑ more spending":"↓ less spending",clr:delta==null?"var(--muted)":inkOn(delta>=0?"#D85A30":"#1D9E75",surf.card)},
          ].map((c,i)=>(
            <div key={i} className="card" style={{animationDelay:i*.04+"s"}}>
              <div style={{fontSize:11,color:"var(--muted)",fontWeight:500,marginBottom:5}}>{c.label}</div>
              {loading?<Sk w="70%" h={22}/>:<div style={{fontSize:20,fontWeight:600,letterSpacing:"-.02em",marginBottom:3}}>{c.val??"—"}</div>}
              <div style={{fontSize:11,color:c.clr||"var(--muted)"}}>{loading?<Sk w="80%" h={10}/>:c.sub}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:24,padding:4,marginBottom:14,border:"1px solid var(--border)",overflowX:"auto"}}>
          {["overview","categories","transactions","accounts","trends","recurring","ask"].map(t=>(
            <button key={t} className={`tab${tab===t?" active":""}`} onClick={()=>{setTab(t);if(t!=="accounts")setSelAcct(null);}}>
              {t[0].toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>

        {/* OVERVIEW */}
        {tab==="overview"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div className="card">
              <div style={{display:"flex",alignItems:"center",gap:20}}>
                {loading?<Sk w={130} h={130} r={65}/>:<Donut data={donutData} size={130}/>}
                <div style={{flex:1}}>
                  <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",marginBottom:8,textTransform:"uppercase",letterSpacing:".05em"}}>Top categories</div>
                  {loading?[1,2,3,4].map(i=><div key={i} style={{marginBottom:8}}><Sk h={12}/></div>):
                    cats.slice(0,6).map((c,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:markOn(getColor(c.label),surf.card),flexShrink:0}}/>
                        <span style={{fontSize:12,color:"var(--text)",flex:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{getName(c.label)}</span>
                        <span style={{fontSize:12,fontFamily:"'DM Mono',monospace",color:"var(--muted)",flexShrink:0}}>{fmt(c.amount)}</span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",marginBottom:12,textTransform:"uppercase",letterSpacing:".05em"}}>Recent transactions</div>
              {loading?[1,2,3].map(i=><div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:10}}><Sk w={34} h={34} r={10}/><div style={{flex:1}}><Sk w="60%" h={13}/></div><Sk w={50} h={13}/></div>):
                txs.slice(0,6).map((t,i)=>{
                  const a=acctById(t.account_id);
                  return (
                  <div key={i} className="tx" onClick={()=>setSelTx(t)} style={{cursor:"pointer",opacity:t.excluded?.5:1}}>
                    <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span>{getName(t.category)} · {t.transaction_date}</span>
                        {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
                        {t.excluded&&<Pill label="Excluded" color="#888780" surface={surf.card}/>}
                      </div>
                    </div>
                    <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
                  </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* CATEGORIES */}
        {tab==="categories"&&(
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>
                {monthLabel(year,month)} · {fmt(totalSpent)}
              </div>
              <button className="ibtn" style={{fontSize:11}} onClick={()=>setAddingCat(true)}>+ Add category</button>
            </div>
            {budgetCount>0&&!loading&&(
              <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--bg)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,flexWrap:"wrap"}}>
                <span style={{color:"var(--muted)"}}>Budgeted <strong style={{color:"var(--text)",fontFamily:"'DM Mono',monospace"}}>{fmt(budgetedTotal)}</strong></span>
                <span style={{color:"var(--muted)"}}>·</span>
                <span style={{color:"var(--muted)"}}>Spent <strong style={{color:"var(--text)",fontFamily:"'DM Mono',monospace"}}>{fmt(budgetedSpent)}</strong></span>
                <span style={{flex:1}}/>
                <span style={{fontWeight:600,color:inkOn(budgetLeft>=0?"#1D9E75":"#D85A30",surf.bg)}}>
                  {budgetLeft>=0?`${fmt(budgetLeft)} left`:`${fmt(-budgetLeft)} over`}
                </span>
              </div>
            )}
            {loading?[1,2,3,4,5].map(i=><div key={i} style={{marginBottom:14}}><Sk h={14}/></div>):
              catRows.map((c,i)=>{
                const lim=budgets[c.label];
                const hasB=lim!=null;
                const ratio=hasB&&lim>0?c.amount/lim:0;
                // The bar sits on the --track fill, not the card: contrast is
                // computed against THAT. The #D85A30/#FAC775 pair is semantic
                // status, not palette, but it needs the same treatment to stay
                // visible on a dark track — the stored hexes are untouched.
                const barColor=markOn(hasB?(ratio>=1?"#D85A30":ratio>=0.8?"#FAC775":getColor(c.label)):getColor(c.label),surf.track);
                const barW=hasB?Math.min(ratio,1)*100:(c.amount/maxCat)*100;
                return (
                <div key={c.label} style={{marginBottom:14,animationDelay:i*.03+"s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
                      <Swatch color={getColor(c.label)} onChange={hex=>saveColors({...customColors,[c.label]:hex})}/>
                      <EditName name={getName(c.label)} onSave={v=>saveNames({...customNames,[c.label]:v})}/>
                      <span style={{fontSize:11,color:"var(--muted)",flexShrink:0,marginLeft:4}}>{c.transaction_count} txn{c.transaction_count!==1?"s":""}</span>
                    </div>
                    <div style={{display:"flex",alignItems:"baseline",gap:5,marginLeft:12,flexShrink:0}}>
                      <span style={{fontSize:13,fontFamily:"'DM Mono',monospace"}}>{fmt(c.amount)}</span>
                      <BudgetEdit limit={lim} onSave={v=>saveBudget(c.label,v)}/>
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div className="bar-bg"><div className="bar-fill" style={{width:barW+"%",background:barColor}}/></div>
                    <span style={{fontSize:11,color:hasB&&ratio>=1?inkOn("#D85A30",surf.card):"var(--muted)",width:38,textAlign:"right",flexShrink:0}}>
                      {hasB?(lim>0?Math.round(ratio*100)+"%":"—"):`${c.percent_of_total?.toFixed(0)}%`}
                    </span>
                  </div>
                </div>
                );
              })}

            {customCats.length>0&&(
              <>
                <div style={{borderTop:"1px solid var(--border)",margin:"16px 0 12px"}}/>
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Custom categories</div>
                {customCats.map(c=>(
                  <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <Swatch color={c.color} onChange={hex=>saveCats(customCats.map(cc=>cc.id===c.id?{...cc,color:hex}:cc))}/>
                    <EditName name={c.name} onSave={v=>saveCats(customCats.map(cc=>cc.id===c.id?{...cc,name:v}:cc))}/>
                    <button onClick={()=>saveCats(customCats.filter(cc=>cc.id!==c.id))}
                      style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:18,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                  </div>
                ))}
              </>
            )}
            <div style={{marginTop:16,fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px"}}>
              Click a color swatch to change it · Double-click a name to rename it · Tap ＋ budget to set a monthly limit
            </div>
          </div>
        )}

        {/* TRANSACTIONS */}
        {tab==="transactions"&&(
          <div className="card">
            <div style={{position:"relative",marginBottom:12}}>
              <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Search all transactions…"
                style={{width:"100%",padding:"9px 34px 9px 12px",borderRadius:8,border:"1px solid var(--border)",
                  background:"var(--bg)",color:"var(--text)",fontSize:16,fontFamily:"inherit",outline:"none"}}/>
              {searchQ&&(
                <button onClick={()=>setSearchQ("")} title="Clear search"
                  style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",
                    cursor:"pointer",color:"var(--muted)",fontSize:18,lineHeight:1,padding:"2px 6px"}}>×</button>
              )}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>
                {searchActive?"Search results · all months":monthLabel(year,month)}
              </div>
              <span style={{fontSize:12,color:"var(--muted)"}}>
                {searchActive
                  ?(searching?"searching…":`${shownSearch.length} match${shownSearch.length!==1?"es":""}`)
                  :`${shownTxs.length} transaction${shownTxs.length!==1?"s":""}`}
              </span>
            </div>
            {accounts.filter(a=>!a.hidden).length>1&&(
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                {/* "All accounts" has no palette colour of its own — it stays on
                    tokens (it used to ask for `var(--muted)22`, which is not a
                    colour, so its active tint never painted at all). */}
                {[{id:null,label:"All accounts",color:null},...accounts.filter(a=>!a.hidden).map(a=>({id:a.id,label:acctLabel(a),color:acctColor(a)}))].map(c=>{
                  const active=txAcctFilter===c.id;
                  const cs=c.color?chipOn(c.color,surf.card):null;
                  return (
                    <button key={c.id||"all"} onClick={()=>setTxAcctFilter(c.id)}
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,
                        background:active&&cs?cs.bg:"var(--bg)",color:active?(cs?cs.ink:"var(--text)"):"var(--muted)",
                        border:`1px solid ${active?(cs?markOn(c.color,surf.card):"var(--text)"):"var(--border)"}`,borderRadius:20,padding:"4px 10px",
                        cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>
                      {cs&&<span style={{width:6,height:6,borderRadius:"50%",display:"inline-block",
                        background:active?cs.dot:markOn(c.color,surf.bg)}}/>}
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
            {(searchActive?searching:loading)?[1,2,3,4,5].map(i=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:12}}>
                <Sk w={34} h={34} r={10}/><div style={{flex:1}}><Sk w="65%" h={13}/></div><Sk w={55} h={13}/>
              </div>
            )):listTxs.length===0?(
              <div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:14}}>
                {searchActive?`No transactions match "${searchQ.trim()}".`
                  :txAcctFilter?"No transactions for this account this month.":"No transactions for this period."}
              </div>
            ):listTxs.map((t,i)=>{
              const a=acctById(t.account_id);
              return (
              <div key={t.plaid_tx_id||i} className="tx" onClick={()=>setSelTx(t)} style={{animationDelay:i*.015+"s",cursor:"pointer",opacity:t.excluded?.5:1}}>

                <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:3,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span>{t.transaction_date}</span>
                    <span>·</span>
                    <Pill label={getName(t.category)} color={getColor(t.category)} surface={surf.card}/>
                    {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
                    {t.excluded&&<Pill label="Excluded" color="#888780" surface={surf.card}/>}
                  </div>
                </div>
                <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
              </div>
              );
            })}
            {searchActive&&!searching&&searchRes?.hasMore&&(
              <div style={{textAlign:"center",marginTop:12,fontSize:11,color:"var(--muted)"}}>
                Showing the first 200 matches — narrow your search.
              </div>
            )}
          </div>
        )}

        {/* ACCOUNTS */}
        {tab==="accounts"&&!selAcct&&(
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:4}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>Accounts</div>
              <button className="ibtn" style={{fontSize:11}} onClick={()=>setImporting(true)}>⤓ Import statement</button>
            </div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>
              Give each account a nickname and color — they tag every transaction across the app.
              Import a bank statement (CSV or PDF) to add an account that isn't connected to Plaid,
              or to check a connected one against its statement.
            </div>
            {loading&&accounts.length===0?[1,2,3].map(i=><div key={i} style={{marginBottom:12}}><Sk h={40}/></div>):
              [...accounts].sort((a,b)=>(a.hidden?1:0)-(b.hidden?1:0)).map((a,i)=>(
                <div key={a.id} className="tx" style={{cursor:"pointer",animationDelay:i*.03+"s",opacity:a.hidden?.5:1}}
                  onClick={()=>setSelAcct(a)}>
                  <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <Swatch color={acctColor(a)} onChange={hex=>saveAccount(a.id,{color:hex})}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:6}}>
                      <EditName name={acctLabel(a)} onSave={v=>saveAccount(a.id,{nickname:v})}/>
                      {isManualAccount(a)&&<Pill label="Imported" color="#7F77DD" surface={surf.card}/>}
                      {a.hidden&&<Pill label="Hidden" color="#888780" surface={surf.card}/>}
                    </div>
                    <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                      {[acctInst(a),`${a.name}${a.mask?` ··${a.mask}`:""}`,a.subtype||a.type].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500}}>{fmtX(a.current_balance??0)}</div>
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>tap to view →</div>
                  </div>
                </div>
              ))}
            {!loading&&accounts.length===0&&(
              <div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:14}}>No accounts yet. Link one to get started.</div>
            )}
            <div style={{marginTop:14,fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px"}}>
              Double-click a name to set a nickname · Click a swatch to change the badge color
            </div>
          </div>
        )}

        {tab==="accounts"&&selAcct&&(
          <div className="card">
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <button className="nbtn" onClick={()=>setSelAcct(null)} title="Back to accounts">‹</button>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{width:10,height:10,borderRadius:3,background:markOn(acctColor(selAcct),surf.card),flexShrink:0}}/>
                  <span style={{fontSize:15,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{acctLabel(selAcct)}</span>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                  {[acctInst(selAcct),`${selAcct.name}${selAcct.mask?` ··${selAcct.mask}`:""}`,selAcct.subtype||selAcct.type].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div style={{fontSize:15,fontFamily:"'DM Mono',monospace",fontWeight:600,flexShrink:0}}>{fmtX(selAcct.current_balance??0)}</div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:12}}>
              <button onClick={handleToggleHide} disabled={togglingHide}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:"1px solid var(--border)",background:"none",
                  color:"var(--text)",fontFamily:"inherit",fontSize:12,fontWeight:500,cursor:togglingHide?"default":"pointer",opacity:togglingHide?.6:1}}>
                {togglingHide?"Saving…":selAcct.hidden?"Unhide":"Hide from dashboard"}
              </button>
              {!isManualAccount(selAcct)&&(
                <button onClick={handleUnlink} disabled={unlinking}
                  style={{flex:1,padding:"8px 0",borderRadius:8,border:"1px solid var(--danger-border)",background:"none",
                    color:"var(--danger)",fontFamily:"inherit",fontSize:12,fontWeight:500,cursor:unlinking?"default":"pointer",opacity:unlinking?.6:1}}>
                  {unlinking?"Unlinking…":`Unlink ${acctInst(selAcct)||"bank"}…`}
                </button>
              )}
            </div>
            <div style={{marginTop:6,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              {isManualAccount(selAcct)
                ?"Imported account · re-import a CSV to add or correct transactions (duplicates are skipped automatically)"
                :"Hide keeps syncing but drops it from totals · Unlink removes the connection and its data"}
            </div>
            <div style={{borderTop:"1px solid var(--border)",margin:"12px 0"}}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>All transactions</div>
              {acctTxs&&<span style={{fontSize:12,color:"var(--muted)"}}>{acctTxs.length}{acctHasMore?"+":""} transaction{acctTxs.length!==1?"s":""}</span>}
            </div>
            {acctLoading?[1,2,3,4,5].map(i=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:12}}>
                <Sk w={34} h={34} r={10}/><div style={{flex:1}}><Sk w="65%" h={13}/></div><Sk w={55} h={13}/>
              </div>
            )):!acctTxs||acctTxs.length===0?(
              <div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:14}}>No transactions for this account yet.</div>
            ):(
              <>
                {acctTxs.map((t,i)=>(
                  <div key={t.plaid_tx_id||i} className="tx" onClick={()=>setSelTx(t)} style={{animationDelay:Math.min(i,20)*.015+"s",cursor:"pointer",opacity:t.excluded?.5:1}}>
                    <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:3,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span>{t.transaction_date}</span>
                        <span>·</span>
                        <Pill label={getName(t.category)} color={getColor(t.category)} surface={surf.card}/>
                        {t.excluded&&<Pill label="Excluded" color="#888780" surface={surf.card}/>}
                      </div>
                    </div>
                    <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
                  </div>
                ))}
                {acctHasMore&&(
                  <div style={{textAlign:"center",marginTop:12,fontSize:11,color:"var(--muted)"}}>
                    Showing the most recent 500 transactions.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ASK */}
        {tab==="ask"&&(
          <div className="card" style={{display:"flex",flexDirection:"column",minHeight:420}}>
            <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Ask about your spending</div>
            {(()=>{
              const m=ASSISTANT_MODELS[asstModel]||ASSISTANT_MODELS[DEFAULT_MODEL];
              const est=estimateCostRange(asstModel,asstEffort);
              const selStyle={fontSize:12,fontFamily:"inherit",color:"var(--text)",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,padding:"6px 8px",cursor:"pointer",outline:"none"};
              return (
                <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:8,marginBottom:12,paddingBottom:12,borderBottom:"1px solid var(--border)"}}>
                  <select value={asstModel} onChange={e=>saveAsstModel(e.target.value)} style={selStyle}>
                    {Object.entries(ASSISTANT_MODELS).map(([id,cfg])=>(
                      <option key={id} value={id}>{cfg.label} · {cfg.blurb}</option>
                    ))}
                  </select>
                  {m.effort&&(
                    <select value={asstEffort} onChange={e=>saveAsstEffort(e.target.value)} style={selStyle}>
                      {EFFORT_LEVELS.map(l=>(<option key={l} value={l}>{l} effort</option>))}
                    </select>
                  )}
                  {est&&(
                    <span title="Rough estimate. Low = a follow-up in an ongoing chat (context served from cache); high = the first question of a chat. Actual cost depends on answer length."
                      style={{fontSize:11,color:"var(--muted)",fontFamily:"'DM Mono',monospace",marginLeft:"auto"}}>
                      ~{formatCents(est.low)}–{formatCents(est.high)}/question
                    </span>
                  )}
                </div>
              );
            })()}
            <div style={{flex:1,overflowY:"auto",marginBottom:12}}>
              {chatMsgs.length===0&&!chatBusy&&(
                <div>
                  <div style={{fontSize:13,color:"var(--muted)",marginBottom:12,lineHeight:1.5}}>
                    Claude can see your accounts and the last 90 days of transactions, and answers questions with your real numbers. Try:
                  </div>
                  {["How much did I spend on dining out this month vs last?",
                    "What subscriptions am I paying for?",
                    "Where could I realistically cut $200/month?",
                    "Any unusual charges recently?"].map(q=>(
                    <button key={q} onClick={()=>sendChat(q)}
                      style={{display:"block",width:"100%",textAlign:"left",fontSize:12,fontFamily:"inherit",color:"var(--text)",
                        background:"var(--bg)",border:"1px solid var(--border)",borderRadius:10,padding:"9px 12px",marginBottom:6,cursor:"pointer"}}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {chatMsgs.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:8}}>
                  <div style={{maxWidth:"85%",fontSize:13,lineHeight:1.5,whiteSpace:"pre-wrap",borderRadius:12,padding:"8px 12px",
                    background:m.role==="user"?"var(--accent)":"var(--bg)",
                    color:m.role==="user"?"var(--accent-text)":"var(--text)",
                    border:m.role==="user"?"none":"1px solid var(--border)"}}>
                    {m.content}
                  </div>
                </div>
              ))}
              {chatBusy&&(
                <div style={{display:"flex",justifyContent:"flex-start",marginBottom:8}}>
                  <div style={{fontSize:13,color:"var(--muted)",borderRadius:12,padding:"8px 12px",background:"var(--bg)",border:"1px solid var(--border)"}}>
                    <span style={{display:"inline-block",animation:"pulse 1.2s ease-in-out infinite"}}>Thinking…</span>
                  </div>
                </div>
              )}
              {chatError&&(
                <div style={{fontSize:12,color:"var(--danger)",background:"var(--danger-bg)",border:"1px solid var(--danger-border)",borderRadius:8,padding:"8px 12px",marginBottom:8}}>
                  {chatError}
                </div>
              )}
              <div ref={chatEndRef}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")sendChat();}}
                placeholder="Ask about your spending…" disabled={chatBusy}
                style={{flex:1,padding:"10px 12px",borderRadius:10,border:"1px solid var(--border)",background:"var(--bg)",
                  color:"var(--text)",fontSize:13,fontFamily:"inherit",outline:"none"}}/>
              <button onClick={()=>sendChat()} disabled={chatBusy||!chatInput.trim()}
                style={{padding:"0 16px",borderRadius:10,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",
                  fontSize:13,fontWeight:500,cursor:chatBusy||!chatInput.trim()?"default":"pointer",opacity:chatBusy||!chatInput.trim()?.5:1}}>
                Send
              </button>
            </div>
            <div style={{marginTop:8,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              Read-only: the assistant sees your data but can't change anything. Conversations aren't saved.
            </div>
          </div>
        )}

        {/* TRENDS */}
        {tab==="trends"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:16}}>6-month spending</div>
              {loading?<Sk h={140}/>:(
                <>
                  <div style={{display:"flex",alignItems:"flex-end",gap:8,height:130,marginBottom:8}}>
                    {cfPs.map((p,i)=>{
                      // Pixels, not a percentage: the column below is auto-height
                      // (the row only bottom-aligns it), so a % height has nothing
                      // definite to resolve against and every bar collapsed to
                      // minHeight. 114 = the 130px row minus the amount label + gap.
                      const h=Math.max((p.spending.amount/maxSpend)*114,3);
                      const pStart=new Date(p.start);
                      const isSel=pStart.getFullYear()===year&&pStart.getMonth()+1===month;
                      return (
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                          <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"var(--muted)",whiteSpace:"nowrap"}}>{fmt(p.spending.amount)}</span>
                          <div onClick={()=>{setYear(pStart.getFullYear());setMonth(pStart.getMonth()+1);setTab("overview");}}
                            title={`View ${p.label}`}
                            style={{width:"100%",height:h,minHeight:4,background:isSel?"var(--accent)":"var(--track)",
                              borderRadius:"4px 4px 0 0",transition:"all .4s ease",cursor:"pointer"}}
                            onMouseEnter={e=>e.currentTarget.style.opacity=".7"}
                            onMouseLeave={e=>e.currentTarget.style.opacity="1"}/>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    {cfPs.map((p,i)=>{
                      const pStart=new Date(p.start);
                      return <div key={i} onClick={()=>{setYear(pStart.getFullYear());setMonth(pStart.getMonth()+1);setTab("overview");}}
                        style={{flex:1,textAlign:"center",fontSize:10,color:"var(--muted)",cursor:"pointer"}}>{p.label.split(" ")[0]}</div>;
                    })}
                  </div>
                  <div style={{marginTop:12,padding:"10px 14px",background:"var(--bg)",borderRadius:8,fontSize:12,color:"var(--muted)"}}>
                    Avg: <strong style={{color:"var(--text)"}}>{fmt(cashFlow?.averages?.spending?.amount||0)}/mo</strong>
                    <span style={{margin:"0 8px"}}>·</span>Click a bar to jump to that month
                  </div>
                </>
              )}
            </div>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:14}}>Income vs spending</div>
              {loading?<Sk h={100}/>:cfPs.map((p,i)=>{
                const sw=maxSpend?(p.spending.amount/maxSpend)*100:0;
                const iw=maxSpend?(p.income.amount/maxSpend)*100:0;
                return (
                  <div key={i} style={{marginBottom:14}}>
                    <div style={{fontSize:12,fontWeight:500,marginBottom:5}}>{p.label}</div>
                    {/* Bar fills sit on the --track, so that is what they are
                        contrasted against — not the card. */}
                    {[{label:"Spend",w:sw,color:markOn("#D85A30",surf.track),val:p.spending.amount},
                      {label:"Income",w:iw,color:markOn("#1D9E75",surf.track),val:p.income.amount}].map(row=>(
                      <div key={row.label} style={{display:"flex",gap:6,alignItems:"center",marginBottom:3}}>
                        <span style={{fontSize:11,color:"var(--muted)",width:44}}>{row.label}</span>
                        <div className="bar-bg"><div className="bar-fill" style={{width:row.w+"%",background:row.color}}/></div>
                        <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:"var(--muted)",width:54,textAlign:"right"}}>{fmt(row.val)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Cash flow</div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Net cash into your checking account(s) each month — money in minus money out. Internal savings transfers are excluded.</div>
              {loading?<Sk h={100}/>:(()=>{
                const nets=cfPs.map(p=>({label:p.label,net:(p.income?.amount||0)-(p.spending?.amount||0)}));
                const maxAbs=Math.max(...nets.map(n=>Math.abs(n.net)),1);
                return nets.map((n,i)=>{
                  const pos=n.net>=0;
                  const w=(Math.abs(n.net)/maxAbs)*50;
                  return (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <span style={{fontSize:12,fontWeight:500,width:44,flexShrink:0}}>{n.label.split(" ")[0]}</span>
                      <div style={{flex:1,position:"relative",height:14,background:"var(--bg)",borderRadius:7}}>
                        <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1,background:"var(--border)"}}/>
                        {/* The bar is a mark on the --bg gutter; the amount is
                            text on the card. Different surfaces, different
                            targets. */}
                        <div style={{position:"absolute",top:2,height:10,borderRadius:5,background:markOn(pos?"#1D9E75":"#D85A30",surf.bg),width:w+"%",left:pos?"50%":"auto",right:pos?"auto":"50%"}}/>
                      </div>
                      <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:500,color:inkOn(pos?"#1D9E75":"#D85A30",surf.card),width:64,textAlign:"right",flexShrink:0}}>{pos?"+":"−"}{fmt(Math.abs(n.net))}</span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* RECURRING */}
        {tab==="recurring"&&(
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Recurring charges</div>
              {recLoading||!recurring?(
                <><Sk w="40%" h={24}/><div style={{marginTop:8}}><Sk w="60%" h={11}/></div></>
              ):(
                <>
                  <div style={{fontSize:22,fontWeight:600,letterSpacing:"-.02em"}}>
                    {fmt(recurring.reduce((s,r)=>s+r.monthlyAmount,0))}<span style={{fontSize:13,color:"var(--muted)",fontWeight:500}}>/mo</span>
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>
                    {recurring.length} recurring charge{recurring.length!==1?"s":""} · detected from the last 6 months
                  </div>
                </>
              )}
            </div>
            <div className="card">
              {recLoading||!recurring?[1,2,3,4,5].map(i=>(
                <div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:12}}>
                  <Sk w={34} h={34} r={10}/><div style={{flex:1}}><Sk w="60%" h={13}/></div><Sk w={60} h={13}/>
                </div>
              )):recurring.length===0?(
                <div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:14}}>
                  No recurring charges detected yet — they show up after a few months of history.
                </div>
              ):recurring.map((r,i)=>{
                const a=acctById(r.account_id);
                return (
                <div key={r.key} className="tx" style={{animationDelay:i*.02+"s"}}>
                  <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[r.category]||"🔁"}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.name}</div>
                    <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>
                      ~every {r.avgGapDays} days · last {shortDate(r.lastDate)} · next ~{shortDate(r.nextDate)}
                    </div>
                    <div style={{marginTop:4,display:"flex",gap:5,flexWrap:"wrap"}}>
                      <Pill label={getName(r.category)} color={getColor(r.category)} surface={surf.card}/>
                      {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
                    </div>
                  </div>
                  <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>
                    {fmtX(r.monthlyAmount)}<span style={{fontSize:10,color:"var(--muted)"}}>/mo</span>
                  </div>
                </div>
                );
              })}
            </div>
            <div style={{fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px"}}>
              Detected heuristically: same merchant at a ~monthly cadence (±4 days) with similar amounts (±20%). Card payments and transfers never count.
            </div>
          </div>
        )}

        <div style={{textAlign:"center",marginTop:18,fontSize:11,color:"var(--muted)"}}>my-money</div>
      </div>

      {/* Transaction detail modal */}
      {selTx&&(()=>{
        const a=acctById(selTx.account_id);
        const allCats=[...ERA_CATEGORIES,...customCats.map(c=>c.name).filter(n=>!ERA_CATEGORIES.includes(n))];
        return (
        <div className="overlay" onClick={()=>setSelTx(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"80vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10,marginBottom:4}}>
              <div style={{fontSize:16,fontWeight:600,color:"var(--text)",minWidth:0,flex:1}}>
                <EditName name={selTx.merchant_name||selTx.description} onSave={v=>saveTx({user_description:v||null})}/>
              </div>
              <div style={{fontSize:16,fontFamily:"'DM Mono',monospace",fontWeight:600,flexShrink:0}}>{fmtX(selTx.amount)}</div>
            </div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:14,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <span>{selTx.transaction_date}</span>
              {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
              {selTx.user_description&&(
                <button onClick={()=>saveTx({user_description:null})}
                  style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:10,color:"var(--muted)",textDecoration:"underline",padding:0}}>
                  reset name
                </button>
              )}
            </div>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:-10,marginBottom:12}}>Double-click the name to rename this transaction.</div>

            <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Category</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:6}}>
              {allCats.map(cat=>{
                const active=selTx.category===cat;
                // .modal is --card, so that is the surface these tint over.
                const cs=active?chipOn(getColor(cat),surf.card):null;
                return (
                  <button key={cat} onClick={()=>saveTx({user_category:cat===selTx.auto_category?null:cat})}
                    style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                      background:cs?cs.bg:"var(--bg)",color:cs?cs.ink:"var(--muted)",
                      border:`1px solid ${active?markOn(getColor(cat),surf.card):"var(--border)"}`,transition:"all .15s"}}>
                    {getName(cat)}
                  </button>
                );
              })}
            </div>
            {selTx.user_category&&(
              <button onClick={()=>saveTx({user_category:null})}
                style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:11,color:"var(--muted)",textDecoration:"underline",padding:0,marginBottom:6}}>
                Reset to automatic ({getName(selTx.auto_category)})
              </button>
            )}

            <div style={{borderTop:"1px solid var(--border)",margin:"12px 0"}}/>
            <button onClick={()=>saveTx({excluded:!selTx.excluded})}
              style={{width:"100%",padding:"9px 0",borderRadius:8,border:"1px solid var(--border)",background:"none",
                color:"var(--text)",fontFamily:"inherit",fontSize:12,fontWeight:500,cursor:"pointer"}}>
              {selTx.excluded?"Include in spending again":"Exclude from spending"}
            </button>
            <div style={{marginTop:6,marginBottom:12,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              Excluded transactions stay visible but don't count toward totals or charts.
            </div>
            <button onClick={()=>setSelTx(null)} className="ibtn" style={{width:"100%",justifyContent:"center"}}>Done</button>
          </div>
        </div>
        );
      })()}

      {/* CSV import (standalone) */}
      {importing&&(
        <CsvImport
          accounts={accounts}
          onClose={()=>setImporting(false)}
          onImported={()=>reloadData(year,month)}
        />
      )}

      {/* Add category modal */}
      {addingCat&&(
        <div className="overlay" onClick={()=>setAddingCat(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:16,color:"var(--text)"}}>Add custom category</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Name</div>
            <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Date nights, Kids activities…"
              onKeyDown={e=>{if(e.key==="Enter"&&newName.trim()){saveCats([...customCats,{id:Date.now().toString(),name:newName.trim(),color:newColor}]);setNewName("");setNewColor("#7F77DD");setAddingCat(false);}}}
              autoFocus
              style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:14}}/>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Color</div>
            <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
              {["#7F77DD","#1D9E75","#D85A30","#378ADD","#FAC775","#D4537E","#639922","#E24B4A","#888780"].map(c=>(
                <div key={c} onClick={()=>setNewColor(c)}
                  style={{width:26,height:26,borderRadius:7,background:c,cursor:"pointer",
                    border:newColor===c?"3px solid var(--text)":"2px solid transparent",transition:"border .1s"}}/>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setAddingCat(false)} className="ibtn" style={{flex:1,justifyContent:"center"}}>Cancel</button>
              <button onClick={()=>{if(!newName.trim())return;saveCats([...customCats,{id:Date.now().toString(),name:newName.trim(),color:newColor}]);setNewName("");setNewColor("#7F77DD");setAddingCat(false);}}
                disabled={!newName.trim()}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:newName.trim()?"pointer":"default",opacity:newName.trim()?1:.5}}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
