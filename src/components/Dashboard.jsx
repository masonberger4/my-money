import { useState, useEffect, useCallback, useRef } from "react";
import { getOverview, getSpending, getTransactions, getCashFlow, getAccounts, updateAccount, getAccountTransactions } from "../dataAdapter.js";
import { unlinkInstitution } from "../plaidClient.js";
import { runSync } from "../sync.js";
import { getSetting, setSetting } from "../db.js";

const DEFAULT_COLORS = {
  "Shopping and gear": "#7F77DD", "Health and fitness": "#7F77DD",
  "Entertainment and subscriptions": "#7F77DD", "Travel and vacation": "#7F77DD",
  "Dining out": "#1D9E75", "Childcare": "#1D9E75", "Groceries": "#1D9E75",
  "Pets": "#1D9E75", "Healthcare and pharmacy": "#1D9E75", "Coffee and snacks": "#1D9E75",
  "Vehicle expenses": "#D85A30", "Ride shares": "#D85A30", "Public transit": "#D85A30",
  "Home maintenance and improvement": "#378ADD", "Utilities": "#378ADD",
  "Education": "#FAC775", "Side hustles and business": "#888780",
  "Cash, checks, and misc": "#888780", "Transfers and card payments": "#888780",
};

const TX_ICONS = {
  "Dining out":"🍴","Groceries":"🛒","Vehicle expenses":"🚗","Coffee and snacks":"☕",
  "Childcare":"👶","Pets":"🐾","Health and fitness":"💪","Home maintenance and improvement":"🔧",
  "Entertainment and subscriptions":"🎬","Shopping and gear":"🛍","Travel and vacation":"✈️",
  "Healthcare and pharmacy":"💊","Education":"📚","Side hustles and business":"💼",
};

const ACCOUNT_COLORS = ["#7F77DD","#1D9E75","#D85A30","#378ADD","#FAC775","#D4537E","#639922","#E24B4A"];

function monthLabel(y, m) { return new Date(y,m-1,1).toLocaleString("default",{month:"long",year:"numeric"}); }
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
      {slices.map((s,i)=><path key={i} d={arc(s.s,s.e,r,ir)} fill={s.color} opacity=".9"/>)}
      <circle cx={cx} cy={cy} r={ir-2} fill="var(--card)"/>
    </svg>
  );
}

