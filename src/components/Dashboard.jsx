import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { getOverview, getSpending, getTransactions, getCashFlow, getAccounts, updateAccount, getAccountTransactions, updateTransaction, getBudgets, setBudget, getRecurringCandidates, searchTransactions, isManualAccount, isSimpleFinAccount, ACCOUNT_TYPES, setCategoryRule, applyCategoryRuleToHistory, getEnvelopes, setAssigned, setCategoryRollover, setTargetKind, fundTargets, moveMoney, getBudgetIncome, setBudgetIncome, invalidateEnvelopeSpending, isEnvelopeSchemaMissing, targetNeed, readyToAssign, envelopePace, getEnvPace, setEnvPace as persistEnvPace, monthKey, getEntities, createEntity, updateEntity, getTaxYearTransactions, getMileage, addMileage, deleteMileage, getReceiptTxIds, getDebts, getBalanceSnapshots, addManualTransaction, createManualAccount } from "../dataAdapter.js";
import { payoffWhatIf, debtFreeMonth, isMortgage } from "../debtPayoff.js";
import { SCHEDULE_E_LINES, RENTS_KEY, DEFAULT_SCHEDULE_E_MAP, scheduleEReport, entityMonthly, entityLedger, personalDeductionReport, DEDUCTION_BUCKETS, DEFAULT_DEDUCTION_MAP, mileageDeduction, scheduleECsv } from "../taxReport.js";
import { merchantKey } from "../txClassify.js";
import { patchTxShape } from "../spending.js";
import { detectRecurring } from "../recurring.js";
import { unlinkInstitution, askAssistant, getSimpleFinStatus } from "../apiClient.js";
import { ERA_CATEGORIES, UNCATEGORIZED, isBudgetableCategory } from "../categoryMap.js";
import { displayBalance, isDebtAccount as isDebtType } from "../accountBalance.js";
import { runSync } from "../sync.js";
// Lazy: both are modals rendered only on user action, and CsvImport reaches the
// whole statement-import stack — no reason for either in the initial bundle.
// A failed chunk load throws during render; App's ErrorBoundary is the net.
const CsvImport = lazy(() => import("./CsvImport.jsx"));
const SimpleFinConnect = lazy(() => import("./SimpleFinConnect.jsx"));
import ReceiptSection from "./ReceiptSection.jsx";
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
  // Amber, deliberately unlike every real category: this bucket is a prompt to
  // do something, not a spending area.
  "Uncategorized": "#C08A2E",
};

const TX_ICONS = {
  "Dining out":"🍴","Groceries":"🛒","Vehicle expenses":"🚗","Coffee and snacks":"☕",
  "Childcare":"👶","Pets":"🐾","Health and fitness":"💪","Home maintenance and improvement":"🔧",
  "Entertainment and subscriptions":"🎬","Shopping and gear":"🛍","Travel and vacation":"✈️",
  "Healthcare and pharmacy":"💊","Education":"📚","Side hustles and business":"💼",
  "Return":"↩️","Uncategorized":"❓",
};

const ACCOUNT_COLORS = ["#7F77DD","#1D9E75","#D85A30","#378ADD","#FAC775","#D4537E","#639922","#E24B4A"];

// The blue the account-type selector paints its active chip with. A palette
// value like the ones above (so it goes through chipOn/markOn against whatever
// surface it lands on), deliberately NOT --accent: the type editor is a
// settings control, not the app's primary action, and reusing --accent would
// make it compete with the "Always" button in the transaction sheet.
const TYPE_CHIP = "#378ADD";

// The green the rental-property controls paint their active chip with — same
// role as TYPE_CHIP (a settings control, not --accent), distinct hue so a
// property assignment never reads as an account-type change.
const ENTITY_CHIP = "#639922";

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
// Negatives render as −$1,234.56, not $-1,234.56 (matches money() in
// CsvImport.jsx). Debts now always display negative, and money-in transactions
// already did, so this is the common case rather than an edge one.
function fmt(n) {
  const v = Number(n);
  const s = "$"+Math.abs(v).toLocaleString("en-US",{maximumFractionDigits:0});
  return v < 0 ? "−"+s : s;
}
function fmtX(n) {
  const v = Number(n);
  const s = "$"+Math.abs(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  return v < 0 ? "−"+s : s;
}
// "$1,234" for whole dollars, "$1,234.56" when there are cents to show.
function fmtAuto(n) { return Math.round(Number(n)*100)%100===0?fmt(n):fmtX(n); }
function signed(n) { return `${n>0?"+":""}${fmtAuto(n)}`; }

// Hand a generated CSV to the user. In the installed iOS PWA, blob-URL anchor
// downloads are unreliable — the share sheet (→ Save to Files / AirDrop / a
// mail draft to the CPA) is the path that actually works there, so try it
// first and fall back to the anchor click for desktop browsers.
async function downloadCsv(filename,text,mime="text/csv"){
  try{
    const file=new File([text],filename,{type:mime});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:filename});
      return;
    }
  }catch(err){
    if(err&&err.name==="AbortError")return; // user closed the share sheet
    console.error("share failed, falling back to download",err);
  }
  try{
    const url=URL.createObjectURL(new Blob([text],{type:mime}));
    const a=document.createElement("a");
    a.href=url;a.download=filename;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  }catch(err){
    console.error("csv download failed",err);
  }
}
// Ask-tab scrollback: sessionStorage (device-local ephemera, per-tab scoping is
// the point — NOT localStorage, NOT the shared settings table). Every access is
// try/caught (Safari private mode throws on ACCESS). Only {role,content} pairs
// are ever persisted — chatBusy/chatError are transient and never stored.
// Trimmed to sit comfortably under api/assistant.js's caps (MAX_TURNS 30,
// MAX_MSG_CHARS 8000, MAX_TOTAL_CHARS 60000) so a restored history can always
// ride the next send without a 400.
const CHAT_SS_KEY="mm:askChat";
const CHAT_MAX_TURNS=30,CHAT_MSG_CHARS=8000,CHAT_TOTAL_CHARS=48000;
function trimChatForStorage(msgs){
  let out=(Array.isArray(msgs)?msgs:[])
    .filter(m=>m&&(m.role==="user"||m.role==="assistant")&&typeof m.content==="string")
    .map(m=>({role:m.role,content:m.content.slice(0,CHAT_MSG_CHARS)}))
    .slice(-CHAT_MAX_TURNS);
  let total=out.reduce((s,m)=>s+m.content.length,0);
  while(out.length>1&&total>CHAT_TOTAL_CHARS){total-=out[0].content.length;out.shift();}
  return out;
}
function readStoredChat(){
  try{
    const raw=sessionStorage.getItem(CHAT_SS_KEY);
    if(!raw)return [];
    return trimChatForStorage(JSON.parse(raw));
  }catch{return [];}
}
function writeStoredChat(msgs){
  try{
    if(!msgs.length)sessionStorage.removeItem(CHAT_SS_KEY);
    else sessionStorage.setItem(CHAT_SS_KEY,JSON.stringify(trimChatForStorage(msgs)));
  }catch{/* Safari private mode / quota — scrollback just stays in-memory */}
}
// Plain-markdown transcript for the "Save chat" export.
function chatTranscript(msgs){
  const head=`# Spending assistant chat — ${new Date().toLocaleString()}\n`;
  return head+msgs.map(m=>`\n**${m.role==="user"?"You":"Assistant"}:**\n${m.content}\n`).join("");
}
// "Jun 2027" from a 'YYYY-MM-DD' target date.
function monthYear(dateStr) {
  const [y,m]=String(dateStr||"").slice(0,7).split("-").map(Number);
  if(!y||!m) return "";
  return new Date(y,m-1,1).toLocaleString("default",{month:"short",year:"numeric"});
}
const MONO={color:"var(--text)",fontFamily:"'DM Mono',monospace"};
// The semantic money pair (under / over). Always rendered through inkOn/markOn
// against the actual surface so both themes keep contrast.
const OK_MONEY="#1D9E75",OVER_MONEY="#D85A30";
// Keeps a money input to digits with at most one leading "-" and one ".", so
// a fat-fingered "1-2" or "1.2.3" can never reach the adapter. Negatives are
// allowed only where pulling money back out is meaningful (an assignment) —
// never for a target, an income figure or the size of a move.
function numericish(s,{negative=true}={}) {
  const neg=negative&&s.trim().startsWith("-");
  const [whole,...rest]=s.replace(/[^0-9.]/g,"").split(".");
  return (neg?"-":"")+(rest.length?`${whole}.${rest.join("")}`:whole);
}

// Inline editor for a hand-entered liability figure (APR, minimum payment,
// credit limit) on a Debt card. Uncontrolled: commits the parsed number on
// blur (Enter just blurs), empty clears to null, and the field echoes back
// what was actually saved. `id` keys the remount so state can't bleed
// between accounts.
function DebtNum({id,value,onSave,placeholder,prefix,suffix,width=74}) {
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12,color:"var(--muted)"}}>
      {prefix}
      <input key={id+":"+(value??"")} inputMode="decimal" defaultValue={value??""} placeholder={placeholder}
        onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();}}
        onBlur={e=>{
          const t=numericish(e.target.value,{negative:false}).trim();
          const n=t===""?null:Number(t);
          const v=n!=null&&Number.isFinite(n)&&n>=0?n:null;
          e.target.value=v==null?"":String(v); // show what was actually saved
          if(v!==(value??null))onSave(v);
        }}
        style={{width,padding:"5px 7px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",
          color:"var(--text)",fontSize:12,fontFamily:"'DM Mono',monospace",outline:"none",textAlign:"right"}}/>
      {suffix}
    </span>
  );
}

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

// Inline funding-target editor for a Categories row: shows "/ $400" (or
// "＋ target" when unset); tap to edit. Enter/blur saves, empty clears,
// Escape cancels. The target is what you want to put IN each month (YNAB
// rule 2) — the dollars actually put in are assigned on the Budget tab.
function BudgetEdit({limit,onSave}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(limit!=null?String(limit):"");
  const ref=useRef();
  useEffect(()=>{setVal(limit!=null?String(limit):"");},[limit]);
  useEffect(()=>{if(ed)ref.current?.select();},[ed]);
  function commit(){setEd(false);const t=val.trim();onSave(t===""?null:t);}
  if(ed) return (
    <input ref={ref} value={val} inputMode="decimal" placeholder="$/mo"
      onChange={e=>setVal(numericish(e.target.value,{negative:false}))}
      onBlur={commit}
      onKeyDown={e=>{if(e.key==="Enter")commit();if(e.key==="Escape"){setEd(false);setVal(limit!=null?String(limit):"");}}}
      style={{font:"inherit",fontSize:16,width:76,color:"var(--text)",background:"var(--bg)",
        border:"1px solid var(--border)",borderRadius:6,padding:"1px 6px",outline:"none",textAlign:"right"}}/>
  );
  return (
    <button onClick={()=>setEd(true)} title={limit!=null?"Tap to change the monthly funding target":"Set a monthly funding target"}
      style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,
        fontSize:11,color:"var(--muted)",flexShrink:0}}>
      {limit!=null?`/ ${fmt(limit)}`:"＋ target"}
    </button>
  );
}

// Inline editor for the dollars assigned to a category this month — the
// envelope itself. Same interaction as BudgetEdit, but negatives are allowed
// so money can be pulled back out of an envelope and given to another.
function AssignEdit({value,onSave}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(value?String(value):"");
  const ref=useRef();
  useEffect(()=>{setVal(value?String(value):"");},[value]);
  useEffect(()=>{if(ed)ref.current?.select();},[ed]);
  function commit(){setEd(false);const t=val.trim();onSave(t===""?null:t);}
  if(ed) return (
    <input ref={ref} value={val} inputMode="decimal" placeholder="$"
      onChange={e=>setVal(numericish(e.target.value))}
      onBlur={commit}
      onKeyDown={e=>{if(e.key==="Enter")commit();if(e.key==="Escape"){setEd(false);setVal(value?String(value):"");}}}
      style={{font:"inherit",fontSize:16,width:72,color:"var(--text)",background:"var(--card)",
        border:"1px solid var(--accent)",borderRadius:6,padding:"1px 6px",outline:"none",textAlign:"right"}}/>
  );
  return (
    <button onClick={()=>setEd(true)} title="Dollars assigned to this category this month"
      style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,
        fontSize:12,fontWeight:600,color:value?"var(--text)":"var(--accent)",flexShrink:0}}>
      {value?fmtAuto(value):"＋ assign"}
    </button>
  );
}

// The household's money for the month, typed in by hand. The feed can't answer
// this trustworthily — a missed paycheck would silently read as less to
// budget — so Ready to Assign runs on a number the household states (see
// CLAUDE.md, "the income wall"). Saving offers both scopes because most months
// repeat and some don't.
function IncomeEdit({value,isDefault,onSave}) {
  const [ed,setEd]=useState(false);
  const [val,setVal]=useState(value!=null?String(value):"");
  const ref=useRef();
  useEffect(()=>{setVal(value!=null?String(value):"");},[value]);
  useEffect(()=>{if(ed)ref.current?.select();},[ed]);
  function commit(scope){setEd(false);const t=val.trim();onSave(t===""?null:t,scope);}
  if(ed) return (
    <span style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
      <input ref={ref} value={val} inputMode="decimal" placeholder="$"
        onChange={e=>setVal(numericish(e.target.value,{negative:false}))}
        onKeyDown={e=>{if(e.key==="Enter")commit("month");if(e.key==="Escape"){setEd(false);setVal(value!=null?String(value):"");}}}
        style={{font:"inherit",fontSize:16,width:96,color:"var(--text)",background:"var(--card)",
          border:"1px solid var(--accent)",borderRadius:6,padding:"2px 7px",outline:"none",textAlign:"right"}}/>
      <button className="ibtn" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>commit("month")}>This month</button>
      <button className="ibtn" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>commit("default")}>Every month</button>
    </span>
  );
  return (
    <button onClick={()=>setEd(true)} title="What the household has to budget this month"
      style={{background:"none",border:"none",cursor:"pointer",padding:0,
        fontSize:13,fontWeight:600,color:value!=null?"var(--text)":"var(--accent)",fontFamily:"'DM Mono',monospace"}}>
      {value!=null?fmtAuto(value):"＋ set income"}
      {value!=null&&<span style={{fontSize:10,fontWeight:500,color:"var(--muted)",fontFamily:"'DM Sans','Helvetica Neue',sans-serif",marginLeft:5}}>
        {isDefault?"every month":"this month"}
      </span>}
    </button>
  );
}

// Rule 2, "Embrace Your True Expenses". A monthly target is topped up every
// month; a by-date target is a sinking fund — the amount you want to have by a
// deadline, which the app spreads over the months remaining.
function TargetSheet({name,row,busy,surf,year,month,onSave,onClose}) {
  const [amount,setAmount]=useState(row?.target!=null?String(row.target):"");
  const [kind,setKind]=useState(row?.targetKind==="by_date"?"by_date":"monthly");
  const [ym,setYm]=useState(row?.targetDate?String(row.targetDate).slice(0,7):"");
  const n=Number(amount);
  const valid=Number.isFinite(n)&&n>0&&(kind==="monthly"||/^\d{4}-\d{2}$/.test(ym));
  // Mirrors targetNeed()'s by-date arithmetic so the sheet can't promise a
  // number the funder won't produce.
  const preview=(()=>{
    if(!valid) return null;
    if(kind==="monthly") return `Tops this category up to ${fmtAuto(n)} every month.`;
    // Months left count from the month BEING VIEWED, exactly as targetNeed
    // will — when budgeting ahead, "today" would overstate the runway.
    const [ty,tm]=ym.split("-").map(Number);
    const left=Math.max(1,(ty-year)*12+(tm-month)+1);
    const have=row?.rolledOver||0;
    const per=Math.max(0,(n-have)/left);
    return `${fmtAuto(n)} by ${monthYear(`${ym}-01`)} — about ${fmtAuto(per)} a month for ${left} month${left===1?"":"s"}${have>0?`, on top of the ${fmtAuto(have)} already in it`:""}.`;
  })();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:4,color:"var(--text)"}}>Funding target</div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>{name}</div>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Amount</div>
        <input value={amount} inputMode="decimal" autoFocus placeholder="0"
          onChange={e=>setAmount(numericish(e.target.value,{negative:false}))}
          style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",
            color:"var(--text)",fontSize:16,fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:14}}/>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>How to fund it</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {[["monthly","Every month"],["by_date","By a date"]].map(([k,label])=>(
            <button key={k} onClick={()=>setKind(k)}
              style={{flex:1,padding:"8px 0",borderRadius:8,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer",
                background:kind===k?"var(--accent)":"var(--input-bg)",color:kind===k?"var(--accent-text)":"var(--muted)",
                border:`1px solid ${kind===k?"var(--accent)":"var(--border)"}`}}>{label}</button>
          ))}
        </div>

        {kind==="by_date"&&(<>
          <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Needed by</div>
          <input type="month" value={ym} onChange={e=>setYm(e.target.value)}
            style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",
              color:"var(--text)",fontSize:14,fontFamily:"inherit",outline:"none",marginBottom:14}}/>
        </>)}

        <div style={{fontSize:11,color:"var(--muted)",background:"var(--input-bg)",borderRadius:8,padding:"8px 12px",marginBottom:16,minHeight:16}}>
          {preview||"Set an amount to see how this will be funded."}
        </div>

        <div style={{display:"flex",gap:8}}>
          {row?.target!=null&&(
            <button className="ibtn" disabled={busy} style={{justifyContent:"center"}}
              onClick={()=>onSave({amount:"",kind:"monthly",date:null})}>Remove</button>
          )}
          <button className="ibtn" style={{flex:1,justifyContent:"center"}} onClick={onClose}>Cancel</button>
          <button disabled={!valid||busy}
            onClick={()=>onSave({amount,kind,date:kind==="by_date"?`${ym}-01`:null})}
            style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",
              fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:valid&&!busy?"pointer":"default",opacity:valid&&!busy?1:.5}}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// Manual transaction quick-add. The only way to record cash spending — the
