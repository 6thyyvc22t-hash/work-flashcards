(()=>{
'use strict';
const $=id=>document.getElementById(id);
const KEY_PROGRESS='work-flashcards-progress-v2';
const KEY_DRAFT='work-flashcards-deck-draft-v2';
const BACKUP_KIND='work-flashcards-progress';
const DECK_ID='work-it';
const KEY_FIREBASE_CONFIG='work-flashcards-firebase-config-v1';
const KEY_LOCAL_SNAPSHOT='work-flashcards-precloud-backup-v1';
const KEY_CLOUD_ACCOUNT='work-flashcards-last-cloud-account-v1';
const KEY_NOTES_ANON='work-flashcards-notes-anonymous-v1';
const KEY_NOTES_CACHE_PREFIX='work-flashcards-notes-cache-v1:';
const BACKUP_NOTES_KIND='work-flashcards-notes';
let cloud=null,cloudUser=null,cloudStarting=false,preCloudSnapshot=null;
let memoCloud=null,memoUserId=null;
let deckCloud=null,deckUserId=null,deckCloudLoaded=false,deckOverrides={},legacyDraft=null,mergeCloudDeckFn=null;
const KEY_DRAFT_BACKUP='work-flashcards-deck-draft-before-sync-v1';

const fields=['category','question','answer','explanation','point'];
const state={base:null,deck:null,draft:null,progress:{},notes:{},storage:false,category:'ALL',mode:'ordered',current:null,answerShown:false,visibleIds:[],conflict:null};
const idIndex=()=>new Map(state.deck.cards.map((x,i)=>[x.id,i]));
const r=(id)=>state.progress[id]||{seen:false,correct:0,incorrect:0,needsReview:false};
const positive=(x)=>Number.isFinite(Number(x))?Math.max(0,Math.floor(Number(x))):0;
function cleanProgress(p){
  if(!p||typeof p!=='object'||Array.isArray(p))throw Error('学習記録が不正です');
  const out={};for(const [id,v] of Object.entries(p)){
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||!v||typeof v!=='object'||Array.isArray(v))continue;
    out[id]={seen:!!v.seen,correct:positive(v.correct??v.right),incorrect:positive(v.incorrect??v.wrong),needsReview:!!(v.needsReview??v.review)};
  }return out;
}
function cleanNotes(p){
 if(!p||typeof p!=='object'||Array.isArray(p))return {};
 const result={};
 for(const [id,text] of Object.entries(p)){
  if(/^[A-Za-z0-9_-]{1,64}$/.test(id)&&typeof text==='string'&&text.length<=2000&&text.trim())result[id]=text;
 }
 return result;
}
function hasMemos(notes){return Object.values(notes||{}).some(s=>typeof s==='string'&&s.trim())}
function updateMemoStatus(msg,isError=false){
 $('memoStatus').textContent=msg;
 $('memoStatus').classList.toggle('errorText',isError);
 $('memoStatus').classList.toggle('okText',!isError&&msg.startsWith('✓'));
}
function updateMemoMigration(){
 const local=cleanNotes(read(KEY_NOTES_ANON));
 $('cloudMigrateNotes').classList.toggle('hidden',!(memoUserId&&memoCloud?.loaded&&hasMemos(local)&&!memoCloud.pendingCount));
}
function renderMemo(){
 const cardId=state.current;
 $('memoPanel').classList.toggle('hidden',!cardId);
 $('memoText').disabled=!cardId;
 $('memoSave').disabled=!cardId;
 $('memoClear').disabled=!cardId;
 if(!cardId)return;
 const input=$('memoText'),text=state.notes[cardId]||'';
 const isNew=input.dataset.cardId!==cardId;
 if(isNew || (document.activeElement!==input && input.value!==text))input.value=text;
 input.dataset.cardId=cardId;
 $('memoFlag').textContent=text.trim()?'メモあり':'メモなし';
}
function changeMemo(text){
 const id=state.current;
 if(!id)return;
 if(typeof text!=='string'||text.length>2000)return;
 if(text.trim())state.notes[id]=text;else delete state.notes[id];
 $('memoFlag').textContent=text.trim()?'メモあり':'メモなし';
 $('sMemo').textContent=String(state.deck.cards.filter(c=>(state.notes[c.id]||'').trim()).length);
 if(memoUserId&&memoCloud){
  if(!memoCloud.queueNote(id,text))updateMemoStatus('⚠ メモを保存できません。端末の容量を確認してください。',true);
 }else{
  const ok=store(KEY_NOTES_ANON,state.notes);
  updateMemoStatus(ok?'✓ この端末に保存済み（ログインするとクラウド同期できます）':'⚠ 端末への保存に失敗しました',!ok);
 }
 updateMemoMigration();
}
async function migrateOldNotes(){
 const notes=cleanNotes(read(KEY_NOTES_ANON));
 if(!memoUserId||!memoCloud||!hasMemos(notes))return;
 if(!confirm('ログイン前に保存した端末メモをクラウドへ追加します。クラウド側にメモがある問題は上書きしません。続行しますか？'))return;
 try{
  const added=await memoCloud.migrateLocalNotes(notes);
  alert(added+'問のメモを追加しました。端末側の元メモはバックアップとして残しています。');
 }catch(e){alert('メモ移行に失敗：'+e.message)}
}
function exportMemos(){fileDownload({type:BACKUP_NOTES_KIND,version:1,deckId:DECK_ID,exportedAt:new Date().toISOString(),notes:state.notes},'work-flashcards-notes.json')}
function importMemos(file){
 if(!file)return;
 file.text().then(async txt=>{
  const parsed=JSON.parse(txt);
  if(parsed.type!==BACKUP_NOTES_KIND||parsed.deckId!==DECK_ID||!parsed.notes||typeof parsed.notes!=='object')throw Error('この単語帳のメモJSONではありません');
  const notes=cleanNotes(parsed.notes);
  if(memoUserId&&memoCloud){
   if(!confirm('クラウドの全メモをこのJSONで置き換えます。iPhoneとiPadの両方に反映されます。続けますか？'))return;
   await memoCloud.replaceNotes(notes);
   alert('メモをクラウドに復元しました。');
  }else if(confirm('この端末の全メモをJSONの内容で置き換えますか？')){
   if(!store(KEY_NOTES_ANON,notes))throw Error('端末へ保存できません');
   state.notes=notes;render();alert('メモを端末に復元しました。');
  }
 }).catch(e=>alert('メモの読み込みに失敗：'+e.message));
}
function validateDeck(raw){
  if(!raw||typeof raw!=='object'||raw.deckId!==DECK_ID||!Array.isArray(raw.cards)||!Array.isArray(raw.archivedCards))throw Error('この単語帳に対応しないJSONです');
  if(!Array.isArray(raw.categories)||raw.categories.some(c=>typeof c!=='string'||!c.trim()))throw Error('分野の設定が不正です');
  if(raw.cards.length+raw.archivedCards.length>10000)throw Error('問題数が多すぎます');
  const seen=new Set(),categories=new Set(raw.categories);
  const validateCard=c=>{
    if(!c||typeof c!=='object'||typeof c.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(c.id)||seen.has(c.id))throw Error('重複または不正な問題IDです');
    seen.add(c.id);
    if(!categories.has(c.category)||typeof c.question!=='string'||!c.question.trim()||typeof c.answer!=='string'||!c.answer.trim())throw Error('問題文・正答・分野が不正です');
    for(const f of ['explanation','point'])if(c[f]!=null&&typeof c[f]!=='string')throw Error('解説・ポイントが不正です');
    return {...c};
  };
  const cards=raw.cards.map(validateCard),archivedCards=raw.archivedCards.map(validateCard);
  const retiredIds=Array.isArray(raw.retiredIds)?raw.retiredIds:[];
  for(const id of retiredIds){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||seen.has(id))throw Error('完全削除した問題IDが不正または重複しています');seen.add(id);}
  const numericIds=[...seen].filter(x=>/^\d+$/.test(x)).map(Number);
  const minNext=Math.max(1,...numericIds,0)+1;
  return {schemaVersion:2,deckId:DECK_ID,title:String(raw.title||'仕事理解用 デジタル単語帳'),description:String(raw.description||''),revision:String(raw.revision||''),nextId:Math.max(minNext,positive(raw.nextId)||1),categories:[...raw.categories],cards,archivedCards,retiredIds:[...retiredIds]};
}
function showAlert(id,message){$(id).textContent=message;$(id).classList.remove('hidden');}
function clearAlert(id){$(id).classList.add('hidden');$(id).textContent='';}
function store(key,value){if(!state.storage)return false;try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{state.storage=false;updateSaveNotice();return false;}}
function read(key){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}

