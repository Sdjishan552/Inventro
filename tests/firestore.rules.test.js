import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc } from 'firebase/firestore';

const projectId = 'inventro-security-test';
const rules = fs.readFileSync('firestore.rules', 'utf8');
let env;

const companyA = 'companyA';
const companyB = 'companyB';
const adminUid = 'adminA';
const invUid = 'invA';
const reqUid = 'reqA';
const otherInvUid = 'invB';
const adminEmail = 'admin@example.com';
const invEmail = 'inventory@example.com';
const reqEmail = 'request@example.com';
const otherInvEmail = 'other-inventory@example.com';

function ctx(uid, email) {
  return env.authenticatedContext(uid, { email });
}

function path(...parts) { return parts.join('/'); }

async function seed() {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const writes = [
      [path('companies', companyA), { ownerUid: adminUid, ownerEmail: adminEmail, name: 'A' }],
      [path('companies', companyB), { ownerUid: 'adminB', ownerEmail: 'adminb@example.com', name: 'B' }],
      [path('companies', companyA, 'employees', adminEmail), { uid: adminUid, email: adminEmail, role: 'admin', status: 'active' }],
      [path('companies', companyA, 'employees', invEmail), { uid: invUid, email: invEmail, role: 'inventory_manager', status: 'active' }],
      [path('companies', companyA, 'employees', reqEmail), { uid: reqUid, email: reqEmail, role: 'stock_requester', status: 'active' }],
      [path('companies', companyA, 'employees', otherInvEmail), { uid: otherInvUid, email: otherInvEmail, role: 'inventory_manager', status: 'active' }],
      [path('companies', companyB, 'employees', 'adminb@example.com'), { uid: 'adminB', email: 'adminb@example.com', role: 'admin', status: 'active' }],
      [path('companies', companyA, 'items', 'rice'), { name: 'Rice', unit: 'kg', quantity: 10, lowStockAlert: 2, updatedBy: adminUid }],
      [path('companies', companyA, 'items', 'rice', 'movements', 'm1'), {
        type: 'receive', quantity: 10, unit: 'kg', itemName: 'Rice', note: 'Initial',
        byUid: invUid, byEmail: invEmail, byRole: 'inventory_manager', byName: 'Inventory', createdAt: { seconds: 1, nanoseconds: 0 },
        editCount: 0, deleted: false, active: true
      }]
    ];
    for (const [p, data] of writes) await setDoc(doc(db, p), data);
  });
}

describe('Inventro Firestore Security Rules', function () {
  before(async () => {
    env = await initializeTestEnvironment({ projectId, firestore: { rules } });
    await seed();
  });

  after(async () => { await env.cleanup(); });

  it('denies unauthenticated company reads', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, path('companies', companyA))));
  });

  it('prevents cross-company item reads', async () => {
    const db = ctx(adminUid, adminEmail).firestore();
    await assertFails(getDoc(doc(db, path('companies', companyB, 'employees', 'adminb@example.com'))));
  });

  it('allows an Inventory Manager to edit their own movement', async () => {
    const db = ctx(invUid, invEmail).firestore();
    await assertSucceeds(updateDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'm1')), {
      quantity: 8,
      note: 'Corrected',
      editedByUid: invUid,
      editedByEmail: invEmail,
      editCount: 1,
      deleted: false,
      active: true,
      editedAt: new Date()
    }));
  });

  it('blocks changing movement ownership/audit identity', async () => {
    const db = ctx(invUid, invEmail).firestore();
    await assertFails(updateDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'm1')), {
      byUid: otherInvUid,
      editedByUid: invUid,
      editedByEmail: invEmail,
      editCount: 2,
      deleted: false,
      active: true,
      editedAt: new Date()
    }));
  });

  it('blocks rewriting byRole on an existing movement (audit-identity spoofing)', async () => {
    const db = ctx(invUid, invEmail).firestore();
    await assertFails(updateDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'm1')), {
      byRole: 'admin',
      editedByUid: invUid,
      editedByEmail: invEmail,
      editCount: 2,
      deleted: false,
      active: true,
      editedAt: new Date()
    }));
  });

  it('blocks another Inventory Manager from editing someone else\'s movement', async () => {
    const db = ctx(otherInvUid, otherInvEmail).firestore();
    await assertFails(updateDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'm1')), {
      quantity: 7,
      editedByUid: otherInvUid,
      editedByEmail: otherInvEmail,
      editCount: 2,
      deleted: false,
      active: true,
      editedAt: new Date()
    }));
  });

  it('allows Admin to create a correctly attributed initial receipt', async () => {
    const db = ctx(adminUid, adminEmail).firestore();
    await assertSucceeds(setDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'admin-initial')), {
      type: 'receive', quantity: 50, unit: 'kg', itemName: 'Rice', note: 'Initial inventory received by Admin',
      byUid: adminUid, byEmail: adminEmail, byRole: 'admin', byName: 'Admin', createdAt: new Date(),
      openingStock: 50, isInitialReceipt: true, source: 'admin_item_creation'
    }));
  });

  it('blocks role spoofing on movement creation', async () => {
    const db = ctx(invUid, invEmail).firestore();
    await assertFails(setDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'spoof')), {
      type: 'receive', quantity: 1, unit: 'kg', itemName: 'Rice', byUid: invUid, byEmail: invEmail,
      byRole: 'admin', byName: 'Inventory', createdAt: new Date()
    }));
  });

  it('blocks Stock Requester from creating a direct movement', async () => {
    const db = ctx(reqUid, reqEmail).firestore();
    await assertFails(setDoc(doc(db, path('companies', companyA, 'items', 'rice', 'movements', 'request-direct')), {
      type: 'dispatch', quantity: 1, unit: 'kg', itemName: 'Rice', byUid: reqUid, byEmail: reqEmail,
      byRole: 'stock_requester', byName: 'Requester', createdAt: new Date()
    }));
  });
});
