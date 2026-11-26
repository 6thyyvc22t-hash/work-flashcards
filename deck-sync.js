// Per-user changes layered over public questions.json. Progress and notes remain separate.
import { getApps } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore, collection, doc, onSnapshot, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
const CACHE='work-flashcards-deck-cloud-cache-v1:',PENDING='work-flashcards-deck-cloud-pending-v1:';
const ID=/^[A-Za-z0-9_-]{1,64}$/;
const actions=new Set(['active','archived','purged']);
const safeRead=k=>{try{return JSON.parse(localStorage.getItem(k)||'null')}catch{return null}};
const safeStore=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return true}catch{return false}};
const clone=o=>JSON.parse(JSON.stringify(o));
function cleanCard(id,v){
 if(!v||typeof v!=='object'||Array.isArray(v)||v.id!==id)return null;
 if(typeof v.category!=='string'||!v.category||typeof v.question!=='string'||!v.question
    ||typeof v.answer!=='string'||!v.answer||v.question.length>400||v.answer.length>400)return null;
 return {id,section_no:Number.isInteger(v.section_no)?Math.max(0,v.section_no):0,
  category:v.category,question:v.question,answer:v.answer,
  explanation:String(v.explanation||'').slice(0,600),
  point:String(v.point||'').slice(0,600),origin:String(v.origin||'').slice(0,1000)};
}
function cleanChange(id,v){
 if(!ID.test(id)||!v||typeof v!=='object'||!actions.has(v.status))return null;
 if(v.status==='purged')return {status:'purged'};
 const card=cleanCard(id,v.card);return card?{status:v.status,card}:null;
}
function cleanChanges(raw){
 const out={};if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
 for(const [id,v] of Object.entries(raw)){const ch=cleanChange(id,v);if(ch)out[id]=ch}
 return out;
}
export function mergeCloudDeck(base,overrides){
 const deck=clone(base),active=new Map(deck.cards.map(c=>[c.id,c]));
 const archived=new Map(deck.archivedCards.map(c=>[c.id,c]));
 const retired=new Set(deck.retiredIds||[]);
 for(const [id,v] of Object.entries(cleanChanges(overrides))){
  active.delete(id);archived.delete(id);retired.delete(id);
  if(v.status==='active')active.set(id,v.card);
  if(v.status==='archived')archived.set(id,v.card);
  if(v.status==='purged')retired.add(id);
 }
 const order=(a,b)=>{
  const na=/^[0-9]+$/.test(a.id),nb=/^[0-9]+$/.test(b.id);
  if(na&&nb)return Number(a.id)-Number(b.id);
  if(na!==nb)return na?-1:1;
  return a.id.localeCompare(b.id);
 };
 deck.cards=[...active.values()].sort(order);
 deck.archivedCards=[...archived.values()].sort(order);
 deck.retiredIds=[...retired];
 const numeric=[...active.keys(),...archived.keys(),...retired].filter(id=>/^[0-9]+$/.test(id)).map(Number);
 deck.nextId=Math.max(base.nextId,1+Math.max(0,...numeric));
 return deck;
}
export function createDeckSync({onUser,onDeck,onStatus}){
 const app=getApps().find(a=>a.name==='work-flashcards-sync');if(!app)throw Error('Firebase未初期化');
 const auth=getAuth(app),db=getFirestore(app);
 let uid=null,unsub=null,remote={},pending={},loaded=false;
 const inflight=new Set();
 const status=(m,e=false)=>onStatus?.(m,e);
 const merged=()=>Object.assign({},remote,pending);
 const emit=()=>onDeck?.(merged(),loaded);
 const savePending=()=>safeStore(PENDING+uid,pending);
 function flush(){
  if(!uid||!loaded)return;
  for(const [id,change] of Object.entries(pending)){
   if(inflight.has(id))continue;
   const targetUid=uid,token=JSON.stringify(change);
   inflight.add(id);
   const payload=change.status==='purged'
    ?{status:'purged',updatedAt:serverTimestamp()}
    :{status:change.status,card:change.card,updatedAt:serverTimestamp()};
   setDoc(doc(db,'workUsers',targetUid,'deckChanges',id),payload).then(()=>{
    inflight.delete(id);
    if(uid!==targetUid)return;
    remote[id]=change;
    if(pending[id]&&JSON.stringify(pending[id])===token){
     delete pending[id];
     if(!savePending())status('⚠ 問題の送信記録を端末に保存できません',true);
    }
    emit();if(Object.keys(pending).length)flush();
    else status('✓ 問題データをクラウドと同期済み');
   }).catch(error=>{
    inflight.delete(id);
    if(uid===targetUid)status('⚠ 問題を送信できません: '+error.message+'。端末に送信待ち保存',true);
   });
  }
 }
 onAuthStateChanged(auth,user=>{
  if(unsub){unsub();unsub=null}
  uid=user?.uid||null;loaded=false;remote={};pending={};inflight.clear();
  onUser?.(user);
  if(!uid){status('問題の変更はこの端末だけに保存されます');return}
  remote=cleanChanges(safeRead(CACHE+uid));
  pending=cleanChanges(safeRead(PENDING+uid));
  emit();status('問題データの同期を確認しています…');
  const currentUid=uid;
  unsub=onSnapshot(collection(db,'workUsers',uid,'deckChanges'),snapshot=>{
   if(uid!==currentUid)return;
   const latest={};
   snapshot.forEach(row=>{const ch=cleanChange(row.id,row.data());if(ch)latest[row.id]=ch});
   remote=latest;
   if(!safeStore(CACHE+uid,remote))status('⚠ 問題データの端末キャッシュを保存できません',true);
   loaded=true;emit();flush();
   if(!Object.keys(pending).length)status('✓ 問題データをクラウドと同期済み');
   else status('問題データの送信待ち '+Object.keys(pending).length+'件');
  },error=>{if(uid===currentUid)status('⚠ 問題データを同期できません: '+error.message+'。Firestoreルールを確認してください。',true)});
 });
 return {
  get loaded(){return loaded},
  get pendingCount(){return Object.keys(pending).length},
  get changes(){return merged()},
  queueChange(id,value){
   if(!uid)return false;
   const ch=cleanChange(id,value);if(!ch)return false;
   const previous=pending[id];pending[id]=ch;
   if(!savePending()){if(previous)pending[id]=previous;else delete pending[id];return false}
   emit();status('問題データの送信待ち '+Object.keys(pending).length+'件');
   flush();return true;
  },
  syncNow:flush
 };
}
