"use strict";
const $=id=>document.getElementById(id);
let currentKind="followup", preset="3", view="active", canCreate=false, defaultReminderTime="08:15";
let allTasks=[], listRequest=0, manuallyToggledCreate=false, selectedExistingTask=null;
// Nie dopuszczaj do wielokrotnego otwarcia wiadomości przy szybkich kliknięciach.
let openingOriginal = false;
const params = new URLSearchParams(location.search);
const sourceId = /^\d+$/.test(params.get("messageId") || "") ? Number(params.get("messageId")) : null;
const multipleSelected = params.get("multiple") === "1";
const createOnly = params.get("onlyCreate") === "1";
if (createOnly) {
 document.body.classList.add("createOnly");
 document.querySelector(".brand small").textContent="New follow-up for selected message";
}
// Wszystkie wiadomości obsługiwane przez dodatek znajdują się w Lokalnych folderach.
function folderDisplay(raw){
 const cleaned=String(raw||"").split("/").map(v=>v.trim()).filter(Boolean).join(" / ");
 if(!cleaned)return "Local Folders (unknown folder)";
 return /^(?:Lokalne foldery|Local Folders)(?:\s*\/|$)/i.test(cleaned)
   ? cleaned.replace(/^Lokalne foldery(?=\s*\/|$)/i,"Local Folders") : "Local Folders / "+cleaned;
}
function status(msg,bad=false){$("status").textContent=msg;$("status").classList.toggle("error",bad);}
function localDate(date){const d=new Date(date);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function setPreset(p){preset=p;document.querySelectorAll(".presets button").forEach(b=>b.classList.toggle("chosen",b.dataset.days===p));if(p!=="custom"){let d=new Date();d.setDate(d.getDate()+Number(p));$("day").value=localDate(d);$("hour").value=defaultReminderTime;}}
function due(){const raw=$("day").value+"T"+$("hour").value+":00";const d=new Date(raw);if(!Number.isFinite(d.getTime())||d<=new Date())throw new Error("Due date must be in the future.");return d.toISOString();}
function fillDueFromTask(task){
 const existing=new Date(task.due);
 if(!Number.isFinite(existing.getTime()))return;
 setPreset("custom");
 $("day").value=localDate(existing);
 $("hour").value=String(existing.getHours()).padStart(2,"0")+":"+String(existing.getMinutes()).padStart(2,"0");
 $("move").checked=!!task.moveAtDue;
}
function formatDueDate(d){return new Date(d).toLocaleString("en-GB",{dateStyle:"medium",timeStyle:"short"});}
async function send(type,payload={}){return messenger.runtime.sendMessage({type,...payload});}
function addText(parent,tag,cls,text){const el=document.createElement(tag);el.className=cls;el.textContent=text;parent.appendChild(el);return el;}
function stamp(t){const date=new Date(t.due), now=Date.now();return {txt:date.toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}), overdue:new Date(t.due).getTime()<now && t.status==="waiting"};}
async function goToOriginal(t){
 if(openingOriginal)return;
 openingOriginal=true;
 try{
  status("Locating the original message and opening its folder…");
  await send("open",{id:t.id}); // background: znajdź po Message-ID, również po przeniesieniu
  window.close(); // zamknij wyłącznie panel dodatku, nie Thunderbird
 }catch(e){
  openingOriginal=false;
  status("Could not open original: "+String(e),true);
 }
}
function taskNode(t){
 const outer=document.createElement("div");outer.className="task status-"+t.status;
 // Wyroznij sprawy wymagajace uwagi: przypomniane, przeterminowane
 // i odpowiedziane, ktore uzytkownik moze zamknac. DONE to historia.
 const dueTime=Date.parse(t.due);
 const isOverdue=Number.isFinite(dueTime) && dueTime<=Date.now();
 const needsAttention=t.status==="answered" || t.status==="reminded" ||
   (["waiting","processing","error"].includes(t.status) && isOverdue);
 if(needsAttention){
   outer.classList.add("needs-attention");
   outer.dataset.attention=t.status==="answered" ? "ready" : "overdue";
 }
 outer.tabIndex=0;
 outer.title="Double-click to open the original message in its current folder.";
 outer.setAttribute("aria-label",t.subject+". Double-click or Enter to open the original.");
 outer.addEventListener("dblclick",event=>{
   if(event.target.closest("button, input, select, textarea, a, .diagnostic"))return;
   void goToOriginal(t);
 });
 outer.addEventListener("keydown",event=>{
   if(event.target!==outer || event.key!=="Enter")return;
   event.preventDefault();void goToOriginal(t);
 });
 const top=addText(outer,"div","taskTop","");
 const name=addText(top,"button","taskName",t.subject);
 name.type="button";
 name.title="Open the original message in its current folder, even after moving.";
 name.addEventListener("click",()=>void goToOriginal(t));
 const day=addText(top,"span","when",stamp(t).txt);if(stamp(t).overdue)day.classList.add("overdue");
 // Jeden jednoznaczny opis lokalizacji prawdziwego maila (bez technicznej historii przenoszenia).
 const meta=addText(outer,"div","taskMeta",folderDisplay(t.currentFolder?.path||t.currentFolder?.name||t.sourceFolder?.path||t.sourceFolder?.name));
 meta.title=meta.textContent;
 const actions=addText(outer,"div","taskActions","");
 const open=addText(actions,"button","navigateButton","↗ Original");
 open.type="button";
 open.title="Opens the original email in its current Thunderbird folder, even after moving. Not the locally generated reminder.";
 open.addEventListener("click",()=>void goToOriginal(t));
 const descriptions={
  finish:"Stops monitoring this follow-up. Does not delete messages or reminders.",
  moveOriginalNow:"Moves the existing original to Local Folders Inbox without creating a copy.",
  setMoveAtDue:"Controls whether the original will be moved to Inbox when the reminder is due.",
  markAnswered:"Marks this follow-up answered and moves it to Answered. Does not delete any mail.",
  retry:"Retries generating a local reminder after an error. Does not send mail."
 };
 function action(label,type,opts={}){
   const isRestore=type==="finish" && !!opts.returnToOriginal;
   const css=type==="finish" ? "finishButton" : type==="markAnswered" ? "answeredButton" : type==="retry" ? "retryButton" : "utilityButton";
   const b=addText(actions,"button",css,label);
   b.type="button";
   b.title=isRestore
      ? "Finish the follow-up and move its original back to the folder it was in before the automatic move. Does not delete the message."
      : descriptions[type] || label;
   if(type==="setMoveAtDue") b.title=opts.moveAtDue
     ? "Move the original to Inbox on the due date, without copying."
     : "Leave the original in its folder; only the local reminder will appear in Inbox.";
   b.addEventListener("click",async()=>{
     if(b.disabled)return;
     b.disabled=true;
     try{status("Working…");await send(type,{id:t.id,...opts});status("Saved.");await load();}
     catch(e){status(String(e),true);b.disabled=false;}
   });
 }
 if(t.status!=="done"){
   action("Finish","finish");
   if(t.kind==="followup" && ["waiting","reminded","error"].includes(t.status)){
     const update=addText(actions,"button","utilityButton","Reschedule");
     update.type="button";
     update.title="Change this task's due date without creating a duplicate. Existing reminder emails are preserved.";
     update.addEventListener("click",event=>{
       event.stopPropagation();
       const previous=outer.querySelector(".rescheduleEditor");
       if(previous){previous.remove();return;}
       const editor=addText(outer,"div","rescheduleEditor","");
       editor.addEventListener("click",e=>e.stopPropagation());
       editor.addEventListener("dblclick",e=>e.stopPropagation());
       editor.addEventListener("keydown",e=>e.stopPropagation());
       const heading=addText(editor,"div","rescheduleHint",`Current due: ${formatDueDate(t.due)} · ${t.status.toUpperCase()}`);
       const row=addText(editor,"div","rescheduleRow","");
       const day=document.createElement("input");day.type="date";day.title="New follow-up date";
       const hour=document.createElement("input");hour.type="time";hour.title="New follow-up time";
       const existing=new Date(t.due);
       const prefill=existing.getTime()>Date.now()?existing:new Date(Date.now()+3*86400000);
       day.value=localDate(prefill);
       hour.value=String(prefill.getHours()).padStart(2,"0")+":"+String(prefill.getMinutes()).padStart(2,"0");
       const moveLabel=document.createElement("label");moveLabel.className="rescheduleMove";
       const move=document.createElement("input");move.type="checkbox";move.checked=!!t.moveAtDue;
       moveLabel.append(move,document.createTextNode("Move to Inbox when due"));
       const save=document.createElement("button");save.type="button";save.className="rescheduleSave";save.textContent="Update";
       const cancel=document.createElement("button");cancel.type="button";cancel.textContent="Cancel";
       row.append(day,hour,save,cancel);editor.append(row,moveLabel);
       save.addEventListener("click",async()=>{
         save.disabled=true;
         try {
           const chosen=new Date(day.value+"T"+hour.value+":00");
           if(!Number.isFinite(chosen.getTime())||chosen<=new Date())throw new Error("Choose a future due date.");
           const result=await send("rescheduleTask",{id:t.id,due:chosen.toISOString(),moveAtDue:move.checked});
           status(`Follow-up rescheduled to ${formatDueDate(result.due)}. No duplicate task created.`);
           await load();
         }catch(e){status("Could not reschedule: "+String(e),true);save.disabled=false;}
       });
       cancel.addEventListener("click",()=>editor.remove());
       day.focus();
     });
   }
   if(t.status==="waiting") {
     action(t.moveAtDue ? "Do not move" : "Move when due",
       "setMoveAtDue",{moveAtDue:!t.moveAtDue});
   }
   if(t.status==="reminded" && !/(?:^|\/)(?:Inbox|Odebrane)$/i.test(t.currentFolder?.path||"")) {
     action("Move to Inbox", "moveOriginalNow");
   }
   if(t.kind==="followup" && ["waiting","reminded","processing","error"].includes(t.status)) {
     const diagnose=addText(actions,"button","diagnoseButton","Check reply");
     diagnose.type="button";
     diagnose.title="Checks reply links via Message-ID, References, and In-Reply-To. Does not modify or delete messages.";
     diagnose.addEventListener("click",async()=>{
       try {
         diagnose.disabled=true;
         const result=await send("replyDiagnostic",{id:t.id});
         const description={"original":"original","synthetic":"local reminder","no-references":"no reply headers","old-date":"older than the follow-up","own-address":"sender is your own address","accepted":"valid reply","unreadable":"unreadable headers"};
         let box=outer.querySelector(".diagnostic");
         if(!box)box=addText(outer,"div","diagnostic","");
         box.replaceChildren();
         addText(box,"strong","",`Checked ${result.scanned} messages with a similar subject.`);
         for(const [k,count] of Object.entries(result.counts)) {
           if(count) addText(box,"div","",`${description[k]||k}: ${count}`);
         }
         if(result.truncated)addText(box,"div","", "Note: the number of inspected messages was limited.");
         if(result.counts["own-address"]>0) {
           const allow=addText(box,"button","small","Count my own replies");
           allow.type="button";
           allow.title="Allow replies sent from your own address, e.g. for a self-addressed test.";
           allow.addEventListener("click",async()=>{
             try{await send("acceptOwnReplies",{id:t.id});status("Reply rule updated and messages checked.");await load();}
             catch(e){status(String(e),true);}
           });
         }
         if(result.counts["no-references"]>0) addText(box,"div","", "Matching subjects or visual threading alone is not enough. References or In-Reply-To headers are needed.");
         if(result.counts["old-date"]>0) addText(box,"div","", "This message predates the follow-up and cannot count automatically.");
         if(result.matched) addText(box,"div","", "A linked reply was found. Use “Check replies and due dates”.");
         else if(!result.scanned) addText(box,"div","", "No matching messages were found in Local Folders.");
       }catch(e){status("Diagnostics: "+e,true);}
       finally{diagnose.disabled=false;}
     });
     action("Answered","markAnswered");
   }
   if(t.movedByUs)action("Finish & restore","finish",{returnToOriginal:true});
   if(t.status==="error")action("Retry","retry");
 }
 // Resolve duplicates explicitly; do not guess which copy is the monitored one.
 if(t.tagError && /kopii|niejednoznaczn|wielu kopii|copies|ambiguous/i.test(t.tagError) &&
     ["waiting","reminded","processing","error"].includes(t.status)) {
   const selectCopy=addText(actions,"button","chooseCopyButton","Choose copy");
   selectCopy.type="button";
   selectCopy.title="Choose the correct original among messages sharing a Message-ID. Tags will be repaired.";
   selectCopy.addEventListener("click",async()=>{
     let chooser=outer.querySelector(".copyChooser");
     if(chooser){chooser.remove();return;}
     chooser=addText(outer,"div","copyChooser","");
     addText(chooser,"strong","","Choose the message to monitor:");
     try {
       selectCopy.disabled=true;
       const copies=await send("originalCandidates",{id:t.id});
       if(!copies.length){addText(chooser,"p","","No copies found in Local Folders.");return;}
       copies.forEach(copy=>{
         const item=addText(chooser,"div","copyOption","");
         addText(item,"div","copyFolder",folderDisplay(copy.folder));
         addText(item,"div","copyDetails",[copy.subject,copy.author,copy.date?new Date(copy.date).toLocaleString("en-GB"):""].filter(Boolean).join(" · "));
         // When there are two truly distinct messages with identical metadata,
         // expose their different internal IDs instead of displaying identical rows.
         addText(item,"div","copyDetails",`Thunderbird message #${copy.id}${copy.knownId?" · saved when the follow-up was created":""}`);
         const choose=addText(item,"button","copySelectButton","Use this copy");
         choose.type="button";
         choose.title="Bind the follow-up to this message and repair its tags.";
         choose.addEventListener("click",async()=>{
           choose.disabled=true;
           try {
             status("Binding the selected copy and repairing tags…");
             await send("bindOriginal",{id:t.id,messageId:copy.id,
                 accountId:copy.accountId,folderPath:copy.folderPath});
             status("Original selected. Tags repaired.");
             await load();
           }catch(e){status("Cannot select copy: "+String(e),true);choose.disabled=false;}
         });
       });
     }catch(e){status("Copy list: "+String(e),true);addText(chooser,"div","taskError",String(e));}
     finally{selectCopy.disabled=false;}
   });
 }
 if(t.lastError)addText(outer,"div","taskError",t.lastError);
 if(t.tagError)addText(outer,"div","taskError","Tags: "+t.tagError + (/kopii|niejednoznaczn|copies|ambiguous/i.test(t.tagError)?" Click “Choose copy”.":" Open Log → Repair active tags."));
 return outer;
}
// Dane z bazy pobieramy raz; samo wpisywanie w filtrze nie odpyta ponownie TB.
// Dzięki temu lista reaguje od razu także przy kilkudziesięciu zadaniach.
function normalizeSearch(value){
 return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("en");
}
function renderTasks(){
 const all=allTasks;
 const active=all.filter(t=>["waiting","reminded","processing","error"].includes(t.status));
 $("count").textContent=String(active.length);
 for(const [kind,label] of [["active","Active"],["answered","Answered"],["done","Finished"]]){
   const n=kind==="active"?active.length:all.filter(t=>t.status===kind).length;
   const button=document.querySelector(`.tabs button[data-view="${kind}"]`);
   if(button) button.textContent=`${label} (${n})`;
 }
 const finishedCount=all.filter(t=>t.status==="done").length;
 const clearButton=$("clearFinished");
 clearButton.hidden=view!=="done" || finishedCount===0;
 clearButton.textContent=`Clear finished (${finishedCount})`;
 const term=normalizeSearch($("taskSearch").value.trim());
 const unfiltered=all.filter(t=>view==="active"?["waiting","reminded","processing","error"].includes(t.status):t.status===view);
 const rows=unfiltered.filter(t=>!term||normalizeSearch([
   t.subject,t.currentFolder?.path,t.currentFolder?.name,t.sourceFolder?.path,t.sourceFolder?.name
 ].join(" ")).includes(term))
   .sort((a,b)=>new Date(a.due)-new Date(b.due));
 const box=$("tasks");const previousScroll=box.scrollTop;
 box.replaceChildren();
 rows.slice(0,100).forEach(t=>box.appendChild(taskNode(t)));
 box.scrollTop=previousScroll;
 if(!rows.length) addText(box,"div","empty",term?"No tasks match your search.":"No tasks in this tab.");
 $("shown").textContent=term?`Found ${rows.length} of ${unfiltered.length}`:
   rows.length>100?`100 of ${rows.length} (nearest due dates)`:`${rows.length} tasks`;
}
async function load(){
 const request=++listRequest;
 try{
  const all=await send("list");
  if(request!==listRequest)return;
  allTasks=all;
  renderTasks();
 }catch(e){status("Task list: "+e,true);}
}
async function selection(){
 const card=$("selected");
 function showProblem(message){
  selectedExistingTask=null;$("existingNotice").hidden=true;$("add").textContent="✓ Save follow-up and close";
  canCreate=false;card.replaceChildren();
  addText(card,"div","selectionTitle","No message selected");
  addText(card,"div","selectionFolder",message);
  card.classList.add("fail");$("add").disabled=true;
 }
 try{
  if(multipleSelected){showProblem("Select exactly one message.");return false;}
  const s=await send("selection",sourceId?{messageId:sourceId}:{});
  if(!s){showProblem("Select a message in Thunderbird.");return false;}
  canCreate=Boolean(s.local&&s.hasHeader);
  card.replaceChildren();
  addText(card,"div","selectionTitle",s.subject||"(no subject)");
  const location=addText(card,"div","selectionFolder",folderDisplay(s.folder));
  location.title=location.textContent;
  if(!s.local)addText(card,"div","selectionProblem","Available for Local Folders only.");
  if(!s.hasHeader)addText(card,"div","selectionProblem","Message-ID header is missing.");
  selectedExistingTask=s.existingTask||null;
  const notice=$("existingNotice");
  if(selectedExistingTask && canCreate){
    notice.hidden=false;
    const when=formatDueDate(selectedExistingTask.due);
    notice.textContent=`Existing follow-up found (${selectedExistingTask.status.toUpperCase()}; due ${when}). Change the date and click Update — the existing task will be reused, not duplicated.`+
      (selectedExistingTask.status==="reminded" ? " The old local reminder will be kept; a fresh reminder is created only on the new due date." : "");
    $("add").textContent="↻ Update existing follow-up and close";
    fillDueFromTask(selectedExistingTask);
    if(selectedExistingTask.status==="processing") {
      notice.textContent="This follow-up is currently being processed. Reopen the form after processing finishes.";
      canCreate=false;
    }
  } else {
    notice.hidden=true;
    $("add").textContent="✓ Save follow-up and close";
  }
  card.classList.toggle("fail",!canCreate);$("add").disabled=!canCreate;
  return canCreate;
 }catch(e){showProblem(String(e));return false;}
}
$("add").addEventListener("click",async()=>{
 try{if(!canCreate)throw Error("First select a message in Local Folders.");
  $("add").disabled=true;
  // Dopiero potwierdzony zapis pozwala zamknąć okno. W razie błędu formularz zostaje.
  const saved=await send("addSelected",{...(sourceId?{messageId:sourceId}:{}),kind:currentKind,due:due(),moveAtDue:$("move").checked});
  if(saved?.rescheduled) status("Existing follow-up rescheduled. Same task, new due date.");
  if(saved?.tagError) {
    status("The follow-up was SAVED, but tagging failed: "+saved.tagError+". Do not create a duplicate. Open the full list, then Log → Repair active tags.",true);
    $("openFullPanel").hidden=false;
  } else {
    status(saved?.rescheduled ? "Existing follow-up updated. Closing window…" : "Follow-up saved. Closing window…");
    window.close();
  }
 }catch(e){status(String(e),true);$("openFullPanel").hidden=false;}finally{$("add").disabled=!canCreate;}
});
$("refresh").addEventListener("click",()=>{void syncSelection();if(!createOnly)void load();});
$("checknow").addEventListener("click",async()=>{
 const button=$("checknow");button.disabled=true;
 try{
  status("Checking replies and due dates…");
  const result=await send("scanReplies");
  await send("tick");await load();
  status(`Checked ${result.checked} follow-ups; detected ${result.answered} replies` +
   (result.errors?`; errors: ${result.errors}`: "."),Boolean(result.errors));
 }catch(e){status(String(e),true);}finally{button.disabled=false;}
});
function showCreate(expand){
 $("createSection").classList.toggle("collapsed",!expand);
 $("toggleCreate").setAttribute("aria-expanded",String(expand));
 $("toggleCreate").textContent=expand?"Collapse form ▴":"Expand form ▾";
}
$("toggleCreate").addEventListener("click",()=>{manuallyToggledCreate=true;showCreate($("createSection").classList.contains("collapsed"));});
$("taskSearch").addEventListener("input",()=>{ $("tasks").scrollTop=0;renderTasks(); });
document.querySelectorAll(".presets button").forEach(x=>x.addEventListener("click",()=>setPreset(x.dataset.days)));
$("day").addEventListener("change",()=>setPreset("custom"));$("hour").addEventListener("change",()=>setPreset("custom"));
document.querySelectorAll(".tabs button[data-view]").forEach(b=>b.addEventListener("click",()=>{view=b.dataset.view;document.querySelectorAll(".tabs button[data-view]").forEach(x=>x.classList.toggle("active",x===b));$("tasks").scrollTop=0;renderTasks();}));
// Only finished history records are removed. No Thunderbird messages are touched.
$("clearFinished").addEventListener("click",async()=>{
 const button=$("clearFinished");
 const count=allTasks.filter(t=>t.status==="done").length;
 if(view!=="done" || count===0)return;
 if(!window.confirm(`Remove all ${count} finished follow-up records from history?\n\nThis will NOT delete or change any email messages.\nThis action cannot be undone.`))return;
 button.disabled=true;
 try{
  const result=await send("clearFinished");
  await load();
  status(`Removed ${result.removed} finished record(s) from the queue. No emails were deleted.`);
 }catch(e){status("Could not clear finished history: "+String(e),true);}
 finally{button.disabled=false;}
});
async function loadSettings() {
 try {
   const settings=await send("getSettings");
   defaultReminderTime=settings.defaultTime;
   $("defaultHour").value=defaultReminderTime;
   $("settingsHourText").textContent=defaultReminderTime;
   if (preset!=="custom") setPreset(preset);
 } catch(e) { status("Settings: "+e,true); }
}
$("saveDefaultHour").addEventListener("click", async()=>{
  const button=$("saveDefaultHour");
  try {
    button.disabled=true;
    const settings=await send("setSettings",{settings:{defaultTime:$("defaultHour").value}});
    defaultReminderTime=settings.defaultTime;
    $("settingsHourText").textContent=defaultReminderTime;
    if (preset!=="custom") setPreset(preset);
    status("New default time: "+defaultReminderTime+". Existing follow-ups were not changed.");
  } catch(e) { status("Could not save default time: "+e,true); }
  finally { button.disabled=false; }
});
// Ikona zębatki pozostaje w nagłówku; panel ustawień otwiera się nad listą.
document.addEventListener("keydown", e => {
 if (e.key === "Escape") $("settingsSection").open = false;
});
document.addEventListener("click", e => {
 const settings = $("settingsSection");
 if (settings.open && !settings.contains(e.target)) settings.open = false;
});
// Bez zaznaczonej wiadomości schowaj zbędny formularz: lista otrzyma całe miejsce.
// Z zaznaczoną wiadomością formularz pozostaje rozwinięty. Można to zmienić ręcznie.
async function syncSelection(){
 const available=await selection();
 if(!createOnly && !manuallyToggledCreate)showCreate(available);
 if(!available && !createOnly && !manuallyToggledCreate){
   $("taskSearch").focus({preventScroll:true});
 }
}
showCreate(createOnly);setPreset("3");void syncSelection();if(!createOnly)void load();void loadSettings();
// Po uruchomieniu odświeżamy zapisane ścieżki także wtedy, gdy w czasie
// przenoszenia maila do innego katalogu panel nie był otwarty.
void send("refreshLocations").then(result=>{
 if(result.changed && !createOnly) return load();
}).catch(e=>console.warn("Follow-up: current location check",String(e)));
// Keep an already open list synchronized when a response arrives in the background.
try {
 messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tasks && !createOnly) load();
  if (area === "local" && changes.settings) loadSettings();
 });
} catch (_) { /* Older runtimes: manual refresh remains available. */ }
if(!createOnly) window.addEventListener("focus", () => load());

