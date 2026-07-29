import { useState, useEffect, useCallback, useRef } from "react";
import { getOverview, getSpending, getTransactions, getCashFlow, getAccounts, updateAccount, getAccountTransactions, updateTransaction, getBudgets, setBudget, getRecurringCandidates, searchTransactions, isManualAccount, isSimpleFinAccount, ACCOUNT_TYPES, setCategoryRule, applyCategoryRuleToHistory, getEnvelopes, setAssigned, setCategoryRollover, setTargetKind, fundTargets, moveMoney, getBudgetIncome, setBudgetIncome, invalidateEnvelopeSpending, targetNeed, readyToAssign } from "../dataAdapter.js";
import { merchantKey } from "../txClassify.js";
import { detectRecurring } from "../recurring.js";
import { unlinkInstitution, askAssistant } from "../apiClient.js";
import { ERA_CATEGORIES, UNCATEGORIZED, isBudgetableCategory } from "../categoryMap.js";
import { displayBalance, isDebtAccount as isDebtType } from "../accountBalance.js";
import { runSync } from "../sync.js";
import CsvImport from "./CsvImport.jsx";
import SimpleFinConnect from "./SimpleFinConnect.jsx";
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
    try{
      const[ov,sp,tx,cf,ac,bu,en,inc]=await Promise.all([
        cur?getOverview():Promise.resolve(null),
        getSpending({year:y,month:m}),
        getTransactions({year:y,month:m}),
        getCashFlow({num_periods:6}),
        getAccounts(),
        // Tolerate the budgets table not existing yet (migration lands at merge).
        getBudgets().catch(()=>({budgets:{}})),
        // Same for the envelope table — null just shows the not-set-up notice.
        getEnvelopes({year:y,month:m}).catch(()=>null),
        getBudgetIncome({year:y,month:m}).catch(()=>null),
      ]);
      if(seq!==loadSeq.current)return false;
      setOverview(ov);setSpending(sp);setTransactions(tx);setCashFlow(cf);
      setAccounts(ac.accounts||[]);
      setBudgets(bu.budgets||{});
      setEnvelopes(en);
      setIncome(inc);
      setRecurring(null); // recompute lazily on next Recurring-tab visit
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
  const [connectingSfin,setConnectingSfin]=useState(false);

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

  async function offerToLearn(category){
    if(!selTx)return;
    const descriptor=txDescriptor(selTx);
    const key=merchantKey(descriptor);
    if(!key)return;
    let count=0;
    try{ count=await applyCategoryRuleToHistory(descriptor,category,{dryRun:true}); }
    catch(err){ console.error("rule preview failed",err); }
    setLearnPrompt({descriptor,key,category,count});
  }

  async function learnMerchant(){
    if(!learnPrompt)return;
    setLearning(true);
    try{
      await setCategoryRule(learnPrompt.descriptor,learnPrompt.category);
      const n=await applyCategoryRuleToHistory(learnPrompt.descriptor,learnPrompt.category);
      setLearnPrompt(null);
      setLearnedNote(`Remembered — ${learnPrompt.key} is ${getName(learnPrompt.category)}${n>0?`, and ${n} past transaction${n!==1?"s":""} updated`:""}.`);
      await reloadData(year,month);
    }catch(err){
      console.error("learning the merchant failed",err);
      setLearnPrompt(null);
      setLearnedNote(null);
      window.alert(`Couldn't save that rule: ${err.message||err}`);
    }finally{
      setLearning(false);
    }
  }

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
    if(!crossed||!fed)return;
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
    // SimpleFIN can't be unlinked per bank from here: one access URL covers
    // every bank linked at the Bridge, so the app stops syncing this one and
    // forgets its data, while the bank itself stays linked at SimpleFIN.
    const tail=isSimpleFinAccount(selAcct)
      ?"This bank stops syncing into the app. It stays connected at SimpleFIN Bridge — remove it there too if you want it gone for good."
      :"The bank connection is also removed from Plaid (freeing a slot). This cannot be undone — re-linking later re-imports history from Plaid.";
    const ok=window.confirm(
      `${isSimpleFinAccount(selAcct)?"Remove":"Unlink"} ${instName}?\n\nThis removes ${siblings.length} account${siblings.length!==1?"s":""} and all their transactions from the app:\n${list}\n\n${tail}`
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
  // Debts read negative (see src/accountBalance.js). getOverview orders credit
  // accounts first, so this headline is usually a card — and it carries `type`.
  const balance=displayBalance(overview?.accounts?.[0]?.balance?.current,overview?.accounts?.[0]?.type);
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
  // Categories with no envelope yet, offered by the "budget another category"
  // picker. Custom categories are budgetable too.
  const allCatNames=[...ERA_CATEGORIES,...customCats.map(c=>c.name).filter(n=>!ERA_CATEGORIES.includes(n))];
  const unbudgetedCats=allCatNames.filter(c=>isBudgetableCategory(c)&&!envRows.some(r=>r.category===c));

  // Assigning during render is a side effect; the ref has to track the
  // *committed* month so an in-flight envelope write can tell it landed on a
  // stale one.
  useEffect(()=>{monthRef.current=`${year}-${month}`;},[year,month]);

  // Every envelope write goes through here. It re-reads what it wrote rather
  // than updating state optimistically: a budget that shows a number it failed
  // to save is worse than one that takes a beat to settle. If the user has
  // moved to another month meanwhile, the result is dropped rather than shown
  // under the new month. envBusy serializes writes so a double-tap can't
  // interleave two reloads.
  async function runEnvelopeWrite(what,fn){
    if(envBusy)return;
    const key=`${year}-${month}`;
    setEnvBusy(true);setError(null);
    try{
      await fn();
      const[env,inc,bud]=await Promise.all([
        getEnvelopes({year,month}),
        getBudgetIncome({year,month}),
        getBudgets(),
      ]);
      if(monthRef.current===key){setEnvelopes(env);setIncome(inc);setBudgets(bud.budgets||{});}
    }catch(err){
      console.error(`${what} save failed`,err);
      setError(`Couldn't save ${what} — your change wasn't stored. Check your connection and try again.`);
    }finally{setEnvBusy(false);}
  }

  const saveBudget=(category,val)=>runEnvelopeWrite("the target",()=>setBudget(category,val));
  const saveAssigned=(category,val)=>runEnvelopeWrite("the assignment",()=>setAssigned(category,{year,month},val));
  const saveRollover=(category,next)=>runEnvelopeWrite("the rollover setting",()=>setCategoryRollover(category,next));
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
            {" "}<button onClick={()=>setTab("accounts")} style={{background:"none",border:"none",padding:0,font:"inherit",color:"inherit",textDecoration:"underline",cursor:"pointer"}}>Review and unhide</button>.
          </div>
        )}

        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {[
            {label:"Total spent",val:loading?null:fmt(totalSpent),sub:isCurrent&&lastSpent!=null?`vs ${fmt(lastSpent)} last month`:monthLabel(year,month)},
            // Whole dollars like its neighbours: a negative card balance with
            // cents is too wide for a third of a 390px screen and wrapped the
            // minus sign onto its own line.
            {label:"Card balance",val:loading?null:fmt(balance),sub:overview?.accounts?.[0]?.name||"Linked account"},
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
          {["overview","categories","budget","transactions","accounts","trends","recurring","ask"].map(t=>(
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
                      <span style={{fontSize:11,color:"var(--muted)",flexShrink:0,marginLeft:4}}>{c.transaction_count} txn{c.transaction_count!==1?"s":""}</span>
                    </div>
                    <div style={{display:"flex",alignItems:"baseline",gap:5,marginLeft:12,flexShrink:0}}>
                      <span style={{fontSize:13,fontFamily:"'DM Mono',monospace"}}>{fmt(c.amount)}</span>
                      {/* No budget on Uncategorized — it would be a budget on
                          the classifier's ignorance, and the number moves as
                          merchants get learned rather than as spending changes. */}
                      {isBudgetableCategory(c.label)&&<BudgetEdit limit={lim} onSave={v=>saveBudget(c.label,v)}/>}
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
              Click a color swatch to change it · Double-click a name to rename it · ＋ target sets what you want to fund each month; the Budget tab is where you put real dollars in
            </div>
          </div>
        )}

        {/* BUDGET (envelopes — YNAB rules 1, 2 and 3) */}
        {tab==="budget"&&(()=>{
          const okBg=inkOn(OK_MONEY,surf.bg),overBg=inkOn(OVER_MONEY,surf.bg);
          const okCard=inkOn(OK_MONEY,surf.card),overCard=inkOn(OVER_MONEY,surf.card);
          return (
          <div className="card">
            {!envelopes&&!loading&&(
              <div style={{fontSize:12,color:"var(--muted)",textAlign:"center",padding:"28px 12px",lineHeight:1.6}}>
                Envelope budgeting isn't set up yet.<br/>
                Its migration (<code>20260729000001_budget_envelopes.sql</code>) needs to run first.
              </div>
            )}
            {loading&&!envelopes&&[1,2,3,4].map(i=><div key={i} style={{marginBottom:14}}><Sk h={14}/></div>)}
            {envelopes&&(<>
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
                        {r.spent!==0&&(<><span>·</span><span>{fmtAuto(r.spent)} spent</span></>)}
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
                        <button onClick={()=>setMoveFrom(r.category)} disabled={envBusy}
                          title="Move money between this envelope and another"
                          style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"0 2px",
                            fontSize:13,lineHeight:1,color:"var(--muted)",flexShrink:0}}>⇄</button>
                        <button onClick={()=>saveRollover(r.category,!r.rollover)} disabled={envBusy}
                          title={r.rollover?"Leftover rolls into next month — tap to turn off":"Leftover resets each month — tap to roll it over"}
                          style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"0 2px",
                            fontSize:13,lineHeight:1,color:r.rollover?"var(--accent)":"var(--border)",flexShrink:0}}>⟳</button>
                      </div>
                    ):(
                      <div style={{fontSize:11,color:"var(--muted)"}}>
                        {fmtAuto(r.spent)} spent · can't be budgeted — categorize these transactions to give them an envelope
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
                Tap the amount to assign real dollars · ＋ target is what you want to fund · ⇄ moves money between
                envelopes · ⟳ carries a category's leftover (or its overspend) into next month
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
              <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
                <button className="ibtn" style={{fontSize:11}} onClick={()=>setConnectingSfin(true)}>⚡ SimpleFIN</button>
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
        // Uncategorized is never offered as a manual choice — it means "the
        // classifier didn't know", and the way to undo a wrong pick is
        // "Reset to automatic" below, not to assert ignorance by hand.
        const allCats=[...ERA_CATEGORIES.filter(c=>c!==UNCATEGORIZED),...customCats.map(c=>c.name).filter(n=>!ERA_CATEGORIES.includes(n))];
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
                </div>
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

      {/* SimpleFIN connect */}
      {connectingSfin&&(
        <SimpleFinConnect
          onClose={()=>setConnectingSfin(false)}
          onConnected={()=>reloadData(year,month)}
        />
      )}

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
