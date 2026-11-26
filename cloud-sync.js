// Firebase cloud progress sync for AP flashcards.
// All cloud records live below workUsers/<auth.uid>; GitHub Pages only hosts public card content.
// Public Firebase web config is loaded by app.js; API keys here are not account passwords.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, getDocs, runTransaction, writeBatch,
  increment, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';

const QUEUE_PREFIX='work-flashcards-pending-v3:';
const allowedKind=new Set(['correct','wrong']);
const int=n=>Number.isFinite(Number(n))?Math.max(0,Math.trunc(Number(n))):0;
const validId=id=>/^[A-Za-z0-9_-]{1,64}$/.test(String(id));
function normalized(v){
  return {seen:!!v?.seen,correct:int(v?.correct),incorrect:int(v?.incorrect),needsReview:!!v?.needsReview};
}
function applyGrade(progress,id,kind){
  const x=normalized(progress[id]);
  progress[id]={seen:true,correct:x.correct+(kind==='correct'?1:0),incorrect:x.incorrect+(kind==='wrong'?1:0),needsReview:kind==='wrong'};
}
function storageRead(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null}}
function storageWrite(key,v){try{localStorage.setItem(key,JSON.stringify(v));return true}catch{return false}}
function cleanQueue(list){return Array.isArray(list)?list.filter(e=>e&&validId(e.cardId)&&allowedKind.has(e.kind)&&validId(e.id)).map(e=>({id:String(e.id),cardId:String(e.cardId),kind:e.kind})):[]}
function chunks(list,size){const a=[];for(let i=0;i<list.length;i+=size)a.push(list.slice(i,i+size));return a}