// An edit changes only affected IDs. Never interpret an ID absent in an older
// local draft as a deletion: GitHub may have added that ID afterwards.
function deckStatusMap(deck){
 const out={};
 for(const c of deck.cards)out[c.id]={status:'active',card:c};
 for(const c of deck.archivedCards)out[c.id]={status:'archived',card:c};
 for(const id of deck.retiredIds)out[id]={status:'purged'};
 return out;
}
function deckDiff(before,after){
 const old=deckStatusMap(before),next=deckStatusMap(after),changes=[];
 for(const [id,change] of Object.entries(next)){
  if(JSON.stringify(old[id])!==JSON.stringify(change))changes.push({id,change});
 }
 return changes;
}
function legacyDraftDiff(){
 if(!legacyDraft?.deck)return {changes:[],skipped:0};
 const local=validateDeck(legacyDraft.deck),changes=deckDiff(state.base,local);
 const safe=changes.filter(x=>!Object.prototype.hasOwnProperty.call(deckOverrides,x.id));
 return {changes:safe,skipped:changes.length-safe.length};
}
function updateDeckMigration(){
 const btn=$('cloudMigrateDeck'),info=$('cloudDeckMigrationInfo');
 if(!btn||!info)return;
 const ready=!!(deckUserId&&deckCloudLoaded&&legacyDraft?.deck);
 btn.classList.toggle('hidden',!ready);
 info.classList.toggle('hidden',!ready);
 if(ready){
  try{
   const summary=legacyDraftDiff();
   info.textContent='以前の端末下書きあり。移行候補 '+summary.changes.length+'件（クラウドに変更済みの '+summary.skipped+'件は上書きしません）。';
  }catch(e){info.textContent='下書きを検証できません: '+e.message}
 }
}
function migrateLegacyDeck(){
 if(!deckUserId||!deckCloud?.loaded||!legacyDraft?.deck)return;
 let result;
 try{result=legacyDraftDiff()}catch(e){alert('下書きの検証に失敗: '+e.message);return}
 const kinds={active:0,archived:0,purged:0};
 for(const item of result.changes)kinds[item.change.status]++;
 if(!confirm('以前この端末で行った問題変更をクラウドに移行します。\n追加・編集 '+kinds.active+'件／保管 '+kinds.archived+'件／完全削除 '+kinds.purged+'件。\nクラウド側で変更済みの '+result.skipped+'件は上書きしません。iPadにも反映されます。実行しますか？'))return;
 if(!store(KEY_DRAFT_BACKUP,legacyDraft)){alert('下書きのバックアップ保存に失敗しました。移行を中止します。');return}
 for(const {id,change} of result.changes){
  if(!deckCloud.queueChange(id,change)){alert('Q'+id+' の送信待ち保存に失敗しました。下書きは残しています。');return}
 }
 try{localStorage.removeItem(KEY_DRAFT)}
 catch{alert('クラウド送信待ちは保存しましたが、古い下書きを削除できませんでした。');return}
 legacyDraft=null;state.draft=null;updateView();
 alert(result.changes.length+'件をクラウド送信待ちへ登録しました。同期状態をご確認ください。');
}
function showDeckCloudStatus(message,isError=false){
 const el=$('deckCloudStatus');if(!el)return;
 el.textContent=message;
 el.classList.toggle('errorText',isError);
 el.classList.toggle('okText',!isError&&message.startsWith('✓'));
}

