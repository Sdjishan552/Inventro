import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, updateDoc, serverTimestamp, writeBatch, onSnapshot, runTransaction, enableMultiTabIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Your Firebase project. Not a secret — see SETUP-EASY.md for why. ----
const firebaseConfig = {
  apiKey: "AIzaSyCag4m0CcdPTzy2NpGPKyItU-Lhn47i2bw",
  authDomain: "inventropro.firebaseapp.com",
  projectId: "inventropro",
  storageBucket: "inventropro.firebasestorage.app",
  messagingSenderId: "1028605077228",
  appId: "1:1028605077228:web:273f8d8bf6b7284be0a7c9"
};

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
enableMultiTabIndexedDbPersistence(db).catch(() => {});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

function signInWithGoogle() { return signInWithPopup(auth, provider); }
function signOut() { return fbSignOut(auth); }

function randomSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function getMyMembership() {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'memberships', uid));
  return snap.exists() ? snap.data() : null;
}

async function createCompany(companyName) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  const name = companyName.trim();
  if (!name) throw new Error('Company name is required.');
  const nameLower = name.toLowerCase();
  const companyRef = doc(collection(db, 'companies'));
  const emailLower = user.email.toLowerCase();

  let code;
  for (let i = 0; i < 8; i++) {
    const candidate = randomSixDigitCode();
    const codeSnap = await getDoc(doc(db, 'codes', candidate));
    if (!codeSnap.exists()) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not generate a unique code. Please try again.');

  try {
    await setDoc(companyRef, {
      name, nameLower, code, ownerUid: user.uid, ownerEmail: emailLower, createdAt: serverTimestamp()
    });
    await setDoc(doc(db, 'codes', code), { companyId: companyRef.id, reservedBy: user.uid });
    await setDoc(doc(db, 'companies', companyRef.id, 'employees', emailLower), {
      email: emailLower, role: 'admin',
      tabs: ['stock', 'receive', 'dispatch', 'admin', 'stats', 'history', 'logbook'],
      status: 'active', addedAt: serverTimestamp(), joinedAt: serverTimestamp(), uid: user.uid
    });
    await setDoc(doc(db, 'memberships', user.uid), {
      companyId: companyRef.id, companyName: name, role: 'admin', email: emailLower
    });
    return { companyId: companyRef.id, code };
  } catch (err) {
    await deleteDoc(companyRef).catch(() => {});
    if (code) await deleteDoc(doc(db, 'codes', code)).catch(() => {});
    throw err;
  }
}


async function verifyEmployeeCode(code) {
  const user = auth.currentUser;
  const companyId = membership?.companyId;
  if (!user || !companyId) throw new Error('Your employee session is not available.');

  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new Error('Enter the 6-digit company code exactly as given by your admin.');
  }

  const codeSnap = await getDoc(doc(db, 'codes', cleanCode));
  if (!codeSnap.exists()) {
    throw new Error("That code doesn't match your company.");
  }

  const { companyId: codeCompanyId } = codeSnap.data();
  if (codeCompanyId !== companyId) {
    throw new Error('That company code does not belong to your company.');
  }

  const emailLower = user.email.toLowerCase();
  const employeeSnap = await getDoc(doc(db, 'companies', companyId, 'employees', emailLower));
  if (!employeeSnap.exists()) {
    throw new Error('Your email is not registered as an employee of this company.');
  }

  const employee = employeeSnap.data();
  if (employee.role === 'admin') {
    throw new Error('Admin accounts do not use employee code verification.');
  }
  if (employee.status !== 'active') {
    throw new Error('Your employee access is not active. Ask the admin to enable your login.');
  }

  const allowedDays = Array.isArray(employee.workingDays)
    ? employee.workingDays
    : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  if (!allowedDays.includes(todayKey())) {
    throw new Error(`You do not have Inventro access today. Your allowed days are: ${allowedDays.map(d => WEEK_DAYS.find(([key]) => key === d)?.[1] || d).join(', ')}.`);
  }

  sessionStorage.setItem('inventroEmployeeVerified', companyId);
  return true;
}

function isEmployeeCodeVerified(companyId) {
  return sessionStorage.getItem('inventroEmployeeVerified') === companyId;
}

function clearEmployeeCodeVerification() {
  sessionStorage.removeItem('inventroEmployeeVerified');
}

async function joinCompany(code) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) throw new Error('Enter the 6-digit code exactly as given by your admin.');

  const codeSnap = await getDoc(doc(db, 'codes', cleanCode));
  if (!codeSnap.exists()) throw new Error("That code doesn't match any company. Double-check it with your admin.");
  const { companyId } = codeSnap.data();

  const emailLower = user.email.toLowerCase();
  const employeeRef = doc(db, 'companies', companyId, 'employees', emailLower);
  const employeeSnap = await getDoc(employeeRef);
  if (!employeeSnap.exists()) {
    throw new Error(`Your admin hasn't added ${user.email} to this company yet. Ask them to add your email first.`);
  }
  const employee = employeeSnap.data();
  if (employee.status === 'active') throw new Error('This account has already joined the company.');
  if (employee.status === 'disabled') throw new Error('Your Inventro login has been disabled by the company admin.');
  if (employee.role === 'admin') throw new Error('Admin accounts cannot join as employees.');

  const allowedDays = Array.isArray(employee.workingDays) ? employee.workingDays : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  if (!allowedDays.includes(todayKey())) {
    throw new Error(`You do not have Inventro access today. Your allowed days are: ${allowedDays.map(d => WEEK_DAYS.find(([key]) => key === d)?.[1] || d).join(', ')}.`);
  }

  await setDoc(employeeRef, { status: 'active', uid: user.uid, joinedAt: serverTimestamp() }, { merge: true });
  const companySnap = await getDoc(doc(db, 'companies', companyId));
  await setDoc(doc(db, 'memberships', user.uid), {
    companyId, companyName: companySnap.data()?.name ?? '', role: employee.role, email: emailLower
  });
  return { companyId, role: employee.role };
}

function friendlyError(err) {
  if (err?.code === 'auth/popup-closed-by-user') return 'Sign-in was closed before finishing. Try again.';
  return err?.message || 'Something went wrong. Please try again.';
}


function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[char]));
}

function currentCompanyId() {
  return membership?.companyId || null;
}

const WEEK_DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday']
];

function todayKey() {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getDay()];
}

async function listEmployees() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  const snap = await getDocs(collection(db, 'companies', companyId, 'employees'));
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }))
    .filter((employee) => employee.role !== 'admin');
}

async function listDepartments() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  const snap = await getDocs(collection(db, 'companies', companyId, 'departments'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a,b) => (a.nameLower || a.name || '').localeCompare(b.nameLower || b.name || '', undefined, {sensitivity:'base'}));
}

async function createDepartment(name) {
  const companyId = currentCompanyId();
  if (!companyId || membership?.role !== 'admin') throw new Error('Only the company Admin can manage departments.');
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (clean.length < 2) throw new Error('Enter a valid department name.');
  const existing = await getDocs(collection(db, 'companies', companyId, 'departments'));
  if (existing.docs.some(d => String(d.data()?.nameLower || d.data()?.name || '').trim().toLowerCase() === clean.toLowerCase())) {
    throw new Error('That department already exists.');
  }
  const ref = doc(collection(db, 'companies', companyId, 'departments'));
  await setDoc(ref, { name: clean, nameLower: clean.toLowerCase(), createdAt: serverTimestamp(), createdByUid: auth.currentUser?.uid || '', createdByEmail: auth.currentUser?.email?.toLowerCase() || '' });
}

async function deleteDepartment(departmentId) {
  const companyId = currentCompanyId();
  if (!companyId || membership?.role !== 'admin') throw new Error('Only the company Admin can manage departments.');
  await deleteDoc(doc(db, 'companies', companyId, 'departments', departmentId));
}

async function addEmployee(email, role, workingDays) {
  const companyId = currentCompanyId();
  const admin = auth.currentUser;
  if (!companyId || !admin) throw new Error('Your company session is not available.');
  const cleanEmail = email.trim().toLowerCase();

  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Enter a valid employee Gmail address.');
  }
  if (cleanEmail === admin.email.toLowerCase()) {
    throw new Error('The owner account is already the admin. Add a different employee email.');
  }
  if (!['inventory_manager', 'chef', 'request'].includes(role)) {
    throw new Error('Choose a valid employee role.');
  }
  if (!Array.isArray(workingDays) || workingDays.length === 0) {
    throw new Error('Select at least one access day.');
  }

  const employeeRef = doc(db, 'companies', companyId, 'employees', cleanEmail);
  const existing = await getDoc(employeeRef);
  if (existing.exists()) {
    throw new Error('This email is already in the company team.');
  }

  await setDoc(employeeRef, {
    email: cleanEmail,
    role,
    workingDays,
    status: 'invited',
    addedBy: admin.uid,
    addedAt: serverTimestamp()
  });
}

async function updateEmployee(employeeEmail, changes) {
  const companyId = currentCompanyId();
  if (!companyId) throw new Error('Company session is not available.');
  await updateDoc(doc(db, 'companies', companyId, 'employees', employeeEmail), changes);
}


const INVENTORY_UNITS = [
  'kg','gram','ton','liter','ml','packet','sack','piece','bottle',
  'box','dozen','tray','carton','bag','can','jar','tin','bundle','set'
];

function formatDate(value) {
  if (!value) return 'Not updated yet';
  const d = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return 'Not updated yet';
  const day=String(d.getDate()).padStart(2,'0');
  const month=String(d.getMonth()+1).padStart(2,'0');
  const year=d.getFullYear();
  const time=d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});
  return `${day}-${month}-${year}, ${time}`;
}

function localDateKey(d=new Date()){const x=d instanceof Date?d:new Date(d);const y=x.getFullYear();const m=String(x.getMonth()+1).padStart(2,'0');const day=String(x.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}

async function fetchItemImage(itemName) {
  const clean = itemName.trim();
  if (!clean) return {url:'',source:''};

  // 1) Wikipedia: useful for generic ingredients such as rice, flour, milk, etc.
  try {
    const title = encodeURIComponent(clean.replace(/\s+/g,'_'));
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {headers:{'Accept':'application/json'}});
    if (r.ok) {
      const data = await r.json();
      const url = data?.thumbnail?.source || data?.originalimage?.source || '';
      if (url) return {url,source:'Wikipedia'};
    }
  } catch (_) {}

  // 2) Wikimedia Commons search: broader image search for food/product names.
  try {
    const q = encodeURIComponent(clean);
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=300&format=json&origin=*`);
    if (r.ok) {
      const data = await r.json();
      const pages = Object.values(data?.query?.pages || {});
      const page = pages.find(x => {
        const t = (x.title || '').toLowerCase();
        return !/logo|icon|map|flag|diagram|screenshot/.test(t) && x.imageinfo?.[0];
      });
      const info = page?.imageinfo?.[0];
      const url = info?.thumburl || info?.url || '';
      if (url) return {url,source:'Wikimedia Commons'};
    }
  } catch (_) {}

  // 3) Open Food Facts: particularly useful for packaged/branded food products.
  try {
    const q = encodeURIComponent(clean);
    const r = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=8`);
    if (r.ok) {
      const data = await r.json();
      const product = (data.products || []).find(x => x.image_front_small_url || x.image_front_url || x.image_url);
      const url = product?.image_front_small_url || product?.image_front_url || product?.image_url || '';
      if (url) return {url,source:'Open Food Facts'};
    }
  } catch (_) {}

  return {url:'',source:''};
}

async function listItems() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  const snap = await getDocs(collection(db,'companies',companyId,'items'));
  const items = snap.docs.map(d => ({id:d.id,...d.data()}));

  // Older items created before automatic images was improved can be upgraded
  // automatically when viewed by Admin/Inventory Manager.
  if (canInventoryOperate()) {
    for (const item of items) {
      if (!item.imageUrl) {
        const found = await fetchItemImage(item.name || '');
        if (found.url) {
          try {
            await updateDoc(doc(db,'companies',companyId,'items',item.id), {
              imageUrl:found.url, imageSource:found.source, imageCheckedAt:serverTimestamp()
            });
            item.imageUrl = found.url;
            item.imageSource = found.source;
          } catch (_) {}
        }
      }
    }
  }

  return items.sort((a,b)=>(a.nameLower||'').localeCompare(b.nameLower||''));
}

async function createInventoryItem({name,unit,openingStock,lowStockAlert}) {
  const companyId = currentCompanyId(), user = auth.currentUser;
  if (!companyId || !user) throw new Error('Your company session is not available.');
  if (!canManageItems()) throw new Error('Only Admin can add inventory items.');
  const cleanName = name.trim().replace(/\s+/g,' ');
  const nameLower = cleanName.toLowerCase();
  const quantity = Number(openingStock), low = Number(lowStockAlert);
  if (cleanName.length < 2) throw new Error('Enter a valid item name.');
  if (!INVENTORY_UNITS.includes(unit)) throw new Error('Choose a valid unit.');
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Opening stock must be 0 or more.');
  if (!Number.isFinite(low) || low < 0) throw new Error('Low stock alert must be 0 or more.');

  const existingItems=await getDocs(collection(db,'companies',companyId,'items'));
  if(existingItems.docs.some(d=>String(d.data()?.nameLower||d.data()?.name||'').trim().toLowerCase()===nameLower)) throw new Error('This item name already exists. Names are not case-sensitive.');
  const id = nameLower.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60);
  if (!id) throw new Error('The item name could not be used.');
  const ref = doc(db,'companies',companyId,'items',id);
  if ((await getDoc(ref)).exists()) throw new Error('This item already exists.');

  const imageUrl = await fetchItemImage(cleanName);
  await setDoc(ref,{
    name:cleanName,nameLower,unit,quantity,lowStockAlert:low,
    imageUrl:imageUrl.url || '',imageSource:imageUrl.source || '',
    createdAt:serverTimestamp(),updatedAt:serverTimestamp(),
    updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase() || ''
  });
  await setDoc(doc(ref,'movements',`${Date.now()}-opening`),{
    type:'opening',quantity,unit,note:'Opening stock',
    byUid:user.uid,byEmail:user.email?.toLowerCase() || '',byRole:membership?.role || '',createdAt:serverTimestamp()
  });
}

async function changeStock(itemId, amount, type, note='', options={}) {
  const companyId = currentCompanyId(), user = auth.currentUser;
  if (!companyId || !user) throw new Error('Your company session is not available.');
  if (type === 'dispatch' && !canDirectDispatch()) throw new Error('Only Admin and Inventory Manager can dispatch stock directly.');
  if (type === 'receive' && !canReceiveStock()) throw new Error('Only Admin and Inventory Manager can receive stock.');
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a quantity greater than 0.');
  const ref = doc(db,'companies',companyId,'items',itemId);
  const movementRef = doc(collection(ref,'movements'));
  const fulfillOrder = type === 'receive' && options.fulfillOutstandingOrder === true;
  const cleanDepartment = type === 'dispatch' ? String(options.department || '').trim() : '';
  if (type === 'dispatch' && !cleanDepartment) throw new Error('Select the department receiving this stock.');
  if (type === 'dispatch') { const departments = await listDepartments(); if (!departments.some(d => d.name === cleanDepartment)) throw new Error('Select a valid department.'); }
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('That item no longer exists. Refresh the stock list.');
    const item = snap.data(), current = Number(item.quantity || 0);
    const next = type === 'dispatch' ? current - n : current + n;
    if (type === 'dispatch' && n > current) throw new Error(`Not enough ${item.name} in stock. Available: ${current} ${item.unit}.`);
    const update = {quantity:next,updatedAt:serverTimestamp(),updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase() || ''};
    if (fulfillOrder && item.procurementStatus === 'ordered') {
      update.procurementStatus = 'fulfilled';
      update.procurementFulfilledAt = serverTimestamp();
      update.procurementFulfilledByUid = user.uid;
      update.procurementFulfilledByEmail = user.email?.toLowerCase() || '';
    }
    tx.update(ref,update);
    tx.set(movementRef,{type,quantity:n,unit:item.unit,department:cleanDepartment,note:note.trim(),byUid:user.uid,byEmail:user.email?.toLowerCase() || '',byRole:membership?.role || '',createdAt:serverTimestamp(),
      ...(fulfillOrder && item.procurementStatus === 'ordered' ? {procurementEvent:'order_fulfilled',orderId:item.procurementOrderId||'',orderSentAt:item.procurementOrderSentAt||null} : {})
    });
    if (fulfillOrder && item.procurementStatus === 'ordered') {
      tx.set(doc(collection(ref,'movements')),{type:'order_fulfilled',quantity:n,unit:item.unit,note:`Supplier order fulfilled${item.procurementOrderId?` (${item.procurementOrderId})`:''}`,orderId:item.procurementOrderId||'',byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',createdAt:serverTimestamp()});
    }
  });
}

function canManageItems() {
  // Adding new inventory items is an Admin-only function and is exposed only inside Admin.
  return membership?.role === 'admin';
}
function canInventoryOperate() {
  return ['admin','inventory_manager'].includes(membership?.role);
}
function canDirectDispatch() { return canInventoryOperate(); }
function canReceiveStock() { return canInventoryOperate(); }
function canCreateRequest() { return ['inventory_manager','chef','request'].includes(membership?.role); }
function canManageRequests() { return membership?.role === 'inventory_manager'; }