export async function createCloudSync(config, listeners){
  if(!config?.apiKey||!config?.authDomain||!config?.projectId||!config?.appId)throw Error('Firebase設定のapiKey、authDomain、projectId、appIdが不足しています。');
  const app=getApps().find(a=>a.name==='work-flashcards-sync')||initializeApp(config,'work-flashcards-sync');
  const auth=getAuth(app),db=getFirestore(app);
  try{await setPersistence(auth,browserLocalPersistence)}catch(e){listeners.onStatus('認証情報の端末保存が制限されています。再ログインが必要になる場合があります。',true)}
  let user=null,unsub=null,remoteProgress={},pending=[],flushing=false,remoteLoaded=false,cloudError=false,disposing=false;
  const storeQueue=()=>storageWrite(QUEUE_PREFIX+user.uid,pending);
  const cardsRef=()=>collection(db,'workUsers',user.uid,'cards');
  const send=()=>{
    if(!user||!remoteLoaded)return;
    const progress=structuredClone(remoteProgress);
    for(const op of pending)applyGrade(progress,op.cardId,op.kind);
    listeners.onProgress(progress,Object.keys(remoteProgress).length,pending.length);
  };
  const status=(message,isError=false)=>listeners.onStatus(message,isError);
  async function flush(){
    if(!user||flushing||disposing||cloudError)return;
    flushing=true;
    try{
      while(pending.length){
        if(!user||disposing)break;
        const op=pending[0];
        const uid=user.uid,opDoc=doc(db,'workUsers',uid,'operations',op.id),cardDoc=doc(db,'workUsers',uid,'cards',op.cardId);
        await runTransaction(db,async tx=>{
          const exists=await tx.get(opDoc);
          if(exists.exists())return;
          tx.set(opDoc,{cardId:op.cardId,kind:op.kind,createdAt:serverTimestamp()});
          tx.set(cardDoc,{
            seen:true,correct:increment(op.kind==='correct'?1:0),incorrect:increment(op.kind==='wrong'?1:0),
            needsReview:op.kind==='wrong',lastRatedAt:serverTimestamp(),
          },{merge:true});
        });
        if(user?.uid!==uid)break;
        pending=pending.filter(x=>x.id!==op.id);storeQueue();send();
      }
      if(user&&remoteLoaded){status(pending.length?'未送信の学習記録があります':'✓ クラウドと同期済み');}
    }catch(e){status('クラウドへの保存待ち：'+(e?.code||e?.message||'接続を確認してください'),true)}
    finally{flushing=false}
  }
  const online=()=>{if(user)flush()};
  const visible=()=>{if(!document.hidden&&user)flush()};
  window.addEventListener('online',online);document.addEventListener('visibilitychange',visible);
  onAuthStateChanged(auth,u=>{
    if(unsub){unsub();unsub=null}
    user=u;remoteProgress={};remoteLoaded=false;cloudError=false;
    if(!u){pending=[];listeners.onUser(null);status('クラウド同期：未ログイン');return}
    pending=cleanQueue(storageRead(QUEUE_PREFIX+u.uid));listeners.onUser({uid:u.uid,email:u.email});
    status('学習記録をクラウドから読み込み中…');
    unsub=onSnapshot(cardsRef(),snapshot=>{
      if(user?.uid!==u.uid)return;
      const out={};for(const d of snapshot.docs){if(validId(d.id))out[d.id]=normalized(d.data())}
      remoteProgress=out;remoteLoaded=true;send();status(pending.length?'送信待ちの学習記録があります':'✓ クラウドと同期済み');
      if(pending.length)flush();
    },error=>{cloudError=true;status('クラウドの読み込みに失敗：'+(error.code||error.message)+'。Firestoreルールを確認してください。',true)});
  },error=>status('認証状態を取得できません：'+error.message,true));
  return {
    get signedIn(){return !!user},
    get remoteLoaded(){return remoteLoaded},
    get hasPending(){return pending.length>0},
    async signIn(email,password){return signInWithEmailAndPassword(auth,email,password)},
    async signUp(email,password){return createUserWithEmailAndPassword(auth,email,password)},
    async signOut(){if(pending.length&&!confirm('未同期の採点記録があります。ログアウト後もこの端末に残りますが、再ログインまで同期されません。続行しますか？'))return;await firebaseSignOut(auth)},
    queueGrade(cardId,kind){
      if(!user||!validId(cardId)||!allowedKind.has(kind))return false;
      const op={id:crypto.randomUUID().replace(/-/g,''),cardId,kind};
      pending.push(op);
      if(!storeQueue()){pending.pop();status('未送信の記録を端末に保存できません。プライベートブラウズを解除してください。',true);return false}
      send();flush();return true;
    },
    async migrateLocal(progress){
      if(!user||!remoteLoaded)throw Error('ログインしてクラウドの読み込みを完了してください');
      if(Object.keys(remoteProgress).length||pending.length)throw Error('クラウドに成績があるため自動移行は行いません。重複加算を防ぐためです');
      const entries=Object.entries(progress).filter(([id,v])=>validId(id)&&v&&(v.seen||int(v.correct)||int(v.incorrect)||v.needsReview));
      for(const part of chunks(entries,400)){
        const batch=writeBatch(db);
        for(const [id,v] of part)batch.set(doc(db,'workUsers',user.uid,'cards',id),{...normalized(v),lastRatedAt:serverTimestamp()});
        await batch.commit();
      }
      return entries.length;
    },
    async replaceProgress(progress){
      if(!user||!remoteLoaded)throw Error('クラウドの読み込みが完了していません');
      if(pending.length)throw Error('送信待ちの記録があります。オンラインで同期してから再実行してください');
      const snap=await getDocs(cardsRef());
      const entries=Object.entries(progress).filter(([id,v])=>validId(id)&&v&&(v.seen||int(v.correct)||int(v.incorrect)||v.needsReview));
      const batchOps=[...snap.docs.map(x=>({type:'delete',ref:x.ref})),...entries.map(([id,v])=>({type:'set',ref:doc(db,'workUsers',user.uid,'cards',id),value:{...normalized(v),lastRatedAt:serverTimestamp()}}))];
      for(const part of chunks(batchOps,400)){
        const batch=writeBatch(db);
        for(const op of part){if(op.type==='delete')batch.delete(op.ref);else batch.set(op.ref,op.value)}
        await batch.commit();
      }
    },
    async reset(){return this.replaceProgress({})},
    getCloudProgress(){return structuredClone(remoteProgress)},
  };
}