function updateSaveNotice(){
 const txt=state.storage?(cloudUser?'✓ 学習記録を端末にも保存し、Firebaseクラウドと同期します。未送信がある場合は下の同期状態をご確認ください。':'✓ 学習記録と端末の編集内容はこのブラウザ内に保存されます。Firebaseログイン後に端末間で同期できます。'):'⚠ この表示環境では端末への自動保存ができません。必ずJSONを書き出してください。';
 $('saveNotice').textContent=txt;$('saveNotice').className='alert '+(state.storage?'note':'warning');
}
function setDraft(deck){
 const candidate=validateDeck(deck);
 if(deckUserId&&deckCloud&&deckCloudLoaded){
  const changes=deckDiff(state.deck,candidate);
  if(!changes.length)return;
  for(const {id,change} of changes){
   if(!deckCloud.queueChange(id,change)){
    alert('問題変更の端末保存に失敗しました。端末容量と同期状態を確認してください。');return;
   }
  }
  return;
 }
 state.deck=candidate;
 state.draft={baseRevision:state.base.revision,deck:state.deck};
 if(!store(KEY_DRAFT,state.draft))alert('問題を端末に保存できませんでした。JSONバックアップを取ってください。');
 if(deckUserId){legacyDraft=state.draft;showDeckCloudStatus('⚠ クラウド接続待ちのため端末下書きに保存しました',true)}
 updateView();
}
function updateDraftNotice(){
 if(deckUserId){
  $('draftStatus').textContent=deckCloudLoaded?'個人用問題変更をクラウド同期中（送信待ち '+(deckCloud?.pendingCount||0)+'件）':'問題データのクラウド読込待ち';
 }else $('draftStatus').textContent=state.draft?'この端末で編集した下書きを使用中（未公開）':'GitHub公開版を使用中';
 $('archivedCount').textContent='削除済み保管：'+state.deck.archivedCards.length+'問';
 $('discardDraft').classList.toggle('hidden',!!(deckUserId&&!legacyDraft));
 updateDeckMigration();
}
function getPool(){return state.deck.cards.filter(c=>(state.category==='ALL'||c.category===state.category)&&(state.mode==='missed'?r(c.id).needsReview:state.mode==='new'?!r(c.id).seen:true)).map(c=>c.id);}
function renderJump(pool){
 const group=$('jumpGroup'),select=$('jumpSelect'),button=$('jumpBtn');
 const sequential=state.mode!=='random';
 group.classList.toggle('hidden',!sequential);
 if(!sequential)return;
 const poolKey=pool.join('|');
 if(select.dataset.poolKey!==poolKey){
  const byId=new Map(state.deck.cards.map(c=>[c.id,c]));
  select.replaceChildren(...pool.map((id,index)=>{
   const question=byId.get(id)?.question||'';
   const label=question.length>36?question.slice(0,36)+'…':question;
   return new Option(`${index+1} / ${pool.length}（Q${id}） ${label}`,id);
  }));
  select.dataset.poolKey=poolKey;
 }
 select.disabled=button.disabled=pool.length===0;
 select.value=state.current||'';
 $('jumpHelp').textContent=pool.length?`現在の条件の全${pool.length}問から選択できます。移動しても学習記録は変わりません。`:'現在の条件に合う問題がありません。';
}
function jumpToSelected(){
 if(state.mode==='random')return;
 const id=$('jumpSelect').value;
 if(!id||!getPool().includes(id))return;
 state.current=id;state.answerShown=false;render();
}
function chooseRandom(ids,exclude){const eligible=ids.length>1?ids.filter(id=>id!==exclude):ids;return eligible[Math.floor(Math.random()*eligible.length)]||null;}
function nextCard(step=1,wasGraded=false){
 const pool=getPool();if(!pool.length){state.current=null;render();return;}
 const previous=state.current,order=state.deck.cards.map(c=>c.id);
 if(state.mode==='random'){state.current=chooseRandom(pool,previous)}
 else if(pool.includes(previous)&&!wasGraded){state.current=pool[(pool.indexOf(previous)+step+pool.length)%pool.length]}
 else{
   const prevIndex=order.indexOf(previous);
   if(prevIndex<0)state.current=pool[0];
   else{
     const ordered=step>0?pool.find(id=>order.indexOf(id)>prevIndex):[...pool].reverse().find(id=>order.indexOf(id)<prevIndex);
     state.current=ordered||(step>0?pool[0]:pool[pool.length-1]);
   }
 }
 state.answerShown=false;render();
}
function resetSelection(){const pool=getPool();state.current=state.mode==='random'?chooseRandom(pool):pool[0]||null;state.answerShown=false;render();}
function renderStats(){
 const cards=state.deck.cards;
 let studied=0,correct=0,wrong=0,missed=0;
 for(const c of cards){const x=r(c.id);studied+=x.seen?1:0;correct+=positive(x.correct);wrong+=positive(x.incorrect);missed+=x.needsReview?1:0;}
 $('sTotal').textContent=String(cards.length);$('deckCount').textContent='全'+cards.length+'問';$('sStudied').textContent=String(studied);
 $('sCorrect').textContent=String(correct);$('sWrong').textContent=String(wrong);$('sMissed').textContent=String(missed);
 $('sAccuracy').textContent=correct+wrong?(correct/(correct+wrong)*100).toFixed(1)+'%':'—';
 $('sMemo').textContent=String(cards.filter(c=>!!(state.notes[c.id]||'').trim()).length);
}
function render(){
 renderStats();const pool=getPool();state.visibleIds=pool;
 if(!pool.includes(state.current)){state.current=pool[0]||null;state.answerShown=false;}
 renderJump(pool);
 const card=state.deck.cards.find(x=>x.id===state.current),has=!!card;
 $('card').classList.toggle('hidden',!has);$('emptyMessage').classList.toggle('hidden',has);
 $('questionIndex').textContent=has?'Q'+card.id:'該当0問';
 $('progressText').textContent=has?`${pool.indexOf(card.id)+1} / ${pool.length}`:'0 / 0';
 $('progressBar').style.width=has?(100*(pool.indexOf(card.id)+1)/pool.length).toFixed(2)+'%':'0%';
 if(has){
   $('cardCategory').textContent=card.category;$('questionText').textContent=card.question;
   const score=r(card.id),correctCount=$('cardCorrectCount'),wrongCount=$('cardWrongCount');
   if(correctCount)correctCount.textContent=String(positive(score.correct));
   if(wrongCount)wrongCount.textContent=String(positive(score.incorrect));
   $('answerText').textContent=card.answer;$('explanationText').textContent=card.explanation||'';
   $('pointText').textContent=card.point?'設計・実務の観点：'+card.point:'';
   $('answerArea').classList.toggle('hidden',!state.answerShown);
   $('cardSide').textContent=state.answerShown?'裏面・正答':'表面・問題';
   $('tapHelp').textContent=state.answerShown?'タップして問題に戻る':'タップして答えを表示';
   $('showBtn').textContent=state.answerShown?'問題に戻す':'答えを見る';
 }
 for(const id of ['wrongBtn','correctBtn'])$(id).disabled=!(has&&state.answerShown);
 for(const id of ['skipBtn','prevBtn','nextBtn','showBtn'])$(id).disabled=!has;
 renderMemo();
}
function toggleAnswer(){if(!state.current)return;state.answerShown=!state.answerShown;render();}
function grade(kind){
 if(!state.current||!state.answerShown)return;
 const id=state.current,x=r(id);
 state.progress[id]={seen:true,correct:positive(x.correct)+(kind==='correct'?1:0),incorrect:positive(x.incorrect)+(kind==='wrong'?1:0),needsReview:kind==='wrong'};
 store(KEY_PROGRESS,state.progress);
 if(cloudUser&&cloud&&!cloud.queueGrade(id,kind))showCloudStatus('クラウドへの送信待ち記録を保存できませんでした。JSONバックアップを取ってください。',true);
 nextCard(1,true);
}

