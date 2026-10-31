"use strict";
/* Thunderbird 140 ESR / 141 MV2 background. All reminder email is generated locally
   with messages.import; this extension never calls any send method. */
const api = messenger;
const LOG = "[Follow-up Local]";
const dueBusy = new Set();
const ANSWER_TRACKING_STATES = new Set(["waiting", "processing", "error", "reminded"]);
const tagOperations = new Map();
let serial = Promise.resolve();

// Toolbar warning (v0.1.20): purely visual; does not alter any task or email.
// Treat an already generated reminder as requiring attention until the user
// marks the follow-up as answered or completed.
function overdueFollowupCount(tasks, now=Date.now()) {
  return tasks.filter(t => t.kind === "followup" && (
    t.status === "reminded" ||
    (["waiting", "processing", "error"].includes(t.status) &&
      Number.isFinite(Date.parse(t.due)) && Date.parse(t.due) <= now)
  )).length;
}
let toolbarAlertState = null;
let toolbarAlertQueue = Promise.resolve();
async function updateToolbarAlert() {
  const {tasks=[]} = await api.storage.local.get({tasks:[]});
  const n = overdueFollowupCount(tasks);
  const state = n ? `overdue-${n}` : "normal";
  if (toolbarAlertState === state) return;
  const icon = n ? {"32":"icons/overdue32.png", "64":"icons/overdue64.png"}
                 : {"32":"icons/task32.png", "64":"icons/task64.png"};
  await api.browserAction.setIcon({path:icon});
  await api.browserAction.setBadgeBackgroundColor({color:"#B4232B"});
  await api.browserAction.setBadgeText({text:n ? "!" : ""});
  await api.browserAction.setTitle({title:n ? `Follow-up: ${n} overdue task(s)` : "Follow-up"});
  toolbarAlertState = state;
}
function requestToolbarAlert() {
  toolbarAlertQueue = toolbarAlertQueue.catch(()=>{}).then(updateToolbarAlert)
    .catch(e => console.warn(LOG,"Could not refresh the Follow-up icon:",e));
  return toolbarAlertQueue;
}
// No changes to existing storage handling: observe only the tasks key.
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tasks) void requestToolbarAlert();
});

