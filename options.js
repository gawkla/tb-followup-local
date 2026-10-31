"use strict";
const timeInput=document.getElementById("defaultTime");
const status=document.getElementById("status");
const save=document.getElementById("save");
async function message(type,fields={}) { return messenger.runtime.sendMessage({type,...fields}); }
(async()=>{
  try { const settings=await message("getSettings"); timeInput.value=settings.defaultTime; }
  catch(e){status.textContent="Could not load settings: "+e;}
})();
save.addEventListener("click",async()=>{
  save.disabled=true;
  try {
    const settings=await message("setSettings",{settings:{defaultTime:timeInput.value}});
    timeInput.value=settings.defaultTime;
    status.textContent="Saved "+settings.defaultTime+". New follow-ups will use this time.";
  } catch(e) {status.textContent="Could not save: "+e;}
  finally{save.disabled=false;}
});
