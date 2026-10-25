const DB_NAME = 'szklo-witrazowe-db';
const STORE = 'items';
let db, items = [], editingId = null, activeId = null, pendingPhoto = null, activeView = 'glass';

const $ = id => document.getElementById(id);

// Supabase cloud sync. Publishable/anon key is intended for browser use; never put service_role here.
const SUPABASE_URL = 'https://fcromxczfjxvrptktzzb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-svgIsvfUfKwj1JBVX-k2Q_4Jl6AXUs';
const ADMIN_EMAIL = 'tomaszlubacz@icloud.com';
const CLOUD_BUCKET = 'witraz-zdjecia';
let cloud = null, cloudUser = null, cloudBusy = false, lastCloudSync = 0;
if (window.supabase?.createClient) cloud = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function cloudStatus(message) { const el = $('cloudStatus'); if (el) el.textContent = 'Supabase: ' + message; }
// Timestamps in older backups can be numbers or numeric strings (milliseconds).
function timestampMs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = (parts[0].match(/data:([^;]+)/) || [,'image/jpeg'])[1];
  const binary = atob(parts[1]); const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes], {type:mime});
}
function blobToDataUrl(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
}
async function uploadCloudItem(item) {
  if (!cloud || !cloudUser) return;
  const path = `${item.id}.jpg`;
  const blob = dataUrlToBlob(item.photo);
  const up = await cloud.storage.from(CLOUD_BUCKET).upload(path, blob, {contentType: blob.type || 'image/jpeg', upsert:true});
  if (up.error) throw up.error;
  const {data:pub} = cloud.storage.from(CLOUD_BUCKET).getPublicUrl(path);
  const stamp = timestampMs(item.updatedAt) || timestampMs(item.createdAt) || Date.now();
  const createdStamp = timestampMs(item.createdAt) || stamp;
  const row = {
    local_id: String(item.id),
    kind: item.kind === 'gallery' ? 'gallery' : 'glass',
    title: firstLine(item.description).slice(0,200) || 'Bez tytułu',
    description: item.description || '',
    image_url: pub.publicUrl,
    created_at: new Date(createdStamp).toISOString(),
    updated_at: new Date(stamp).toISOString()
  };
  const saved = await cloud.from('witraz_items').upsert(row, {onConflict:'local_id'});
  if (saved.error) throw saved.error;
}
async function syncLocalToCloud() {
  if (!cloudUser) throw new Error('Najpierw zaloguj administratora.');
  const local = await allItems();
  const {data: cloudRows, error} = await cloud.from('witraz_items').select('local_id,updated_at');
  if (error) throw error;
  const cloudMap = new Map((cloudRows || []).filter(x=>x.local_id).map(x=>[String(x.local_id), x]));
  for (let i=0;i<local.length;i++) {
    const item = local[i];
    const remote = cloudMap.get(String(item.id));
    const localStamp = timestampMs(item.updatedAt) || timestampMs(item.createdAt);
    const remoteStamp = timestampMs(remote?.updated_at);
    // Never upload an older local copy over a newer cloud copy.
    if (remote && remoteStamp >= localStamp) continue;
    cloudStatus(`wysyłanie nowszych wpisów ${i+1}/${local.length}…`);
    await uploadCloudItem(item);
  }
}
async function syncCloudToLocal() {
  if (!cloudUser) return;
  cloudStatus('pobieranie wpisów…');
  const {data:rows,error} = await cloud.from('witraz_items').select('local_id,kind,title,description,image_url,created_at,updated_at').not('local_id','is',null).order('created_at',{ascending:false});
  if (error) throw error;
  const local = await allItems();
  const localMap = new Map(local.map(x=>[String(x.id),x]));
  let downloaded = 0, skipped = 0;
  for (const row of (rows || [])) {
    if (!row.local_id || !row.image_url) continue;
    const old = localMap.get(String(row.local_id));
    const remoteStamp = timestampMs(row.updated_at) || timestampMs(row.created_at);
    const localStamp = timestampMs(old?.updatedAt) || timestampMs(old?.createdAt);
    // Existing local copy is already current (or newer); do not re-download its large photo.
    if (old && localStamp >= remoteStamp) { skipped++; continue; }
    cloudStatus(`pobieranie zdjęć ${downloaded+1}/${rows.length}…`);
    const resp = await fetch(row.image_url, {cache:'no-store'});
    if (!resp.ok) throw new Error('Nie udało się pobrać zdjęcia z magazynu.');
    const photo = await blobToDataUrl(await resp.blob());
    const item = {
      id: String(row.local_id), kind: row.kind === 'gallery' ? 'gallery' : 'glass',
      description: row.description || row.title || '', photo,
      createdAt: timestampMs(row.created_at) || (timestampMs(old?.createdAt) || Date.now()),
      updatedAt: remoteStamp || Date.now()
    };
    await putItem(item);
    localMap.set(String(item.id), item);
    downloaded++;
  }
  items = await allItems(); render();
  cloudStatus(`gotowe: ${downloaded} pobrano, ${skipped} już aktualnych; razem ${rows?.length || 0} w chmurze.`);
}