async function listRequests() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  const snap = await getDocs(collection(db,'companies',companyId,'requests'));
  return snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
    const at=a.createdAt?.toMillis?.()||0, bt=b.createdAt?.toMillis?.()||0; return bt-at;
  });
}

async function listRequestEvents() {
  const companyId=currentCompanyId();
  if(!companyId) return [];
  const requests=await listRequests();
  const events=[];
  for(const r of requests){
    const snap=await getDocs(collection(db,'companies',companyId,'requests',r.id,'events'));
    snap.docs.forEach(d=>events.push({id:d.id,requestId:r.id,...d.data()}));
    // Backward-compatible fallback for old requests that predate event logging.
    if(!snap.docs.length){
      events.push({id:`legacy-${r.id}-pending`,requestId:r.id,eventType:'pending',itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||'',actorUid:r.requestedByUid||'',actorEmail:r.requestedByEmail||'',actorRole:r.requestedByRole||'',createdAt:r.createdAt});
      if(r.status && r.status!=='pending'){
        events.push({id:`legacy-${r.id}-${r.status}`,requestId:r.id,eventType:r.status,itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||'',actorUid:r.fulfilledByUid||r.reviewedByUid||'',actorEmail:r.fulfilledByEmail||r.reviewedByEmail||'',actorRole:'inventory_manager',createdAt:r.updatedAt||r.createdAt});
      }
    }
  }
  return events.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
}

async function createStockRequest({itemId,quantity,department,note=''}) {
  const companyId=currentCompanyId(), user=auth.currentUser;
  if (!companyId || !user) throw new Error('Your company session is not available.');
  if (!canCreateRequest()) throw new Error('You do not have permission to create a stock request.');
  const n=Number(quantity);
  if (!Number.isFinite(n)||n<=0) throw new Error('Enter a quantity greater than 0.');
  const cleanDepartment = String(department || '').trim();
  if (!cleanDepartment) throw new Error('Select the department this request is for.');
  const departments = await listDepartments();
  if (!departments.some(d => d.name === cleanDepartment)) throw new Error('Select a valid department.');
  const itemSnap=await getDoc(doc(db,'companies',companyId,'items',itemId));
  if(!itemSnap.exists()) throw new Error('That item no longer exists. Refresh and try again.');
  const item=itemSnap.data();
  const requestRef = doc(collection(db,'companies',companyId,'requests'));
  const requestData={itemId,itemName:item.name,quantity:n,unit:item.unit,note:note.trim(),status:'pending',notificationBatchId:requestRef.id,notificationBatchCreatedAt:Date.now(),department:cleanDepartment,requestedByUid:user.uid,requestedByEmail:user.email?.toLowerCase()||'',requestedByRole:membership?.role||'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()};
  await setDoc(requestRef,requestData);
  await setDoc(doc(collection(db,'companies',companyId,'requests',requestRef.id,'events')),{
    requestId:requestRef.id,eventType:'pending',itemId,itemName:item.name,quantity:n,unit:item.unit,department:cleanDepartment,
    requestedByUid:user.uid,requestedByEmail:user.email?.toLowerCase()||'',requestedByRole:membership?.role||'',
    actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()
  });
}

async function createRequestNotification(requestId, requestData, status, extraMessage='') {
  const companyId = currentCompanyId(), user = auth.currentUser;
  if (!companyId || !user || membership?.role !== 'inventory_manager' || !requestData?.requestedByUid) return;
  let title = 'Request update';
  let message = extraMessage || `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} was updated.`;
  if (status === 'approved') {
    title = 'Request approved';
    message = `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} has been approved.`;
  } else if (status === 'rejected') {
    title = 'Request rejected';
    message = `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} was rejected.`;
  } else if (status === 'fulfilled') {
    title = 'Request fulfilled';
    message = `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} has been dispatched and fulfilled.`;
  } else if (status === 'stock_unavailable') {
    title = 'Not enough stock';
    message = extraMessage || `Your request for ${requestData.itemName} — ${requestData.quantity} ${requestData.unit} cannot be approved right now because there is not enough stock. The request remains pending.`;
  }
  await setDoc(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')), {
    recipientUid: requestData.requestedByUid,
    requestId,
    batchId: requestData.notificationBatchId || requestId,
    notificationBatchId: requestData.notificationBatchId || requestId,
    type: 'request_status',
    status,
    title,
    message,
    read: false,
    createdAt: serverTimestamp()
  });
}