function cleanId(value) { return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase(); }
function plainId(value) { return String(value || "").trim().replace(/^<|>$/g, ""); }
function folderKey(f) { return f ? `${f.accountId || ""}|${f.path || f.name || ""}` : ""; }
function folderLabel(f) { return f ? `${f.path || f.name || "?"}` : "Unknown folder"; }
function asFolder(f) { return f ? { accountId:f.accountId, path:f.path, name:f.name } : null; }
function allChildren(folder) {
  if (!folder) return [];
  return [folder, ...(folder.subFolders || []).flatMap(allChildren)];
}
function uniqueTaskId() { return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
// Trwaly, ograniczony dziennik bez tresci wiadomosci. Operacje zapisu
// wykonujemy niezaleznie od kolejki transakcji zadan, aby uniknac deadlocka.
let diagnosticQueue = Promise.resolve();
function recordDiagnostic(level, parts) {
  const details=parts.map(p => typeof p === "string" ? p : JSON.stringify(p)).join(" ").slice(0,650);
  diagnosticQueue = diagnosticQueue.catch(()=>{}).then(async()=>{
    const {diagnosticLog=[]}=await api.storage.local.get({diagnosticLog:[]});
    diagnosticLog.push({at:new Date().toISOString(),level,details});
    await api.storage.local.set({diagnosticLog:diagnosticLog.slice(-120)});
  }).catch(e=>console.warn(LOG,"Could not save diagnostic log:",e));
}
function writeLog(...a) {
  console.log(LOG, ...a);
  if (/^(Added|Rescheduled|Follow-up tags|Tag operation|Restored WaitingForFBK|Saved local reminder|Reply detected|Tag repair|Duplicate follow-up|Tag error)/.test(String(a[0]))) recordDiagnostic("info",a);
}
function writeError(...a) { console.error(LOG, ...a); recordDiagnostic("error",a); }

// Systemowe powiadomienia. Thunderbird/Windows może zdecydować o ich
// faktycznym położeniu i momencie wyświetlenia; po ~5 s prosimy o zamknięcie.
// Błędy powiadomień nigdy nie przerywają zapisu zadań ani importu maili.
const NOTICE_DURATION_MS = 5000;
const DEFAULT_REMINDER_TIME = "08:15";
function validateReminderTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
async function getSettings() {
  const {settings} = await api.storage.local.get("settings");
  const savedTime = settings && settings.defaultTime;
  return {defaultTime:validateReminderTime(savedTime) ? savedTime : DEFAULT_REMINDER_TIME};
}
async function setSettings(next) {
  if (!validateReminderTime(next?.defaultTime)) throw new Error("Time must be HH:MM (00:00–23:59).");
  const settings = {defaultTime:next.defaultTime};
  await api.storage.local.set({settings});
  writeLog("Default reminder time updated:", settings.defaultTime);
  return settings;
}

// Kliknięcie systemowego powiadomienia ma aktywować główne okno poczty,
// nie tworzyć nowego okna i nie zmieniać wybranego folderu / wiadomości.
async function focusMainThunderbirdWindow() {
  if (!api.windows?.getAll || !api.windows?.update) throw new Error("Windows API is unavailable.");
  const mainWindows = await api.windows.getAll({windowTypes:["normal"]});
  if (!mainWindows?.length) throw new Error("No main Thunderbird window found.");
  let last = null;
  try { last = await api.windows.getLastFocused(); } catch (_) {}
  const main = mainWindows.find(w=>w.id===last?.id) ||
    mainWindows.find(w=>w.focused) || mainWindows[0];
  if (main.state === "minimized") {
    await api.windows.update(main.id, {state:"normal"});
  }
  await api.windows.update(main.id, {focused:true});
  writeLog("Focused Thunderbird after a notification click", main.id);
}
if (api.notifications?.onClicked) {
  api.notifications.onClicked.addListener(notificationId => {
    if (!/^followup-(due|answered)-/.test(String(notificationId))) return;
    focusMainThunderbirdWindow().catch(error =>
      writeError("Could not activate Thunderbird from the notification:", error));
  });
}
async function notifyTask(task, event) {
  if (!api.notifications?.create) return;
  const title = event === "answered"
    ? "Follow-up: reply received"
    : task.kind === "snooze" ? "Snooze: reminder" : "Follow-up: due date reached";
  const message = event === "answered"
    ? `Reply received for: ${task.subject}. Moved to Answered.`
    : `Reminder for: ${task.subject}. Check Local Folders Inbox.`;
  try {
    const noticeId = `followup-${event}-${task.id}`;
    const id = await api.notifications.create(noticeId, {
      type: "basic",
      iconUrl: api.runtime.getURL("icons/task64.png"),
      title,
      message
    });
    writeLog("Notification", event, task.subject);
    setTimeout(() => {
      api.notifications.clear(id || noticeId)
        .catch(error => writeLog("Dismiss notification", String(error)));
    }, NOTICE_DURATION_MS);
  } catch (error) {
    writeError("Notification could not be shown", String(error));
  }
}

async function state() { const s = await api.storage.local.get({ tasks: [], composePending: {} }); return s; }
function transaction(fn) {
  const p = serial.then(async () => {
    const s = await state();
    const result = await fn(s);
    await api.storage.local.set({tasks:s.tasks, composePending:s.composePending});
    return result;
  });
  serial = p.catch(e => writeError("storage transaction:", e));
  return p;
}
async function findLocal() {
  const accounts = await api.accounts.list(true);
  const local = accounts.find(a => a.type === "none");
  if (!local) throw new Error("Local Folders account (type none) not found.");
  return local;
}
async function inbox() {
  const local = await findLocal();
  const all = allChildren(local.rootFolder || {subFolders:local.folders || []});
  const box = all.find(f => (f.specialUse || []).includes("inbox")) ||
      all.find(f => ["inbox", "odebrane"].includes(String(f.name || "").toLowerCase()) && (String(f.path || "").split("/").filter(Boolean).length <= 1));
  if (!box) throw new Error("Local Folders Inbox not found. Create the folder and try again.");
  return box;
}
async function isLocalFolder(folder) {
  const a = await api.accounts.get(folder.accountId, false);
  return !!(a && a.type === "none");
}

async function queryAll(query, max = 100) {
  const result = [];
  let page = await api.messages.query(query);
  try {
    while (page) {
      for (const m of page.messages || []) {
        result.push(m);
        if (result.length >= max) return result;
      }
      if (!page.id) break;
      page = await api.messages.continueList(page.id);
    }
  } finally {
    if (page && page.id && result.length >= max) {
      try { await api.messages.abortList(page.id); } catch (_) {}
    }
  }
  return result;
}
// Never infer the identity of a monitored original from RFC Message-ID alone:
// a copied .eml has the SAME Message-ID. In ambiguous cases ask the user.
async function originalCandidates(task) {
  const id=plainId(task.headerMessageId);
  if(!id) throw new Error("This message has no Message-ID.");
  const found=(await queryAll({headerMessageId:id}, 100))
    .filter(m=>m.folder && cleanId(m.headerMessageId)===cleanId(id));
  // messages.query() can report the SAME Thunderbird message more than once.
  // Counting raw search rows as physical copies made it impossible to repair
  // tags even after choosing the correct message. A Thunderbird message id is
  // unique for the current session, so count each id exactly once. Do NOT
  // deduplicate on subject/author/date/Message-ID: different real copies may
  // have identical metadata and must remain individually selectable.
  const local=[];
  const seenMessageIds=new Set();
  let repeatedRows=0;
  for (const m of found) {
    if (!Number.isSafeInteger(m.id) || m.id<=0) continue;
    if (seenMessageIds.has(m.id)) { repeatedRows++; continue; }
    seenMessageIds.add(m.id);
    if (await isLocalFolder(m.folder)) local.push(m);
  }
  if (repeatedRows) console.debug(LOG,
    `Message-ID search returned ${repeatedRows} duplicate rows; unique local messages: ${local.length}`);
  return local;
}
function pickOriginal(task, candidates, hintId=null) {
  if (!candidates.length) return null;
  if (candidates.length===1) return candidates[0];
  // A Thunderbird internal id is ephemeral. Only trust it when BOTH the
  // exact folder and RFC Message-ID still agree with what we remembered.
  const remembered=folderKey(task.currentFolder);
  const sameFolder=candidates.filter(m=>folderKey(m.folder)===remembered);
  for(const internalId of [hintId,task.lastKnownInternalId]) {
    if(!Number.isSafeInteger(internalId)||internalId<=0)continue;
    const matching=sameFolder.filter(m=>m.id===internalId);
    if(matching.length===1)return matching[0];
  }
  if(sameFolder.length===1)return sameFolder[0];
  throw new Error(`Found ${candidates.length} copies sharing this Message-ID. Choose the monitored original using the “Choose copy” button.`);
}
async function locate(task) {
  const candidates=await originalCandidates(task);
  return pickOriginal(task,candidates);
}
async function resolveOriginal(task,hintId=null) {
  const candidates=await originalCandidates(task);
  return pickOriginal(task,candidates,hintId);
}
async function originalCandidateList(taskId) {
  const task=await findTask(taskId);
  if(!task)throw new Error("Task does not exist.");
  if(!["waiting","reminded","processing","error"].includes(task.status))
    throw new Error("You can choose a copy only for an active task.");
  const copies=await originalCandidates(task);
  return copies.map(m=>({
    id:m.id,folder:folderLabel(m.folder),accountId:m.folder.accountId,
    folderPath:m.folder.path,subject:m.subject,author:m.author||"",
    date:m.date instanceof Date?m.date.toISOString():String(m.date||""),
    remembered:folderKey(m.folder)===folderKey(task.currentFolder),
    knownId:m.id===task.lastKnownInternalId
  }));
}
async function bindOriginal(taskId,internalId,accountId,folderPath) {
  const task=await findTask(taskId);
  if(!task||!["waiting","reminded","processing","error"].includes(task.status))
    throw new Error("Task is not active.");
  const copies=await originalCandidates(task);
  const selected=copies.find(m=>m.id===internalId &&
    m.folder.accountId===accountId && m.folder.path===folderPath);
  if(!selected)throw new Error("The selected copy was moved or removed. Refresh the list and choose again.");
  // Preserve sourceFolder: it may be needed to restore the message after due.
  await patchTask(taskId,{currentFolder:asFolder(selected.folder),
    lastKnownInternalId:selected.id,tagError:null,
    selectedCopyAt:Date.now(),selectedCopyFolder:asFolder(selected.folder)});
  writeLog("Selected original from multiple copies",task.subject,folderLabel(selected.folder),selected.id);
  return repairTaskTags(taskId);
}

async function patchTask(taskId, patch) {
  return transaction(s => {
    const t = s.tasks.find(t => t.id === taskId);
    if (!t) throw new Error("Task does not exist.");
    Object.assign(t, patch, {updatedAt:Date.now()});
    return {...t};
  });
}
async function findTask(taskId) { return (await state()).tasks.find(t => t.id === taskId); }

// The tag key is NOT the label shown in Thunderbird. Resolve the user's
// existing tags by their display name, avoiding duplicate names or keys.
const FOLLOWUP_TAGS = [
  {name:"reminder", key:"fu_reminder", color:"#D98616"},
  {name:"WaitingForFBK", key:"fu_waitingforfbk", color:"#2177B5"}
];
function runTagOperation(taskId, work) {
  const previous = tagOperations.get(taskId) || Promise.resolve();
  const current = previous.catch(()=>{}).then(work);
  tagOperations.set(taskId, current);
  current.then(()=>{
    if (tagOperations.get(taskId) === current) tagOperations.delete(taskId);
  },()=>{
    if (tagOperations.get(taskId) === current) tagOperations.delete(taskId);
  });
  return current;
}
async function availableTags() {
  if (api.messages.tags?.list) return api.messages.tags.list();
  if (api.messages.listTags) return api.messages.listTags();
  throw new Error("Thunderbird tag list is unavailable.");
}
async function followupTagKeys() {
  let tags = await availableTags();
  const keys=[];
  for (const wanted of FOLLOWUP_TAGS) {
    let found = tags.find(t => String(t.tag||"").toLocaleLowerCase("pl") === wanted.name.toLocaleLowerCase("pl"));
    if (!found) {
      if (!api.messages.tags?.create) throw new Error(`The ${wanted.name} tag was not found and cannot be created.`);
      let key=wanted.key, ix=2;
      while(tags.some(t=>t.key===key)) key=`${wanted.key}_${ix++}`;
      const created=await api.messages.tags.create(key,wanted.name,wanted.color);
      found={key:created||key,tag:wanted.name};
      tags=[...tags,found];
      writeLog("Created missing tag",found.tag,found.key);
    }
    keys.push(found.key);
  }
  return [...new Set(keys)];
}
async function ensureTaskTags(taskId, hintId=null) {
  return runTagOperation(taskId, async()=>{
    const task=await findTask(taskId);
    if (!task || task.kind!=="followup" || task.status!=="waiting" || task.tagSetupComplete) return false;
    const original=await resolveOriginal(task,hintId);
    if (!original) throw new Error("Original not found; no tags applied.");
    const wanted=await followupTagKeys();
    const present=new Set(original.tags || (await api.messages.get(original.id)).tags || []);
    const added=wanted.filter(key=>!present.has(key));
    if (added.length) await api.messages.update(original.id, {tags:[...present,...added]});
    // Save exactly what this add-on added. Tags that had already existed on
    // this message must remain under the user's control.
    await patchTask(taskId,{managedTagKeys:added,tagSetupComplete:true,tagError:null,
      currentFolder:asFolder(original.folder),lastKnownInternalId:original.id});
    writeLog("Tagi Follow-up",task.subject,added, "tagi zastane zachowane");
    return true;
  });
}
// Polityka tagów:
// - Po due date usuwamy reminder, lecz zostawiamy WaitingForFBK.
// - Po odpowiedzi LUB ręcznym zakończeniu usuwamy OBA tagi, także wtedy,
//   gdy były przypisane do wiadomości jeszcze przed utworzeniem Follow-upu.
// Innych tagów nie dotykamy. Znajdowanie po Message-ID działa po MOVE.
async function releaseTaskTags(taskId) {
  return runTagOperation(taskId, async()=>{
    const task=await findTask(taskId);
    if (!task || !["answered","done","reminded"].includes(task.status)) return false;
    const reminded=task.status==="reminded";
    if (reminded && task.reminderTagReleased) return false;
    if (!reminded && task.terminalTagClearChecked) return false;

    const [reminderKey,waitingKey]=await followupTagKeys();
    const toRemove=reminded ? [reminderKey] : [reminderKey,waitingKey];
    const original=await locate(task);
    if (!original) throw new Error("Original not found; could not remove follow-up tags.");
    const present=original.tags || (await api.messages.get(original.id)).tags || [];
    const updated=present.filter(key=>!toRemove.includes(key));
    if (updated.length!==present.length) {
      await api.messages.update(original.id,{tags:updated});
    }

    const owned=Array.isArray(task.managedTagKeys)?task.managedTagKeys:[];
    const patch={managedTagKeys:owned.filter(key=>!toRemove.includes(key)),tagError:null};
    if (reminded) patch.reminderTagReleased=true;
    else {
      patch.terminalTagClearChecked=true;
      patch.tagsClearedAt=Date.now();
    }
    await patchTask(taskId,patch);
    writeLog("Follow-up tags after",reminded?"due date":"reply/completion",
      task.subject,"removed:",present.filter(key=>toRemove.includes(key)));
    return updated.length!==present.length;
  });
}
// Starsza wersja 0.1.9 zdejmowała oba tagi po due date. Dla nadal
// przypomnianych zadań przywróć WaitingForFBK tylko raz, jeśli go brakuje.
// Nie dodawaj z powrotem reminder i nie zmieniaj tagów innych niż oczekiwany.
async function ensureWaitingAfterDue(taskId) {
  return runTagOperation(taskId, async()=>{
    const task=await findTask(taskId);
    if (!task || task.kind!=="followup" || task.status!=="reminded" || task.waitingAfterDueChecked) return false;
    const original=await locate(task);
    if (!original) throw new Error("Original not found for WaitingForFBK validation.");
    const [,waitingKey]=await followupTagKeys();
    const present=new Set(original.tags || (await api.messages.get(original.id)).tags || []);
    const managed=new Set(task.managedTagKeys||[]);
    if (!present.has(waitingKey)) {
      await api.messages.update(original.id,{tags:[...present,waitingKey]});
      managed.add(waitingKey);
      writeLog("Restored WaitingForFBK after due date",task.subject);
    }
    await patchTask(taskId,{managedTagKeys:[...managed],waitingAfterDueChecked:true,tagError:null});
    return true;
  });
}
async function safeTagWork(taskId, action, hintId=null) {
  try {
    const task= action==="apply" ? ensureTaskTags(taskId,hintId) :
      action==="keepWaiting" ? ensureWaitingAfterDue(taskId) : releaseTaskTags(taskId);
    return await task;
  } catch(e) {
    writeError("Operacja tagowania",action,taskId,String(e));
    try {await patchTask(taskId,{tagError:String(e)});}catch(_){}
    return false;
  }
}
// Naprawa na zadanie uzytkownika: ponownie weryfikuje fizyczne tagi,
// niezaleznie od zapisanego stanu tagSetupComplete.
async function repairTaskTags(taskId) {
  return runTagOperation(taskId,async()=>{
    const task=await findTask(taskId);
    if(!task || task.kind!=="followup" || !["waiting","reminded"].includes(task.status))
      return {id:taskId,skipped:true,reason:"Task is neither waiting nor reminded"};
    const original=await resolveOriginal(task);
    if(!original) throw new Error(`Original not found: ${task.subject}`);
    const [reminderKey,waitingKey]=await followupTagKeys();
    const present=new Set(original.tags || (await api.messages.get(original.id)).tags || []);
    const result=new Set(present);
    if(task.status==="waiting") {result.add(reminderKey);result.add(waitingKey);}
    else {result.delete(reminderKey);result.add(waitingKey);}
    if([...result].some(k=>!present.has(k)) || [...present].some(k=>!result.has(k)))
      await api.messages.update(original.id,{tags:[...result]});
    await patchTask(taskId,{
      tagSetupComplete:true,tagError:null,lastKnownInternalId:original.id,
      currentFolder:asFolder(original.folder),
      ...(task.status==="reminded"?{reminderTagReleased:true,waitingAfterDueChecked:true}:{})
    });
    writeLog("Tag repair",task.subject,task.status,folderLabel(original.folder));
    return {id:taskId,subject:task.subject,status:task.status,folder:folderLabel(original.folder),
      had:[...present],now:[...result]};
  });
}
async function diagnosticReport() {
  const {tasks}=await state();
  const {diagnosticLog=[]}=await api.storage.local.get({diagnosticLog:[]});
  return {
    version:api.runtime.getManifest().version,
    generated:new Date().toISOString(),
    tasks:tasks.map(t=>({id:t.id,subject:t.subject,status:t.status,due:t.due,
      folder:folderLabel(t.currentFolder||t.sourceFolder),
      tagSetupComplete:!!t.tagSetupComplete,tagError:t.tagError||null,
      tagsCleared:!!t.terminalTagClearChecked})),
    log:diagnosticLog.slice(-100)
  };
}
async function reconcileTags(limit=40) {
  const {tasks}=await state();
  for (const t of tasks.filter(t=>t.kind==="followup" && t.status==="waiting" && !t.tagSetupComplete && new Date(t.due)>new Date()).slice(0,limit)) {
    await safeTagWork(t.id,"apply");
  }
  // Wersja 0.1.9 mogła zdjąć WaitingForFBK: odbuduj znacznik dla
  // przypomnianych, nadal monitorowanych Follow-upów.
  for (const t of tasks.filter(t=>t.kind==="followup" && t.status==="reminded" && (!t.reminderTagReleased || !t.waitingAfterDueChecked)).slice(0,limit)) {
    if (!t.reminderTagReleased) await safeTagWork(t.id,"release");
    if (!t.waitingAfterDueChecked) await safeTagWork(t.id,"keepWaiting");
  }
  // Obejmuje też zakończone zadania starszych wersji, w których jeden
  // z tagów mógł istnieć jeszcze przed założeniem Follow-upu.
  for (const t of tasks.filter(t=>t.kind==="followup" &&
      ["answered","done"].includes(t.status) && !t.terminalTagClearChecked).slice(0,limit)) {
    await safeTagWork(t.id,"release");
  }
}

function normalizeDue(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid reminder date.");
  if (d.getTime() <= Date.now() - 60000) throw new Error("Due date must be in the future.");
  return d.toISOString();
}
// Reuse the SAME database record if the user selects a message with an active
// follow-up. In particular, a previously REMINDED task is armed for a new due
// date without deleting the old local reminder or touching the original email.
async function rescheduleFollowup(taskId, {due, moveAtDue, headerMessageId=null}={}) {
  const nextDue = normalizeDue(due);
  if (dueBusy.has(taskId)) throw new Error("This follow-up is being processed. Try updating it again in a moment.");
  const change = await transaction(s => {
    const task = s.tasks.find(t=>t.id===taskId && t.kind==="followup");
    if (!task) throw new Error("The existing follow-up was not found.");
    if (headerMessageId && cleanId(task.headerMessageId)!==cleanId(headerMessageId))
      throw new Error("The selected message does not match this follow-up.");
    if (!ANSWER_TRACKING_STATES.has(task.status))
      throw new Error("Only active follow-ups can be rescheduled.");
    if (task.status==="processing" || dueBusy.has(task.id))
      throw new Error("This follow-up is being processed. Try updating it again in a moment.");
    const previousStatus=task.status, previousDue=task.due;
    const wasReminded=previousStatus==="reminded" || previousStatus==="error";
    task.due=nextDue;
    task.moveAtDue=moveAtDue===undefined ? !!task.moveAtDue : !!moveAtDue;
    task.status="waiting";
    task.lastError=null;
    task.processingSince=null;
    task.updatedAt=Date.now();
    task.rescheduledAt=Date.now();
    task.rescheduleCount=(task.rescheduleCount||0)+1;
    if (wasReminded) {
      // A new unique local reminder will be imported only at the NEW due date.
      // Old reminders are preserved as mail history (no messages are deleted).
      task.reminderHeaderId=`local-${task.id.replace(/[^a-z0-9]/gi,"")}-r${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}@followup.invalid`;
      task.reminderId=null;
      task.reminderTagReleased=false;
      task.waitingAfterDueChecked=false;
      task.tagSetupComplete=false;
    }
    return {id:task.id,previousStatus,previousDue};
  });
  const live=await findTask(taskId);
  // Restore reminder + WaitingForFBK on a postponed REMINDED task;
  // tag failure never rolls back the already saved date.
  if (!live.tagSetupComplete) await safeTagWork(taskId,"apply");
  const saved=await findTask(taskId);
  writeLog("Rescheduled follow-up", saved.subject, change.previousStatus,
    change.previousDue, "->", saved.due, saved.id);
  return {...saved,rescheduled:true,previousStatus:change.previousStatus,previousDue:change.previousDue};
}

async function createTask({kind, due, moveAtDue, message, headerMessageId, subject, author, recipients, sourceFolder, accountId}) {
  if (!["snooze", "followup"].includes(kind)) throw new Error("Invalid task type.");
  const m = message || null;
  const mid = plainId(m?.headerMessageId || headerMessageId);
  if (!mid) throw new Error("Message-ID header is missing; the message cannot be reliably tracked after moving.");
  const f = m?.folder || sourceFolder || null;
  if (f && !(await isLocalFolder(f))) throw new Error("Only Local Folders messages are supported.");
  const local = await findLocal();
  if (accountId && accountId !== local.id) throw new Error("Message is not in Local Folders.");
  const knownIdentities = (await api.accounts.list(false))
    .flatMap(a => a.identities || []).flatMap(x => addresses(x.email || ""));
  const task = {
    id:uniqueTaskId(),kind,headerMessageId:mid,ownAddresses:[...new Set(knownIdentities)],
    subject:m?.subject || subject || "(bez tematu)",
    author:m?.author || author || "", recipients:m?.recipients || recipients || [],
    createdAt:Date.now(), due:normalizeDue(due), status:"waiting", moveAtDue:moveAtDue === undefined ? true : !!moveAtDue,
    sourceFolder:asFolder(f), currentFolder:asFolder(f), dueOriginFolder:null, movedByUs:false,
    reminderHeaderId:null, reply:null, lastError:null, updatedAt:Date.now(),
    managedTagKeys:[],tagSetupComplete:false,tagError:null,
    lastKnownInternalId:Number.isSafeInteger(m?.id)?m.id:null
  };
  task.reminderHeaderId = `local-${task.id.replace(/[^a-z0-9]/gi, "")}@followup.invalid`;
  await transaction(s => {
    const existing = s.tasks.find(t => t.kind === kind &&
      cleanId(t.headerMessageId) === cleanId(mid) &&
      ANSWER_TRACKING_STATES.has(t.status));
    if (existing) {
      writeLog("Duplicate follow-up",existing.subject,existing.status,existing.id);
      throw new Error("This message already has an active follow-up ("+existing.status+"). No duplicate was created. Open the toolbar list or diagnostics.");
    }
    s.tasks.unshift(task);
    return null;
  });
  if (task.kind === "followup") await safeTagWork(task.id,"apply",m?.id||null);
  const created=await findTask(task.id);
  if (created.tagError) writeLog("Tag error after creation",created.subject,created.tagError);
  writeLog("Added",task.kind,task.subject,task.due,task.id);
  return created;
}
async function openTask(taskId) {
  const task = await findTask(taskId);
  if (!task) throw new Error("Task not found.");
  const msg = await locate(task);
  if (!msg) throw new Error("Original not found. Check whether the message was deleted.");
  await patchTask(task.id, {currentFolder:asFolder(msg.folder)});
  // Prefer opening the actual folder and highlighting this exact message.
  const tabs = await api.mailTabs.query({});
  const preferred = tabs.find(t => t.active) || tabs[0];
  if (preferred) {
    try {
      await api.mailTabs.setSelectedMessages(preferred.id,[msg.id]);
      await api.tabs.update(preferred.id,{active:true});
      if (preferred.windowId && api.windows?.update) {
        try { await api.windows.update(preferred.windowId,{focused:true}); }catch(_){}
      }
      return {folder:folderLabel(msg.folder),selected:true};
    } catch (e) { writeLog("mailTabs selection failed, fallback to tab",String(e)); }
  }
  await api.messageDisplay.open({messageId:msg.id,location:"tab",active:true});
  return {folder:folderLabel(msg.folder),selected:false};
}

function headerList(full, name) {
  const o = full?.headers || {};
  const v = Object.entries(o).filter(([k]) => k.toLowerCase() === name.toLowerCase())
    .flatMap(([,value]) => Array.isArray(value) ? value : [value]);
  return v.join(" ");
}
function isReplyTo(full, targetId) {
  const raw = headerList(full, "references") + " " + headerList(full, "in-reply-to");
  const ids = [...raw.matchAll(/<([^<>\s]+)>/g)].map(m => cleanId(m[1]));
  if (ids.includes(cleanId(targetId))) return true;
  return raw.split(/[\s,]+/).some(x => cleanId(x) === cleanId(targetId));
}
function isSelfReminder(full, message=null) {
  // Even if an imported local .eml has lost a custom X- header in the index,
  // never treat our synthetic message as a human response.
  return Boolean(headerList(full, "x-local-followup-reminder")) ||
    /@followup\.invalid$/i.test(plainId(message?.headerMessageId)) ||
    /local-reminder@followup\.invalid/i.test(message?.author || "");
}
function addresses(s) {
  const value = Array.isArray(s) ? s.join(" ") : String(s || "");
  return (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(x => x.toLowerCase());
}
function selfOnlyConversation(task) {
  // A user testing mail->mail from the same identity should have their
  // own reply detected. This exception must NOT apply to a mail sent to
  // a real customer, as another outgoing follow-up is not their answer.
  const own = new Set(task.ownAddresses || []);
  const author = addresses(task.author);
  const recipients = addresses(task.recipients);
  return author.length > 0 && recipients.length > 0 &&
    author.every(x => own.has(x)) && recipients.every(x => own.has(x));
}
function ownReplyBlocked(task, message) {
  if (task.allowSelfReplies || selfOnlyConversation(task)) return false;
  const own = new Set(task.ownAddresses || []);
  return addresses(message.author).some(x => own.has(x));
}
const ANSWER_LEEWAY_MS = 120000;
function candidateReason(task, message, full) {
  if (cleanId(task.headerMessageId) === cleanId(message.headerMessageId)) return "original";
  if (isSelfReminder(full,message)) return "synthetic";
  if (!isReplyTo(full, task.headerMessageId)) return "no-references";
  // A message already present before the reminder was created cannot
  // satisfy an 'await response' task, even if Thunderbird threads it.
  if (new Date(message.date).getTime() < task.createdAt - ANSWER_LEEWAY_MS) return "old-date";
  if (ownReplyBlocked(task,message)) return "own-address";
  return "accepted";
}
async function registerReply(task, message, via) {
  // Zmiana statusu jest atomowa, bo skan po uruchomieniu i zdarzenie nowej
  // poczty mogą jednocześnie zobaczyć tę samą odpowiedź.
  const changed = await transaction(s => {
    const live = s.tasks.find(t => t.id === task.id);
    if (!live || !ANSWER_TRACKING_STATES.has(live.status)) return false;
    Object.assign(live, {status:"answered",
      reply:{headerMessageId:message.headerMessageId,receivedAt:new Date(message.date).toISOString(),via},
      lastError:null, updatedAt:Date.now()});
    return true;
  });
  if (!changed) return false;
  await safeTagWork(task.id,"release");
  writeLog("Reply detected",task.subject,"via",via);
  await notifyTask(task, "answered");
  return true;
}
async function observeMessages(messages) {
  const pending = (await state()).tasks.filter(t => t.kind === "followup" && ANSWER_TRACKING_STATES.has(t.status));
  if (!pending.length) return;
  for (const message of messages) {
    if (!message?.id || !message.headerMessageId) continue;
    try {
      const full = await api.messages.getFull(message.id);
      if (isSelfReminder(full,message)) continue;
      for (const task of pending) {
        if (candidateReason(task,message,full) === "accepted") {
          const latest = await findTask(task.id);
          if (latest && ANSWER_TRACKING_STATES.has(latest.status)) await registerReply(task,message,"new-message");
        }
      }
    } catch (e) {writeError("Incoming message analysis",e);}
  }
}
function strippedSubject(subject) {
  return String(subject || "").replace(/^\s*((re|fw|fwd|odp|sv)\s*:\s*)+/gi, "").trim();
}
async function inspectReplies(task, {apply=false, max=400}={}) {
  if (task.kind !== "followup") throw new Error("Reply diagnostics are available for follow-ups only.");
  const counts={original:0,synthetic:0,"no-references":0,"old-date":0,"own-address":0,accepted:0,unreadable:0};
  const examples=[];
  const local=await findLocal();
  const subject=strippedSubject(task.subject);
  if (subject.length < 3) return {counts, scanned:0, truncated:false, examples, matched:false, note:"Subject too short to search safely for replies."};
  // Crucial: do NOT require fromDate here. Some stored emails have an
  // unexpected Date header or were moved into Local Folders much later.
  // The date can be evaluated per candidate and explained to the user.
  const candidates=await queryAll({accountId:local.id,subject},max);
  // Prefer chronological order so the earliest matching response closes
  // the task. This also makes the diagnosis deterministic.
  candidates.sort((a,b)=>new Date(a.date)-new Date(b.date));
  let selected=null;
  for (const m of candidates) {
    if (!m.headerMessageId) continue;
    if (cleanId(m.headerMessageId)===cleanId(task.headerMessageId)) {
      counts.original++;continue;
    }
    try {
      const full=await api.messages.getFull(m.id);
      const reason=candidateReason(task,m,full);
      counts[reason]++;
      if (reason!=="no-references" || examples.filter(x=>x.reason==="no-references").length<2) {
        if(examples.length<12)examples.push({subject:m.subject,date:new Date(m.date).toISOString(),author:m.author,reason});
      }
      if (reason==="accepted" && !selected) selected=m;
    } catch(e) { counts.unreadable++;if(examples.length<12)examples.push({subject:m.subject,reason:"unreadable",error:String(e)}); }
  }
  if (apply && selected && ANSWER_TRACKING_STATES.has((await findTask(task.id))?.status)) await registerReply(task,selected,"recheck");
  return {counts,scanned:candidates.length,truncated:candidates.length>=max,examples,matched:Boolean(selected),
    ownOnly:selfOnlyConversation(task),allowSelfReplies:!!task.allowSelfReplies};
}
async function recheckReply(t) {
  if(t.kind!=="followup" || !ANSWER_TRACKING_STATES.has(t.status))return false;
  const report=await inspectReplies(t,{apply:true});
  return report.matched;
}
async function scanReplies(limit=30) {
  const tasks=(await state()).tasks.filter(t=>t.kind==="followup" && ANSWER_TRACKING_STATES.has(t.status))
    .sort((a,b)=>new Date(a.due)-new Date(b.due)).slice(0,limit);
  let answered=0,errors=0;
  for(const task of tasks){
    try{if(await recheckReply(task))answered++;}
    catch(e){errors++;writeError("Kontrola odpowiedzi",task.subject,e);}
  }
  return {checked:tasks.length,answered,errors};
}

function base64Utf8(value) {
  const bytes=new TextEncoder().encode(value);let s="";
  for (const b of bytes) s+=String.fromCharCode(b);
  return btoa(s).replace(/.{1,76}/g,"$&\r\n").trim();
}
function mimeSubject(subject) {
  // RFC 2047: keep each encoded-word below 75 characters and do not split UTF-8.
  const chunks=[]; let part="", size=0;
  for (const letter of String(subject).replace(/[\r\n]/g," ")) {
    const bytes=new TextEncoder().encode(letter).length;
    if (size+bytes>42 && part) {chunks.push(part);part="";size=0;}
    part+=letter;size+=bytes;
  }
  if(part) chunks.push(part);
  return chunks.map(c=>`=?UTF-8?B?${base64Utf8(c).replace(/\s+/g,"")}?=`).join("\r\n ");
}
function produceReminder(task, origin) {
  const date = new Date().toUTCString();
  const title = task.kind === "followup" ? "FOLLOW-UP REQUIRED" : "SNOOZE REMINDER";
  const originalId = plainId(task.headerMessageId);
  const body = [
    title,"","Original folder: " + (origin || "unknown"),
    "Original message: " + task.subject,
    "Follow-up task ID: " + task.id,
    "","Open the Follow-up Local panel and select this task to jump to the original message.",
    "When finished, choose Finish (optionally restoring the original folder).",
    "","THIS MESSAGE IS LOCAL ONLY. It was not sent to the recipient."
  ].join("\r\n");
  const lines = [
    "From: \"Local Follow-up\" <local-reminder@followup.invalid>",
    "To: \"Local Inbox\" <local-inbox@followup.invalid>",
    `Subject: ${mimeSubject("Re: " + task.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${task.reminderHeaderId}>`,
    `In-Reply-To: <${originalId}>`,
    `References: <${originalId}>`,
    "X-Local-Followup-Reminder: yes",
    `X-Local-Followup-Task: ${task.id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",base64Utf8(body),""
  ];
  return new File([lines.join("\r\n")],"reminder.eml",{type:"message/rfc822"});
}
async function findExistingReminder(t) {
  const list = await queryAll({headerMessageId:t.reminderHeaderId},20);
  return list.find(m=>cleanId(m.headerMessageId)===cleanId(t.reminderHeaderId));
}
// Verify by the stable RFC Message-ID and the TARGET folder, never by a stale
// numeric Thunderbird message id. A folder move can finish before the index is
// immediately searchable, so retry briefly. Never create a reminder if a required
// move cannot be confirmed.
async function locateInFolder(headerMessageId, targetFolder, retries = 8) {
  const id = plainId(headerMessageId);
  for (let attempt = 0; attempt < retries; attempt++) {
    const hits = (await queryAll({headerMessageId:id}, 80))
      .filter(m => cleanId(m.headerMessageId) === cleanId(id) &&
                    folderKey(m.folder) === folderKey(targetFolder));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error("Multiple copies in Inbox; cannot choose one automatically.");
    if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function moveOriginalToInbox(taskId) {
  let task = await findTask(taskId);
  if (!task) throw new Error("Task does not exist.");
  if (["answered","done"].includes(task.status)) throw new Error("Task is already closed.");
  const target = await inbox();
  const original = await locate(task);
  if (!original) throw new Error("Original not found by Message-ID. Nothing was moved.");
  if (folderKey(original.folder) === folderKey(target)) {
    await patchTask(task.id, {currentFolder:asFolder(target),
      // Recovery: a previous move might have succeeded just before a restart.
      movedByUs:!!(task.movedByUs || task.movePending),movePending:false,lastError:null});
    return {moved:false,alreadyInbox:true,folder:folderLabel(target)};
  }
  // On manual moves after the reminder, dueOriginFolder was recorded at due time.
  // If no reminder fired yet, remember the folder where the message lives NOW.
  if (!task.dueOriginFolder) {
    task = await patchTask(task.id, {dueOriginFolder:asFolder(original.folder)});
  }
  // Save the intent before moving: an interrupted operation must never silently
  // lose the fact that this original may need returning to its prior folder.
  await patchTask(task.id, {movePending:true});
  await api.messages.move([original.id], target);
  const moved = await locateInFolder(task.headerMessageId, target);
  if (!moved) {
    throw new Error("Move was requested but the original could not be verified in Inbox. Check folders; no duplicate reminder was created.");
  }
  await patchTask(task.id, {currentFolder:asFolder(target),movedByUs:true,movePending:false,lastError:null});
  writeLog("Original in Local Folders Inbox",task.subject,"from",folderLabel(original.folder));
  return {moved:true,folder:folderLabel(target),originalFolder:folderLabel(original.folder)};
}

async function processDueTask(taskId) {
  if (dueBusy.has(taskId)) return;
  dueBusy.add(taskId);
  try {
    let task = await findTask(taskId);
    if (!task || !["waiting","processing"].includes(task.status) || new Date(task.due).getTime() > Date.now()) return;
    if (task.status === "processing" && Date.now() - (task.processingSince||0) < 120000) return;
    if (await recheckReply(task)) return;
    task = await patchTask(task.id,{status:"processing",processingSince:Date.now(),lastError:null});
    let msg = await locate(task);
    if (!msg) throw new Error("Original not found after moving. No reminder was created and no copy was made.");
    // Capture current location even if Nostalgy moved this message after setting the task.
    if (!task.dueOriginFolder) task = await patchTask(task.id,{dueOriginFolder:asFolder(msg.folder)});
    if (task.moveAtDue) {
      // Must succeed BEFORE importing the new reminder: this guarantees that
      // the original and our local reply can actually share the Inbox thread.
      await moveOriginalToInbox(task.id);
      msg = await locateInFolder(task.headerMessageId, await inbox());
      if (!msg) throw new Error("Monitored message not found in Inbox; reminder was cancelled.");
    }
    await patchTask(task.id,{currentFolder:asFolder(msg.folder)});
    // If a reply arrived while a move was in progress, do not generate a reminder.
    if((await findTask(task.id)).status === "answered") return;
    let reminder = await findExistingReminder(task);
    if (!reminder) {
      const localInbox = await inbox();
      const origin = folderLabel(task.dueOriginFolder || msg.folder);
      reminder = await api.messages.import(produceReminder(task, origin),localInbox,{read:false,new:true});
    }
    // Nie nadpisuj statusu "answered", jeśli odpowiedź przyszła podczas MOVE/importu.
    const changed = await transaction(s => {
      const live = s.tasks.find(t => t.id === task.id);
      if (!live || !["waiting", "processing"].includes(live.status)) return false;
      Object.assign(live, {status:"reminded",reminderId:reminder?.id||null,
        lastError:null,updatedAt:Date.now()});
      return true;
    });
    if (changed) {
      await safeTagWork(task.id,"release"); // zdejmij reminder, zachowaj WaitingForFBK
      if (task.kind === "followup") await safeTagWork(task.id,"keepWaiting");
      writeLog("Saved local reminder",task.subject);
      await notifyTask(task, "due");
    }
  } catch(e) {
    writeError("Reminder processing",taskId,e);
    try {await patchTask(taskId,{status:"error",lastError:String(e)});}catch(_){}
  } finally {dueBusy.delete(taskId);}
}
async function tick() {
  const {tasks} = await state();
  for (const t of tasks) if (["waiting","processing"].includes(t.status) && new Date(t.due).getTime() <= Date.now()) await processDueTask(t.id);
  // Ewentualne przerwanie MOVE może opóźnić zmianę tagów.
  // Przy statusie reminded WaitingForFBK ma pozostać; wcześniejsze 0.1.9
  // przywróci go jednorazowa migracja poniżej.
  await reconcileTags(15);
}
async function finish(taskId, returnToOriginal=false) {
  let t=await findTask(taskId);
  if(!t) throw new Error("Task not found.");
  if (returnToOriginal && t.movedByUs && (t.dueOriginFolder || t.sourceFolder)) {
    const msg=await locate(t);
    if(!msg) throw new Error("Original missing; cannot move it back.");
    const target = await api.folders.get(t.dueOriginFolder || t.sourceFolder);
    if(!target) throw new Error("The previous folder no longer exists.");
    const inboxFolder = await inbox();
    if(folderKey(msg.folder)!==folderKey(inboxFolder)) throw new Error("Message was manually moved out of Inbox; no changes made.");
    await api.messages.move([msg.id],target);
    await patchTask(taskId,{currentFolder:asFolder(target),movedByUs:false,movePending:false});
  }
  const done = await patchTask(taskId,{status:"done",lastError:null});
  await safeTagWork(taskId,"release");
  return done;
}
async function retry(taskId) {await patchTask(taskId,{status:"waiting",lastError:null}); await tick(); return true;}

// Toolbar shows list + creation; message right click shows ONLY creation.
// Capture the exact message *before* changing focus.
async function snapshotMessage(tab) {
  if (!tab?.id) return null;
  try {
    const list = await api.mailTabs.getSelectedMessages(tab.id);
    if (list?.messages?.length === 1) return list.messages[0];
    if (list?.messages?.length > 1) return {multiple:true};
  } catch (e) { writeLog("No mail tab selection:",String(e)); }
  try { return await api.messageDisplay.getDisplayedMessage(tab.id); }
  catch (_) { return null; }
}
// One extension panel window at a time. Checking the actual popup URLs also
// recovers an existing window after a background-script restart.
let followupPanelWindowId = null;
let followupPanelQueue = Promise.resolve();
function panelAddress({messageId=null,kind="followup",multiple=false,focusCreate=false,onlyCreate=false}={}) {
  const q = new URLSearchParams({kind});
  if (Number.isSafeInteger(messageId) && messageId > 0) q.set("messageId",String(messageId));
  if (multiple) q.set("multiple","1");
  if (focusCreate) q.set("create","1");
  if (onlyCreate) q.set("onlyCreate","1");
  return api.runtime.getURL("panel.html?"+q.toString());
}
async function openOrFocusPanel(options) {
  const opts = {messageId:null,kind:"followup",multiple:false,focusCreate:false,onlyCreate:false,...options};
  const panelBase = api.runtime.getURL("panel.html");
  const windows = await api.windows.getAll({populate:true,windowTypes:["popup"]});
  const matches = windows.map(w=>({
    window:w,
    tab:(w.tabs||[]).find(t=>typeof t.url==="string" &&
      (t.url===panelBase || t.url.startsWith(panelBase+"?")))
  })).filter(item=>item.tab || item.window.id===followupPanelWindowId);
  const active = matches.find(item=>item.window.id===followupPanelWindowId) || matches[0];
  if (active) {
    const w = active.window;
    try {
      const existingUrl = active.tab?.url || "";
      const existingArgs = existingUrl ? new URL(existingUrl).searchParams : new URLSearchParams();
      const existingQuick = existingArgs.get("onlyCreate")==="1";
      // Toolbar always gets the complete list. A quick-create form is changed
      // into the full panel IN THE SAME WINDOW, never duplicated.
      const switchToFull = existingQuick && !opts.onlyCreate;
      // If the user right-clicks another message, do not keep the stale
      // messageId from the previously opened form.
      const changedSelection = Number.isSafeInteger(opts.messageId) && opts.messageId>0 &&
        existingArgs.get("messageId") !== String(opts.messageId);
      if (active.tab && (switchToFull || changedSelection)) {
        const target = panelAddress({...opts,onlyCreate:existingQuick && !switchToFull});
        await api.tabs.update(active.tab.id,{url:target});
      }
      if (switchToFull) await api.windows.update(w.id,{width:1120,height:880});
      if (w.state==="minimized") await api.windows.update(w.id,{state:"normal"});
      await api.windows.update(w.id,{focused:true});
      followupPanelWindowId=w.id;
      writeLog("Focused existing Follow-up panel",{id:w.id,switchedToFull:switchToFull,updatedSelection:changedSelection});
      return w;
    } catch(error) {
      // Do not create a second window when an existing one still exists but
      // its navigation/focus failed. Only recreate after it was truly closed.
      try {await api.windows.get(w.id);throw error;}
      catch(checkError) {if(checkError===error)throw error;}
      followupPanelWindowId=null;
    }
  }
  const w = await api.windows.create({
    url:panelAddress(opts),type:"popup",
    width:opts.onlyCreate ? 715 : 1120,height:opts.onlyCreate ? 575 : 880
  });
  followupPanelWindowId=w.id;
  writeLog("Opened task panel",{id:w.id,messageId:opts.messageId,kind:opts.kind});
  return w;
}
function openPanel(options={}) {
  // Rapid toolbar/context clicks must not pass the 'does a window exist?'
  // test concurrently and each create another panel.
  const next=followupPanelQueue.catch(()=>{}).then(()=>openOrFocusPanel(options));
  followupPanelQueue=next.then(()=>{},()=>{});
  return next;
}
api.windows.onRemoved.addListener(windowId=>{
  if (followupPanelWindowId===windowId) followupPanelWindowId=null;
});
api.browserAction.onClicked.addListener(tab=>{
  (async()=>{
    const selected = await snapshotMessage(tab);
    await openPanel({messageId:selected?.id||null,multiple:!!selected?.multiple});
  })().catch(e=>writeError("Toolbar panel:",e));
});
try {
  api.menus.create({id:"sf-followup",title:"Set follow-up…",contexts:["message_list"]});
} catch(e) { writeError("Menu initialization",e); }
api.menus.onClicked.addListener((info,tab)=>{
  (async()=>{
    if(info.menuItemId !== "sf-followup")return;
    const list = info.selectedMessages?.messages || [];
    let selected = null;
    if (list.length === 1) selected=list[0];
    else if (list.length === 0) selected=await snapshotMessage(tab);
    await openPanel({messageId:selected?.id||null,multiple:list.length>1||!!selected?.multiple,
      kind:"followup",focusCreate:true,onlyCreate:true});
  })().catch(e=>writeError("Context menu:",e));
});

async function getSelection() {
  const active = (await api.tabs.query({active:true,currentWindow:true}))[0];
  if (active) {
    try {
      const msgs = await api.mailTabs.getSelectedMessages(active.id);
      if (msgs?.messages?.length===1) return msgs.messages[0];
      if (msgs?.messages?.length>1) throw new Error("Select exactly one message.");
    } catch(e) { if (String(e).includes("Select exactly one message") || String(e).includes("tylko jedną")) throw e; }
    try {const m = await api.messageDisplay.getDisplayedMessage(active.id);if(m) return m;}catch(_){}
  }
  const mailTabs = await api.mailTabs.query({active:true});
  if (mailTabs[0]) {
    const page=await api.mailTabs.getSelectedMessages(mailTabs[0].id);
    if(page.messages?.length===1)return page.messages[0];
  }
  return null;
}

async function apiMessage(request) {
  switch(request.type) {
    case "getSettings": return getSettings();
    case "setSettings": return setSettings(request.settings);
    case "list": return (await state()).tasks;
    case "diagnosticReport": return diagnosticReport();
    case "repairTags": return repairTaskTags(request.id);
    case "originalCandidates": return originalCandidateList(request.id);
    case "bindOriginal": return bindOriginal(request.id,request.messageId,request.accountId,request.folderPath);
    case "repairActiveTags": {
      const tasks=(await state()).tasks.filter(t=>t.kind==="followup" && ["waiting","reminded"].includes(t.status));
      const results=[];
      for(const t of tasks.slice(0,50)) {
        try {results.push(await repairTaskTags(t.id));}
        catch(e) {
          writeError("Tag repair failed",t.subject,String(e));
          await patchTask(t.id,{tagError:String(e)});
          results.push({id:t.id,subject:t.subject,error:String(e)});
        }
      }
      return results;
    }
    case "showTasks": return openPanel();
    case "refreshLocations": {
      // Dodatkowa synchronizacja: onMoved normalnie odświeża lokalizacje,
      // ale przy otwarciu panelu porównaj z rzeczywistym folderem po Message-ID.
      // Najwyżej 30 aktywnych zadań, aby nie blokować dużej skrzynki lokalnej.
      const tasks=(await state()).tasks.filter(t=>t.status!=="done").slice(0,30);
      let changed=0,missing=0;
      for(const t of tasks){
        try{
          const original=await locate(t);
          if(!original){missing++;continue;}
          if(folderKey(original.folder)!==folderKey(t.currentFolder)){
            await patchTask(t.id,{currentFolder:asFolder(original.folder)});
            changed++;
          }
        }catch(e){writeLog("Location update",t.subject,String(e));}
      }
      return {checked:tasks.length,changed,missing};
    }
    case "selection": {
      const m = request.messageId ? await api.messages.get(request.messageId) : await getSelection();
      if (!m) return null;
      const active=(await state()).tasks.filter(t=>t.kind==="followup" &&
        ANSWER_TRACKING_STATES.has(t.status) &&
        cleanId(t.headerMessageId)===cleanId(m.headerMessageId));
      const existingTask=active.length===1 ? {
        id:active[0].id,due:active[0].due,status:active[0].status,
        moveAtDue:!!active[0].moveAtDue
      } : null;
      return {id:m.id,subject:m.subject,folder:folderLabel(m.folder),
        local:await isLocalFolder(m.folder),hasHeader:!!m.headerMessageId,
        existingTask};
    }
    case "addSelected": {
      const m = request.messageId ? await api.messages.get(request.messageId) : await getSelection();
      if(!m)throw new Error("Select one Thunderbird message or open it in its own tab.");
      const matches=(await state()).tasks.filter(t=>t.kind==="followup" &&
        ANSWER_TRACKING_STATES.has(t.status) &&
        cleanId(t.headerMessageId)===cleanId(m.headerMessageId));
      if(matches.length>1) throw new Error("More than one active follow-up has this Message-ID. Open the task list and reschedule the intended task directly.");
      if(matches.length===1) return rescheduleFollowup(matches[0].id,
        {...request,headerMessageId:m.headerMessageId});
      return createTask({...request,message:m});
    }
    case "rescheduleTask": return rescheduleFollowup(request.id,
      {due:request.due,moveAtDue:request.moveAtDue});
    case "open":return openTask(request.id);
    case "clearFinished": {
      // Queue history only. Do not touch messages, tags or active/answered tasks.
      return transaction(s => {
        const oldCount=s.tasks.length;
        s.tasks=s.tasks.filter(t=>t.status!=="done");
        return {removed:oldCount-s.tasks.length,remaining:s.tasks.length};
      });
    }
    case "finish":return finish(request.id,!!request.returnToOriginal);
    case "moveOriginalNow":return moveOriginalToInbox(request.id);
    case "setMoveAtDue": {
      const t = await findTask(request.id);
      if (!t || t.status !== "waiting") throw new Error("Move-on-due can only be changed on a waiting task.");
      return patchTask(t.id,{moveAtDue:!!request.moveAtDue,lastError:null});
    }
    case "retry":return retry(request.id);
    case "tick":await tick();return true;
    case "scanReplies":return scanReplies();
    case "replyDiagnostic": {
      const t=await findTask(request.id);
      if(!t)throw new Error("Task not found.");
      return inspectReplies(t,{apply:false});
    }
    case "acceptOwnReplies": {
      const t=await findTask(request.id);
      if(!t || t.kind!=="followup" || !ANSWER_TRACKING_STATES.has(t.status)) throw new Error("This is not an active follow-up.");
      await patchTask(t.id,{allowSelfReplies:true});
      const report=await inspectReplies(await findTask(t.id),{apply:true});
      return report;
    }
    case "markAnswered": {
      const t=await findTask(request.id);
      if(!t || t.kind!=="followup" || !ANSWER_TRACKING_STATES.has(t.status)) throw new Error("This is not an active follow-up.");
      const answered=await patchTask(t.id,{status:"answered",reply:{manual:true,receivedAt:new Date().toISOString()},lastError:null});
      await safeTagWork(t.id,"release");
      return answered;
    }
    case "diagnostic": {
      const a = await findLocal(), b = await inbox();
      return {localAccount:a.name,localAccountId:a.id,inbox:folderLabel(b),time:new Date().toString(),count:(await state()).tasks.length};
    }
    case "composePreview": {
      const tabs = await api.tabs.query({active:true,currentWindow:true});
      const tab=tabs[0];
      if(!tab)throw new Error("Compose window not found.");
      const details = await api.compose.getComposeDetails(tab.id);
      return {tabId:tab.id,subject:details.subject||"(no subject)",to:details.to||[]};
    }
    case "composeSet": {
      const tabId=request.tabId;
      await api.compose.getComposeDetails(tabId); // ensure compose window still exists
      const info = await api.compose.getComposeDetails(tabId);
      const entry={kind:request.kind,due:normalizeDue(request.due),moveAtDue:!!request.moveAtDue,
        subject:info.subject||"Sent message",recipients:info.to||[],createdAt:Date.now()};
      await transaction(s=>{s.composePending[String(tabId)]=entry;return null;});
      return entry;
    }
    case "composeClear":await transaction(s=>{delete s.composePending[String(request.tabId)];return null;});return true;
    default:throw new Error("Unknown command.");
  }
}
api.runtime.onMessage.addListener((request) => apiMessage(request));
api.alarms.onAlarm.addListener(a=>{if(a.name==="task-check")tick().catch(writeError).finally(requestToolbarAlert);});
api.messages.onNewMailReceived.addListener((_folder,list)=>{
  observeMessages(list.messages||[]).catch(writeError);
},true);
api.messages.onMoved.addListener((original,moved)=>{
  // An RFC Message-ID can have many copies. Follow only the EXACT moved
  // instance (previous internal id AND its previous folder), not every copy.
  const before=original?.messages||[],after=moved?.messages||[];
  transaction(s=>{
    for(let i=0;i<Math.min(before.length,after.length);i++) {
      const old=before[i],now=after[i];
      if(!old?.folder||!now?.folder||cleanId(old.headerMessageId)!==cleanId(now.headerMessageId))continue;
      for(const t of s.tasks) {
        if(!ANSWER_TRACKING_STATES.has(t.status))continue;
        if(cleanId(t.headerMessageId)!==cleanId(old.headerMessageId))continue;
        if(folderKey(t.currentFolder)!==folderKey(old.folder))continue;
        if(Number.isSafeInteger(t.lastKnownInternalId) && t.lastKnownInternalId!==old.id)continue;
        t.currentFolder=asFolder(now.folder);
        t.lastKnownInternalId=now.id;
        t.updatedAt=Date.now();
      }
    }
  }).catch(writeError);
});

api.compose.onAfterSend.addListener((tab,sendInfo)=>{
  (async()=>{
    const key=String(tab.id),s=await state(),pending=s.composePending[key];
    if(!pending) return;
    if(sendInfo.error || sendInfo.mode!=="sendNow") {
      writeLog("Message was not sent; pending follow-up setting retained",sendInfo.error||sendInfo.mode);return;
    }
    const h=plainId(sendInfo.headerMessageId);
    const msg=(sendInfo.messages||[]).find(m=>m.folder&&m.headerMessageId)||null;
    if(!h && !msg?.headerMessageId)throw new Error("Message sent without Message-ID; a follow-up cannot be created safely.");
    // Without a stored copy, attempt immediate lookup; task still trackable by header.
    let finalMsg=msg;
    if(!finalMsg){
      const hits=(await queryAll({headerMessageId:h},40)).filter(m=>m.folder && cleanId(m.headerMessageId)===cleanId(h));
      const localHits=[];for(const m of hits)if(await isLocalFolder(m.folder))localHits.push(m);
      // If multiple physical copies exist, do not silently bind to the first.
      if(localHits.length===1)finalMsg=localHits[0];
    }
    await createTask({...pending,message:finalMsg,headerMessageId:h,
      subject:finalMsg?.subject||pending.subject||"Sent message",recipients:finalMsg?.recipients||pending.recipients||[],
      accountId:(await findLocal()).id});
    await transaction(s=>{delete s.composePending[key];return null;});
  })().catch(e=>writeError("Post-send follow-up",e));
});
function awaitIsLocalHint(m){return !!m.folder;} // verify fully in createTask
api.tabs.onRemoved.addListener(tabId=>{
  // onAfterSend and onRemoved may fire in either order. Allow the send event to
  // process its intent before cleaning up a closed compose window.
  setTimeout(()=>transaction(s=>{delete s.composePending[String(tabId)];return null;}).catch(writeError), 30000);
});
(async()=>{
  try {
    await api.alarms.create("task-check",{periodInMinutes:1});
    await requestToolbarAlert();
    // Reconcile all active statuses, INCLUDING tasks for which a reminder
    // already fired. Do not scan more than 30 cases on startup.
    const {tasks}=await state();
    await reconcileTags();
    const checked = await scanReplies();
    writeLog("Reply check on startup", checked);
    await tick();
    writeLog("Started; tasks",tasks.length);
  } catch(e){writeError("Start",e);}
})();