function cloudControls() {
  $('cloudLoginBtn').hidden = !!cloudUser;
  $('cloudLogoutBtn').hidden = !cloudUser;
  $('cloudSyncBtn').hidden = !cloudUser;
}
async function runCloudSync() {
  if (!cloud || !cloudUser || cloudBusy || !db) return;
  cloudBusy = true;
  $('cloudSyncBtn').disabled = true;
  try {
    await syncLocalToCloud();
    await syncCloudToLocal();
    lastCloudSync = Date.now();
    cloudStatus('połączono i zsynchronizowano.');
  } catch (err) {
    cloudStatus('błąd synchronizacji: ' + (err.message || 'nieznany'));
    throw err;
  } finally {
    cloudBusy = false;
    $('cloudSyncBtn').disabled = false;
  }
}
async function restoreCloudSession() {
  if (!cloud || !db) return;
  try {
    const {data: {session}, error} = await cloud.auth.getSession();
    if (error || !session) { cloudControls(); return; }
    const {data, error: userError} = await cloud.auth.getUser();
    if (userError || data.user?.email?.toLowerCase() !== ADMIN_EMAIL) {
      cloudUser = null; cloudControls(); return;
    }
    cloudUser = data.user;
    cloudControls();
    await runCloudSync();
  } catch(err) { cloudStatus('błąd: ' + (err.message || 'nieznany')); }
}
async function cloudLoginAndSync() {
  if (!cloud) throw new Error('Nie załadowała się biblioteka Supabase. Odśwież stronę.');
  const email = $('cloudEmail').value.trim().toLowerCase(), password = $('cloudPassword').value;
  if (email !== ADMIN_EMAIL) throw new Error('Użyj konta administratora aplikacji.');
  if (!password) throw new Error('Wpisz hasło.');
  cloudStatus('logowanie…');
  const {data,error} = await cloud.auth.signInWithPassword({email,password});
  if (error) throw error;
  cloudUser = data.user;
  if (cloudUser.email?.toLowerCase() !== ADMIN_EMAIL) { await cloud.auth.signOut(); cloudUser=null; throw new Error('To nie jest konto administratora.'); }
  $('cloudPassword').value='';
  cloudControls();
  // Merge by stable local_id and updated_at; older local copies do not overwrite newer cloud records.
  await runCloudSync();
}

