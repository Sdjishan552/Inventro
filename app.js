import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, getDoc, getDocs, setDoc, deleteDoc, updateDoc, serverTimestamp, writeBatch, onSnapshot, runTransaction, query, where, enableMultiTabIndexedDbPersistence
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
      status: 'active', addedAt: serverTimestamp(), joinedAt: serverTimestamp(), uid: user.uid, displayName: user.displayName || ''
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


function isStockRequesterRole(role) { return ['stock_requester','chef','request'].includes(String(role||'').toLowerCase()); }
function normalizedRole(role) { return isStockRequesterRole(role) ? 'stock_requester' : String(role||''); }
function isEditableTransactionRole(role) { return ['inventory_manager','stock_requester','chef','request'].includes(String(role||'')); }

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
  if (employee.status === 'disabled') {
    throw new Error('Your Inventro login has been disabled by the company admin.');
  }

  const allowedDays = Array.isArray(employee.workingDays)
    ? employee.workingDays
    : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  if (!allowedDays.includes(todayKey())) {
    throw new Error(`You do not have Inventro access today. Your allowed days are: ${allowedDays.map(d => WEEK_DAYS.find(([key]) => key === d)?.[1] || d).join(', ')}.`);
  }

  if (employee.status === 'invited') {
    await updateDoc(employeeSnap.ref, { status: 'active', uid: user.uid, joinedAt: serverTimestamp(), displayName: user.displayName || '' });
  }
  localStorage.setItem('inventroEmployeeVerified', companyId);
  localStorage.setItem(`inventroCompanyCodeVersion:${companyId}`, String((await getDoc(doc(db,'companies',companyId))).data()?.companyCodeVersion || 'legacy'));
  return true;
}

function isEmployeeCodeVerified(companyId) {
  return localStorage.getItem('inventroEmployeeVerified') === companyId;
}

function clearEmployeeCodeVerification() {
  localStorage.removeItem('inventroEmployeeVerified');
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

  await setDoc(employeeRef, { status: 'active', uid: user.uid, joinedAt: serverTimestamp(), displayName: user.displayName || '' }, { merge: true });
  const companySnap = await getDoc(doc(db, 'companies', companyId));
  await setDoc(doc(db, 'memberships', user.uid), {
    companyId, companyName: companySnap.data()?.name ?? '', role: employee.role, email: emailLower
  });
  return { companyId, role: employee.role };
}

function friendlyError(err) {
  if (err?.code === 'auth/popup-closed-by-user') return 'Sign-in was closed before finishing. Try again.';
  if (err?.code === 'permission-denied' || /Missing or insufficient permissions/i.test(String(err?.message||''))) {
    return 'Firebase permission denied. Make sure the latest firestore.rules from this Inventro build has been published in Firebase Console. Your PIN was accepted; this is a Firestore Rules issue, not a PIN issue.';
  }
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

const employeeDirectory = new Map();

async function syncMyEmployeeProfile() {
  const companyId = currentCompanyId();
  const user = auth.currentUser;
  if (!companyId || !user?.email) return;
  const email = user.email.toLowerCase();
  const ref = doc(db, 'companies', companyId, 'employees', email);
  try {
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data()?.status === 'active' && user.displayName && snap.data()?.displayName !== user.displayName) {
      await updateDoc(ref, { displayName: user.displayName });
    }
  } catch (err) { console.warn('Employee display name sync:', err); }
}

async function listEmployees() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  // The Employees collection is already kept live by startRealtimeSync().
  // Reuse that in-memory copy instead of re-reading the whole collection
  // from Firestore every time the Admin/Requests/History screens open.
  const useLiveCache = realtimeEmployeesReady && realtimeCompanyId === companyId;
  const rawEmployees = useLiveCache
    ? realtimeLatestEmployees.map(d => ({...d}))
    : (await getDocs(collection(db, 'companies', companyId, 'employees'))).docs.map((item) => ({ id: item.id, ...item.data() }));
  const employees = rawEmployees.filter((employee) => employee.role !== 'admin');
  employees.forEach(employee => {
    const email = String(employee.email || employee.id || '').trim().toLowerCase();
    if (email) employeeDirectory.set(email, {
      name: String(employee.displayName || employee.name || '').trim(),
      role: employee.role || ''
    });
  });
  return employees;
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
  if (!['inventory_manager', 'transaction_manager', 'stock_requester', 'chef', 'request'].includes(role)) {
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

function formatQty(value){
  const n=Number(value||0);
  if(!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toLocaleString('en-IN',{maximumFractionDigits:2});
}

function localDateKey(d=new Date()){const x=d instanceof Date?d:new Date(d);const y=x.getFullYear();const m=String(x.getMonth()+1).padStart(2,'0');const day=String(x.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}

function isMobileDevice(){return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||'');}

const PIN_LOCK_MS = 5 * 60 * 1000;
let pinUnlockedUntil = 0;
let pinActivityTimer = null;
// The PIN hash used to live only in localStorage (one PIN per device). It now
// lives in Firestore on the user's own memberships/{uid} doc, which the
// existing rules already let a user fully read/write themselves. `membership`
// is refreshed from that doc on every sign-in (see onAuthStateChanged below),
// so reading the PIN hash off it is enough to keep it in sync across devices.
function storedPinHash(){return membership?.securityPinHash||null;}
function pinUnlocked(){return !!storedPinHash() && Date.now() < pinUnlockedUntil;}
async function hashPin(pin){const data=new TextEncoder().encode(pin);const buf=await crypto.subtle.digest('SHA-256',data);return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function touchPinSession(){if(storedPinHash()){pinUnlockedUntil=Date.now()+PIN_LOCK_MS;}}
function armPinAutoLock(){clearTimeout(pinActivityTimer);pinActivityTimer=setTimeout(()=>{pinUnlockedUntil=0;},PIN_LOCK_MS);}
function resetPinActivity(){if(pinUnlocked()){touchPinSession();armPinAutoLock();}}
['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev,()=>{if(view!=='welcome'&&view!=='employeeCode')resetPinActivity();},{passive:true}));
async function setPersonalPin(pin){
  if(!/^\d{4,8}$/.test(String(pin))) throw new Error('PIN must contain 4 to 8 digits.');
  const user=auth.currentUser; if(!user) throw new Error('Not signed in.');
  const hash=await hashPin(String(pin));
  await setDoc(doc(db,'memberships',user.uid),{securityPinHash:hash,securityPinUpdatedAt:serverTimestamp()},{merge:true});
  membership={...(membership||{}),securityPinHash:hash};
  pinUnlockedUntil=Date.now()+PIN_LOCK_MS; armPinAutoLock();
}

// ---- Fingerprint / face unlock (WebAuthn platform authenticator) ----
// This swaps the typed PIN for the device's own fingerprint/face prompt on
// phones that support it (Android/iOS via Chrome, Safari, etc). Desktops and
// laptops have no such sensor, so they always fall back to the cloud PIN
// above. Note this app has no backend server, so the fingerprint check is
// verified locally by the OS/browser, not by a server-side signature — the
// real access control is still the Firebase sign-in plus the PIN in
// Firestore; the fingerprint is a convenience gate on top of that, same as
// unlocking a phone's screen.
function biometricDeviceKey(){return `inventroBiometricEnabled:${auth.currentUser?.uid||''}`;}
function biometricCredentialKey(){return `inventroBiometricCredId:${auth.currentUser?.uid||''}`;}
function biometricEnabledOnThisDevice(){return localStorage.getItem(biometricDeviceKey())==='1';}
// True only when biometric is on AND we hold the specific credential id
// needed to target the platform authenticator directly. A device enrolled
// before this fix will have the flag but no id — treat that as off and
// clear the stale flag, rather than repeating the broken picker flow.
function biometricReadyOnThisDevice(){
  if(!biometricEnabledOnThisDevice()) return false;
  if(!localStorage.getItem(biometricCredentialKey())){ localStorage.removeItem(biometricDeviceKey()); return false; }
  return true;
}
function bufferToBase64url(buf){
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64urlToBuffer(str){
  const pad='='.repeat((4 - str.length % 4) % 4);
  const base64=(str+pad).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  const buf=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) buf[i]=raw.charCodeAt(i);
  return buf.buffer;
}
async function platformAuthAvailable(){
  try{ return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch(e){ return false; }
}
async function registerBiometricUnlock(){
  const user=auth.currentUser; if(!user) throw new Error('Not signed in.');
  const cred=await navigator.credentials.create({publicKey:{
    challenge:crypto.getRandomValues(new Uint8Array(32)),
    rp:{name:'Inventro',id:location.hostname},
    user:{id:new TextEncoder().encode(user.uid),name:user.email||'inventro-user',displayName:user.displayName||user.email||'Inventro user'},
    pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    // residentKey 'discouraged' (not 'required') keeps this a plain device
    // credential rather than a discoverable passkey — it never gets synced
    // into Google Password Manager or offered in its account-picker sheet.
    // Paired with allowCredentials below, this makes verifyWithBiometric()
    // go straight to a silent fingerprint/face prompt every time.
    authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'discouraged',userVerification:'required'},
    timeout:60000
  }});
  localStorage.setItem(biometricDeviceKey(),'1');
  localStorage.setItem(biometricCredentialKey(),bufferToBase64url(cred.rawId));
  // Best-effort bookkeeping only (which accounts have a device enrolled anywhere) — never used for verification.
  setDoc(doc(db,'memberships',user.uid),{biometricEnrolled:true},{merge:true}).catch(()=>{});
}
async function verifyWithBiometric(){
  const credId=localStorage.getItem(biometricCredentialKey());
  if(!credId) throw new Error('No fingerprint credential on this device.');
  await navigator.credentials.get({publicKey:{
    challenge:crypto.getRandomValues(new Uint8Array(32)),
    rpId:location.hostname,
    userVerification:'required',
    timeout:60000,
    // Targeting the exact credential is what skips Google's "Use saved
    // passkey?" account-chooser sheet and goes straight to the device's
    // own fingerprint/face prompt.
    allowCredentials:[{type:'public-key',id:base64urlToBuffer(credId),transports:['internal']}]
  }});
}
async function offerBiometricSetup(){
  if(!(isMobileDevice() && !biometricEnabledOnThisDevice() && await platformAuthAvailable())) return;
  if(!window.confirm('Use your fingerprint (or face unlock) on this device instead of typing the PIN each time?')) return;
  try{ await registerBiometricUnlock(); showTemporaryMessage('Fingerprint unlock turned on for this device.','success'); }
  catch(e){ /* device declined/unsupported the prompt — silently keep using the PIN */ }
}
function pinModal(action, setup=false){
  return new Promise((resolve,reject)=>{
    const old=document.getElementById('inventro-pin-modal'); if(old) old.remove();
    const stored=storedPinHash();
    const title=setup?'Create your Inventro PIN':`Enter PIN to ${action}`;
    const subtitle=setup?'Create a 4–8 digit personal PIN. It is separate from the company code.':'This PIN is required before this stock transaction can be saved.';
    const modal=document.createElement('div'); modal.id='inventro-pin-modal'; modal.className='pin-modal-backdrop';
    modal.innerHTML=`<div class="pin-modal" role="dialog" aria-modal="true" aria-labelledby="pin-modal-title"><div class="pin-modal-icon">🔐</div><h2 id="pin-modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p><div class="pin-modal-field"><label for="pin-modal-input">${setup?'New PIN':'Personal PIN'}</label><div class="pin-modal-input-wrap"><input id="pin-modal-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="4–8 digits"><button type="button" id="pin-modal-toggle" aria-label="Show PIN">👁</button></div></div>${setup?'<div class="pin-modal-field"><label for="pin-modal-confirm">Confirm PIN</label><div class="pin-modal-input-wrap"><input id="pin-modal-confirm" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Re-enter PIN"><button type="button" data-confirm-toggle aria-label="Show PIN">👁</button></div></div>':''}<div class="pin-modal-actions"><button type="button" class="small-action" id="pin-modal-cancel">Cancel</button><button type="button" class="btn btn-primary" id="pin-modal-submit">${setup?'Create PIN':'Verify PIN'}</button></div><div class="pin-modal-error" id="pin-modal-error" hidden></div></div>`;
    document.body.appendChild(modal);
    const input=modal.querySelector('#pin-modal-input'), confirm=modal.querySelector('#pin-modal-confirm'), err=modal.querySelector('#pin-modal-error');
    const fail=(msg)=>{err.textContent=msg;err.hidden=false;input.focus();};
    const close=(ok,value)=>{modal.remove();ok?resolve(value):reject(new Error('PIN required.'));};
    modal.querySelector('#pin-modal-cancel').addEventListener('click',()=>close(false));
    modal.addEventListener('click',e=>{if(e.target===modal)close(false);});
    const toggle=(btn,target)=>btn.addEventListener('click',()=>{target.type=target.type==='password'?'text':'password';btn.textContent=target.type==='password'?'👁':'🙈';target.focus();});
    toggle(modal.querySelector('#pin-modal-toggle'),input); if(confirm) toggle(modal.querySelector('[data-confirm-toggle]'),confirm);
    const submit=async()=>{const value=input.value.trim();if(!/^\d{4,8}$/.test(value))return fail('PIN must contain 4–8 digits.');try{if(setup){if(value!==confirm.value.trim())return fail('PINs do not match.');await setPersonalPin(value);touchPinSession();armPinAutoLock();close(true,true);}else{if(!stored)return close(false);if(await hashPin(value)!==stored)return fail('Incorrect PIN. Please try again.');touchPinSession();armPinAutoLock();close(true,true);}}catch(e){fail(e.message||'PIN verification failed.');}};
    modal.querySelector('#pin-modal-submit').addEventListener('click',submit);input.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});confirm?.addEventListener('keydown',e=>{if(e.key==='Enter')submit();});setTimeout(()=>input.focus(),30);
  });
}
async function requirePin(action='continue'){
  if(!auth.currentUser||!currentCompanyId()) return true;
  const stored=storedPinHash();
  if(!stored){
    await pinModal(action,true);
    await offerBiometricSetup();
    return true;
  }
  // Critical stock actions deliberately ask for confirmation every time.
  // The 5-minute session still controls workspace auto-lock separately.
  // On a phone with fingerprint/face unlock already turned on for this
  // device, use that instead of asking the person to type their PIN; if it
  // fails or is cancelled, fall straight through to the normal PIN modal.
  if(isMobileDevice() && biometricReadyOnThisDevice() && await platformAuthAvailable()){
    try{ await verifyWithBiometric(); touchPinSession(); armPinAutoLock(); return true; }
    catch(e){ /* fingerprint failed/cancelled — ask for the PIN below */ }
  }
  await pinModal(action,false); return true;
}
async function renderPinSettings(){
  const current=storedPinHash();
  const next=window.prompt(current?'Enter a new 4–8 digit Inventro PIN.':'Create your 4–8 digit Inventro PIN.');
  if(next===null)return;
  const confirmPin=window.prompt('Confirm the PIN.');
  if(next!==confirmPin){showTemporaryMessage('PINs do not match.','error');return;}
  try{
    await setPersonalPin(next);
    showTemporaryMessage('PIN saved to your account. It now unlocks Inventro on any device you sign into.','success');
    await offerBiometricSetup();
  }catch(e){showTemporaryMessage(e.message,'error');}
}
async function renderBiometricSettings(){
  if(biometricReadyOnThisDevice()){
    if(window.confirm('Fingerprint unlock is ON for this device. Turn it off and use the PIN instead?')){
      localStorage.removeItem(biometricDeviceKey());
      localStorage.removeItem(biometricCredentialKey());
      showTemporaryMessage('Fingerprint unlock turned off for this device.','success');
    }
    return;
  }
  if(!(await platformAuthAvailable())){
    showTemporaryMessage('This device does not support fingerprint/face unlock.','error');
    return;
  }
  if(!storedPinHash()){
    showTemporaryMessage('Create your Inventro PIN first, then turn on fingerprint unlock.','error');
    return;
  }
  try{ await registerBiometricUnlock(); showTemporaryMessage('Fingerprint unlock turned on for this device.','success'); }
  catch(e){ showTemporaryMessage('Could not set up fingerprint unlock on this device.','error'); }
}
function showPinGate(){
  const has=!!storedPinHash();
  const canBiometric=has && isMobileDevice() && biometricReadyOnThisDevice();
  root.innerHTML=`<div class="screen pin-gate"><div class="pin-gate-card"><p class="brand">Inventro Security</p><div class="pin-icon-wrap">${canBiometric?'👆':'🔒'}</div><h1>${has?'Workspace locked':'Create your security PIN'}</h1><p class="subtitle">${has?(canBiometric?'Use your fingerprint to continue, or enter your PIN below.':'Enter your personal PIN to continue. The same PIN works on any device you sign into.'):'Choose your own 4–8 digit PIN. You will need it when the app opens and after 5 minutes of inactivity.'}</p>${canBiometric?'<button type="button" class="btn btn-primary" id="biometric-retry">👆 Use fingerprint</button><p class="pin-hint">Or enter your PIN instead:</p>':''}<div class="pin-form"><div class="field"><label for="inventro-pin">${has?'PIN':'New PIN'}</label><div class="pin-input-wrap"><input id="inventro-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Enter PIN"><button type="button" class="pin-toggle" data-target="inventro-pin" aria-label="Show PIN">👁</button></div></div>${has?'':'<div class="field"><label for="inventro-pin-confirm">Confirm PIN</label><div class="pin-input-wrap"><input id="inventro-pin-confirm" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Re-enter PIN"><button type="button" class="pin-toggle" data-target="inventro-pin-confirm" aria-label="Show PIN">👁</button></div></div>'}<button class="btn btn-primary" id="unlock-pin">${has?'Unlock Inventro':'Create PIN & Enter'}</button></div><p class="pin-hint">Your PIN is personal and now syncs to your account, not just this device.</p></div></div>`;
  const go=async()=>{const a=root.querySelector('#inventro-pin').value;if(!/^\d{4,8}$/.test(a)){showTemporaryMessage('PIN must contain 4 to 8 digits.','error');return;}try{if(has){if(await hashPin(a)!==storedPinHash())throw new Error('Incorrect Inventro PIN.');}else{const b=root.querySelector('#inventro-pin-confirm').value;if(a!==b)throw new Error('PINs do not match.');await setPersonalPin(a);}touchPinSession();armPinAutoLock();render();}catch(e){showTemporaryMessage(e.message,'error');}};
  root.querySelectorAll('.pin-toggle').forEach(btn=>btn.addEventListener('click',()=>{const input=root.querySelector('#'+btn.dataset.target);input.type=input.type==='password'?'text':'password';btn.textContent=input.type==='password'?'👁':'🙈';btn.setAttribute('aria-label',input.type==='password'?'Show PIN':'Hide PIN');input.focus();}));
  root.querySelector('#unlock-pin').addEventListener('click',go);root.querySelector('#inventro-pin').addEventListener('keydown',e=>{if(e.key==='Enter')go();});root.querySelector('#inventro-pin-confirm')?.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
  if(canBiometric){
    const tryBiometric=async()=>{try{await verifyWithBiometric();touchPinSession();armPinAutoLock();render();}catch(e){showTemporaryMessage('Fingerprint not recognized. Enter your PIN instead.','error');}};
    root.querySelector('#biometric-retry')?.addEventListener('click',tryBiometric);
    tryBiometric(); // auto-prompt immediately, like a phone lock screen
  }
}


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

async function listItems(includeArchived=false) {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  // Items are already kept live by startRealtimeSync(). listItems() is
  // called on almost every screen open (Stock, Dispatch, Receive, Requests,
  // Stats, History, Admin), so reusing the in-memory copy instead of a fresh
  // getDocs() here is the single biggest Firestore-read saving in the app.
  const useLiveCache = realtimeItemsReady && realtimeCompanyId === companyId;
  const rawItems = useLiveCache
    ? realtimeLatestItems.map(d => ({...d}))
    : (await getDocs(collection(db,'companies',companyId,'items'))).docs.map(d => ({id:d.id,...d.data()}));
  const items = rawItems.filter(item => includeArchived || item.archived !== true);

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
    name:cleanName,nameLower,unit,quantity,openingStock:quantity,lowStockAlert:low,
    imageUrl:imageUrl.url || '',imageSource:imageUrl.source || '',
    createdAt:serverTimestamp(),updatedAt:serverTimestamp(),
    updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase() || ''
  });
  await setDoc(doc(ref,'movements',`${Date.now()}-opening`),{
    type:'opening',quantity,unit,itemName:cleanName,note:'Opening stock',
    byUid:user.uid,byEmail:user.email?.toLowerCase() || '',byRole:membership?.role || '',
    openingStock:quantity,createdAt:serverTimestamp()
  });
}


