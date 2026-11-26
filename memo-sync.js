// Private note synchronization. Uses the SAME Firebase Auth user as cloud-sync.js.
// Notes never enter the public questions.json file.
import { getApps } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocs, onSnapshot, runTransaction,
  setDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const KEY_PENDING='work-flashcards-notes-pending-v1:';
const KEY_CACHE='work-flashcards-notes-cache-v1:';
const validId=id=>/^[A-Za-z0-9_-]{1,64}$/.test(String(id));
const validText=text=>typeof text==='string'&&text.length<=2000;
const safeRead=key=>{try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}};
const safeWrite=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true}catch{return false}};
function cleanNotes(obj){
  const res={};
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return res;
  for(const [id,text] of Object.entries(obj))if(validId(id)&&validText(text)&&text)res[id]=text;
  return res;
}
function cleanPending(obj){
  const res={};
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return res;
  for(const [id,v] of Object.entries(obj)){
    if(validId(id)&&v&&validText(v.text)&&validId(v.revision))res[id]={text:v.text,revision:v.revision};
  }
  return res;
}

export function createMemoSync(listeners){
  const app=getApps().find(x=>x.name==='work-flashcards-sync');
  if(!app)throw Error('Firebase認証がまだ初期化されていません');
  const auth=getAuth(app),db=getFirestore(app);
  let user=null,unsubNotes=null,remoteNotes={},cachedNotes={},pending={},loaded=false;
  let flushing=false,flushTimer=null;
  const notifyStatus=(msg,error=false)=>listeners.onStatus(msg,error);
  const noteCol=()=>collection(db,'workUsers',user.uid,'notes');
  const combined=()=>{
    const notes=loaded?{...remoteNotes}:{...cachedNotes};
    for(const [id,v] of Object.entries(pending)){
      if(v.text)notes[id]=v.text;else delete notes[id];
    }
    return notes;
  };
  const emit=()=>{
    if(!user)return;
    const notes=combined();
    cachedNotes=notes;
    safeWrite(KEY_CACHE+user.uid,notes);
    listeners.onNotes({...notes},Object.keys(pending).length,loaded);
  };
  const storePending=()=>user&&safeWrite(KEY_PENDING+user.uid,pending);
  const schedule=()=>{
    if(flushTimer)clearTimeout(flushTimer);
    flushTimer=setTimeout(()=>{flushTimer=null;void flush()},700);
  };
  async function flush(){
    if(flushing||!user||!loaded||!navigator.onLine)return;
    flushing=true;
    const uid=user.uid;
    try{
      while(user?.uid===uid){
        const next=Object.entries(pending)[0];if(!next)break;
        const [cardId,v]=next;
        await setDoc(doc(db,'workUsers',uid,'notes',cardId),{text:v.text,updatedAt:serverTimestamp()});
        if(user?.uid!==uid)break;
        // If edited again during the request, preserve the newer draft.
        if(pending[cardId]?.revision===v.revision){
          remoteNotes[cardId]=v.text;
          delete pending[cardId];
          storePending();
          emit();
        }
      }
      if(user?.uid===uid)notifyStatus(Object.keys(pending).length?'メモを同期中':'✓ メモはクラウドに同期済み');
    }catch(err){
      notifyStatus('メモは端末に保存済み・クラウドへの送信待ち：'+(err.code||err.message),true);
    }finally{flushing=false}
  }
  const online=()=>void flush();
  const visible=()=>{if(!document.hidden)void flush()};
  window.addEventListener('online',online);
  document.addEventListener('visibilitychange',visible);
  onAuthStateChanged(auth,next=>{
    if(unsubNotes){unsubNotes();unsubNotes=null}
    if(flushTimer){clearTimeout(flushTimer);flushTimer=null}
    user=next;loaded=false;remoteNotes={};cachedNotes={};pending={};
    listeners.onUser(next?{uid:next.uid,email:next.email}:null);
    if(!next){notifyStatus('端末内のみのメモです（ログインすると同期できます）');return}
    const uid=next.uid;
    cachedNotes=cleanNotes(safeRead(KEY_CACHE+uid));
    pending=cleanPending(safeRead(KEY_PENDING+uid));
    emit();
    notifyStatus('クラウドのメモを読み込み中…');
    unsubNotes=onSnapshot(noteCol(),snap=>{
      if(user?.uid!==uid)return;
      const notes={};
      for(const item of snap.docs){
        const text=item.data()?.text;
        if(validId(item.id)&&validText(text)&&text)notes[item.id]=text;
      }
      // On an offline-only, empty snapshot, preserve the last synced device cache.
      if(snap.metadata.fromCache&&!snap.docs.length&&Object.keys(cachedNotes).length){
        remoteNotes={...cachedNotes};
      }else remoteNotes=notes;
      loaded=true;
      emit();
      notifyStatus(Object.keys(pending).length?'メモに未送信の変更があります':'✓ メモはクラウドに同期済み');
      if(Object.keys(pending).length)schedule();
    },err=>notifyStatus('メモを同期できません：'+(err.code||err.message)+'。Firestoreルールの更新が必要です。',true));
  },err=>notifyStatus('メモ認証の確認に失敗：'+err.message,true));
  return {
    get signedIn(){return !!user},
    get loaded(){return loaded},
    get pendingCount(){return Object.keys(pending).length},
    queueNote(cardId,text){
      if(!user||!validId(cardId)||!validText(text))return false;
      const previous=pending[cardId];
      pending[cardId]={text,revision:crypto.randomUUID().replace(/-/g,'')};
      if(!storePending()){
        if(previous)pending[cardId]=previous;else delete pending[cardId];
        notifyStatus('メモを端末に保存できません。ストレージ設定を確認してください。',true);
        return false;
      }
      emit();notifyStatus('メモを端末に保存しました。クラウド同期待ち…');schedule();
      return true;
    },
    syncNow(){if(flushTimer){clearTimeout(flushTimer);flushTimer=null}void flush()},
    async migrateLocalNotes(notes){
      if(!user||!loaded)throw Error('クラウドにログインして読み込みを完了してください');
      if(Object.keys(pending).length)throw Error('未同期のメモがあります。同期後に実行してください');
      const uid=user.uid,items=Object.entries(cleanNotes(notes));let imported=0;
      for(const [id,text] of items){
        const n=await runTransaction(db,async tx=>{
          const ref=doc(db,'workUsers',uid,'notes',id),old=await tx.get(ref);
          if(old.exists()&&old.data()?.text)return false;
          tx.set(ref,{text,updatedAt:serverTimestamp()});return true;
        });
        if(n)imported++;
      }
      return imported;
    },
    async replaceNotes(notes){
      if(!user||!loaded)throw Error('クラウドのメモ読み込みを完了してください');
      if(Object.keys(pending).length)throw Error('未同期のメモがあります。同期後に実行してください');
      const uid=user.uid,values=cleanNotes(notes),snap=await getDocs(noteCol());
      const ids=new Set([...snap.docs.map(x=>x.id),...Object.keys(values)]);
      const all=[...ids];
      for(let n=0;n<all.length;n+=400){
        const batch=writeBatch(db);
        for(const id of all.slice(n,n+400))batch.set(doc(db,'workUsers',uid,'notes',id),{text:values[id]||'',updatedAt:serverTimestamp()});
        await batch.commit();
      }
    }
  };
}