const grid = $('grid'), empty = $('empty'), itemDialog = $('itemDialog'), detailDialog = $('detailDialog'), backupDialog = $('backupDialog');

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath:'id'});
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function allItems() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0)));
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || new Error('Nie udało się odczytać kolekcji.'));
  });
}
function putItem(item) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function deleteItem(id) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}
function shortText(text) { return text.length > 95 ? text.slice(0,92)+'…' : text; }
function render() {
  const q = $('search').value.trim().toLocaleLowerCase('pl');
  const filtered = items.filter(x => (x.kind || 'glass') === activeView && String(x.description || '').toLocaleLowerCase('pl').includes(q));
  grid.replaceChildren();
  empty.hidden = filtered.length > 0;
  grid.hidden = filtered.length === 0;
  const hasItemsInView = items.some(x => (x.kind || 'glass') === activeView);
  if (filtered.length === 0 && hasItemsInView && q) {
    empty.hidden = false; $('emptyTitle').textContent = 'Brak wyników';
    $('emptyText').textContent = 'Spróbuj wpisać inne słowo.'; $('emptyAdd').hidden = true;
  } else {
    $('emptyTitle').textContent = activeView === 'gallery' ? 'Galeria gotowych witraży' : 'Twoja kolekcja szkła';
    $('emptyText').textContent = activeView === 'gallery' ? 'Dodaj zdjęcia ukończonych witraży, aby stworzyć własną galerię.' : 'Dodaj pierwsze zdjęcie, aby rozpocząć katalogowanie.';
    $('emptyAdd').textContent = activeView === 'gallery' ? '＋ Dodaj witraż' : '＋ Dodaj szkło';
    $('emptyAdd').hidden = false;
  }
  filtered.forEach(item => {
    const card = document.createElement('article'); card.className='card'; card.tabIndex=0;
    const img = document.createElement('img'); img.src=item.photo; img.alt=activeView === 'gallery' ? 'Zdjęcie gotowego witrażu' : 'Zdjęcie szkła'; img.loading='lazy';
    const h = document.createElement('h3'); h.textContent = firstLine(item.description) || 'Bez opisu';
    const p = document.createElement('p'); p.textContent=shortText(item.description);
    card.append(img,h,p);
    card.addEventListener('click',()=>showDetail(item.id));
    card.addEventListener('keydown',e=>{if(e.key==='Enter')showDetail(item.id)});
    grid.append(card);
  });
}
function firstLine(s) { return s.split('\n').map(x=>x.trim()).find(Boolean)||''; }
function resetPhotoPreview() {
  $('photoPreview').hidden = true; $('photoPreview').removeAttribute('src');
  $('photoPlaceholder').hidden = false; $('removePhotoBtn').hidden = true;
}
function setPhotoPreview(data) {
  $('photoPreview').src=data; $('photoPreview').hidden=false;
  $('photoPlaceholder').hidden=true; $('removePhotoBtn').hidden=false;
}
function openEditor(id=null) {
  editingId=id; pendingPhoto=null;
  $('itemForm').reset(); resetPhotoPreview();
  const item=id ? items.find(x=>x.id===id) : null;
  $('dialogTitle').textContent=item ? ((item.kind === 'gallery') ? 'Edytuj witraż' : 'Edytuj szkło') : (activeView === 'gallery' ? 'Dodaj gotowy witraż' : 'Dodaj szkło');
  $('photoPlaceholder').querySelector('strong').textContent = 'Dodaj zdjęcie';
  $('photoPlaceholder').querySelector('span:last-child').textContent = 'Zrób zdjęcie lub wybierz z galerii';
  $('description').placeholder = activeView === 'gallery' ? 'Nazwa witrażu, miejsce, data lub inne informacje…' : 'Wpisz opis szkła…';
  if(item){$('description').value=item.description;pendingPhoto=item.photo;setPhotoPreview(item.photo);}
  itemDialog.showModal();
}
async function readPhoto(file) {
  if(!file) return null;
  if(!file.type || !file.type.startsWith('image/')) throw new Error('Wybierz plik graficzny.');
  // Use createImageBitmap when available, with an Image fallback for older iOS Safari.
  let source, width, height, cleanup = () => {};
  if (typeof createImageBitmap === 'function') {
    try {
      source = await createImageBitmap(file);
      width = source.width; height = source.height;
      cleanup = () => source.close?.();
    } catch (_) { /* Try the browser Image decoder below. */ }
  }
  if (!source) {
    const objectUrl = URL.createObjectURL(file);
    try {
      source = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Nie udało się otworzyć zdjęcia. Spróbuj wybrać je ponownie.'));
        img.src = objectUrl;
      });
      width = source.naturalWidth; height = source.naturalHeight;
      cleanup = () => URL.revokeObjectURL(objectUrl);
    } catch (err) { URL.revokeObjectURL(objectUrl); throw err; }
  }
  try {
    if (!width || !height) throw new Error('Plik nie zawiera czytelnego zdjęcia.');
    const max = 1800, scale = Math.min(1,max/Math.max(width,height));
    const canvas = document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(width*scale));
    canvas.height=Math.max(1,Math.round(height*scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Nie udało się przygotować zdjęcia.');
    context.drawImage(source,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',0.86);
  } finally { cleanup(); }
}
$('photoInput').addEventListener('change',async e=>{
  try { if(e.target.files[0]) { pendingPhoto=await readPhoto(e.target.files[0]); setPhotoPreview(pendingPhoto); } }
  catch(err){toast(err.message||'Nie udało się wczytać zdjęcia.');}
  e.target.value='';
});
$('removePhotoBtn').addEventListener('click',()=>{pendingPhoto=null;resetPhotoPreview();});
$('itemForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const description=$('description').value.trim();
  if(!description){toast(activeView === 'gallery' ? 'Wpisz opis witrażu.' : 'Wpisz opis szkła.');return;}
  if(!pendingPhoto){toast(activeView === 'gallery' ? 'Dodaj zdjęcie witrażu.' : 'Dodaj zdjęcie szkła.');return;}
  const old=editingId?items.find(x=>x.id===editingId):null;
  const item={id:editingId||crypto.randomUUID(),kind:old?.kind || activeView,description,photo:pendingPhoto,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
  try {
    await putItem(item); items=await allItems(); if (cloudUser) { try { await uploadCloudItem(item); } catch(err) { toast('Zapisano lokalnie; błąd synchronizacji: '+(err.message||'sprawdź połączenie')); } } itemDialog.close(); render();
    if(activeId===item.id) showDetail(item.id);
    toast(old?'Zapisano zmiany.':(item.kind === 'gallery' ? 'Dodano witraż do galerii.' : 'Dodano szkło.'));
  } catch {toast('Nie udało się zapisać. Sprawdź wolne miejsce na urządzeniu.');}
});
$('cancelBtn').addEventListener('click',()=>itemDialog.close());
$('addBtn').addEventListener('click',()=>openEditor());
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{activeView=btn.dataset.view;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b===btn));$('search').value='';$('addBtn').setAttribute('aria-label',activeView==='gallery'?'Dodaj witraż':'Dodaj szkło');render();}));
$('emptyAdd').addEventListener('click',()=>openEditor());
$('search').addEventListener('input',render);
function showDetail(id) {
  const item=items.find(x=>x.id===id); if(!item)return;
  activeId=id; $('detailPhoto').src=item.photo; $('detailDescription').textContent=item.description;
  const isGallery = item.kind === 'gallery';
  $('detailDialog').querySelector('.dialog-head strong').textContent = isGallery ? 'Gotowy witraż' : 'Szkło';
  $('detailPhoto').alt = isGallery ? 'Zdjęcie gotowego witrażu' : 'Zdjęcie szkła';
  $('detailDescription').previousElementSibling.textContent = isGallery ? 'Opis witrażu' : 'Opis szkła';
  $('changePhotoBtn').textContent = isGallery ? '▧ Zmień zdjęcie witrażu' : '▧ Zmień zdjęcie szkła';
  $('editBtn').textContent = isGallery ? '✎ Edytuj opis witrażu' : '✎ Edytuj opis szkła';
  $('detailDate').textContent='Dodano: '+new Date(item.createdAt || Date.now()).toLocaleDateString('pl-PL');
  detailDialog.showModal();
}
$('detailBack').addEventListener('click',()=>detailDialog.close());
$('editBtn').addEventListener('click',()=>{detailDialog.close();openEditor(activeId);});
$('changePhotoBtn').addEventListener('click',()=>{detailDialog.close();openEditor(activeId);$('photoInput').click();});
$('deleteBtn').addEventListener('click',async()=>{
  if(!activeId)return;
  if(confirm('Usunąć ten wpis ze zdjęciem? Tej operacji nie można cofnąć.')){
    const deleting = items.find(x=>x.id===activeId);
    if (cloudUser) {
      const {error} = await cloud.from('witraz_items').delete().eq('local_id', String(activeId));
      if (error) { toast('Nie usunięto z Supabase: '+error.message); return; }
      await cloud.storage.from(CLOUD_BUCKET).remove([`${activeId}.jpg`]);
    }
    await deleteItem(activeId);items=await allItems();detailDialog.close();render();toast('Usunięto wpis.');
  }
});
$('backupBtn').addEventListener('click',()=>backupDialog.showModal());
$('backupClose').addEventListener('click',()=>backupDialog.close());
$('exportBtn').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({format:'szklo-witrazowe-backup-v1',items},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url;a.download='kopia-szkla-witrazowego-'+new Date().toISOString().slice(0,10)+'.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Przygotowano kopię zapasową.');
});
$('importInput').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try {
    const data=JSON.parse(await file.text());
    if(!data || !Array.isArray(data.items) || !data.items.every(x => x && x.id && typeof x.description === 'string' && typeof x.photo === 'string' && x.photo.startsWith('data:image/'))) {
      throw new Error('Nieprawidłowy format kopii.');
    }
    const normalized = data.items.map(x=>({...x,kind:x.kind==='gallery'?'gallery':'glass',createdAt:timestampMs(x.createdAt) || Date.now(),updatedAt:timestampMs(x.updatedAt) || timestampMs(x.createdAt) || Date.now()}));
    if(!confirm('Import zastąpi obecną kolekcję. Najpierw wyeksportuj kopię, jeśli chcesz zachować obecne wpisy. Kontynuować?'))return;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      const store=tx.objectStore(STORE);
      store.clear();
      normalized.forEach(x=>store.put(x));
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error || new Error('Import nie powiódł się.'));
      tx.onabort=()=>reject(tx.error || new Error('Import został przerwany.'));
    });
    items=await allItems();render();backupDialog.close();toast('Zaimportowano kopię.');
  } catch(err) {
    toast(err?.message === 'Nieprawidłowy format kopii.' ? err.message : 'Nie udało się zaimportować kopii. Obecna kolekcja powinna pozostać bez zmian.');
  } finally {e.target.value='';}
});