async function updateInventoryItem(itemId,{name,unit,lowStockAlert,imageUrl,imageSource}){
  const companyId=currentCompanyId(); if(!companyId||membership?.role!=='admin') throw new Error('Only Admin can edit inventory definitions.');
  const cleanName=String(name||'').trim().replace(/\s+/g,' '), low=Number(lowStockAlert);
  if(cleanName.length<2)throw new Error('Enter a valid item name.'); if(!INVENTORY_UNITS.includes(unit))throw new Error('Choose a valid unit.'); if(!Number.isFinite(low)||low<0)throw new Error('Low stock alert must be 0 or more.');
  const ref=doc(db,'companies',companyId,'items',itemId); const snap=await getDoc(ref); if(!snap.exists())throw new Error('Item no longer exists.');
  const dup=await getDocs(collection(db,'companies',companyId,'items')); if(dup.docs.some(d=>d.id!==itemId && String(d.data()?.nameLower||d.data()?.name||'').toLowerCase()===cleanName.toLowerCase()))throw new Error('Another item already uses that name.');
  const payload={name:cleanName,nameLower:cleanName.toLowerCase(),unit,lowStockAlert:low,updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid,updatedByEmail:auth.currentUser.email?.toLowerCase()||''};
  if(typeof imageUrl==='string' && imageUrl.trim()) payload.imageUrl=imageUrl.trim();
  if(typeof imageSource==='string') payload.imageSource=imageSource;
  await updateDoc(ref,payload);
}

async function deleteInventoryItem(itemId){
  const companyId=currentCompanyId();
  const user=auth.currentUser;
  if(!companyId||!user||membership?.role!=='admin') throw new Error('Only Admin can delete inventory items.');
  const ref=doc(db,'companies',companyId,'items',itemId);
  const snap=await getDoc(ref);
  if(!snap.exists()) throw new Error('This inventory item no longer exists.');
  await updateDoc(ref,{
    archived:true,
    archivedAt:serverTimestamp(),
    archivedBy:user.uid,
    archivedByEmail:user.email?.toLowerCase()||'',
    updatedAt:serverTimestamp(),
    updatedBy:user.uid,
    updatedByEmail:user.email?.toLowerCase()||''
  });
}

