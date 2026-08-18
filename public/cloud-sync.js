(function(){
  'use strict';
  const PREFIX='pius_';
  const LOCAL_ONLY=/(password|login_grant|preview_|health_probe|_read_|_seen_|_undo|review_drafts|active_step)/i;
  const CLIENT=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()).toString();
  const versions=new Map();
  const nativeGet=Storage.prototype.getItem;
  const nativeSet=Storage.prototype.setItem;
  const nativeRemove=Storage.prototype.removeItem;
  let applying=false,ready=false,pending=Promise.resolve();

  function eligible(key){return String(key||'').startsWith(PREFIX)&&!LOCAL_ONLY.test(String(key||''))}
  function actor(){
    try{return nativeGet.call(localStorage,'pius_current_user_id')||document.documentElement.dataset.portal||'portal-user'}catch(e){return'portal-user'}
  }
  function parsed(raw){try{return JSON.parse(raw)}catch(e){return raw}}
  function encoded(value){return typeof value==='string'?value:JSON.stringify(value)}
  function setNative(key,value){applying=true;try{nativeSet.call(localStorage,key,encoded(value))}finally{applying=false}}
  function removeNative(key){applying=true;try{nativeRemove.call(localStorage,key)}finally{applying=false}}
  function headers(){return{'Content-Type':'application/json','x-portal-client':CLIENT,'x-portal-actor':actor()}}
  function notify(message,error){
    window.dispatchEvent(new CustomEvent('pius-cloud-status',{detail:{message,error:!!error}}));
    let box=document.getElementById('piusCloudNotice');
    if(!box){box=document.createElement('button');box.id='piusCloudNotice';box.type='button';box.style.cssText='position:fixed;right:16px;bottom:16px;z-index:999999;border:0;border-radius:12px;padding:12px 16px;background:#173f70;color:white;box-shadow:0 8px 24px #0003;font:600 13px system-ui;cursor:pointer';box.onclick=()=>location.reload();document.body?.appendChild(box)}
    box.textContent=message+(error?'':' — Refresh');box.style.background=error?'#a12b2b':'#173f70';box.hidden=false;
  }
  function queueSave(key,value){
    if(!ready||applying||!eligible(key))return;
    pending=pending.then(async()=>{
      const response=await fetch('/api/cloud-state/'+encodeURIComponent(key),{method:'PUT',headers:headers(),body:JSON.stringify({value:parsed(value),baseVersion:versions.get(key)||0})});
      const result=await response.json().catch(()=>({}));
      if(response.status===409){notify('Newer cloud data is available',false);return}
      if(!response.ok)throw new Error(result.error||'Cloud save failed');
      versions.set(key,Number(result.version||1));
    }).catch(error=>{console.error('[Cloud Sync]',error);notify('Cloud save failed. Your local copy is retained.',true)});
  }
  function queueDelete(key){
    if(!ready||applying||!eligible(key))return;
    pending=pending.then(()=>fetch('/api/cloud-state/'+encodeURIComponent(key),{method:'DELETE',headers:headers()})).catch(error=>{console.error('[Cloud Sync]',error);notify('Cloud delete failed.',true)});
  }

  Storage.prototype.setItem=function(key,value){nativeSet.call(this,key,value);if(this===localStorage)queueSave(String(key),String(value))};
  Storage.prototype.removeItem=function(key){nativeRemove.call(this,key);if(this===localStorage)queueDelete(String(key))};

  // Synchronous bootstrap is deliberate: existing inline portal scripts read
  // localStorage while the HTML is parsing, so cloud state must arrive first.
  try{
    const xhr=new XMLHttpRequest();xhr.open('GET','/api/cloud-state',false);xhr.setRequestHeader('Cache-Control','no-store');xhr.send();
    if(xhr.status>=200&&xhr.status<300){
      const response=JSON.parse(xhr.responseText||'{}');
      const cloudKeys=new Set();
      Object.entries(response.records||{}).forEach(([key,row])=>{if(eligible(key)){cloudKeys.add(key);setNative(key,row.value);versions.set(key,Number(row.version||1))}});
      ready=true;window.PIUS_CLOUD_READY=true;
      // The Principal portal may seed keys that pre-date this migration. Once
      // a key exists in Supabase, the cloud copy always wins on every device.
      if(/principal\.html$/i.test(location.pathname)){
        for(let i=0;i<localStorage.length;i++){
          const key=localStorage.key(i);if(eligible(key)&&!cloudKeys.has(key))queueSave(key,nativeGet.call(localStorage,key));
        }
      }
    }else{ready=true;window.PIUS_CLOUD_READY=false;console.error('[Cloud Sync] bootstrap returned',xhr.status)}
  }catch(error){ready=true;window.PIUS_CLOUD_READY=false;console.error('[Cloud Sync] bootstrap failed',error)}

  window.addEventListener('pius-cloud-message',event=>{
    const data=event.detail||{},payload=data.payload||{};
    if(payload.source===CLIENT||!eligible(payload.key))return;
    if(data.type==='CLOUD_STATE_UPDATED'){
      setNative(payload.key,payload.value);versions.set(payload.key,Number(payload.version||1));notify('New cloud data is available',false);
    }else if(data.type==='CLOUD_STATE_DELETED'){
      removeNative(payload.key);versions.delete(payload.key);notify('Cloud data was updated',false);
    }
  });
  try{
    const protocol=location.protocol==='https:'?'wss:':'ws:';
    const socket=new WebSocket(protocol+'//'+location.host);
    socket.addEventListener('message',event=>{
      try{const data=JSON.parse(event.data);if(data.type==='CLOUD_STATE_UPDATED'||data.type==='CLOUD_STATE_DELETED')window.dispatchEvent(new CustomEvent('pius-cloud-message',{detail:data}))}catch(ignore){}
    });
  }catch(error){console.error('[Cloud Sync] live channel failed',error)}
  window.PIUS_CLOUD_SYNC={clientId:CLIENT,isReady:()=>!!window.PIUS_CLOUD_READY,flush:()=>pending};
})();