$('cloudLoginBtn').addEventListener('click', async()=>{
  if (cloudBusy) return;
  $('cloudLoginBtn').disabled=true;
  try { await cloudLoginAndSync(); toast('Synchronizacja zakończona.'); }
  catch(err) { cloudStatus('błąd: '+(err.message||'nieznany')); toast('Nie udało się zsynchronizować: '+(err.message||'sprawdź ustawienia Supabase')); }
  finally { $('cloudLoginBtn').disabled=false; }
});
$('cloudSyncBtn').addEventListener('click', async()=>{
  try { await runCloudSync(); toast('Synchronizacja zakończona.'); }
  catch(err) { toast('Błąd synchronizacji: '+(err.message||'nieznany')); }
});
$('cloudLogoutBtn').addEventListener('click', async()=>{
  if (cloud) await cloud.auth.signOut(); cloudUser=null;
  cloudControls();
  cloudStatus('wylogowano; dane lokalne pozostały na urządzeniu.');
});
if (!cloud) cloudStatus('biblioteka niedostępna.');

// When returning to the app, check for changes on other devices.
document.addEventListener('visibilitychange', ()=>{
  if (!document.hidden && cloudUser && !cloudBusy && Date.now()-lastCloudSync > 30000) {
    runCloudSync().catch(err=>cloudStatus('błąd synchronizacji: '+(err.message||'nieznany')));
  }
});

(async()=>{
  try { db=await openDB();items=await allItems();render(); await restoreCloudSession(); }
  catch {toast('Nie udało się otworzyć lokalnej bazy danych.');}
})();