// feed can't see it and CSV/PDF import only backfills. Writes a manual: row via
// addManualTransaction (write-time categorization precedence + the manual:
// id/sign core live in the adapter; this is just the form).
//
// Sign: the user types a POSITIVE dollar figure — "what I spent". The app's
// convention is positive = money out, so a spend stores as typed; a refund /
// money-in is the negation, chosen by the direction toggle. The adapter takes
// an already-signed amount and never reinterprets, so the flip is done here.
//
// Category: left blank = let the write-time classifier decide (mapped_category);
// an explicit pick becomes user_category, which still wins at read time.
function QuickAddSheet({accounts,manualAccounts,allCats,getName,getColor,acctLabel,acctColor,busy,surf,onSave,onClose}) {
  const [amount,setAmount]=useState("");
  const [dir,setDir]=useState("out"); // out = spent (positive); in = refund/income (negative)
  // Commit-on-blur: <input type=date> emits complete garbage years while typing
  // ("0002-..") — see the date Gotcha. `date` is the committed value; `dateRaw`
  // tracks keystrokes and is validated (year floor) only on blur.
  const today=new Date().toISOString().slice(0,10);
  const [date,setDate]=useState(today);
  const [dateRaw,setDateRaw]=useState(today);
  const [description,setDescription]=useState("");
  const [category,setCategory]=useState(null);
  // Default target: the sole manual account, else none (created on save).
  const [acctId,setAcctId]=useState(manualAccounts.length===1?manualAccounts[0].id:(manualAccounts[0]?.id||""));
  const n=Number(amount);
  const valid=Number.isFinite(n)&&n>0&&!!description.trim()&&/^\d{4}-\d{2}-\d{2}$/.test(date);
  const commitDate=()=>{
    const v=dateRaw;
    // Year floor: reject the partial-year garbage the input emits mid-type.
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number(v.slice(0,4))>=2000){setDate(v);}
    else setDateRaw(date); // snap back to the last good value
  };
  const inputStyle={width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",
    background:"var(--input-bg)",color:"var(--text)",fontSize:16,fontFamily:"inherit",outline:"none"};
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"85vh",overflowY:"auto"}}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:4,color:"var(--text)"}}>Add transaction</div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>
          Record cash or anything the bank feed can&rsquo;t see.
        </div>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Type</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {[["out","Money out"],["in","Money in"]].map(([k,label])=>(
            <button key={k} onClick={()=>setDir(k)}
              style={{flex:1,padding:"8px 0",borderRadius:8,fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:"pointer",
                background:dir===k?"var(--accent)":"var(--input-bg)",color:dir===k?"var(--accent-text)":"var(--muted)",
                border:`1px solid ${dir===k?"var(--accent)":"var(--border)"}`}}>{label}</button>
          ))}
        </div>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Amount</div>
        <input value={amount} inputMode="decimal" autoFocus placeholder="0"
          onChange={e=>setAmount(numericish(e.target.value,{negative:false}))}
          style={{...inputStyle,fontFamily:"'DM Mono',monospace",marginBottom:14}}/>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Date</div>
        <input type="date" value={dateRaw} onChange={e=>setDateRaw(e.target.value)} onBlur={commitDate}
          style={{...inputStyle,fontSize:14,marginBottom:14}}/>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Description</div>
        <input value={description} onChange={e=>setDescription(e.target.value)} placeholder="e.g. Farmers market"
          style={{...inputStyle,marginBottom:14}}/>

        {manualAccounts.length>1&&(<>
          <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Account</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
            {manualAccounts.map(a=>{
              const active=acctId===a.id;
              const cs=active?chipOn(acctColor(a),surf.card):null;
              return (
                <button key={a.id} onClick={()=>setAcctId(a.id)}
                  style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                    background:cs?cs.bg:"var(--bg)",color:cs?cs.ink:"var(--muted)",
                    border:`1px solid ${active?markOn(acctColor(a),surf.card):"var(--border)"}`,transition:"all .15s"}}>
                  {acctLabel(a)}
                </button>
              );
            })}
          </div>
        </>)}

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>
          Category <span style={{opacity:.7}}>— optional, auto-detected if left blank</span>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
          {allCats.map(cat=>{
            const active=category===cat;
            const cs=active?chipOn(getColor(cat),surf.card):null;
            return (
              <button key={cat} onClick={()=>setCategory(active?null:cat)}
                style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                  background:cs?cs.bg:"var(--bg)",color:cs?cs.ink:"var(--muted)",
                  border:`1px solid ${active?markOn(getColor(cat),surf.card):"var(--border)"}`,transition:"all .15s"}}>
                {getName(cat)}
              </button>
            );
          })}
        </div>

        {manualAccounts.length===0&&(
          <div style={{fontSize:11,color:"var(--muted)",background:"var(--input-bg)",borderRadius:8,padding:"8px 12px",marginBottom:16}}>
            This will create an &ldquo;Imported&rdquo; account to hold manual entries.
          </div>
        )}

        <div style={{display:"flex",gap:8}}>
          <button className="ibtn" style={{flex:1,justifyContent:"center"}} onClick={onClose}>Cancel</button>
          <button disabled={!valid||busy}
            onClick={()=>onSave({acctId,date,amount:dir==="in"?-n:n,description:description.trim(),category})}
            style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",
              fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:valid&&!busy?"pointer":"default",opacity:valid&&!busy?1:.5}}>
            {busy?"Adding…":"Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Rule 3, "Roll With the Punches". Overspending one category is meant to be
// answered by taking the money from another, not by pretending the plan held.
function MoveSheet({from,rows,getName,chipFor,busy,surf,onMove,onClose}) {
  const [to,setTo]=useState("");
  const [amount,setAmount]=useState("");
  const src=rows.find(r=>r.category===from);
  const n=Number(amount);
  const valid=Number.isFinite(n)&&n>0&&!!to&&to!==from;
  const after=valid?(src?.available||0)-n:null;
  const targetRow=rows.find(r=>r.category===to);
  const overInk=inkOn(OVER_MONEY,surf.card),okInk=inkOn(OK_MONEY,surf.card);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"80vh",overflowY:"auto"}}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:4,color:"var(--text)"}}>Move money</div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>
          Out of {getName(from)} — {fmtAuto(src?.available||0)} available
        </div>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Amount</div>
        <input value={amount} inputMode="decimal" autoFocus placeholder="0"
          onChange={e=>setAmount(numericish(e.target.value,{negative:false}))}
          style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--input-bg)",
            color:"var(--text)",fontSize:16,fontFamily:"'DM Mono',monospace",outline:"none",marginBottom:14}}/>

        <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Into</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
          {rows.filter(r=>r.category!==from).map(r=>{
            const active=to===r.category;
            const c=chipFor(r.category,active);
            return (
              <button key={r.category} onClick={()=>setTo(r.category)}
                style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                  background:c.bg,color:c.ink,border:`1px solid ${c.border}`,transition:"all .15s"}}>
                {getName(r.category)}
                {r.available<0&&<span style={{color:active?c.ink:overInk,marginLeft:5}}>{fmtAuto(r.available)}</span>}
              </button>
            );
          })}
        </div>

        <div style={{fontSize:11,color:"var(--muted)",background:"var(--input-bg)",borderRadius:8,padding:"8px 12px",marginBottom:16}}>
          {valid
            ? <>Leaves {getName(from)} at <strong style={{color:after<0?overInk:"var(--text)"}}>{fmtAuto(after)}</strong>
                {" "}and brings {getName(to)} to <strong style={{color:(targetRow?.available||0)+n<0?overInk:okInk}}>{fmtAuto((targetRow?.available||0)+n)}</strong>.</>
            : "Pick an amount and a category to move it into."}
        </div>

        <div style={{display:"flex",gap:8}}>
          <button className="ibtn" style={{flex:1,justifyContent:"center"}} onClick={onClose}>Cancel</button>
          <button disabled={!valid||busy} onClick={()=>onMove(from,to,amount)}
            style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",
              fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:valid&&!busy?"pointer":"default",opacity:valid&&!busy?1:.5}}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}

// The "open the transactions behind this number" affordance, used by both the
// Categories rows and the Budget envelopes. A dotted underline rather than a
// hover state: this is a phone-first app, and hover doesn't exist there — the
// hint has to be visible without a pointer. With nothing to open it renders as
// plain text, so a dead button never invites a tap.
function DrillNum({onClick,title,style,children}) {
  if(!onClick) return <span style={style}>{children}</span>;
  return (
    <button onClick={onClick} title={title}
      style={{background:"none",border:"none",padding:0,font:"inherit",color:"inherit",cursor:"pointer",
        textDecoration:"underline",textDecorationStyle:"dotted",textDecorationColor:"var(--muted)",
        textUnderlineOffset:3,...style}}>
      {children}
    </button>
  );
}