function Swatch({color,onChange}) {
  const ref=useRef();
  return (
    <div onClick={()=>ref.current?.click()} title="Click to change color"
      style={{width:14,height:14,borderRadius:3,background:color,cursor:"pointer",flexShrink:0,
        outline:"1.5px solid rgba(0,0,0,0.12)",transition:"transform .1s",position:"relative"}}
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

function Pill({label,color}) {
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,background:color+"22",color,
    borderRadius:20,padding:"2px 8px",fontWeight:600}}>
    <span style={{width:5,height:5,borderRadius:"50%",background:color,display:"inline-block"}}/>
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
  const [txAcctFilter,setTxAcctFilter]=useState(null);
  const [selAcct,setSelAcct]=useState(null);
  const [acctTxs,setAcctTxs]=useState(null);
  const [acctHasMore,setAcctHasMore]=useState(false);
  const [acctLoading,setAcctLoading]=useState(false);
  const [customColors,setCustomColors]=useState({});
  const [customNames,setCustomNames]=useState({});
  const [customCats,setCustomCats]=useState([]);
  const [ready,setReady]=useState(false);
  const [addingCat,setAddingCat]=useState(false);
  const [newName,setNewName]=useState("");
  const [newColor,setNewColor]=useState("#7F77DD");
  const didInitialSync=useRef(false);

  useEffect(()=>{
    async function load(){
      try {
        const [c,n,cc]=await Promise.all([
          getSetting("dash:colors").catch(()=>null),
          getSetting("dash:names").catch(()=>null),
          getSetting("dash:cats").catch(()=>null),
        ]);
        if(c)setCustomColors(JSON.parse(c));
        if(n)setCustomNames(JSON.parse(n));
        if(cc)setCustomCats(JSON.parse(cc));
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

  const isCurrent = year===now.getFullYear()&&month===now.getMonth()+1;
  const canNext = !(year===now.getFullYear()&&month>=now.getMonth()+1);

  function prevMonth(){if(month===1){setYear(y=>y-1);setMonth(12);}else setMonth(m=>m-1);}
  function nextMonth(){if(!canNext)return;if(month===12){setYear(y=>y+1);setMonth(1);}else setMonth(m=>m+1);}

  const reloadData=useCallback(async(y,m)=>{
    setError(null);
    const cur=y===now.getFullYear()&&m===now.getMonth()+1;
    try{
      const[ov,sp,tx,cf,ac]=await Promise.all([
        cur?getOverview():Promise.resolve(null),
        getSpending({year:y,month:m}),
        getTransactions({year:y,month:m}),
        getCashFlow({num_periods:6}),
        getAccounts(),
      ]);
      setOverview(ov);setSpending(sp);setTransactions(tx);setCashFlow(cf);
      setAccounts(ac.accounts||[]);
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
  const cfPs=cashFlow?.periods||[];
  const maxCat=cats[0]?.amount||1;
  const maxSpend=Math.max(...cfPs.map(p=>p.spending?.amount||0),1);
  const totalSpent=cats.reduce((s,c)=>s+c.amount,0);
  const balance=overview?.accounts?.[0]?.balance?.current||0;
  const lastSpent=overview?.last_month?.spending?.amount;
  const delta=lastSpent!=null?totalSpent-lastSpent:null;
  const donutData=cats.slice(0,7).map(c=>({label:getName(c.label),value:c.amount,color:getColor(c.label)}));

  return (
    <div style={{fontFamily:"'DM Sans','Helvetica Neue',sans-serif",background:"var(--bg,#F7F6F2)",minHeight:"100vh",
      color:"var(--text,#1a1a18)","--bg":"#F7F6F2","--card":"#FFFFFF","--text":"#1a1a18","--muted":"#888780","--border":"#E4E2DC"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(prefers-color-scheme:dark){:root{--bg:#18181A!important;--card:#222224!important;--text:#F0EFEB!important;--muted:#6e6e6a!important;--border:#2E2E30!important;}}
        *{box-sizing:border-box;margin:0;padding:0;}
        .card{background:var(--card);border-radius:14px;border:1px solid var(--border);padding:18px 20px;animation:fadeIn .25s ease both;}
        .tab{background:none;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;color:var(--muted);padding:6px 10px;border-radius:20px;transition:all .15s;flex:1;}
        .tab.active{background:var(--card);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.08);}
        .tab:hover:not(.active){color:var(--text);}
        .ibtn{background:none;border:1px solid var(--border);border-radius:8px;padding:5px 12px;font-family:inherit;font-size:12px;font-weight:500;color:var(--muted);cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:all .15s;}
        .ibtn:hover{color:var(--text);border-color:var(--text);}
        .ibtn:disabled{opacity:.35;cursor:default;}
        .nbtn{background:var(--card);border:1px solid var(--border);border-radius:8px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;transition:all .15s;line-height:1;}
        .nbtn:hover:not(:disabled){border-color:var(--text);}
        .nbtn:disabled{opacity:.3;cursor:default;}
        .tx{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);}
        .tx:last-child{border-bottom:none;}
        .overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:100;}
        .modal{background:var(--card);border-radius:16px;padding:24px;width:320px;border:1px solid var(--border);}
        .bar-bg{flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden;}
        .bar-fill{height:100%;border-radius:3px;transition:width .5s ease;}
      `}</style>

      <div style={{maxWidth:720,margin:"0 auto",padding:"24px 16px"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
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
          <button className="ibtn" onClick={()=>fetchData(year,month,{sync:true})} disabled={loading}>
            <span style={{display:"inline-block",animation:loading?"spin 1s linear infinite":"none"}}>↻</span>
            {lastUpd?lastUpd.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"Refresh"}
          </button>
        </div>

        {error&&<div style={{background:"#FCEBEB",border:"1px solid #F09595",borderRadius:10,padding:"12px 16px",fontSize:13,color:"#A32D2D",marginBottom:14}}>{error}</div>}

        {/* Summary */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {[
            {label:"Total spent",val:loading?null:fmt(totalSpent),sub:isCurrent&&lastSpent!=null?`vs ${fmt(lastSpent)} last month`:monthLabel(year,month)},
            {label:"Card balance",val:loading?null:fmtX(balance),sub:overview?.accounts?.[0]?.name||"Linked account"},
            {label:"vs last month",val:loading||delta==null?null:`${delta>=0?"+":""}${fmt(delta)}`,sub:delta==null?"—":delta>=0?"↑ more spending":"↓ less spending",clr:delta==null?"var(--muted)":delta>=0?"#D85A30":"#1D9E75"},
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
          {["overview","categories","transactions","accounts","trends"].map(t=>(
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
                        <div style={{width:8,height:8,borderRadius:"50%",background:getColor(c.label),flexShrink:0}}/>
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
                  <div key={i} className="tx">
                    <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2,display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span>{getName(t.category)} · {t.transaction_date}</span>
                        {a&&<Pill label={acctLabel(a)} color={acctColor(a)}/>}
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
            {loading?[1,2,3,4,5].map(i=><div key={i} style={{marginBottom:14}}><Sk h={14}/></div>):
              cats.map((c,i)=>(
                <div key={i} style={{marginBottom:14,animationDelay:i*.03+"s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
                      <Swatch color={getColor(c.label)} onChange={hex=>saveColors({...customColors,[c.label]:hex})}/>
                      <EditName name={getName(c.label)} onSave={v=>saveNames({...customNames,[c.label]:v})}/>
                      <span style={{fontSize:11,color:"var(--muted)",flexShrink:0,marginLeft:4}}>{c.transaction_count} txn{c.transaction_count!==1?"s":""}</span>
                    </div>
                    <span style={{fontSize:13,fontFamily:"'DM Mono',monospace",marginLeft:12,flexShrink:0}}>{fmt(c.amount)}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div className="bar-bg"><div className="bar-fill" style={{width:((c.amount/maxCat)*100)+"%",background:getColor(c.label)}}/></div>
                    <span style={{fontSize:11,color:"var(--muted)",width:30,textAlign:"right",flexShrink:0}}>{c.percent_of_total?.toFixed(0)}%</span>
                  </div>
                </div>
              ))}

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
              Click a color swatch to change it · Double-click a name to rename it
            </div>
          </div>
        )}

        {/* TRANSACTIONS */}
        {tab==="transactions"&&(
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em"}}>{monthLabel(year,month)}</div>
              <span style={{fontSize:12,color:"var(--muted)"}}>{shownTxs.length} transaction{shownTxs.length!==1?"s":""}</span>
            </div>
            {accounts.length>1&&(
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                {[{id:null,label:"All accounts",color:"var(--muted)"},...accounts.map(a=>({id:a.id,label:acctLabel(a),color:acctColor(a)}))].map(c=>{
                  const active=txAcctFilter===c.id;
                  return (
                    <button key={c.id||"all"} onClick={()=>setTxAcctFilter(c.id)}
                      style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,
                        background:active?c.color+"22":"var(--bg)",color:active?c.color:"var(--muted)",
                        border:`1px solid ${active?c.color:"var(--border)"}`,borderRadius:20,padding:"4px 10px",
                        cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>
                      {c.id&&<span style={{width:6,height:6,borderRadius:"50%",background:c.color,display:"inline-block"}}/>}
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
            {loading?[1,2,3,4,5].map(i=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"center",marginBottom:12}}>
                <Sk w={34} h={34} r={10}/><div style={{flex:1}}><Sk w="65%" h={13}/></div><Sk w={55} h={13}/>
              </div>
            )):shownTxs.length===0?(
              <div style={{textAlign:"center",padding:"30px 0",color:"var(--muted)",fontSize:14}}>
                {txAcctFilter?"No transactions for this account this month.":"No transactions for this period."}
              </div>
            ):shownTxs.map((t,i)=>{
              const a=acctById(t.account_id);
              return (
              <div key={i} className="tx" style={{animationDelay:i*.015+"s"}}>
                <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:3,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span>{t.transaction_date}</span>
                    <span>·</span>
                    <Pill label={getName(t.category)} color={getColor(t.category)}/>
                    {a&&<Pill label={acctLabel(a)} color={acctColor(a)}/>}
                  </div>
                </div>
                <div style={{fontSize:13,fontFamily:"'DM Mono',monospace",fontWeight:500,flexShrink:0}}>{fmtX(t.amount)}</div>
              </div>
              );
            })}
          </div>
        )}

        {/* ACCOUNTS */}
        {tab==="accounts"&&!selAcct&&(
          <div className="card">
            <div style={{fontSize:11,fontWeight:500,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Accounts</div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>
              Give each account a nickname and color — they tag every transaction across the app.
            </div>
            {loading&&accounts.length===0?[1,2,3].map(i=><div key={i} style={{marginBottom:12}}><Sk h={40}/></div>):
              accounts.map((a,i)=>(
                <div key={a.id} className="tx" style={{cursor:"pointer",animationDelay:i*.03+"s"}}
                  onClick={()=>setSelAcct(a)}>
                  <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <Swatch color={acctColor(a)} onChange={hex=>saveAccount(a.id,{color:hex})}/>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:6}}>
                      <EditName name={acctLabel(a)} onSave={v=>saveAccount(a.id,{nickname:v})}/>
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
                  <span style={{width:10,height:10,borderRadius:3,background:acctColor(selAcct),flexShrink:0}}/>
                  <span style={{fontSize:15,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{acctLabel(selAcct)}</span>
                </div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                  {[acctInst(selAcct),`${selAcct.name}${selAcct.mask?` ··${selAcct.mask}`:""}`,selAcct.subtype||selAcct.type].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div style={{fontSize:15,fontFamily:"'DM Mono',monospace",fontWeight:600,flexShrink:0}}>{fmtX(selAcct.current_balance??0)}</div>
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
                  <div key={t.plaid_tx_id||i} className="tx" style={{animationDelay:Math.min(i,20)*.015+"s"}}>
                    <div style={{width:34,height:34,borderRadius:10,background:"var(--bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{TX_ICONS[t.category]||"🛍"}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.merchant_name||t.description}</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:3,display:"flex",alignItems:"center",gap:6}}>
                        <span>{t.transaction_date}</span>
                        <span>·</span>
                        <Pill label={getName(t.category)} color={getColor(t.category)}/>
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
            <div style={{borderTop:"1px solid var(--border)",margin:"16px 0 12px"}}/>
            <button onClick={handleUnlink} disabled={unlinking}
              style={{width:"100%",padding:"9px 0",borderRadius:8,border:"1px solid #F09595",background:"none",
                color:"#A32D2D",fontFamily:"inherit",fontSize:12,fontWeight:500,cursor:unlinking?"default":"pointer",opacity:unlinking?.6:1}}>
              {unlinking?"Unlinking…":`Unlink ${acctInst(selAcct)||"this bank"}…`}
            </button>
            <div style={{marginTop:8,fontSize:10,color:"var(--muted)",textAlign:"center"}}>
              Removes this bank connection, all its accounts, and their transactions.
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
                      const h=Math.max((p.spending.amount/maxSpend)*100,3);
                      const pStart=new Date(p.start);
                      const isSel=pStart.getFullYear()===year&&pStart.getMonth()+1===month;
                      return (
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                          <span style={{fontSize:9,fontFamily:"'DM Mono',monospace",color:"var(--muted)",whiteSpace:"nowrap"}}>{fmt(p.spending.amount)}</span>
                          <div onClick={()=>{setYear(pStart.getFullYear());setMonth(pStart.getMonth()+1);setTab("overview");}}
                            title={`View ${p.label}`}
                            style={{width:"100%",height:h+"%",minHeight:4,background:isSel?"#7F77DD":"var(--border)",
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
                    {[{label:"Spend",w:sw,color:"#D85A30",val:p.spending.amount},{label:"Income",w:iw,color:"#1D9E75",val:p.income.amount}].map(row=>(
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
          </div>
        )}

        <div style={{textAlign:"center",marginTop:18,fontSize:11,color:"var(--muted)"}}>my-money</div>
      </div>

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
                style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",background:"#7F77DD",color:"#fff",fontFamily:"inherit",fontSize:14,fontWeight:500,cursor:newName.trim()?"pointer":"default",opacity:newName.trim()?1:.5}}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