async function updateRequestStatus(requestId,status) {
  const companyId=currentCompanyId(), user=auth.currentUser;
  if(!companyId||!user||!canManageRequests()) throw new Error('Only Inventory Manager can manage requests.');
  if(!['approved','rejected'].includes(status)) throw new Error('Invalid request status.');
  const requestRef = doc(db,'companies',companyId,'requests',requestId);
  const result = await runTransaction(db, async(tx) => {
    const reqSnap = await tx.get(requestRef);
    if(!reqSnap.exists()) throw new Error('That request no longer exists.');
    const requestData = reqSnap.data();
    if(requestData.status !== 'pending') throw new Error(`This request is already ${requestData.status || 'processed'}.`);

    if(status === 'approved') {
      const itemRef = doc(db,'companies',companyId,'items',requestData.itemId);
      const itemSnap = await tx.get(itemRef);
      if(!itemSnap.exists()) throw new Error('The requested item no longer exists.');
      const item = itemSnap.data();
      const current = Number(item.quantity || 0);
      const requested = Number(requestData.quantity || 0);
      if(!Number.isFinite(requested) || requested <= 0) throw new Error('The request has an invalid quantity.');
      if(requested > current) {
        const eventRef = doc(collection(requestRef,'events'));
        tx.set(eventRef,{requestId,eventType:'stock_unavailable',batchId:requestData.notificationBatchId || requestId,notificationBatchId:requestData.notificationBatchId || requestId,itemId:requestData.itemId,itemName:requestData.itemName,quantity:requested,unit:requestData.unit||item.unit||'',availableQuantity:current,department:requestData.department||'',requestedByUid:requestData.requestedByUid||'',requestedByEmail:requestData.requestedByEmail||'',requestedByRole:requestData.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()});
        if(requestData.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')),{recipientUid:requestData.requestedByUid,requestId,batchId:requestData.notificationBatchId || requestId,type:'request_status',status:'stock_unavailable',title:'Not enough stock',message:`Your request for ${requestData.itemName} — ${requested} ${requestData.unit || item.unit || ''} cannot be approved right now. Available stock: ${current} ${item.unit || requestData.unit || ''}. The request remains pending.`,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
        return {approved:false, requestData, available:current, unit:item.unit || requestData.unit || ''};
      }
    }

    tx.update(requestRef,{status,updatedAt:serverTimestamp(),reviewedByUid:user.uid,reviewedByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(collection(requestRef,'events')),{requestId,eventType:status,batchId:requestData.notificationBatchId || requestId,notificationBatchId:requestData.notificationBatchId || requestId,itemId:requestData.itemId,itemName:requestData.itemName,quantity:Number(requestData.quantity||0),unit:requestData.unit||'',department:requestData.department||'',requestedByUid:requestData.requestedByUid||'',requestedByEmail:requestData.requestedByEmail||'',requestedByRole:requestData.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()});
    if(requestData.requestedByUid) {
      const title = status === 'approved' ? 'Request approved' : 'Request rejected';
      const message = status === 'approved'
        ? `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} has been approved.`
        : `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} was rejected.`;
      tx.set(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')),{recipientUid:requestData.requestedByUid,requestId,batchId:requestData.notificationBatchId || requestId,type:'request_status',status,title,message,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
    }
    return {approved:status==='approved', requestData, available:null, unit:requestData.unit||''};
  });

  if(status==='approved' && !result.approved) {
    throw new Error(`Not enough ${result.requestData.itemName} in stock. Requested: ${result.requestData.quantity} ${result.requestData.unit || result.unit}. Available: ${result.available} ${result.unit}. The request remains pending.`);
  }
}

async function fulfillRequest(requestId) {
  const companyId=currentCompanyId(), user=auth.currentUser;
  if(!companyId||!user||!canManageRequests()) throw new Error('Only Inventory Manager can dispatch approved requests.');
  const requestRef=doc(db,'companies',companyId,'requests',requestId);
  const movementId=`request-${requestId}-${Date.now()}`;
  const result = await runTransaction(db,async(tx)=>{
    const reqSnap=await tx.get(requestRef);
    if(!reqSnap.exists()) throw new Error('That request no longer exists.');
    const req=reqSnap.data();
    if(req.status!=='approved') throw new Error('Only approved requests can be dispatched.');
    const itemRef=doc(db,'companies',companyId,'items',req.itemId);
    const itemSnap=await tx.get(itemRef);
    if(!itemSnap.exists()) throw new Error('The requested item no longer exists.');
    const item=itemSnap.data(), current=Number(item.quantity||0), n=Number(req.quantity||0);
    if(n<=0) throw new Error('The request has an invalid quantity.');
    if(n>current) {
      if(req.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',req.requestedByUid,'notifications')),{recipientUid:req.requestedByUid,requestId,batchId:req.notificationBatchId || requestId,notificationBatchId:req.notificationBatchId || requestId,type:'request_status',status:'stock_unavailable',title:'Not enough stock',message:`Your approved request for ${req.itemName} — ${n} ${req.unit || item.unit || ''} cannot be dispatched yet because only ${current} ${item.unit || req.unit || ''} is currently available. Please wait for stock to arrive.`,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
      tx.set(doc(collection(requestRef,'events')),{requestId,eventType:'stock_unavailable',batchId:req.notificationBatchId || requestId,itemId:req.itemId,itemName:req.itemName,quantity:n,unit:item.unit||req.unit||'',availableQuantity:current,department:req.department||'',requestedByUid:req.requestedByUid||'',requestedByEmail:req.requestedByEmail||'',requestedByRole:req.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()});
      return {fulfilled:false,itemName:req.itemName,requested:n,available:current,unit:item.unit||req.unit||''};
    }
    tx.update(itemRef,{quantity:current-n,updatedAt:serverTimestamp(),updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(itemRef,'movements',movementId),{type:'dispatch',quantity:n,unit:item.unit,department:req.department||'',note:`Request fulfilled${req.note?': '+req.note:''}`,requestId,requestedByEmail:req.requestedByEmail||'',requestedByUid:req.requestedByUid||'',requestedByRole:req.requestedByRole||'',byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',createdAt:serverTimestamp()});
    tx.update(requestRef,{status:'fulfilled',updatedAt:serverTimestamp(),fulfilledAt:serverTimestamp(),fulfilledByUid:user.uid,fulfilledByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(collection(requestRef,'events')),{requestId,eventType:'fulfilled',batchId:req.notificationBatchId || requestId,itemId:req.itemId,itemName:req.itemName,quantity:n,unit:item.unit,department:req.department||'',requestedByUid:req.requestedByUid||'',requestedByEmail:req.requestedByEmail||'',requestedByRole:req.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()});
    if (req.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',req.requestedByUid,'notifications')), { recipientUid:req.requestedByUid, requestId, batchId:req.notificationBatchId || requestId, type:'request_status', status:'fulfilled', title:'Request fulfilled', message:`${req.itemName} — ${n} ${item.unit} for ${req.department || 'the selected department'} has been dispatched and fulfilled.`, read:false, clientCreatedAt:Date.now(), createdAt:serverTimestamp() });
    return {fulfilled:true};
  });
  if(!result.fulfilled) throw new Error(`Not enough ${result.itemName} in stock to dispatch this approved request. Requested: ${result.requested} ${result.unit}. Available: ${result.available} ${result.unit}. The request remains approved and has not been dispatched.`);
}

async function listHistory() {
  const items=await listItems();
  const employees=await listEmployees();
  const roleByEmail=new Map(employees.map(e=>[(e.email||'').toLowerCase(),e.role]));
  const rows=[];
  for(const item of items){
    const snap=await getDocs(collection(db,'companies',currentCompanyId(),'items',item.id,'movements'));
    snap.docs.forEach(d=>{
      const data=d.data();
      rows.push({id:d.id,itemName:item.name,itemId:item.id,...data,
        actorRole:data.byRole || roleByEmail.get((data.byEmail||'').toLowerCase()) || ''});
    });
  }
  return rows.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
}

function canEditMovementRow(row){
  const role=membership?.role;
  if(!role || role==='admin') return false;
  if(!['inventory_manager','chef','request'].includes(role)) return false;
  return row.actorRole===role || (!row.actorRole && row.byUid===auth.currentUser?.uid);
}

async function recalculateItemFromMovements(tx,itemRef,movementDocs){
  let quantity=0;
  for(const d of movementDocs){
    const m=d.data();
    const n=Number(m.quantity||0);
    if(m.type==='opening'||m.type==='receive') quantity+=n;
    else if(m.type==='dispatch') quantity-=n;
  }
  if(quantity<0) throw new Error('This correction would make stock negative. Check the movement quantity/type.');
  tx.update(itemRef,{quantity,updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid,updatedByEmail:auth.currentUser.email?.toLowerCase()||''});
  return quantity;
}

async function editMovement(itemId,movementId,changes){
  if(!['inventory_manager','chef','request'].includes(membership?.role)) throw new Error('History editing is available only to the respective department role.');
  const companyId=currentCompanyId();
  const itemRef=doc(db,'companies',companyId,'items',itemId);
  const movementRef=doc(itemRef,'movements',movementId);
  const allMovementSnap=await getDocs(collection(itemRef,'movements'));
  const movementRefs=allMovementSnap.docs.map(d=>d.ref);
  await runTransaction(db,async(tx)=>{
    const itemSnap=await tx.get(itemRef);
    const movementSnaps=[];
    for(const ref of movementRefs) movementSnaps.push(await tx.get(ref));
    const movementSnap=movementSnaps.find(x=>x.id===movementId);
    if(!itemSnap.exists()||!movementSnap?.exists()) throw new Error('That transaction no longer exists.');
    const movement=movementSnap.data();
    const actorRole=movement.byRole || '';
    if(actorRole && actorRole!==membership.role) throw new Error('You can edit only transactions belonging to your own department.');
    if(!actorRole && movement.byUid!==auth.currentUser?.uid) throw new Error('This older transaction has no department record, so only its original creator can edit it.');
    const type=String(changes.type||movement.type).trim().toLowerCase();
    const quantity=Number(changes.quantity);
    if(!['opening','receive','dispatch'].includes(type)) throw new Error('Invalid movement type.');
    if(!Number.isFinite(quantity)||quantity<0) throw new Error('Quantity must be 0 or more.');
    tx.update(movementRef,{type,quantity,note:String(changes.note||'').trim(),editedAt:serverTimestamp(),editedByUid:auth.currentUser.uid,editedByEmail:auth.currentUser.email?.toLowerCase()||'',byRole:actorRole||membership.role});
    const docs=movementSnaps.map((d,i)=>d.id===movementId?{id:d.id,data:()=>({...movement,type,quantity})}:{id:d.id,data:()=>d.data()});
    await recalculateItemFromMovements(tx,itemRef,docs);
  });
}

async function deleteMovement(itemId,movementId){
  if(!['inventory_manager','chef','request'].includes(membership?.role)) throw new Error('History editing is available only to the respective department role.');
  const companyId=currentCompanyId();
  const itemRef=doc(db,'companies',companyId,'items',itemId);
  const movementRef=doc(itemRef,'movements',movementId);
  const allMovementSnap=await getDocs(collection(itemRef,'movements'));
  const movementRefs=allMovementSnap.docs.map(d=>d.ref);
  await runTransaction(db,async(tx)=>{
    const itemSnap=await tx.get(itemRef);
    const movementSnaps=[];
    for(const ref of movementRefs) movementSnaps.push(await tx.get(ref));
    const movementSnap=movementSnaps.find(x=>x.id===movementId);
    if(!itemSnap.exists()||!movementSnap?.exists()) throw new Error('That transaction no longer exists.');
    const movement=movementSnap.data();
    const actorRole=movement.byRole||'';
    if(actorRole && actorRole!==membership.role) throw new Error('You can delete only transactions belonging to your own department.');
    if(!actorRole && movement.byUid!==auth.currentUser?.uid) throw new Error('This older transaction has no department record, so only its original creator can delete it.');
    const remaining=movementSnaps.filter(d=>d.id!==movementId).map(d=>({id:d.id,data:()=>d.data()}));
    tx.delete(movementRef);
    await recalculateItemFromMovements(tx,itemRef,remaining);
  });
}

function movementLabel(type){return ({opening:'Opening stock',receive:'Received',dispatch:'Dispatched'})[type]||type;}
function stockState(q,low){
  q=Number(q||0); low=Number(low||0);
  if(q<=low) return 'low';
  if(low>0 && q<=stockNearLimit(low)) return 'near';
  return 'ok';
}
function stockNearLimit(low){ return Number(low||0)>0 ? Number(low)*1.5 : 0; }

async function deleteCompanyCompletely() {
  const companyId = currentCompanyId(), user = auth.currentUser;
  if (!companyId || !user || membership?.role !== 'admin') throw new Error('Only the company admin can delete the company.');
  const companyRef = doc(db,'companies',companyId);
  const companySnap = await getDoc(companyRef);
  if (!companySnap.exists()) throw new Error('Company was already deleted.');
  const company = companySnap.data();
  if (company.ownerUid !== user.uid) throw new Error('Only the original owner can delete this company.');

  const employees = await getDocs(collection(db,'companies',companyId,'employees'));
  const items = await getDocs(collection(db,'companies',companyId,'items'));
  const requests = await getDocs(collection(db,'companies',companyId,'requests'));
  const batch = writeBatch(db);
  employees.docs.forEach(e => {
    const d=e.data();
    if (d.uid) batch.delete(doc(db,'memberships',d.uid));
    batch.delete(e.ref);
  });
  for (const item of items.docs) {
    const moves = await getDocs(collection(item.ref,'movements'));
    moves.docs.forEach(m => batch.delete(m.ref));
    batch.delete(item.ref);
  }
  for (const r of requests.docs) {
    const events = await getDocs(collection(r.ref,'events'));
    events.docs.forEach(e => batch.delete(e.ref));
    batch.delete(r.ref);
  }
  if (company.code) batch.delete(doc(db,'codes',company.code));
  batch.delete(companyRef);
  batch.delete(doc(db,'memberships',user.uid));
  await batch.commit();
}

function roleLabel(role) {
  return ({
    inventory_manager: 'Inventory Manager',
    chef: 'Chef',
    request: 'Request'
  })[role] || role;
}

function showTemporaryMessage(message, type = 'info') {
  const old = document.getElementById('temporary-message');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'temporary-message';
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ---------------- UI ----------------


const root = document.getElementById('app');

function installConnectionIndicator(){
  let el=document.getElementById('connection-indicator');
  if(!el){el=document.createElement('div');el.id='connection-indicator';document.body.appendChild(el);}
  const update=()=>{const online=navigator.onLine;el.textContent=online?'● Online':'○ Offline — changes will sync when connected';el.className=online?'online':'offline';};
  window.addEventListener('online',update); window.addEventListener('offline',update); update();
}
installConnectionIndicator();

async function enableLowStockNotifications(){
  if(!('Notification' in window)) throw new Error('This browser does not support notifications.');
  const permission=await Notification.requestPermission();
  if(permission!=='granted') throw new Error('Notification permission was not granted.');
  showTemporaryMessage('Low-stock alerts are enabled on this browser.','success');
}

function maybeNotifyStockState(items){
  if(membership?.role !== 'inventory_manager') return;
  if(!('Notification' in window)||Notification.permission!=='granted') return;
  const key=`inventroStockStates:${currentCompanyId()}`;
  const previous=JSON.parse(localStorage.getItem(key)||'{}');
  const next={};
  items.forEach(item=>{
    const q=Number(item.quantity||0), low=Number(item.lowStockAlert||0), state=stockState(q,low);
    next[item.id]=state;
    const old=previous[item.id];
    if(old && old!==state && (state==='near'||state==='low')){
      const title=state==='low' ? `Inventro • LOW STOCK` : `Inventro • Stock getting low`;
      const body=state==='low'
        ? `${item.name}: ${q} ${item.unit} remaining. Low limit: ${low} ${item.unit}.`
        : `${item.name}: ${q} ${item.unit} remaining. It is approaching the low limit of ${low} ${item.unit}.`;
      showTemporaryMessage(`${state==='low'?'🔴':'🟡'} ${item.name}: ${state==='low'?'LOW STOCK':'approaching low stock'} — ${q} ${item.unit}`,state==='low'?'error':'success');
      try{new Notification(title,{body,tag:`inventro-stock-${item.id}`,renotify:true});}catch(_){ }
    }
  });
  localStorage.setItem(key,JSON.stringify(next));
}

/*
 * SPA history navigation for Android/browser back button and swipe-back gesture.
 * Every real screen change gets a browser history entry; live Firebase updates
 * continue to re-render without creating history entries.
 */
let historyNavigationReady = false;
function navigate(nextView, { replace = false } = {}) {
  if (view === nextView) { render(); return; }
  view = nextView;
  const state = { inventro: true, view: nextView };
  if (replace || !historyNavigationReady) history.replaceState(state, '', location.href);
  else history.pushState(state, '', location.href);
  render();
}

function navigateBack(fallback = 'home') {
  if (historyNavigationReady && history.state?.inventro) {
    history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}

window.addEventListener('popstate', (event) => {
  // Keep Android/browser Back inside the SPA. The initial document entry must
  // never resolve to Inventro's internal loading screen.
  if (event.state?.inventro && event.state.view) {
    view = event.state.view;
    render();
    return;
  }
  view = auth.currentUser ? (membership ? 'home' : 'welcome') : 'welcome';
  history.replaceState({ inventro: true, view }, '', location.href);
  render();
});

/*
 * Global dashboard navigation.
 * This is delegated from #app so navigation continues to work even when
 * dashboard cards are re-rendered dynamically.
 */
root.addEventListener('click', (event) => {
  const card = event.target.closest('[data-action]');
  if (!card || !root.contains(card)) return;
  const action = card.dataset.action;
  if (action === 'admin') {
    if (!membership || membership.role !== 'admin') return showTemporaryMessage('Only the company admin can open this section.','error');
    navigate('admin'); return;
  }
  if (action === 'stock') { navigate('stock'); return; }
  if (action === 'dispatch') { navigate('dispatch'); return; }
  if (action === 'receive') { navigate('receive'); return; }
  if (action === 'requests') { navigate('requests'); return; }
  if (action === 'stats') { navigate('stats'); return; }
  if (action === 'history') { navigate('history'); return; }
  showTemporaryMessage(`${card.querySelector('strong')?.textContent || 'This section'} is coming next.`);
});

function renderWelcome({ onCreate, onJoin }) {
  root.innerHTML = `
    <div class="screen">
      <p class="brand">Company Workspace</p>
      <h1>Manage your kitchen stock, start to finish.</h1>
      <p class="subtitle">Set up a new company, or join one you've already been invited to.</p>
      <div class="stack">
        <button class="btn btn-primary" id="create-btn">Create a company<span class="btn-arrow">›</span></button>
        <button class="btn btn-secondary" id="join-btn">Join a company<span class="btn-arrow">›</span></button>
      </div>
    </div>`;
  root.querySelector('#create-btn').addEventListener('click', onCreate);
  root.querySelector('#join-btn').addEventListener('click', onJoin);
}

function renderCreateCompany({ onBack, onDone }) {
  let error = '', loading = false;
  function draw() {
    const user = auth.currentUser;
    root.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="back-btn">‹ Back</button></div>
        <p class="brand">Create a company</p>
        <h1>${user ? 'Name your company' : 'Sign in to continue'}</h1>
        <p class="subtitle">${user
          ? "This becomes the workspace your team joins. You'll get a 6-digit code afterward to share with them."
          : "You'll create this company under your Google account. Whichever Gmail you choose here becomes the sole admin."}</p>
        ${error ? `<div class="error-box">${error}</div>` : ''}
        ${user ? `
          <div class="field">
            <label for="company-name">Company name</label>
            <input type="text" id="company-name" placeholder="e.g. Riverside Kitchen" maxlength="60" />
          </div>
          <div class="stack"><button class="btn btn-primary" id="submit-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner"></span> Creating…' : 'Create company'}</button></div>
        ` : `
          <div class="stack"><button class="btn btn-primary" id="google-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner"></span> Opening Google…' : 'Continue with Google'}</button></div>
        `}
      </div>`;
    root.querySelector('#back-btn').addEventListener('click', onBack);
    const googleBtn = root.querySelector('#google-btn');
    if (googleBtn) googleBtn.addEventListener('click', async () => {
      error = ''; loading = true; draw();
      try { await signInWithGoogle(); } catch (err) { error = friendlyError(err); } finally { loading = false; draw(); }
    });
    const submitBtn = root.querySelector('#submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', async () => {
      const nameInput = root.querySelector('#company-name');
      error = ''; loading = true; draw();
      try { const { code } = await createCompany(nameInput.value); onDone(code); }
      catch (err) { error = friendlyError(err); loading = false; draw(); }
    });
  }
  draw();
}

function renderCompanyCreated({ code, onContinue }) {
  root.innerHTML = `
    <div class="screen">
      <p class="brand">You're set up</p>
      <h1>Save this code</h1>
      <p class="subtitle">Share it only with people who should be able to join. You'll add their emails from the admin tab before they can use it.</p>
      <div class="code-display"><div class="code">${code}</div><div class="caption">Your company's join code</div></div>
      <button class="btn btn-primary" id="continue-btn">Enter workspace</button>
    </div>`;
  root.querySelector('#continue-btn').addEventListener('click', onContinue);
}

function renderJoinCompany({ onBack, onDone }) {
  let error = '', loading = false;
  function draw() {
    const user = auth.currentUser;
    root.innerHTML = `
      <div class="screen">
        <div class="back-row"><button class="back-btn" id="back-btn">‹ Back</button></div>
        <p class="brand">Join a company</p>
        <h1>${user ? 'Enter your code' : 'Sign in to continue'}</h1>
        <p class="subtitle">${user
          ? `Signed in as ${user.email}. Enter the 6-digit code your admin gave you.`
          : 'Choose the Google account your admin added to the company. It has to match exactly.'}</p>
        ${error ? `<div class="error-box">${error}</div>` : ''}
        ${user ? `
          <div class="field">
            <label for="join-code">6-digit code</label>
            <input type="text" id="join-code" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />
          </div>
          <div class="stack">
            <button class="btn btn-primary" id="submit-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner"></span> Checking…' : 'Join company'}</button>
            <button class="btn-link" id="change-account-btn" ${loading ? 'disabled' : ''}>↻ Change Google account</button>
          </div>
        ` : `
          <div class="stack"><button class="btn btn-primary" id="google-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner"></span> Opening Google…' : 'Continue with Google'}</button></div>
        `}
      </div>`;
    root.querySelector('#back-btn').addEventListener('click', onBack);
    const googleBtn = root.querySelector('#google-btn');
    if (googleBtn) googleBtn.addEventListener('click', async () => {
      error = ''; loading = true; draw();
      try { await signInWithGoogle(); } catch (err) { error = friendlyError(err); } finally { loading = false; draw(); }
    });
    const codeInput = root.querySelector('#join-code');
    if (codeInput) codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    });
    const changeAccountBtn = root.querySelector('#change-account-btn');
    if (changeAccountBtn) changeAccountBtn.addEventListener('click', async () => {
      if (loading) return;
      error = '';
      returnToJoinAfterSignOut = true;
      await signOut().catch(() => {});
    });

    const submitBtn = root.querySelector('#submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', async () => {
      error = ''; loading = true; draw();
      try { await joinCompany(codeInput.value); onDone(); }
      catch (err) { error = friendlyError(err); loading = false; draw(); }
    });
  }
  draw();
}


function renderEmployeeCode() {
  let error = '';
  let loading = false;
  const user = auth.currentUser;

  function draw() {
    root.innerHTML = `
      <div class="screen">
        <p class="brand">Inventro Employee Access</p>
        <h1>Enter company code</h1>
        <p class="subtitle">
          Signed in as ${escapeHtml(user?.email || '')}. For employee accounts, the 6-digit company code is required to enter the workspace.
        </p>

        ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ''}

        <div class="field">
          <label for="employee-company-code">6-digit company code</label>
          <input type="text" id="employee-company-code" class="code-input"
                 inputmode="numeric" maxlength="6" placeholder="000000"
                 autocomplete="one-time-code" />
        </div>

        <div class="stack">
          <button class="btn btn-primary" id="verify-code-btn" ${loading ? 'disabled' : ''}>
            ${loading ? '<span class="spinner"></span> Verifying…' : 'Enter employee workspace'}
          </button>
          <button class="btn-link" id="employee-signout-btn" ${loading ? 'disabled' : ''}>
            Sign in with a different Google account
          </button>
        </div>
      </div>`;

    const input = root.querySelector('#employee-company-code');
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 6);
    });

    root.querySelector('#verify-code-btn').addEventListener('click', async () => {
      error = '';
      loading = true;
      draw();
      try {
        await verifyEmployeeCode(input.value);
        navigate('home');
      } catch (err) {
        error = friendlyError(err);
        loading = false;
        draw();
      }
    });

    root.querySelector('#employee-signout-btn').addEventListener('click', async () => {
      clearEmployeeCodeVerification();
      await signOut();
    });
  }

  draw();
}


let requestBadgeUnsubscribe = null;
let requestBadgeCompanyId = null;
let homeStatusUnsubscribe = null;


// Global real-time synchronization.  These listeners stay alive for the whole
// signed-in company session so pages never depend on a manual Refresh button.
let realtimeUnsubscribers = [];
let realtimeMovementUnsubs = new Map();
let realtimeRequestEventUnsubs = new Map();
let realtimeRefreshTimer = null;
let realtimeCompanyId = null;
let realtimeStarted = false;

function stopRealtimeSync() {
  realtimeUnsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeUnsubscribers = [];
  realtimeMovementUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeMovementUnsubs.clear();
  realtimeRequestEventUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeRequestEventUnsubs.clear();
  if (realtimeRefreshTimer) { clearTimeout(realtimeRefreshTimer); realtimeRefreshTimer = null; }
  realtimeCompanyId = null;
  realtimeStarted = false;
}

function scheduleRealtimeRefresh(kind) {
  // Stock and Requests already have focused listeners that update their visible
  // cards/lists in place. For read-only/log pages, redraw after Firestore settles.
  if (['stock','requests'].includes(view)) return;
  if (!['home','dispatch','receive','history','logbook','stats','admin'].includes(view)) return;
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(() => {
    realtimeRefreshTimer = null;
    if (!auth.currentUser || !membership) return;
    if (view === 'home') {
      startHomeStatusListener();
      return;
    }
    if (view === 'dispatch' || view === 'receive') {
      // Do not destroy typed quantity/note/department fields. Update the
      // selected item's live insight instead; the next open/render gets the
      // complete latest list automatically.
      updateMovementLiveContext();
      return;
    }
    if (view === 'history' || view === 'logbook') renderHistory();
    else if (view === 'stats') renderStats();
    else if (view === 'admin') renderAdmin();
  }, 120);
}

function syncMovementListeners(companyId, itemDocs) {
  const ids = new Set(itemDocs.map(d => d.id));
  for (const [itemId, unsub] of realtimeMovementUnsubs) {
    if (!ids.has(itemId)) { try { unsub(); } catch (_) {} realtimeMovementUnsubs.delete(itemId); }
  }
  for (const item of itemDocs) {
    if (realtimeMovementUnsubs.has(item.id)) continue;
    const movementRef = collection(db,'companies',companyId,'items',item.id,'movements');
    const unsub = onSnapshot(movementRef, () => scheduleRealtimeRefresh('movements'), err => console.warn('Movement realtime listener:', err));
    realtimeMovementUnsubs.set(item.id, unsub);
  }
}

function syncRequestEventListeners(companyId, requestDocs) {
  const ids = new Set(requestDocs.map(d => d.id));
  for (const [requestId, unsub] of realtimeRequestEventUnsubs) {
    if (!ids.has(requestId)) { try { unsub(); } catch (_) {} realtimeRequestEventUnsubs.delete(requestId); }
  }
  for (const request of requestDocs) {
    // Firestore rules do not permit a Chef/Request user to listen to another
    // person's request events, so only subscribe to that user's own requests.
    if (!['admin','inventory_manager'].includes(membership?.role) && request.data()?.requestedByUid !== auth.currentUser?.uid) continue;
    if (realtimeRequestEventUnsubs.has(request.id)) continue;
    const eventRef = collection(db,'companies',companyId,'requests',request.id,'events');
    const unsub = onSnapshot(eventRef, () => scheduleRealtimeRefresh('request-events'), err => console.warn('Request event realtime listener:', err));
    realtimeRequestEventUnsubs.set(request.id, unsub);
  }
}

function startRealtimeSync() {
  const companyId = currentCompanyId();
  if (!companyId || !auth.currentUser) return;
  if (realtimeStarted && realtimeCompanyId === companyId) return;
  stopRealtimeSync();
  realtimeStarted = true;
  realtimeCompanyId = companyId;

  const add = (ref, callback, label) => {
    let first = true;
    const unsub = onSnapshot(ref, snap => {
      const wasFirst = first; first = false;
      callback(snap, wasFirst);
    }, err => console.warn(`${label} realtime listener:`, err));
    realtimeUnsubscribers.push(unsub);
  };

  add(doc(db,'companies',companyId), (_snap, wasFirst) => { if (!wasFirst) scheduleRealtimeRefresh('company'); }, 'Company');

  add(collection(db,'companies',companyId,'employees'), (snap, wasFirst) => {
    // Keep the signed-in membership role in sync if Admin changes it.
    const me = snap.docs.find(d => d.id === (auth.currentUser?.email || '').toLowerCase());
    if (me?.exists?.()) {
      const data = me.data();
      if (data.role && data.role !== membership?.role) {
        membership = {...membership, role:data.role, email:data.email || membership.email};
        if (data.status !== 'active') {
          clearEmployeeCodeVerification();
          view = 'employeeCode';
        }
        render();
        return;
      }
    }
    if (!wasFirst) scheduleRealtimeRefresh('employees');
  }, 'Employees');

  add(collection(db,'companies',companyId,'departments'), (snap, wasFirst) => {
    const liveDepartments = snap.docs.map(d => ({id:d.id,...d.data()})).sort((a,b)=>(a.nameLower||a.name||'').localeCompare(b.nameLower||b.name||'', undefined, {sensitivity:'base'}));
    if (view === 'dispatch' || view === 'receive') updateMovementLiveContext(null, liveDepartments);
    if (!wasFirst) scheduleRealtimeRefresh('departments');
  }, 'Departments');

  add(collection(db,'companies',companyId,'items'), (snap, wasFirst) => {
    const docs = snap.docs.map(d => ({id:d.id,...d.data()}));
    syncMovementListeners(companyId, snap.docs);
    if (!wasFirst) scheduleRealtimeRefresh('items');
    if (view === 'stock') {
      renderStockCards(docs);
      maybeNotifyStockState(docs);
    }
    if (view === 'dispatch' || view === 'receive') updateMovementLiveContext(docs);
  }, 'Items');

  add(collection(db,'companies',companyId,'requests'), (snap, wasFirst) => {
    const docs = snap.docs.map(d => ({id:d.id,...d.data()}));
    syncRequestEventListeners(companyId, snap.docs);
    if (!wasFirst) scheduleRealtimeRefresh('requests');
    if (membership?.role === 'inventory_manager') updateRequestBadge(docs.filter(r => r.status === 'pending').length);
  }, 'Requests');

  // Membership itself is also live. This catches role/company changes made by
  // another session without requiring a page reload.
  add(doc(db,'memberships',auth.currentUser.uid), (snap, wasFirst) => {
    if (!snap.exists()) return;
    const next = snap.data();
    if (!wasFirst && JSON.stringify(next) !== JSON.stringify(membership)) {
      membership = next;
      startRequestBadgeListener();
      render();
    }
  }, 'Membership');
}

function updateMovementLiveContext(liveItems, liveDepartments) {
  const select = root.querySelector('#movement-item');
  const insight = root.querySelector('#movement-item-insight');
  if (!select || !insight) return;
  const currentId = select.value;
  if (Array.isArray(liveDepartments)) {
    const deptSelect = root.querySelector('#movement-department');
    if (deptSelect) {
      const selectedDept = deptSelect.value;
      deptSelect.innerHTML = '<option value="">Select department…</option>' + liveDepartments.map(d => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('');
      deptSelect.value = liveDepartments.some(d => d.name === selectedDept) ? selectedDept : '';
    }
  }
  const itemsNow = liveItems || [];
  const item = itemsNow.find(i => i.id === currentId);
  if (!item) return;
  const q = Number(item.quantity || 0), low = Number(item.lowStockAlert || 0);
  const state = stockState(q, low);
  const currentText = `${item.name} — ${q} ${item.unit}`;
  const option = select.querySelector(`option[value="${CSS.escape(currentId)}"]`);
  if (option) option.textContent = currentText;
  const stateNode = insight.querySelector('.movement-state');
  if (stateNode) {
    stateNode.className = `stock-state movement-state ${state}`;
    stateNode.textContent = state === 'low' ? 'Low' : state === 'near' ? 'Near low' : 'Good';
  }
  const stockNode = insight.querySelector('.movement-insight-grid div:first-child strong');
  if (stockNode) stockNode.textContent = `${q} ${item.unit}`;
  const lowNode = insight.querySelector('.movement-insight-grid div:nth-child(2) strong');
  if (lowNode) lowNode.textContent = `${low} ${item.unit}`;
}

function stopRequestBadgeListener() {
  if (requestBadgeUnsubscribe) requestBadgeUnsubscribe();
  requestBadgeUnsubscribe = null;
  requestBadgeCompanyId = null;
}

function clearHomeRequestNotificationAlert() {
  const card = root.querySelector('[data-action=\"requests\"]');
  if (card) {
    card.classList.remove('home-alert-card','home-request-approved','home-request-rejected','home-request-mixed');
  }
}

function updateRequestBadge(count) {
  const badge = root.querySelector('#request-badge');
  const card = root.querySelector('[data-action=\"requests\"]');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count <= 0;
  }
  if (card) {
    card.classList.remove('home-request-approved','home-request-rejected','home-request-mixed');
    card.classList.toggle('home-alert-card', count > 0);
  }
}

let homeRequestNotificationTimer = null;

function stopHomeRequestNotificationAlert() {
  if (homeRequestNotificationTimer) {
    clearTimeout(homeRequestNotificationTimer);
    homeRequestNotificationTimer = null;
  }
  clearHomeRequestNotificationAlert();
}

function updateHomeRequestNotificationAlert(notifications) {
  const card = root.querySelector('[data-action="requests"]');
  const badge = root.querySelector('#request-badge');
  if (!card || membership?.role === 'inventory_manager') return;

  if (homeRequestNotificationTimer) {
    clearTimeout(homeRequestNotificationTimer);
    homeRequestNotificationTimer = null;
  }
  card.classList.remove('home-alert-card','home-request-approved','home-request-rejected','home-request-mixed');

  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const statusNotifications = notifications
    .filter(n => ['approved','rejected'].includes(String(n.status || '').toLowerCase()))
    .map(n => ({
      ...n,
      _time: Number(n.clientCreatedAt || n.createdAt?.toMillis?.() || 0),
      _request: String(n.requestId || n.notificationBatchId || n.batchId || n.id),
      _status: String(n.status || '').toLowerCase()
    }))
    .filter(n => n._time > 0 && (now - n._time) >= 0 && (now - n._time) < windowMs)
    .sort((a,b) => b._time - a._time);

  // Treat each request as its own notification batch. For a given request,
  // only its latest approval/rejection decision controls the Home-card light.
  // This prevents an older rejection from mixing with a newer approval.
  const latestByRequest = new Map();
  for (const n of statusNotifications) {
    const existing = latestByRequest.get(n._request);
    if (!existing || n._time > existing._time) latestByRequest.set(n._request, n);
  }
  const requestBatches = [...latestByRequest.values()].sort((a,b) => b._time - a._time);

  if (!statusNotifications.length) {
    if (badge) {
      badge.hidden = true;
      badge.textContent = '0';
      badge.classList.remove('request-badge-green','request-badge-red','request-badge-yellow');
    }
    return;
  }

  /*
   * IMPORTANT: the home light is decided by the NEWEST request batch only.
   *
   * Example:
   *   Request #1 -> rejected -> RED
   *   Request #2 -> approved -> GREEN
   *
   * The old rejected request can still remain in the 5-notification list, but
   * it is NOT allowed to contaminate the colour of the newer request.
   *
   * Yellow is reserved for a true multi-result batch; different requests never mix their colours.
   */
  const newest = requestBatches[0];
  // A single request has one final decision. Therefore an approval is always
  // green and a rejection is always red, even when another request was
  // rejected/approved a few minutes earlier. Yellow is reserved for a true
  // multi-result batch, not for different requests.
  const approved = newest._status === 'approved';
  const rejected = newest._status === 'rejected';
  const mixed = false;

  if (approved) card.classList.add('home-request-approved');
  else if (rejected) card.classList.add('home-request-rejected');
  else if (mixed) card.classList.add('home-request-mixed');

  if (badge) {
    badge.textContent = '1';
    badge.hidden = false;
    badge.classList.toggle('request-badge-green', approved);
    badge.classList.toggle('request-badge-red', rejected);
    badge.classList.toggle('request-badge-yellow', mixed);
  }

  const remaining = Math.max(1000, windowMs - (now - newest._time));
  homeRequestNotificationTimer = setTimeout(() => {
    homeRequestNotificationTimer = null;
    updateHomeRequestNotificationAlert(notifications);
  }, remaining + 100);
}

function updateHomeStockBadge(count) {
  const badge = root.querySelector('#stock-alert-badge');
  const card = root.querySelector('[data-action=\"stock\"]');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count <= 0;
  }
  if (card) card.classList.toggle('home-alert-card', count > 0);
}

function startRequestBadgeListener() {
  stopRequestBadgeListener();
  // The pending-request badge belongs to the Inventory Manager. Chef/Request
  // users use their own five-minute approval/rejection alert on the Home card.
  if (membership?.role !== 'inventory_manager') return;
  const companyId = currentCompanyId();
  if (!companyId) return;
  requestBadgeCompanyId = companyId;
  requestBadgeUnsubscribe = onSnapshot(
    collection(db, 'companies', companyId, 'requests'),
    snap => {
      const pending = snap.docs.filter(d => d.data().status === 'pending').length;
      updateRequestBadge(pending);
      const previous = Number(sessionStorage.getItem(`inventroPendingRequests:${companyId}`) || 0);
      if (membership?.role === 'inventory_manager' && pending > previous && 'Notification' in window && Notification.permission === 'granted') {
        const newest = snap.docs.map(d => ({id:d.id, ...d.data()}))
          .filter(r => r.status === 'pending')
          .sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0))[0];
        if (newest) {
          try { new Notification('Inventro: New stock request', { body: `${newest.itemName} — ${newest.quantity} ${newest.unit}` }); } catch (_) {}
        }
      }
      sessionStorage.setItem(`inventroPendingRequests:${companyId}`, String(pending));
    },
    err => console.warn('Request badge listener:', err)
  );
}

function startHomeStatusListener() {
  if (homeStatusUnsubscribe) homeStatusUnsubscribe();
  stopHomeRequestNotificationAlert();
  const companyId = currentCompanyId();
  if (!companyId) return;
  let latestItems = [];
  let latestPending = 0;
  let latestNotifications = [];
  let notificationTimer = null;
  const apply = () => {
    const low = latestItems.filter(i => stockState(Number(i.quantity || 0), Number(i.lowStockAlert || 0)) === 'low').length;
    updateHomeStockBadge(low);
    if (membership?.role === 'inventory_manager') updateRequestBadge(latestPending);
    else if (['chef','request'].includes(membership?.role)) updateHomeRequestNotificationAlert(latestNotifications);
  };
  const unItems = onSnapshot(
    collection(db, 'companies', companyId, 'items'),
    snap => { latestItems = snap.docs.map(d => ({id:d.id, ...d.data()})); apply(); },
    err => console.warn('Home stock status listener:', err)
  );
  const unRequests = onSnapshot(
    collection(db, 'companies', companyId, 'requests'),
    snap => { latestPending = snap.docs.filter(d => d.data().status === 'pending').length; apply(); },
    err => console.warn('Home request status listener:', err)
  );
  let unNotifications = () => {};
  if (['chef','request'].includes(membership?.role) && auth.currentUser?.uid) {
    unNotifications = onSnapshot(
      collection(db, 'companies', companyId, 'userNotifications', auth.currentUser.uid, 'notifications'),
      snap => {
        latestNotifications = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(n => n.recipientUid === auth.currentUser?.uid);
        apply();
      },
      err => console.warn('Home request notification listener:', err)
    );
  }
  homeStatusUnsubscribe = () => {
    unItems();
    unRequests();
    unNotifications();
    if (notificationTimer) clearTimeout(notificationTimer);
  };
}

function renderHome(membership) {
  const user = auth.currentUser;
  const companyName = escapeHtml(membership?.companyName || 'Your company');
  const role = membership?.role || 'member';
  const email = escapeHtml(membership?.email || user?.email || '');
  const firstNameRaw = (user?.displayName || (membership?.email || '').split('@')[0] || 'there').split(' ')[0];
  const firstName = escapeHtml(firstNameRaw);
  const initial = escapeHtml((firstNameRaw[0] || 'U').toUpperCase());
  const isAdmin = role === 'admin';
  const canManage = canManageItems();
  const canRequest = canCreateRequest();
  const quickItems = [
    ['📦','Stock','View live current kitchen stock','stock'],
    ...(role === 'inventory_manager' ? [['⬆️','Dispatch','Send stock out directly','dispatch'],['⬇️','Receive Stock','Record newly arrived items','receive']] : []),
    ...(canRequest ? [['📝','Requests','Create and manage kitchen stock requests','requests']] : []),
    ...(isAdmin ? [['👥','Admin','Manage your company team','admin']] : []),
    ['📊','Stats','See stock and usage insights','stats'],
    ['🕘','History','Review previous stock activity','history']
  ];

  root.innerHTML = `
    <div class="dashboard">
      <div class="topbar">
        <div class="topbar-brand">Inventro</div>
        <div class="account-wrap">
          <button class="user-pill account-toggle" id="account-toggle" type="button"><div class="avatar">${initial}</div><div class="user-email">${email}</div><span class="account-chevron">⌄</span></button>
          <div class="account-menu" id="account-menu" hidden><div class="account-menu-email">${email}</div>${isAdmin ? '<button type="button" class="danger-menu-btn" id="delete-company-btn">Delete company</button>' : ''}<button type="button" class="menu-signout" id="menu-signout">Sign out</button></div>
        </div>
      </div>
      <section class="hero"><p class="eyebrow">Company workspace</p><h1>Welcome, ${firstName}! 👋</h1><p>You are successfully logged in. This is your ${companyName} inventory workspace.</p><div class="company-meta"><span class="badge">🏢 ${companyName}</span><span class="badge role">${isAdmin ? '👑 Admin' : '👤 ' + escapeHtml(roleLabel(role))}</span><span class="badge">● Active</span></div></section>
      <div class="section-title">Quick access</div><div class="quick-grid">${quickItems.map(([icon,title,desc,action])=>`<button class="quick-card ${action==='requests'?'request-quick-card':''} ${action==='stock'?'stock-quick-card':''}" data-action="${action}" type="button"><div class="quick-icon">${icon}</div><strong>${title}${action==='stock'?'<span class="home-status-badge" id="stock-alert-badge" hidden>0</span>':''}${action==='requests'?'<span class="request-badge" id="request-badge" hidden>0</span>':''}</strong><span>${desc}</span></button>`).join('')}</div>
      <div class="section-title">Workflow</div><div class="coming"><strong>Live cloud inventory is enabled.</strong><br>Stock changes, requests and movement records are stored in Firebase. Open <b>Stock</b> on another phone to see updates automatically.<div class="home-alert-row"><button class="small-action approve" id="enable-alerts" type="button">🔔 Enable low-stock alerts</button><span>Browser notifications are optional.</span></div></div>
      <div class="dashboard-footer"><button class="signout-small" id="signout-btn">Sign out</button></div>
    </div>`;
  const accountToggle=root.querySelector('#account-toggle'), accountMenu=root.querySelector('#account-menu');
  if(accountToggle&&accountMenu) accountToggle.addEventListener('click',()=>{accountMenu.hidden=!accountMenu.hidden;});
  root.querySelector('#menu-signout')?.addEventListener('click',()=>{clearEmployeeCodeVerification();signOut();});
  root.querySelector('#signout-btn').addEventListener('click',()=>{clearEmployeeCodeVerification();signOut();});
  root.querySelector('#enable-alerts')?.addEventListener('click',async()=>{try{await enableLowStockNotifications();}catch(err){showTemporaryMessage(friendlyError(err),'error');}});
  startHomeStatusListener();
  root.querySelector('#delete-company-btn')?.addEventListener('click',async()=>{
    const name=membership?.companyName||'your company'; const typed=window.prompt(`This permanently deletes ${name}, employees, items, requests and stock history.\n\nType the company name exactly to continue:`);
    if(typed!==name){if(typed!==null)showTemporaryMessage('Company name did not match. Nothing was deleted.','error');return;}
    if(!window.confirm('Final confirmation: permanently delete this company and its inventory data?'))return;
    const b=root.querySelector('#delete-company-btn');b.disabled=true;b.textContent='Deleting…';
    try{await deleteCompanyCompletely();clearEmployeeCodeVerification();await signOut();}catch(err){b.disabled=false;b.textContent='Delete company';showTemporaryMessage(friendlyError(err),'error');}
  });
}

function renderAddItem() {
  if (membership?.role !== 'admin') { navigate('home'); return; }
  root.innerHTML=`<div class="dashboard feature-page">
    <div class="topbar"><button class="back-btn" id="feature-back">‹ Back</button><div class="topbar-brand">Inventro</div></div>
    <section class="feature-header"><p class="eyebrow">Inventory setup</p><h1>Add an item</h1><p>Set item name, unit, opening stock and low-stock alert.</p></section>
    <section class="admin-card">
      <div class="field"><label for="item-name">Item name</label><input id="item-name" type="text" placeholder="e.g. Rice" maxlength="80"></div>
      <div class="field"><label for="item-unit">Unit</label><select id="item-unit">${INVENTORY_UNITS.map(u=>`<option value="${u}">${u}</option>`).join('')}</select></div>
      <div class="two-fields"><div class="field"><label for="opening-stock">Opening stock</label><input id="opening-stock" type="number" min="0" step="0.01" value="0"></div><div class="field"><label for="low-stock">Low stock alert</label><input id="low-stock" type="number" min="0" step="0.01" value="0"></div></div>
      <div class="image-preview-box"><div class="preview-placeholder">🖼️</div><div><strong>Automatic item photo</strong><span>Inventro will try to find a product image when you save.</span></div></div>
      <button class="btn btn-primary" id="save-item">Save item</button>
    </section></div>`;
  root.querySelector('#feature-back').addEventListener('click',()=>navigateBack('home'));
  root.querySelector('#save-item').addEventListener('click',async()=>{
    const b=root.querySelector('#save-item');b.disabled=true;b.innerHTML='<span class="spinner"></span> Finding image & saving…';
    try{await createInventoryItem({name:root.querySelector('#item-name').value,unit:root.querySelector('#item-unit').value,openingStock:root.querySelector('#opening-stock').value,lowStockAlert:root.querySelector('#low-stock').value});showTemporaryMessage('Item added successfully.','success');navigate('stock');}
    catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;b.textContent='Save item';}
  });
}

let stockUnsubscribe=null;
function stopStockListener(){if(stockUnsubscribe){stockUnsubscribe();stockUnsubscribe=null;}}
function stockSort(items, lowFirst) {
  const normalized = [...items];
  normalized.sort((a, b) => {
    if (lowFirst) {
      const sa = stockState(Number(a.quantity || 0), Number(a.lowStockAlert || 0));
      const sb = stockState(Number(b.quantity || 0), Number(b.lowStockAlert || 0));
      const rank = { low: 0, near: 1, ok: 2 };
      if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb];
    }
    return (a.nameLower || a.name || '').localeCompare(b.nameLower || b.name || '', undefined, { sensitivity: 'base' });
  });
  return normalized;
}

function renderStockCards(items) {
  const grid = root.querySelector('#stock-grid');
  if (!grid) return;
  const query = (root.querySelector('#stock-search')?.value || '').trim().toLowerCase();
  const filtered = items.filter(item => !query || (item.name || '').toLowerCase().includes(query));
  const managerView = membership?.role === 'inventory_manager';
  const ordered = stockSort(filtered, managerView);
  grid.innerHTML = ordered.length ? ordered.map(item => {
    const q = Number(item.quantity || 0), low = Number(item.lowStockAlert || 0);
    const state = stockState(q, low);
    const image = item.imageUrl || `https://placehold.co/96x96/eaf2ff/2563eb?text=${encodeURIComponent((item.name || 'Item').slice(0,10))}`;
    const lastReportMs=managerView?Date.parse(localStorage.getItem(`inventroLastStockReport:${currentCompanyId()}`)||''):NaN;
    const updatedMs=item.updatedAt?.toMillis?.()||0;
    const newSinceReport=managerView && Number.isFinite(lastReportMs) && updatedMs>lastReportMs && (state==='low'||state==='near');
    return `<article class="stock-card ${state} ${managerView && state === 'low' ? 'manager-low-highlight' : ''} ${managerView && state === 'near' ? 'manager-near-highlight' : ''}">
      <div class="stock-photo"><img src="${escapeHtml(image)}" alt="${escapeHtml(item.name)}" onerror="this.src='https://placehold.co/96x96/eaf2ff/2563eb?text=Item'"></div>
      <div class="stock-info"><div class="stock-name-row"><h3>${escapeHtml(item.name)}</h3>${newSinceReport?'<span class="new-report-flag">NEW</span>':''}<span class="stock-state">${state === 'low' ? 'Low' : state === 'near' ? 'Near low' : 'Good'}</span></div>
      <div class="stock-qty">${q} <span>${escapeHtml(item.unit)}</span></div>
      <div class="stock-meta">Low alert: ${low} ${escapeHtml(item.unit)}</div>
      <div class="stock-meta">Updated: ${escapeHtml(formatDate(item.updatedAt))}</div></div>
    </article>`;
  }).join('') : `<div class="empty-team"><div class="empty-icon">${query ? '🔎' : '📦'}</div><strong>${query ? 'No matching items' : 'No stock items yet'}</strong><span>${query ? 'Try another item name.' : 'Admin can add the first item.'}</span></div>`;
}

async function loadJsPdf() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-inventro-jspdf]');
    if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    script.async = true; script.dataset.inventroJspdf = '1';
    script.onload = resolve; script.onerror = () => reject(new Error('Could not load the PDF generator. Connect to the internet and try again.'));
    document.head.appendChild(script);
  });
  if (!window.jspdf?.jsPDF) throw new Error('PDF generator is unavailable.');
  return window.jspdf.jsPDF;
}

function currentStockRows(items) {
  return stockSort(items, false).map(item => ({
    name: item.name || 'Unnamed item', quantity: Number(item.quantity || 0), unit: item.unit || '',
    low: Number(item.lowStockAlert || 0), updated: formatDate(item.updatedAt)
  }));
}

async function shareFile(file, text) {
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ title: 'Inventro Stock Report', text, files: [file] });
    return 'shared';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'downloaded';
}

function itemHasOutstandingOrder(item) {
  return item?.procurementStatus === 'ordered' && !!item?.procurementOrderId;
}

function procurementLabel(item) {
  return itemHasOutstandingOrder(item) ? 'Order sent' : 'Not ordered';
}

function reportCandidates(items) {
  const reds = items.filter(i => stockState(Number(i.quantity||0), Number(i.lowStockAlert||0)) === 'low');
  const yellows = items.filter(i => stockState(Number(i.quantity||0), Number(i.lowStockAlert||0)) === 'near');
  return {
    newRed: reds.filter(i => !itemHasOutstandingOrder(i)),
    newYellow: yellows.filter(i => !itemHasOutstandingOrder(i)),
    outstanding: items.filter(itemHasOutstandingOrder).sort((a,b)=>(a.nameLower||a.name||'').localeCompare(b.nameLower||b.name||'',undefined,{sensitivity:'base'}))
  };
}

async function markItemsOrderSent(items, orderId, generatedAt) {
  const companyId=currentCompanyId(), user=auth.currentUser;
  if(!companyId||!user||membership?.role!=='inventory_manager') throw new Error('Only Inventory Manager can mark supplier orders.');
  const batch=writeBatch(db);
  for(const item of items){
    const ref=doc(db,'companies',companyId,'items',item.id);
    batch.update(ref,{procurementStatus:'ordered',procurementOrderId:orderId,procurementOrderSentAt:generatedAt,procurementOrderSentByUid:user.uid,procurementOrderSentByEmail:user.email?.toLowerCase()||'',procurementOrderQty:Number(item.quantity||0),updatedAt:serverTimestamp(),updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase()||''});
    batch.set(doc(collection(ref,'movements')),{type:'order_sent',quantity:Number(item.quantity||0),unit:item.unit,note:'Added to supplier reorder report',orderId,orderSentAt:generatedAt,byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',createdAt:serverTimestamp()});
  }
  await batch.commit();
}

async function shareLowStockPdf({yellowIds=[], resendIds=[]}={}){
  if(membership?.role!=='inventory_manager') throw new Error('Only Inventory Manager can share the low-stock report.');
  const items=await listItems();
  const {newRed,newYellow,outstanding}=reportCandidates(items);
  const yellow=newYellow.filter(i=>yellowIds.includes(i.id));
  const resend=outstanding.filter(i=>resendIds.includes(i.id));
  const chosen=[...newRed,...yellow,...resend];
  if(!chosen.length) throw new Error('There are no new red items, selected yellow items, or selected outstanding orders to share.');
  const JsPDF=await loadJsPdf(); const pdf=new JsPDF({unit:'mm',format:'a4'});
  const company=membership?.companyName||'Company', now=new Date();
  const orderId=`ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  pdf.setTextColor(20,27,38);pdf.setFont('helvetica','bold');pdf.setFontSize(20);pdf.text('INVENTRO',16,18);pdf.setFontSize(13);pdf.text('Supplier Reorder Request',16,26);
  pdf.setFont('helvetica','normal');pdf.setFontSize(9);pdf.text(company,16,33);pdf.text(`Order report: ${orderId}`,16,38);pdf.text(`Generated: ${formatDate(now)}`,16,43);
  pdf.setDrawColor(220,226,234);pdf.line(16,47,194,47); let y=57;
  const headers=['Priority','Item','Remaining','Low limit','Status'];const xs=[16,39,105,137,165];
  pdf.setFont('helvetica','bold');pdf.setFontSize(8.5);headers.forEach((h,i)=>pdf.text(h,xs[i],y)); y+=7;pdf.setFont('helvetica','normal');
  chosen.forEach(item=>{
    if(y>278){pdf.addPage();y=20;pdf.setFont('helvetica','bold');headers.forEach((h,i)=>pdf.text(h,xs[i],y));y+=7;pdf.setFont('helvetica','normal');}
    const state=stockState(Number(item.quantity||0),Number(item.lowStockAlert||0));
    const priority=state==='low'?'RED':state==='near'?'YELLOW':'ORDERED';
    pdf.text(priority,xs[0],y);pdf.text(String(item.name).slice(0,32),xs[1],y);pdf.text(`${Number(item.quantity||0)} ${item.unit}`,xs[2],y);pdf.text(`${Number(item.lowStockAlert||0)} ${item.unit}`,xs[3],y);pdf.text(itemHasOutstandingOrder(item)?'Previously sent':'New order',xs[4],y);pdf.setDrawColor(238,241,245);pdf.line(16,y+2,194,y+2);y+=8;
  });
  y+=5;pdf.setFontSize(8);pdf.setTextColor(90,98,110);pdf.text('New items are automatically included only when they do not already have an outstanding supplier order.',16,y);y+=5;pdf.text('Items marked as previously sent were included again only when explicitly selected for resend.',16,y);
  const blob=pdf.output('blob');const file=new File([blob],`Inventro-Supplier-Order-${now.toISOString().slice(0,10)}-${orderId.slice(-6)}.pdf`,{type:'application/pdf'});
  const mode=await shareFile(file,`${company} — Supplier reorder ${orderId}`);
  // Only mark as ordered after the share/download succeeded. A cancelled share does not lock the item.
  const toMark=chosen.filter(i=>!itemHasOutstandingOrder(i));
  if(toMark.length) await markItemsOrderSent(toMark,orderId,now.toISOString());
  localStorage.setItem(`inventroLastStockReport:${currentCompanyId()}`,now.toISOString());
  localStorage.setItem(`inventroLastOrderId:${currentCompanyId()}`,orderId);
  return {mode,orderId,marked:toMark.length};
}

function stockReportSelectionHtml(items){
  const {newRed,newYellow,outstanding}=reportCandidates(items);
  const totalActionable=newRed.length+newYellow.length;
  return `<details class="stock-report-builder stock-report-collapsed">
    <summary class="stock-report-summary">
      <div class="stock-report-summary-main"><span class="supplier-mini-icon">📦</span><div><strong>Supplier reorder</strong><span>Smart order tracking</span></div></div>
      <div class="supplier-summary-chips"><span class="supplier-chip red-chip">🔴 ${newRed.length} new red</span><span class="supplier-chip yellow-chip">🟡 ${newYellow.length} yellow</span><span class="supplier-chip blue-chip">🔵 ${outstanding.length} ordered</span></div>
      <span class="supplier-expand">View details <b>⌄</b></span>
    </summary>
    <div class="stock-report-details">
      <div class="report-builder-head"><div><strong>Supplier reorder</strong><span>New red items are included automatically. Yellow items can be selected. Already ordered items are not repeated unless you explicitly resend them.</span></div><span class="report-snapshot">${totalActionable} ready to review</span></div>
      <div class="report-groups">
        <div><div class="report-group-title red-title">🔴 New red — automatically included (${newRed.length})</div>${newRed.length?newRed.map(i=>`<label class="report-item locked"><input type="checkbox" checked disabled><span>${escapeHtml(i.name)}</span><small>${i.quantity} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">No new red items need ordering.</div>'}</div>
        <div><div class="report-group-title yellow-title">🟡 New yellow — choose to include (${newYellow.length})</div>${newYellow.length?newYellow.map(i=>`<label class="report-item"><input type="checkbox" class="yellow-report-check" value="${escapeHtml(i.id)}"><span>${escapeHtml(i.name)}</span><small>${i.quantity} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">No new yellow items right now.</div>'}</div>
        <div><div class="report-group-title ordered-title">🔵 Already ordered — not repeated automatically (${outstanding.length})</div>${outstanding.length?outstanding.map(i=>`<label class="report-item ordered-report-item"><input type="checkbox" class="resend-report-check" value="${escapeHtml(i.id)}"><span>${escapeHtml(i.name)}<em>Order sent ${escapeHtml(formatDate(i.procurementOrderSentAt))}</em></span><small>${i.quantity} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">No outstanding supplier orders.</div>'}</div>
      </div>
      <div class="report-builder-actions"><button class="small-action report-btn" id="share-selected-low-pdf" type="button">📄 Create & share supplier order</button><span>New red items cannot be missed. Previously ordered items require an explicit resend.</span></div>
    </div>
  </details>`;
}

async function shareCurrentStockCsv(){
  if(membership?.role!=='inventory_manager') throw new Error('Only Inventory Manager can share the stock CSV.');
  const items=await listItems(); const rows=currentStockRows(items); if(!rows.length) throw new Error('There are no stock items to share.');
  const escapeCsv=value=>`"${String(value??'').replaceAll('"','""')}"`;
  const lines=[['Item Name','Current Quantity','Unit','Low Stock Limit','Status','Last Updated'].map(escapeCsv).join(','),...rows.map(r=>[r.name,r.quantity,r.unit,r.low,stockState(r.quantity,r.low),r.updated].map(escapeCsv).join(','))];
  const file=new File([lines.join('\r\n')],`Inventro-Current-Stock-${new Date().toISOString().slice(0,10)}.csv`,{type:'text/csv;charset=utf-8'});return shareFile(file,`${membership?.companyName||'Company'} — Current Stock List`);
}

async function shareDailyHistoryCsv(dateStr){
  if(!['admin','inventory_manager'].includes(membership?.role)) throw new Error('Only Admin and Inventory Manager can share daily stock history.');
  const rows=await listHistory(); const day=dateStr||localDateKey();
  const start=new Date(`${day}T00:00:00`),end=new Date(`${day}T23:59:59.999`);
  const selected=rows.filter(r=>{const ms=r.createdAt?.toMillis?.()||0;return ms>=start.getTime()&&ms<=end.getTime();}).sort((a,b)=>{const byItem=(a.itemName||'').localeCompare(b.itemName||'',undefined,{sensitivity:'base'});if(byItem)return byItem;return (a.createdAt?.toMillis?.()||0)-(b.createdAt?.toMillis?.()||0);});
  if(!selected.length) throw new Error(`No stock history was recorded on ${day}.`);
  const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;const lines=[['Item Name','Movement','Department','Quantity','Unit','Person','Time','Note'].map(esc).join(','),...selected.map(r=>[r.itemName,movementLabel(r.type),r.department||'',r.quantity,r.unit,r.byEmail,formatDate(r.createdAt),r.note||''].map(esc).join(','))];
  const file=new File([lines.join('\r\n')],`Inventro-Daily-History-${day}.csv`,{type:'text/csv;charset=utf-8'});return shareFile(file,`${membership?.companyName||'Company'} — Daily stock history ${day}`);
}

async function renderStock(){
  stopStockListener(); let items=[],error=''; try{items=await listItems();}catch(err){error=friendlyError(err);}
  const manager=membership?.role==='inventory_manager';
  const lastReport=manager?localStorage.getItem(`inventroLastStockReport:${currentCompanyId()}`):null;
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="stock-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="stock-refresh">↻ Refresh</button></div>
    <section class="feature-header"><p class="eyebrow">Live inventory</p><h1>Stock</h1><p>${manager?'🔴 Red = at/below the low-stock limit. 🟡 Yellow = above the limit but within 50% of it. 🟢 Green = safely above that margin.':'🔴 Red = at/below the low-stock limit. 🟡 Yellow = above the limit but within 50% of it. 🟢 Green = safely above that margin.'}</p></section>
    ${manager?`<section class="inventory-tools"><div class="stock-search-wrap"><span>⌕</span><input id="stock-search" type="search" placeholder="Search stock by item name…" autocomplete="off"></div><div class="inventory-share-actions"><button class="small-action csv-btn" id="share-stock-csv" type="button">📊 Share current stock CSV</button></div></section>${lastReport?`<div class="report-history-note">Last reorder report sent: <strong>${escapeHtml(formatDate(lastReport))}</strong>. New red/yellow items after that time are not part of that old snapshot.</div>`:''}${stockReportSelectionHtml(items)}`:`<section class="inventory-tools"><div class="stock-search-wrap"><span>⌕</span><input id="stock-search" type="search" placeholder="Search stock by item name…" autocomplete="off"></div></section>`}
    ${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}<div id="stock-grid" class="stock-grid"></div></div>`;
  renderStockCards(items);
  root.querySelector('#stock-back').addEventListener('click',()=>{stopStockListener();navigateBack('home');});root.querySelector('#stock-refresh').addEventListener('click',()=>renderStock());root.querySelector('#stock-search').addEventListener('input',()=>renderStockCards(items));
  root.querySelector('#share-stock-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#share-stock-csv');b.disabled=true;b.textContent='Preparing CSV…';try{const mode=await shareCurrentStockCsv();showTemporaryMessage(mode==='shared'?'Current stock CSV ready to share.':'Current stock CSV downloaded.','success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📊 Share current stock CSV';}});
  root.querySelector('#share-selected-low-pdf')?.addEventListener('click',async()=>{const b=root.querySelector('#share-selected-low-pdf');b.disabled=true;b.textContent='Preparing report…';try{const yellowIds=[...root.querySelectorAll('.yellow-report-check:checked')].map(x=>x.value);const resendIds=[...root.querySelectorAll('.resend-report-check:checked')].map(x=>x.value);const result=await shareLowStockPdf({yellowIds,resendIds});showTemporaryMessage(result.mode==='shared'?`Supplier order ${result.orderId} ready to share.`:`Supplier order ${result.orderId} downloaded.`,'success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📄 Generate & share report';}});
  const companyId=currentCompanyId(); if(companyId){stockUnsubscribe=onSnapshot(collection(db,'companies',companyId,'items'),snap=>{const live=snap.docs.map(d=>({id:d.id,...d.data()}));renderStockCards(live);maybeNotifyStockState(live);},err=>showTemporaryMessage(friendlyError(err),'error'));}
}

async function renderMovement(type){
  if(type==='dispatch'&&!canDirectDispatch()){navigate('requests');return;}
  if(type==='receive'&&!canReceiveStock()){navigate('requests');return;}
  let items=[],departments=[],error='';try{items=await listItems();departments=await listDepartments();}catch(err){error=friendlyError(err);}
  const receive=type==='receive';
  const sorted=stockSort(items,false);
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="movement-back">‹ Back</button><div class="topbar-brand">Inventro</div></div>
    <section class="feature-header"><p class="eyebrow">Stock movement</p><h1>${receive?'Receive Stock':'Dispatch'}</h1><p>${receive?'Record a newly arrived delivery. If this delivery fulfills an outstanding supplier order, Inventro can close that order at the same time.':'Record stock leaving the store. Choose an item to see its current stock context before saving.'}</p></section>
    <section class="admin-card movement-card">${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}
      ${!receive?`<div class="field"><label for="movement-department">Department receiving stock</label><select id="movement-department"><option value="">Select department…</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>`:''}<div class="field"><label for="movement-item">Item</label><select id="movement-item">${sorted.map(i=>`<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} — ${i.quantity} ${escapeHtml(i.unit)}</option>`).join('')}</select></div>
      <div id="movement-item-insight" class="movement-insight"></div>
      <div class="field"><label for="movement-qty">Quantity</label><input id="movement-qty" type="number" min="0.01" step="0.01" placeholder="0"></div>
      <div class="field"><label for="movement-note">Note (optional)</label><input id="movement-note" type="text" maxlength="120" placeholder="${receive?'e.g. Supplier delivery':'e.g. Emergency kitchen issue'}"></div>
      ${receive?`<label class="fulfill-order-option"><input id="fulfill-outstanding-order" type="checkbox"><span><strong>Close outstanding supplier order</strong><small>If this delivery is the order that was previously sent, mark it as received/fulfilled.</small></span></label>`:''}
      <button class="btn btn-primary" id="movement-save" ${items.length?'':'disabled'}>${receive?'Record received stock':'Record dispatch'}</button>
    </section></div>`;
  const select=root.querySelector('#movement-item'), insight=root.querySelector('#movement-item-insight'), fulfillCheck=root.querySelector('#fulfill-outstanding-order');
  async function refreshInsight(){
    const item=items.find(i=>i.id===select.value); if(!item){insight.innerHTML='';return;}
    let moves=[]; try{moves=await listItemMovements(item.id);}catch(_){ }
    const lastDispatch=[...moves].reverse().find(m=>m.type==='dispatch');
    const lastReceive=[...moves].reverse().find(m=>m.type==='receive');
    const state=stockState(Number(item.quantity||0),Number(item.lowStockAlert||0));
    if(fulfillCheck) fulfillCheck.checked=!!itemHasOutstandingOrder(item);
    insight.innerHTML=`<div class="movement-insight-head"><strong>${escapeHtml(item.name)}</strong><span class="stock-state movement-state ${state}">${state==='low'?'Low':state==='near'?'Near low':'Good'}</span></div><div class="movement-insight-grid"><div><span>Stock now</span><strong>${Number(item.quantity||0)} ${escapeHtml(item.unit)}</strong></div><div><span>Low limit</span><strong>${Number(item.lowStockAlert||0)} ${escapeHtml(item.unit)}</strong></div><div><span>Last dispatch</span><strong>${lastDispatch?escapeHtml(formatDate(lastDispatch.createdAt)):'No record yet'}</strong></div><div><span>Last arrival</span><strong>${lastReceive?escapeHtml(formatDate(lastReceive.createdAt)):'No record yet'}</strong></div></div>${itemHasOutstandingOrder(item)?`<div class="outstanding-order-note">🔵 <strong>Supplier order outstanding</strong><span>Sent ${escapeHtml(formatDate(item.procurementOrderSentAt))} · ${escapeHtml(item.procurementOrderId)}</span></div>`:''}`;
  }
  select.addEventListener('change',refreshInsight); await refreshInsight();
  root.querySelector('#movement-back').addEventListener('click',()=>navigateBack('home'));
  root.querySelector('#movement-save').addEventListener('click',async()=>{const b=root.querySelector('#movement-save');b.disabled=true;b.textContent='Saving…';try{await changeStock(select.value,root.querySelector('#movement-qty').value,type,root.querySelector('#movement-note').value,{fulfillOutstandingOrder:!!fulfillCheck?.checked,department:root.querySelector('#movement-department')?.value||''});showTemporaryMessage(receive?'Received stock recorded.':'Dispatch recorded.','success');navigate('stock');}catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;b.textContent=receive?'Record received stock':'Record dispatch';}});
}

let myNotificationUnsubscribe=null;
let requestListUnsubscribe=null;
let requestListCompanyId=null;
let requestListRenderTimer=null;
function stopMyNotificationListener(){if(myNotificationUnsubscribe){myNotificationUnsubscribe();myNotificationUnsubscribe=null;}}
function stopRequestListListener(){
  if(requestListUnsubscribe) requestListUnsubscribe();
  requestListUnsubscribe=null;
  requestListCompanyId=null;
  if(requestListRenderTimer){clearTimeout(requestListRenderTimer);requestListRenderTimer=null;}
}
function startRequestListListener(){
  const companyId=currentCompanyId();
  if(!companyId) return;
  if(requestListUnsubscribe && requestListCompanyId===companyId) return;
  stopRequestListListener();
  requestListCompanyId=companyId;
  requestListUnsubscribe=onSnapshot(
    collection(db,'companies',companyId,'requests'),
    ()=>{
      if(view!=='requests') return;
      // Let the current request page refresh itself from the authoritative Firestore snapshot.
      // Debouncing prevents multiple writes (status/event/notification) from causing a render storm.
      if(requestListRenderTimer) clearTimeout(requestListRenderTimer);
      requestListRenderTimer=setTimeout(()=>{requestListRenderTimer=null;if(view==='requests') renderRequests();},50);
    },
    err=>console.warn('Request list listener:',err)
  );
}
function renderNotificationPanel(notifications){
  const panel=root.querySelector('#notification-list-wrap'); const title=root.querySelector('#notification-title');
  if(!panel||!title)return;
  const unread=notifications.filter(n=>!n.read).length;
  title.innerHTML=`🔔 My notifications ${unread?`<span class="notification-count">${unread}</span>`:''}`;
  panel.innerHTML=notifications.map(n=>`<article class="notification-item ${n.read?'read':'unread'}"><div><strong>${escapeHtml(n.title||'Request update')}</strong><p>${escapeHtml(n.message||'')}</p><small>${escapeHtml(formatDate(n.createdAt))}</small></div>${!n.read?`<button class="small-action" data-read-notification="${escapeHtml(n.id)}">Mark read</button>`:''}</article>`).join('')||`<div class="empty-team"><div class="empty-icon">🔔</div><strong>No notifications</strong><span>Your request updates will appear here.</span></div>`;
  panel.querySelectorAll('[data-read-notification]').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await markNotificationRead(btn.dataset.readNotification);}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
}
function startMyNotificationListener(){
  stopMyNotificationListener();
  const companyId=currentCompanyId(), uid=auth.currentUser?.uid;
  if(!companyId||!uid||!['chef','request'].includes(membership?.role))return;
  myNotificationUnsubscribe=onSnapshot(collection(db,'companies',companyId,'userNotifications',uid,'notifications'),snap=>{
    const notifications=snap.docs.map(d=>({id:d.id,...d.data()})).filter(n=>n.recipientUid===uid).sort((a,b)=>(Number(b.clientCreatedAt||b.createdAt?.toMillis?.()||0)-Number(a.clientCreatedAt||a.createdAt?.toMillis?.()||0))).slice(0,5);
    renderNotificationPanel(notifications);
    const newest=notifications[0]; const key=`inventroLastNotification:${companyId}:${uid}`; const previous=sessionStorage.getItem(key);
    if(newest?.id&&newest.id!==previous){sessionStorage.setItem(key,newest.id);if(!newest.read)showTemporaryMessage(`🔔 ${newest.title}: ${newest.message}`,'success');}
  },err=>console.warn('Notification listener:',err));
}

async function listMyNotifications() {
  const companyId=currentCompanyId(), uid=auth.currentUser?.uid;
  if(!companyId||!uid) return [];
  const snap=await getDocs(collection(db,'companies',companyId,'userNotifications',uid,'notifications'));
  return snap.docs.map(d=>({id:d.id,...d.data()})).filter(n=>n.recipientUid===uid).sort((a,b)=>(Number(b.clientCreatedAt||b.createdAt?.toMillis?.()||0)-Number(a.clientCreatedAt||a.createdAt?.toMillis?.()||0))).slice(0,5);
}

async function markNotificationRead(notificationId) {
  const companyId=currentCompanyId(), uid=auth.currentUser?.uid;
  if(!companyId||!uid) throw new Error('Your session is not available.');
  await updateDoc(doc(db,'companies',companyId,'userNotifications',uid,'notifications',notificationId),{read:true,readAt:serverTimestamp()});
}

async function renderRequests(){
  if(!canCreateRequest()&&!canManageRequests()){navigate('home');return;}
  let items=[],requests=[],departments=[],notifications=[],error='';
  try{items=await listItems();requests=await listRequests();departments=await listDepartments(); if(['chef','request'].includes(membership?.role)) notifications=await listMyNotifications();}catch(err){error=friendlyError(err);}
  const canManage=canManageRequests();
  const canViewAllRequests=['admin','inventory_manager'].includes(membership?.role);
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="requests-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="requests-refresh">↻ Refresh</button></div><section class="feature-header"><p class="eyebrow">Kitchen workflow</p><h1>Stock Requests</h1><p>Chef/Request users ask for stock for a specific department. Only the Inventory Manager approves or dispatches requests.</p></section>${['chef','request'].includes(membership?.role)?`<section class="admin-card"><div class="admin-card-title"><div><h2>New request</h2><p>Choose what the kitchen needs.</p></div></div><div class="field"><label for="request-item">Item</label><select id="request-item">${items.map(i=>`<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} — ${i.quantity} ${escapeHtml(i.unit)} available</option>`).join('')}</select></div><div class="field"><label for="request-department">Department</label><select id="request-department"><option value="">Select department…</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label for="request-qty">Quantity needed</label><input id="request-qty" type="number" min="0.01" step="0.01" placeholder="0"></div><div class="field"><label for="request-note">Reason / note</label><input id="request-note" type="text" maxlength="120" placeholder="e.g. Dinner preparation"></div><button class="btn btn-primary" id="request-save" ${items.length?'':'disabled'}>Send request</button></section>`:''}${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}${['chef','request'].includes(membership?.role)?`<section class="admin-card notification-panel"><div class="admin-card-title"><div><h2 id="notification-title">🔔 My notifications ${notifications.filter(n=>!n.read).length?`<span class="notification-count">${notifications.filter(n=>!n.read).length}</span>`:''}</h2><p>Updates about your stock requests appear here automatically.</p></div></div><div id="notification-list-wrap" class="notification-list">${notifications.map(n=>`<article class="notification-item ${n.read?'read':'unread'}"><div><strong>${escapeHtml(n.title||'Request update')}</strong><p>${escapeHtml(n.message||'')}</p><small>${escapeHtml(formatDate(n.createdAt))}</small></div>${!n.read?`<button class="small-action" data-read-notification="${escapeHtml(n.id)}">Mark read</button>`:''}</article>`).join('')||`<div class="empty-team"><div class="empty-icon">🔔</div><strong>No notifications</strong><span>Your request updates will appear here.</span></div>`}</div></section>`:''}<section class="admin-card"><div class="admin-card-title"><div><h2>${canViewAllRequests?'All requests':'My requests'}</h2><p>${requests.length} request${requests.length===1?'':'s'}.</p></div></div><div class="request-list">${requests.filter(r=>canViewAllRequests||r.requestedByUid===auth.currentUser?.uid).map(r=>`<article class="request-card"><div><div class="request-title"><strong>${escapeHtml(r.itemName)}</strong><span class="request-status ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></div><div class="request-qty">${r.quantity} ${escapeHtml(r.unit)}</div><div class="stock-meta">Department: <strong>${escapeHtml(r.department||'Not specified')}</strong> · By ${escapeHtml(r.requestedByEmail||'')} · ${escapeHtml(formatDate(r.createdAt))}</div>${r.note?`<div class="request-note">${escapeHtml(r.note)}</div>`:''}</div><div class="request-actions">${canManage&&r.status==='pending'?`<button class="small-action approve" data-request-action="approve" data-id="${escapeHtml(r.id)}">Approve</button><button class="small-action reject" data-request-action="reject" data-id="${escapeHtml(r.id)}">Reject</button>`:''}${canManage&&r.status==='approved'?`<button class="small-action approve" data-request-action="fulfill" data-id="${escapeHtml(r.id)}">Dispatch & Fulfill</button>`:''}</div></article>`).join('')||`<div class="empty-team"><div class="empty-icon">📝</div><strong>No requests yet</strong><span>New kitchen requests will appear here.</span></div>`}</div></section></div>`;
  root.querySelector('#requests-back').addEventListener('click',()=>navigateBack('home'));
  root.querySelector('#requests-refresh').addEventListener('click',()=>renderRequests());
  root.querySelector('#request-save')?.addEventListener('click',async()=>{const b=root.querySelector('#request-save');b.disabled=true;b.textContent='Sending…';try{await createStockRequest({itemId:root.querySelector('#request-item').value,quantity:root.querySelector('#request-qty').value,department:root.querySelector('#request-department').value,note:root.querySelector('#request-note').value});showTemporaryMessage('Stock request sent.','success');await renderRequests();}catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;b.textContent='Send request';}});
  root.querySelectorAll('[data-read-notification]').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await markNotificationRead(btn.dataset.readNotification);}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
  startMyNotificationListener();
  startRequestListListener();
  root.querySelectorAll('[data-request-action]').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{const action=btn.dataset.requestAction;if(action==='fulfill')await fulfillRequest(btn.dataset.id);else await updateRequestStatus(btn.dataset.id,action==='approve'?'approved':'rejected');showTemporaryMessage(action==='fulfill'?'Request fulfilled and stock dispatched.':'Request updated.','success');await renderRequests();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
}

async function renderHistory(){
  const role=membership?.role||'';
  const isAdmin=role==='admin';
  const today=localDateKey();
  const currentEmail=(auth.currentUser?.email||'').toLowerCase();
  let rows=[],departments=[],requestEvents=[],employees=[],error='';
  try{
    rows=await listHistory();
    departments=await listDepartments();
    employees=await listEmployees();
    if(role==='admin'||role==='inventory_manager'){
      requestEvents=await listRequestEvents();
    }else{
      const myRequests=(await listRequests()).filter(r=>r.requestedByUid===auth.currentUser?.uid);
      for(const r of myRequests){
        const snap=await getDocs(collection(db,'companies',currentCompanyId(),'requests',r.id,'events'));
        snap.docs.forEach(d=>requestEvents.push({id:d.id,requestId:r.id,...d.data()}));
        if(!snap.docs.length){
          requestEvents.push({id:`legacy-${r.id}-pending`,requestId:r.id,eventType:'pending',itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||role,actorUid:r.requestedByUid||'',actorEmail:r.requestedByEmail||'',actorRole:r.requestedByRole||role,createdAt:r.createdAt});
          if(r.status&&r.status!=='pending') requestEvents.push({id:`legacy-${r.id}-${r.status}`,requestId:r.id,eventType:r.status,itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||role,actorUid:r.fulfilledByUid||r.reviewedByUid||'',actorEmail:r.fulfilledByEmail||r.reviewedByEmail||'',actorRole:'inventory_manager',createdAt:r.updatedAt||r.createdAt});
        }
      }
    }
  }catch(err){error=friendlyError(err);}

  const roleRows=(r)=>rows.filter(x=>x.actorRole===r);
  const roleEvents=(r)=>requestEvents.filter(e=>e.actorRole===r || e.requestedByRole===r);

  // Build reliable Admin history events from the request documents too. This makes the
  // Request/Chef cards useful even when an older request was created before event logging,
  // or when an event write was interrupted. The request document's current status is used
  // as a fallback; it never replaces existing detailed events.
  if(isAdmin){
    try{
      const allRequests=await listRequests();
      const existingKeys=new Set(requestEvents.map(e=>`${e.requestId}:${e.eventType}`));
      for(const r of allRequests){
        const reqRole=r.requestedByRole||'';
        if(!['request','chef'].includes(reqRole)) continue;
        const base={requestId:r.id,itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:reqRole};
        const pendingKey=`${r.id}:pending`;
        if(!existingKeys.has(pendingKey)) requestEvents.push({id:`fallback-${r.id}-pending`,...base,eventType:'pending',actorUid:r.requestedByUid||'',actorEmail:r.requestedByEmail||'',actorRole:reqRole,createdAt:r.createdAt});
        if(r.status && r.status!=='pending'){
          const statusKey=`${r.id}:${r.status}`;
          if(!existingKeys.has(statusKey)) requestEvents.push({id:`fallback-${r.id}-${r.status}`,...base,eventType:r.status,actorUid:r.fulfilledByUid||r.reviewedByUid||'',actorEmail:r.fulfilledByEmail||r.reviewedByEmail||'',actorRole:'inventory_manager',createdAt:r.updatedAt||r.createdAt});
        }
      }
    }catch(err){ console.warn('Admin request history fallback:',err); }
  }
  const isDate=(value,day)=>{
    if(!day||day==='all') return true;
    const ms=value?.toMillis?.()||0; if(!ms)return false;
    return localDateKey(new Date(ms))===day;
  };
  const movementKind=(r)=>r.requestId?'requested-dispatch':r.type;
  const eventLabel=(e)=>({pending:'Request pending',approved:'Request approved',rejected:'Request rejected',fulfilled:'Request fulfilled'})[e.eventType]||e.eventType;
  const eventTime=(e)=>e.createdAt;
  const combinedForRole=(selectedRole)=>{
    if(selectedRole==='request'){
      // Request account history: show BOTH request activity and the actual Inventory Manager
      // dispatches that fulfilled requests created by Request accounts. For the signed-in
      // Request user, restrict it to that user's requests; for Admin's Request card, show
      // every Request-role account's activity.
      const requestRoleEvents=requestEvents.filter(e=>e.requestedByRole==='request');
      const requestMovementRows=rows.filter(r=>r.type==='dispatch' && r.requestId && r.requestedByRole==='request');
      const movementRows=(isAdmin ? requestMovementRows : requestMovementRows.filter(r=>(r.requestedByUid||'')===auth.currentUser?.uid || (r.requestedByEmail||'').toLowerCase()===currentEmail));
      const events=(isAdmin ? requestRoleEvents : requestRoleEvents.filter(e=>(e.requestedByUid||'')===auth.currentUser?.uid || (e.requestedByEmail||'').toLowerCase()===currentEmail));
      return [...movementRows.map(r=>({kind:'movement',time:r.createdAt,...r})),...events.map(e=>({kind:'request',time:e.createdAt,...e}))]
        .sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
    }
    if(selectedRole==='inventory_manager'){
      // Inventory Manager log book is the physical stock ledger: receiving and dispatching.
      return rows.filter(r=>r.actorRole==='inventory_manager').map(r=>({kind:'movement',time:r.createdAt,...r})).sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
    }
    if(selectedRole==='chef'){
      // Chef history: request activity created by Chef accounts plus fulfilment dispatches to Chef requests.
      const movementRows=rows.filter(r=>r.type==='dispatch' && r.requestId && r.requestedByRole==='chef')
        .map(r=>({kind:'movement',time:r.createdAt,...r}));
      const events=requestEvents.filter(e=>e.requestedByRole==='chef')
        .map(e=>({kind:'request',time:e.createdAt,...e}));
      return [...movementRows,...events].sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
    }
    // Admin is intentionally not an account card anymore. Keep this fallback for non-card callers.
    const movementRows=rows.filter(r=>r.actorRole===selectedRole).map(r=>({kind:'movement',time:r.createdAt,...r}));
    const events=requestEvents.filter(e=>e.requestedByRole===selectedRole || e.actorRole===selectedRole)
      .map(e=>({kind:'request',time:e.createdAt,...e}));
    return [...movementRows,...events].sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
  };

  function renderRows(list, opts={}){
    const target=root.querySelector('#history-list'); if(!target)return;
    const shown=list.filter(r=>{
      if(opts.day && !isDate(r.time||r.createdAt,opts.day))return false;
      const type=root.querySelector('#history-type')?.value||'all';
      const dept=root.querySelector('#history-department')?.value||'all';
      if(dept!=='all' && (r.department||'')!==dept)return false;
      if(type==='received' && !(r.kind==='movement'&&r.type==='receive'))return false;
      if(type==='dispatched' && !(r.kind==='movement'&&r.type==='dispatch'))return false;
      if(type==='requested-dispatch' && !(r.kind==='movement'&&r.type==='dispatch'&&r.requestId))return false;
      if(type.startsWith('request-') && !(r.kind==='request'&&r.eventType===type.slice(8)))return false;
      return true;
    });
    target.innerHTML=shown.map(r=>{
      if(r.kind==='request'){
        return `<article class="history-row request-history-row"><div class="history-icon">📝</div><div class="history-main"><strong>${escapeHtml(r.itemName||'Stock request')}</strong><span>${escapeHtml(eventLabel(r))} · ${Number(r.quantity||0)} ${escapeHtml(r.unit||'')}${r.department?` · Department: ${escapeHtml(r.department)}`:''}</span><small>${escapeHtml(r.actorEmail||r.requestedByEmail||'')} · ${escapeHtml(roleLabel(r.actorRole)||roleLabel(r.requestedByRole)||'')} · ${escapeHtml(formatDate(r.createdAt))}${r.requestId?` · Request ${escapeHtml(r.requestId.slice(0,8))}`:''}</small></div></article>`;
      }
      const requested=r.requestId?' · Requested by: '+(r.requestedByEmail||'') : '';
      const label=r.requestId?'Requested item dispatched':movementLabel(r.type);
      return `<article class="history-row"><div class="history-icon">${r.type==='receive'||r.type==='opening'?'＋':'−'}</div><div class="history-main"><strong>${escapeHtml(r.itemName)}</strong><span>${escapeHtml(label)} ${r.quantity} ${escapeHtml(r.unit)}${r.department?` · Department: ${escapeHtml(r.department)}`:''}</span><small>${escapeHtml(r.byEmail||'')} · ${escapeHtml(roleLabel(r.actorRole)||'')} · ${escapeHtml(formatDate(r.createdAt))}${requested}${r.note?' · '+escapeHtml(r.note):''}${r.editedAt?' · Edited '+escapeHtml(formatDate(r.editedAt)):''}</small></div>${canEditMovementRow(r)?`<div class="history-actions"><button class="small-action" data-edit-movement="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">Edit</button><button class="small-action reject" data-delete-movement="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">Delete</button></div>`:''}</article>`;
    }).join('')||`<div class="empty-team"><div class="empty-icon">🕘</div><strong>No matching log entries</strong><span>Try another date or filter.</span></div>`;
    attachHistoryActions();
  }

  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="history-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="history-refresh">↻ Refresh</button></div>
    <section class="feature-header"><p class="eyebrow">Daily log book</p><h1>History</h1><p>${isAdmin?'Select an account/role first, then filter only the activities belonging to that account. Admin remains read-only.':role==='request'?'Your log book shows only stock that the Inventory Manager actually dispatched for your requests.':role==='inventory_manager'?'Your log book shows receiving, direct dispatch and dispatches made to fulfill stock requests.':'Your department request and stock activity is shown here day by day.'}</p></section>
    ${isAdmin?`<section class="history-account-grid" id="history-account-grid"><button class="history-account-card active" data-history-role="inventory_manager" type="button"><span>📦</span><strong>Inventory Manager</strong><small>Receiving, dispatch & request fulfilment</small></button><button class="history-account-card" data-history-role="request" type="button"><span>📝</span><strong>Request</strong><small>Request activity & dispatched fulfilments</small></button><button class="history-account-card" data-history-role="chef" type="button"><span>👨‍🍳</span><strong>Chef</strong><small>Chef requests & dispatched fulfilments</small></button></section>`:''}
    <section class="history-tools"><div><label for="history-day">Date</label><input id="history-day" type="date" value="${today}"></div><div><label for="history-type">Activity</label><select id="history-type"></select></div><div><label for="history-department">Department</label><select id="history-department"><option value="all">All departments</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>${isAdmin||role==='inventory_manager'?`<button class="small-action csv-btn" id="share-day-csv" type="button">📊 Share day CSV</button>`:''}<button class="small-action" id="history-today" type="button">Today</button></section>
    ${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}<section class="admin-card"><div id="history-list" class="history-list"></div></section></div>`;

  let selectedRole=isAdmin?'inventory_manager':role;

  function setHistoryActivityOptions(){
    const select=root.querySelector('#history-type'); if(!select)return;
    const previous=select.value;
    let options=[];
    if(selectedRole==='inventory_manager'){
      options=[['all','All stock movement'],['received','Received items'],['dispatched','Dispatched items'],['requested-dispatch','Requested item dispatches']];
    }else if(selectedRole==='request'){
      options=isAdmin
        ? [['all','All request activity'],['request-pending','Request pending'],['request-approved','Request approved'],['request-rejected','Request rejected'],['request-fulfilled','Request fulfilled'],['requested-dispatch','Dispatched requested items']]
        : [['all','Dispatched to me'],['dispatched','Dispatched items']];
    }else if(selectedRole==='chef'){
      options=[['all','All Chef activity'],['request-pending','Request pending'],['request-approved','Request approved'],['request-rejected','Request rejected'],['request-fulfilled','Request fulfilled'],['requested-dispatch','Dispatched requested items']];
    }
    select.innerHTML=options.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
    if(options.some(([value])=>value===previous))select.value=previous;
  }
  setHistoryActivityOptions();

  const buildList=()=>{
    if(selectedRole==='request') return combinedForRole('request');
    if(selectedRole==='chef') return combinedForRole('chef');
    if(selectedRole==='inventory_manager') return combinedForRole('inventory_manager');
    return combinedForRole(role);
  };
  const refreshList=()=>{
    let list=buildList();
    if(role==='request') list=list.filter(r=>r.kind==='movement'&&r.type==='dispatch'&&r.requestId);
    if(role==='inventory_manager') list=list.filter(r=>r.kind==='movement'&&(r.type==='receive'||r.type==='dispatch'));
    renderRows(list,{day:root.querySelector('#history-day')?.value||today});
  };
  const attachHistoryActions=()=>{
    root.querySelectorAll('[data-edit-movement]').forEach(btn=>btn.addEventListener('click',async()=>{const [itemId,movementId]=btn.dataset.editMovement.split(':');const row=rows.find(x=>x.itemId===itemId&&x.id===movementId);if(!row)return;const type=prompt('Movement type: opening, receive, or dispatch',row.type);if(type===null)return;const qty=prompt('Correct quantity',String(row.quantity));if(qty===null)return;const note=prompt('Correct note (optional)',row.note||'');if(note===null)return;btn.disabled=true;try{await editMovement(itemId,movementId,{type:type.trim().toLowerCase(),quantity:qty,note});showTemporaryMessage('History corrected and stock recalculated.','success');await renderHistory();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
    root.querySelectorAll('[data-delete-movement]').forEach(btn=>btn.addEventListener('click',async()=>{const [itemId,movementId]=btn.dataset.deleteMovement.split(':');if(!confirm('Delete this history entry and recalculate the item stock?'))return;btn.disabled=true;try{await deleteMovement(itemId,movementId);showTemporaryMessage('History entry deleted and stock recalculated.','success');await renderHistory();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
  };
  root.querySelectorAll('[data-history-role]').forEach(btn=>btn.addEventListener('click',()=>{root.querySelectorAll('[data-history-role]').forEach(x=>x.classList.remove('active'));btn.classList.add('active');selectedRole=btn.dataset.historyRole;setHistoryActivityOptions();refreshList();}));
  root.querySelector('#history-type')?.addEventListener('change',refreshList);
  root.querySelector('#history-department')?.addEventListener('change',refreshList);
  root.querySelector('#history-day')?.addEventListener('change',refreshList);
  root.querySelector('#history-today')?.addEventListener('click',()=>{root.querySelector('#history-day').value=today;refreshList();});
  root.querySelector('#history-back').addEventListener('click',()=>navigateBack('home'));
  root.querySelector('#history-refresh').addEventListener('click',()=>renderHistory());
  root.querySelector('#share-day-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#share-day-csv');b.disabled=true;b.textContent='Preparing CSV…';try{const mode=await shareDailyHistoryCsv(root.querySelector('#history-day').value);showTemporaryMessage(mode==='shared'?'Daily CSV ready to share.':'Daily CSV downloaded.','success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📊 Share day CSV';}});
  refreshList();
}

async function renderStats(){
  let items=[],rows=[],error='';try{items=await listItems();rows=await listHistory();}catch(err){error=friendlyError(err);}
  const low=items.filter(i=>stockState(Number(i.quantity||0),Number(i.lowStockAlert||0))==='low').length;
  const near=items.filter(i=>stockState(Number(i.quantity||0),Number(i.lowStockAlert||0))==='near').length;
  const received=rows.filter(r=>r.type==='receive').length, dispatched=rows.filter(r=>r.type==='dispatch').length;
  const byItem=items.map(i=>{const m=rows.filter(r=>r.itemId===i.id);return {...i,receivedQty:m.filter(x=>x.type==='receive').reduce((a,x)=>a+Number(x.quantity||0),0),dispatchedQty:m.filter(x=>x.type==='dispatch').reduce((a,x)=>a+Number(x.quantity||0),0)};}).sort((a,b)=>b.dispatchedQty-a.dispatchedQty);
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="stats-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="stats-refresh">↻ Refresh</button></div><section class="feature-header"><p class="eyebrow">Inventory insights</p><h1>Stats</h1><p>Quantities are compared per item because kg, liters, pieces and boxes cannot be meaningfully added together.</p></section>${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}<div class="stat-grid"><div class="stat-card"><strong>${items.length}</strong><span>Total items</span></div><div class="stat-card danger"><strong>${low}</strong><span>Low stock</span></div><div class="stat-card warning"><strong>${near}</strong><span>Near low</span></div><div class="stat-card"><strong>${received}</strong><span>Receive events</span></div><div class="stat-card"><strong>${dispatched}</strong><span>Dispatch events</span></div></div><section class="admin-card"><div class="admin-card-title"><div><h2>Item usage</h2><p>Received and dispatched quantities by item.</p></div></div><div class="usage-list">${byItem.map(i=>`<div class="usage-row"><div><strong>${escapeHtml(i.name)}</strong><span>Current: ${Number(i.quantity||0)} ${escapeHtml(i.unit)}</span></div><div><span>Received: ${i.receivedQty} ${escapeHtml(i.unit)}</span><span>Dispatched: ${i.dispatchedQty} ${escapeHtml(i.unit)}</span></div></div>`).join('')||'<div class="empty-team">No items yet.</div>'}</div></section></div>`;
  root.querySelector('#stats-back').addEventListener('click',()=>navigateBack('home'));root.querySelector('#stats-refresh').addEventListener('click',()=>renderStats());
}

async function renderAdmin() {
  const user = auth.currentUser;
  if (!membership || membership.role !== 'admin') {
    navigate('home');
    return;
  }

  let employees = [];
  let departments = [];
  let error = '';
  let loading = true;
  let activeTab = 'team';

  function draw(tab = activeTab) {
    activeTab = tab;
    root.innerHTML = `
      <div class="dashboard admin-page">
        <div class="topbar">
          <button class="back-btn" id="admin-back">‹ Back to workspace</button>
          <div class="topbar-brand">Inventro</div>
          <div class="user-pill">
            <div class="avatar">${escapeHtml((user?.displayName?.[0] || 'A').toUpperCase())}</div>
            <div class="user-email">${escapeHtml(user?.email || '')}</div>
          </div>
        </div>

        <section class="admin-header">
          <p class="eyebrow">Administration</p>
          <h1>Admin Center</h1>
          <p>Manage your team, inventory setup, and company controls from one organized workspace.</p>
        </section>

        <style>
          .admin-nav{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 18px}
          .admin-nav-btn{appearance:none;border:1px solid var(--border);background:var(--surface);border-radius:12px;padding:13px 14px;text-align:left;cursor:pointer;transition:.15s ease;box-shadow:var(--shadow-sm)}
          .admin-nav-btn:hover{border-color:var(--border-strong);transform:translateY(-1px)}
          .admin-nav-btn.active{border-color:#bcd3ff;background:var(--primary-soft);box-shadow:0 0 0 2px rgba(37,99,235,.06)}
          .admin-nav-icon{font-size:19px;display:block;margin-bottom:5px}
          .admin-nav-btn strong{display:block;font-size:13px;color:var(--text)}
          .admin-nav-btn span{display:block;margin-top:3px;color:var(--text-muted);font-size:10px;line-height:1.35}
          .admin-panel{display:none}.admin-panel.active{display:block}
          .admin-section-label{display:flex;align-items:center;gap:9px;margin:0 0 12px;color:var(--text-soft);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}
          .admin-section-label:after{content:"";height:1px;background:var(--border);flex:1}
          .admin-danger-card{border-color:#fecaca;background:#fffafa}
          .admin-danger-card h2{color:#991b1b}
          .admin-info-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
          .admin-info-box{padding:13px;border:1px solid var(--border);border-radius:11px;background:var(--surface-soft)}
          .admin-info-box span{display:block;color:var(--text-muted);font-size:10px;margin-bottom:4px}.admin-info-box strong{font-size:13px;word-break:break-word}
          @media(max-width:650px){.admin-nav{grid-template-columns:1fr}.admin-info-grid{grid-template-columns:1fr}.user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis}}
        </style>

        <nav class="admin-nav" aria-label="Admin sections">
          <button type="button" class="admin-nav-btn ${activeTab === 'team' ? 'active' : ''}" data-admin-tab="team">
            <span class="admin-nav-icon">👥</span><strong>Team Management</strong><span>Employees, roles & access days</span>
          </button>
          <button type="button" class="admin-nav-btn ${activeTab === 'inventory' ? 'active' : ''}" data-admin-tab="inventory">
            <span class="admin-nav-icon">📦</span><strong>Inventory Setup</strong><span>Add and configure stock items</span>
          </button>
          <button type="button" class="admin-nav-btn ${activeTab === 'departments' ? 'active' : ''}" data-admin-tab="departments">
            <span class="admin-nav-icon">🏢</span><strong>Departments</strong><span>Create departments used for dispatch & requests</span>
          </button>
          <button type="button" class="admin-nav-btn ${activeTab === 'company' ? 'active' : ''}" data-admin-tab="company">
            <span class="admin-nav-icon">⚙️</span><strong>Company Controls</strong><span>Company information & danger zone</span>
          </button>
        </nav>

        <div class="admin-panel ${activeTab === 'team' ? 'active' : ''}" data-admin-panel="team">
          <div class="admin-section-label">Team management</div>
          <section class="admin-card">
            <div class="admin-card-title">
              <div><h2>Add employee</h2><p>The employee must use this exact Google email and your company's 6-digit code to join.</p></div>
            </div>
            <div class="field"><label for="employee-email">Employee Gmail</label><input type="text" id="employee-email" placeholder="employee@gmail.com" autocomplete="off" /></div>
            <div class="field"><label for="employee-role">Role</label><select id="employee-role"><option value="inventory_manager">Inventory Manager</option><option value="chef">Chef</option><option value="request">Request</option></select></div>
            <div class="field"><label>Login access days</label><div class="day-grid">${WEEK_DAYS.map(([key, label]) => `<label class="day-option"><input type="checkbox" value="${key}" checked /><span>${label.slice(0, 3)}</span></label>`).join('')}</div><p class="helper-text">On an unchecked day, this employee will not be allowed to enter the company workspace.</p></div>
            ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ''}
            <button class="btn btn-primary" id="add-employee-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner spinner-dark"></span> Loading team…' : 'Add employee'}</button>
          </section>

          <section class="admin-card">
            <div class="admin-card-title"><div><h2>Team members</h2><p>${employees.length} employee${employees.length === 1 ? '' : 's'} in this company.</p></div><button class="refresh-btn" id="refresh-team" type="button">↻ Refresh</button></div>
            <div class="team-list">
              ${employees.length === 0 ? `<div class="empty-team"><div class="empty-icon">👥</div><strong>No employees added yet</strong><span>Add your first employee above.</span></div>` : employees.map((employee) => `
                <div class="employee-row" data-email="${escapeHtml(employee.email)}">
                  <div class="employee-main"><div class="employee-avatar">${escapeHtml((employee.email?.[0] || 'E').toUpperCase())}</div><div><strong>${escapeHtml(employee.email)}</strong><span>${escapeHtml(roleLabel(employee.role))} · ${employee.status === 'active' ? 'Active' : 'Invited'}</span></div></div>
                  <div class="employee-controls">
                    <select class="employee-role"><option value="inventory_manager" ${employee.role === 'inventory_manager' ? 'selected' : ''}>Inventory Manager</option><option value="chef" ${employee.role === 'chef' ? 'selected' : ''}>Chef</option><option value="request" ${employee.role === 'request' ? 'selected' : ''}>Request</option></select>
                    <div class="mini-days">${WEEK_DAYS.map(([key, label]) => `<label title="${label}"><input type="checkbox" data-day="${key}" ${employee.workingDays?.includes(key) ? 'checked' : ''} /><span>${key[0].toUpperCase()}</span></label>`).join('')}</div>
                    <button class="access-btn ${employee.status === 'active' ? 'disable' : 'enable'}" type="button">${employee.status === 'active' ? 'Disable login' : 'Enable login'}</button>
                  </div>
                </div>`).join('')}
            </div>
          </section>
        </div>

        <div class="admin-panel ${activeTab === 'inventory' ? 'active' : ''}" data-admin-panel="inventory">
          <div class="admin-section-label">Inventory setup</div>
          <section class="admin-card admin-inventory-card">
            <div class="admin-card-title"><div><h2>➕ Add inventory item</h2><p>Only the company Admin can create new stock items.</p></div></div>
            <div class="field"><label for="admin-item-name">Item name</label><input id="admin-item-name" type="text" placeholder="e.g. Basmati Rice" maxlength="80"></div>
            <div class="field"><label for="admin-item-unit">Unit</label><select id="admin-item-unit">${INVENTORY_UNITS.map(u => `<option value="${u}">${u}</option>`).join('')}</select></div>
            <div class="two-fields"><div class="field"><label for="admin-opening-stock">Opening stock</label><input id="admin-opening-stock" type="number" min="0" step="0.01" value="0"></div><div class="field"><label for="admin-low-stock">Low stock alert</label><input id="admin-low-stock" type="number" min="0" step="0.01" value="0"></div></div>
            <div class="image-preview-box"><div class="preview-placeholder">🖼️</div><div><strong>Automatic item photo</strong><span>Inventro will try to find an image when you save the item.</span></div></div>
            <button class="btn btn-primary" id="admin-save-item" type="button">Save inventory item</button><div id="admin-item-message"></div>
          </section>
          <section class="admin-card"><div class="admin-card-title"><div><h2>Inventory permissions</h2><p>Item creation is restricted to this Admin section. Inventory Manager can operate stock without adding new item definitions.</p></div></div><div class="admin-info-grid"><div class="admin-info-box"><span>Item creation</span><strong>Admin only</strong></div><div class="admin-info-box"><span>Stock operations</span><strong>Admin + Inventory Manager</strong></div></div></section>
        </div>

        <div class="admin-panel ${activeTab === 'departments' ? 'active' : ''}" data-admin-panel="departments">
          <div class="admin-section-label">Department setup</div>
          <section class="admin-card">
            <div class="admin-card-title"><div><h2>🏢 Add department</h2><p>Departments appear in Inventory Manager dispatch and in Chef/Request stock requests.</p></div></div>
            <div class="field"><label for="department-name">Department name</label><input id="department-name" type="text" maxlength="60" placeholder="e.g. Main Kitchen"></div>
            <button class="btn btn-primary" id="add-department-btn" type="button">Add department</button>
          </section>
          <section class="admin-card"><div class="admin-card-title"><div><h2>Departments</h2><p>${departments.length} department${departments.length===1?'':'s'} configured.</p></div></div><div class="department-list">${departments.length?departments.map(d=>`<div class="department-row"><div><strong>${escapeHtml(d.name)}</strong><span>Available for dispatch, requests and history filters</span></div><button class="small-action reject" data-delete-department="${escapeHtml(d.id)}" type="button">Delete</button></div>`).join(''):`<div class="empty-team"><div class="empty-icon">🏢</div><strong>No departments yet</strong><span>Add at least one department before staff can dispatch/request stock for it.</span></div>`}</div></section>
        </div>

        <div class="admin-panel ${activeTab === 'company' ? 'active' : ''}" data-admin-panel="company">
          <div class="admin-section-label">Company controls</div>
          <section class="admin-card">
            <div class="admin-card-title"><div><h2>Company information</h2><p>Basic information for the company currently managed by this Admin.</p></div></div>
            <div class="admin-info-grid"><div class="admin-info-box"><span>Company</span><strong>${escapeHtml(membership?.companyName || '—')}</strong></div><div class="admin-info-box"><span>Your role</span><strong>Admin</strong></div><div class="admin-info-box"><span>Admin email</span><strong>${escapeHtml(user?.email || '—')}</strong></div><div class="admin-info-box"><span>Company ID</span><strong>${escapeHtml(membership?.companyId || '—')}</strong></div></div>
          </section>
          <section class="admin-card admin-danger-card">
            <div class="admin-card-title"><div><h2>⚠️ Danger zone</h2><p>Deleting the company permanently removes its Firestore company data. This action should only be used when you are certain.</p></div></div>
            <button class="btn btn-danger" id="admin-delete-company" type="button">Delete company</button>
          </section>
        </div>
      </div>`;

    root.querySelector('#admin-back').addEventListener('click', () => navigateBack('home'));

    root.querySelectorAll('[data-admin-tab]').forEach((btn) => btn.addEventListener('click', () => draw(btn.dataset.adminTab)));
    root.querySelector('#add-department-btn')?.addEventListener('click', async () => { const b=root.querySelector('#add-department-btn'); b.disabled=true; try{await createDepartment(root.querySelector('#department-name').value); showTemporaryMessage('Department added.','success'); departments=await listDepartments(); draw('departments');}catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;} });
    root.querySelectorAll('[data-delete-department]').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Delete this department? Existing history will remain, but it will no longer be available for new dispatches or requests.'))return;btn.disabled=true;try{await deleteDepartment(btn.dataset.deleteDepartment);showTemporaryMessage('Department deleted.','success');departments=await listDepartments();draw('departments');}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));

    const saveItemBtn = root.querySelector('#admin-save-item');
    saveItemBtn?.addEventListener('click', async () => {
      saveItemBtn.disabled = true;
      saveItemBtn.innerHTML = '<span class="spinner spinner-dark"></span> Finding image & saving…';
      const msg = root.querySelector('#admin-item-message');
      try {
        await createInventoryItem({ name: root.querySelector('#admin-item-name').value, unit: root.querySelector('#admin-item-unit').value, openingStock: root.querySelector('#admin-opening-stock').value, lowStockAlert: root.querySelector('#admin-low-stock').value });
        msg.innerHTML = '<div class="success-box">Item added successfully. You can view it in Stock.</div>';
        root.querySelector('#admin-item-name').value = '';
        root.querySelector('#admin-opening-stock').value = '0';
        root.querySelector('#admin-low-stock').value = '0';
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      } finally {
        saveItemBtn.disabled = false;
        saveItemBtn.textContent = 'Save inventory item';
      }
    });

    root.querySelector('#admin-delete-company')?.addEventListener('click', async () => {
      const companyName = membership?.companyName || '';
      const typed = prompt(`This permanently deletes the company and its data. Type the exact company name to continue:\n\n${companyName}`);
      if (typed !== companyName) {
        if (typed !== null) showTemporaryMessage('Company name did not match. Deletion cancelled.', 'error');
        return;
      }
      const confirmation = prompt('Final confirmation: type DELETE to permanently delete this company.');
      if (confirmation !== 'DELETE') return;
      const btn = root.querySelector('#admin-delete-company');
      btn.disabled = true; btn.textContent = 'Deleting…';
      try { await deleteCompanyCompletely(); clearEmployeeCodeVerification(); await signOut(); }
      catch (err) { btn.disabled = false; btn.textContent = 'Delete company'; showTemporaryMessage(friendlyError(err), 'error'); }
    });

    const addBtn = root.querySelector('#add-employee-btn');
    if (!loading) {
      addBtn.addEventListener('click', async () => {
        error = '';
        const email = root.querySelector('#employee-email').value;
        const role = root.querySelector('#employee-role').value;
        const days = [...root.querySelectorAll('.day-option input:checked')].map((input) => input.value);
        addBtn.disabled = true; addBtn.textContent = 'Adding employee…';
        try { await addEmployee(email, role, days); showTemporaryMessage('Employee added. They can now join with the company code.', 'success'); await loadEmployees(); }
        catch (err) { error = friendlyError(err); loading = false; draw(activeTab); }
      });
    }

    root.querySelector('#refresh-team').addEventListener('click', loadEmployees);
    root.querySelectorAll('.employee-row').forEach((row) => {
      const employeeEmail = row.dataset.email;
      const roleSelect = row.querySelector('.employee-role');
      const accessBtn = row.querySelector('.access-btn');
      async function saveEmployeeChanges() {
        const workingDays = [...row.querySelectorAll('[data-day]:checked')].map((input) => input.dataset.day);
        if (workingDays.length === 0) { showTemporaryMessage('Select at least one access day.', 'error'); return; }
        try { await updateEmployee(employeeEmail, { role: roleSelect.value, workingDays }); showTemporaryMessage('Employee permissions updated.', 'success'); await loadEmployees(); }
        catch (err) { showTemporaryMessage(friendlyError(err), 'error'); }
      }
      roleSelect.addEventListener('change', saveEmployeeChanges);
      row.querySelectorAll('[data-day]').forEach((checkbox) => checkbox.addEventListener('change', saveEmployeeChanges));
      accessBtn.addEventListener('click', async () => {
        try {
          const newStatus = employees.find((e) => e.email === employeeEmail)?.status === 'active' ? 'disabled' : 'invited';
          await updateEmployee(employeeEmail, { status: newStatus });
          showTemporaryMessage(newStatus === 'disabled' ? 'Employee login disabled.' : 'Employee login enabled.', 'success');
          await loadEmployees();
        } catch (err) { showTemporaryMessage(friendlyError(err), 'error'); }
      });
    });
  }

  async function loadEmployees() {
    loading = true; error = ''; draw(activeTab);
    try { employees = await listEmployees(); departments = await listDepartments(); }
    catch (err) { error = friendlyError(err); }
    finally { loading = false; draw(activeTab); }
  }

  await loadEmployees();
}

// ---------------- router ----------------
let view = 'loading', membership = null, justCreatedCode = null, returnToJoinAfterSignOut = false;

function render() {
  if (view !== 'stock') stopStockListener();
  if (view !== 'requests') stopRequestListListener();
  switch (view) {
    case 'welcome':
      renderWelcome({ onCreate: () => navigate('create'), onJoin: () => navigate('join') });
      break;
    case 'create':
      renderCreateCompany({
        onBack: () => navigateBack('welcome'),
        onDone: (code) => { justCreatedCode = code; navigate('created'); }
      });
      break;
    case 'created':
      renderCompanyCreated({
        code: justCreatedCode,
        onContinue: async () => { membership = await getMyMembership(); startRealtimeSync(); navigate('home'); }
      });
      break;
    case 'join':
      renderJoinCompany({
        onBack: () => navigateBack('welcome'),
        onDone: async () => { membership = await getMyMembership(); startRealtimeSync(); navigate('home'); }
      });
      break;
    case 'home':
      renderHome(membership);
      break;
    case 'employeeCode':
      renderEmployeeCode();
      break;
    case 'stock':
      renderStock();
      break;
    case 'dispatch':
      renderMovement('dispatch');
      break;
    case 'receive':
      renderMovement('receive');
      break;
    case 'requests':
      renderRequests();
      break;
    case 'stats':
      renderStats();
      break;
    case 'history':
    case 'logbook':
      renderHistory();
      break;
    case 'admin':
      renderAdmin();
      break;
    default:
      root.innerHTML = `<div class="screen"><p class="subtitle">Loading…</p></div>`;
  }
}
historyNavigationReady = true;
history.replaceState({ inventro: true, view }, '', location.href);
render();

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    stopRequestBadgeListener();
    stopMyNotificationListener();
    stopRequestListListener();
    stopRealtimeSync();
    if (homeStatusUnsubscribe) homeStatusUnsubscribe();
    homeStatusUnsubscribe = null;
    stopHomeRequestNotificationAlert();
    membership = null;
    if (returnToJoinAfterSignOut) {
      returnToJoinAfterSignOut = false;
      view = 'join';
    } else {
      view = 'welcome';
    }
    history.replaceState({ inventro: true, view }, '', location.href);
    render();
    return;
  }
  membership = await getMyMembership();
  if (membership) { startRequestBadgeListener(); startRealtimeSync(); }

  if (membership) {
    if (membership.role === 'admin') {
      view = 'home';
    } else if (isEmployeeCodeVerified(membership.companyId)) {
      view = 'home';
    } else {
      view = 'employeeCode';
    }
  } else if (view === 'loading') {
    view = 'welcome';
  }

  // The first authenticated screen becomes the real SPA history root. This
  // prevents Android Back from returning to the pre-auth 'loading' entry.
  history.replaceState({ inventro: true, view }, '', location.href);
  render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
