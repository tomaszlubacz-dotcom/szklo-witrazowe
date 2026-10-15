const DB_NAME = 'szklo-witrazowe-db';
const STORE = 'items';
let db, items = [], editingId = null, activeId = null, pendingPhoto = null;

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
    req.onsuccess = () => resolve(req.result.sort((a,b) => b.createdAt-a.createdAt));
    req.onerror = () => reject(req.error);
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
  const filtered = items.filter(x => x.description.toLocaleLowerCase('pl').includes(q));
  grid.replaceChildren();
  empty.hidden = filtered.length > 0;
  grid.hidden = filtered.length === 0;
  if (items.length && filtered.length === 0) {
    empty.hidden = false;
    empty.querySelector('h2').textContent = 'Brak wyników';
    empty.querySelector('p').textContent = 'Spróbuj wpisać inne słowo.';
    $('emptyAdd').hidden = true;
  } else {
    empty.querySelector('h2').textContent = 'Twoja kolekcja szkła';
    empty.querySelector('p').textContent = 'Dodaj pierwsze zdjęcie, aby rozpocząć katalogowanie.';
    $('emptyAdd').hidden = false;
  }
  filtered.forEach(item => {
    const card = document.createElement('article'); card.className='card'; card.tabIndex=0;
    const img = document.createElement('img'); img.src=item.photo; img.alt='Zdjęcie szkła';
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
  $('dialogTitle').textContent=item?'Edytuj szkło':'Dodaj szkło';
  if(item){$('description').value=item.description;pendingPhoto=item.photo;setPhotoPreview(item.photo);}
  itemDialog.showModal();
}
async function readPhoto(file) {
  if(!file) return null;
  if(!file.type.startsWith('image/')) throw new Error('Wybierz plik graficzny.');
  // Resize large photos to keep the local catalog manageable.
  const bitmap = await createImageBitmap(file);
  const max = 1800, scale = Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale);
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg',0.86);
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
  if(!description){toast('Wpisz opis szkła.');return;}
  if(!pendingPhoto){toast('Dodaj zdjęcie szkła.');return;}
  const old=editingId?items.find(x=>x.id===editingId):null;
  const item={id:editingId||crypto.randomUUID(),description,photo:pendingPhoto,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now()};
  try {
    await putItem(item); items=await allItems(); itemDialog.close(); render();
    if(activeId===item.id) showDetail(item.id);
    toast(old?'Zapisano zmiany.':'Dodano szkło.');
  } catch {toast('Nie udało się zapisać. Sprawdź wolne miejsce na urządzeniu.');}
});
$('cancelBtn').addEventListener('click',()=>itemDialog.close());
$('addBtn').addEventListener('click',()=>openEditor());
$('emptyAdd').addEventListener('click',()=>openEditor());
$('search').addEventListener('input',render);
function showDetail(id) {
  const item=items.find(x=>x.id===id); if(!item)return;
  activeId=id; $('detailPhoto').src=item.photo; $('detailDescription').textContent=item.description;
  $('detailDate').textContent='Dodano: '+new Date(item.createdAt).toLocaleDateString('pl-PL');
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
    if(!Array.isArray(data.items)||!data.items.every(x=>x.id&&x.description&&x.photo))throw new Error();
    if(!confirm('Import zastąpi obecną kolekcję. Najpierw wyeksportuj kopię, jeśli chcesz zachować obecne wpisy. Kontynuować?'))return;
    const tx=db.transaction(STORE,'readwrite'), store=tx.objectStore(STORE);store.clear();data.items.forEach(x=>store.put(x));
    tx.oncomplete=async()=>{items=await allItems();render();backupDialog.close();toast('Zaimportowano kopię.');};
  } catch {toast('Nie udało się odczytać kopii JSON.');}
  finally {e.target.value='';}
});
(async()=>{
  try { db=await openDB();items=await allItems();render(); }
  catch {toast('Ta przeglądarka nie obsługuje lokalnego zapisu. Otwórz aplikację w Safari.');}
})();