// Every transaction the viewed month has in one category. Opened by tapping a
// category's transaction count or amount on the Categories tab, or its Spent on
// the Budget tab.
//
// The list is split by `counted` — the flag the adapter stamps from the SAME
// isSpend() predicate the bars and envelopes aggregate on. So the total printed
// here is the number that was tapped to open it, by construction, and the rows
// that are in the category but not in the total (excluded, refunds, loan
// postings) are still shown rather than silently dropped — "where did the other
// $40 go" is exactly the question this sheet exists to answer.
function CategorySheet({name,color,when,rows,surf,getName,acctById,acctLabel,acctColor,onPick,onClose}) {
  const counted=rows.filter(t=>t.counted);
  const other=rows.filter(t=>!t.counted);
  const total=counted.reduce((s,t)=>s+t.amount,0);
  const c=chipOn(color,surf.card);
  function row(t,muted){
    const a=acctById(t.account_id);
    return (
      <div key={t.id} className="tx" onClick={()=>onPick(t)} style={{cursor:"pointer",opacity:muted?.55:1}}>
        <div style={{width:30,height:30,borderRadius:9,background:"var(--bg)",display:"flex",alignItems:"center",
          justifyContent:"center",fontSize:14,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {t.merchant_name||t.description}
          </div>
          <div style={{fontSize:11,color:"var(--muted)",marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
            <span>{t.transaction_date}</span>
            {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
            {t.excluded&&<Pill label="Excluded" color="#888780" surface={surf.card}/>}
          </div>
        </div>
        <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
      </div>
    );
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}
        style={{width:"min(460px,92vw)",maxHeight:"82vh",overflowY:"auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{width:10,height:10,borderRadius:3,background:c.dot,flexShrink:0}}/>
          <span style={{fontSize:16,fontWeight:600,color:"var(--text)",minWidth:0,overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getName(name)}</span>
          <span style={{flex:1}}/>
          <span style={{fontSize:16,fontWeight:600,fontFamily:"'DM Mono',monospace",flexShrink:0}}>{fmtAuto(total)}</span>
        </div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>
          {when} · {counted.length} transaction{counted.length!==1?"s":""}
        </div>

        {rows.length===0?(
          <div style={{textAlign:"center",padding:"24px 0",color:"var(--muted)",fontSize:13}}>
            No transactions in this category this month.
          </div>
        ):counted.map(t=>row(t,false))}

        {other.length>0&&(<>
          <div style={{borderTop:"1px solid var(--border)",margin:"14px 0 10px"}}/>
          <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",
            letterSpacing:".05em",marginBottom:4}}>Not counted</div>
          <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginBottom:6}}>
            In this category, but outside the total above — excluded by hand, money coming back in,
            or posted on a loan account.
          </div>
          {other.map(t=>row(t,true))}
        </>)}

        <button onClick={onClose} className="ibtn" style={{width:"100%",justifyContent:"center",marginTop:16}}>Done</button>
      </div>
    </div>
  );
}

// Everything compiled under one rental property for the viewed tax year — the
// ledger behind the worksheet card's numbers. Opened by tapping the card's
// transaction count or its Money in / Money out; rows open the detail sheet,
// which owns the property tag, the capital flag and the receipt. Sections come
// from entityLedger (src/taxReport.js), whose totals are pinned by test to
// equal the card's entityMonthly sums — the list must add up to the number
// that was tapped. Rows come from the tax cache, which saveTx INVALIDATES
// rather than patches (the one list that refetches itself), so `busy` shows
// skeletons during the refetch instead of a stale list.
function PropertySheet({name,year,rows,busy,receiptTxIds,surf,getName,getColor,acctById,acctLabel,acctColor,onPick,onClose}) {
  const led=entityLedger(rows);
  const amber=inkOn("#C08A2E",surf.card);
  const c=chipOn(ENTITY_CHIP,surf.card);
  const head=(label,total)=>(
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:11,fontWeight:500,
      color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>
      <span>{label}</span>
      {total!=null&&<span style={{fontFamily:"'DM Mono',monospace"}}>{fmtAuto(total)}</span>}
    </div>
  );
  function row(t,muted){
    const a=acctById(t.account_id);
    // null = receipts feature not installed: show NOTHING rather than nag
    // (the getReceiptTxIds sentinel rule).
    const hasReceipt=receiptTxIds?receiptTxIds.has(t.id):null;
    return (
      <div key={t.id} className="tx" onClick={()=>onPick(t)} style={{cursor:"pointer",opacity:muted?.55:1}}>
        <div style={{width:30,height:30,borderRadius:9,background:"var(--bg)",display:"flex",alignItems:"center",
          justifyContent:"center",fontSize:14,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
            {t.merchant_name||t.description}
          </div>
          <div style={{fontSize:11,color:"var(--muted)",marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
            <span>{shortDate(t.transaction_date)}</span>
            <Pill label={getName(t.category)} color={getColor(t.category)} surface={surf.card}/>
            {a&&<Pill label={acctLabel(a)} color={acctColor(a)} surface={surf.card}/>}
            {t.is_capital&&<Pill label="Capital" color={ENTITY_CHIP} surface={surf.card}/>}
            {hasReceipt&&<span title="Receipt attached">📎</span>}
            {t.is_capital&&hasReceipt===false&&<span style={{color:amber}}>no receipt</span>}
            {t.excluded&&<Pill label="Excluded" color="#888780" surface={surf.card}/>}
          </div>
        </div>
        <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
      </div>
    );
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}
        style={{width:"min(460px,92vw)",maxHeight:"82vh",overflowY:"auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{width:10,height:10,borderRadius:3,background:c.dot,flexShrink:0}}/>
          <span style={{fontSize:16,fontWeight:600,color:"var(--text)",minWidth:0,overflow:"hidden",
            textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
          <span style={{flex:1}}/>
          <span style={{fontSize:16,fontWeight:600,fontFamily:"'DM Mono',monospace",flexShrink:0}}>
            {signed(Math.round((led.moneyIn.total-led.moneyOut.total)*100)/100)}
          </span>
        </div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>
          {year} · {rows.length} transaction{rows.length!==1?"s":""} compiled under this property
        </div>

        {busy?(<>
          <Sk h={40}/><div style={{height:8}}/><Sk h={40}/><div style={{height:8}}/><Sk h={40} w="70%"/>
        </>):rows.length===0?(
          <div style={{textAlign:"center",padding:"24px 0",color:"var(--muted)",fontSize:13}}>
            Nothing tagged to this property in {year}.
          </div>
        ):(<>
          {led.moneyIn.rows.length>0&&(<>
            {head("Money in",led.moneyIn.total)}
            {led.moneyIn.rows.map(t=>row(t,false))}
          </>)}
          {led.moneyOut.rows.length>0&&(<>
            {led.moneyIn.rows.length>0&&<div style={{borderTop:"1px solid var(--border)",margin:"14px 0 10px"}}/>}
            {head("Money out",led.moneyOut.total)}
            {led.moneyOut.rows.map(t=>row(t,false))}
          </>)}
          {led.notCounted.rows.length>0&&(<>
            <div style={{borderTop:"1px solid var(--border)",margin:"14px 0 10px"}}/>
            {head("Not counted",null)}
            <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginBottom:6}}>
              Excluded by hand — kept visible so a tagged row can't quietly vanish from the record.
            </div>
            {led.notCounted.rows.map(t=>row(t,true))}
          </>)}
        </>)}

        <button onClick={onClose} className="ibtn" style={{width:"100%",justifyContent:"center",marginTop:16}}>Done</button>
      </div>
    </div>
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
  // By-date sinking funds, kept OUT of `budgets`: their amount is a
  // multi-month total, not a monthly cap (see getBudgets).
  const [byDate,setByDate]=useState({});
  // --- Envelope budgeting (Budget tab) ---
  const [envelopes,setEnvelopes]=useState(null);
  const [income,setIncome]=useState(null);
  // Categories the user has pulled into the Budget tab to start an envelope in,
  // but hasn't assigned to yet — local only, nothing is written until they do.
  const [extraEnvCats,setExtraEnvCats]=useState([]);
  const [targetEdit,setTargetEdit]=useState(null);   // category name
  const [moveFrom,setMoveFrom]=useState(null);       // category name
  const [envBusy,setEnvBusy]=useState(false);
  const [pickingCat,setPickingCat]=useState(false);
  const monthRef=useRef(`${now.getFullYear()}-${now.getMonth()+1}`);
  const loadSeq=useRef(0);
  // Orders the two writers of envelope state (reloadData and runEnvelopeWrite)
  // against each other; loadSeq alone can't — it only orders reloads.
  const envSeq=useRef(0);
  // Envelope writes queue instead of dropping: a second edit made while the
  // first is settling must not silently vanish.
  const envChain=useRef(Promise.resolve());
  const [txAcctFilter,setTxAcctFilter]=useState(null);
  // The RAW category label (never the dash:names alias — that is what
  // user_category and every envelope table are keyed by), or null for "all".
  const [txCatFilter,setTxCatFilter]=useState(null);
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
  // --- Debt tab (lazy like recurring) ---
  const [debtData,setDebtData]=useState(null);   // {debts,totalDebt,totalMinimums,hasDebtColumns}
  const [debtLoading,setDebtLoading]=useState(false);
  const [debtSnaps,setDebtSnaps]=useState([]);   // balance_snapshots rows, oldest first (STORED sign: debts positive)
  const [debtStrategy,setDebtStrategy]=useState("snowball");
  const [debtExtra,setDebtExtra]=useState("");   // extra $/mo, text while typing
  // Per-account include-in-payoff override; the DEFAULT (no entry) is: credit
  // cards in, loans out — mortgages dominate a snowball/avalanche and make the
  // debt-free date meaningless (spec), and v1 keeps all loans opt-in.
  const [debtInclude,setDebtInclude]=useState({});
  // --- Rental & tax (Tax tab) ---
  const [entities,setEntities]=useState([]);
  const [taxYear,setTaxYear]=useState(now.getFullYear());
  const [taxData,setTaxData]=useState(null);    // {transactions} for taxYear, lazy like recurring
  const [taxLoading,setTaxLoading]=useState(false);
  // Invalidation epoch. A bare setTaxData(null) is NOT a reliable invalidation:
  // when taxData is already null (a load in flight), React bails on the
  // identical value, the effect never re-runs, and the in-flight load paints a
  // stale snapshot with nothing left to supersede it. Bumping the epoch always
  // changes a dependency, so every invalidation mints a new taxSeq and the
  // seq check drops whatever was in flight.
  const [taxEpoch,setTaxEpoch]=useState(0);
  const [mileage,setMileage]=useState([]);
  // Set of transaction ids that have a receipt photo, for the capital-expense
  // no-receipt nag + the CSV column; null = the migration isn't installed, so
  // the nag is skipped rather than firing on everything. Rides the tax cache:
  // loaded with taxData, invalidated by invalidateTax.
  const [receiptTxIds,setReceiptTxIds]=useState(null);
  // {emap:{[entityId]:{category:line|'rents'}}, dmap:{category:bucketKey}} —
  // household-shared (settings table): the tax mapping is about the money, not
  // the device.
  const [taxMaps,setTaxMaps]=useState(null);
  const [addingEntity,setAddingEntity]=useState(false);
  const [newEntityName,setNewEntityName]=useState("");
  const [mileForm,setMileForm]=useState(null);  // {on_date,miles,purpose,entity_id}
  const [customColors,setCustomColors]=useState({});
  const [customNames,setCustomNames]=useState({});
  const [customCats,setCustomCats]=useState([]);
  // Per-envelope pace-warning opt-in — { category: true }, default OFF. Stored
  // in the settings table under 'env:pace' (a JSON blob, like dash:colors) so
  // no migration is needed; read once on mount below.
  const [envPace,setEnvPace]=useState({});
  const [ready,setReady]=useState(false);
  const [addingCat,setAddingCat]=useState(false);
  const [newName,setNewName]=useState("");
  const [newColor,setNewColor]=useState("#7F77DD");
  // The category whose transactions are being drilled into (raw label), opened
  // from a Categories row or a Budget envelope.
  const [catDrill,setCatDrill]=useState(null);
  // Property drill-in on the Tax tab: the entity id whose compiled ledger is
  // open, or null. Rows come from taxData, so the sheet shows the tax cache's
  // busy state while an edit's invalidation refetches.
  const [taxDrill,setTaxDrill]=useState(null);
  // Cycling card-balance tile: id of the credit account the Overview tile
  // shows. DEVICE pref (localStorage, the mm:theme precedent — a settings-table
  // pref would flip the other phone). A stale/unresolvable id falls back to the
  // credit-first default at render time; every storage access is try/caught
  // (Safari private mode throws on ACCESS).
  const [cardTileId,setCardTileId]=useState(()=>{try{return localStorage.getItem("mm:cardTile")||null;}catch{return null;}});
  const cardSwipe=useRef(null);
  // Hydrated from sessionStorage on mount, written back on change (see
  // CHAT_SS_KEY above) — scrollback survives a same-tab reload, not tab close.
  const [chatMsgs,setChatMsgs]=useState(readStoredChat);
  const [chatInput,setChatInput]=useState("");
  const [chatBusy,setChatBusy]=useState(false);
  const [chatError,setChatError]=useState(null);
  const [asstModel,setAsstModel]=useState(DEFAULT_MODEL);
  const [asstEffort,setAsstEffort]=useState(DEFAULT_EFFORT);
  const chatEndRef=useRef(null);
  const didInitialSync=useRef(false);
  // {last_pulled_at,last_error} when the SimpleFIN feed looks unhealthy —
  // checked ONCE per mount, after the initial sync (never a status fetch on
  // every dashboard load; that was the LinkAccount antipattern).
  const [feedHealth,setFeedHealth]=useState(null);

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
  useEffect(()=>{writeStoredChat(chatMsgs);},[chatMsgs]);
  function clearChat(){
    setChatMsgs([]);setChatError(null);setChatInput("");
    try{sessionStorage.removeItem(CHAT_SS_KEY);}catch{/* private mode */}
  }

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
        const [c,n,cc,am,ae,ep]=await Promise.all([
          getSetting("dash:colors").catch(()=>null),
          getSetting("dash:names").catch(()=>null),
          getSetting("dash:cats").catch(()=>null),
          getSetting("asst:model").catch(()=>null),
          getSetting("asst:effort").catch(()=>null),
          getEnvPace().catch(()=>({})),
        ]);
        if(c)setCustomColors(JSON.parse(c));
        if(n)setCustomNames(JSON.parse(n));
        if(cc)setCustomCats(JSON.parse(cc));
        if(ep)setEnvPace(ep);
        if(am&&ASSISTANT_MODELS[am])setAsstModel(am);
        if(ae&&EFFORT_LEVELS.includes(ae))setAsstEffort(ae);
      } catch{}
      setReady(true);
    }
    load();
  },[]);

  // The custom categories the household has added, as plain names — the same
  // thing a built-in category is. De-duplicated and trimmed because the list is
  // free text the user typed.
  const customCatNames=useMemo(()=>{
    const seen=new Set(),out=[];
    for(const c of customCats||[]){
      const n=(c?.name||"").trim();
      if(n&&!seen.has(n)){seen.add(n);out.push(n);}
    }
    return out;
  },[customCats]);
  // The colour picked when a custom category was CREATED. `dash:colors` is the
  // one mutable colour store for every category, built-in or custom (that's what
  // makes a custom category's swatch behave like any other), so this is only a
  // seed — read as a fallback for categories created before that was true, and
  // written into dash:colors alongside dash:cats for every new one.
  const customCatColors=useMemo(()=>{
    const m={};
    for(const c of customCats||[]){
      const n=(c?.name||"").trim();
      if(n&&c.color&&!(n in m))m[n]=c.color;
    }
    return m;
  },[customCats]);

  const getColor=useCallback((cat)=>customColors[cat]||DEFAULT_COLORS[cat]||customCatColors[cat]||"#888780",[customColors,customCatColors]);
  const getName=useCallback((cat)=>customNames[cat]||cat,[customNames]);

  async function saveColors(next){setCustomColors(next);try{await setSetting("dash:colors",JSON.stringify(next));}catch{}}
  async function saveNames(next){setCustomNames(next);try{await setSetting("dash:names",JSON.stringify(next));}catch{}}
  async function saveCats(next){setCustomCats(next);try{await setSetting("dash:cats",JSON.stringify(next));}catch{}}

  // Adding a custom category seeds dash:colors too, so from creation onward one
  // store answers "what colour is this category" for built-in and custom alike
  // and the row's swatch edits the same place every other row's does.
  async function addCustomCat(name,color){
    const n=name.trim();
    if(!n)return;
    await Promise.all([
      customCatNames.includes(n)?Promise.resolve():saveCats([...customCats,{id:Date.now().toString(),name:n,color}]),
      saveColors({...customColors,[n]:color}),
    ]);
  }
  // Retiring one only takes the name out of the pickers. Its colour, its target
  // and any transactions already filed under it are keyed by the NAME and stay
  // exactly where they are — re-adding the same name restores all of it, which
  // is why this needs no confirmation.
  function removeCustomCat(id){saveCats(customCats.filter(c=>c.id!==id));}
  function saveAsstModel(m){setAsstModel(m);setSetting("asst:model",m).catch(()=>{});}
  function saveAsstEffort(e){setAsstEffort(e);setSetting("asst:effort",e).catch(()=>{});}

  // --- Rental & tax handlers ---
  async function saveTaxMaps(next){setTaxMaps(next);try{await setSetting("tax:maps",JSON.stringify(next));}catch(err){console.error("saving tax maps failed",err);}}
  // A fresh entity's Schedule E mapping starts from the conservative defaults;
  // the FIRST edit copies them into the stored map and edits that. Never merge
  // the defaults over a stored map — that would resurrect a default the user
  // explicitly un-mapped, making "Not mapped" a silent no-op for those rows.
  const emapFor=useCallback(id=>taxMaps?.emap?.[id]??DEFAULT_SCHEDULE_E_MAP,[taxMaps]);
  function setEmapEntry(entityId,category,value){
    const next={...emapFor(entityId)};
    if(value==null)delete next[category];else next[category]=value;
    saveTaxMaps({...(taxMaps||{dmap:{...DEFAULT_DEDUCTION_MAP}}),emap:{...(taxMaps?.emap||{}),[entityId]:next}});
  }
  function setDmapEntry(category,bucket){
    const next={...(taxMaps?.dmap||{...DEFAULT_DEDUCTION_MAP})};
    if(bucket==null)delete next[category];else next[category]=bucket;
    saveTaxMaps({...(taxMaps||{}),emap:taxMaps?.emap||{},dmap:next});
  }
  async function handleAddEntity(){
    const name=newEntityName.trim();
    if(!name)return;
    try{
      const e=await createEntity(name);
      setEntities(prev=>[...prev,e]);
      setNewEntityName("");setAddingEntity(false);
      invalidateTax();
    }catch(err){
      console.error("creating the property failed",err);
      window.alert(`Couldn't add the property: ${err.message||err}\n\nIf this is a fresh deploy, the rental-tax migration may not have been applied yet.`);
    }
  }
  async function renameEntity(id,name){
    const n=(name||"").trim();
    if(!n)return;
    setEntities(prev=>prev.map(e=>e.id===id?{...e,name:n}:e));
    try{await updateEntity(id,{name:n});}catch(err){console.error("renaming the property failed",err);}
  }
  async function setEntityArchived(id,archived){
    const at=archived?new Date().toISOString():null;
    setEntities(prev=>prev.map(e=>e.id===id?{...e,archived_at:at}:e));
    try{await updateEntity(id,{archived_at:at});}catch(err){console.error("archiving the property failed",err);}
  }
  async function handleAddMileage(){
    if(!mileForm)return;
    const miles=Number(mileForm.miles);
    if(!mileForm.on_date||!Number.isFinite(miles)||miles<=0)return;
    try{
      const row=await addMileage({on_date:mileForm.on_date,miles,purpose:mileForm.purpose,entity_id:mileForm.entity_id||null});
      // Only list it if it belongs to the year on screen.
      if(row.on_date.slice(0,4)===String(taxYear))setMileage(prev=>[row,...prev].sort((a,b)=>a.on_date<b.on_date?1:-1));
      setMileForm(null);
    }catch(err){
      console.error("adding mileage failed",err);
      window.alert(`Couldn't save the drive: ${err.message||err}`);
    }
  }
  async function handleDeleteMileage(id){
    setMileage(prev=>prev.filter(m=>m.id!==id));
    try{await deleteMileage(id);}catch(err){console.error("deleting mileage failed",err);}
  }

  const isCurrent = year===now.getFullYear()&&month===now.getMonth()+1;
  // Every other tab reports on months that have happened, so it stops at the
  // current one. Budgeting is forward-looking — assigning next month's money
  // before the month starts is the whole point of rule 1 — so the Budget tab
  // may look ahead. Leaving it snaps back (see the tab handler), because a
  // future month is empty everywhere else.
  const monthsAhead=(year-now.getFullYear())*12+(month-(now.getMonth()+1));
  const maxAhead=tab==="budget"?12:0;
  const canNext = monthsAhead<maxAhead;
  const isFuture = monthsAhead>0;

  function prevMonth(){if(month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1);}
  function nextMonth(){if(!canNext)return;if(month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1);}
  function goCurrentMonth(){setYear(now.getFullYear());setMonth(now.getMonth()+1);}

  const reloadData=useCallback(async(y,m)=>{
    setError(null);
    const cur=y===now.getFullYear()&&m===now.getMonth()+1;
    // Two month taps in quick succession leave two loads in flight, and nothing
    // guarantees they resolve in order. Without this, the slower one wins and
    // paints its month's envelopes under the other month's header — and the
    // next assignment the user types is then written to the WRONG month, which
    // rolls forward into every month after it. Same monotonic-sequence guard
    // the cross-month search already uses.
    const seq=++loadSeq.current;
    // The envelope walk reads transactions; this is the moment they may have
    // moved (a sync, an import, a recategorisation, a learned rule), so drop
    // the memoised spend sums.
    invalidateEnvelopeSpending();
    const eseq=++envSeq.current;
    try{
      const[ov,sp,tx,cf,ac,bu,en,inc,ents]=await Promise.all([
        cur?getOverview():Promise.resolve(null),
        getSpending({year:y,month:m}),
        getTransactions({year:y,month:m}),
        getCashFlow({num_periods:6}),
        getAccounts(),
        // Tolerate the budgets table not existing yet (migration lands at merge).
        getBudgets().catch(()=>({budgets:{}})),
        // Envelope schema not installed yet -> null (shows the not-set-up
        // notice). A TRANSIENT failure -> undefined (keep what's on screen) —
        // otherwise one flaky request would claim the migration never ran.
        getEnvelopes({year:y,month:m}).catch(e=>isEnvelopeSchemaMissing(e)?null:undefined),
        getBudgetIncome({year:y,month:m}).catch(()=>undefined),
        // Eager because the transaction sheet and account sheet both offer the
        // entity picker; degrades to [] until the rental-tax migration lands
        // (inside getEntities) — undefined = transient failure, keep state.
        getEntities().catch(()=>undefined),
      ]);
      if(seq!==loadSeq.current)return false;
      setOverview(ov);setSpending(sp);setTransactions(tx);setCashFlow(cf);
      setAccounts(ac.accounts||[]);
      // A transient entity-read failure keeps the previous list (the envelope
      // pattern): folding it into [] would blank the entity chips and every
      // property worksheet until the next successful reload.
      if(ents!==undefined)setEntities(ents.entities||[]);
      invalidateTax(); // recompute lazily on next Tax-tab visit
      // A completed envelope write may have painted fresher rows while this
      // reload was in flight — don't overwrite them (or the freshly saved
      // budgets/targets) with a pre-write snapshot.
      if(eseq===envSeq.current){
        setBudgets(bu.budgets||{});
        setByDate(bu.byDate||{});
        if(en!==undefined)setEnvelopes(en);
        if(inc!==undefined)setIncome(inc);
      }
      setRecurring(null); // recompute lazily on next Recurring-tab visit
      setDebtData(null);  // same: refetch balances/liability fields on next Debt-tab visit
      setLastUpd(new Date());
    }catch(err){
      if(seq!==loadSeq.current)return false;
      console.error(err);
      setError("Couldn't load data from local cache.");
    }
    return true;
  },[]);

  const fetchData=useCallback(async(y,m,{sync=false}={})=>{
    setLoading(true);
    if(sync){
      try{ await runSync(); }
      catch(err){ console.error("sync failed",err); setError("Bank sync failed. Showing cached data."); }
    }
    const live=await reloadData(y,m);
    // Don't clear the spinner on behalf of a load that has been superseded —
    // the newer one is still running.
    if(live!==false)setLoading(false);
  },[reloadData]);

  useEffect(()=>{
    if(!ready)return;
    const syncFirst=!didInitialSync.current;
    if(syncFirst)didInitialSync.current=true;
    fetchData(year,month,{sync:syncFirst}).then(()=>{
      if(!syncFirst)return;
      // The sync response can't answer "is the feed stale?" — a clean pull
      // carries no last_pulled_at — so ask /api/simplefin-status once, in the
      // same flow, after the sync has had its chance to freshen the watermark.
      getSimpleFinStatus().then(s=>{
        if(!s?.connected)return;
        const stale=s.last_pulled_at&&Date.now()-new Date(s.last_pulled_at).getTime()>3*86_400_000;
        if(s.last_error||stale)setFeedHealth({last_pulled_at:s.last_pulled_at,last_error:s.last_error||null});
      }).catch(err=>console.error("feed status check failed",err));
    });
  },[year,month,ready,refreshTick,fetchData]);

  // Recurring detection is lazy: fetched + computed the first time the tab
  // opens (6-month query), cached until the next data reload.
  useEffect(()=>{
    if(tab!=="recurring"||recurring||recLoading)return;
    setRecLoading(true);
    // Clock for dueStatus: the real wall-clock day, computed local (not the
    // viewed month), because "is this subscription overdue?" is a question
    // about today, not about whatever month the dashboard is scrolled to.
    const d=new Date();
    const today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    getRecurringCandidates()
      .then(res=>setRecurring(detectRecurring(res.transactions,today)))
      .catch(err=>{console.error(err);setRecurring([]);})
      .finally(()=>setRecLoading(false));
  },[tab,recurring,recLoading]);

  // The Debt tab is lazy the same way: the credit/loan accounts with their
  // liability fields, plus a year of balance snapshots for the history chart
  // (best-effort — the table may not exist yet; the adapter returns []).
  useEffect(()=>{
    if(tab!=="debt"||debtData||debtLoading)return;
    setDebtLoading(true);
    getDebts()
      .then(async d=>{
        try{
          const since=new Date(Date.now()-365*86400000).toISOString().slice(0,10);
          setDebtSnaps(await getBalanceSnapshots(d.debts.map(a=>a.id),since));
        }catch(err){console.error("balance snapshots load failed",err);setDebtSnaps([]);}
        setDebtData(d);
      })
      .catch(err=>{console.error("debt load failed",err);setDebtData({debts:[],totalDebt:0,totalMinimums:0,hasDebtColumns:false});})
      .finally(()=>setDebtLoading(false));
  },[tab,debtData,debtLoading]);

  // Optimistic save for a hand-entered liability field (apr / minimum_payment /
  // credit_limit / next_payment_due_date). Patches the debt cache — including
  // the derived debtRate and the two totals, the same recompute-every-derived-
  // field rule as saveTx — then writes; the accounts row is the client's own
  // (RLS-scoped) so updateAccount writes it directly.
  function saveDebt(id,fields){
    setDebtData(prev=>{
      if(!prev)return prev;
      const debts=prev.debts.map(a=>{
        if(a.id!==id)return a;
        const next={...a,...fields};
        next.debtRate=next.apr??next.interest_rate??null;
        return next;
      });
      return {...prev,debts,
        totalDebt:debts.reduce((s,a)=>s+(Number(a.current_balance)||0),0),
        totalMinimums:debts.reduce((s,a)=>s+(Number(a.minimum_payment)||0),0)};
    });
    updateAccount(id,fields).catch(err=>console.error("debt field save failed",err));
  }

  // The Tax tab is lazy the same way: a calendar year of rows + the mileage
  // log + the saved category→tax-line mappings, cached until invalidateTax
  // (below) drops it. The sequence ref is the same guard reloadData/search
  // use — and deliberately NO taxLoading in the guard or the deps: gating on
  // it would serialize loads, suppressing exactly the superseding load the
  // seq check needs, so a year tap during an in-flight load would paint the
  // old year's rows under the new header (review-caught).
  const taxSeq=useRef(0);
  useEffect(()=>{
    if(tab!=="tax"||taxData)return;
    const seq=++taxSeq.current;
    setTaxLoading(true);
    Promise.all([
      getTaxYearTransactions(taxYear),
      getMileage(taxYear).catch(err=>{console.error("mileage load failed",err);return {mileage:[]};}),
      getSetting("tax:maps").catch(()=>null),
      getReceiptTxIds().catch(err=>{console.error("receipt ids load failed",err);return null;}),
    ])
      .then(([t,m,maps,rids])=>{
        if(seq!==taxSeq.current)return;
        setTaxData(t);
        setMileage(m.mileage||[]);
        setReceiptTxIds(rids);
        setTaxMaps(prev=>{
          if(prev)return prev; // don't clobber unsaved edits with a stale read
          let parsed=null;
          try{parsed=maps?JSON.parse(maps):null;}catch{}
          return (parsed&&typeof parsed==="object")
            ?{emap:parsed.emap||{},dmap:parsed.dmap||{...DEFAULT_DEDUCTION_MAP}}
            :{emap:{},dmap:{...DEFAULT_DEDUCTION_MAP}};
        });
      })
      .catch(err=>{if(seq===taxSeq.current){console.error(err);setTaxData({transactions:[]});}})
      .finally(()=>{if(seq===taxSeq.current)setTaxLoading(false);});
  },[tab,taxData,taxYear,taxEpoch]);
  // The ONLY way to invalidate the tax cache — see the taxEpoch comment.
  const invalidateTax=useCallback(()=>{setTaxData(null);setTaxEpoch(e=>e+1);},[]);

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

  // A property pill ONLY where the ROW was tagged by hand (t.entity_id): rows
  // inheriting a dedicated rental account's default would stamp every row of
  // that account, where the account pill already carries the meaning. The
  // hand-tagged rows are the surprising ones — a fridge bought on the joint
  // card — and the pill is what makes that tag visible in the ledger.
  const entPill=useCallback(id=>{
    if(!id)return null;
    const n=entities.find(x=>x.id===id)?.name;
    return n?<Pill label={n} color={ENTITY_CHIP} surface={surf.card}/>:null;
  },[entities,surf.card]);

  async function saveAccount(id,fields){
    setAccounts(prev=>prev.map(a=>a.id===id?{...a,...fields}:a));
    if(selAcct?.id===id)setSelAcct(prev=>({...prev,...fields}));
    try{await updateAccount(id,fields);}catch(err){console.error("account update failed",err);}
  }

  const [unlinking,setUnlinking]=useState(false);
  const [togglingHide,setTogglingHide]=useState(false);
  const [selTx,setSelTx]=useState(null);
  const [importing,setImporting]=useState(false);
  const [connectingSfin,setConnectingSfin]=useState(false);
  const [quickAdd,setQuickAdd]=useState(false); // manual transaction quick-add sheet
  const [quickAddBusy,setQuickAddBusy]=useState(false);

  // Learned merchant rules: after a manual recategorization, offer to remember
  // the merchant so the correction survives the next sync/import.
  const [learnPrompt,setLearnPrompt]=useState(null); // {descriptor,key,category,count}
  const [learnedNote,setLearnedNote]=useState(null);
  const [learning,setLearning]=useState(false);
  // Clear the prompt when a different transaction is opened.
  useEffect(()=>{setLearnPrompt(null);setLearnedNote(null);},[selTx?.id]);

  // The string the classifier actually sees at write time — merchant_name is
  // SimpleFIN's `payee`, description its raw descriptor. Must match the write
  // path or a taught rule wouldn't fire on the next pull.
  const txDescriptor=useCallback(t=>t?(t.merchant_name||t.description||""):"",[]);

  // count is a NUMBER when the preview ran, or null when it couldn't — the two
  // must stay distinguishable. Folding a failure into 0 renders identically to
  // "nothing to update", which is exactly how a broken preview passed for a
  // working one: the row being edited always matches its own rule, so a real 0
  // is only possible when the merchant appears nowhere else.
  async function offerToLearn(category){
    if(!selTx)return;
    const descriptor=txDescriptor(selTx);
    const key=merchantKey(descriptor);
    if(!key)return;
    let count=null,previewError=null;
    try{ count=await applyCategoryRuleToHistory(descriptor,category,{dryRun:true}); }
    catch(err){ console.error("rule preview failed",err); previewError=err.message||String(err); }
    setLearnPrompt({descriptor,key,category,count,previewError});
  }

  // A rule rewrites OTHER transactions, so there is no id to patch and the
  // optimistic path can't help: the lists reloadData doesn't cover have to be
  // refetched or the relabelled rows keep their old category on screen — the
  // "it didn't apply to the others" symptom.
  const refetchOpenLists=useCallback(async()=>{
    const q=searchQ.trim();
    await Promise.all([
      q.length>=2
        ? searchTransactions(q).then(setSearchRes).catch(err=>console.error("search refresh failed",err))
        : Promise.resolve(),
      selAcct
        ? getAccountTransactions(selAcct.id)
            .then(res=>{setAcctTxs(res.transactions);setAcctHasMore(res.hasMore);})
            .catch(err=>console.error("account list refresh failed",err))
        : Promise.resolve(),
    ]);
  },[searchQ,selAcct]);

  async function learnMerchant(){
    if(!learnPrompt)return;
    setLearning(true);
    try{
      await setCategoryRule(learnPrompt.descriptor,learnPrompt.category);
      const n=await applyCategoryRuleToHistory(learnPrompt.descriptor,learnPrompt.category);
      setLearnPrompt(null);
      // Say which of the two things happened. "Remembered" alone reads as
      // success even when nothing was relabelled.
      setLearnedNote(n>0
        ? `Remembered — ${learnPrompt.key} is ${getName(learnPrompt.category)}, and ${n} past transaction${n!==1?"s":""} updated.`
        : `Remembered — ${learnPrompt.key} is ${getName(learnPrompt.category)}. No past transactions needed changing; future ones will use it.`);
      await reloadData(year,month);
      await refetchOpenLists();
    }catch(err){
      console.error("learning the merchant failed",err);
      setLearnPrompt(null);
      setLearnedNote(null);
      window.alert(`Couldn't save that rule: ${err.message||err}`);
    }finally{
      setLearning(false);
    }
  }

  // The ONE optimistic patch for a transaction edit. EVERY list holding
  // transaction rows is patched here, not at the call site — reloadData
  // refreshes only the current month, so search results (cross-month) and the
  // account sheet are never refetched and this patch is all they get; three
  // shipped bugs each came from a caller forgetting one list or one derived
  // field (the saveTx Gotcha in CLAUDE.md). The derived-field recompute
  // (`category`, `merchant_name`) lives INSIDE patchTxShape (src/spending.js,
  // mirroring what toTxShape derives) so a caller can't skip it. `counted`
  // can't be recomputed — it needs the account type, which the shape doesn't
  // carry — but its only reader is the category drill-in, whose rows come from
  // `transactions`, which reloadData refetches.
  // Returns a rollback that puts each list's own captured pre-patch row back,
  // for the failed-write path — without it the lists reloadData never reaches
  // keep asserting a save that didn't land.
  function patchAllTxLists(id,fields){
    const apply=t=>t.id===id?patchTxShape(t,fields):t;
    // Capture per list — the lists hold distinct row objects, and this runs
    // from an event handler, so the closed-over state is current.
    const before={
      month:transactions?.transactions.find(t=>t.id===id)||null,
      acct:acctTxs?.find(t=>t.id===id)||null,
      search:searchRes?.transactions.find(t=>t.id===id)||null,
      sel:selTx&&selTx.id===id?selTx:null,
    };
    setTransactions(prev=>prev?{...prev,transactions:prev.transactions.map(apply)}:prev);
    setAcctTxs(prev=>prev?prev.map(apply):prev);
    setSearchRes(prev=>prev?{...prev,transactions:prev.transactions.map(apply)}:prev);
    setSelTx(prev=>prev?apply(prev):prev);
    return()=>{
      const put=row=>t=>t.id===id?row:t;
      if(before.month)setTransactions(prev=>prev?{...prev,transactions:prev.transactions.map(put(before.month))}:prev);
      if(before.acct)setAcctTxs(prev=>prev?prev.map(put(before.acct)):prev);
      if(before.search)setSearchRes(prev=>prev?{...prev,transactions:prev.transactions.map(put(before.search))}:prev);
      // Only if the sheet still shows this row — the user may have moved on.
      if(before.sel)setSelTx(prev=>prev&&prev.id===id?before.sel:prev);
    };
  }

  // Optimistic transaction edit: patch every local copy immediately, persist,
  // then refresh totals in the background. A failed write ROLLS THE PATCH BACK
  // and says so (learnMerchant's failure pattern) — before this, the patched
  // lists kept showing a save that never landed.
  async function saveTx(fields){
    if(!selTx)return;
    const rollback=patchAllTxLists(selTx.id,fields);
    // Any edit can move a row in or out of a tax report (category, entity,
    // capital flag, exclusion) — drop the cached year and recompute lazily.
    // This pre-write invalidation may start a load that races the UPDATE, but
    // reloadData below runs after the write and bumps the epoch again, which
    // supersedes any pre-commit snapshot (the seq check drops it).
    invalidateTax();
    try{
      await updateTransaction(selTx.id,fields);
    }catch(err){
      console.error("transaction update failed",err);
      rollback();
      window.alert(`Couldn't save that change: ${err.message||err}`);
    }
    reloadData(year,month);
  }

  // Manual transaction quick-add save. If no manual account exists yet, create
  // the household "Imported" account first (reusing the CSV-import machinery),
  // then insert. On success, optimistically SHOW the new row: patchAllTxLists
  // only maps EXISTING rows by id, so a brand-new row can't ride it — the row
  // is prepended straight into `transactions` when its date falls in the viewed
  // month (the one list the tab renders), then reloadData refreshes the totals
  // and canonical ordering. A viewed-month miss just relies on reloadData.
  async function addManualTx({acctId,date,amount,description,category}){
    setQuickAddBusy(true);
    try{
      let targetId=acctId;
      if(!targetId){
        const acct=await createManualAccount({name:"Imported"});
        targetId=acct.id;
      }
      const row=await addManualTransaction({accountId:targetId,date,amount,description,category:category||undefined});
      // Optimistic insert into the viewed month's list (date is YYYY-MM-DD).
      const inView=date.slice(0,7)===`${year}-${String(month).padStart(2,"0")}`;
      if(inView){
        setTransactions(prev=>prev
          ?{...prev,transactions:[row,...prev.transactions].sort((a,b)=>(b.transaction_date||"").localeCompare(a.transaction_date||""))}
          :prev);
      }
      setQuickAdd(false);
      await reloadData(year,month); // canonical totals + ordering
    }catch(err){
      console.error("manual transaction add failed",err);
      window.alert(`Couldn't add that transaction: ${err.message||err}`);
    }finally{
      setQuickAddBusy(false);
    }
  }

  // From the detail sheet's "Compiled under X in the Tax tab" link: close
  // every overlay, land on the Tax tab on the TRANSACTION'S year (the viewed
  // tax year may differ — a January sheet showing a December row), and open
  // that property's drill-in. The confirmation loop for "did my tag actually
  // make the tax records?".
  function jumpToTax(entityId){
    const t=selTx;
    setSelTx(null);setCatDrill(null);setSelAcct(null);
    const y=Number((t?.transaction_date||"").slice(0,4));
    if(y&&y!==taxYear&&y<=now.getFullYear()){setTaxYear(y);invalidateTax();}
    setTaxDrill(entityId);
    setTab("tax");
  }

  // Correcting an inferred type can cross the debt boundary (Bank ⇄ Credit
  // card/Loan), and the STORED balance was normalized under the old type: a
  // card mis-inferred as a bank stored SimpleFIN's raw negative, so the moment
  // it is retyped as credit, displayBalance negates it and the card reads
  // +$5,127.97 — backwards, and on exactly the phase-3 screen where types get
  // fixed. The stored sign can't be recovered locally (we can't tell a flipped
  // value from an unflipped one), so re-pull: the feed is authoritative and
  // api/sync.js re-normalizes against the corrected type. `force` skips the
  // once-an-hour throttle. Only on a boundary crossing — credit→loan is free.
  const [retyping,setRetyping]=useState(false);
  // `fed` = the balance comes from SimpleFIN. Crossing the debt boundary flips
  // the sign convention the stored balance must follow (positive = owed), and
  // only the feed can restate it — so a fed account re-syncs. A manual account's
  // balance was typed in by hand and no pull will ever correct it, so re-syncing
  // there would burn a SimpleFIN request and, worse, imply the number had been
  // fixed when nothing touched it.
  async function saveAccountType(id,fields,prevType,fed){
    const crossed=isDebtType(prevType)!==isDebtType(fields.type);
    await saveAccount(id,fields);
    // Any type change can move the account across isLoanAccount(), which sits
    // inside isSpend() — the memoised envelope spend sums and the fetched
    // spending state are both stale now, re-sync or not.
    if(prevType!==fields.type){invalidateEnvelopeSpending();}
    if(!crossed||!fed){
      if(prevType!==fields.type)reloadData(year,month);
      return;
    }
    setRetyping(true);
    try{
      await runSync({force:true});
      await reloadData(year,month);
    }catch(err){
      console.error("re-sync after type change failed",err);
    }finally{
      setRetyping(false);
    }
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
    // SimpleFIN removal is a SOFT-HIDE: the server marks the accounts hidden
    // and disables the institution (the tombstone that keeps the next pull from
    // recreating it). Nothing is deleted — Restore in the SimpleFIN modal
    // brings the visible accounts back. The buried permanent delete lives in
    // that modal too, next to Restore, never here.
    const ok=isSimpleFinAccount(selAcct)
      ?window.confirm(
        `Remove ${instName} from view?\n\nThis hides ${siblings.length} account${siblings.length!==1?"s":""} and stops them counting in any total:\n${list}\n\nNothing is deleted — all transactions (including any CSV/PDF backfill) are kept, and Restore in the SimpleFIN modal brings the bank back exactly as it was. It stays connected at SimpleFIN Bridge.`
      )
      :window.confirm(
        `Unlink ${instName}?\n\nThis removes ${siblings.length} account${siblings.length!==1?"s":""} and all their transactions from the app:\n${list}\n\nThis cannot be undone.`
      );
    if(!ok)return;
    setUnlinking(true);
    try{
      await unlinkInstitution(selAcct.institution_id);
      setSelAcct(null);
      setTxAcctFilter(null);
      // The removed bank's rows no longer appear (hidden for SimpleFIN, deleted
      // for manual), so a category filter set from them may now describe nothing.
      setTxCatFilter(null);
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
  // While a search is active the Transactions tab renders results across all
  // months instead of the selected month; the account and category chips still
  // filter them.
  const searchActive=searchQ.trim().length>=2;
  const searchTxs=searchRes?.transactions||[];
  // Account first, category second, so the category chips can be derived from
  // the account-filtered rows WITHOUT being narrowed by the category filter —
  // otherwise picking a category leaves exactly one chip on screen and no way
  // back. Accounts narrow the offered categories; categories never narrow the
  // offered accounts.
  const acctTxsView=txAcctFilter?txs.filter(t=>t.account_id===txAcctFilter):txs;
  const acctSearchView=txAcctFilter?searchTxs.filter(t=>t.account_id===txAcctFilter):searchTxs;
  const shownTxs=txCatFilter?acctTxsView.filter(t=>t.category===txCatFilter):acctTxsView;
  const shownSearch=txCatFilter?acctSearchView.filter(t=>t.category===txCatFilter):acctSearchView;
  const listTxs=searchActive?shownSearch:shownTxs;
  const cfPs=cashFlow?.periods||[];
  const maxCat=cats[0]?.amount||1;
  const maxSpend=Math.max(...cfPs.map(p=>p.spending?.amount||0),1);
  const totalSpent=cats.reduce((s,c)=>s+c.amount,0);
  // Debts read negative (see src/accountBalance.js). getOverview orders credit
  // accounts first, so this headline is usually a card — and it carries `type`.
  // The tile cycles over unhidden CREDIT accounts only; the remembered pick is
  // a device pref (mm:cardTile). 0 credit accounts -> today's behavior (first
  // ordered account / em-dash); a stored id that no longer resolves falls back
  // to the credit-first default, never a blank tile.
  const creditAccts=(overview?.accounts||[]).filter(a=>a.type==="credit");
  const tileAcct=creditAccts.find(a=>a.id===cardTileId)||creditAccts[0]||overview?.accounts?.[0];
  const tileIdx=Math.max(0,creditAccts.indexOf(tileAcct));
  const balance=displayBalance(tileAcct?.balance?.current,tileAcct?.type);
  const cycleCard=(dir)=>{
    if(creditAccts.length<2)return;
    const next=creditAccts[(tileIdx+dir+creditAccts.length)%creditAccts.length];
    setCardTileId(next.id);
    try{localStorage.setItem("mm:cardTile",next.id);}catch{/* private mode: session-only */}
  };
  const lastSpent=overview?.last_month?.spending?.amount;
  const delta=lastSpent!=null?totalSpent-lastSpent:null;
  // Donut slices are non-text marks on the card -> 3:1.
  const donutData=cats.slice(0,7).map(c=>({label:getName(c.label),value:c.amount,color:markOn(getColor(c.label),surf.card)}));

  // The viewed month's transactions indexed by effective category — what the
  // drill-in sheet lists. Built from the rows already on hand (getTransactions
  // returns the WHOLE month, paginated, uncapped), so tapping a number costs no
  // round trip and the list can't disagree with the transactions tab.
  // The categories offered as filter chips on the Transactions tab: the ones
  // actually PRESENT in the rows in view, not the whole taxonomy — 22 built-ins
  // plus customs would be a wall of chips, most of them dead ends.
  // `t.category` is already the effective category (dataAdapter's
  // effectiveCategory falls back to Uncategorized), so there is nothing to
  // normalize here — re-deriving it is exactly the drift `counted` exists to
  // prevent.
  const catChips=useMemo(()=>{
    const pool=searchActive?acctSearchView:acctTxsView;
    const present=new Set();
    for(const t of pool)present.add(t.category);
    const arr=[...present];
    // Pin the active filter even when nothing in view matches it (a month
    // change, an account switch, a narrower search). Auto-clearing a filter the
    // user set reads as a bug, and the empty state below names the category.
    if(txCatFilter&&!present.has(txCatFilter))arr.push(txCatFilter);
    // Alphabetical by DISPLAY name: stable across months, accounts and
    // keystrokes, which is what makes a horizontally-scrolling row usable. A
    // count- or amount-ordered row reshuffles under the thumb, and ordering by
    // outflow would put "Transfers and card payments" first nearly every month.
    return arr.sort((a,b)=>getName(a).localeCompare(getName(b),undefined,{sensitivity:"base"}));
  },[acctTxsView,acctSearchView,searchActive,txCatFilter,getName]);

  const txsByCategory=useMemo(()=>{
    const m=new Map();
    for(const t of txs){
      const list=m.get(t.category);
      if(list)list.push(t); else m.set(t.category,[t]);
    }
    return m;
  },[txs]);
  const drillRows=catDrill?(txsByCategory.get(catDrill)||[]):[];
  // Only offer the drill-in when there is something behind the number.
  const openDrill=useCallback(cat=>(txsByCategory.get(cat)||[]).length?()=>setCatDrill(cat):null,[txsByCategory]);

  // Budgets read the getSpending() groups (not raw transactions), so when the
  // adapter's effective-category logic changes (transaction-editing branch),
  // budget progress follows automatically. Keys are raw category labels.
  const budgetCount=Object.keys(budgets).length;
  // One list, one row shape. A custom category is not a different KIND of
  // category — it is a category — so it sits in the same list as the built-in
  // ones rather than in a block of its own, and gets the same swatch, name,
  // count, amount, target and bar. Categories with no spending this month are
  // listed when someone has deliberately put them in play: a target (monthly or
  // by-date), or having been created by hand.
  const catRows=(()=>{
    const seen=new Set(cats.map(c=>c.label));
    const rows=[...cats];
    for(const k of [...Object.keys(budgets),...Object.keys(byDate),...customCatNames]){
      if(seen.has(k))continue;
      seen.add(k);
      rows.push({label:k,amount:0,transaction_count:0,percent_of_total:0});
    }
    return rows;
  })();
  const budgetedSpent=cats.reduce((s,c)=>budgets[c.label]!=null?s+c.amount:s,0);
  const budgetedTotal=Object.values(budgets).reduce((s,v)=>s+v,0);
  const budgetLeft=budgetedTotal-budgetedSpent;

  // --- Budget tab (envelopes) -------------------------------------------------
  // Rows come straight from the walk, which already covers every category that
  // has an assignment, a target, or spending this month. extraEnvCats are ones
  // the user has pulled in to start an envelope but not yet assigned to.
  const envMap={};
  for(const r of envelopes?.categories||[])envMap[r.category]=r;
  const envRows=[...(envelopes?.categories||[]),
    ...extraEnvCats.filter(k=>!envMap[k]).map(k=>({category:k,assigned:0,rolledOver:0,spent:0,
      available:0,target:budgets[k]??null,targetKind:"monthly",targetDate:null,rollover:true}))];
  // Uncategorized (and any transfer bucket) is bookkeeping, not a budget — a
  // budget on it would be a budget on the classifier's ignorance. Its spending
  // still renders (the size of the unknown stays visible), but it takes no
  // assignments, targets or moves — so it is also excluded from Fund targets
  // and the move sheet's destinations.
  const budgetableRows=envRows.filter(r=>isBudgetableCategory(r.category));
  // What each targeted category still needs this month to hit its target.
  const fundNeeds=budgetableRows.map(r=>({row:r,need:targetNeed(r,{year,month})})).filter(x=>x.need>0);
  const fundTotal=fundNeeds.reduce((s,x)=>s+x.need,0);
  const rta=envelopes?readyToAssign(income?.income,envelopes.totals):null;
  // Wall-clock local day for the pace warning — the SAME reasoning as the
  // Recurring tab's clock: "is this envelope spending ahead of pace?" is a
  // question about the present moment, so it uses today, not the viewed month
  // (envelopePace returns null unless today falls inside the viewed month).
  const paceToday=(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;})();
  // Categories with no envelope yet, offered by the "budget another category"
  // picker. Custom categories are budgetable too.
  const allCatNames=[...ERA_CATEGORIES,...customCatNames.filter(n=>!ERA_CATEGORIES.includes(n))];
  const unbudgetedCats=allCatNames.filter(c=>isBudgetableCategory(c)&&!envRows.some(r=>r.category===c));

  // Assigning during render is a side effect; the ref has to track the
  // *committed* month so an in-flight envelope write can tell it landed on a
  // stale one.
  useEffect(()=>{monthRef.current=`${year}-${month}`;},[year,month]);

  // Every envelope write goes through here. It re-reads what it wrote rather
  // than updating state optimistically: a budget that shows a number it failed
  // to save is worse than one that takes a beat to settle. If the user has
  // moved to another month meanwhile, the result is dropped rather than shown
  // under the new month. Writes QUEUE on envChain — the inline editors stay
  // usable while a save settles, and an edit made in that window must run
  // after it, not silently vanish.
  function runEnvelopeWrite(what,fn){
    const run=envChain.current.then(()=>doEnvelopeWrite(what,fn));
    envChain.current=run.catch(()=>{});
    return run;
  }
  async function doEnvelopeWrite(what,fn){
    const key=`${year}-${month}`;
    setEnvBusy(true);setError(null);
    try{
      await fn();
      // The re-read is TOLERANT: the write itself failing must surface, but a
      // failed refresh must not report a stored change as "wasn't stored" —
      // that exact false alarm would fire on every pre-migration preview,
      // where budgets writes succeed and the envelope schema doesn't exist.
      const[env,inc,bud]=await Promise.all([
        getEnvelopes({year,month}).catch(e=>isEnvelopeSchemaMissing(e)?null:undefined),
        getBudgetIncome({year,month}).catch(()=>undefined),
        getBudgets().catch(()=>undefined),
      ]);
      if(monthRef.current===key){
        // Newer than any reload still in flight from before the write.
        envSeq.current++;
        if(env!==undefined)setEnvelopes(env);
        if(inc!==undefined)setIncome(inc);
        if(bud!==undefined){setBudgets(bud.budgets||{});setByDate(bud.byDate||{});}
      }else{
        // The user moved months while the write settled. The write still went
        // to ITS month (the one the number was typed against) — but a reload
        // for the new month may have read budget_months before this write
        // committed, leaving the carry short on screen. Re-read the month now
        // being viewed; envSeq drops anything older.
        const [cy,cm]=monthRef.current.split("-").map(Number);
        const fresh=await getEnvelopes({year:cy,month:cm}).catch(()=>undefined);
        if(fresh!==undefined&&monthRef.current===`${cy}-${cm}`){
          envSeq.current++;
          setEnvelopes(fresh);
        }
      }
    }catch(err){
      console.error(`${what} save failed`,err);
      setError(`Couldn't save ${what} — your change wasn't stored. Check your connection and try again.`);
    }finally{setEnvBusy(false);}
  }

  const saveBudget=(category,val)=>runEnvelopeWrite("the target",()=>setBudget(category,val));
  const saveAssigned=(category,val)=>runEnvelopeWrite("the assignment",()=>setAssigned(category,{year,month},val));
  const saveRollover=(category,next)=>{
    // The ⟳ is disabled on by-date rows, but the invariant lives here too: a
    // sinking fund with rollover off would ask for its full share forever.
    if(!next&&envMap[category]?.targetKind==="by_date"&&envMap[category]?.target!=null)return;
    return runEnvelopeWrite("the rollover setting",()=>setCategoryRollover(category,next));
  };
  // Pace warning is a pure display preference (never touches the walk), so its
  // toggle writes settings directly and optimistically — no runEnvelopeWrite,
  // no envelope refetch.
  function togglePace(category){
    const next={...envPace};
    if(next[category])delete next[category];else next[category]=true;
    setEnvPace(next);
    persistEnvPace(next).catch(err=>console.error("saving pace opt-in failed",err));
  }
  const saveIncome=(val,scope)=>runEnvelopeWrite("the income",()=>setBudgetIncome({year,month},val,{scope}));
  const doMove=(from,to,amount)=>runEnvelopeWrite("the transfer",()=>moveMoney({from,to,amount},{year,month}));
  const saveTarget=(category,{amount,kind,date})=>runEnvelopeWrite("the target",async()=>{
    await setBudget(category,amount);
    await setTargetKind(category,kind,date);
    // A sinking fund only reaches its number because each month's leftover
    // carries. With rollover off, rolledOver is always 0, so targetNeed() would
    // ask for the full monthly share forever and the fund would never converge —
    // a by-date target on a non-rolling category is incoherent, not a preference.
    if(kind==="by_date"&&envMap[category]&&!envMap[category].rollover){
      await setCategoryRollover(category,true);
    }
  });

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",background:"var(--bg)",minHeight:"100vh",
      color:"var(--text)"}}>
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

        {/* Feed health — amber, not red: the data on screen is fine, it's just
            getting stale. last_error is already sanitized server-side. The ×
            clears it for this session only (plain state — the status check runs
            once per mount, so it stays gone until the next app load; a broken
            feed re-raises it then, which is the point). */}
        {feedHealth&&(
          <div style={{background:"var(--warn-bg)",border:"1px solid var(--warn-border)",borderRadius:10,padding:"12px 16px",fontSize:13,color:"var(--warn)",marginBottom:14,lineHeight:1.5,display:"flex",alignItems:"flex-start",gap:8}}>
            <div style={{flex:1}}>
              {feedHealth.last_error
                ?<>Bank feed problem: {feedHealth.last_error}</>
                :<>Bank feed hasn't updated since {new Date(feedHealth.last_pulled_at).toLocaleDateString([],{month:"short",day:"numeric"})}.</>}
              {" "}<button onClick={()=>setConnectingSfin(true)} style={{background:"none",border:"none",padding:0,font:"inherit",color:"inherit",textDecoration:"underline",cursor:"pointer"}}>Check connection</button>
            </div>
            <button onClick={()=>setFeedHealth(null)} aria-label="Dismiss" title="Dismiss"
              style={{background:"none",border:"none",cursor:"pointer",color:"inherit",fontSize:18,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
          </div>
        )}

        {/* Everything is hidden — which is what a brand-new SimpleFIN connect
            looks like. New accounts arrive hidden:true (their TYPE is a guess,
            and unhiding is the deliberate confirm), and getOverview filters on
            hidden:false — so the first thing a successful connect shows is a
            dashboard of em-dashes and an empty donut, with nothing on screen
            explaining why. Under Plaid this could never happen: those accounts
            arrived visible. Without this line the app looks broken at exactly
            the moment it just worked. */}
        {!loading&&accounts.length>0&&accounts.every(a=>a.hidden)&&(
          <div style={{background:"var(--warn-bg)",border:"1px solid var(--warn-border)",borderRadius:10,padding:"12px 16px",fontSize:13,color:"var(--warn)",marginBottom:14,lineHeight:1.5}}>
            Your {accounts.length===1?"account is":"accounts are"} hidden until you've checked
            {accounts.length===1?" its":" their"} type — that's what decides whether spending counts.
            {" "}<button onClick={()=>{setTab("accounts");if(isFuture)goCurrentMonth();}} style={{background:"none",border:"none",padding:0,font:"inherit",color:"inherit",textDecoration:"underline",cursor:"pointer"}}>Review and unhide</button>.
          </div>
        )}

        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {[
            {label:"Total spent",val:loading?null:fmt(totalSpent),sub:isCurrent&&lastSpent!=null?`vs ${fmt(lastSpent)} last month`:monthLabel(year,month)},
            // Whole dollars like its neighbours: a negative card balance with
            // cents is too wide for a third of a 390px screen and wrapped the
            // minus sign onto its own line.
            // Cycles through unhidden credit accounts: click/tap advances,
            // horizontal swipe goes either way (with an intent threshold so it
            // never claims a vertical page scroll). Selection is a device pref.
            {label:"Card balance",val:loading?null:fmt(balance),sub:tileAcct?.name||"Linked account",cycle:!loading&&creditAccts.length>1},
            {label:"vs last month",val:loading||delta==null?null:`${delta>=0?"+":""}${fmt(delta)}`,sub:delta==null?"—":delta>=0?"↑ more spending":"↓ less spending",clr:delta==null?"var(--muted)":inkOn(delta>=0?"#D85A30":"#1D9E75",surf.card)},
          ].map((c,i)=>(
            <div key={i} className="card" style={{animationDelay:i*.04+"s",...(c.cycle?{cursor:"pointer",userSelect:"none"}:{})}}
              onClick={c.cycle?()=>cycleCard(1):undefined}
              onTouchStart={c.cycle?(e)=>{const t=e.touches[0];cardSwipe.current={x:t.clientX,y:t.clientY};}:undefined}
              onTouchEnd={c.cycle?(e)=>{
                const s=cardSwipe.current;cardSwipe.current=null;if(!s)return;
                const t=e.changedTouches[0];const dx=t.clientX-s.x,dy=t.clientY-s.y;
                // Horizontal intent only: |dx| must beat |dy| AND clear a
                // minimum, so a vertical scroll is never claimed. A real swipe
                // suppresses the synthetic click; a plain tap falls through to
                // onClick above.
                if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>30){e.preventDefault();cycleCard(dx<0?1:-1);}
              }:undefined}>
              <div style={{fontSize:11,color:"var(--muted)",fontWeight:500,marginBottom:5}}>{c.label}</div>
              {loading?<Sk w="70%" h={22}/>:<div style={{fontSize:20,fontWeight:600,letterSpacing:"-.02em",marginBottom:3}}>{c.val??"—"}</div>}
              <div style={{fontSize:11,color:c.clr||"var(--muted)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{loading?<Sk w="80%" h={10}/>:c.sub}</div>
              {c.cycle&&(
                <div style={{display:"flex",gap:4,marginTop:6,alignItems:"center"}}>
                  {creditAccts.map((a,j)=>(
                    <span key={a.id??j} style={{width:5,height:5,borderRadius:"50%",background:j===tileIdx?"var(--accent)":"var(--border)"}}/>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:3,background:"var(--bg)",borderRadius:24,padding:4,marginBottom:14,border:"1px solid var(--border)",overflowX:"auto"}}>
          {["overview","categories","budget","transactions","accounts","debt","trends","recurring","tax","ask"].map(t=>(
            <button key={t} className={`tab${tab===t?" active":""}`}
              onClick={()=>{
                setTab(t);
                if(t!=="accounts")setSelAcct(null);
                // Only the Budget tab can look into the future; every other tab
                // would just show an empty month, so leaving snaps back.
                if(t!=="budget"&&isFuture)goCurrentMonth();
              }}>
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
                <span style={{color:"var(--muted)"}}>Targets <strong style={{color:"var(--text)",fontFamily:"'DM Mono',monospace"}}>{fmt(budgetedTotal)}</strong></span>
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
                      <DrillNum onClick={openDrill(c.label)} title={`See the ${getName(c.label)} transactions`}
                        style={{fontSize:11,color:"var(--muted)",flexShrink:0,marginLeft:4}}>
                        {c.transaction_count} txn{c.transaction_count!==1?"s":""}
                      </DrillNum>
                    </div>
                    <div style={{display:"flex",alignItems:"baseline",gap:5,marginLeft:12,flexShrink:0}}>
                      <DrillNum onClick={openDrill(c.label)} title={`See the ${getName(c.label)} transactions`}
                        style={{fontSize:13,fontFamily:"'DM Mono',monospace"}}>{fmt(c.amount)}</DrillNum>
                      {/* No budget on Uncategorized — it would be a budget on
                          the classifier's ignorance, and the number moves as
                          merchants get learned rather than as spending changes. */}
                      {isBudgetableCategory(c.label)&&(byDate[c.label]
                        ?<button onClick={()=>setTab("budget")}
                            title="Sinking fund — a total to reach by a date, not a monthly cap. Edit it on the Budget tab."
                            style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,
                              fontSize:11,color:"var(--muted)",flexShrink:0}}>
                            {fmtAuto(byDate[c.label].target)} by {monthYear(byDate[c.label].date)}
                          </button>
                        :<BudgetEdit limit={lim} onSave={v=>saveBudget(c.label,v)}/>)}
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div className="bar-bg"><div className="bar-fill" style={{width:barW+"%",background:barColor}}/></div>
                    <span style={{fontSize:11,color:hasB&&ratio>=1?inkOn("#D85A30",surf.card):"var(--muted)",width:38,textAlign:"right",flexShrink:0}}>
                      {hasB?(lim>0?Math.round(ratio*100)+"%":"—"):`${c.percent_of_total?.toFixed(0)}%`}
                    </span>
                  </div>
                  {c.label===UNCATEGORIZED&&(
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:5,lineHeight:1.5}}>
                      Merchants the classifier didn't recognise. Still counted as spending — open one
                      and set its category, and it'll remember that merchant next time.
                    </div>
                  )}
                  {/* Teach-queue: the month's top Uncategorized merchants, derived
                      in render from txsByCategory (no cached state — the
                      setState(null) gotcha never applies, and the list self-heals
                      through learnMerchant's reloadData). Grouped by the SAME key
                      the classifier uses (merchantKey over txDescriptor, not raw
                      description) so a taught rule fires on the next pull. Tapping
                      a row opens the detail sheet for the group's most recent
                      transaction — the existing pick-a-category → offerToLearn →
                      learnMerchant flow, dry-run preview and all; Uncategorized
                      is never offerable there. */}
                  {c.label===UNCATEGORIZED&&(()=>{
                    const rows=txsByCategory.get(UNCATEGORIZED)||[];
                    const groups=new Map();
                    for(const t of rows){
                      const k=merchantKey(txDescriptor(t));
                      if(!k)continue;
                      const g=groups.get(k);
                      if(g){g.count++;if(t.amount>0)g.out+=t.amount;if(t.transaction_date>g.tx.transaction_date)g.tx=t;}
                      else groups.set(k,{key:k,count:1,out:t.amount>0?t.amount:0,tx:t});
                    }
                    // Top 5 by count (ties broken by summed outflow): repetition,
                    // not size, is what makes a merchant worth teaching.
                    const top=[...groups.values()].sort((a,b)=>b.count-a.count||b.out-a.out).slice(0,5);
                    if(top.length===0)return null;
                    return (
                      <div style={{marginTop:8,background:"var(--bg)",borderRadius:8,padding:"8px 10px"}}>
                        <div style={{fontSize:10,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:6}}>
                          Teach it — this month's top unknowns
                        </div>
                        {top.map(g=>(
                          <button key={g.key} onClick={()=>setSelTx(g.tx)}
                            style={{display:"flex",alignItems:"center",gap:8,width:"100%",background:"none",border:"none",
                              padding:"4px 0",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                            <span style={{fontSize:11,fontWeight:500,color:"var(--text)",flex:1,minWidth:0,
                              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.key}</span>
                            <span style={{fontSize:10,color:"var(--muted)",flexShrink:0}}>{g.count} txn{g.count!==1?"s":""}</span>
                            <span style={{fontSize:11,fontFamily:"'DM Mono',monospace",color:"var(--text)",flexShrink:0}}>{fmt(g.out)}</span>
                            <span style={{fontSize:11,color:"var(--muted)",flexShrink:0}}>›</span>
                          </button>
                        ))}
                        <div style={{fontSize:10,color:"var(--muted)",marginTop:4,lineHeight:1.5}}>
                          Tap one, pick its category, and it'll offer to remember the merchant.
                        </div>
                      </div>
                    );
                  })()}
                </div>
                );
              })}

            {/* Custom categories used to sit in a separate block below this
                list, name-and-colour only — no count, no amount, no target, and
                a colour the rest of the app never read (getColor knew nothing
                about it, so they rendered grey everywhere else). They are
                ordinary rows in the list above now; adding and retiring them
                lives in the "+ Add category" sheet, which is what keeps this
                list one uniform set of rows. */}
            <div style={{marginTop:16,fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px",lineHeight:1.6}}>
              Tap a transaction count or an amount to see what's in it · Click a color swatch to change it ·
              Double-click a name to rename it · ＋ target sets what you want to fund each month; the Budget tab
              is where you put real dollars in
            </div>
          </div>
        )}

        {/* BUDGET (envelopes — YNAB rules 1, 2 and 3) */}
        {tab==="budget"&&(()=>{
          const okBg=inkOn(OK_MONEY,surf.bg),overBg=inkOn(OVER_MONEY,surf.bg);
          const okCard=inkOn(OK_MONEY,surf.card),overCard=inkOn(OVER_MONEY,surf.card);
          // The walk stamps the month it computed. Until the viewed month's
          // rows arrive, the previous month's must not render EDITABLE under
          // the new header — an assignment typed against them would be written
          // to the new month and roll forward into every month after it.
          const envCurrent=!!envelopes&&envelopes.month===monthKey(year,month);
          return (
          <div className="card">
            {!envelopes&&!loading&&(
              <div style={{fontSize:12,color:"var(--muted)",textAlign:"center",padding:"28px 12px",lineHeight:1.6}}>
                Envelope budgeting isn't set up yet.<br/>
                Its migration (<code>20260729000001_budget_envelopes.sql</code>) needs to run first.
              </div>
            )}
            {((loading&&!envelopes)||(envelopes&&!envCurrent))&&[1,2,3,4].map(i=><div key={i} style={{marginBottom:14}}><Sk h={14}/></div>)}
            {envCurrent&&(<>
              {envelopes.truncated&&(
                <div style={{background:"var(--danger-bg)",border:"1px solid var(--danger-border)",borderRadius:8,padding:"8px 12px",
                  fontSize:11,color:"var(--danger)",marginBottom:12}}>
                  An assignment is dated impossibly far back, so the rollover walk was clamped. These balances may be short.
                </div>
              )}

              {/* Ready to Assign — rule 1, on hand-entered income. */}
              <div style={{background:"var(--bg)",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:12,marginBottom:8}}>
                  <span style={{color:"var(--muted)"}}>Income</span>
                  <IncomeEdit value={income?.income} isDefault={!!income?.isDefault} onSave={saveIncome}/>
                  <span style={{flex:1}}/>
                  <span style={{color:"var(--muted)"}}>Assigned <strong style={MONO}>{fmtAuto(envelopes.totals.assigned)}</strong></span>
                </div>
                {rta!=null?(
                  <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:22,fontWeight:600,letterSpacing:"-.02em",fontFamily:"'DM Mono',monospace",
                      color:rta>0?okBg:rta<0?overBg:"var(--text)"}}>{fmtAuto(Math.abs(rta))}</span>
                    <span style={{fontSize:12,color:"var(--muted)"}}>
                      {rta>0?"left to assign":rta<0?"assigned beyond your income":"every dollar has a job"}
                    </span>
                  </div>
                ):(
                  <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>
                    Set your income for the month to see what's left to assign. It's typed in by hand —
                    the feed can't be trusted to see every paycheck, and a budget built on a partial
                    number would silently run low.
                  </div>
                )}
                {fundNeeds.length>0&&(
                  <button className="ibtn" disabled={envBusy}
                    onClick={()=>runEnvelopeWrite("the targets",()=>fundTargets(
                      fundNeeds.map(x=>({category:x.row.category,amount:x.row.assigned+x.need})),{year,month}))}
                    style={{marginTop:11,fontSize:11,width:"100%",justifyContent:"center"}}>
                    Fund targets · {fmtAuto(fundTotal)} into {fundNeeds.length} categor{fundNeeds.length===1?"y":"ies"}
                  </button>
                )}
              </div>

              {isFuture&&(
                <div style={{fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px",marginBottom:12}}>
                  Budgeting ahead for {monthLabel(year,month)}. Nothing has been spent yet — balances carry in from
                  the months before it.
                </div>
              )}

              {envRows.length===0&&(
                <div style={{fontSize:12,color:"var(--muted)",textAlign:"center",padding:"20px 12px",lineHeight:1.6}}>
                  No envelopes yet. Add a category below and assign it some money.
                </div>
              )}

              {envRows.map(r=>{
                const budgetable=isBudgetableCategory(r.category);
                const pot=r.assigned+r.rolledOver;
                const ratio=pot>0?r.spent/pot:0;
                // An unbudgetable row has no envelope; its available is just
                // −spent, which must not read as an overspend alarm.
                const over=budgetable&&r.available<0;
                const barW=pot>0?Math.min(ratio,1)*100:0;
                const barColor=markOn(over?OVER_MONEY:ratio>=0.8?"#FAC775":getColor(r.category),surf.track);
                const need=budgetable?targetNeed(r,{year,month}):0;
                // Pace warning: opt-in, budgetable envelopes only, off the
                // spent the walk already produced (never recomputed) against a
                // flat month-pace. Display-only — nothing here feeds available.
                const paceOn=budgetable&&!!envPace[r.category];
                const pace=paceOn?envelopePace({assigned:r.assigned,spent:r.spent,year,month,today:paceToday}):null;
                return (
                  <div key={r.category} style={{marginBottom:16}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <Swatch color={getColor(r.category)} onChange={hex=>saveColors({...customColors,[r.category]:hex})}/>
                      <span style={{fontSize:13,fontWeight:500,color:"var(--text)",minWidth:0,overflow:"hidden",
                        textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getName(r.category)}</span>
                      <span style={{flex:1}}/>
                      {/* An unbudgetable row has no envelope, so a negative
                          "available" would be a false alarm — show its spend. */}
                      <span style={{fontSize:13,fontWeight:600,fontFamily:"'DM Mono',monospace",flexShrink:0,
                        color:!budgetable?"var(--muted)":over?overCard:r.available>0?okCard:"var(--muted)"}}>
                        {budgetable?fmtAuto(r.available):fmtAuto(r.spent)}
                      </span>
                    </div>

                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
                      <div className="bar-bg"><div className="bar-fill" style={{width:barW+"%",background:barColor}}/></div>
                      <span style={{fontSize:11,width:38,textAlign:"right",flexShrink:0,color:over?overCard:"var(--muted)"}}>
                        {pot>0?Math.round(ratio*100)+"%":"—"}
                      </span>
                    </div>

                    {budgetable?(
                      <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted)",flexWrap:"wrap"}}>
                        {r.assigned!==0&&<span>Assigned</span>}
                        <AssignEdit value={r.assigned} onSave={v=>saveAssigned(r.category,v)}/>
                        {r.rolledOver!==0&&(<>
                          <span>·</span>
                          <span style={{color:r.rolledOver>0?okCard:overCard}}>{signed(r.rolledOver)} rolled</span>
                        </>)}
                        {r.spent!==0&&(<><span>·</span>
                          <DrillNum onClick={openDrill(r.category)} title={`See the ${getName(r.category)} transactions`}>
                            {fmtAuto(r.spent)} spent
                          </DrillNum></>)}
                        <span style={{flex:1}}/>
                        <button onClick={()=>setTargetEdit(r.category)} disabled={envBusy}
                          title="Set a funding target for this category"
                          style={{background:"none",border:`1px solid ${r.target!=null?"var(--accent)":"var(--border)"}`,
                            borderRadius:20,cursor:"pointer",fontFamily:"inherit",padding:"2px 8px",fontSize:10,
                            color:r.target!=null?"var(--accent)":"var(--muted)",flexShrink:0}}>
                          {r.target==null?"＋ target"
                            :r.targetKind==="by_date"?`${fmtAuto(r.target)} by ${monthYear(r.targetDate)}`
                            :`${fmtAuto(r.target)}/mo`}
                        </button>
                        {need>0&&<span style={{color:"var(--accent)",fontSize:10}}>needs {fmtAuto(need)}</span>}
                        {pace&&(()=>{const cs=chipOn("#C08A2E",surf.card);return(
                          <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:6,
                            color:cs.ink,background:cs.bg,flexShrink:0}}
                            title={`Spent ${fmtAuto(r.spent)} of the ${fmtAuto(r.assigned)} assigned, ahead of the ${Math.round(pace.elapsed*100)}% of the month elapsed`}>
                            ⏱ ahead of pace</span>);})()}
                        <button onClick={()=>togglePace(r.category)} disabled={envBusy}
                          title={paceOn
                            ?"Pace warning on — flags when spending runs ahead of the month. Tap to turn off"
                            :"Warn when this envelope is spending ahead of a flat month pace (best for fungible categories like groceries, not fixed bills)"}
                          style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"0 2px",
                            fontSize:13,lineHeight:1,color:paceOn?"var(--accent)":"var(--border)",flexShrink:0}}>⏱</button>
                        <button onClick={()=>setMoveFrom(r.category)} disabled={envBusy}
                          title="Move money between this envelope and another"
                          style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"0 2px",
                            fontSize:13,lineHeight:1,color:"var(--muted)",flexShrink:0}}>⇄</button>
                        <button onClick={()=>saveRollover(r.category,!r.rollover)}
                          disabled={envBusy||(r.targetKind==="by_date"&&r.target!=null)}
                          title={r.targetKind==="by_date"&&r.target!=null
                            ?"A sinking fund only reaches its date because leftovers carry — rollover stays on while the by-date target exists"
                            :r.rollover?"Leftover rolls into next month — tap to turn off":"Leftover resets each month — tap to roll it over"}
                          style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"0 2px",
                            fontSize:13,lineHeight:1,color:r.rollover?"var(--accent)":"var(--border)",flexShrink:0}}>⟳</button>
                      </div>
                    ):(
                      <div style={{fontSize:11,color:"var(--muted)"}}>
                        <DrillNum onClick={openDrill(r.category)} title={`See the ${getName(r.category)} transactions`}>
                          {fmtAuto(r.spent)} spent
                        </DrillNum> · can't be budgeted — categorize these transactions to give them an envelope
                      </div>
                    )}
                  </div>
                );
              })}

              {unbudgetedCats.length>0&&(
                <button className="ibtn" onClick={()=>setPickingCat(true)}
                  style={{fontSize:11,width:"100%",justifyContent:"center",marginTop:4}}>
                  + Budget another category
                </button>
              )}

              <div style={{marginTop:16,fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px",lineHeight:1.6}}>
                Tap the amount to assign real dollars · tap what's been spent to see the transactions behind it ·
                ＋ target is what you want to fund · ⇄ moves money between envelopes · ⟳ carries a category's
                leftover (or its overspend) into next month · ⏱ warns when a fungible envelope spends ahead of pace
              </div>
            </>)}
          </div>
          );
        })()}

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
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:10}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>
                {searchActive?"Search results · all months":monthLabel(year,month)}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:12,color:"var(--muted)"}}>
                  {searchActive
                    ?(searching?"searching…":`${shownSearch.length} match${shownSearch.length!==1?"es":""}`)
                    :`${shownTxs.length} transaction${shownTxs.length!==1?"s":""}`}
                </span>
                <button className="ibtn" style={{fontSize:11}} onClick={()=>setQuickAdd(true)}>+ Add transaction</button>
              </div>
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
            {/* Category chips. ONE horizontally-scrolling line, not a wrapping
                row like the accounts above: usable width inside .card at 390px
                is ~318px and "Home maintenance and improvement" alone is ~230px,
                so wrapping ~15 of these would bury the list under six rows of
                chips. Horizontal scroll is already the tab bar's idiom.
                The `||txCatFilter` in the guard is load-bearing — without it a
                pool that collapses to one category unmounts the row while the
                filter is still applied, taking "All categories" with it. */}
            {(catChips.length>1||txCatFilter)&&(
              <div style={{display:"flex",gap:6,flexWrap:"nowrap",overflowX:"auto",overflowY:"hidden",
                marginBottom:12,paddingBottom:2,scrollbarWidth:"none",WebkitOverflowScrolling:"touch"}}>
                {[{cat:null,label:"All categories",color:null},...catChips.map(c=>({cat:c,label:getName(c),color:getColor(c)}))].map(c=>{
                  const active=txCatFilter===c.cat;
                  const cs=c.color?chipOn(c.color,surf.card):null;
                  // Tapping the ACTIVE chip clears it, so undo never needs a
                  // scroll back to "All categories" — which can sit off-screen
                  // here in a way it never does on the wrapping account row.
                  // That is why this differs from setTxAcctFilter(c.id) above.
                  //
                  // Namespaced key: a category label is free text, so a custom
                  // category named "all" would otherwise collide with the All
                  // chip. (The account row can key on the bare id — uuids.)
                  const key=c.cat===null?"all:":"cat:"+c.cat;
                  return (
                    <button key={key} title={c.label}
                      onClick={()=>setTxCatFilter(txCatFilter===c.cat?null:c.cat)}
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,flexShrink:0,maxWidth:150,
                        background:active&&cs?cs.bg:"var(--bg)",color:active?(cs?cs.ink:"var(--text)"):"var(--muted)",
                        border:`1px solid ${active?(cs?markOn(c.color,surf.card):"var(--text)"):"var(--border)"}`,borderRadius:20,padding:"4px 10px",
                        cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>
                      {cs&&<span style={{width:6,height:6,borderRadius:"50%",display:"inline-block",flexShrink:0,
                        background:active?cs.dot:markOn(c.color,surf.bg)}}/>}
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</span>
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
                {/* Always getName — a renamed category must not leak its raw
                    registry label here. The hasMore case exists so the app never
                    claims a category has nothing when it only looked at a
                    truncated page of matches. */}
                {(()=>{
                  const cn=txCatFilter?getName(txCatFilter):null;
                  const q=searchQ.trim();
                  if(searchActive&&cn&&searchRes?.hasMore)return `No ${cn} transactions in the first 200 matches for "${q}".`;
                  if(searchActive&&cn)return `No ${cn} transactions match "${q}".`;
                  if(searchActive)return `No transactions match "${q}".`;
                  if(cn&&txAcctFilter)return `No ${cn} transactions for this account this month.`;
                  if(cn)return `No ${cn} transactions this month.`;
                  if(txAcctFilter)return "No transactions for this account this month.";
                  return "No transactions for this period.";
                })()}
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
                    {entPill(t.entity_id)}
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
              <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
                <button className="ibtn" style={{fontSize:11}} onClick={()=>setConnectingSfin(true)}>+ Add bank</button>
                <button className="ibtn" style={{fontSize:11}} onClick={()=>setImporting(true)}>⤓ Import statement</button>
              </div>
            </div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>
              Give each account a nickname and color — they tag every transaction across the app.
              Connect banks through SimpleFIN, or import a statement (CSV or PDF) for history a
              feed doesn't reach.
            </div>
            {loading&&accounts.length===0?[1,2,3].map(i=><div key={i} style={{marginBottom:12}}><Sk h={40}/></div>):
              [...accounts].sort((a,b)=>(a.hidden?1:0)-(b.hidden?1:0)).map((a,i)=>(
                <div key={a.id} className="tx" style={{cursor:"pointer",animationDelay:i*.03+"s",opacity:a.hidden?.5:1}}
                  onClick={()=>setSelAcct(a)}>
                  <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <Swatch color={acctColor(a)} onChange={hex=>saveAccount(a.id,{color:hex})}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    {/* Wraps, and the name keeps a flex-basis: a SimpleFIN
                        account carries two badges, and EditName is flex:1
                        minWidth:0, so without a basis it would shrink to
                        "Member…" rather than letting the badges wrap. */}
                    <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{display:"flex",flex:"1 1 150px",minWidth:0}}>
                        <EditName name={acctLabel(a)} onSave={v=>saveAccount(a.id,{nickname:v})}/>
                      </span>
                      {isManualAccount(a)&&<Pill label="Imported" color="#7F77DD" surface={surf.card}/>}
                      {isSimpleFinAccount(a)&&<Pill label="SimpleFIN" color="#378ADD" surface={surf.card}/>}
                      {a.hidden&&<Pill label="Hidden" color="#888780" surface={surf.card}/>}
                    </div>
                    <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                      {[acctInst(a),`${a.name}${a.mask?` ··${a.mask}`:""}`,a.subtype||a.type].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500}}>{fmtX(displayBalance(a.current_balance,a.type))}</div>
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
              <div style={{fontSize:15,fontFamily:"'DM Mono',monospace",fontWeight:600,flexShrink:0}}>{fmtX(displayBalance(selAcct.current_balance,selAcct.type))}</div>
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
                  {unlinking?"Removing…":`${isSimpleFinAccount(selAcct)?"Remove":"Unlink"} ${acctInst(selAcct)||"bank"}…`}
                </button>
              )}
            </div>
            <div style={{marginTop:6,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              {isManualAccount(selAcct)
                ?"Imported account · re-import a CSV to add or correct transactions (duplicates are skipped automatically)"
                :isSimpleFinAccount(selAcct)
                ?"Hide keeps syncing but drops it from totals · Remove deletes its data here and stops syncing this bank (it stays linked at SimpleFIN Bridge)"
                :"Hide keeps syncing but drops it from totals · Unlink removes the connection and its data"}
            </div>

            {/* Account type — editable everywhere now.
                SimpleFIN sends no type at all, so it's guessed from the account
                name on first sync; the checking/savings split drives the Trends
                cash-flow model, so a wrong guess has to be fixable.

                This used to be SimpleFIN-only, because a Plaid sync re-wrote
                type and subtype on every pull and an edit there would silently
                revert. That reason died with Plaid — and it never applied to
                MANUAL accounts, whose type is set once at creation and then
                never written again by anything. Leaving them out meant a
                statement-imported account typed Savings by mistake could never
                be corrected, and `isCheckingAccount` in cashFlow.js reads
                exactly that field to decide whether its outflows are household
                spending. A field that changes the numbers must be fixable. */}
            {(isSimpleFinAccount(selAcct)||isManualAccount(selAcct))&&(
              <div style={{marginTop:12,background:"var(--bg)",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Account type</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {ACCOUNT_TYPES.map(t=>{
                    const active=selAcct.type===t;
                    const label=t==="depository"?"Bank":t==="credit"?"Credit card":"Loan";
                    // The panel is --bg, so that's the surface these tint over
                    // — not --card like the category chips a few hundred lines
                    // down. Hardcoding #378ADD22/#378ADD here made the selected
                    // type unreadable in dark mode.
                    const cs=active?chipOn(TYPE_CHIP,surf.bg):null;
                    return (
                      <button key={t} disabled={retyping}
                        onClick={()=>saveAccountType(selAcct.id,{type:t,subtype:t==="depository"?(selAcct.subtype==="savings"?"savings":"checking"):t==="credit"?"credit card":"loan"},selAcct.type,isSimpleFinAccount(selAcct))}
                        style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:retyping?"default":"pointer",opacity:retyping?.6:1,
                          background:cs?cs.bg:"var(--card)",color:cs?cs.ink:"var(--muted)",
                          border:`1px solid ${active?markOn(TYPE_CHIP,surf.bg):"var(--border)"}`,transition:"all .15s"}}>
                        {label}
                      </button>
                    );
                  })}
                </div>
                {selAcct.type==="depository"&&(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
                    {["checking","savings"].map(st=>{
                      const active=(selAcct.subtype==="savings"?"savings":"checking")===st;
                      const cs=active?chipOn(TYPE_CHIP,surf.bg):null;
                      return (
                        <button key={st} onClick={()=>saveAccount(selAcct.id,{subtype:st})}
                          style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                            background:cs?cs.bg:"var(--card)",color:cs?cs.ink:"var(--muted)",
                            border:`1px solid ${active?markOn(TYPE_CHIP,surf.bg):"var(--border)"}`,transition:"all .15s"}}>
                          {st==="checking"?"Checking":"Savings"}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div style={{fontSize:10,color:"var(--muted)",marginTop:8,lineHeight:1.5}}>
                  {retyping
                    ?"Re-syncing so the balance is read the right way round for the new type…"
                    :<>SimpleFIN doesn't send an account type — this was guessed from the name. Money out of
                      <em> checking</em> counts as spending in Trends; money out of <em>savings</em> never does.</>}
                </div>
              </div>
            )}

            {/* Rental property — account-level default (every transaction on
                this account counts for the property on the Tax tab). Offered
                once a property exists; also shown when the account is already
                assigned to one that was since archived, so it can be cleared.
                Same --bg panel as the type editor, so the chips tint over
                surf.bg, not surf.card. */}
            {(entities.some(e=>!e.archived_at)||selAcct.entity_id)&&(
              <div style={{marginTop:12,background:"var(--bg)",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Rental property</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[{id:null,name:"None"},...entities.filter(e=>!e.archived_at||e.id===selAcct.entity_id)].map(e=>{
                    const active=(selAcct.entity_id||null)===e.id;
                    const cs=active&&e.id?chipOn(ENTITY_CHIP,surf.bg):null;
                    return (
                      // Invalidate AFTER the write commits: doing it before
                      // lets the tax tab's SELECT race the UPDATE and cache
                      // the old attribution (saveAccount swallows errors, so
                      // awaiting is safe).
                      <button key={e.id||"none"} onClick={async()=>{await saveAccount(selAcct.id,{entity_id:e.id});invalidateTax();}}
                        style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                          background:cs?cs.bg:"var(--card)",color:cs?cs.ink:(active?"var(--text)":"var(--muted)"),
                          border:`1px solid ${active?(e.id?markOn(ENTITY_CHIP,surf.bg):"var(--text)"):"var(--border)"}`,transition:"all .15s"}}>
                        {e.name}
                      </button>
                    );
                  })}
                </div>
                <div style={{fontSize:10,color:"var(--muted)",marginTop:8,lineHeight:1.5}}>
                  Tags every transaction on this account for the property on the Tax tab (single
                  transactions can still be reassigned in their detail sheet). No other totals change.
                </div>
              </div>
            )}
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
                        {entPill(t.entity_id)}
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

        {/* DEBT */}
        {tab==="debt"&&(()=>{
          const busy=debtLoading||!debtData;
          const debts=debtData?.debts||[];
          const hasCols=debtData?.hasDebtColumns!==false;
          const inPayoff=d=>debtInclude[d.id]??(d.type==="credit"); // credit in, loans (incl. mortgages) opt-in
          const included=debts.filter(d=>(Number(d.current_balance)||0)>0&&inPayoff(d));
          const extra=Math.max(0,Number(debtExtra)||0);
          const missingMin=included.filter(d=>!(Number(d.minimum_payment)>0));
          const plan=included.length?payoffWhatIf(included,{strategy:debtStrategy,extraMonthly:extra}):null;
          const startMonth=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
          const freeMonth=plan?debtFreeMonth(startMonth,plan):null;
          // Total-owed history: carry each account's last-seen snapshot forward
          // so a day where only one bank reported doesn't read as a paydown.
          const series=(()=>{
            if(debtSnaps.length<2)return [];
            const last={},pts=[];let cur=null;
            for(const s of debtSnaps){
              last[s.account_id]=Number(s.balance)||0;
              const total=Object.values(last).reduce((a,b)=>a+b,0);
              if(cur&&cur.date===s.captured_on)cur.total=total;
              else pts.push(cur={date:s.captured_on,total});
            }
            return pts.length>=2?pts:[];
          })();
          return (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:5}}>Total debt</div>
              {busy?<Sk w="50%" h={26}/>:(
                <>
                  {/* Rendered through displayBalance like every per-card row, so
                      the headline and the rows agree on the sign (a positive
                      total above negative cards is exactly the inconsistency
                      displayBalance exists to remove). */}
                  <div style={{fontSize:24,fontWeight:600,letterSpacing:"-.02em",fontFamily:"'DM Mono',monospace"}}>
                    {fmtX(displayBalance(debtData.totalDebt,"credit"))}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>
                    {debts.length} debt account{debts.length!==1?"s":""}
                    {debtData.totalMinimums>0&&<> · {fmt(debtData.totalMinimums)}/mo in minimum payments</>}
                    {" "}· hidden accounts excluded
                  </div>
                </>
              )}
            </div>

            {!busy&&debts.length===0&&(
              <div className="card" style={{textAlign:"center",padding:"34px 16px",color:"var(--muted)",fontSize:13,lineHeight:1.6}}>
                No credit or loan accounts yet.<br/>
                Link a card or loan through SimpleFIN (Accounts tab) and it shows up here with its balance synced daily.
              </div>
            )}

            {(busy||debts.length>0)&&(
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Your debts</div>
              {!hasCols&&!busy&&(
                <div style={{fontSize:11,color:"var(--muted)",background:"var(--bg)",borderRadius:8,padding:"8px 12px",marginBottom:10}}>
                  Balances are live; APR and minimum-payment entry activates once the debt-tracker migration is applied.
                </div>
              )}
              {hasCols&&<div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>
                Balances sync from the feed; APR, minimum payment and credit limit are yours to type in — they feed the payoff projection below.
              </div>}
              {busy?[1,2].map(i=><div key={i} style={{marginBottom:14}}><Sk h={64}/></div>):
                debts.map((a,i)=>{
                  const bal=Number(a.current_balance)||0;
                  const limit=Number(a.credit_limit)||0;
                  const util=a.type==="credit"&&limit>0?Math.min(bal/limit,1):null;
                  const utilColor=util!=null?(util>=.8?OVER_MONEY:OK_MONEY):null;
                  const inc=inPayoff(a);
                  return (
                    <div key={a.id} style={{padding:"10px 0",borderTop:i?"1px solid var(--border)":"none",animationDelay:i*.03+"s"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{width:10,height:10,borderRadius:3,background:markOn(acctColor(a),surf.card),flexShrink:0}}/>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{acctLabel(a)}</div>
                          <div style={{fontSize:11,color:"var(--muted)",marginTop:1}}>
                            {[acctInst(a),a.type==="credit"?"Credit card":isMortgage(a)?"Mortgage":"Loan",
                              a.next_payment_due_date?`due ${shortDate(a.next_payment_due_date)}`:null].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontSize:14,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{fmtX(displayBalance(a.current_balance,a.type))}</div>
                          {util!=null&&<div style={{fontSize:10,color:inkOn(utilColor,surf.card),marginTop:1}}>{Math.round(util*100)}% of limit</div>}
                        </div>
                      </div>
                      {util!=null&&(
                        <div className="bar-bg" style={{marginTop:7}}>
                          <div className="bar-fill" style={{width:(util*100)+"%",background:markOn(utilColor,surf.track)}}/>
                        </div>
                      )}
                      {hasCols&&(
                        <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:10,marginTop:8}}>
                          <DebtNum id={a.id+":apr"} value={a.apr} placeholder="APR" suffix="%" width={56}
                            onSave={v=>saveDebt(a.id,{apr:v})}/>
                          <DebtNum id={a.id+":min"} value={a.minimum_payment} placeholder="min" prefix="$" suffix="/mo" width={64}
                            onSave={v=>saveDebt(a.id,{minimum_payment:v})}/>
                          {a.type==="credit"&&(
                            <DebtNum id={a.id+":lim"} value={a.credit_limit} placeholder="limit" prefix="$" width={70}
                              onSave={v=>saveDebt(a.id,{credit_limit:v})}/>
                          )}
                          {/* Commit on BLUR only — a date input emits COMPLETE
                              garbage values while the year is typed (see the
                              placed_in_service comment). */}
                          <label style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,color:"var(--muted)"}}>due
                            <input type="date" key={a.id+":due:"+(a.next_payment_due_date||"")} defaultValue={a.next_payment_due_date||""}
                              onBlur={ev=>{const raw=ev.target.value||null;const v=raw&&raw.slice(0,4)>="1900"?raw:null;
                                ev.target.value=v||"";
                                if(v!==(a.next_payment_due_date||null))saveDebt(a.id,{next_payment_due_date:v});}}
                              style={{padding:"5px 7px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",
                                color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                          </label>
                          <button onClick={()=>setDebtInclude(prev=>({...prev,[a.id]:!inc}))}
                            title={inc?"Included in the payoff projection":isMortgage(a)?"Mortgages are excluded from the projection by default — they'd dominate it":"Tap to include in the payoff projection"}
                            style={{marginLeft:"auto",fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                              background:inc?chipOn(TYPE_CHIP,surf.card).bg:"var(--bg)",
                              color:inc?chipOn(TYPE_CHIP,surf.card).ink:"var(--muted)",
                              border:`1px solid ${inc?markOn(TYPE_CHIP,surf.card):"var(--border)"}`,transition:"all .15s"}}>
                            {inc?"✓ in payoff":"＋ payoff"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
            )}

            {!busy&&hasCols&&debts.length>0&&(
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Payoff projection</div>
              <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:8,marginBottom:12}}>
                {["snowball","avalanche"].map(s=>{
                  const active=debtStrategy===s;
                  const cs=active?chipOn(TYPE_CHIP,surf.card):null;
                  return (
                    <button key={s} onClick={()=>setDebtStrategy(s)}
                      title={s==="snowball"?"Smallest balance first — quick wins":"Highest APR first — least interest"}
                      style={{fontSize:11,fontWeight:600,padding:"5px 12px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                        background:cs?cs.bg:"var(--bg)",color:cs?cs.ink:"var(--muted)",
                        border:`1px solid ${active?markOn(TYPE_CHIP,surf.card):"var(--border)"}`,transition:"all .15s"}}>
                      {s==="snowball"?"Snowball":"Avalanche"}
                    </button>
                  );
                })}
                <span style={{marginLeft:"auto",display:"inline-flex",alignItems:"center",gap:4,fontSize:12,color:"var(--muted)"}}>
                  extra $
                  <input value={debtExtra} inputMode="decimal" placeholder="0"
                    onChange={e=>setDebtExtra(numericish(e.target.value,{negative:false}))}
                    style={{width:64,padding:"5px 7px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",
                      color:"var(--text)",fontSize:12,fontFamily:"'DM Mono',monospace",outline:"none",textAlign:"right"}}/>
                  /mo
                </span>
              </div>
              {included.length===0?(
                <div style={{fontSize:12,color:"var(--muted)"}}>
                  Nothing is included in the projection yet — tap "＋ payoff" on a debt above.
                  Mortgages are left out by default: they'd dominate the plan and make the debt-free date meaningless.
                </div>
              ):missingMin.length>0?(
                <div style={{fontSize:12,color:"var(--muted)"}}>
                  Enter a minimum payment for {missingMin.map(d=>acctLabel(d)).join(", ")} to project a payoff.
                </div>
              ):plan.stalled?(
                <div style={{fontSize:12,color:"var(--danger)",background:"var(--danger-bg)",border:"1px solid var(--danger-border)",borderRadius:8,padding:"8px 12px"}}>
                  At these payments the balances never fall — the minimums don't cover the monthly interest. Add an extra payment above.
                </div>
              ):(
                <>
                  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:10}}>
                    {[{label:"Debt-free",val:freeMonth?monthYear(freeMonth):"—",sub:`${plan.months} month${plan.months!==1?"s":""}`},
                      {label:"Total interest",val:fmtAuto(plan.totalInterest),sub:`${debtStrategy} order`},
                      ...(extra>0?[{label:"vs minimums only",val:fmtAuto(plan.interestSaved)+" saved",sub:plan.monthsSaved>0?`${plan.monthsSaved} month${plan.monthsSaved!==1?"s":""} sooner`:"same timeline",clr:inkOn(OK_MONEY,surf.bg)}]:[]),
                    ].map((c,i)=>(
                      <div key={i} style={{flex:"1 1 100px",background:"var(--bg)",borderRadius:10,padding:"10px 12px"}}>
                        <div style={{fontSize:10,color:"var(--muted)",fontWeight:500,marginBottom:3}}>{c.label}</div>
                        <div style={{fontSize:15,fontWeight:600,fontFamily:"'DM Mono',monospace",color:c.clr||"var(--text)"}}>{c.val}</div>
                        <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{c.sub}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>
                    {plan.perDebt.filter(d=>d.months!=null).map(d=>`${d.name||"?"} clears month ${d.months}`).join(" · ")}
                  </div>
                </>
              )}
              <div style={{marginTop:10,fontSize:10,color:"var(--muted)"}}>
                Projection assumes the current balances, no new charges, and a fixed monthly budget of the minimums plus any extra —
                freed-up minimums roll onto the next debt.
              </div>
            </div>
            )}

            {series.length>=2&&(
            <div className="card">
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Total owed over time</div>
              {(()=>{
                const max=Math.max(...series.map(p=>p.total),1);
                const min=Math.min(...series.map(p=>p.total));
                const span=Math.max(max-min,max*.02,1);
                const W=300,H=60;
                const pts=series.map((p,i)=>`${(i/(series.length-1))*W},${H-4-((p.total-min)/span)*(H-8)}`).join(" ");
                const line=markOn("#7F77DD",surf.card);
                return (
                  <>
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{width:"100%",height:H,display:"block"}}>
                      <polyline points={pts} fill="none" stroke={line} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
                    </svg>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:10,color:"var(--muted)",fontFamily:"'DM Mono',monospace"}}>
                      <span>{shortDate(series[0].date)} · {fmt(displayBalance(series[0].total,"credit"))}</span>
                      <span>{shortDate(series[series.length-1].date)} · {fmt(displayBalance(series[series.length-1].total,"credit"))}</span>
                    </div>
                  </>
                );
              })()}
              <div style={{marginTop:8,fontSize:10,color:"var(--muted)"}}>Snapshots are taken by the daily sync whenever a balance changes — the line fills in over time.</div>
            </div>
            )}
          </div>
          );
        })()}

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
            {chatMsgs.length>0&&(
              <div style={{display:"flex",justifyContent:"center",gap:8,marginTop:10}}>
                <button onClick={()=>downloadCsv(`spending_chat_${new Date().toISOString().slice(0,10)}.md`,chatTranscript(chatMsgs),"text/markdown")}
                  style={{fontSize:11,fontFamily:"inherit",color:"var(--text)",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,padding:"5px 10px",cursor:"pointer"}}>
                  Save chat
                </button>
                <button onClick={clearChat} disabled={chatBusy}
                  style={{fontSize:11,fontFamily:"inherit",color:"var(--muted)",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,padding:"5px 10px",cursor:chatBusy?"default":"pointer",opacity:chatBusy?.5:1}}>
                  New chat
                </button>
              </div>
            )}
            <div style={{marginTop:8,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              Read-only: the assistant sees your data but can't change anything. Chats stay on this device until the tab or app closes — Save chat exports a copy.
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
                // Quiet signal badges (not a nag banner): amber warn for a
                // price hike or a charge due within a week, red danger for an
                // overdue one. Colours are the app's warn/danger data hexes run
                // through the contrast helpers against the card surface, same as
                // the Categories over/under money pair.
                const overdue=r.dueStatus==="overdue";
                const dueSoon=r.dueStatus==="due-soon";
                const dueHex=overdue?"#D85A30":"#C08A2E";
                const dueChip=chipOn(dueHex,surf.card), creepChip=chipOn("#C08A2E",surf.card);
                const badge={display:"inline-flex",alignItems:"center",gap:3,fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:6,whiteSpace:"nowrap"};
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
                      {r.priceCreep&&(
                        <span style={{...badge,color:creepChip.ink,background:creepChip.bg}}>
                          ↑ was {fmtX(r.medianAmount)} now {fmtX(r.lastAmount)}
                        </span>
                      )}
                      {(overdue||dueSoon)&&(
                        <span style={{...badge,color:dueChip.ink,background:dueChip.bg}}>
                          {overdue?"⚠ overdue":"● due soon"}
                        </span>
                      )}
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

        {/* TAX — the rental Schedule E lens, personal deductions and the
            mileage log. Record-keeping for the preparer, NOT tax math: no AGI
            floors, no depreciation schedules, no advice. Entity-tagged rows
            still count in every household spending view — this tab is a lens
            over the same rows, not an exclusion (deliberate; don't "fix" it by
            filtering them out of spending). */}
        {tab==="tax"&&(()=>{
          const activeEnts=entities.filter(e=>!e.archived_at);
          const txs=taxData?.transactions||[];
          const busy=taxLoading||!taxData;
          const dmap=taxMaps?.dmap||DEFAULT_DEDUCTION_MAP;
          const canNextTax=taxYear<now.getFullYear();
          const personalRows=txs.filter(t=>!t.effective_entity_id);
          const deductions=personalDeductionReport(personalRows,dmap);
          const mileSum=mileageDeduction(mileage);
          const entName=id=>entities.find(x=>x.id===id)?.name||null;
          // Active properties, plus archived ones that still have rows in the
          // viewed year — an archive must not erase a filed year's worksheet.
          const shownEnts=entities.filter(e=>!e.archived_at||txs.some(t=>t.effective_entity_id===e.id));
          const lineOptions=[["","Not mapped"],[RENTS_KEY,"Rents received (income)"],...SCHEDULE_E_LINES.map(l=>[String(l.line),`${l.line} · ${l.label}`])];
          const selStyleSm={fontSize:11,fontFamily:"inherit",color:"var(--text)",background:"var(--bg)",border:"1px solid var(--border)",borderRadius:8,padding:"4px 6px",cursor:"pointer",outline:"none",maxWidth:180};
          const allCatNames=[...ERA_CATEGORIES.filter(c=>c!==UNCATEGORIZED),...customCatNames.filter(n=>!ERA_CATEGORIES.includes(n))];
          const localToday=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
          const amber=inkOn("#C08A2E",surf.card);
          return (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {/* Tax year + framing */}
            <div className="card">
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
                <button className="nbtn" onClick={()=>{setTaxYear(y=>y-1);invalidateTax();}}>‹</button>
                <div style={{fontSize:18,fontWeight:600,minWidth:90,textAlign:"center",color:"var(--text)"}}>{taxYear}</div>
                <button className="nbtn" disabled={!canNextTax} onClick={()=>{if(canNextTax){setTaxYear(y=>y+1);invalidateTax();}}}>›</button>
              </div>
              <div style={{fontSize:10,color:"var(--muted)",textAlign:"center",marginTop:6,lineHeight:1.5}}>
                Calendar-year records for your tax preparer — not tax advice. Rental transactions still
                count in the household spending views; this tab is a lens over the same rows.
              </div>
            </div>

            {/* Properties */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>Rental properties</div>
                <button className="ibtn" style={{fontSize:11}} onClick={()=>setAddingEntity(v=>!v)}>＋ Add property</button>
              </div>
              {addingEntity&&(
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <input value={newEntityName} onChange={e=>setNewEntityName(e.target.value)} placeholder="e.g. Maple St duplex"
                    autoFocus onKeyDown={e=>{if(e.key==="Enter")handleAddEntity();}}
                    style={{flex:1,minWidth:0,padding:"8px 10px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:14,fontFamily:"inherit",outline:"none"}}/>
                  <button onClick={handleAddEntity} disabled={!newEntityName.trim()}
                    style={{padding:"0 14px",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",fontSize:12,fontWeight:600,cursor:newEntityName.trim()?"pointer":"default",opacity:newEntityName.trim()?1:.5}}>
                    Add
                  </button>
                </div>
              )}
              {entities.length===0&&!addingEntity&&(
                <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
                  Add a property, then tag its money: assign a whole account to it from the Accounts tab,
                  or tag single transactions in their detail sheet. This tab builds the Schedule E
                  worksheet from whatever is tagged.
                </div>
              )}
              {entities.map(e=>(
                <div key={e.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,opacity:e.archived_at?.55:1}}>
                  <span style={{width:11,height:11,borderRadius:3,background:markOn(ENTITY_CHIP,surf.card),flexShrink:0}}/>
                  <span style={{fontSize:13,fontWeight:500,color:"var(--text)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    <EditName name={e.name} onSave={v=>renameEntity(e.id,v)}/>
                  </span>
                  {e.archived_at
                    ?<button className="ibtn" style={{fontSize:10}} onClick={()=>setEntityArchived(e.id,false)}>Restore</button>
                    :<button onClick={()=>setEntityArchived(e.id,true)} title={`Archive ${e.name}`}
                        style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:18,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>}
                </div>
              ))}
              {entities.length>0&&(
                <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginTop:4}}>
                  Archiving hides a property from pickers; its tagged history stays and past years still report.
                </div>
              )}
            </div>

            {busy&&(
              <div className="card">
                <Sk h={16}/><div style={{height:10}}/><Sk h={16} w="70%"/><div style={{height:10}}/><Sk h={16} w="45%"/>
              </div>
            )}

            {/* One worksheet card per property */}
            {!busy&&shownEnts.map(e=>{
              const rows=txs.filter(t=>t.effective_entity_id===e.id);
              const emap=emapFor(e.id);
              const rep=scheduleEReport(rows,emap);
              const months=entityMonthly(rows);
              const totIn=months.reduce((s,m)=>s+m.income,0);
              const totOut=months.reduce((s,m)=>s+m.expenses,0);
              const catsPresent=[...new Set(rows.filter(t=>!t.is_capital).map(t=>t.category))].sort();
              return (
              <div className="card" key={e.id}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10}}>
                  <div style={{fontSize:15,fontWeight:600,color:"var(--text)"}}>{e.name}</div>
                  <DrillNum onClick={rows.length?()=>setTaxDrill(e.id):null} title={`Everything compiled under ${e.name}`}
                    style={{fontSize:11,color:"var(--muted)",flexShrink:0}}>{rows.length} transaction{rows.length!==1?"s":""} in {taxYear}</DrillNum>
                </div>
                {rows.length===0?(
                  <div style={{fontSize:12,color:"var(--muted)",marginTop:8}}>Nothing tagged to this property in {taxYear} yet.</div>
                ):(<>
                  <div style={{display:"flex",gap:20,margin:"10px 0 2px"}}>
                    <div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>Money in</div>
                      <DrillNum onClick={()=>setTaxDrill(e.id)} title={`Everything compiled under ${e.name}`}
                        style={{display:"block",fontSize:15,fontWeight:600,fontFamily:"'DM Mono',monospace",color:inkOn("#1D9E75",surf.card)}}>{fmtAuto(totIn)}</DrillNum>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>Money out</div>
                      <DrillNum onClick={()=>setTaxDrill(e.id)} title={`Everything compiled under ${e.name}`}
                        style={{display:"block",fontSize:15,fontWeight:600,fontFamily:"'DM Mono',monospace",color:"var(--text)"}}>{fmtAuto(totOut)}</DrillNum>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>Net cash</div>
                      <div style={{fontSize:15,fontWeight:600,fontFamily:"'DM Mono',monospace",color:totIn-totOut<0?inkOn("#D85A30",surf.card):"var(--text)"}}>{signed(Math.round((totIn-totOut)*100)/100)}</div>
                    </div>
                  </div>

                  <div style={{borderTop:"1px solid var(--border)",margin:"12px 0 10px"}}/>
                  <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Schedule E worksheet</div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
                    <span style={{color:"var(--text)"}}>3 · Rents received</span>
                    <span style={{fontFamily:"'DM Mono',monospace",color:"var(--text)"}}>{fmtAuto(rep.rents.total)}</span>
                  </div>
                  {/* Line 3 goes on the return — say how much of it was a
                      DEFAULT (unmapped money in) rather than an explicit
                      mapping, so a refund in an unmapped category can't
                      inflate rents invisibly. */}
                  {rep.rents.defaulted.count>0&&(
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:-2,marginBottom:6}}>
                      includes {fmtAuto(rep.rents.defaulted.total)} from {rep.rents.defaulted.count} unmapped
                      deposit{rep.rents.defaulted.count!==1?"s":""} counted as rent by default — map their
                      categories below if that's wrong
                    </div>
                  )}
                  {rep.lines.filter(l=>l.total!==0).map(l=>(
                    <div key={l.line} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
                      <span style={{color:"var(--text)"}}>{l.line} · {l.label}</span>
                      <span style={{fontFamily:"'DM Mono',monospace",color:"var(--text)"}}>{fmtAuto(l.total)}</span>
                    </div>
                  ))}
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,marginTop:2,paddingTop:6,borderTop:"1px solid var(--border)"}}>
                    <span style={{color:"var(--text)"}}>Total expenses on the worksheet</span>
                    <span style={{fontFamily:"'DM Mono',monospace",color:"var(--text)"}}>{fmtAuto(rep.totalExpenses)}</span>
                  </div>

                  {rep.unmapped.length>0&&(
                    <div style={{marginTop:10,background:"var(--bg)",borderRadius:8,padding:"8px 10px"}}>
                      {/* This panel is --bg, so the amber must be corrected
                          against surf.bg — amber (card) belongs to notes that
                          sit directly on the card. */}
                      <div style={{fontSize:11,fontWeight:600,color:inkOn("#C08A2E",surf.bg),marginBottom:6}}>
                        Not on any line yet — {fmtAuto(rep.unmappedTotal)}
                      </div>
                      {rep.unmapped.map(u=>(
                        <div key={u.category} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--muted)",marginBottom:4}}>
                          <span>{getName(u.category)} · {u.count}</span>
                          <span style={{fontFamily:"'DM Mono',monospace"}}>{fmtAuto(u.total)}</span>
                        </div>
                      ))}
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>Map these categories below and they move onto the worksheet.</div>
                    </div>
                  )}

                  {rep.capital.items.length>0&&(
                    <div style={{marginTop:10}}>
                      <div style={{fontSize:11,fontWeight:600,color:"var(--text)",marginBottom:6}}>
                        Capital expenses (depreciate, don't deduct) — {fmtAuto(rep.capital.total)}
                      </div>
                      {rep.capital.items.map(c=>{
                        const row=rows.find(r=>r.id===c.id);
                        return (
                          <div key={c.id} onClick={row?()=>setSelTx(row):undefined}
                            style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11,color:"var(--muted)",marginBottom:4,cursor:row?"pointer":"default"}}>
                            <span style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {shortDate(c.date)} · {c.description}
                              {(!c.placed_in_service||!c.useful_life_years)&&<span style={{color:amber}}> · needs in-service date/life</span>}
                              {receiptTxIds&&!receiptTxIds.has(c.id)&&<span style={{color:amber}}> · no receipt</span>}
                            </span>
                            <span style={{fontFamily:"'DM Mono',monospace",flexShrink:0}}>{fmtAuto(c.amount)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{borderTop:"1px solid var(--border)",margin:"12px 0 10px"}}/>
                  <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:8}}>Category → Schedule E line</div>
                  {catsPresent.map(cat=>{
                    const cur=emap[cat];
                    const val=cur===RENTS_KEY?RENTS_KEY:(typeof cur==="number"?String(cur):"");
                    return (
                      <div key={cat} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:6}}>
                        <span style={{fontSize:12,color:"var(--text)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getName(cat)}</span>
                        <select value={val} style={selStyleSm}
                          onChange={ev=>{const v=ev.target.value;setEmapEntry(e.id,cat,v===""?null:(v===RENTS_KEY?RENTS_KEY:Number(v)));}}>
                          {lineOptions.map(([v,l])=><option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                    );
                  })}
                  <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginTop:2}}>
                    Money in with no mapping counts as rent automatically. The mapping applies to this property only.
                  </div>

                  <button className="ibtn" style={{width:"100%",justifyContent:"center",marginTop:12}}
                    onClick={()=>downloadCsv(`${e.name.replace(/[^\w-]+/g,"_")}_${taxYear}_scheduleE.csv`,scheduleECsv(rep,{entityName:e.name,year:taxYear,receiptTxIds}))}>
                    Export worksheet CSV
                  </button>
                </>)}
              </div>
              );
            })}

            {/* Personal deductions */}
            {!busy&&(
              <div className="card">
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Personal deductions</div>
                {deductions.map(b=>(
                  <div key={b.key} style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
                    <span style={{color:"var(--text)"}}>{b.label}{b.count>0&&<span style={{color:"var(--muted)"}}> · {b.count}</span>}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",color:"var(--text)"}}>{fmtAuto(b.total)}</span>
                  </div>
                ))}
                <div style={{borderTop:"1px solid var(--border)",margin:"10px 0"}}/>
                <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",marginBottom:8}}>Which categories count</div>
                {Object.entries(dmap).map(([cat,bucket])=>(
                  <div key={cat} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:6}}>
                    <span style={{fontSize:12,color:"var(--text)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getName(cat)}</span>
                    <select value={bucket} style={selStyleSm}
                      onChange={ev=>setDmapEntry(cat,ev.target.value||null)}>
                      {DEDUCTION_BUCKETS.map(b=><option key={b.key} value={b.key}>{b.label}</option>)}
                      <option value="">Remove</option>
                    </select>
                  </div>
                ))}
                <select value="" style={{...selStyleSm,maxWidth:"100%",marginTop:2}}
                  onChange={ev=>{if(ev.target.value)setDmapEntry(ev.target.value,"charitable");}}>
                  <option value="">＋ Count a category…</option>
                  {allCatNames.filter(c=>!(c in dmap)).map(c=><option key={c} value={c}>{getName(c)}</option>)}
                </select>
                <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginTop:8}}>
                  Year totals your preparer asks about. As of 2026, charitable gifts can be deducted even
                  without itemizing — bring the total either way. Rental-tagged rows never count here.
                </div>
              </div>
            )}

            {/* Mileage */}
            {!busy&&(
              <div className="card">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>Mileage</div>
                  {!mileForm&&<button className="ibtn" style={{fontSize:11}} onClick={()=>setMileForm({on_date:localToday,miles:"",purpose:"",entity_id:activeEnts[0]?.id||""})}>＋ Log a drive</button>}
                </div>
                <div style={{fontSize:13,color:"var(--text)",marginBottom:4}}>
                  <strong style={{fontFamily:"'DM Mono',monospace"}}>{mileSum.miles.toLocaleString("en-US")}</strong> mi in {taxYear} ·
                  deduction <strong style={{fontFamily:"'DM Mono',monospace"}}>{fmtAuto(mileSum.amount)}</strong>
                </div>
                {mileSum.byRate.length>1&&(
                  <div style={{fontSize:10,color:"var(--muted)",marginBottom:4}}>
                    {mileSum.byRate.map(r=>`${r.miles.toLocaleString("en-US")} mi × ${(r.rate*100).toFixed(1)}¢`).join(" · ")}
                  </div>
                )}
                {mileSum.unratedMiles>0&&(
                  <div style={{fontSize:10,color:amber,marginBottom:4}}>
                    {mileSum.unratedMiles} mi predate the app's rate table and are valued at $0 — give your preparer the dates.
                  </div>
                )}
                {mileForm&&(
                  <div style={{marginTop:8,background:"var(--bg)",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                      <input type="date" value={mileForm.on_date} onChange={ev=>setMileForm(f=>({...f,on_date:ev.target.value}))}
                        style={{flex:"1 1 130px",padding:"6px 8px",borderRadius:8,border:"1px solid var(--border)",background:"var(--card)",color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                      <input inputMode="decimal" placeholder="Miles" value={mileForm.miles}
                        onChange={ev=>setMileForm(f=>({...f,miles:ev.target.value.replace(/[^\d.]/g,"")}))}
                        style={{flex:"0 1 80px",padding:"6px 8px",borderRadius:8,border:"1px solid var(--border)",background:"var(--card)",color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                    </div>
                    <input placeholder="Purpose (e.g. showing, repair run)" value={mileForm.purpose}
                      onChange={ev=>setMileForm(f=>({...f,purpose:ev.target.value}))}
                      style={{width:"100%",padding:"6px 8px",borderRadius:8,border:"1px solid var(--border)",background:"var(--card)",color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none",marginBottom:8}}/>
                    {activeEnts.length>0&&(
                      <select value={mileForm.entity_id} style={{...selStyleSm,background:"var(--card)",maxWidth:"100%",marginBottom:8}}
                        onChange={ev=>setMileForm(f=>({...f,entity_id:ev.target.value}))}>
                        {activeEnts.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
                        <option value="">No property</option>
                      </select>
                    )}
                    <div style={{display:"flex",gap:8}}>
                      <button className="ibtn" style={{flex:1,justifyContent:"center"}} onClick={()=>setMileForm(null)}>Cancel</button>
                      <button onClick={handleAddMileage} disabled={!mileForm.on_date||!(Number(mileForm.miles)>0)}
                        style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",fontSize:12,fontWeight:600,
                          cursor:mileForm.on_date&&Number(mileForm.miles)>0?"pointer":"default",opacity:mileForm.on_date&&Number(mileForm.miles)>0?1:.5}}>
                        Save drive
                      </button>
                    </div>
                  </div>
                )}
                {mileage.length>0&&<div style={{height:8}}/>}
                {mileage.map(m=>(
                  <div key={m.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:11,color:"var(--muted)",marginBottom:5}}>
                    <span style={{flexShrink:0}}>{shortDate(m.on_date)}</span>
                    <span style={{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--text)"}}>
                      {m.purpose||"Drive"}{m.entity_id&&entName(m.entity_id)?` · ${entName(m.entity_id)}`:""}
                    </span>
                    <span style={{fontFamily:"'DM Mono',monospace",flexShrink:0}}>{Number(m.miles).toLocaleString("en-US")} mi</span>
                    <button onClick={()=>handleDeleteMileage(m.id)} title="Delete this drive"
                      style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:15,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                  </div>
                ))}
                <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginTop:8}}>
                  Valued at the IRS standard rate for the drive's date (2026: 72.5¢/mi Jan–Jun, 76¢/mi from
                  Jul 1). Hand-entered — log rental and other deductible drives only.
                </div>
              </div>
            )}
          </div>
          );
        })()}

        <div style={{textAlign:"center",marginTop:18,fontSize:11,color:"var(--muted)"}}>my-money</div>
      </div>

      {/* Category drill-in. Rendered BEFORE the transaction sheet on purpose:
          both are .overlay at the same z-index, so DOM order is what puts the
          transaction sheet on top when a row in here is tapped — and closing it
          drops back to this list rather than to the dashboard. */}
      {catDrill&&(
        <CategorySheet name={catDrill} color={getColor(catDrill)} when={monthLabel(year,month)}
          rows={drillRows} surf={surf} getName={getName}
          acctById={acctById} acctLabel={acctLabel} acctColor={acctColor}
          onPick={t=>setSelTx(t)} onClose={()=>setCatDrill(null)}/>
      )}

      {/* Property drill-in — same stacking rule as the category sheet above:
          rendered before the transaction sheet so a tapped row's detail opens
          on top, and closing it drops back to this list. */}
      {taxDrill&&(()=>{
        const ent=entities.find(x=>x.id===taxDrill);
        if(!ent)return null;
        const propRows=(taxData?.transactions||[]).filter(t=>t.effective_entity_id===taxDrill);
        return (
          <PropertySheet name={ent.name} year={taxYear} rows={propRows} busy={taxLoading||!taxData}
            receiptTxIds={receiptTxIds} surf={surf} getName={getName} getColor={getColor}
            acctById={acctById} acctLabel={acctLabel} acctColor={acctColor}
            onPick={t=>setSelTx(t)} onClose={()=>setTaxDrill(null)}/>
        );
      })()}

      {/* Transaction detail modal */}
      {selTx&&(()=>{
        const a=acctById(selTx.account_id);
        // Uncategorized is never offered as a manual choice — it means "the
        // classifier didn't know", and the way to undo a wrong pick is
        // "Reset to automatic" below, not to assert ignorance by hand.
        const allCats=[...ERA_CATEGORIES.filter(c=>c!==UNCATEGORIZED),...customCatNames.filter(n=>!ERA_CATEGORIES.includes(n))];
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
                  <button key={cat} onClick={()=>{const next=cat===selTx.auto_category?null:cat;saveTx({user_category:next});setLearnedNote(null);if(next)offerToLearn(next);else setLearnPrompt(null);}}
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

            {/* Teach the merchant. Without this, correcting a transaction fixes
                exactly one row and the same merchant lands in Uncategorized
                again next month — Plaid used to absorb that invisibly. */}
            {learnPrompt&&(
              <div style={{marginTop:10,background:"var(--bg)",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:11,color:"var(--text)",lineHeight:1.5,marginBottom:8}}>
                  Always categorize <strong>{learnPrompt.key}</strong> as <strong>{getName(learnPrompt.category)}</strong>?
                  {learnPrompt.count>0&&<> Also updates {learnPrompt.count} past transaction{learnPrompt.count!==1?"s":""}.</>}
                  {learnPrompt.count===0&&<> No past transactions match it.</>}
                </div>
                {learnPrompt.previewError&&(
                  <div style={{fontSize:10,color:inkOn("#D85A30",surf.bg),lineHeight:1.5,marginBottom:8}}>
                    Couldn't check past transactions: {learnPrompt.previewError}. The rule will still be
                    saved for future transactions.
                  </div>
                )}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setLearnPrompt(null)} className="ibtn" style={{flex:1,justifyContent:"center",fontSize:11}}>Just this one</button>
                  <button onClick={learnMerchant} disabled={learning}
                    style={{flex:1,padding:"6px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:learning?"default":"pointer",opacity:learning?.6:1}}>
                    {learning?"Saving…":"Always"}
                  </button>
                </div>
              </div>
            )}
            {learnedNote&&(
              <div style={{marginTop:10,fontSize:11,color:inkOn("#1D9E75",surf.card),lineHeight:1.5}}>{learnedNote}</div>
            )}

            {/* Rental property + capital flag. selTx.entity_id is the row's
                OWN assignment; null inherits the account's default. Offered
                once a property exists (or the row already carries one). */}
            {(entities.some(e=>!e.archived_at)||selTx.entity_id)&&(()=>{
              const acctEnt=a?.entity_id||null;
              const own=selTx.entity_id||null;
              const eff=own||acctEnt;
              const pickable=entities.filter(e=>!e.archived_at||e.id===own);
              return (<>
                <div style={{borderTop:"1px solid var(--border)",margin:"12px 0"}}/>
                <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Rental property</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:6}}>
                  {/* With an account default there is no "None": untagging a
                      row on a rental account just falls back to the default,
                      so offering None would be a chip that can't stick. */}
                  {[...(acctEnt?[]:[{id:null,name:"None"}]),...pickable].map(e=>{
                    const active=e.id?(eff===e.id):!eff;
                    const cs=active&&e.id?chipOn(ENTITY_CHIP,surf.card):null;
                    return (
                      <button key={e.id||"none"}
                        onClick={()=>saveTx({entity_id:e.id===acctEnt?null:e.id})}
                        style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                          background:cs?cs.bg:"var(--bg)",color:cs?cs.ink:(active?"var(--text)":"var(--muted)"),
                          border:`1px solid ${active?(e.id?markOn(ENTITY_CHIP,surf.card):"var(--text)"):"var(--border)"}`,transition:"all .15s"}}>
                        {e.name}{e.id&&e.id===acctEnt&&!own?" · account":""}
                      </button>
                    );
                  })}
                </div>
                {/* The tag's EFFECT, said out loud — the linkage Mason asked
                    for existed but nothing confirmed it. Tagged: a dotted
                    link straight to the property's compiled ledger. Untagged:
                    one line saying what tagging does. */}
                {eff?(
                  <button onClick={()=>jumpToTax(eff)}
                    style={{background:"none",border:"none",padding:0,fontFamily:"inherit",fontSize:10,color:"var(--muted)",
                      cursor:"pointer",textDecoration:"underline",textDecorationStyle:"dotted",textUnderlineOffset:3}}>
                    Compiled under {entities.find(x=>x.id===eff)?.name||"this property"} in the Tax tab ›
                  </button>
                ):(
                  <div style={{fontSize:10,color:"var(--muted)"}}>
                    Tag a property and this transaction is compiled in the Tax tab for tax time.
                  </div>
                )}
                {eff&&(
                  <div style={{marginTop:4}}>
                    <button onClick={()=>saveTx({is_capital:!selTx.is_capital})}
                      style={{width:"100%",padding:"8px 0",borderRadius:8,background:"none",color:"var(--text)",
                        border:`1px solid ${selTx.is_capital?markOn(ENTITY_CHIP,surf.card):"var(--border)"}`,
                        fontFamily:"inherit",fontSize:12,fontWeight:500,cursor:"pointer"}}>
                      {selTx.is_capital?"✓ Capital expense (improvement)":"Mark as capital expense (improvement)"}
                    </button>
                    <div style={{marginTop:5,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
                      Improvements are depreciated, not deducted — the worksheet lists them separately.
                    </div>
                    {selTx.is_capital&&(
                      <div style={{display:"flex",gap:8,marginTop:8}}>
                        <label style={{flex:1,fontSize:10,color:"var(--muted)"}}>Placed in service
                          {/* Commit on BLUR only. Typing a year in a date
                              input yields a COMPLETE value per keystroke
                              ("0002-…", "0020-…", …), so an onChange commit
                              persists garbage intermediate years — and the
                              optimistic patch then makes blur a no-op on the
                              garbage (review-caught). The year floor rejects
                              an abandoned partial year the same way. */}
                          <input type="date" key={selTx.id} defaultValue={selTx.placed_in_service||""}
                            onBlur={ev=>{const raw=ev.target.value||null;const v=raw&&raw.slice(0,4)>="1900"?raw:null;
                              ev.target.value=v||"";
                              if(v!==(selTx.placed_in_service||null))saveTx({placed_in_service:v});}}
                            style={{width:"100%",marginTop:3,padding:"6px 8px",borderRadius:8,border:"1px solid var(--border)",
                              background:"var(--bg)",color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                        </label>
                        <label style={{width:104,fontSize:10,color:"var(--muted)"}}>Useful life (yrs)
                          <input inputMode="numeric" key={selTx.id} defaultValue={selTx.useful_life_years??""}
                            onBlur={ev=>{const n=parseInt(ev.target.value,10);const v=Number.isFinite(n)&&n>0?n:null;
                              ev.target.value=v==null?"":String(v); // show what was actually saved
                              if(v!==(selTx.useful_life_years??null))saveTx({useful_life_years:v});}}
                            style={{width:"100%",marginTop:3,padding:"6px 8px",borderRadius:8,border:"1px solid var(--border)",
                              background:"var(--bg)",color:"var(--text)",fontSize:12,fontFamily:"inherit",outline:"none"}}/>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>);
            })()}

            {/* Receipt photos. Owns its own load/state (not a transactions
                column, so it's outside the saveTx patch discipline); receipt
                changes only need the tax cache dropped for the no-receipt
                nag. key remounts on row change so state can't bleed. */}
            <ReceiptSection key={selTx.id} txId={selTx.id} onChanged={invalidateTax}/>

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
        <Suspense fallback={null}>
          <CsvImport
            accounts={accounts}
            onClose={()=>setImporting(false)}
            onImported={()=>reloadData(year,month)}
          />
        </Suspense>
      )}

      {/* SimpleFIN connect */}
      {connectingSfin&&(
        <Suspense fallback={null}>
          <SimpleFinConnect
            onClose={()=>setConnectingSfin(false)}
            onConnected={()=>reloadData(year,month)}
          />
        </Suspense>
      )}

      {/* Manual transaction quick-add */}
      {quickAdd&&(()=>{
        const manualAccounts=accounts.filter(a=>isManualAccount(a)&&!isSimpleFinAccount(a));
        // Uncategorized is never an offerable pick (same rule as the detail sheet).
        const allCats=[...ERA_CATEGORIES.filter(c=>c!==UNCATEGORIZED),...customCatNames.filter(n=>!ERA_CATEGORIES.includes(n))];
        return (
          <QuickAddSheet accounts={accounts} manualAccounts={manualAccounts} allCats={allCats}
            getName={getName} getColor={getColor} acctLabel={acctLabel} acctColor={acctColor}
            busy={quickAddBusy} surf={surf} onSave={addManualTx} onClose={()=>setQuickAdd(false)}/>
        );
      })()}

      {/* Funding target (rule 2) */}
      {targetEdit&&(
        <TargetSheet name={getName(targetEdit)} row={envMap[targetEdit]||{target:budgets[targetEdit]??null}} busy={envBusy} surf={surf} year={year} month={month}
          onClose={()=>setTargetEdit(null)}
          onSave={v=>{const c=targetEdit;setTargetEdit(null);saveTarget(c,v);}}/>
      )}

      {/* Move money between envelopes (rule 3) */}
      {moveFrom&&(
        <MoveSheet from={moveFrom} rows={budgetableRows} getName={getName} busy={envBusy} surf={surf}
          chipFor={(cat,active)=>{
            if(!active)return {bg:"var(--bg)",ink:"var(--muted)",border:"var(--border)"};
            const c=chipOn(getColor(cat),surf.card);
            return {bg:c.bg,ink:c.ink,border:c.ink};
          }}
          onClose={()=>setMoveFrom(null)}
          onMove={(f,t,amt)=>{setMoveFrom(null);doMove(f,t,amt);}}/>
      )}

      {/* Pull a category into the Budget tab so it can be assigned to */}
      {pickingCat&&(
        <div className="overlay" onClick={()=>setPickingCat(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"70vh",overflowY:"auto"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:4,color:"var(--text)"}}>Budget another category</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>
              Adds it to this month's budget. Nothing is saved until you assign it money or set a target.
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:18}}>
              {unbudgetedCats.map(c=>(
                <button key={c} onClick={()=>{setExtraEnvCats(p=>p.includes(c)?p:[...p,c]);setPickingCat(false);}}
                  style={{fontSize:11,fontWeight:600,padding:"5px 10px",borderRadius:20,fontFamily:"inherit",cursor:"pointer",
                    background:"var(--bg)",color:"var(--muted)",border:"1px solid var(--border)"}}>
                  {getName(c)}
                </button>
              ))}
            </div>
            <button onClick={()=>setPickingCat(false)} className="ibtn" style={{width:"100%",justifyContent:"center"}}>Cancel</button>
          </div>
        </div>
      )}

      {/* Custom categories: add one, or retire one. Retiring lives HERE rather
          than on the row it used to sit on, because a delete button on some
          rows and not others is exactly the separation this sheet exists to
          remove — in the list itself, a custom category is indistinguishable
          from a built-in one. */}
      {addingCat&&(()=>{
        const dup=customCatNames.some(n=>n.toLowerCase()===newName.trim().toLowerCase())
          ||ERA_CATEGORIES.some(n=>n.toLowerCase()===newName.trim().toLowerCase());
        const canAdd=!!newName.trim()&&!dup;
        const add=()=>{if(!canAdd)return;addCustomCat(newName,newColor);setNewName("");setNewColor("#7F77DD");setAddingCat(false);};
        return (
        <div className="overlay" onClick={()=>setAddingCat(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxHeight:"82vh",overflowY:"auto"}}>
            <div style={{fontSize:16,fontWeight:600,marginBottom:4,color:"var(--text)"}}>Custom categories</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:16,lineHeight:1.5}}>
              They behave exactly like the built-in ones — same list, same color, same funding target.
            </div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Name</div>
            <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. Date nights, Kids activities…"
              onKeyDown={e=>{if(e.key==="Enter")add();}}
              autoFocus
              style={{width:"100%",padding:"9px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--bg)",color:"var(--text)",fontSize:16,fontFamily:"inherit",outline:"none",marginBottom:dup?4:14}}/>
            {dup&&<div style={{fontSize:11,color:"var(--muted)",marginBottom:12}}>That category already exists.</div>}
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
              <button onClick={add} disabled={!canAdd}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"var(--accent)",color:"var(--accent-text)",fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:canAdd?"pointer":"default",opacity:canAdd?1:.5}}>
                Add
              </button>
            </div>

            {customCats.length>0&&(<>
              <div style={{borderTop:"1px solid var(--border)",margin:"18px 0 12px"}}/>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:10}}>Yours</div>
              {customCats.map(c=>(
                <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:9}}>
                  {/* Reads getColor, the same call the row and the Budget tab
                      make — so what's shown here is what's shown there. */}
                  <span style={{width:11,height:11,borderRadius:3,background:markOn(getColor(c.name),surf.card),flexShrink:0}}/>
                  <span style={{fontSize:13,fontWeight:500,color:"var(--text)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{getName(c.name)}</span>
                  <button onClick={()=>removeCustomCat(c.id)} title={`Stop offering ${getName(c.name)}`}
                    style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:18,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                </div>
              ))}
              <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginTop:8}}>
                Removing one just stops offering it. Its color, its target and any transactions already filed
                under it are kept — adding the same name back restores all of it. Change a color or a name on
                the Categories tab, like any other category.
              </div>
            </>)}
          </div>
        </div>
        );
      })()}
    </div>
  );
}