async function changeStock(itemId, amount, type, note='', options={}) {
  await requirePin(type==='receive'?'receive stock':'dispatch stock');
  const companyId = currentCompanyId(), user = auth.currentUser;
  if (!companyId || !user) throw new Error('Your company session is not available.');
  // Re-check the authoritative employee role immediately before writing. This
  // prevents a stale client membership from being mistaken for permission.
  if (user.email) {
    const employeeSnap = await getDoc(doc(db,'companies',companyId,'employees',user.email.toLowerCase()));
    if (!employeeSnap.exists() || employeeSnap.data()?.status !== 'active') throw new Error('Your employee access is not active. Please ask the Admin to enable it.');
    const authoritativeRole = String(employeeSnap.data()?.role || '').toLowerCase();
    if (type === 'dispatch' && !['admin','inventory_manager'].includes(authoritativeRole)) throw new Error('Your current Firebase role is not allowed to dispatch stock.');
    if (type === 'receive' && !['admin','inventory_manager'].includes(authoritativeRole)) throw new Error('Your current Firebase role is not allowed to receive stock.');
  }
  if (type === 'dispatch' && !canDirectDispatch()) throw new Error('Only Admin and Inventory Manager can dispatch stock directly.');
  if (type === 'receive' && !canReceiveStock()) throw new Error('Only Admin and Inventory Manager can receive stock.');
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter a quantity greater than 0.');
  const ref = doc(db,'companies',companyId,'items',itemId);
  const movementRef = doc(collection(ref,'movements'));
  const fulfillOrder = type === 'receive' && options.fulfillOutstandingOrder === true;
  const cleanDepartment = String(options.department || '').trim();
  if (type === 'dispatch') {
    if (!cleanDepartment) throw new Error('Select the department receiving this stock.');
    const departments = await listDepartments();
    if (!departments.some(d => d.name === cleanDepartment)) throw new Error('Select a valid department.');
  }
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
    tx.set(movementRef,{type,quantity:n,unit:item.unit,itemName:item.name,department:cleanDepartment,note:note.trim(),byUid:user.uid,byEmail:user.email?.toLowerCase() || '',byRole:membership?.role || '',byName:user.displayName || '',createdAt:serverTimestamp(),
      ...(fulfillOrder && item.procurementStatus === 'ordered' ? {procurementEvent:'order_fulfilled',orderId:item.procurementOrderId||'',orderSentAt:item.procurementOrderSentAt||null} : {})
    });
    if (fulfillOrder && item.procurementStatus === 'ordered') {
      tx.set(doc(collection(ref,'movements')),{type:'order_fulfilled',quantity:n,unit:item.unit,itemName:item.name,note:`Supplier order fulfilled${item.procurementOrderId?` (${item.procurementOrderId})`:''}`,orderId:item.procurementOrderId||'',byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',byName:user.displayName || '',createdAt:serverTimestamp()});
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
function canCreateRequest() { return ['inventory_manager','transaction_manager'].includes(membership?.role) || isStockRequesterRole(membership?.role); }
function canManageRequests() { return membership?.role === 'inventory_manager'; }

async function listRequests() {
  const companyId = currentCompanyId();
  if (!companyId) return [];
  // Requests are already kept live by startRealtimeSync(); reuse that copy
  // instead of re-reading the whole collection every time this is called.
  const useLiveCache = realtimeRequestsReady && realtimeCompanyId === companyId;
  const raw = useLiveCache
    ? realtimeLatestRequests.map(d => ({...d}))
    : (await getDocs(collection(db,'companies',companyId,'requests'))).docs.map(d=>({id:d.id,...d.data()}));
  return raw.sort((a,b)=>{
    const at=a.createdAt?.toMillis?.()||0, bt=b.createdAt?.toMillis?.()||0; return bt-at;
  });
}

async function listRequestEvents() {
  const companyId=currentCompanyId();
  if(!companyId) return [];
  const requests=await listRequests();
  const events=[];
  for(const r of requests){
    // syncRequestEventListeners() already keeps a live per-request events
    // cache for every request this user is allowed to see; only fall back to
    // a one-off read for the rare request it hasn't subscribed to yet.
    const cached=realtimeRequestEventsCache.get(r.id);
    const evDocs=Array.isArray(cached) ? cached
      : (await getDocs(collection(db,'companies',companyId,'requests',r.id,'events'))).docs.map(d=>({id:d.id,requestId:r.id,...d.data()}));
    evDocs.forEach(d=>events.push(d));
    // Backward-compatible fallback for old requests that predate event logging.
    if(!evDocs.length){
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
  const requestData={itemId,itemName:item.name,quantity:n,unit:item.unit,note:note.trim(),status:'pending',requestedByName:user.displayName || '',notificationBatchId:requestRef.id,notificationBatchCreatedAt:Date.now(),department:cleanDepartment,requestedByUid:user.uid,requestedByEmail:user.email?.toLowerCase()||'',requestedByRole:membership?.role||'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()};
  await setDoc(requestRef,requestData);
  await setDoc(doc(collection(db,'companies',companyId,'requests',requestRef.id,'events')),{
    requestId:requestRef.id,eventType:'pending',itemId,itemName:item.name,quantity:n,unit:item.unit,department:cleanDepartment,
    requestedByUid:user.uid,requestedByEmail:user.email?.toLowerCase()||'',requestedByRole:membership?.role||'',requestedByName:user.displayName || '',
    actorUid:user.uid,actorName:user.displayName || '',actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',createdAt:serverTimestamp()
  });
}

async function cancelStockRequest(requestId){
  const companyId=currentCompanyId(), user=auth.currentUser;
  if(!companyId||!user) throw new Error('Your company session is not available.');
  if(!isStockRequesterRole(membership?.role)) throw new Error('Only the person who created the request can cancel it.');
  const requestRef=doc(db,'companies',companyId,'requests',requestId);
  await runTransaction(db, async(tx)=>{
    const snap=await tx.get(requestRef);
    if(!snap.exists()) throw new Error('That request no longer exists.');
    const r=snap.data();
    if(r.requestedByUid!==user.uid) throw new Error('You can cancel only your own request.');
    if(r.status!=='pending') throw new Error('Only pending requests can be cancelled. Approved, rejected, or fulfilled requests cannot be cancelled.');
    tx.update(requestRef,{status:'cancelled',updatedAt:serverTimestamp(),cancelledAt:serverTimestamp(),cancelledByUid:user.uid,cancelledByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(collection(requestRef,'events')),{requestId,eventType:'cancelled',batchId:r.notificationBatchId||requestId,notificationBatchId:r.notificationBatchId||requestId,batchCreatedAt:r.notificationBatchCreatedAt||Date.now(),itemId:r.itemId,itemName:r.itemName,quantity:Number(r.quantity||0),unit:r.unit||'',department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',actorName:user.displayName || '',createdAt:serverTimestamp()});
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
    title = 'Request dispatched';
    message = `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} has been dispatched.`;
  } else if (status === 'stock_unavailable') {
    title = 'Not enough stock';
    message = extraMessage || `Your request for ${requestData.itemName} — ${requestData.quantity} ${requestData.unit} cannot be approved right now because there is not enough stock. The request remains pending.`;
  }
  await setDoc(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')), {
    recipientUid: requestData.requestedByUid,
    requestId,
    batchId: requestData.notificationBatchId || requestId, notificationBatchId: requestData.notificationBatchId || requestId, batchCreatedAt: requestData.notificationBatchCreatedAt || Date.now(),
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
        tx.set(eventRef,{requestId,eventType:'stock_unavailable',batchId:requestData.notificationBatchId || requestId, notificationBatchId:requestData.notificationBatchId || requestId, batchCreatedAt:requestData.notificationBatchCreatedAt || Date.now(),notificationBatchId:requestData.notificationBatchId || requestId,itemId:requestData.itemId,itemName:requestData.itemName,quantity:requested,unit:requestData.unit||item.unit||'',availableQuantity:current,department:requestData.department||'',requestedByUid:requestData.requestedByUid||'',requestedByEmail:requestData.requestedByEmail||'',requestedByRole:requestData.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',actorName:user.displayName || '',createdAt:serverTimestamp()});
        if(requestData.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')),{recipientUid:requestData.requestedByUid,requestId,batchId:requestData.notificationBatchId || requestId, notificationBatchId:requestData.notificationBatchId || requestId, batchCreatedAt:requestData.notificationBatchCreatedAt || Date.now(),type:'request_status',status:'stock_unavailable',title:'Not enough stock',message:`Your request for ${requestData.itemName} — ${requested} ${requestData.unit || item.unit || ''} cannot be approved right now. Available stock: ${current} ${item.unit || requestData.unit || ''}. The request remains pending.`,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
        return {approved:false, requestData, available:current, unit:item.unit || requestData.unit || ''};
      }
    }

    tx.update(requestRef,{status,updatedAt:serverTimestamp(),reviewedByUid:user.uid,reviewedByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(collection(requestRef,'events')),{requestId,eventType:status,batchId:requestData.notificationBatchId || requestId, notificationBatchId:requestData.notificationBatchId || requestId, batchCreatedAt:requestData.notificationBatchCreatedAt || Date.now(),notificationBatchId:requestData.notificationBatchId || requestId,itemId:requestData.itemId,itemName:requestData.itemName,quantity:Number(requestData.quantity||0),unit:requestData.unit||'',department:requestData.department||'',requestedByUid:requestData.requestedByUid||'',requestedByEmail:requestData.requestedByEmail||'',requestedByRole:requestData.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',actorName:user.displayName || '',createdAt:serverTimestamp()});
    if(requestData.requestedByUid) {
      const title = status === 'approved' ? 'Request approved' : 'Request rejected';
      const message = status === 'approved'
        ? `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} has been approved.`
        : `${requestData.itemName} — ${requestData.quantity} ${requestData.unit} for ${requestData.department || 'the selected department'} was rejected.`;
      tx.set(doc(collection(db,'companies',companyId,'userNotifications',requestData.requestedByUid,'notifications')),{recipientUid:requestData.requestedByUid,requestId,batchId:requestData.notificationBatchId || requestId, notificationBatchId:requestData.notificationBatchId || requestId, batchCreatedAt:requestData.notificationBatchCreatedAt || Date.now(),type:'request_status',status,title,message,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
    }
    return {approved:status==='approved', requestData, available:null, unit:requestData.unit||''};
  });

  if(status==='approved' && !result.approved) {
    throw new Error(`Not enough ${result.requestData.itemName} in stock. Requested: ${result.requestData.quantity} ${result.requestData.unit || result.unit}. Available: ${result.available} ${result.unit}. The request remains pending.`);
  }
}

async function fulfillRequest(requestId) {
  await requirePin('dispatch a requested item');
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
      if(req.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',req.requestedByUid,'notifications')),{recipientUid:req.requestedByUid,requestId,batchId:req.notificationBatchId || requestId, notificationBatchId:req.notificationBatchId || requestId, batchCreatedAt:req.notificationBatchCreatedAt || Date.now(),notificationBatchId:req.notificationBatchId || requestId,type:'request_status',status:'stock_unavailable',title:'Not enough stock',message:`Your approved request for ${req.itemName} — ${n} ${req.unit || item.unit || ''} cannot be dispatched yet because only ${current} ${item.unit || req.unit || ''} is currently available. Please wait for stock to arrive.`,read:false,clientCreatedAt:Date.now(),createdAt:serverTimestamp()});
      tx.set(doc(collection(requestRef,'events')),{requestId,eventType:'stock_unavailable',batchId:req.notificationBatchId || requestId, notificationBatchId:req.notificationBatchId || requestId, batchCreatedAt:req.notificationBatchCreatedAt || Date.now(),itemId:req.itemId,itemName:req.itemName,quantity:n,unit:item.unit||req.unit||'',availableQuantity:current,department:req.department||'',requestedByUid:req.requestedByUid||'',requestedByEmail:req.requestedByEmail||'',requestedByRole:req.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',actorName:user.displayName || '',createdAt:serverTimestamp()});
      return {fulfilled:false,itemName:req.itemName,requested:n,available:current,unit:item.unit||req.unit||''};
    }
    tx.update(itemRef,{quantity:current-n,updatedAt:serverTimestamp(),updatedBy:user.uid,updatedByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(itemRef,'movements',movementId),{type:'dispatch',quantity:n,unit:item.unit,itemName:item.name,department:req.department||'',note:`Request dispatched${req.note?': '+req.note:''}`,requestId,requestedByEmail:req.requestedByEmail||'',requestedByUid:req.requestedByUid||'',requestedByRole:req.requestedByRole||'',requestedByName:req.requestedByName||'',byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',byName:user.displayName || '',createdAt:serverTimestamp()});
    tx.update(requestRef,{status:'fulfilled',updatedAt:serverTimestamp(),fulfilledAt:serverTimestamp(),fulfilledByUid:user.uid,fulfilledByEmail:user.email?.toLowerCase()||''});
    tx.set(doc(collection(requestRef,'events')),{requestId,eventType:'fulfilled',batchId:req.notificationBatchId || requestId, notificationBatchId:req.notificationBatchId || requestId, batchCreatedAt:req.notificationBatchCreatedAt || Date.now(),itemId:req.itemId,itemName:req.itemName,quantity:n,unit:item.unit,department:req.department||'',requestedByUid:req.requestedByUid||'',requestedByEmail:req.requestedByEmail||'',requestedByRole:req.requestedByRole||'',actorUid:user.uid,actorEmail:user.email?.toLowerCase()||'',actorRole:membership?.role||'',actorName:user.displayName || '',createdAt:serverTimestamp()});
    if (req.requestedByUid) tx.set(doc(collection(db,'companies',companyId,'userNotifications',req.requestedByUid,'notifications')), { recipientUid:req.requestedByUid, requestId, batchId:req.notificationBatchId || requestId, notificationBatchId:req.notificationBatchId || requestId, batchCreatedAt:req.notificationBatchCreatedAt || Date.now(), type:'request_status', status:'fulfilled', title:'Request dispatched', message:`${req.itemName} — ${n} ${item.unit} for ${req.department || 'the selected department'} has been dispatched.`, read:false, clientCreatedAt:Date.now(), createdAt:serverTimestamp() });
    return {fulfilled:true};
  });
  if(!result.fulfilled) throw new Error(`Not enough ${result.itemName} in stock to dispatch this approved request. Requested: ${result.requested} ${result.unit}. Available: ${result.available} ${result.unit}. The request remains approved and has not been dispatched.`);
}

async function listHistory() {
  const items=await listItems(true);
  const employees=await listEmployees();
  const roleByEmail=new Map(employees.map(e=>[(e.email||'').toLowerCase(),e.role]));
  const rows=[];
  for(const item of items){
    let movementDocs = realtimeMovementCache.get(item.id);
    // The live listener intentionally contains only the last 7 days. An empty
    // cache is valid when this item has had no movement in that window, so do
    // not fall back to the entire ledger just because the array is empty.
    if(!realtimeMovementCache.has(item.id)){
      // Never fall back to the complete ledger for normal/current-page history.
      // Older history is loaded explicitly by getMovementRowsForDay(day).
      const movementRef=query(
        collection(db,'companies',currentCompanyId(),'items',item.id,'movements'),
        where('createdAt','>=',movementLiveStartDate())
      );
      const snap=await getDocs(movementRef);
      movementDocs=snap.docs.map(d=>({id:d.id,...d.data()}));
      realtimeMovementCache.set(item.id, movementDocs.map(data=>({
        ...data,
        itemId:item.id,
        itemName:data.itemName || item.name || '',
        unit:data.unit || item.unit || '',
        actorRole:data.byRole || data.actorRole || realtimeEmployeeRoleMap.get(String(data.byEmail||'').toLowerCase()) || '', actorName:data.byName || data.actorName || employeeDirectory.get(String(data.byEmail||'').toLowerCase())?.name || ''
      })));
    }
    movementDocs.forEach(data=>{
      rows.push({id:data.id,itemName:item.name,itemId:item.id,...data,
        actorRole:data.byRole || roleByEmail.get((data.byEmail||'').toLowerCase()) || ''});
    });
  }
  return rows.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
}

function canEditMovementRow(row){
  const role=membership?.role;
  if(!role || role==='admin' || !isEditableTransactionRole(role)) return false;
  const actorRole=String(row.actorRole||row.byRole||'');
  if (isStockRequesterRole(role)) return isStockRequesterRole(actorRole) && ((row.byUid===auth.currentUser?.uid) || !row.byUid || actorRole==='');
  return actorRole===role || (!actorRole && row.byUid===auth.currentUser?.uid);
}

async function listMovementRevisions(itemId,movementId){
  const companyId=currentCompanyId();
  if(!companyId) return [];
  const snap=await getDocs(collection(db,'companies',companyId,'items',itemId,'movements',movementId,'revisions'));
  return snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.changedAt?.toMillis?.()||0)-(a.changedAt?.toMillis?.()||0));
}

async function recalculateItemFromMovements(tx,itemRef,movementDocs){
  let quantity=0;
  for(const d of movementDocs){
    const m=d.data();
    if(m.deleted===true || m.active===false) continue;
    const n=Number(m.quantity||0);
    if(!Number.isFinite(n) || n<0) continue;
    if(m.type==='opening'||m.type==='receive') quantity+=n;
    else if(m.type==='dispatch') quantity-=n;
  }
  if(quantity<0) throw new Error('This correction would make stock negative. Check the movement quantity/type.');
  tx.update(itemRef,{quantity,updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid,updatedByEmail:auth.currentUser.email?.toLowerCase()||''});
  return quantity;
}

function movementRevisionRef(itemId,movementId){
  return doc(collection(db,'companies',currentCompanyId(),'items',itemId,'movements',movementId,'revisions'));
}

async function editMovement(itemId,movementId,changes){
  await requirePin('edit transaction');
  if(!isEditableTransactionRole(membership?.role) || membership?.role==='admin') throw new Error('History editing is available only to the account that owns the transaction.');
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
    if(movement.deleted===true) throw new Error('This transaction is already deleted.');
    const actorRole=String(movement.byRole || '');
    if(isStockRequesterRole(membership.role)) {
      if(!isStockRequesterRole(actorRole) || (movement.byUid && movement.byUid!==auth.currentUser?.uid)) throw new Error('You can edit only your own Stock Requisitioner transactions.');
    } else if(actorRole && actorRole!==membership.role) throw new Error('You can edit only transactions belonging to your own role.');
    else if(!actorRole && movement.byUid!==auth.currentUser?.uid) throw new Error('This older transaction has no role record, so only its original creator can edit it.');
    const type=String(changes.type||movement.type).trim().toLowerCase();
    const quantity=Number(changes.quantity);
    if(!['opening','receive','dispatch'].includes(type)) throw new Error('Invalid movement type.');
    if(!Number.isFinite(quantity)||quantity<0) throw new Error('Quantity must be 0 or more.');
    const revision=movementRevisionRef(itemId,movementId);
    tx.set(revision,{
      action:'edit', version:Number(movement.editCount||0)+1,
      previousType:movement.type||'', previousQuantity:Number(movement.quantity||0), previousUnit:movement.unit||'', previousNote:movement.note||'',
      previousDepartment:movement.department||'', previousByUid:movement.byUid||'', previousByEmail:movement.byEmail||'', previousByRole:movement.byRole||'', previousCreatedAt:movement.createdAt||null,
      currentType:type, currentQuantity:quantity, currentUnit:movement.unit||'', currentNote:String(changes.note||'').trim(), currentDepartment:movement.department||'',
      changedByUid:auth.currentUser.uid, changedByEmail:auth.currentUser.email?.toLowerCase()||'', changedByRole:membership.role, changedAt:serverTimestamp()
    });
    tx.update(movementRef,{type,quantity,note:String(changes.note||'').trim(),editedAt:serverTimestamp(),editedByUid:auth.currentUser.uid,editedByEmail:auth.currentUser.email?.toLowerCase()||'',byRole:actorRole||membership.role,editCount:Number(movement.editCount||0)+1,deleted:false,active:true});
    const docs=movementSnaps.map(d=>d.id===movementId?{id:d.id,data:()=>({...movement,type,quantity,deleted:false,active:true})}:{id:d.id,data:()=>d.data()});
    await recalculateItemFromMovements(tx,itemRef,docs);
  });
}

async function deleteMovement(itemId,movementId){
  await requirePin('delete transaction');
  if(!isEditableTransactionRole(membership?.role) || membership?.role==='admin') throw new Error('Only the account that owns the transaction can delete it.');
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
    if(movement.deleted===true) throw new Error('This transaction is already deleted.');
    const actorRole=String(movement.byRole||'');
    if(isStockRequesterRole(membership.role)) {
      if(!isStockRequesterRole(actorRole) || (movement.byUid && movement.byUid!==auth.currentUser?.uid)) throw new Error('You can delete only your own Stock Requisitioner transactions.');
    } else if(actorRole && actorRole!==membership.role) throw new Error('You can delete only transactions belonging to your own role.');
    else if(!actorRole && movement.byUid!==auth.currentUser?.uid) throw new Error('This older transaction has no role record, so only its original creator can delete it.');
    const revision=movementRevisionRef(itemId,movementId);
    tx.set(revision,{
      action:'delete', version:Number(movement.editCount||0)+1,
      previousType:movement.type||'', previousQuantity:Number(movement.quantity||0), previousUnit:movement.unit||'', previousNote:movement.note||'',
      previousDepartment:movement.department||'', previousByUid:movement.byUid||'', previousByEmail:movement.byEmail||'', previousByRole:movement.byRole||'', previousCreatedAt:movement.createdAt||null,
      currentType:movement.type||'', currentQuantity:Number(movement.quantity||0), currentUnit:movement.unit||'', currentNote:movement.note||'', currentDepartment:movement.department||'', currentDeleted:true,
      changedByUid:auth.currentUser.uid, changedByEmail:auth.currentUser.email?.toLowerCase()||'', changedByRole:membership.role, changedAt:serverTimestamp()
    });
    tx.update(movementRef,{deleted:true,active:false,deletedAt:serverTimestamp(),deletedByUid:auth.currentUser.uid,deletedByEmail:auth.currentUser.email?.toLowerCase()||'',deletedByRole:membership.role,editCount:Number(movement.editCount||0)+1});
    const remaining=movementSnaps.map(d=>({id:d.id,data:()=>d.id===movementId?{...d.data(),deleted:true,active:false}:d.data()}));
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

async function rotateCompanyCode() {
  const companyId = currentCompanyId();
  const user = auth.currentUser;
  if (!companyId || !user || membership?.role !== 'admin') throw new Error('Only the company Admin can change the company code.');
  const companyRef = doc(db, 'companies', companyId);
  const companySnap = await getDoc(companyRef);
  if (!companySnap.exists()) throw new Error('Company was not found.');
  const company = companySnap.data();
  if (company.ownerUid !== user.uid) throw new Error('Only the original company owner can change the company code.');

  let newCode = '';
  for (let i = 0; i < 12; i++) {
    const candidate = randomSixDigitCode();
    const snap = await getDoc(doc(db, 'codes', candidate));
    if (!snap.exists()) { newCode = candidate; break; }
  }
  if (!newCode) throw new Error('Could not generate a new unique company code. Please try again.');

  const employeesSnap = await getDocs(collection(db, 'companies', companyId, 'employees'));
  const batch = writeBatch(db);
  if (company.code) batch.delete(doc(db, 'codes', company.code));
  batch.set(doc(db, 'codes', newCode), { companyId, reservedBy: user.uid });
  batch.update(companyRef, {
    code: newCode,
    companyCodeVersion: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    companyCodeChangedAt: serverTimestamp(),
    companyCodeChangedBy: user.uid
  });
  // Force every employee to re-enter the fresh code after they are signed out.
  // The employee self-update rule permits invited -> active on successful code verification.
  employeesSnap.docs.forEach(emp => {
    const data = emp.data();
    if (data.role !== 'admin' && data.status === 'active') {
      batch.update(emp.ref, { status: 'invited' });
    }
  });
  await batch.commit();
  return newCode;
}

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
  if (isStockRequesterRole(role)) return 'Stock Requisitioner';
  return ({
    inventory_manager: 'Inventory Manager',
    transaction_manager: 'Transaction Manager',
    admin: 'Admin'
  })[role] || role;
}

function shortPersonId(email, role='') {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) return '—';
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = ''; let n = hash >>> 0;
  for (let i = 0; i < 4; i++) { code += alphabet[n % alphabet.length]; n = Math.floor(n / alphabet.length); }
  const prefix = ({inventory_manager:'IM', transaction_manager:'TM', stock_requester:'SR', chef:'SR', request:'SR', admin:'AD'})[String(role||'').toLowerCase()] || 'ID';
  return `${prefix}-${code}`;
}

function shortDisplayName(email, explicitName='') {
  const supplied = String(explicitName || '').trim();
  const cached = employeeDirectory.get(String(email || '').trim().toLowerCase())?.name || '';
  const name = supplied || cached;
  if (name) return name.split(/\s+/)[0].replace(/[^\p{L}\p{N}'-]/gu,'');
  const local = String(email || '').split('@')[0].replace(/[._-]+/g,' ').trim();
  const first = local.split(/\s+/)[0] || 'User';
  return first.length > 18 ? first.slice(0,18) : first;
}

function personRef(email, role='', explicitName='') {
  // Privacy-friendly, easy-to-read identifier: role prefix + the email local-part.
  // Example: ferdousirahman1979@gmail.com → IM-ferdousirahman1979
  // The full email is never rendered by this helper.
  const cleanEmail = String(email || '').trim().toLowerCase();
  const localPart = (cleanEmail.includes('@') ? cleanEmail.split('@')[0] : cleanEmail)
    .replace(/[^a-z0-9._-]/gi, '') || 'user';
  const prefix = ({inventory_manager:'IM', transaction_manager:'TM', stock_requester:'SR', chef:'SR', request:'SR', admin:'AD'})[String(role||'').toLowerCase()] || 'ID';
  return `${prefix}-${localPart}`;
}

function transactionOriginLabel(row){
  return row?.requestId ? 'REQUESTED TRANSACTION' : 'SELF TRANSACTION';
}

function transactionOriginShort(row){
  return row?.requestId ? 'REQUESTED' : 'SELF';
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
  if (action === 'tm-live-report') {
    if (membership?.role !== 'transaction_manager') return showTemporaryMessage('Only the Transaction Manager can open the live daily report.','error');
    historyOpenLiveRequested = true;
    navigate('history');
    return;
  }
  showTemporaryMessage(`${card.querySelector('strong')?.textContent || 'This section'} is coming next.`);
});

function renderWelcome({ onCreate, onJoin }) {
  root.innerHTML = `
    <div class="landing-page">
      <div class="landing-orb landing-orb-one"></div>
      <div class="landing-orb landing-orb-two"></div>
      <section class="landing-shell">
        <div class="landing-brand-row">
          <div class="inventro-mark" aria-hidden="true">
            <span></span><span></span><span></span>
          </div>
          <div>
            <div class="landing-brand-name">Inventro</div>
            <div class="landing-brand-caption">Kitchen inventory, simplified.</div>
          </div>
          <div class="landing-status"><span></span> Secure workspace</div>
        </div>

        <div class="landing-hero">
          <div class="landing-copy">
            <div class="landing-kicker"><span>✦</span> Smart stock management</div>
            <h1>Everything your kitchen needs, <em>in one place.</em></h1>
            <p>Track stock, receive supplies, dispatch ingredients, manage requests and keep your team in sync — without the paperwork.</p>
            <div class="landing-actions">
              <button class="landing-action landing-action-primary" id="create-btn">
                <span class="landing-action-icon">＋</span>
                <span><strong>Create a company</strong><small>Start your inventory workspace</small></span>
                <b>→</b>
              </button>
              <button class="landing-action landing-action-secondary" id="join-btn">
                <span class="landing-action-icon">↗</span>
                <span><strong>Join a company</strong><small>Use the code from your admin</small></span>
                <b>→</b>
              </button>
            </div>
            <div class="landing-trust">
              <span>✓ Google sign-in</span><span>✓ Live stock sync</span><span>✓ Role-based access</span>
            </div>
          </div>

          <div class="landing-preview" aria-hidden="true">
            <div class="preview-window">
              <div class="preview-top"><span class="preview-dot"></span><span class="preview-dot"></span><span class="preview-dot"></span><span class="preview-title">Inventory overview</span><span class="preview-menu">•••</span></div>
              <div class="preview-welcome">
                <div><small>Today’s kitchen stock</small><strong>Everything under control.</strong></div>
                <span class="preview-live">● LIVE</span>
              </div>
              <div class="preview-stats">
                <div><small>Total items</small><strong>128</strong><span>Across your kitchen</span></div>
                <div><small>Low stock</small><strong class="preview-red">07</strong><span>Needs attention</span></div>
              </div>
              <div class="preview-list">
                <div><span class="preview-icon rice">◉</span><span><strong>Basmati Rice</strong><small>42 kg available</small></span><i class="preview-pill good">Healthy</i></div>
                <div><span class="preview-icon oil">◒</span><span><strong>Cooking Oil</strong><small>18 L available</small></span><i class="preview-pill warn">Low</i></div>
                <div><span class="preview-icon veg">◆</span><span><strong>Fresh Vegetables</strong><small>Daily receiving</small></span><i class="preview-pill good">Healthy</i></div>
              </div>
              <div class="preview-chart"><span style="height:34%"></span><span style="height:52%"></span><span style="height:43%"></span><span style="height:70%"></span><span style="height:58%"></span><span style="height:84%"></span><span style="height:64%"></span></div>
            </div>
            <div class="preview-float preview-float-one"><span>✓</span><div><strong>Stock synced</strong><small>Just now</small></div></div>
            <div class="preview-float preview-float-two"><span>↗</span><div><strong>5 requests</strong><small>Today</small></div></div>
          </div>
        </div>

        <div class="landing-features">
          <div><span>📦</span><strong>One inventory</strong><small>Receive, dispatch & track stock</small></div>
          <div><span>👥</span><strong>Built for teams</strong><small>Admin & role-based workflows</small></div>
          <div><span>📊</span><strong>Clear insights</strong><small>History, requests & statistics</small></div>
        </div>
        <p class="landing-footer">Designed for busy kitchens · Simple enough for everyone</p>
      </section>
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
const MOVEMENT_LIVE_DAYS = 7;
let realtimeMovementUnsubs = new Map();
let realtimeMovementCache = new Map();
let fullMovementCache = new Map();
let fullMovementCacheCompanyId = null;
let realtimeRequestEventUnsubs = new Map();
let realtimeRequestEventsCache = new Map();
let realtimeRefreshTimer = null;
let realtimeCompanyId = null;
let realtimeStarted = false;
let realtimeEmployeeRoleMap = new Map();
let realtimeLatestItems = [];
let realtimeLatestEmployees = [];
let realtimeLatestRequests = [];
// These flip true only once each collection's FIRST live snapshot has
// actually arrived, so list*() below never serves an empty/stale cache
// during the brief window after startRealtimeSync() is called but before
// Firestore has delivered anything yet.
let realtimeItemsReady = false;
let realtimeEmployeesReady = false;
let realtimeRequestsReady = false;
let historyOpenLiveRequested = false;

function stopRealtimeSync() {
  realtimeUnsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeUnsubscribers = [];
  realtimeMovementUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeMovementUnsubs.clear();
  realtimeMovementCache.clear();
  fullMovementCache.clear();
  fullMovementCacheCompanyId = null;
  realtimeRequestEventUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
  realtimeRequestEventUnsubs.clear();
  realtimeRequestEventsCache.clear();
  if (realtimeRefreshTimer) { clearTimeout(realtimeRefreshTimer); realtimeRefreshTimer = null; }
  realtimeCompanyId = null;
  realtimeStarted = false;
  realtimeEmployeeRoleMap.clear();
  realtimeLatestItems = [];
  realtimeLatestEmployees = [];
  realtimeLatestRequests = [];
  realtimeItemsReady = false;
  realtimeEmployeesReady = false;
  realtimeRequestsReady = false;
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

function movementLiveStartDate(){
  const d=new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate()-(MOVEMENT_LIVE_DAYS-1));
  return d;
}

function syncMovementListeners(companyId, itemDocs) {
  const ids = new Set(itemDocs.map(d => d.id));
  for (const [itemId, unsub] of realtimeMovementUnsubs) {
    if (!ids.has(itemId)) { try { unsub(); } catch (_) {} realtimeMovementUnsubs.delete(itemId); }
  }
  for (const item of itemDocs) {
    if (realtimeMovementUnsubs.has(item.id)) continue;
    const movementRef = query(
      collection(db,'companies',companyId,'items',item.id,'movements'),
      where('createdAt','>=',movementLiveStartDate())
    );
    const unsub = onSnapshot(movementRef, snap => {
      const itemData = realtimeLatestItems.find(x => x.id === item.id) || {};
      realtimeMovementCache.set(item.id, snap.docs.map(d => {
        const data = d.data() || {};
        const byEmail = String(data.byEmail || '').toLowerCase();
        return {
          id:d.id, ...data, itemId:item.id,
          itemName:data.itemName || itemData.name || '',
          unit:data.unit || itemData.unit || '',
          actorRole:data.byRole || data.actorRole || realtimeEmployeeRoleMap.get(byEmail) || '', actorName:data.byName || data.actorName || employeeDirectory.get(byEmail)?.name || ''
        };
      }));
      scheduleRealtimeRefresh('movements');
    }, err => console.warn('Movement realtime listener:', err));
    realtimeMovementUnsubs.set(item.id, unsub);
  }
}

async function loadFullMovementHistory(){
  const companyId=currentCompanyId();
  if(!companyId) return new Map();
  if(fullMovementCacheCompanyId===companyId && fullMovementCache.size) return fullMovementCache;
  fullMovementCache.clear();
  fullMovementCacheCompanyId=companyId;
  const items=await listItems(true);
  await Promise.all(items.map(async item=>{
    const snap=await getDocs(collection(db,'companies',companyId,'items',item.id,'movements'));
    const rows=snap.docs.map(d=>{
      const data=d.data()||{};
      const byEmail=String(data.byEmail||'').toLowerCase();
      return {
        id:d.id,...data,itemId:item.id,
        itemName:data.itemName||item.name||'',
        unit:data.unit||item.unit||'',
        actorRole:data.byRole||data.actorRole||realtimeEmployeeRoleMap.get(byEmail)||'',
        actorName:data.byName||data.actorName||employeeDirectory.get(byEmail)?.name||''
      };
    });
    fullMovementCache.set(item.id,rows);
  }));
  return fullMovementCache;
}

function movementRowsFromCache(){
  const rows=[];
  realtimeMovementCache.forEach((movementRows,itemId)=>{
    (movementRows||[]).forEach(r=>rows.push({itemId,...r}));
  });
  return rows;
}

async function getMovementRowsForDay(day){
  const today=localDateKey();
  if(day===today) return movementRowsFromCache();
  const targetStart=new Date(`${day}T00:00:00`).getTime();
  const liveStart=movementLiveStartDate().getTime();
  if(targetStart>=liveStart) return movementRowsFromCache();
  const full=await loadFullMovementHistory();
  const rows=[];
  full.forEach((movementRows,itemId)=>(movementRows||[]).forEach(r=>rows.push({itemId,...r})));
  return rows;
}

function syncRequestEventListeners(companyId, requestDocs) {
  const ids = new Set(requestDocs.map(d => d.id));
  for (const [requestId, unsub] of realtimeRequestEventUnsubs) {
    if (!ids.has(requestId)) { try { unsub(); } catch (_) {} realtimeRequestEventUnsubs.delete(requestId); realtimeRequestEventsCache.delete(requestId); }
  }
  for (const request of requestDocs) {
    // Firestore rules do not permit a Chef/Request user to listen to another
    // person's request events, so only subscribe to that user's own requests.
    if (!['admin','inventory_manager'].includes(membership?.role) && request.data()?.requestedByUid !== auth.currentUser?.uid) continue;
    if (realtimeRequestEventUnsubs.has(request.id)) continue;
    const eventRef = collection(db,'companies',companyId,'requests',request.id,'events');
    const unsub = onSnapshot(eventRef, snap => {
      // Cache these instead of throwing them away, so listRequestEvents()
      // doesn't have to re-read every request's events on every open.
      realtimeRequestEventsCache.set(request.id, snap.docs.map(d => ({id:d.id, requestId:request.id, ...d.data()})));
      scheduleRealtimeRefresh('request-events');
    }, err => console.warn('Request event realtime listener:', err));
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

  add(doc(db,'companies',companyId), async (snap, wasFirst) => {
    if (!snap.exists()) return;
    const data = snap.data() || {};
    const version = String(data.companyCodeVersion || 'legacy');
    const key = `inventroCompanyCodeVersion:${companyId}`;
    const previous = localStorage.getItem(key);
    if (!previous) localStorage.setItem(key, version);
    else if (!wasFirst && previous !== version) {
      localStorage.setItem(key, version);
      clearEmployeeCodeVerification();
      showTemporaryMessage('The company code was changed. Please sign in again with the new company code.', 'info');
      await signOut();
      return;
    }
    if (!wasFirst) scheduleRealtimeRefresh('company');
  }, 'Company');

  add(collection(db,'companies',companyId,'employees'), (snap, wasFirst) => {
    // Full employee docs, kept live so listEmployees() can reuse this instead
    // of re-reading the whole collection on every Admin/Requests/History open.
    realtimeLatestEmployees = snap.docs.map(d => ({id:d.id,...d.data()}));
    realtimeEmployeesReady = true;
    // Keep a live email -> role map so movement listeners can correctly identify
    // Inventory Manager transactions even when older movement documents only have byEmail.
    realtimeEmployeeRoleMap = new Map(snap.docs.map(d => { const x=d.data()||{}; const email=(x.email||d.id||'').toLowerCase(); if (email) employeeDirectory.set(email,{name:String(x.displayName||x.name||'').trim(),role:x.role||''}); return [email, x.role||'']; }));
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
    // Re-subscribe/re-read movement collections after the employee role map is refreshed.
    // This repairs legacy movement rows that identify the actor by email only.
    const currentItemDocs = realtimeLatestItems.map(x => ({id:x.id}));
    if (currentItemDocs.length) {
      realtimeMovementUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
      realtimeMovementUnsubs.clear();
      syncMovementListeners(companyId, currentItemDocs);
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
    // Keep the latest item snapshot globally. Movement listeners need this
    // snapshot to enrich movement rows and must never depend on a local
    // home-page variable.
    realtimeLatestItems = docs;
    realtimeItemsReady = true;
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
    realtimeLatestRequests = docs;
    realtimeRequestsReady = true;
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
  if (badge) badge.classList.remove('request-badge-green','request-badge-red','request-badge-yellow');

  const now = Date.now();
  const windowMs = 5 * 60 * 1000;

  // Every request is its own notification batch.  A batch is identified by
  // requestId (with notificationBatchId/batchId as fallbacks for old records).
  // We NEVER combine different requests when deciding the Home-card colour.
  const statusNotifications = notifications
    .filter(n => ['approved','rejected'].includes(String(n.status || '').toLowerCase()))
    .map(n => {
      const requestId = String(n.requestId || n.notificationBatchId || n.batchId || n.id);
      const batchId = String(n.notificationBatchId || n.batchId || n.requestId || n.id);
      const t = Number(n.clientCreatedAt || n.createdAt?.toMillis?.() || 0);
      return { ...n, _time:t, _requestId:requestId, _batchId:batchId, _status:String(n.status || '').toLowerCase() };
    })
    .filter(n => n._time > 0 && (now - n._time) >= 0 && (now - n._time) < windowMs)
    .sort((a,b) => b._time - a._time);

  if (!statusNotifications.length) {
    if (badge) { badge.hidden = true; badge.textContent = '0'; }
    return;
  }

  // Build independent request batches. If a request somehow has multiple
  // decision records, its own batch can be mixed. A different request can
  // NEVER make this batch mixed.
  const batches = new Map();
  for (const n of statusNotifications) {
    if (!batches.has(n._requestId)) batches.set(n._requestId, []);
    batches.get(n._requestId).push(n);
  }

  const batchList = [...batches.entries()].map(([requestId, events]) => {
    events.sort((a,b) => b._time - a._time);
    const latest = events[0];
    const statuses = new Set(events.map(e => e._status));
    return {
      requestId,
      events,
      latest,
      mixed: statuses.has('approved') && statuses.has('rejected'),
      latestTime: latest._time
    };
  }).sort((a,b) => b.latestTime - a.latestTime);

  // ONLY the newest request batch controls the Home-card light.
  // Example: #1 rejected (red), then #2 approved (green) => GREEN.
  const newestBatch = batchList[0];
  const latestStatus = newestBatch.latest._status;
  const approved = latestStatus === 'approved';
  const rejected = latestStatus === 'rejected';
  const mixed = newestBatch.mixed;

  if (mixed) card.classList.add('home-request-mixed');
  else if (approved) card.classList.add('home-request-approved');
  else if (rejected) card.classList.add('home-request-rejected');

  if (badge) {
    // Badge represents the newest request batch, not older requests.
    badge.textContent = '1';
    badge.hidden = false;
    badge.classList.toggle('request-badge-green', approved && !mixed);
    badge.classList.toggle('request-badge-red', rejected && !mixed);
    badge.classList.toggle('request-badge-yellow', mixed);
  }

  // The five-minute timer belongs to this newest request batch only.
  const remaining = Math.max(1000, windowMs - (now - newestBatch.latestTime));
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
    else if (['stock_requester','chef','request','transaction_manager'].includes(membership?.role)) updateHomeRequestNotificationAlert(latestNotifications);
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
  if (['stock_requester','chef','request','transaction_manager'].includes(membership?.role) && auth.currentUser?.uid) {
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


function getRealtimeMovementRows() {
  const rows = [];
  realtimeMovementCache.forEach((movementRows, itemId) => {
    (movementRows || []).forEach(r => rows.push({itemId, ...r}));
  });
  return rows;
}

function buildTransactionManagerDailyCsvFile(day, rows, items, activity='all', department='all') {
  if (membership?.role !== 'transaction_manager') throw new Error('Only the Transaction Manager can access the daily transaction CSV.');
  const report = buildTransactionManagerDailyReport(rows, day, {activity, department, items});
  const selected = report.todayRows.slice().sort((a,b)=>{ const t=(a.createdAt?.toMillis?.()||0)-(b.createdAt?.toMillis?.()||0); if(t) return t; return String(a.itemName||'').localeCompare(String(b.itemName||''),undefined,{sensitivity:'base'}); });
  if(!selected.length) throw new Error(`No matching Inventory Manager transactions were recorded on ${day}.`);
  const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;
  const movementFilter=activity==='receive'?'Received':activity==='dispatch'?'Dispatched':'All movements';
  const departmentFilter=department==='all'?'All departments':department;
  const lines=[['Inventro Transaction Manager Daily CSV'],['Date',day],['Movement filter',movementFilter],['Department filter',departmentFilter],['Generated',formatDate(new Date())],[],['Item Name','Movement','Department','Quantity','Unit','Time','Person ID','Role','Requested By','Request ID','Note','Status'],...selected.map(r=>[r.itemName,movementLabel(r.type),r.department||'',r.quantity,r.unit||'',formatDate(r.createdAt),r.byEmail?shortPersonId(r.byEmail,r.byRole||r.actorRole||''):'',roleLabel(r.byRole||r.actorRole||''),r.requestedByEmail?shortPersonId(r.requestedByEmail,r.requestedByRole||'stock_requester'):'',r.requestId||'',r.note||'',r.deleted?'DELETED':r.editedAt?'EDITED':'ORIGINAL'])].map(row=>row.map(esc).join(','));
  return new File([lines.join('\r\n')],`Inventro-TM-Daily-${day}.csv`,{type:'text/csv;charset=utf-8'});
}
async function shareTransactionManagerDailyCsv(day, rows, items, activity='all', department='all') { const file=buildTransactionManagerDailyCsvFile(day,rows,items,activity,department); return shareFile(file,`${membership?.companyName||'Company'} — Transaction Manager daily report ${day}`); }
function downloadTransactionManagerDailyCsv(day, rows, items, activity='all', department='all') { const file=buildTransactionManagerDailyCsvFile(day,rows,items,activity,department); const url=URL.createObjectURL(file); const a=document.createElement('a'); a.href=url; a.download=file.name; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500); return 'downloaded'; }

function renderHome(membership) {
  if (!pinUnlocked()) { showPinGate(); return; }
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
    // Stock Requisitioners already see live item availability inline when
    // they create a request, so their own "Stock" tile is redundant.
    ...(isStockRequesterRole(role) ? [] : [['📦','Stock','View live current kitchen stock','stock']]),
    ...(role === 'inventory_manager' ? [['⬆️','Dispatch','Send stock out directly','dispatch'],['⬇️','Receive Stock','Record newly arrived items','receive']] : []),
    ...(canRequest ? [['📝','Requests','Create and manage kitchen stock requests','requests']] : []),
    ...(isAdmin ? [['👥','Admin','Manage your company team','admin']] : []),
    ['📊','Stats','See stock and usage insights','stats'],
    // Transaction Manager's "History" and "Live Daily Report" open the exact
    // same screen, so only the more clearly named one is kept for them.
    ...(role === 'transaction_manager' ? [] : [['🕘','History','Review previous stock activity','history']]),
    ...(role === 'transaction_manager' ? [['⚡','Live Daily Report','Track Inventory Manager receive & dispatch activity','tm-live-report']] : [])
  ];

  root.innerHTML = `
    <div class="dashboard">
      <div class="topbar">
        <div class="topbar-brand">Inventro</div>
        <div class="account-wrap">
          <button class="user-pill account-toggle" id="account-toggle" type="button"><div class="avatar">${initial}</div><div class="user-email">${email}</div><span class="account-chevron">⌄</span></button>
          <div class="account-menu" id="account-menu" hidden><div class="account-menu-email">${email}</div><button type="button" class="menu-action" id="pin-settings-btn">🔐 Security PIN</button>${isMobileDevice()?`<button type="button" class="menu-action" id="biometric-settings-btn">👆 Fingerprint unlock ${biometricReadyOnThisDevice()?'(on)':'(off)'}</button>`:''}<button type="button" class="menu-signout" id="menu-signout">Sign out</button></div>
        </div>
      </div>
      <section class="hero"><p class="eyebrow">Company workspace</p><h1>Welcome, ${firstName}! 👋</h1><p>You are successfully logged in. This is your ${companyName} inventory workspace.</p><div class="company-meta"><span class="badge">🏢 ${companyName}</span><span class="badge role">${isAdmin ? '👑 Admin' : '👤 ' + escapeHtml(roleLabel(role))}</span><span class="badge">● Active</span></div></section>
      <div class="section-title">Quick access</div><div class="quick-grid">${quickItems.map(([icon,title,desc,action])=>`<button class="quick-card ${action==='requests'?'request-quick-card':''} ${action==='stock'?'stock-quick-card':''}" data-action="${action}" type="button"><div class="quick-icon">${icon}</div><strong>${title}${action==='stock'?'<span class="home-status-badge" id="stock-alert-badge" hidden>0</span>':''}${action==='requests'?'<span class="request-badge" id="request-badge" hidden>0</span>':''}</strong><span>${desc}</span></button>`).join('')}</div>
    </div>`;
  const accountToggle=root.querySelector('#account-toggle'), accountMenu=root.querySelector('#account-menu');
  if(accountToggle&&accountMenu) accountToggle.addEventListener('click',()=>{accountMenu.hidden=!accountMenu.hidden;});
  root.querySelector('#menu-signout')?.addEventListener('click',()=>{clearEmployeeCodeVerification();signOut();});
  root.querySelector('#enable-alerts')?.addEventListener('click',async()=>{try{await enableLowStockNotifications();}catch(err){showTemporaryMessage(friendlyError(err),'error');}});
  startHomeStatusListener();
  root.querySelector('#pin-settings-btn')?.addEventListener('click',renderPinSettings);
  root.querySelector('#biometric-settings-btn')?.addEventListener('click',async()=>{await renderBiometricSettings();renderHome(membership);});

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
  // The Share button must open the native Android/Web Share sheet.
  // Do NOT silently fall back to downloading: that makes a Share tap behave
  // like the Download button. Some Android browsers report canShare(false)
  // for CSV files even though navigator.share can still hand the File to the
  // native share sheet, so try the file share directly.
  if (!navigator.share) throw new Error('File sharing is not supported by this browser. Please use Chrome on Android.');
  try {
    await navigator.share({ title: 'Inventro Stock Report', text, files: [file] });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.error('Native file sharing failed.', err);
    throw new Error('Could not open the Android share sheet. Please try again or use Download CSV.');
  }
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
    batch.set(doc(collection(ref,'movements')),{type:'order_sent',quantity:Number(item.quantity||0),unit:item.unit,note:'Added to supplier reorder report',orderId,orderSentAt:generatedAt,byUid:user.uid,byEmail:user.email?.toLowerCase()||'',byRole:membership?.role||'',byName:user.displayName || '',createdAt:serverTimestamp()});
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
      <div class="stock-report-summary-main"><span class="supplier-mini-icon">📦</span><div><strong>Supplier reorder</strong><span>${totalActionable ? `${totalActionable} item${totalActionable===1?'':'s'} ready` : 'No new reorder items'}</span></div></div>
      <div class="supplier-summary-chips"><span class="supplier-chip red-chip">🔴 ${newRed.length}</span><span class="supplier-chip yellow-chip">🟡 ${newYellow.length}</span><span class="supplier-chip blue-chip">🔵 ${outstanding.length}</span></div>
      <span class="supplier-expand">Open <b>⌄</b></span>
    </summary>
    <div class="stock-report-details">
      <div class="supplier-compact-head"><strong>Build supplier order</strong><span>Red items are included automatically. Select yellow items. Ordered items can be selected again only for resend.</span></div>
      <div class="supplier-compact-groups">
        <div class="supplier-compact-group red-group"><div class="report-group-title red-title">🔴 New red <em>${newRed.length}</em></div>${newRed.length?newRed.map(i=>`<label class="report-item compact-report-item locked"><input type="checkbox" checked disabled><span>${escapeHtml(i.name)}</span><small>${formatQty(i.quantity)} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">None</div>'}</div>
        <div class="supplier-compact-group yellow-group"><div class="report-group-title yellow-title">🟡 Yellow <em>${newYellow.length}</em></div>${newYellow.length?newYellow.map(i=>`<label class="report-item compact-report-item"><input type="checkbox" class="yellow-report-check" value="${escapeHtml(i.id)}"><span>${escapeHtml(i.name)}</span><small>${formatQty(i.quantity)} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">None</div>'}</div>
        <div class="supplier-compact-group ordered-group"><div class="report-group-title ordered-title">🔵 Ordered <em>${outstanding.length}</em></div>${outstanding.length?outstanding.map(i=>`<label class="report-item compact-report-item ordered-report-item"><input type="checkbox" class="resend-report-check" value="${escapeHtml(i.id)}"><span>${escapeHtml(i.name)}<em>${escapeHtml(formatDate(i.procurementOrderSentAt))}</em></span><small>${formatQty(i.quantity)} ${escapeHtml(i.unit)}</small></label>`).join(''):'<div class="report-empty">None</div>'}</div>
      </div>
      <div class="report-builder-actions compact-report-actions"><button class="small-action report-btn" id="share-selected-low-pdf" type="button">📄 Create & share order</button><span>${totalActionable?'Review yellow selections before sending.':'Choose an outstanding order above to resend.'}</span></div>
    </div>
  </details>`;
}

async function shareCurrentStockCsv(itemsOverride=null){
  if(membership?.role!=='inventory_manager') throw new Error('Only Inventory Manager can share the stock CSV.');
  const items=Array.isArray(itemsOverride)?itemsOverride:await listItems(); const rows=currentStockRows(items); if(!rows.length) throw new Error('There are no stock items to share.');
  const escapeCsv=value=>`"${String(value??'').replaceAll('"','""')}"`;
  const lines=[['Item Name','Current Quantity','Unit','Low Stock Limit','Status','Last Updated'].map(escapeCsv).join(','),...rows.map(r=>[r.name,r.quantity,r.unit,r.low,stockState(r.quantity,r.low),r.updated].map(escapeCsv).join(','))];
  const file=new File([lines.join('\r\n')],`Inventro-Current-Stock-${new Date().toISOString().slice(0,10)}.csv`,{type:'text/csv;charset=utf-8'});return shareFile(file,`${membership?.companyName||'Company'} — Current Stock List`);
}

async function shareDailyHistoryCsv(dateStr, rowsOverride=null){
  if(!['admin','inventory_manager'].includes(membership?.role)) throw new Error('Only Admin and Inventory Manager can share daily stock history.');
  const rows=Array.isArray(rowsOverride)?rowsOverride:await listHistory(); const day=dateStr||localDateKey();
  const start=new Date(`${day}T00:00:00`),end=new Date(`${day}T23:59:59.999`);
  const selected=rows.filter(r=>{const ms=r.createdAt?.toMillis?.()||0;return ms>=start.getTime()&&ms<=end.getTime();}).sort((a,b)=>{const byItem=(a.itemName||'').localeCompare(b.itemName||'',undefined,{sensitivity:'base'});if(byItem)return byItem;return (a.createdAt?.toMillis?.()||0)-(b.createdAt?.toMillis?.()||0);});
  if(!selected.length) throw new Error(`No stock history was recorded on ${day}.`);
  const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;const lines=[['Item Name','Movement','Department','Quantity','Unit','Person ID','Role','Time','Note','Status','Edited By ID','Edited At','Deleted By ID','Deleted At','Requested By ID'].map(esc).join(','),...selected.map(r=>[r.itemName,movementLabel(r.type),r.department||'',r.quantity,r.unit,r.byEmail?shortPersonId(r.byEmail,r.actorRole||r.byRole||''):'',roleLabel(r.actorRole||r.byRole||''),formatDate(r.createdAt),r.note||'',r.deleted?'DELETED':r.editedAt?'EDITED':'ORIGINAL',r.editedByEmail?shortPersonId(r.editedByEmail,r.editedByRole||r.actorRole||r.byRole||''):'',r.editedAt?formatDate(r.editedAt):'',r.deletedByEmail?shortPersonId(r.deletedByEmail,r.deletedByRole||r.actorRole||r.byRole||''): '',r.deletedAt?formatDate(r.deletedAt):'',r.requestedByEmail?shortPersonId(r.requestedByEmail,r.requestedByRole||'stock_requester'): ''].map(esc).join(','))];
  const file=new File([lines.join('\r\n')],`Inventro-Daily-History-${day}.csv`,{type:'text/csv;charset=utf-8'});return shareFile(file,`${membership?.companyName||'Company'} — Daily stock history ${day}`);
}

async function renderStock(){
  stopStockListener(); let items=[],error=''; try{items=await listItems();}catch(err){error=friendlyError(err);}
  const manager=membership?.role==='inventory_manager';
  const lastReport=manager?localStorage.getItem(`inventroLastStockReport:${currentCompanyId()}`):null;
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="stock-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="stock-refresh">↻ Refresh</button></div>
    <section class="feature-header"><p class="eyebrow">Live inventory</p><h1>Stock</h1><p>Live stock levels and current availability across the company.</p></section>
    ${manager?`<section class="inventory-tools"><div class="stock-search-wrap"><span>⌕</span><input id="stock-search" type="search" placeholder="Search stock by item name…" autocomplete="off"></div><div class="inventory-share-actions"><button class="small-action csv-btn" id="share-stock-csv" type="button">📊 Share current stock CSV</button></div></section>${lastReport?`<div class="report-history-note">Last reorder report sent: <strong>${escapeHtml(formatDate(lastReport))}</strong>. New red/yellow items after that time are not part of that old snapshot.</div>`:''}${stockReportSelectionHtml(items)}`:`<section class="inventory-tools"><div class="stock-search-wrap"><span>⌕</span><input id="stock-search" type="search" placeholder="Search stock by item name…" autocomplete="off"></div></section>`}
    ${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}<div id="stock-grid" class="stock-grid"></div></div>`;
  renderStockCards(items);
  root.querySelector('#stock-back').addEventListener('click',()=>{stopStockListener();navigateBack('home');});root.querySelector('#stock-refresh').addEventListener('click',()=>renderStock());root.querySelector('#stock-search').addEventListener('input',()=>renderStockCards(items));
  root.querySelector('#share-stock-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#share-stock-csv');b.disabled=true;b.textContent='Preparing CSV…';try{const mode=await shareCurrentStockCsv(items);showTemporaryMessage(mode==='shared'?'Current stock CSV ready to share.':'Current stock CSV downloaded.','success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📊 Share current stock CSV';}});
  root.querySelector('#share-selected-low-pdf')?.addEventListener('click',async()=>{const b=root.querySelector('#share-selected-low-pdf');b.disabled=true;b.textContent='Preparing report…';try{const yellowIds=[...root.querySelectorAll('.yellow-report-check:checked')].map(x=>x.value);const resendIds=[...root.querySelectorAll('.resend-report-check:checked')].map(x=>x.value);const result=await shareLowStockPdf({yellowIds,resendIds});showTemporaryMessage(result.mode==='shared'?`Supplier order ${result.orderId} ready to share.`:`Supplier order ${result.orderId} downloaded.`,'success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📄 Generate & share report';}});
  const companyId=currentCompanyId(); if(companyId){stockUnsubscribe=onSnapshot(collection(db,'companies',companyId,'items'),snap=>{const live=snap.docs.map(d=>({id:d.id,...d.data()}));renderStockCards(live);maybeNotifyStockState(live);},err=>showTemporaryMessage(friendlyError(err),'error'));}
}

async function renderMovement(type){
  if(type==='dispatch'&&!canDirectDispatch()){navigate('requests');return;}
  if(type==='receive'&&!canReceiveStock()){navigate('requests');return;}
  let items=[],departments=[],error='';try{items=await listItems();departments=await listDepartments();}catch(err){error=friendlyError(err);}
  const receive=type==='receive',sorted=stockSort(items,false);
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="movement-back">‹ Back</button><div class="topbar-brand">Inventro</div></div>
    <section class="feature-header"><p class="eyebrow">Stock movement</p><h1>${receive?'Receive Stock':'Dispatch'}</h1><p>${receive?'Record a newly arrived delivery.':'Record stock leaving the store. Choose an item and department before saving.'}</p></section>
    <section class="admin-card movement-card">${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}
      <div class="field"><label for="movement-item-search">Item</label>
        <div class="movement-combobox" id="movement-combobox">
          <div class="movement-item-search"><span>⌕</span><input id="movement-item-search" type="search" placeholder="Search or choose an item…" autocomplete="off" aria-expanded="false" aria-controls="movement-item-menu"></div>
          <div id="movement-item-menu" class="movement-item-menu" role="listbox" hidden>${sorted.map(i=>`<button type="button" class="movement-item-option" data-item-id="${escapeHtml(i.id)}"><strong>${escapeHtml(i.name)}</strong><span>${Number(i.quantity||0)} ${escapeHtml(i.unit)}</span></button>`).join('')}</div>
        </div>
        <input id="movement-item" type="hidden">
      </div>
      <div id="movement-item-insight" class="movement-insight"></div>
      ${receive?'':`<div class="field"><label for="movement-department">Department receiving stock</label><select id="movement-department"><option value="">Select department…</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>`}
      <div class="field"><label for="movement-qty">Quantity</label><input id="movement-qty" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0"></div>
      <div class="field"><label for="movement-note">Note (optional)</label><input id="movement-note" type="text" maxlength="120" placeholder="${receive?'e.g. Supplier delivery':'e.g. Emergency kitchen issue'}"></div>
      ${receive?`<label class="fulfill-order-option"><input id="fulfill-outstanding-order" type="checkbox"><span><strong>Close outstanding supplier order</strong><small>If this delivery is the order that was previously sent, mark it as received/fulfilled.</small></span></label>`:''}
      <button class="btn btn-primary" id="movement-save" ${items.length?'':'disabled'}>${receive?'Record received stock':'Record dispatch'}</button>
    </section></div>`;
  const search=root.querySelector('#movement-item-search'),hidden=root.querySelector('#movement-item'),menu=root.querySelector('#movement-item-menu'),combo=root.querySelector('#movement-combobox'),insight=root.querySelector('#movement-item-insight'),fulfillCheck=root.querySelector('#fulfill-outstanding-order'),save=root.querySelector('#movement-save');let selectedItemId='';
  const setMenu=(open)=>{menu.hidden=!open;search.setAttribute('aria-expanded',String(open));};
  function drawOptions(){const q=search.value.trim().toLowerCase();const matches=sorted.filter(i=>String(i.name||'').toLowerCase().includes(q));menu.innerHTML=matches.length?matches.map(i=>`<button type="button" class="movement-item-option" data-item-id="${escapeHtml(i.id)}"><strong>${escapeHtml(i.name)}</strong><span>${Number(i.quantity||0)} ${escapeHtml(i.unit)}</span></button>`).join(''):`<div class="movement-item-empty">No matching stock item found.</div>`;setMenu(true);}
  async function refreshInsight(item){selectedItemId=item?.id||'';hidden.value=selectedItemId;if(item)search.value=item.name;if(!item){insight.innerHTML='<div class="movement-select-hint">Select a stock item from the dropdown above.</div>';if(save)save.disabled=true;return;}let moves=[];try{moves=await listItemMovements(item.id);}catch(_){}const lastDispatch=[...moves].reverse().find(m=>m.type==='dispatch'),lastReceive=[...moves].reverse().find(m=>m.type==='receive'),state=stockState(Number(item.quantity||0),Number(item.lowStockAlert||0));if(fulfillCheck)fulfillCheck.checked=!!itemHasOutstandingOrder(item);insight.innerHTML=`<div class="movement-insight-head"><strong>${escapeHtml(item.name)}</strong><span class="stock-state movement-state ${state}">${state==='low'?'Low':state==='near'?'Near low':'Good'}</span></div><div class="movement-insight-grid"><div><span>Stock now</span><strong>${Number(item.quantity||0)} ${escapeHtml(item.unit)}</strong></div><div><span>Low limit</span><strong>${Number(item.lowStockAlert||0)} ${escapeHtml(item.unit)}</strong></div><div><span>Last dispatch</span><strong>${lastDispatch?escapeHtml(formatDate(lastDispatch.createdAt)):'No record yet'}</strong></div><div><span>Last arrival</span><strong>${lastReceive?escapeHtml(formatDate(lastReceive.createdAt)):'No record yet'}</strong></div></div>${itemHasOutstandingOrder(item)?`<div class="outstanding-order-note">🔵 <strong>Supplier order outstanding</strong><span>Sent ${escapeHtml(formatDate(item.procurementOrderSentAt))} · ${escapeHtml(item.procurementOrderId)}</span></div>`:''}`;if(save)save.disabled=false;}
  search.addEventListener('focus',drawOptions);search.addEventListener('input',()=>{hidden.value='';selectedItemId='';if(save)save.disabled=true;drawOptions();});
  menu.addEventListener('click',e=>{const btn=e.target.closest('[data-item-id]');if(!btn)return;const item=sorted.find(i=>i.id===btn.dataset.itemId);if(item){refreshInsight(item);setMenu(false);}});
  document.addEventListener('click',function outsideMovement(e){if(combo&&!combo.contains(e.target))setMenu(false);},{once:true});
  root.querySelector('#movement-back').addEventListener('click',()=>navigateBack('home'));save.addEventListener('click',async()=>{save.disabled=true;save.textContent='Checking PIN…';try{if(!selectedItemId)throw new Error('Choose an item first.');const department=root.querySelector('#movement-department')?.value.trim()||'';if(type==='dispatch'&&!department)throw new Error('Select the department receiving this stock.');await changeStock(selectedItemId,root.querySelector('#movement-qty').value,type,root.querySelector('#movement-note').value,{fulfillOutstandingOrder:!!fulfillCheck?.checked,department});showTemporaryMessage(receive?'Received stock recorded.':'Dispatch recorded.','success');navigate('stock');}catch(err){showTemporaryMessage(friendlyError(err),'error');save.disabled=false;save.textContent=receive?'Record received stock':'Record dispatch';}});
  refreshInsight(null);
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
  if(!companyId||!uid||!['stock_requester','chef','request','transaction_manager'].includes(membership?.role))return;
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
  if(!canCreateRequest()&&!canManageRequests()){navigate('home');return;}let items=[],requests=[],departments=[],notifications=[],error='';try{items=await listItems();requests=await listRequests();departments=await listDepartments();if(['stock_requester','chef','request','transaction_manager'].includes(membership?.role))notifications=await listMyNotifications();}catch(err){error=friendlyError(err);}const canManage=canManageRequests(),canViewAllRequests=['admin','inventory_manager'].includes(membership?.role);let requestDateFilter='';
  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="requests-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="requests-refresh">↻ Refresh</button></div><section class="feature-header"><p class="eyebrow">Kitchen workflow</p><h1>Stock Requests</h1><p>Stock Requisitioner and Transaction Manager users ask for stock for a department. Inventory Manager reviews and dispatches approved requests.</p></section>${['stock_requester','chef','request','transaction_manager'].includes(membership?.role)?`<section class="admin-card"><div class="admin-card-title"><div><h2>New request</h2><p>Choose what the kitchen needs.</p></div></div><div class="field"><label for="request-item">Item</label><select id="request-item">${items.map(i=>`<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} — ${i.quantity} ${escapeHtml(i.unit)} available</option>`).join('')}</select></div><div class="field"><label for="request-department">Department</label><select id="request-department"><option value="">Select department…</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div><div class="field"><label for="request-qty">Quantity needed</label><input id="request-qty" type="number" min="0.01" step="0.01" placeholder="0"></div><div class="field"><label for="request-note">Reason / note</label><input id="request-note" type="text" maxlength="120" placeholder="e.g. Dinner preparation"></div><button class="btn btn-primary" id="request-save" ${items.length?'':'disabled'}>Send request</button></section>`:''}${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}${['stock_requester','chef','request','transaction_manager'].includes(membership?.role)?`<section class="admin-card notification-panel"><div class="admin-card-title"><div><h2 id="notification-title">🔔 My notifications ${notifications.filter(n=>!n.read).length?`<span class="notification-count">${notifications.filter(n=>!n.read).length}</span>`:''}</h2><p>Updates about your stock requests appear here automatically.</p></div></div><div id="notification-list-wrap" class="notification-list">${notifications.map(n=>`<article class="notification-item ${n.read?'read':'unread'}"><div><strong>${escapeHtml(n.title||'Request update')}</strong><p>${escapeHtml(n.message||'')}</p><small>${escapeHtml(formatDate(n.createdAt))}</small></div>${!n.read?`<button class="small-action" data-read-notification="${escapeHtml(n.id)}">Mark read</button>`:''}</article>`).join('')||`<div class="empty-team"><div class="empty-icon">🔔</div><strong>No notifications</strong><span>Your request updates will appear here.</span></div>`}</div></section>`:''}<section class="admin-card request-filter-card"><div class="request-filter-row"><div class="field"><label for="request-date-filter">Filter by date</label><input id="request-date-filter" type="date"></div><button class="small-action" id="request-date-clear" type="button">Show all dates</button></div></section><section class="admin-card"><div class="admin-card-title"><div><h2>${canViewAllRequests?'All requests':'My requests'} <span id="request-visible-count"></span></h2><p>Approved requests stay yellow until dispatched. Dispatched requests turn green.</p></div></div><div id="request-list-render" class="request-list"></div></section></div>`;
  const listEl=root.querySelector('#request-list-render'),countEl=root.querySelector('#request-visible-count');function renderList(){const visible=requests.filter(r=>(canViewAllRequests||r.requestedByUid===auth.currentUser?.uid)&&(!requestDateFilter||localDateKey(r.createdAt?.toDate?.()||new Date(r.createdAt||0))===requestDateFilter));countEl.textContent=`(${visible.length})`;listEl.innerHTML=visible.map(r=>`<article class="request-card request-status-card-${escapeHtml(r.status)}"><div><div class="request-title"><strong>${escapeHtml(r.itemName)}</strong><span class="request-status ${escapeHtml(r.status)}">${escapeHtml(r.status==='approved'?'READY TO DISPATCH':r.status==='fulfilled'?'DISPATCHED':r.status.toUpperCase())}</span></div><div class="request-qty">${r.quantity} ${escapeHtml(r.unit)}</div><div class="stock-meta">Department: <strong>${escapeHtml(r.department||'Not specified')}</strong> · By ${escapeHtml(personRef(r.requestedByEmail||'', r.requestedByRole||'stock_requester', r.requestedByName||''))} · ${escapeHtml(formatDate(r.createdAt))}</div>${r.note?`<div class="request-note">${escapeHtml(r.note)}</div>`:''}</div><div class="request-actions">${canManage&&r.status==='pending'?`<button class="small-action approve" data-request-action="approve" data-id="${escapeHtml(r.id)}">Approve</button><button class="small-action reject" data-request-action="reject" data-id="${escapeHtml(r.id)}">Reject</button>`:''}${canManage&&r.status==='approved'?`<button class="small-action fulfill-action" data-request-action="fulfill" data-id="${escapeHtml(r.id)}">Dispatch</button>`:''}${!canManage&&r.status==='pending'&&r.requestedByUid===auth.currentUser?.uid?`<button class="small-action reject" data-request-action="cancel" data-id="${escapeHtml(r.id)}">Cancel request</button>`:''}</div></article>`).join('')||`<div class="empty-team"><div class="empty-icon">📝</div><strong>No requests for this date</strong><span>Try another date or show all dates.</span></div>`;listEl.querySelectorAll('[data-request-action]').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{const action=btn.dataset.requestAction;if(action==='fulfill')await fulfillRequest(btn.dataset.id);else if(action==='cancel')await cancelStockRequest(btn.dataset.id);else await updateRequestStatus(btn.dataset.id,action==='approve'?'approved':'rejected');showTemporaryMessage(action==='fulfill'?'Request dispatched and stock recorded.':action==='cancel'?'Request cancelled.':'Request updated.','success');await renderRequests();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));}
  root.querySelector('#request-date-filter').addEventListener('change',e=>{requestDateFilter=e.target.value;renderList();});root.querySelector('#request-date-clear').addEventListener('click',()=>{requestDateFilter='';root.querySelector('#request-date-filter').value='';renderList();});root.querySelector('#requests-back').addEventListener('click',()=>navigateBack('home'));root.querySelector('#requests-refresh').addEventListener('click',()=>renderRequests());root.querySelector('#request-save')?.addEventListener('click',async()=>{const b=root.querySelector('#request-save');b.disabled=true;b.textContent='Sending…';try{await createStockRequest({itemId:root.querySelector('#request-item').value,quantity:root.querySelector('#request-qty').value,department:root.querySelector('#request-department').value,note:root.querySelector('#request-note').value});showTemporaryMessage('Stock request sent.','success');await renderRequests();}catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;b.textContent='Send request';}});root.querySelectorAll('[data-read-notification]').forEach(btn=>btn.addEventListener('click',async()=>{btn.disabled=true;try{await markNotificationRead(btn.dataset.readNotification);}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));startMyNotificationListener();startRequestListListener();renderList();
}


function movementMillis(r){
  return Number(r?.createdAt?.toMillis?.() || r?.clientCreatedAt || 0);
}
function stockAffectingMovement(r){
  return r?.deleted !== true && r?.active !== false && ['opening','receive','dispatch'].includes(r?.type) && Number.isFinite(Number(r?.quantity));
}
function movementSignedQuantity(r){
  const n=Number(r?.quantity||0);
  return (r?.type==='opening'||r?.type==='receive') ? n : r?.type==='dispatch' ? -n : 0;
}
function buildTransactionManagerDailyReport(rows, day, options={}) {
  const ledgerRows = rows.map(r => ({...r, actorRole:r.actorRole || r.byRole || realtimeEmployeeRoleMap.get(String(r.byEmail||'').toLowerCase()) || ''})).filter(stockAffectingMovement);
  const targetStart = new Date(`${day}T00:00:00`).getTime();
  const targetEnd = new Date(`${day}T00:00:00`); targetEnd.setDate(targetEnd.getDate()+1);
  const endMs=targetEnd.getTime();
  const before = ledgerRows.filter(r => movementMillis(r) < targetStart);
  const duringDay = ledgerRows.filter(r => { const t=movementMillis(r); return t>=targetStart && t<endMs; });

  const imDayRows = duringDay.filter(r => (r.byRole||r.actorRole)==='inventory_manager');
  const activity=options.activity||'all', department=options.department||'all';
  const visibleRows=imDayRows.filter(r => (activity==='all'||r.type===activity) && (department==='all'||(r.department||'')===department));

  const today=day===localDateKey();
  const itemMap=new Map((options.items||[]).map(i=>[i.id,i]));
  const itemIds=[...new Set((today ? duringDay : [...before,...duringDay]).map(r=>r.itemId||r.id).filter(Boolean))];

  const reports=itemIds.map(itemId=>{
    const prior=before.filter(r=>r.itemId===itemId);
    const dayAll=duringDay.filter(r=>r.itemId===itemId);
    const dayIm=imDayRows.filter(r=>r.itemId===itemId);
    const sample=dayAll[0]||prior.slice().sort((a,b)=>movementMillis(b)-movementMillis(a))[0]||itemMap.get(itemId);
    if(!sample) return null;

    let opening;
    const liveStartMs=movementLiveStartDate().getTime();
    const isLiveWindowDay=targetStart>=liveStartMs && targetStart<=new Date(`${localDateKey()}T00:00:00`).getTime();
    if(isLiveWindowDay && itemMap.has(itemId)){
      // The live cache intentionally contains only 7 days, so it cannot safely
      // calculate an opening balance by summing rows before the selected day.
      // Instead, use the item's authoritative current stock and subtract every
      // non-opening movement from the selected day forward. Opening-stock
      // movements are treated as the baseline, not as an intraday receipt.
      const currentQty=Number(itemMap.get(itemId).quantity||0);
      const netFromSelectedDay=ledgerRows
        .filter(r=>r.itemId===itemId && movementMillis(r)>=targetStart && r.type!=='opening')
        .reduce((sum,r)=>sum+movementSignedQuantity(r),0);
      opening=currentQty-netFromSelectedDay;
    }else{
      opening=prior.reduce((sum,r)=>sum+movementSignedQuantity(r),0);
      // If the item was created with opening stock on this same day, that opening
      // movement is the day's opening balance, not a receipt during the day.
      opening+=dayAll.filter(r=>r.type==='opening').reduce((sum,r)=>sum+Number(r.quantity||0),0);
    }

    const received=dayIm.filter(r=>r.type==='receive').reduce((sum,r)=>sum+Number(r.quantity||0),0);
    const dispatched=dayIm.filter(r=>r.type==='dispatch').reduce((sum,r)=>sum+Number(r.quantity||0),0);
    const closing=opening+dayAll.filter(r=>r.type!=='opening').reduce((sum,r)=>sum+movementSignedQuantity(r),0);
    return {itemId,itemName:sample.itemName||sample.name||itemMap.get(itemId)?.name||itemId,unit:sample.unit||itemMap.get(itemId)?.unit||'',opening,received,dispatched,closing,transactions:dayIm,
      hasNegativeOpening:opening<0,hasNegativeClosing:closing<0};
  }).filter(Boolean).sort((a,b)=>a.itemName.localeCompare(b.itemName,undefined,{sensitivity:'base'}));
  return {reports,todayRows:visibleRows,allInventoryManagerRows:imDayRows};
}
function renderTransactionManagerLiveReport(root, rows, day, options={}) {
  const target=root.querySelector('#tm-live-report');
  if(!target) return;
  const today=localDateKey();
  const live=day===today;
  const reportItems=options.items || realtimeLatestItems;
  const {reports,todayRows}=buildTransactionManagerDailyReport(rows,day,{...options,items:reportItems});
  const updated=todayRows.map(r=>r.createdAt?.toMillis?.()||0).filter(Boolean).sort((a,b)=>b-a)[0];
  const latest=updated ? formatDate(new Date(updated)) : 'No transactions yet';
  target.innerHTML=`
    <div class="tm-live-head">
      <div><div class="tm-live-title"><span class="tm-live-dot ${live?'active':'locked'}"></span><strong>${live?'Live daily report':'Finished daily report'}</strong><span class="tm-report-state ${live?'live':'locked'}">${live?'LIVE':'LOCKED'}</span></div>
      <p>${live?'Updates automatically whenever the Inventory Manager records a receive or dispatch.':'This day is finished. Its report is read-only and preserved from the recorded transaction history.'}</p></div>
      <div class="tm-last-update">Last transaction<br><strong>${escapeHtml(latest)}</strong></div>
    </div>
    <div class="tm-live-summary tm-live-summary-compact"><div><span>Transactions</span><strong>${todayRows.length}</strong><small>Inventory Manager entries</small></div><div><span>Items moved</span><strong>${new Set(todayRows.map(r=>r.itemId)).size}</strong><small>Different goods</small></div></div>
    <div class="tm-live-table-wrap"><table class="tm-live-table"><thead><tr><th>Good</th><th>Opening</th><th>Received</th><th>Dispatched</th><th>Closing</th></tr></thead><tbody>${reports.map(x=>`<tr><td><strong>${escapeHtml(x.itemName)}</strong><small>${escapeHtml(x.unit)}</small></td><td>${formatQty(x.opening)} ${escapeHtml(x.unit)}</td><td class="tm-in">+${formatQty(x.received)} ${escapeHtml(x.unit)}</td><td class="tm-out">−${formatQty(x.dispatched)} ${escapeHtml(x.unit)}</td><td><strong>${formatQty(x.closing)} ${escapeHtml(x.unit)}</strong></td></tr>`).join('')||`<tr><td colspan="5"><div class="empty-team"><strong>No Inventory Manager transactions for this day.</strong><span>New activity will appear here automatically.</span></div></td></tr>`}</tbody></table></div>
    <div class="tm-feed"><div class="tm-feed-head"><strong>Transaction feed</strong><span>${todayRows.length ? 'Newest activity first' : 'Waiting for activity'}</span></div>${todayRows.slice().sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0)).map(r=>{ const actorEmail=String(r.byEmail||r.actorEmail||'').trim(); const actorRole=roleLabel(r.byRole||r.actorRole||'inventory_manager'); const requester=r.requestId&&r.requestedByEmail?` · Requested by ${personRef(r.requestedByEmail,r.requestedByRole||'stock_requester',r.requestedByName||'')}`:''; const origin=transactionOriginShort(r); const when=formatDate(r.createdAt); const audit=(membership?.role==='transaction_manager'&&(r.editCount||r.editedAt||r.deleted))?`<button class="small-action audit-view-btn tm-feed-audit" data-tm-revision="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">View changes</button>`:''; return `<div class="tm-feed-row ${r.type==='receive'?'tm-feed-receive':'tm-feed-dispatch'}"><span class="tm-feed-type ${r.type==='receive'?'in':'out'}">${r.type==='receive'?'IN':'OUT'}</span><div class="tm-feed-main"><strong>${escapeHtml(r.itemName)} <span class="tm-origin-pill ${origin.toLowerCase()}">${origin}</span></strong><span>${r.type==='receive'?'+':'−'}${formatQty(r.quantity)} ${escapeHtml(r.unit)}${r.department?` · ${escapeHtml(r.department)}`:''}</span><small>${escapeHtml(personRef(actorEmail,r.byRole||r.actorRole||'inventory_manager',r.byName||''))} · ${escapeHtml(when)}${requester}${r.editedAt?' · EDITED':''}${r.deleted?' · DELETED':''}</small></div>${audit}</div>`;}).join('')||'<div class="empty-team">No transactions recorded yet.</div>'}</div>
    <div class="tm-lock-note">🔒 ${live?'Today remains live until the date changes. At midnight, this report becomes a finished locked record and the new day starts with the previous closing balances as its opening basis.':'This finished report is locked because the selected date has passed.'}</div>`;
}

function openRevisionViewer(revisions,currentMovement=null){
  const old=document.getElementById('revision-viewer-modal'); if(old) old.remove();
  const overlay=document.createElement('div'); overlay.id='revision-viewer-modal'; overlay.className='modal-overlay revision-overlay';
  const current=currentMovement||{};
  const currentBox=current.id?`<section class="revision-current-box"><div class="revision-current-head"><div><span class="revision-current-label">CURRENT SAVED DATA</span><strong>${escapeHtml(current.itemName||'Transaction')}</strong></div><span class="history-audit-pill ${current.deleted?'deleted':'edited'}">${current.deleted?'DELETED':'CURRENT'}</span></div><div class="revision-grid"><div><small>Quantity</small><strong>${escapeHtml(String(current.quantity??0))} ${escapeHtml(current.unit||'')}</strong></div><div><small>Type</small><strong>${escapeHtml(movementLabel(current.type||''))}</strong></div><div><small>Department</small><strong>${escapeHtml(current.department||'—')}</strong></div><div><small>Note</small><strong>${escapeHtml(current.note||'—')}</strong></div></div></section>`:'';
  const accessNotice=current.revisionReadError?`<div class="error-box">${escapeHtml(current.revisionReadError)}</div>`:'';
  const rows=revisions.map((r,i)=>`<article class="revision-card">
    <div class="revision-top"><div><span class="revision-action ${escapeHtml(r.action||'edit')}">${escapeHtml(r.action==='delete'?'DELETED':'EDITED · Revision '+(r.version||i+1))}</span></div><strong>${escapeHtml(formatDate(r.changedAt))}</strong></div>
    <div class="revision-by">Changed by <strong>${escapeHtml(personRef(r.changedByEmail||'', r.changedByRole||''))}</strong></div>
    <div class="revision-grid">
      <div><small>Previous quantity</small><strong>${escapeHtml(String(r.previousQuantity??0))} ${escapeHtml(r.previousUnit||'')}</strong></div>
      <div><small>Previous type</small><strong>${escapeHtml(movementLabel(r.previousType||''))}</strong></div>
      <div><small>Previous department</small><strong>${escapeHtml(r.previousDepartment||'—')}</strong></div>
      <div><small>Previous note</small><strong>${escapeHtml(r.previousNote||'—')}</strong></div>
    </div>
    <div class="revision-original"><span>Original owner</span><strong>${escapeHtml(personRef(r.previousByEmail||'', r.previousByRole||''))}</strong></div>
  </article>`).join('');
  overlay.innerHTML=`<div class="revision-modal" role="dialog" aria-modal="true"><div class="revision-modal-head"><div><p class="eyebrow">Audit trail</p><h2>Transaction changes</h2><p>This view is available to the transaction owner, Admin and Transaction Manager. It shows who changed the record and what the previous saved data was.</p></div><button class="modal-close" id="revision-close" type="button">×</button></div><div class="revision-list">${accessNotice}${currentBox}${rows||'<div class="empty-team"><div class="empty-icon">🧾</div><strong>No previous versions recorded</strong><span>No edit or delete revision has been recorded for this transaction.</span></div>'}</div><div class="revision-modal-foot"><button class="btn btn-secondary" id="revision-close-bottom" type="button">Close</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#revision-close').onclick=()=>overlay.remove(); overlay.querySelector('#revision-close-bottom').onclick=()=>overlay.remove(); overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
}

function canViewRevisionDetails(row){
  if(!row) return false;
  const role=membership?.role||'';
  return role==='transaction_manager' || role==='admin' || row.byUid===auth.currentUser?.uid || String(row.byEmail||'').toLowerCase()===String(auth.currentUser?.email||'').toLowerCase();
}

async function renderHistory(forcedRole=null){
  const role=membership?.role||'';
  const isAdmin=role==='admin';
  const selectedRole=isAdmin ? (forcedRole || null) : (isStockRequesterRole(role) ? 'stock_requester' : role);
  const adminMenuOnly=isAdmin && !selectedRole;
  const today=localDateKey();
  const currentEmail=(auth.currentUser?.email||'').toLowerCase();
  const selectedDayForLoad = document.querySelector('#history-day')?.value || today;
  let rows=[],departments=[],requestEvents=[],requestRecords=[],employees=[],error='';
  try{
    rows=selectedRole && selectedDayForLoad && selectedDayForLoad !== today
      ? await getMovementRowsForDay(selectedDayForLoad)
      : await listHistory();
    requestRecords=await listRequests();
    departments=await listDepartments();
    employees=await listEmployees();
    if(role==='admin'||role==='inventory_manager'){
      requestEvents=await listRequestEvents();
    }else{
      // Request/Chef/TM history uses the parent request documents only.
      // This avoids permission failures from legacy/malformed event documents while
      // still showing the complete current request lifecycle.
      const myRequests=(await listRequests()).filter(r=>r.requestedByUid===auth.currentUser?.uid);
      for(const r of myRequests){
        const base={requestId:r.id,itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||role};
        requestEvents.push({id:`fallback-${r.id}-pending`,...base,eventType:'pending',actorUid:r.requestedByUid||'',actorEmail:r.requestedByEmail||'',actorRole:r.requestedByRole||role,createdAt:r.createdAt});
        if(r.status&&r.status!=='pending') requestEvents.push({id:`fallback-${r.id}-${r.status}`,...base,eventType:r.status,actorUid:r.fulfilledByUid||r.reviewedByUid||'',actorEmail:r.fulfilledByEmail||r.reviewedByEmail||'',actorRole:'inventory_manager',createdAt:r.updatedAt||r.createdAt});
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
        if(!(isStockRequesterRole(reqRole) || reqRole==='transaction_manager')) continue;
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
  const eventLabel=(e)=>({pending:'Pending',approved:'Approved',rejected:'Rejected',fulfilled:'Dispatched',cancelled:'Cancelled'})[e.eventType]||e.eventType;
  const requestStatusTime=(r)=>r.status==='cancelled' ? (r.cancelledAt||r.updatedAt||r.createdAt) : r.status==='fulfilled' ? (r.fulfilledAt||r.updatedAt||r.createdAt) : (r.updatedAt||r.createdAt);
  const currentRequestRows=(forAdmin=false)=>requestRecords
    .filter(r=>isStockRequesterRole(r.requestedByRole||'') && (forAdmin || r.requestedByUid===auth.currentUser?.uid || String(r.requestedByEmail||'').toLowerCase()===currentEmail))
    .map(r=>({kind:'request',time:requestStatusTime(r),createdAt:requestStatusTime(r),requestId:r.id,itemId:r.itemId,itemName:r.itemName,quantity:r.quantity,unit:r.unit,department:r.department||'',requestedByUid:r.requestedByUid||'',requestedByEmail:r.requestedByEmail||'',requestedByRole:r.requestedByRole||'stock_requester',requestedByName:r.requestedByName||'',eventType:r.status||'pending',actorUid:r.status==='fulfilled'?r.fulfilledByUid||'':r.reviewedByUid||'',actorEmail:r.status==='fulfilled'?r.fulfilledByEmail||'':r.reviewedByEmail||'',actorRole:'inventory_manager',actorName:r.fulfilledByName||r.reviewedByName||'',dispatchedAt:r.fulfilledAt||null}));
  const eventTime=(e)=>e.createdAt;
  const combinedForRole=(selectedRole)=>{
    if(selectedRole==='stock_requester'){
      // Request account history: show BOTH request activity and the actual Inventory Manager
      // dispatches that fulfilled requests created by Request accounts. For the signed-in
      // Request user, restrict it to that user's requests; for Admin's Request card, show
      // every Request-role account's activity.
      // A request is represented by its CURRENT status, not by every historical
      // status event. Therefore an Approved request moves to Dispatched as soon
      // as Inventory Manager dispatches it and cannot remain in Approved.
      return currentRequestRows(isAdmin)
        .sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
    }
    if(selectedRole==='inventory_manager'){
      // Inventory Manager log book is the physical stock ledger: receiving and dispatching.
      return rows.filter(r=>r.actorRole==='inventory_manager').map(r=>({kind:'movement',time:r.createdAt,...r})).sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
    }
        // Admin is intentionally not an account card anymore. Keep this fallback for non-card callers.
    const movementRows=rows.filter(r=>r.actorRole===selectedRole).map(r=>({kind:'movement',time:r.createdAt,...r}));
    const events=requestEvents.filter(e=>e.requestedByRole===selectedRole || e.actorRole===selectedRole)
      .map(e=>({kind:'request',time:e.createdAt,...e}));
    return [...movementRows,...events].sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0));
  };

  function renderRows(list, opts={}){
    const target=root.querySelector('#history-list'); if(!target)return;
    const statement=root.querySelector('#daily-statement');
    if(statement){
      if(selectedRole==='transaction_manager'){
        const day=opts.day||today; const dayRows=rows.filter(r=>r.actorRole==='inventory_manager' && isDate(r.createdAt,day));
        const before=rows.filter(r=>r.actorRole==='inventory_manager' && (r.createdAt?.toMillis?.()||0) < new Date(`${day}T00:00:00`).getTime());
        const ids=[...new Set([...before,...dayRows].map(r=>r.itemId))];
        const statements=ids.map(id=>{const allBefore=before.filter(r=>r.itemId===id);const todayRows=dayRows.filter(r=>r.itemId===id);const itemName=(todayRows[0]||allBefore[0])?.itemName||id;const unit=(todayRows[0]||allBefore[0])?.unit||'';let opening=0;for(const r of allBefore){const n=Number(r.quantity||0);if(r.type==='opening'||r.type==='receive')opening+=n;else if(r.type==='dispatch')opening-=n;}let received=0,dispatched=0;for(const r of todayRows){const n=Number(r.quantity||0);if(r.type==='receive')received+=n;else if(r.type==='dispatch')dispatched+=n;}return {itemName,unit,opening,received,dispatched,closing:opening+received-dispatched};}).filter(x=>x.opening||x.received||x.dispatched);
        statement.hidden=false; statement.innerHTML=`<div class="daily-statement-head"><div><strong>📘 Daily transaction statement</strong><span>${escapeHtml(day)} · Closing balance becomes the next day's opening balance.</span></div></div><div class="statement-grid">${statements.map(x=>`<div class="statement-row"><strong>${escapeHtml(x.itemName)}</strong><span>Opening <b>${x.opening} ${escapeHtml(x.unit)}</b></span><span>Received <b>+${x.received} ${escapeHtml(x.unit)}</b></span><span>Dispatched <b>−${x.dispatched} ${escapeHtml(x.unit)}</b></span><span>Closing <b>${x.closing} ${escapeHtml(x.unit)}</b></span></div>`).join('')||'<div class="empty-team">No transaction statement for this day.</div>'}</div>`;
      }else statement.hidden=true;
    }
    const shown=list.filter(r=>{
      if(opts.day && !isDate(r.time||r.createdAt,opts.day))return false;
      const type=root.querySelector('#history-type')?.value||'all';
      const dept=root.querySelector('#history-department')?.value||'all';
      if(dept!=='all' && (r.department||'')!==dept)return false;
      if(type==='received' && !(r.kind==='movement'&&r.type==='receive'))return false;
      if(type==='dispatched' && !(r.kind==='movement'&&r.type==='dispatch'))return false;
      if(type==='requested-dispatch' && !(r.kind==='movement'&&r.type==='dispatch'&&r.requestId))return false;
      if(type.startsWith('request-')){
        const requestedStatus=type.slice(8)==='dispatched'?'fulfilled':type.slice(8);
        if(!(r.kind==='request'&&r.eventType===requestedStatus))return false;
      }
      return true;
    });
    target.innerHTML=shown.map(r=>{
      if(r.kind==='request'){
        const requestStatusClass = String(r.eventType||'pending').toLowerCase();
        const requestStatusIcon = ({approved:'✓',rejected:'×',fulfilled:'✓',pending:'•',cancelled:'×'})[requestStatusClass] || '•';
        const requesterRef = personRef(r.requestedByEmail||'', r.requestedByRole||'stock_requester', r.requestedByName||'');
        const processorRef = r.actorEmail ? personRef(r.actorEmail, r.actorRole||'inventory_manager', r.actorName||'') : '';
        const detail = requestStatusClass==='fulfilled' && processorRef ? `Dispatched by: ${escapeHtml(processorRef)}` : `Requested by: ${escapeHtml(requesterRef)}`;
        return `<article class="history-row request-history-row request-event-${escapeHtml(requestStatusClass)}"><div class="history-icon">${requestStatusIcon}</div><div class="history-main"><strong>${escapeHtml(r.itemName||'Stock request')} <span class="history-status-pill ${escapeHtml(requestStatusClass)}">${escapeHtml(eventLabel(r))}</span></strong><span>${Number(r.quantity||0)} ${escapeHtml(r.unit||'')}${r.department?` · Department: ${escapeHtml(r.department)}`:''}</span><small>${detail} · ${escapeHtml(formatDate(r.createdAt))}${r.requestId?` · Request ${escapeHtml(r.requestId.slice(0,8))}`:''}</small></div></article>`;
      }
      const requested=r.requestId?' · Requested by: '+personRef(r.requestedByEmail||'', r.requestedByRole||'stock_requester', r.requestedByName||'') : '';
      const label=r.requestId?'Requested item dispatched':movementLabel(r.type);
      const movementClass = r.type==='receive' ? 'movement-receive' : r.type==='dispatch' ? 'movement-dispatch' : 'movement-opening';
      const movementIcon = r.type==='receive' ? '+' : r.type==='dispatch' ? '−' : '↗';
      const movementPill = r.type==='receive' ? 'RECEIVED' : r.type==='dispatch' ? (r.requestId ? 'DISPATCHED · REQUEST' : 'DISPATCHED') : 'OPENING';
      const canSeeAudit=canViewRevisionDetails(r);
      const auditText=r.deleted?' · DELETED':r.editedAt?' · EDITED':'';
      const auditButton=(canSeeAudit && (r.editCount||r.editedAt||r.deleted))?`<button class="small-action audit-view-btn" data-view-revisions="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">View changes${r.editCount?` (${escapeHtml(String(r.editCount))})`:''}</button>`:'';
      return `<article class="history-row movement-row ${movementClass} ${r.deleted?'movement-deleted':''}"><div class="history-icon">${movementIcon}</div><div class="history-main"><strong>${escapeHtml(r.itemName)} <span class="history-status-pill movement ${movementClass}">${movementPill}</span>${selectedRole==='transaction_manager'?`<span class="tm-origin-pill ${transactionOriginShort(r).toLowerCase()}">${transactionOriginLabel(r)}</span>`:''}${r.deleted?'<span class="history-audit-pill deleted">DELETED</span>':r.editedAt?'<span class="history-audit-pill edited">EDITED</span>':''}</strong><span>${escapeHtml(label)} ${r.quantity} ${escapeHtml(r.unit)}${r.department?` · Department: ${escapeHtml(r.department)}`:''}</span><small>${escapeHtml(personRef(r.byEmail||'', r.actorRole||r.byRole||'', r.byName||''))} · ${escapeHtml(formatDate(r.createdAt))}${requested}${r.note?' · '+escapeHtml(r.note):''}${canSeeAudit&&r.editedAt?' · Edited '+escapeHtml(formatDate(r.editedAt))+` by ${escapeHtml(personRef(r.editedByEmail||'', r.editedByRole||r.actorRole||'', r.editedByName||''))}`:''}${canSeeAudit&&r.deletedAt?' · Deleted '+escapeHtml(formatDate(r.deletedAt))+` by ${escapeHtml(personRef(r.deletedByEmail||'', r.deletedByRole||r.actorRole||'', r.deletedByName||''))}`:''}</small></div><div class="history-actions">${auditButton}${canEditMovementRow(r)&&!r.deleted?`<button class="small-action" data-edit-movement="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">Edit</button><button class="small-action reject" data-delete-movement="${escapeHtml(r.itemId)}:${escapeHtml(r.id)}" type="button">Delete</button>`:''}</div></article>`;
    }).join('')||`<div class="empty-team"><div class="empty-icon">🕘</div><strong>No matching log entries</strong><span>Try another date or filter.</span></div>`;
    attachHistoryActions();
  }

  root.innerHTML=`<div class="dashboard feature-page"><div class="topbar"><button class="back-btn" id="history-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="history-refresh">↻ Refresh</button></div>
    <section class="feature-header"><p class="eyebrow">Daily log book</p><h1>${adminMenuOnly?'History':'History · '+escapeHtml(roleLabel(selectedRole))}</h1><p>${adminMenuOnly?'Choose one history section. The selected section opens as its own clean workspace. Admin remains read-only.':selectedRole==='stock_requester'?'This workspace shows stock requests and the Inventory Manager fulfilments for your requests.':selectedRole==='inventory_manager'?'This workspace shows receiving, direct dispatch and dispatches made to fulfill stock requests.':selectedRole==='transaction_manager'?'This workspace shows the Inventory Manager live and finished daily transaction report day by day.':'This workspace shows Stock Requisitioner request activity and dispatched fulfilments.'}</p></section>
    ${adminMenuOnly?`<section class="history-admin-menu" id="history-admin-menu"><button class="history-account-card" data-history-role="inventory_manager" type="button"><span>📦</span><strong>Inventory Manager</strong><small>Receiving, dispatch & request fulfilment</small></button><button class="history-account-card" data-history-role="stock_requester" type="button"><span>📝</span><strong>Stock Requisitioner</strong><small>Requests, approvals & dispatched fulfilments</small></button><button class="history-account-card" data-history-role="transaction_manager" type="button"><span>🧾</span><strong>Transaction Manager</strong><small>Transaction control & daily statements</small></button></section>`:`<section class="history-workspace" id="history-workspace">
      ${isAdmin?`<div class="history-workspace-bar"><button type="button" class="back-btn" id="history-menu-back">‹ History</button><strong id="history-workspace-title">${escapeHtml(roleLabel(selectedRole))} History</strong></div>`:''}
      <section class="history-tools"><div><label for="history-day">Date</label><input id="history-day" type="date" value="${today}"></div><div><label for="history-type">Activity</label><select id="history-type"></select></div><div><label for="history-department">Department</label><select id="history-department"><option value="all">All departments</option>${departments.map(d=>`<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>${isAdmin||role==='inventory_manager'?`<button class="small-action csv-btn" id="share-day-csv" type="button">📊 Share day CSV</button>`:''}${selectedRole==='transaction_manager'?`<div class="tm-history-csv-actions"><button class="small-action csv-btn tm-download-csv" id="tm-history-download-csv" type="button">📥 Download CSV</button><button class="small-action csv-btn tm-share-csv" id="tm-history-share-csv" type="button">📤 Share CSV</button></div>`:''}<button class="small-action" id="history-today" type="button">Today</button></section>
      ${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}${selectedRole==='transaction_manager'?`<section class="admin-card tm-live-panel" id="history-live-panel"><div id="tm-live-report"></div></section>`:`<section class="admin-card" id="history-daily-panel"><div id="daily-statement" class="daily-statement" hidden></div><div id="history-list" class="history-list"></div></section>`}
    </section>`}</div>`;

  function setHistoryActivityOptions(){
    const select=root.querySelector('#history-type'); if(!select)return;
    const previous=select.value;
    let options=[];
    if(selectedRole==='inventory_manager'){
      options=[['all','All stock movement'],['received','Received items'],['dispatched','Dispatched items'],['requested-dispatch','Requested item dispatches']];
    }else if(selectedRole==='stock_requester'){
      options=[['all','All requests'],['request-pending','Pending'],['request-approved','Approved'],['request-rejected','Rejected'],['request-dispatched','Dispatched'],['request-cancelled','Cancelled']];
    }else if(selectedRole==='transaction_manager'){
      options=[['all','All transaction activity'],['received','Received items'],['dispatched','Dispatched items'],['requested-dispatch','Requested item dispatches']];
    }
    select.innerHTML=options.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');
    if(options.some(([value])=>value===previous))select.value=previous;
  }
  setHistoryActivityOptions();

  historyOpenLiveRequested = false;

  const buildList=()=>{
    if(selectedRole==='stock_requester') return combinedForRole('stock_requester');
    if(selectedRole==='inventory_manager') return combinedForRole('inventory_manager');
    if(selectedRole==='transaction_manager'){ const ledger=combinedForRole('inventory_manager'); const own=requestEvents.filter(e=>e.requestedByUid===auth.currentUser?.uid || e.requestedByRole==='transaction_manager').map(e=>({kind:'request',time:e.createdAt,...e})); return [...ledger,...own].sort((a,b)=>(b.time?.toMillis?.()||0)-(a.time?.toMillis?.()||0)); }
    return combinedForRole(role);
  };
  const refreshList=()=>{
    let list=buildList();
    if(isStockRequesterRole(role)) list=list.filter(r=>(r.kind==='request') || (r.kind==='movement'&&r.type==='dispatch'&&r.requestId));
    if(role==='inventory_manager') list=list.filter(r=>r.kind==='movement'&&(r.type==='receive'||r.type==='dispatch'));
    if(role==='transaction_manager') list=list.filter(r=>(r.kind==='movement'&&r.actorRole==='inventory_manager') || (r.kind==='request'&&r.requestedByUid===auth.currentUser?.uid));
    const selectedDay=root.querySelector('#history-day')?.value||today;
    renderRows(list,{day:selectedDay});
    if(selectedRole==='transaction_manager') {
      const activity=root.querySelector('#history-type')?.value||'all';
      const department=root.querySelector('#history-department')?.value||'all';
      renderTransactionManagerLiveReport(root,rows,selectedDay,{activity: activity==='received'?'receive':activity==='dispatched'?'dispatch':activity==='all'?'all':'all',department});
    }
  };
  const attachHistoryActions=()=>{
    root.querySelectorAll('[data-view-revisions]').forEach(btn=>btn.addEventListener('click',async()=>{const [itemId,movementId]=btn.dataset.viewRevisions.split(':');btn.disabled=true;try{let revisions=[];let revisionError='';try{revisions=await listMovementRevisions(itemId,movementId);}catch(err){revisionError=friendlyError(err);}const currentSnap=await getDoc(doc(db,'companies',currentCompanyId(),'items',itemId,'movements',movementId));openRevisionViewer(revisions,currentSnap.exists()?{id:movementId,...currentSnap.data(),revisionReadError:revisionError}:null);if(revisionError)showTemporaryMessage(revisionError,'error');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{btn.disabled=false;}}));
    root.querySelectorAll('[data-edit-movement]').forEach(btn=>btn.addEventListener('click',async()=>{const [itemId,movementId]=btn.dataset.editMovement.split(':');const row=rows.find(x=>x.itemId===itemId&&x.id===movementId);if(!row)return;const type=prompt('Movement type: opening, receive, or dispatch',row.type);if(type===null)return;const qty=prompt('Correct quantity',String(row.quantity));if(qty===null)return;const note=prompt('Correct note (optional)',row.note||'');if(note===null)return;btn.disabled=true;try{await editMovement(itemId,movementId,{type:type.trim().toLowerCase(),quantity:qty,note});showTemporaryMessage('History corrected and stock recalculated.','success');await renderHistory();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
    root.querySelectorAll('[data-delete-movement]').forEach(btn=>btn.addEventListener('click',async()=>{const [itemId,movementId]=btn.dataset.deleteMovement.split(':');if(!confirm('Delete this history entry and recalculate the item stock?'))return;btn.disabled=true;try{await deleteMovement(itemId,movementId);showTemporaryMessage('History entry deleted and stock recalculated.','success');await renderHistory();}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));
  };
  if(adminMenuOnly){
    root.querySelectorAll('[data-history-role]').forEach(btn=>btn.addEventListener('click',()=>renderHistory(btn.dataset.historyRole)));
    root.querySelector('#history-back').addEventListener('click',()=>navigateBack('home'));
    root.querySelector('#history-refresh').addEventListener('click',()=>renderHistory());
    return;
  }
  root.querySelector('#history-type')?.addEventListener('change',refreshList);
  root.querySelector('#history-department')?.addEventListener('change',refreshList);
  root.querySelector('#history-day')?.addEventListener('change',refreshList);
  root.querySelector('#history-today')?.addEventListener('click',()=>{root.querySelector('#history-day').value=today;refreshList();});
  // When Admin entered a history card, Back must return to the three-card
  // History menu, not jump all the way to Home. Other roles keep their normal
  // Home navigation.
  root.querySelector('#history-back').addEventListener('click',()=>isAdmin ? renderHistory() : navigateBack('home'));
  root.querySelector('#history-menu-back')?.addEventListener('click',()=>renderHistory());
  root.querySelector('#history-refresh').addEventListener('click',()=>renderHistory(selectedRole));
  root.querySelector('#share-day-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#share-day-csv');b.disabled=true;b.textContent='Preparing CSV…';try{const mode=await shareDailyHistoryCsv(root.querySelector('#history-day').value, rows);showTemporaryMessage(mode==='shared'?'Daily CSV ready to share.':'Daily CSV downloaded.','success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📊 Share day CSV';}});
  root.querySelector('#tm-history-download-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#tm-history-download-csv');b.disabled=true;b.textContent='Preparing…';try{const selectedDay=root.querySelector('#history-day')?.value||today;const selectedActivity=root.querySelector('#history-type')?.value||'all';const selectedDepartment=root.querySelector('#history-department')?.value||'all';const activity=selectedActivity==='received'?'receive':selectedActivity==='dispatched'?'dispatch':'all';const items=await listItems();downloadTransactionManagerDailyCsv(selectedDay,rows,items,activity,selectedDepartment);showTemporaryMessage('Transaction Manager CSV downloaded.','success');}catch(err){showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📥 Download CSV';}});
  root.querySelector('#tm-history-share-csv')?.addEventListener('click',async()=>{const b=root.querySelector('#tm-history-share-csv');b.disabled=true;b.textContent='Preparing…';try{const selectedDay=root.querySelector('#history-day')?.value||today;const selectedActivity=root.querySelector('#history-type')?.value||'all';const selectedDepartment=root.querySelector('#history-department')?.value||'all';const activity=selectedActivity==='received'?'receive':selectedActivity==='dispatched'?'dispatch':'all';const items=await listItems();const mode=await shareTransactionManagerDailyCsv(selectedDay,rows,items,activity,selectedDepartment);showTemporaryMessage(mode==='shared'?'Transaction Manager CSV ready to share.':'Transaction Manager CSV downloaded.','success');}catch(err){if(err?.name!=='AbortError')showTemporaryMessage(friendlyError(err),'error');}finally{b.disabled=false;b.textContent='📤 Share CSV';}});
  if(selectedRole) refreshList();
}

function quantitySummary(rows){
  const byUnit=new Map();
  rows.forEach(r=>{ const unit=String(r.unit||'unit').trim()||'unit'; const qty=Number(r.quantity||0); if(Number.isFinite(qty)) byUnit.set(unit,(byUnit.get(unit)||0)+qty); });
  const parts=[...byUnit.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  if(!parts.length) return {value:'0', detail:'No transactions recorded'};
  if(parts.length===1) return {value:`${formatQty(parts[0][1])} ${parts[0][0]}`, detail:'Total quantity'};
  return {value:formatQty(parts.reduce((a,[,q])=>a+q,0)), detail:`Mixed units · ${parts.map(([u,q])=>`${formatQty(q)} ${u}`).join(' · ')}`};
}

async function renderStats(){
  let items=[],rows=[],requests=[],error='';
  try{
    items=await listItems();
    rows=await listHistory();
    const statsStart=movementLiveStartDate().getTime();
    rows=rows.filter(r=>movementMillis(r)>=statsStart);
    requests=await listRequests();
    const statsStartDate=movementLiveStartDate().getTime();
    requests=requests.filter(r=>(r.updatedAt?.toMillis?.()||r.createdAt?.toMillis?.()||0)>=statsStartDate);
  }
  catch(err){error=friendlyError(err);}
  const role=membership?.role||'';
  const ownRequests = requests.filter(r=>r.requestedByUid===auth.currentUser?.uid || normalizedRole(r.requestedByRole)===normalizedRole(role));
  const activeRows=rows.filter(r=>r.deleted!==true && r.active!==false);
  const roleRows = role==='inventory_manager' ? activeRows.filter(r=>r.actorRole==='inventory_manager')
    : isStockRequesterRole(role) ? activeRows.filter(r=>isStockRequesterRole(r.actorRole) || (r.type==='dispatch' && r.requestedByUid===auth.currentUser?.uid))
    : role==='transaction_manager' ? activeRows.filter(r=>r.actorRole==='inventory_manager' || r.requestedByUid===auth.currentUser?.uid || r.requestedByRole==='transaction_manager')
    : activeRows;
  const visibleRequests = role==='admin' || role==='inventory_manager' ? requests : ownRequests;
  const received=roleRows.filter(r=>r.type==='receive');
  const dispatched=roleRows.filter(r=>r.type==='dispatch');
  const pendingReq=visibleRequests.filter(r=>r.status==='pending');
  const approvedReq=visibleRequests.filter(r=>r.status==='approved');
  const fulfilledReq=visibleRequests.filter(r=>r.status==='fulfilled');
  const rejectedReq=visibleRequests.filter(r=>r.status==='rejected');
  const lowItems=items.filter(i=>Number(i.quantity||0)<=Number(i.lowStockAlert||0));
  // Top 8 items by combined dispatch+receive activity, dispatched & received
  // shown side by side on one chart instead of two separate top-10 charts.
  const combinedTop8=items.map(i=>{
    const disp=dispatched.filter(r=>r.itemId===i.id).reduce((a,r)=>a+Number(r.quantity||0),0);
    const recv=received.filter(r=>r.itemId===i.id).reduce((a,r)=>a+Number(r.quantity||0),0);
    return {name:i.name,unit:i.unit,dispatched:disp,received:recv,total:disp+recv};
  }).filter(x=>x.total>0).sort((a,b)=>b.total-a.total).slice(0,8);
  const statusPie=[
    {label:'Good stock',value:items.filter(i=>Number(i.quantity||0)>Number(i.lowStockAlert||0)).length},
    {label:'Low stock',value:lowItems.length}
  ].filter(x=>x.value>0);
  // Stats are intentionally limited to the last 7 calendar days.
  // Build a simple daily receive/dispatch chart from the already-filtered rows.
  const dayMs=86400000;
  const startOfToday=(()=>{const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());})();
  const dayKey=(d)=>localDateKey(d);
  const sumForDay=(source,day)=>source.reduce((a,r)=>{const d=r.createdAt?.toDate?.()||new Date(r.createdAt||0);return dayKey(d)===day?a+Number(r.quantity||0):a;},0);
  const sevenDayLabels=[];
  const sevenDayReceived=[];
  const sevenDayDispatched=[];
  for(let i=6;i>=0;i--){
    const d=new Date(startOfToday.getTime()-i*dayMs);
    const key=dayKey(d);
    sevenDayLabels.push(i===0?'Today':d.toLocaleDateString(undefined,{weekday:'short',day:'numeric'}));
    sevenDayReceived.push(sumForDay(received,key));
    sevenDayDispatched.push(sumForDay(dispatched,key));
  }
  const receivedSummary=quantitySummary(received);
  const dispatchedSummary=quantitySummary(dispatched);
  const roleTitle=role==='admin'?'Company-wide':roleLabel(role);
  const roleDesc={admin:'Company-wide inventory and transaction insights.',inventory_manager:'Your receiving, dispatch and request-workflow insights.',transaction_manager:'Inventory Manager transactions plus your own request activity.',stock_requester:'Your stock requests and fulfilled-dispatch activity.',chef:'Your stock requests and fulfilled-dispatch activity.',request:'Your stock requests and fulfilled-dispatch activity.'}[role]||'Your inventory activity and insights.';
  root.innerHTML=`<div class="dashboard feature-page stats-page"><div class="topbar"><button class="back-btn" id="stats-back">‹ Back</button><div class="topbar-brand">Inventro</div><button class="refresh-btn" id="stats-refresh">↻ Refresh</button></div><section class="feature-header"><p class="eyebrow">Inventory insights · ${escapeHtml(roleTitle)}</p><h1>Stats</h1><p>${escapeHtml(roleDesc)} Activity cards and transaction charts use the last 7 days.</p></section>${error?`<div class="error-box">${escapeHtml(error)}</div>`:''}
  <div class="stat-grid stats-summary">
    <div class="stat-card"><strong>${items.length}</strong><span>Total items</span></div>
    <div class="stat-card"><strong>${received.length}</strong><span>Receive transactions</span></div>
    <div class="stat-card"><strong>${dispatched.length}</strong><span>Dispatch transactions</span></div>
    <div class="stat-card"><strong>${receivedSummary.value}</strong><span>Received quantity</span><small>${escapeHtml(receivedSummary.detail)}</small></div>
    <div class="stat-card"><strong>${dispatchedSummary.value}</strong><span>Dispatched quantity</span><small>${escapeHtml(dispatchedSummary.detail)}</small></div>
    <div class="stat-card ${lowItems.length?'danger':''}"><strong>${lowItems.length}</strong><span>Low-stock items</span></div>
    <div class="stat-card ${pendingReq.length?'warning':''}"><strong>${pendingReq.length}</strong><span>Pending requests</span></div>
    <div class="stat-card"><strong>${approvedReq.length}</strong><span>Approved requests</span></div>
    <div class="stat-card"><strong>${fulfilledReq.length}</strong><span>Dispatched requests</span></div>
    <div class="stat-card ${rejectedReq.length?'danger':''}"><strong>${rejectedReq.length}</strong><span>Rejected requests</span></div>
  </div>
  <section class="admin-card"><div class="admin-card-title"><div><h2>Key performance charts</h2><p>Charts are filtered to the signed-in role where applicable.</p></div></div>
    <div class="chart-grid stats-chart-grid">
      <div class="chart-card"><h3>📊 Top 8 items · dispatched vs received</h3><canvas id="stats-top8"></canvas></div>
      <div class="chart-card"><h3>🥧 Current stock health</h3><canvas id="stats-stock-health"></canvas></div>
      <div class="chart-card"><h3>📈 Last 7 days</h3><canvas id="stats-week-compare"></canvas></div>
    </div>
  </section></div>`;
  if(!window.Chart){await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';sc.onload=resolve;sc.onerror=reject;document.head.appendChild(sc);}).catch(()=>{});}
  if(window.Chart){
    const top8Canvas=root.querySelector('#stats-top8');
    if(top8Canvas) new Chart(top8Canvas,{type:'bar',data:{labels:combinedTop8.map(x=>x.name),datasets:[{label:'Dispatched',data:combinedTop8.map(x=>x.dispatched)},{label:'Received',data:combinedTop8.map(x=>x.received)}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}},scales:{x:{beginAtZero:true}}}});
    new Chart(root.querySelector('#stats-stock-health'),{type:'doughnut',data:{labels:statusPie.map(x=>x.label),datasets:[{data:statusPie.map(x=>x.value)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}});
    new Chart(root.querySelector('#stats-week-compare'),{type:'bar',data:{labels:sevenDayLabels,datasets:[{label:'Received',data:sevenDayReceived},{label:'Dispatched',data:sevenDayDispatched}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true}}}});
  }
  root.querySelector('#stats-back').addEventListener('click',()=>navigateBack('home'));root.querySelector('#stats-refresh').addEventListener('click',()=>renderStats());
}

function closeInventoryEditModal(){ document.querySelector('#inventory-edit-modal')?.remove(); }
function openInventoryEditModal(item,onSave){
  closeInventoryEditModal();
  const overlay=document.createElement('div'); overlay.id='inventory-edit-modal'; overlay.className='modal-overlay inventory-edit-overlay';
  overlay.innerHTML=`<div class="inventory-edit-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-edit-title">
    <div class="inventory-edit-header"><div><p class="eyebrow">Inventory setup</p><h2 id="inventory-edit-title">Edit inventory item</h2><p>Update the saved item just like adding a new item. Current stock will not change.</p></div><button type="button" class="modal-close" id="inventory-edit-close" aria-label="Close">×</button></div>
    <div class="inventory-edit-body">
      <div class="field"><label for="inventory-edit-name">Item name</label><input id="inventory-edit-name" type="text" maxlength="80" value="${escapeHtml(item.name||'')}" placeholder="e.g. Basmati Rice"></div>
      <div class="field"><label for="inventory-edit-unit">Unit</label><select id="inventory-edit-unit">${INVENTORY_UNITS.map(u=>`<option value="${escapeHtml(u)}" ${u===item.unit?'selected':''}>${escapeHtml(u)}</option>`).join('')}</select></div>
      <div class="two-fields"><div class="field"><label>Current stock</label><input type="text" value="${escapeHtml(String(item.quantity??0)+' '+(item.unit||''))}" disabled></div><div class="field"><label for="inventory-edit-low">Low stock alert</label><input id="inventory-edit-low" type="number" min="0" step="0.01" value="${escapeHtml(String(item.lowStockAlert??0))}"></div></div>
      <div class="inventory-edit-photo-card"><div class="inventory-edit-photo" id="inventory-edit-photo"><span>🖼️</span></div><div class="inventory-edit-photo-copy"><strong>Automatic item photo</strong><span id="inventory-edit-photo-status">${item.imageUrl?'Current photo will be replaced automatically if you change the item name.':'Inventro will find an image when the item name changes.'}</span></div></div>
      <div id="inventory-edit-message"></div>
    </div>
    <div class="inventory-edit-footer"><button type="button" class="btn btn-secondary" id="inventory-edit-cancel">Cancel</button><button type="button" class="btn btn-primary" id="inventory-edit-save">Save changes</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const nameInput=overlay.querySelector('#inventory-edit-name'), photo=overlay.querySelector('#inventory-edit-photo'), status=overlay.querySelector('#inventory-edit-photo-status');
  let selectedImage={url:item.imageUrl||'',source:item.imageSource||''}, timer=null, lookupToken=0;
  function showImage(url){ photo.innerHTML=url?`<img src="${escapeHtml(url)}" alt="Item preview" onerror="this.style.display='none'">`:'<span>🖼️</span>'; }
  showImage(selectedImage.url);
  async function refreshImageForName(){
    const name=nameInput.value.trim(); if(name.length<2){selectedImage={url:item.imageUrl||'',source:item.imageSource||''};showImage(selectedImage.url);status.textContent='Enter an item name to find its photo.';return;}
    const token=++lookupToken; status.innerHTML='<span class="spinner spinner-dark"></span> Finding a new photo…'; photo.innerHTML='<span class="image-search-spinner"></span>';
    try{ const found=await fetchItemImage(name); if(token!==lookupToken)return; selectedImage={url:found?.url||'',source:found?.source||''}; if(!selectedImage.url){selectedImage={url:item.imageUrl||'',source:item.imageSource||''};} showImage(selectedImage.url); status.textContent=selectedImage.url?'Photo updated for this item name.':'No suitable photo found; the current photo was kept.'; }
    catch(_){ if(token===lookupToken){selectedImage={url:item.imageUrl||'',source:item.imageSource||''};showImage(selectedImage.url);status.textContent='Could not find a new photo; the current photo was kept.';} }
  }
  nameInput.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refreshImageForName,500);});
  overlay.querySelector('#inventory-edit-close').addEventListener('click',closeInventoryEditModal); overlay.querySelector('#inventory-edit-cancel').addEventListener('click',closeInventoryEditModal); overlay.addEventListener('click',e=>{if(e.target===overlay)closeInventoryEditModal();});
  overlay.querySelector('#inventory-edit-save').addEventListener('click',()=>onSave({name:nameInput.value,unit:overlay.querySelector('#inventory-edit-unit').value,lowStockAlert:overlay.querySelector('#inventory-edit-low').value,imageUrl:selectedImage.url,imageSource:selectedImage.source},overlay));
  nameInput.focus(); nameInput.select();
}

async function renderAdmin() {
  const user = auth.currentUser;
  let companyCode = '';
  try { companyCode = (await getDoc(doc(db,'companies',currentCompanyId()))).data()?.code || ''; } catch(_) {}
  if (!membership || membership.role !== 'admin') {
    navigate('home');
    return;
  }

  let employees = [];
  let departments = [];
  let adminItems = [];
  let error = '';
  let loading = true;
  let activeTab = null;

  function draw(tab = activeTab) {
    activeTab = tab;
    if (!activeTab) {
      root.innerHTML = `<div class="dashboard admin-page admin-menu-only"><div class="topbar"><button class="back-btn" id="admin-back">‹ Back to workspace</button><div class="topbar-brand">Inventro</div><div class="user-pill"><div class="avatar">${escapeHtml((user?.displayName?.[0] || 'A').toUpperCase())}</div><div class="user-email">${escapeHtml(user?.email || '')}</div></div></div><section class="admin-header"><p class="eyebrow">Administration</p><h1>Admin Center</h1><p>Choose one area to manage. Each section opens on its own clean workspace.</p></section><div class="admin-menu-grid"><button class="admin-menu-card" data-admin-tab="team"><span>👥</span><strong>Team Management</strong><small>Employees, roles & access days</small></button><button class="admin-menu-card" data-admin-tab="inventory"><span>📦</span><strong>Inventory Setup</strong><small>Add, edit and configure goods</small></button><button class="admin-menu-card" data-admin-tab="departments"><span>🏢</span><strong>Departments</strong><small>Manage departments used by the kitchen</small></button><button class="admin-menu-card" data-admin-tab="company"><span>⚙️</span><strong>Company Controls</strong><small>Company information and access code</small></button></div></div>`;
      root.querySelector('#admin-back').addEventListener('click',()=>navigateBack('home'));
      root.querySelectorAll('[data-admin-tab]').forEach(btn=>btn.addEventListener('click',()=>draw(btn.dataset.adminTab)));
      return;
    }
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
          .company-control-actions{margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
          .company-control-actions .helper-text{margin:8px 0 0}
          .btn-danger{background:#b91c1c;color:#fff;border:1px solid #991b1b}
          .btn-danger:hover{background:#991c1c}
          .admin-info-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
          .admin-info-box{padding:13px;border:1px solid var(--border);border-radius:11px;background:var(--surface-soft)}
          .admin-info-box span{display:block;color:var(--text-muted);font-size:10px;margin-bottom:4px}.admin-info-box strong{font-size:13px;word-break:break-word}
          @media(max-width:650px){.admin-nav{grid-template-columns:1fr}.admin-info-grid{grid-template-columns:1fr}.user-email{max-width:140px;overflow:hidden;text-overflow:ellipsis}}
        </style>

        <div class="admin-workspace-bar"><button type="button" class="back-btn" id="admin-menu-back">‹ Admin Center</button><strong>${activeTab === 'team' ? 'Team Management' : activeTab === 'inventory' ? 'Inventory Setup' : activeTab === 'departments' ? 'Departments' : 'Company Controls'}</strong></div>

        <div class="admin-panel ${activeTab === 'team' ? 'active' : ''}" data-admin-panel="team">
          <div class="admin-section-label">Team management</div>
          <section class="admin-card">
            <div class="admin-card-title">
              <div><h2>Add employee</h2><p>The employee must use this exact Google email and your company's 6-digit code to join.</p></div>
            </div>
            <div class="field"><label for="employee-email">Employee Gmail</label><input type="text" id="employee-email" placeholder="employee@gmail.com" autocomplete="off" /></div>
            <div class="field"><label for="employee-role">Role</label><select id="employee-role"><option value="inventory_manager">Inventory Manager</option><option value="transaction_manager">Transaction Manager</option><option value="stock_requester">Stock Requisitioner</option></select></div>
            <div class="field"><label>Login access days</label><div class="day-grid">${WEEK_DAYS.map(([key, label]) => `<label class="day-option"><input type="checkbox" value="${key}" checked /><span>${label.slice(0, 3)}</span></label>`).join('')}</div><p class="helper-text">On an unchecked day, this employee will not be allowed to enter the company workspace.</p></div>
            ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ''}
            <button class="btn btn-primary" id="add-employee-btn" ${loading ? 'disabled' : ''}>${loading ? '<span class="spinner spinner-dark"></span> Loading team…' : 'Add employee'}</button>
          </section>

          <section class="admin-card">
            <div class="admin-card-title"><div><h2>Team members</h2><p>${employees.length} employee${employees.length === 1 ? '' : 's'} in this company.</p></div><button class="refresh-btn" id="refresh-team" type="button">↻ Refresh</button></div>
            <div class="team-list">
              ${employees.length === 0 ? `<div class="empty-team"><div class="empty-icon">👥</div><strong>No employees added yet</strong><span>Add your first employee above.</span></div>` : employees.map((employee) => `
                <div class="employee-row" data-email="${escapeHtml(employee.email)}">
                  <div class="employee-main"><div class="employee-avatar">${escapeHtml((employee.email?.[0] || 'E').toUpperCase())}</div><div><strong>${escapeHtml(employee.displayName || shortDisplayName(employee.email))}</strong><span><b>${escapeHtml(shortPersonId(employee.email,employee.role))}</b> · <em>${escapeHtml(employee.email)}</em> · ${escapeHtml(roleLabel(employee.role))} · ${employee.status === 'active' ? 'Active' : 'Invited'}</span></div></div>
                  <div class="employee-controls">
                    <select class="employee-role"><option value="inventory_manager" ${employee.role === 'inventory_manager' ? 'selected' : ''}>Inventory Manager</option><option value="transaction_manager" ${employee.role === 'transaction_manager' ? 'selected' : ''}>Transaction Manager</option><option value="stock_requester" ${isStockRequesterRole(employee.role) ? 'selected' : ''}>Stock Requisitioner</option></select>
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
          <section class="admin-card"><div class="admin-card-title"><div><h2>Inventory permissions</h2><p>Item creation is restricted to this Admin section. Inventory Manager can operate stock without adding new item definitions.</p></div></div><div class="admin-info-grid"><div class="admin-info-box"><span>Item creation</span><strong>Admin only</strong></div><div class="admin-info-box"><span>Stock operations</span><strong>Admin + Inventory Manager</strong></div></div></section><section class="admin-card"><div class="admin-card-title"><div><h2>✏️ Edit saved inventory</h2><p>Change the saved item name, unit or low-stock threshold. Current stock is not changed here.</p></div></div><div class="admin-item-search-wrap"><span>⌕</span><input id="admin-item-search" type="search" placeholder="Search saved goods by name…" autocomplete="off"></div><div id="admin-edit-items" class="admin-edit-items"></div></section>
        </div>

        <div class="admin-panel ${activeTab === 'departments' ? 'active' : ''}" data-admin-panel="departments">
          <div class="admin-section-label">Department setup</div>
          <section class="admin-card">
            <div class="admin-card-title"><div><h2>🏢 Add department</h2><p>Departments appear in Inventory Manager dispatch and Stock Requisitioner requests.</p></div></div>
            <div class="field"><label for="department-name">Department name</label><input id="department-name" type="text" maxlength="60" placeholder="e.g. Main Kitchen"></div>
            <button class="btn btn-primary" id="add-department-btn" type="button">Add department</button>
          </section>
          <section class="admin-card"><div class="admin-card-title"><div><h2>Departments</h2><p>${departments.length} department${departments.length===1?'':'s'} configured.</p></div></div><div class="department-list">${departments.length?departments.map(d=>`<div class="department-row"><div><strong>${escapeHtml(d.name)}</strong><span>Available for dispatch, requests and history filters</span></div><button class="small-action reject" data-delete-department="${escapeHtml(d.id)}" type="button">Delete</button></div>`).join(''):`<div class="empty-team"><div class="empty-icon">🏢</div><strong>No departments yet</strong><span>Add at least one department before staff can dispatch/request stock for it.</span></div>`}</div></section>
        </div>

        <div class="admin-panel ${activeTab === 'company' ? 'active' : ''}" data-admin-panel="company">
          <div class="admin-section-label">Company controls</div>
          <section class="admin-card">
            <div class="admin-card-title"><div><h2>Company information</h2><p>Company identity and secure access details.</p></div></div>
            <div class="admin-info-grid"><div class="admin-info-box"><span>Company</span><strong>${escapeHtml(membership?.companyName || '—')}</strong></div><div class="admin-info-box"><span>Your role</span><strong>Admin</strong></div><div class="admin-info-box"><span>Admin email</span><strong>${escapeHtml(user?.email || '—')}</strong></div><div class="admin-info-box"><span>Company ID</span><strong>${escapeHtml(membership?.companyId || '—')}</strong></div></div>
            <div class="company-code-box"><div><span>6-digit company code</span><strong id="company-code-display">••••••</strong></div><button class="small-action" id="toggle-company-code" type="button" aria-label="Show company code">👁</button></div>
            <div class="company-control-actions">
              <button class="btn btn-secondary" id="change-company-code-btn" type="button">🔄 Change company code</button>
              <p class="helper-text">Changing the code signs every employee out. They must sign in again and enter the new 6-digit code.</p>
            </div>
          </section>
          <section class="admin-card admin-danger-card">
            <div class="admin-card-title"><div><h2>Danger zone</h2><p>Delete the entire company and its stored inventory, transactions, requests and team membership records.</p></div></div>
            <button class="btn btn-danger" id="delete-company-admin-btn" type="button">Delete company</button>
          </section>
        </div>
      </div>`;

    root.querySelector('#admin-back').addEventListener('click', () => navigateBack('home'));
    root.querySelector('#admin-menu-back')?.addEventListener('click', () => draw(null));
    root.querySelector('#toggle-company-code')?.addEventListener('click',()=>{const el=root.querySelector('#company-code-display');const b=root.querySelector('#toggle-company-code');const shown=el.dataset.shown==='1';el.textContent=shown?'••••••':(companyCode||'Not available');el.dataset.shown=shown?'0':'1';b.textContent=shown?'👁':'🙈';});
    root.querySelector('#change-company-code-btn')?.addEventListener('click', async () => {
      if (!confirm('Change the company code? All employees will be signed out and must sign in again with the new code.')) return;
      const b = root.querySelector('#change-company-code-btn');
      b.disabled = true; b.innerHTML = '<span class="spinner spinner-dark"></span> Changing code…';
      try {
        const newCode = await rotateCompanyCode();
        showTemporaryMessage(`Company code changed to ${newCode}. You are being signed out now.`, 'success');
        clearEmployeeCodeVerification();
        await signOut();
      } catch (err) {
        showTemporaryMessage(friendlyError(err), 'error');
        b.disabled = false; b.textContent = '🔄 Change company code';
      }
    });
    root.querySelector('#delete-company-admin-btn')?.addEventListener('click', async () => {
      const ok = confirm('Delete this company permanently? This removes the company, employees, inventory, movements, requests and company code. This cannot be undone.');
      if (!ok) return;
      const b = root.querySelector('#delete-company-admin-btn'); b.disabled = true; b.textContent = 'Deleting company…';
      try { await deleteCompanyCompletely(); clearEmployeeCodeVerification(); await signOut(); } catch (err) { showTemporaryMessage(friendlyError(err), 'error'); b.disabled = false; b.textContent = 'Delete company'; }
    });

    root.querySelectorAll('[data-admin-tab]').forEach((btn) => btn.addEventListener('click', () => draw(btn.dataset.adminTab)));
    root.querySelector('#add-department-btn')?.addEventListener('click', async () => { const b=root.querySelector('#add-department-btn'); b.disabled=true; try{await createDepartment(root.querySelector('#department-name').value); showTemporaryMessage('Department added.','success'); departments=await listDepartments(); draw('departments');}catch(err){showTemporaryMessage(friendlyError(err),'error');b.disabled=false;} });
    root.querySelectorAll('[data-delete-department]').forEach(btn=>btn.addEventListener('click',async()=>{if(!confirm('Delete this department? Existing history will remain, but it will no longer be available for new dispatches or requests.'))return;btn.disabled=true;try{await deleteDepartment(btn.dataset.deleteDepartment);showTemporaryMessage('Department deleted.','success');departments=await listDepartments();draw('departments');}catch(err){showTemporaryMessage(friendlyError(err),'error');btn.disabled=false;}}));

    const editItemsBox=root.querySelector('#admin-edit-items');
    const adminItemSearch=root.querySelector('#admin-item-search');
    function renderAdminEditItems(query=''){
      if(!editItemsBox)return;
      const q=String(query||'').trim().toLowerCase();
      const filtered=adminItems.filter(i=>!q||String(i.name||'').toLowerCase().includes(q));
      editItemsBox.innerHTML=filtered.map(i=>`<div class="admin-edit-row" data-item-id="${escapeHtml(i.id)}"><div><strong>${escapeHtml(i.name)}</strong><small>Current stock: ${i.quantity} ${escapeHtml(i.unit)}</small></div><div class="admin-item-row-actions"><button class="small-action" type="button" data-edit-item="${escapeHtml(i.id)}">Edit</button><button class="small-action danger-action" type="button" data-delete-item="${escapeHtml(i.id)}">Delete</button></div></div>`).join('')||`<div class="empty-team"><div class="empty-icon">🔎</div><strong>${q?'No matching goods':'No inventory items yet.'}</strong><span>${q?'Try another item name.':'Add an inventory item first.'}</span></div>`;
      root.querySelectorAll('[data-edit-item]').forEach(btn=>btn.addEventListener('click',()=>{
        const item=adminItems.find(x=>x.id===btn.dataset.editItem); if(!item)return;
        openInventoryEditModal(item, async (values, modal)=>{
          const save=modal.querySelector('#inventory-edit-save'); save.disabled=true; save.innerHTML='<span class=\"spinner\"></span> Saving…';
          try{ await updateInventoryItem(item.id,values); closeInventoryEditModal(); showTemporaryMessage('Inventory item updated successfully.','success'); adminItems=await listItems(); draw('inventory'); }
          catch(e){ showTemporaryMessage(friendlyError(e),'error'); save.disabled=false; save.textContent='Save changes'; }
        });
      }));
    }
    renderAdminEditItems();
    adminItemSearch?.addEventListener('input',()=>renderAdminEditItems(adminItemSearch.value));

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
    try { employees = await listEmployees(); departments = await listDepartments(); adminItems = await listItems(); }
    catch (err) { error = friendlyError(err); }
    finally { loading = false; draw(activeTab); }
  }

  await loadEmployees();
}

// ---------------- router ----------------
let view = 'loading', membership = null, justCreatedCode = null, returnToJoinAfterSignOut = false;

function render() {
  if (auth.currentUser && membership && isMobileDevice() && !['welcome','loading','employeeCode'].includes(view) && !pinUnlocked()) { showPinGate(); return; }
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
      root.innerHTML = `<div class="loading-screen"><div class="loading-orbit"><span></span><span></span><span></span></div><div class="loading-brand">Inventro</div><h2>Loading your workspace</h2><p>Please wait while your inventory and company data are being prepared.</p></div>`;
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
  if (membership) {
    await syncMyEmployeeProfile();
    try {
      const companySnap = await getDoc(doc(db,'companies',membership.companyId));
      const company = companySnap.exists() ? companySnap.data() : null;
      if (company) {
        const version = String(company.companyCodeVersion || 'legacy');
        const key = `inventroCompanyCodeVersion:${membership.companyId}`;
        const previous = localStorage.getItem(key);
        if (previous && previous !== version) {
          localStorage.setItem(key, version);
          clearEmployeeCodeVerification();
          membership = null;
          await signOut();
          return;
        }
        localStorage.setItem(key, version);
      }
    } catch (e) { console.warn('Company code version check:', e); }
    startRequestBadgeListener(); startRealtimeSync();
  }

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
