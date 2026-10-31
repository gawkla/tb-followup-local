'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
const start=new Date('2026-10-30T07:15:00Z').toISOString();
const future=()=>new Date(Date.now()+7*86400000).toISOString();
const f={accountId:'local1',path:'/Inbox',name:'Inbox'};
const mail={id:1001,headerMessageId:'example-id@mail.test',subject:'Test followup',folder:f,tags:['fu_waitingforfbk'],recipients:['you@example.com'],author:'me@example.com',date:new Date()};
const base={id:'original-id',kind:'followup',headerMessageId:mail.headerMessageId,subject:mail.subject,
 due:start,status:'reminded',moveAtDue:true,currentFolder:f,sourceFolder:f,
 lastKnownInternalId:1001,reminderId:2001,reminderHeaderId:'local-original-id@followup.invalid',
 reminderTagReleased:true,waitingAfterDueChecked:true,tagSetupComplete:true,
 managedTagKeys:['fu_waitingforfbk'],ownAddresses:[],author:mail.author,recipients:mail.recipients,createdAt:Date.now()-4*86400000};
let store={tasks:[{...base}],composePending:{}};
const calls=[];
const ev=()=>({addListener(){}});
const api={
 storage:{local:{async get(k){if(typeof k==='string')return {[k]:store[k]}; if(Array.isArray(k))return Object.fromEntries(k.map(x=>[x,store[x]]));return {...k,...store};},async set(v){Object.assign(store,v);calls.push(['storage.set',Object.keys(v)]);}},onChanged:ev()},
 accounts:{async list(){return [{id:'local1',type:'none',rootFolder:{subFolders:[f]},identities:[]}]},async get(){return {id:'local1',type:'none'}}},
 messages:{async get(){return mail},async query(q){if(q.headerMessageId===mail.headerMessageId)return {messages:[mail]};return {messages:[]}},async update(id,obj){assert.equal(id,1001);mail.tags=obj.tags;calls.push(['tags.updated',obj.tags]);},tags:{async list(){return [{key:'fu_reminder',tag:'reminder'},{key:'fu_waitingforfbk',tag:'WaitingForFBK'}]}},onNewMailReceived:ev(),onMoved:ev()},
 runtime:{getManifest(){return {version:'0.1.26'}},getURL(path){return 'moz-extension://abc/'+path},onMessage:ev()},
 browserAction:{async setIcon(){},async setBadgeBackgroundColor(){},async setBadgeText(){},async setTitle(){},onClicked:ev()},
 alarms:{async create(){},onAlarm:ev()},
 notifications:{onClicked:ev()},
 windows:{onRemoved:ev()},
 menus:{create(){},onClicked:ev()},
 compose:{onAfterSend:ev()},
 tabs:{onRemoved:ev()}
};
const ctx=vm.createContext({messenger:api,console,Date,Set,Map,URLSearchParams,Math, setTimeout(){},setInterval(){},File:class {}, crypto:undefined});
vm.runInContext(source,ctx);
const call=(name,...args)=>vm.runInContext(name,ctx)(...args);
(async()=>{
 await new Promise(r=>setImmediate(r));
 const initial=store.tasks[0];
 const beforeReminderHeader=initial.reminderHeaderId;
 const newDue=future();
 const preview=await call('apiMessage',{type:'selection',messageId:1001});
 assert.equal(preview.existingTask.status,'reminded');
 assert.equal(preview.existingTask.id,'original-id');
 let updated=await call('apiMessage',{type:'addSelected',messageId:1001,kind:'followup',due:newDue,moveAtDue:false});
 assert.equal(store.tasks.length,1,'reused same task');
 assert.equal(updated.rescheduled,true);
 assert.equal(updated.status,'waiting');
 assert.equal(updated.id,'original-id');
 assert.equal(updated.due,newDue);
 assert.equal(updated.moveAtDue,false);
 assert.notEqual(updated.reminderHeaderId,beforeReminderHeader,'new reminder MIME id reserved for next due');
 assert.equal(mail.tags.includes('fu_reminder'),true,'reminder tag rearmed');
 assert.equal(mail.tags.includes('fu_waitingforfbk'),true,'WaitingForFBK preserved');
 assert.equal(calls.some(c=>c[0]==='messages.import'),false,'no new reminder on update');
 const nextDue=new Date(Date.now()+3*86400000).toISOString();
 updated=await call('apiMessage',{type:'rescheduleTask',id:'original-id',due:nextDue,moveAtDue:true});
 assert.equal(store.tasks.length,1);assert.equal(updated.due,nextDue);assert.equal(updated.status,'waiting');
 const headerAfter=updated.reminderHeaderId;
 assert.equal(headerAfter,store.tasks[0].reminderHeaderId,'waiting reschedules keep pending reminder id');
 // A processing task cannot be mutated; this prevents collisions with due processing.
 store.tasks[0].status='processing';
 await assert.rejects(()=>call('apiMessage',{type:'rescheduleTask',id:'original-id',due:future()}),/being processed/);
 store.tasks[0].status='answered';
 await assert.rejects(()=>call('apiMessage',{type:'rescheduleTask',id:'original-id',due:future()}),/Only active/);
 console.log('PASS: selected message recognizes existing follow-up; REMINDED -> WAITING, same ID, tags restored; queue reschedule; no extra reminder at rescheduling; processing and answered protected.');
})().catch(e=>{console.error(e);process.exitCode=1});