// Diagnostyka i naprawa: zawsze pokazuje rekordy z bazy bez filtra listy.
function formatReport(report) {
  const lines=[`Follow-up Local ${report.version} | ${report.generated}`,
    `ALL TASKS: ${report.tasks.length}`,""];
  for(const t of report.tasks) {
    lines.push(`${t.status.toUpperCase()} | ${t.subject} | ${t.folder} | ${t.due}`);
    lines.push(`  id=${t.id} tagSetupComplete=${t.tagSetupComplete} tagError=${t.tagError||"none"}`);
  }
  lines.push("","LOG (oldest first):");
  for(const e of report.log) lines.push(`[${e.at}] ${e.level} ${e.details}`);
  return lines.join("\n");
}
async function refreshDiagnosticReport() {
  $("diagnosticsText").value="Loading report…";
  try {$("diagnosticsText").value=formatReport(await send("diagnosticReport"));}
  catch(e){$("diagnosticsText").value="Diagnostics error: "+String(e);}
}
// The toolbar Log control is a toggle: clicking it twice closes the report.
function setDiagnosticsOpen(open){
  $("diagnosticsPanel").hidden = !open;
  $("showDiagnostics").setAttribute("aria-expanded", String(open));
  $("showDiagnostics").title = open
    ? "Close the diagnostic log"
    : "Open the diagnostic log, including hidden tasks and tag errors; retry tag assignment.";
  if (open) void refreshDiagnosticReport();
}
$("showDiagnostics").addEventListener("click",()=>{
  setDiagnosticsOpen($("diagnosticsPanel").hidden);
});
$("closeDiagnostics").addEventListener("click",()=>setDiagnosticsOpen(false));
$("refreshDiagnostics").addEventListener("click",()=>void refreshDiagnosticReport());
$("repairActiveTags").addEventListener("click",async()=>{
  const b=$("repairActiveTags");b.disabled=true;
  try {
    const results=await send("repairActiveTags");
    const errors=results.filter(r=>r.error);
    status(`Checked tags for ${results.length} tasks; errors: ${errors.length}.`,!!errors.length);
    await load();await refreshDiagnosticReport();
  }catch(e){status("Tag repair: "+String(e),true);}
  finally {b.disabled=false;}
});
$("openFullPanel").addEventListener("click",async()=>{
  try {
    // Convert this quick-create popup into the full list, IN PLACE.
    // Opening a second window and then closing this one would defeat the
    // one-window rule and could race with the background panel registry.
    const w=await messenger.windows.getCurrent();
    await messenger.windows.update(w.id,{width:1120,height:880,focused:true});
    const url=new URL(window.location.href);
    url.searchParams.delete("onlyCreate");
    url.searchParams.delete("create");
    window.location.replace(url.toString());
  } catch(e){status("Opening task list: "+String(e),true);}
});


// 0.1.22: Ko-fi only opens after an explicit click (no network calls on load).
const supportLink = document.getElementById("supportLink");
if (supportLink) {
  supportLink.addEventListener("click", async event => {
    event.preventDefault();
    try {
      await messenger.windows.openDefaultBrowser("https://ko-fi.com/gawkla");
    } catch (error) {
      status("Could not open Ko-fi in your browser: " + String(error), true);
    }
  });
}