function fillFilters(){
 const currentCategory=state.category;
 $('categoryFilter').replaceChildren(new Option('全分野','ALL'),...state.deck.categories.map(c=>new Option(c+'（'+state.deck.cards.filter(x=>x.category===c).length+'問）',c)));
 $('categoryFilter').value=state.deck.categories.includes(currentCategory)?currentCategory:'ALL';state.category=$('categoryFilter').value;
 $('editCategory').replaceChildren(...state.deck.categories.map(c=>new Option(c,c)));
}
function updateView(){fillFilters();updateDraftNotice();$('jumpSelect').dataset.poolKey='';resetSelection();renderManageList();}
function fileDownload(obj,name){
 const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)+'\n'],{type:'application/json;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function exportProgress(){fileDownload({type:BACKUP_KIND,version:2,deckId:DECK_ID,exportedAt:new Date().toISOString(),progress:state.progress},'work-flashcards-progress.json')}
function importProgress(file){
 if(!file)return;file.text().then(txt=>{
  const obj=JSON.parse(txt);let progress;
  if(obj.type===BACKUP_KIND&&obj.deckId===DECK_ID)progress=cleanProgress(obj.progress);
  else throw Error('対応しない学習記録ファイルです');
  if(cloudUser&&cloud){
    if(!confirm('クラウド上の学習記録をこのJSONで置き換えます。iPad・iPhoneの記録も変更されます。実行しますか？'))return;
    cloud.replaceProgress(progress).then(()=>alert('クラウドの学習記録を復元しました。各端末へ自動反映されます。')).catch(e=>alert('クラウドへの復元に失敗：'+e.message));
  }else if(confirm('現在の端末の学習記録を読み込んだ内容で置き換えますか？')){state.progress=progress;store(KEY_PROGRESS,progress);resetSelection();alert('学習記録を端末に復元しました。');}

 }).catch(e=>alert('学習記録の読み込みに失敗しました：'+e.message));
}
function exportDeck(){const deck={...state.deck,revision:new Date().toISOString()};fileDownload(deck,'questions.json');}
function importDeck(file){
 if(!file)return;
 if(deckUserId){alert('クラウド同期中は問題JSONの一括読込を停止しています。ログアウトして端末下書きに読み込み、再ログインして「以前の端末下書きをクラウドへ移行」を使ってください。');return}
 file.text().then(txt=>{
  const candidate=validateDeck(JSON.parse(txt));
  if(!confirm(`問題データを ${candidate.cards.length}問に置き換えますか？\n現在の問題データは自動保存されません。事前の書き出しをおすすめします。\n学習記録は問題IDに紐付いたまま維持します。`))return;
  setDraft(candidate);alert('端末上の問題データを更新しました。全端末への公開はGitHubのquestions.jsonを更新してください。');
 }).catch(e=>alert('問題データの読み込みに失敗しました：'+e.message));
}
function renderManageList(){
 const q=$('manageSearch').value.trim().toLowerCase();
 const sorted=state.deck.cards.filter(c=>!q||[c.id,c.category,c.question,c.answer].join(' ').toLowerCase().includes(q));
 const makeRow=(c,archived)=>{
   const row=document.createElement('div');row.className='manageRow';
   const title=document.createElement('div');title.className='manageText';
   const strong=document.createElement('strong');strong.textContent='Q'+c.id+' ｜ '+c.category;
   const p=document.createElement('div');p.textContent=c.question;title.append(strong,p);row.append(title);
   const buttons=document.createElement('div');buttons.className='manageActions';
   if(archived){const restore=document.createElement('button');restore.type='button';restore.textContent='復元';restore.addEventListener('click',()=>restoreCard(c.id));const hard=document.createElement('button');hard.type='button';hard.className='danger';hard.textContent='完全削除';hard.addEventListener('click',()=>purgeCard(c.id));buttons.append(restore,hard)}
   else{
     const edit=document.createElement('button');edit.type='button';edit.textContent='編集';edit.addEventListener('click',()=>showEditor(c));
     const del=document.createElement('button');del.type='button';del.textContent='保管';del.className='danger';del.addEventListener('click',()=>deleteCard(c.id));
     const hard=document.createElement('button');hard.type='button';hard.textContent='完全削除';hard.className='danger';hard.addEventListener('click',()=>purgeCard(c.id));
     buttons.append(edit,del,hard);
   }row.append(buttons);return row;
 };
 const rows=sorted.map(c=>makeRow(c,false));
 $('manageList').replaceChildren(...rows);
 $('manageResultCount').textContent=`${sorted.length}問を表示中（全${state.deck.cards.length}問）。`;
 if(!sorted.length){const p=document.createElement('p');p.className='small';p.textContent='該当する問題はありません。';$('manageList').append(p)}
 const archive=state.deck.archivedCards.filter(c=>!q||[c.id,c.question,c.answer].join(' ').toLowerCase().includes(q));
 $('archiveList').replaceChildren(...archive.map(c=>makeRow(c,true)));
 if(!archive.length){const p=document.createElement('p');p.className='small';p.textContent='該当する削除済み問題はありません。';$('archiveList').append(p)}
}
function showEditor(card=null){
 $('editId').value=card?.id||'';$('editorTitle').textContent=card?'Q'+card.id+' を編集':'新しい問題を追加';
 for(const field of fields){const key='edit'+field.charAt(0).toUpperCase()+field.slice(1);$(key).value=card?.[field]||'';}
 $('editorForm').classList.remove('hidden');$('editorForm').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function hideEditor(){$('editorForm').classList.add('hidden');$('editorForm').reset();}
function submitEditor(event){
 event.preventDefault();const id=$('editId').value.trim();
 const data={};for(const field of fields){const key='edit'+field.charAt(0).toUpperCase()+field.slice(1);data[field]=$(key).value.trim();}
 if(!data.question||!data.answer||!state.deck.categories.includes(data.category)){alert('分野・問題文・正答を入力してください。');return}
 const normalized=s=>s.replace(/\s+/g,'').toLowerCase();
 if(state.deck.cards.some(x=>x.id!==id&&x.category===data.category&&normalized(x.question)===normalized(data.question))){alert('同じ分野に同じ問題文があります。重複を確認してください。');return}
 const deck=structuredClone(state.deck);
 if(id){const idx=deck.cards.findIndex(c=>c.id===id);if(idx<0)return;deck.cards[idx]={...deck.cards[idx],...data};}
 else{
  const logged=!!deckUserId;
  const newId=logged?'u'+(globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random().toString(36).slice(2)).replace(/-/g,''):String(deck.nextId).padStart(3,'0');
  if(!logged)deck.nextId+=1;
  const section=Math.max(0,...deck.cards.filter(c=>c.category===data.category).map(c=>Number(c.section_no)||0))+1;
  deck.cards.push({id:newId,section_no:section,...data,origin:'手動追加（ユーザー編集）'});
 }
 setDraft(deck);hideEditor();
}
function deleteCard(id){const card=state.deck.cards.find(c=>c.id===id);if(!card)return;
 if(!confirm(`Q${id}「${card.question}」を出題対象から外しますか？\n問題は削除済み一覧に保管され、後から復元できます。学習記録も残ります。`))return;
 const deck=structuredClone(state.deck);deck.cards=deck.cards.filter(c=>c.id!==id);deck.archivedCards.push(card);setDraft(deck);
}
function restoreCard(id){const c=state.deck.archivedCards.find(c=>c.id===id);if(!c)return;
 const deck=structuredClone(state.deck);deck.archivedCards=deck.archivedCards.filter(c=>c.id!==id);deck.cards.push(c);
 // Restore the original numeric card sequence, including older IDs.
 deck.cards.sort((a,b)=>{const an=/^\d+$/.test(a.id),bn=/^\d+$/.test(b.id);return an&&bn?Number(a.id)-Number(b.id):an?-1:bn?1:a.id.localeCompare(b.id)});setDraft(deck);
}
function purgeCard(id){
 // Active cards can be permanently removed directly, without first archiving them.
 const c=state.deck.cards.find(c=>c.id===id)||state.deck.archivedCards.find(c=>c.id===id);
 if(!c)return;
 if(!confirm(`Q${id}「${c.question}」を完全削除しますか？\n問題文・正答を問題データから除き、復元できなくなります。\nログイン中は同じアカウントの他端末へ自動反映します。学習履歴・メモは別管理で残ります。`))return;
 const deck=structuredClone(state.deck);
 deck.cards=deck.cards.filter(c=>c.id!==id);
 deck.archivedCards=deck.archivedCards.filter(c=>c.id!==id);
 if(!deck.retiredIds.includes(id))deck.retiredIds.push(id);
 setDraft(deck);
}
function discardDraft(){
 if(deckUserId){
  if(!legacyDraft)return;
  if(!confirm('以前の端末下書きを破棄しますか？クラウドの問題・成績・メモは変更しません。'))return;
  try{localStorage.removeItem(KEY_DRAFT)}catch{}
  legacyDraft=null;state.draft=null;updateView();return;
 }
 if(!state.draft)return;
 if(!confirm('この端末で編集した問題データを破棄し、GitHub公開版に戻しますか？ 学習記録は残ります。'))return;
 state.draft=null;state.deck=structuredClone(state.base);if(state.storage)localStorage.removeItem(KEY_DRAFT);clearAlert('syncNotice');hideEditor();updateView();
}
function initHandlers(){
 $('card').addEventListener('click',toggleAnswer);
 $('card').addEventListener('keydown',e=>{if(e.target===$('card')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();toggleAnswer()}});
 $('showBtn').addEventListener('click',toggleAnswer);
 $('correctBtn').addEventListener('click',()=>grade('correct'));
 $('wrongBtn').addEventListener('click',()=>grade('wrong'));
 $('skipBtn').addEventListener('click',()=>nextCard());
 $('nextBtn').addEventListener('click',()=>nextCard());
 $('prevBtn').addEventListener('click',()=>nextCard(-1));
 $('memoText').addEventListener('input',e=>changeMemo(e.target.value));
 $('memoSave').addEventListener('click',()=>{if(state.current)changeMemo($('memoText').value);memoCloud?.syncNow()});
 $('memoClear').addEventListener('click',()=>{if(!state.current)return;if(!confirm('この問題のメモを削除しますか？ログイン中は他の端末にも反映されます。'))return;$('memoText').value='';changeMemo('');memoCloud?.syncNow()});
 $('exportMemos').addEventListener('click',exportMemos);
 $('importMemos').addEventListener('change',e=>{importMemos(e.target.files[0]);e.target.value=''});
 $('categoryFilter').addEventListener('change',e=>{state.category=e.target.value;resetSelection()});
 $('modeFilter').addEventListener('change',e=>{state.mode=e.target.value;resetSelection()});
 $('jumpBtn').addEventListener('click',jumpToSelected);
 $('exportProgress').addEventListener('click',exportProgress);
 $('importProgress').addEventListener('change',e=>{importProgress(e.target.files[0]);e.target.value=''});
 $('resetProgress').addEventListener('click',async()=>{
  const msg=cloudUser?'クラウドの全学習記録をリセットします。iPad・iPhone両方に反映されます。取り消せません。実行しますか？':'この端末の正誤・学習済み・復習対象をすべてリセットしますか？';
  if(!confirm(msg))return;
  if(cloudUser&&cloud){try{await cloud.reset();alert('クラウドの記録をリセットしました。')}catch(e){alert('リセットに失敗：'+e.message)}}
  else{state.progress={};store(KEY_PROGRESS,state.progress);resetSelection()}
 });

 $('addCard').addEventListener('click',()=>showEditor());$('exportDeck').addEventListener('click',exportDeck);
 $('importDeck').addEventListener('change',e=>{importDeck(e.target.files[0]);e.target.value=''});
 $('discardDraft').addEventListener('click',discardDraft);
 $('manageSearch').addEventListener('input',renderManageList);
 $('editorForm').addEventListener('submit',submitEditor);
 $('cancelEdit').addEventListener('click',hideEditor);
 $('authSignIn').addEventListener('click',()=>authenticate(false));
 $('authSignUp').addEventListener('click',()=>authenticate(true));
 $('cloudLogout').addEventListener('click',async()=>{if(!cloud)return;try{await cloud.signOut()}catch(e){showCloudStatus('ログアウト失敗：'+e.message,true)}});
 $('cloudMigrate').addEventListener('click',migrateOldProgress);
 $('cloudMigrateNotes').addEventListener('click',migrateOldNotes);
 $('cloudMigrateDeck').addEventListener('click',migrateLegacyDeck);
 $('cloudExportLegacy').addEventListener('click',()=>{if(preCloudSnapshot)fileDownload({type:BACKUP_KIND,version:2,deckId:DECK_ID,exportedAt:new Date().toISOString(),progress:preCloudSnapshot},'work-flashcards-before-cloud.json')});
 $('firebaseApplyConfig').addEventListener('click',()=>{
  try{const v=parseFirebaseConfig($('firebaseConfigInput').value);if(!state.storage)throw Error('端末ストレージが利用できないため設定を保存できません');store(KEY_FIREBASE_CONFIG,v);alert('Firebase設定を保存しました。画面を再読み込みして接続します。');location.reload();}
  catch(e){alert('Firebase設定を確認してください：'+e.message)}
 });
 $('firebaseExportConfig').addEventListener('click',()=>{
   try{const v=parseFirebaseConfig($('firebaseConfigInput').value);fileDownload(v,'firebase-config.json')}
   catch(e){alert('設定JSONを入力してください：'+e.message)}
 });
 $('firebaseClearConfig').addEventListener('click',()=>{
  if(!confirm('この端末だけに保存したFirebase設定を解除しますか？（GitHub公開版の設定は変更されません）'))return;
  try{localStorage.removeItem(KEY_FIREBASE_CONFIG)}catch{}location.reload();
 });
}

function showCloudStatus(message,isError=false){
 const node=$('cloudStatus');node.textContent=message;node.classList.toggle('errorText',isError);node.classList.toggle('okText',!isError&&message.startsWith('✓'));
 $('cloudIndicator').textContent=isError?'⚠':(message.startsWith('✓')?'●':'◯');
}
function parseFirebaseConfig(text){
 // Firebase's Web config is PUBLIC configuration, NOT an admin-service-account credential.
 let v=text;
 if(typeof text==='string'){
  let raw=text.trim();
  // Also accept the `const firebaseConfig = { ... };` snippet supplied by Firebase Console.
  raw=raw.replace(/^(?:const|let|var)\s+firebaseConfig\s*=\s*/, '').replace(/;\s*$/, '');
  raw=raw.replace(/([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2"');
  v=JSON.parse(raw);
 }
 if(!v||typeof v!=='object'||Array.isArray(v)||!['apiKey','authDomain','projectId','appId'].every(k=>typeof v[k]==='string'&&v[k].trim()))throw Error('apiKey・authDomain・projectId・appIdを含むJSONが必要です');
 if(v.private_key||v.privateKey||v.client_email)throw Error('管理者の秘密鍵やサービスアカウント情報は入力しないでください');
 if(!/^work-flashcards-[a-z0-9-]+$/.test(v.projectId.trim()))throw Error('仕事専用のFirebaseプロジェクトID（work-flashcards-で始まるもの）を指定してください。応用情報版の設定は利用できません。');
 return Object.fromEntries(['apiKey','authDomain','projectId','appId','messagingSenderId','storageBucket','measurementId'].filter(k=>typeof v[k]==='string'&&v[k].trim()).map(k=>[k,v[k].trim()]));
}
function hasScores(progress){return Object.values(progress||{}).some(v=>v&&(v.seen||positive(v.correct)||positive(v.incorrect)||v.needsReview));}
function updateMigration(remoteCount){
 const have=hasScores(preCloudSnapshot);
 $('cloudMigrate').classList.toggle('hidden',!(cloudUser&&cloud?.remoteLoaded&&remoteCount===0&&have&&!cloud.hasPending));
 $('cloudExportLegacy').classList.toggle('hidden',!have);
 const info=$('cloudMigrationInfo');
 if(cloudUser&&have){info.classList.remove('hidden');info.textContent=remoteCount===0?'この端末にクラウド導入前の学習記録が見つかりました。「以前の成績を移行」で初回のみ取り込めます。':'この端末の古い学習記録を別に保護しています。クラウドに既に成績があるため、自動で合算しません（重複防止）。必要ならJSONに保存できます。';}
 else info.classList.add('hidden');
}
async function migrateOldProgress(){
 if(!cloud||!cloudUser||!preCloudSnapshot)return;
 if(!confirm('この端末に残る以前の成績をクラウドへ初回移行します。すでにクラウドに成績がある場合は実行できません。続けますか？'))return;
 try{const n=await cloud.migrateLocal(preCloudSnapshot);alert(n+'問分の既存学習記録をクラウドに移行しました。');updateMigration(n)}
 catch(e){alert('移行失敗：'+e.message)}
}
async function authenticate(register){
 if(!cloud){showCloudStatus('先にFirebaseの設定を行ってください',true);return}
 const email=$('authEmail').value.trim(),password=$('authPassword').value;
 if(!email||password.length<6){showCloudStatus('メールアドレスと6文字以上のパスワードを入力してください',true);return}
 for(const id of ['authSignIn','authSignUp'])$(id).disabled=true;
 try{if(register)await cloud.signUp(email,password);else await cloud.signIn(email,password);$('authPassword').value=''}
 catch(e){const errors={'auth/email-already-in-use':'このメールアドレスは登録済みです。ログインしてください。','auth/invalid-credential':'メールアドレスまたはパスワードが正しくありません。','auth/operation-not-allowed':'Firebaseコンソールでメール/パスワード認証を有効にしてください。','auth/unauthorized-domain':'Firebase Authenticationの承認済みドメインに6thyyvc22t-hash.github.ioを追加してください。','auth/weak-password':'パスワードは6文字以上で設定してください。'};showCloudStatus(errors[e.code]||'認証エラー：'+(e.code||e.message),true)}
 finally{for(const id of ['authSignIn','authSignUp'])$(id).disabled=false}
}
async function initCloud(){
 if(cloudStarting)return;cloudStarting=true;
 let config=read(KEY_FIREBASE_CONFIG);
 if(!config){try{const response=await fetch('firebase-config.json',{cache:'no-store'});if(response.ok)config=await response.json()}catch{}}
 try{
  config=parseFirebaseConfig(config);
  $('firebaseConfigInput').value=JSON.stringify(config,null,2);
 }catch{
  showCloudStatus('Firebaseは未設定です。現在は端末内の学習記録を使用中です。下の「Firebase設定」を開いてください。');
  $('cloudSetup').open=true;return;
 }
 try{
   showCloudStatus('Firebaseに接続しています…');
   const {createCloudSync}=await import('./cloud-sync.js');
   cloud=await createCloudSync(config,{
     onUser(user){
       cloudUser=user;
       $('cloudAuthPanel').classList.toggle('hidden',!!user);$('cloudUserPanel').classList.toggle('hidden',!user);
       $('cloudUser').textContent=user?.email||'未ログイン';
       if(user){
         // Preserve the original device-only record once; never silently merge two devices.
         if(!read(KEY_CLOUD_ACCOUNT)&&!read(KEY_LOCAL_SNAPSHOT)&&hasScores(state.progress))store(KEY_LOCAL_SNAPSHOT,state.progress);
         preCloudSnapshot=read(KEY_LOCAL_SNAPSHOT);
         store(KEY_CLOUD_ACCOUNT,user.uid);
       }else {preCloudSnapshot=read(KEY_LOCAL_SNAPSHOT);updateMigration(0)}
       updateSaveNotice();
     },
     onProgress(progress,remoteCount){
       state.progress=cleanProgress(progress);store(KEY_PROGRESS,state.progress);render();updateMigration(remoteCount);
     },
     onStatus(message,isError){showCloudStatus(message,isError)}
   });
   const {createMemoSync}=await import('./memo-sync.js');
   memoCloud=createMemoSync({
     onUser(user){
       memoUserId=user?.uid||null;
       state.notes=memoUserId?cleanNotes(read(KEY_NOTES_CACHE_PREFIX+memoUserId)):cleanNotes(read(KEY_NOTES_ANON));
       renderMemo();renderStats();updateMemoMigration();
     },
     onNotes(notes){
       state.notes=cleanNotes(notes);
       renderMemo();renderStats();updateMemoMigration();
     },
     onStatus(message,isError){updateMemoStatus(message,isError)}
   });
   const {createDeckSync,mergeCloudDeck}=await import('./deck-sync.js');
   mergeCloudDeckFn=mergeCloudDeck;
   deckCloud=createDeckSync({
     onUser(user){
       deckUserId=user?.uid||null;
       deckCloudLoaded=false;deckOverrides={};legacyDraft=read(KEY_DRAFT);
       if(deckUserId){state.draft=null;state.deck=structuredClone(state.base)}
       else{
         const old=legacyDraft?.deck&&legacyDraft.baseRevision===state.base.revision?legacyDraft.deck:null;
         if(old){try{state.deck=validateDeck(old);state.draft=legacyDraft}catch{state.deck=structuredClone(state.base);state.draft=null}}
         else{state.deck=structuredClone(state.base);state.draft=null}
       }
       updateView();
     },
     onDeck(overrides,loaded){
       if(!deckUserId)return;
       deckOverrides=overrides;deckCloudLoaded=loaded;
       try{state.deck=validateDeck(mergeCloudDeckFn(state.base,deckOverrides));state.draft=null;updateView()}
       catch(e){showDeckCloudStatus('⚠ 問題データの統合に失敗: '+e.message,true)}
     },
     onStatus(message,isError){showDeckCloudStatus(message,isError)}
   });
 }catch(e){showCloudStatus('Firebaseへの接続失敗：'+e.message+'。設定や通信を確認してください。',true)}
}

async function init(){
 try{
  const res=await fetch('questions.json',{cache:'no-store'});
  if(!res.ok)throw Error('HTTP '+res.status);
  state.base=validateDeck(await res.json());
  state.deck=structuredClone(state.base);
  try{
   const probe='work-flashcards-probe';localStorage.setItem(probe,'ok');state.storage=localStorage.getItem(probe)==='ok';localStorage.removeItem(probe);
  }catch{state.storage=false}
  if(state.storage){
   state.notes=cleanNotes(read(KEY_NOTES_ANON));
   const current=read(KEY_PROGRESS);
   if(current)state.progress=cleanProgress(current);
   const draft=read(KEY_DRAFT);
   legacyDraft=draft;
   if(draft&&draft.baseRevision&&draft.deck){
    try{
     const decoded=validateDeck(draft.deck);
     if(JSON.stringify([decoded.cards,decoded.archivedCards,decoded.retiredIds])===JSON.stringify([state.base.cards,state.base.archivedCards,state.base.retiredIds])){
      localStorage.removeItem(KEY_DRAFT);
     }else if(draft.baseRevision===state.base.revision){
      state.draft={baseRevision:draft.baseRevision,deck:decoded};state.deck=decoded;
     }else{
      state.conflict=draft;
      showAlert('syncNotice','GitHub公開版が更新されています。古い端末の下書きは自動適用せず保護しました。必要なら以前の問題データを保存してから、新しい公開版を編集してください。');
      const btn=document.createElement('button');btn.type='button';btn.textContent='古い下書きの問題データを保存';btn.style.marginLeft='8px';btn.onclick=()=>fileDownload(validateDeck(draft.deck),'questions-old-draft.json');$('syncNotice').append(btn);
     }
    }catch(e){showAlert('syncNotice','端末の問題下書きを読み込めませんでした：'+e.message)}
   }
  }
  updateSaveNotice();initHandlers();updateView();$('studyApp').classList.remove('hidden');initCloud();
 }catch(error){
  console.error(error);
  showAlert('loadError','問題データを読み込めませんでした。HTMLを「ファイル」アプリで直接開くと正常に動作しない場合があります。index.html・app.js・styles.css・questions.jsonを同じGitHub Pagesリポジトリに置き、Safariで公開URLを開いてください。（'+error.message+'）');
  $('saveNotice').classList.add('hidden');
 }
}
init();
})();