import { useEffect, useMemo, useRef, useState, type PointerEvent, type TouchEvent } from "react";
import { ArrowRightIcon, ChevronLeftIcon, GearIcon, HamburgerMenuIcon, PlusIcon } from "@radix-ui/react-icons";
import { MobileScroll } from "./mobile";
import "./prototype.css";

type Entry = { id: string; at: string; ml: number };
type Theme = "auto" | "light" | "dark";
type Prefs = { ml: number; birthDate?: string; interval: number; advance: number; sleep: number; theme: Theme; keepAwake: boolean };
type Draft = { id?: string; day: string; hour: number; minute: number; ml: number };
const defaults: Prefs = { ml: 120, birthDate: "", interval: 180, advance: 30, sleep: 60, theme: "dark", keepAwake: false };
const demo = new URLSearchParams(location.search).get("demo") === "1";
const getSaved = <T,>(key: string, fallback: T): T => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
const hhmm = (date: Date) => `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
const spanText = (mins: number) => { const n = Math.max(0, Math.floor(mins)); return n >= 60 ? `${Math.floor(n/60)}小时${n%60}分` : `${n}分钟`; };
const seed = (): Entry[] => demo ? [{ id:"sample", at:new Date(Date.now()-155*60_000).toISOString(), ml:120 }] : getSaved<Entry[]>("feedie.entries", []);
const MIN_FEED_ML = 10;
const FEED_ML_STEP = 10;
const isDateKey = (value: string | undefined): value is string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};
const completedMonths = (birthDate: string, now: Date) => {
  const [year, month, day] = birthDate.split("-").map(Number);
  let months = (now.getFullYear() - year) * 12 + now.getMonth() + 1 - month;
  const anniversaryDay = Math.min(day, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  if (now.getDate() < anniversaryDay) months -= 1;
  return Math.max(0, months);
};
const monthReferenceMax = (months: number) => months < 1 ? 80 : months === 1 ? 90 : months <= 3 ? 120 : months <= 5 ? 150 : 200;
const feedSliderMax = (birthDate: string | undefined, now: Date) => {
  if (!isDateKey(birthDate) || birthDate > dayKey(now)) return 400;
  const max = monthReferenceMax(completedMonths(birthDate, now)) * 1.4;
  return Math.ceil(max / FEED_ML_STEP) * FEED_ML_STEP;
};
const clampFeedMl = (value: number, max: number) => Math.min(max, Math.max(MIN_FEED_ML, MIN_FEED_ML + Math.round((value - MIN_FEED_ML) / FEED_ML_STEP) * FEED_ML_STEP));
const feedMlFromPercent = (percent: number, max: number) => {
  const steps = Math.floor((max - MIN_FEED_ML) / FEED_ML_STEP);
  return MIN_FEED_ML + Math.round(Math.min(1, Math.max(0, percent)) * steps) * FEED_ML_STEP;
};

function Stepper({ value, change, label, step=10, min=0, max=400, unit="mL" }: { value:number; change:(v:number)=>void; label:string; step?:number; min?:number; max?:number; unit?:string }) {
  return <div className="f-stepper" aria-label={label}><button type="button" aria-label={`${label}减少`} disabled={value<=min} onClick={()=>change(Math.max(min,value-step))}>−</button><strong>{value}<small>{unit}</small></strong><button type="button" aria-label={`${label}增加`} disabled={value>=max} onClick={()=>change(Math.min(max,value+step))}>＋</button></div>;
}

function AmountSlider({ value, max, change, complete }: { value:number; max:number; change:(value:number)=>void; complete:()=>void }) {
  const percentage = max === MIN_FEED_ML ? 0 : ((value - MIN_FEED_ML) / (max - MIN_FEED_ML)) * 100;
  const steps = Math.max(1, (max - MIN_FEED_ML) / FEED_ML_STEP);
  return <div className="amount-control">
    <div className="amount-readout"><div className="amount-value"><span className="caption">本次喂养量</span><strong>{value}<small>mL</small></strong></div><SlideRecord complete={complete}/></div>
    <div className="amount-range" data-scroll-drag="ignore" style={{"--amount-step-width":`${100/steps}%`} as React.CSSProperties}>
      <span className="amount-track" aria-hidden="true"><span className="amount-fill" style={{width:`${percentage}%`}}/></span><span className="amount-ticks" aria-hidden="true"/>
      <input type="range" min={MIN_FEED_ML} max={max} step={FEED_ML_STEP} value={value} aria-label="本次喂养奶量" aria-valuetext={`${value} 毫升`} onChange={event=>{
        const raw = Number(event.currentTarget.value);
        const percent = max === MIN_FEED_ML ? 0 : (raw - MIN_FEED_ML) / (max - MIN_FEED_ML);
        change(feedMlFromPercent(percent, max));
      }}/>
    </div>
    <div className="amount-scale" aria-hidden="true"><span>{MIN_FEED_ML} mL</span><span>{max} mL</span></div>
    <small className="amount-guidance">月龄参考上限 {max} mL · 每次喂量可有差异</small>
  </div>;
}

function SlideRecord({ complete }: { complete:()=>void }) {
  const track = useRef<HTMLDivElement>(null);
  const progressValue = useRef(0);
  const active = useRef(false);
  const [progress,setProgress] = useState(0);
  const move = (clientX:number) => { const box=track.current?.getBoundingClientRect(); if(!box)return; const next=Math.min(1,Math.max(0,(clientX-box.left-32)/(box.width-64))); progressValue.current=next; setProgress(next); };
  const finish = () => { if(!active.current)return; active.current=false; if(progressValue.current>.82)complete(); progressValue.current=0; setProgress(0); };
  useEffect(()=>{
    const onMove=(event:globalThis.PointerEvent)=>{if(active.current)move(event.clientX);};
    const onUp=()=>{if(active.current)finish();};
    window.addEventListener("pointermove",onMove);
    window.addEventListener("pointerup",onUp);
    window.addEventListener("pointercancel",onUp);
    return()=>{window.removeEventListener("pointermove",onMove);window.removeEventListener("pointerup",onUp);window.removeEventListener("pointercancel",onUp);};
  });
  const start = (e:PointerEvent<HTMLButtonElement>) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); active.current=true; progressValue.current=0; setProgress(0); };
  return <div ref={track} className="f-slide" style={{"--p":progress} as React.CSSProperties} data-scroll-drag="ignore" data-testid="record-slider"><button type="button" className="f-slide-thumb" aria-label="向右滑动完成本次喂养，按回车也可记录" onPointerDown={start} onPointerMove={e=>active.current&&move(e.clientX)} onPointerUp={finish} onPointerCancel={finish} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();complete();}}}><ArrowRightIcon /></button><span>滑动完成本次喂养</span><b aria-hidden="true">›››</b></div>;
}

export function FeedieApp() {
  const [prefs,setPrefs]=useState<Prefs>(()=>demo?{...defaults,theme:"dark"}:{...defaults,...getSaved("feedie.prefs",{})});
  const [entries,setEntries]=useState<Entry[]>(seed);
  const [now,setNow]=useState(()=>new Date());
  const [page,setPage]=useState<"home"|"history"|"settings">("home");
  const [ml,setMl]=useState(prefs.ml);
  const [sleeping,setSleeping]=useState(false);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [undo,setUndo]=useState<Entry|null>(null);
  const [toast,setToast]=useState("");
  const idleRef=useRef<number|null>(null);
  const undoRef=useRef<number|null>(null);
  const wakeRef=useRef<{release:()=>Promise<void>}|null>(null);
  const swipeRef=useRef<{x:number;y:number}|null>(null);
  useEffect(()=>{const id=window.setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(id);},[]);
  useEffect(()=>{if(!demo)localStorage.setItem("feedie.entries",JSON.stringify(entries));},[entries]);
  useEffect(()=>{if(!demo)localStorage.setItem("feedie.prefs",JSON.stringify(prefs));},[prefs]);
  useEffect(()=>{setMl(prefs.ml);},[prefs.ml]);
  useEffect(()=>{const reset=()=>{if(sleeping)return;if(idleRef.current)clearTimeout(idleRef.current);if(prefs.sleep&&page==="home"&&!draft)idleRef.current=window.setTimeout(()=>setSleeping(true),prefs.sleep*1000);};reset();window.addEventListener("pointerdown",reset);window.addEventListener("keydown",reset);return()=>{window.removeEventListener("pointerdown",reset);window.removeEventListener("keydown",reset);if(idleRef.current)clearTimeout(idleRef.current);};},[prefs.sleep,page,draft,sleeping]);
  useEffect(()=>{
    let cancelled=false;
    const sync=async()=>{
      if(!prefs.keepAwake||document.visibilityState!=="visible"){
        await wakeRef.current?.release();wakeRef.current=null;return;
      }
      if(!("wakeLock" in navigator)){setToast("当前浏览器不支持保持常亮");return;}
      try{const lock=await navigator.wakeLock.request("screen");if(cancelled)await lock.release();else wakeRef.current=lock;}
      catch{setToast("当前设备无法保持常亮");}
    };
    void sync();document.addEventListener("visibilitychange",sync);
    return()=>{cancelled=true;document.removeEventListener("visibilitychange",sync);void wakeRef.current?.release();wakeRef.current=null;};
  },[prefs.keepAwake]);
  const sorted=useMemo(()=>[...entries].sort((a,b)=>+new Date(b.at)-+new Date(a.at)),[entries]);
  const dailyTotals=useMemo(()=>{
    const totals=new Map<string,number>();
    for(const entry of entries){const key=dayKey(new Date(entry.at));totals.set(key,(totals.get(key)??0)+(Number.isFinite(entry.ml)?entry.ml:0));}
    return totals;
  },[entries]);
  const todayKey=dayKey(now);
  const todayTotal=dailyTotals.get(todayKey)??0;
  const sliderMax=feedSliderMax(prefs.birthDate,now);
  const currentFeedMl=clampFeedMl(ml,sliderMax);
  const latest=sorted[0], last=latest?new Date(latest.at):null;
  const elapsed=last?Math.max(0,Math.floor((+now-+last)/60000)):0;
  const due=last?new Date(+last+prefs.interval*60000):null;
  const remaining=due?Math.ceil((+due-+now)/60000):null;
  const ratio=Math.min(1,elapsed/prefs.interval);
  const dark=prefs.theme==="dark"||(prefs.theme==="auto"&&(now.getHours()<7||now.getHours()>=19));
  const dueCopy=remaining===null?"完成第一笔记录，开始计时":remaining<=0?`已到提醒时间 · ${spanText(-remaining)}`:`还有 ${remaining} 分钟`;
  const changePref=<K extends keyof Prefs>(key:K,value:Prefs[K])=>setPrefs(p=>({...p,[key]:value}));
  const saveNow=()=>{const item={id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,at:now.toISOString(),ml:currentFeedMl};setEntries(e=>[item,...e]);setUndo(item);setToast("已记录本次喂养");setMl(clampFeedMl(prefs.ml,sliderMax));if(undoRef.current)clearTimeout(undoRef.current);undoRef.current=window.setTimeout(()=>{setUndo(null);setToast("");},6000);};
  const revert=()=>{if(undo)setEntries(e=>e.filter(x=>x.id!==undo.id));setUndo(null);setToast("已撤销记录");window.setTimeout(()=>setToast(""),2200);};
  const openDraft=(entry?:Entry)=>{const date=entry?new Date(entry.at):now;setDraft({id:entry?.id,day:dayKey(date),hour:date.getHours(),minute:date.getMinutes(),ml:entry?.ml??prefs.ml});setConfirmDelete(false);};
  const saveDraft=()=>{if(!draft)return;const at=new Date(`${draft.day}T${String(draft.hour).padStart(2,"0")}:${String(draft.minute).padStart(2,"0")}:00`);if(Number.isNaN(+at)||+at>+now+60000){setToast("时间不能晚于现在");return;}const item={id:draft.id??`${Date.now()}-manual`,at:at.toISOString(),ml:draft.ml};setEntries(e=>draft.id?e.map(x=>x.id===draft.id?item:x):[...e,item]);setDraft(null);setToast("记录已保存");window.setTimeout(()=>setToast(""),2200);};
  const deleteDraft=()=>{if(!draft?.id)return;setEntries(e=>e.filter(x=>x.id!==draft.id));setDraft(null);setConfirmDelete(false);setToast("记录已删除");window.setTimeout(()=>setToast(""),2200);};
  const exportEntries=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,entries:sorted,prefs},null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download=`feedie-${dayKey(new Date())}.json`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const onTouchStart=(e:TouchEvent<HTMLDivElement>)=>{const t=e.touches[0];if(t)swipeRef.current={x:t.clientX,y:t.clientY};};
  const onTouchEnd=(e:TouchEvent<HTMLDivElement>)=>{const start=swipeRef.current,t=e.changedTouches[0];swipeRef.current=null;if(!start||!t||sleeping||draft)return;const dx=t.clientX-start.x,dy=t.clientY-start.y;if(Math.abs(dx)<64||Math.abs(dx)<Math.abs(dy)*1.3)return;if(page==="home"&&start.x<32&&dx>0)setPage("history");if(page==="history"&&dx<0)setPage("home");};
  const dateOptions=Array.from({length:14},(_,i)=>{const date=new Date(now);date.setDate(date.getDate()-i);return dayKey(date);});
  const changeBirthDate=(value:string)=>{
    if(value&&(!isDateKey(value)||value>todayKey)){setToast("出生日期不能晚于今天");window.setTimeout(()=>setToast(""),2200);return;}
    changePref("birthDate",value);
    const nextMax=feedSliderMax(value,now);
    setMl(current=>clampFeedMl(current,nextMax));
  };
  if(draft&&!dateOptions.includes(draft.day))dateOptions.push(draft.day);
  return <div className={`feedie ${dark?"dark":"light"}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} data-testid="feedie-app">
    {page==="home"&&<main className="home" aria-label="喂养状态"><button type="button" className="edge-history" onClick={()=>setPage("history")} aria-label="查看喂养记录"><HamburgerMenuIcon /><span>记录</span></button><section className="home-left"><header className="home-header"><div className="brand">Quiet Gauge<small>记住每一次温柔的守护</small></div><div className="today"><span>{dayKey(now)} · {["星期日","星期一","星期二","星期三","星期四","星期五","星期六"][now.getDay()]}</span><strong>今日 {todayTotal} mL</strong></div></header><div className="clock"><time dateTime={now.toISOString()}>{hhmm(now)}</time></div><div className="last-landscape"><span>上次喂养</span><strong>{last?`${hhmm(last)} · ${latest.ml} mL`:"尚无记录"}</strong></div></section><section className="home-right"><div className="interval"><span className="caption">已间隔</span><strong className="elapsed">{last?spanText(elapsed):"尚未开始"}</strong><span className={`due ${remaining!==null&&remaining<=prefs.advance?"alert":""}`} aria-live="polite">{dueCopy}</span><div className="timeline-labels"><span>上次喂养<strong>{last?hhmm(last):"—"}</strong></span><span>下次喂养<strong>{due?hhmm(due):"—"}</strong></span></div><div className="progress" role="progressbar" aria-label="喂养提醒进度" aria-valuenow={Math.round(ratio*100)} aria-valuemin={0} aria-valuemax={100}><span style={{width:`${ratio*100}%`}}/><i style={{left:`${ratio*100}%`}}/></div><div className="scale"><span>0</span><span>{spanText(prefs.interval)}</span></div><div className="last-portrait"><span>上次喂养</span><strong>{last?`${hhmm(last)} · ${latest.ml} mL`:"尚无记录"}</strong></div></div><div className="entry"><div className="entry-amount"><AmountSlider value={currentFeedMl} max={sliderMax} change={setMl} complete={saveNow}/></div></div></section></main>}
    {page==="history"&&<main className="inner history" aria-label="喂养记录"><header className="inner-header"><button type="button" aria-label="返回主页" onClick={()=>setPage("home")}><ChevronLeftIcon/></button><h1>喂养记录</h1><button type="button" aria-label="打开设置" onClick={()=>setPage("settings")}><GearIcon/></button></header><div className="history-body"><div className="history-top"><strong>{sorted.length}</strong><span>条记录</span><button type="button" onClick={()=>openDraft()}><PlusIcon/> 补录</button></div>{sorted.length?<div className="record-list">{sorted.map((item,index)=>{const date=new Date(item.at),key=dayKey(date),prev=sorted[index-1];return <div key={item.id}>{(!prev||dayKey(new Date(prev.at))!==key)&&<h2><span>{key}</span><strong>合计 {dailyTotals.get(key)??0} mL</strong></h2>}<button type="button" className="record-row" onClick={()=>openDraft(item)}><time>{hhmm(date)}</time><span>{item.ml} mL</span><b>›</b></button></div>;})}</div>:<div className="empty"><strong>还没有喂养记录</strong><span>可在主屏滑动记录，或点「补录」。</span></div>}</div></main>}
    {page==="settings"&&<main className="inner settings" aria-label="设置"><header className="inner-header"><button type="button" aria-label="返回记录" onClick={()=>setPage("history")}><ChevronLeftIcon/></button><h1>设置</h1><span/></header><div className="settings-body"><section><h2>喂养</h2><label className="setting-row"><div><strong>宝宝出生日期</strong><small>用于计算主屏月龄参考上限</small></div><input className="date-setting" type="date" aria-label="宝宝出生日期" max={todayKey} value={isDateKey(prefs.birthDate)&&prefs.birthDate<=todayKey?prefs.birthDate:""} onChange={event=>changeBirthDate(event.currentTarget.value)}/></label><div className="setting-row"><div><strong>默认奶量</strong><small>记录前可临时调整</small></div><Stepper value={prefs.ml} change={v=>changePref("ml",v)} min={10} label="默认奶量"/></div><div className="setting-row"><div><strong>提醒间隔</strong><small>从上次喂养时间开始</small></div><Stepper value={prefs.interval} change={v=>changePref("interval",v)} min={30} max={360} step={15} unit="分" label="提醒间隔"/></div><div className="setting-row"><div><strong>提前提示</strong></div><select aria-label="提前提示" value={prefs.advance} onChange={e=>changePref("advance",Number(e.target.value))}><option value={0}>不提前</option><option value={10}>10 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option></select></div></section><section><h2>显示</h2><div className="theme-setting"><strong>主题模式</strong><small>自动按本地时间 07:00–19:00 切换</small><div className="segmented" role="group" aria-label="主题模式">{(["auto","light","dark"] as const).map(value=><button key={value} type="button" aria-pressed={prefs.theme===value} onClick={()=>changePref("theme",value)}>{value==="auto"?"自动":value==="light"?"亮色":"暗色"}</button>)}</div></div><div className="setting-row"><div><strong>睡眠模式</strong><small>无操作后仅显示时间</small></div><select aria-label="屏幕超时" value={prefs.sleep} onChange={e=>changePref("sleep",Number(e.target.value))}><option value={0}>关闭</option><option value={30}>30 秒</option><option value={60}>1 分钟</option><option value={120}>2 分钟</option><option value={300}>5 分钟</option></select></div><div className="setting-row"><div><strong>保持屏幕常亮</strong><small>页面打开时尝试阻止系统锁屏</small></div><button type="button" className="switch" role="switch" aria-checked={prefs.keepAwake} onClick={()=>changePref("keepAwake",!prefs.keepAwake)}><span/></button></div></section><section><h2>数据</h2><button className="export" type="button" onClick={exportEntries}>导出记录 JSON <span>›</span></button><p>记录保存在当前浏览器。更换设备前请先导出备份。</p></section></div></main>}
    {sleeping&&page==="home"&&<button type="button" className="sleep" aria-label="轻触唤醒主屏" onClick={()=>setSleeping(false)}><time>{hhmm(now)}</time><div><span>距上次喂养</span><strong>{last?spanText(elapsed):"尚无记录"}</strong></div><small>轻触唤醒</small></button>}
    {draft&&<div className="overlay" onClick={()=>setDraft(null)}><section className="editor" role="dialog" aria-modal="true" aria-label={draft.id?"修改喂养记录":"补录喂养"} onClick={e=>e.stopPropagation()}><header><h2>{draft.id?"修改记录":"补录喂养"}</h2><button type="button" aria-label="关闭" onClick={()=>setDraft(null)}>×</button></header><label className="edit-row">日期<select aria-label="日期" value={draft.day} onChange={e=>setDraft({...draft,day:e.target.value})}>{dateOptions.map(d=><option key={d} value={d}>{d}</option>)}</select></label><div className="edit-row">时间<div className="time-select"><select aria-label="小时" value={draft.hour} onChange={e=>setDraft({...draft,hour:Number(e.target.value)})}>{Array.from({length:24},(_,n)=><option key={n} value={n}>{String(n).padStart(2,"0")}</option>)}</select>:<select aria-label="分钟" value={draft.minute} onChange={e=>setDraft({...draft,minute:Number(e.target.value)})}>{Array.from({length:60},(_,n)=><option key={n} value={n}>{String(n).padStart(2,"0")}</option>)}</select></div></div><div className="edit-row">喂养奶量<Stepper value={draft.ml} change={v=>setDraft({...draft,ml:v})} label="记录奶量"/></div><button className="save" type="button" onClick={saveDraft}>保存记录</button>{draft.id&&<button className="delete" type="button" onClick={()=>setConfirmDelete(true)}>删除这条记录</button>}</section></div>}
    {confirmDelete&&<div className="confirm-overlay"><section role="alertdialog" aria-modal="true" aria-label="确认删除记录"><h2>删除这条记录？</h2><p>提醒时间会按剩余的最新记录重新计算。</p><div><button type="button" onClick={()=>setConfirmDelete(false)}>取消</button><button type="button" onClick={deleteDraft}>删除</button></div></section></div>}
    {toast&&<div className="toast" role="status">{toast}{undo&&<button type="button" onClick={revert}>撤销</button>}</div>}
  </div>;
}

export default function Prototype(){return <MobileScroll className="feedie-scroll"><FeedieApp/></MobileScroll>;}

