const DB_NAME = 'szklo-witrazowe-db';
const STORE = 'items';
let db, items = [], editingId = null, activeId = null, pendingPhoto = null, activeView = 'glass';

const $ = id => document.getElementById(id);
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
    await putItem(item); items=await allItems(); itemDialog.close(); render();
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
    const normalized = data.items.map(x=>({...x,kind:x.kind==='gallery'?'gallery':'glass',createdAt:x.createdAt || Date.now(),updatedAt:x.updatedAt || x.createdAt || Date.now()}));
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
(async()=>{
  try { db=await openDB();items=await allItems();render(); }
  catch {toast('Ta przeglądarka nie obsługuje lokalnego zapisu. Otwórz aplikację w Safari.');}
})();
