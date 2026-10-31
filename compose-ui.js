"use strict";
const $=id=>document.getElementById(id);
let tabId=null,preset="3",defaultReminderTime="08:15";
function status(x,bad=false){$("status").textContent=x;$("status").classList.toggle("error",bad);}
function dformat(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function choose(days){preset=days;document.querySelectorAll(".presets button").forEach(b=>b.classList.toggle("chosen",b.dataset.days===days));if(days!=="custom"){const d=new Date();d.setDate(d.getDate()+Number(days));$("day").value=dformat(d);$("hour").value=defaultReminderTime;}}
function due(){const d=new Date($("day").value+"T"+$("hour").value+":00");if(!Number.isFinite(d.getTime())||d<=new Date())throw new Error("Choose a future due date.");return d.toISOString();}
async function send(type,fields={}){return messenger.runtime.sendMessage({type,...fields});}
async function init(){try{const info=await send("composePreview");tabId=info.tabId;$("composeInfo").textContent=info.subject+" · to: "+(info.to||[]).join(", ");}catch(e){status("Cannot read compose window: "+e,true);$("save").disabled=true;}}
document.querySelectorAll(".presets button").forEach(b=>b.addEventListener("click",()=>choose(b.dataset.days)));
$("day").addEventListener("change",()=>choose("custom"));$("hour").addEventListener("change",()=>choose("custom"));
$("save").addEventListener("click",async()=>{try{if(tabId===null)throw Error("Compose window not found.");await send("composeSet",{tabId,kind:"followup",due:due(),moveAtDue:$("move").checked});status("Follow-up saved. Send the message normally.");window.close();}catch(e){status(String(e),true);}});
$("clear").addEventListener("click",async()=>{try{await send("composeClear",{tabId});status("Pending follow-up cancelled.");}catch(e){status(String(e),true);}});
choose("3");init();
(async()=>{
  try {
    const settings=await send("getSettings");
    defaultReminderTime=settings.defaultTime;
    if(preset!=="custom")choose(preset);
  }catch(e){status("Default time: "+e,true);}
})();
