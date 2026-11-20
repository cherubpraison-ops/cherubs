// Cherub's OS notifier — run by GitHub Actions every 15 minutes (free).
// Reads each user's private data with a service account and sends push notifications:
//   • the daily session check-in (at the user's chosen time, default 19:00 India time)
//   • Sunday: collect next week's advance
//   • last day of the month: collect next month's fee
//   • the user's own reminders, when they fall due
const admin = require('firebase-admin');

const APP_URL = 'https://cherubpraison-ops.github.io/cherubs/';
const TZ_OFFSET_MIN = 330; // India (UTC+05:30)

const sa = JSON.parse(process.env.FIREBASE_SA || '{}');
if (!sa.project_id) { console.log('FIREBASE_SA secret is not set yet — nothing to do.'); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const pad = n => String(n).padStart(2, '0');
function nowLocal() {
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const date = d.toISOString().slice(0, 10), hm = d.toISOString().slice(11, 16);
  return { date, hm, stamp: date + 'T' + hm, dow: d.getUTCDay() };
}
const parseD = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ymd = d => d.toISOString().slice(0, 10);
const lastDay = date => { const d = parseD(date); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
const minusMinutes = (stamp, m) => { const d = new Date(Date.parse(stamp + ':00Z') - m * 60000); return d.toISOString().slice(0, 16); };

function scheduledOn(c, d) {
  if (c.active === false) return false;
  if (c.start && d < c.start) return false;
  if (c.sched === 'alt') {
    const base = c.altStart || c.start; if (!base) return false;
    const diff = Math.round((parseD(d) - parseD(base)) / 864e5);
    return diff >= 0 && diff % 2 === 0;
  }
  return (c.days || []).map(Number).includes(parseD(d).getUTCDay());
}
const addDays = (s, k) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + k); return ymd(d); };
const first = n => String(n || '').split(' ')[0];
function sessionsFor(items, d) {
  const clients = items.filter(i => i.kind === 'client').sort((a, b) => ((a.order ?? 1e12) - (b.order ?? 1e12)));
  const sess = new Map(items.filter(i => i.kind === 'session').map(s => [s.id, s]));
  const out = [];
  for (const c of clients) {
    const id = 'r_' + c.id + '_' + d, s = sess.get(id);
    if (scheduledOn(c, d) || (s && s.status)) out.push({ name: c.name, cid: c.id, sid: id, date: d, monthly: c.pay === 'monthly', status: (s && s.status) || 'pending' });
  }
  for (const s of sess.values()) {
    if (s.extra && s.date === d) { const c = clients.find(x => x.id === s.clientId); if (c) out.push({ name: c.name, cid: c.id, sid: s.id, date: d, monthly: c.pay === 'monthly', status: s.status || 'pending' }); }
  }
  return out.filter(x => x.status !== 'moved');
}
function pendingToday(items, d) {
  const clients = items.filter(i => i.kind === 'client');
  const sess = new Map(items.filter(i => i.kind === 'session').map(s => [s.id, s]));
  const out = [];
  for (const c of clients) {
    if (!scheduledOn(c, d)) continue;
    const s = sess.get('r_' + c.id + '_' + d);
    if (!s || !s.status || s.status === 'pending') out.push(c.name);
  }
  for (const s of sess.values()) {
    if (s.extra && s.date === d && s.status === 'pending') { const c = clients.find(x => x.id === s.clientId); if (c) out.push(c.name); }
  }
  return out;
}

async function sendTo(tokensRef, tokens, title, body, extra) {
  if (!tokens.length) return;
  const x = extra || {};
  const notification = { title, body, icon: APP_URL + 'icon-192.png', badge: APP_URL + 'icon-192.png' };
  if (x.tag) notification.tag = x.tag;
  if (x.actions) { notification.actions = x.actions; notification.requireInteraction = true; }
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    webpush: { notification, data: x.data || {}, fcmOptions: { link: APP_URL + (x.hash || '') } }
  });
  // Forget devices that no longer accept notifications.
  await Promise.all(res.responses.map((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      return tokensRef.where('token', '==', tokens[i]).get().then(q => Promise.all(q.docs.map(d => d.ref.delete())));
    }
  }));
  console.log(`sent "${title}" to ${res.successCount}/${tokens.length} device(s)`);
}

async function runForUser(userRef) {
  const devRef = userRef.collection('devices');
  const devs = await devRef.get();
  const tokens = devs.docs.map(d => d.data().token).filter(Boolean);
  if (!tokens.length) return;

  const items = (await userRef.collection('items').get()).docs.map(d => ({ ...d.data(), id: d.id }));
  const prefs = items.find(i => i.kind === 'prefs') || {};
  const checkin = prefs.checkin || '19:00';
  const names = prefs.notifNames !== false;
  const preview = prefs.preview || '21:00';
  const metaRef = userRef.collection('meta').doc('notify');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() : {};
  const sent = meta.sent || {};
  const t = nowLocal();
  const msgs = [];
  let changed = false;

  // Test requested from Settings.
  const testRef = userRef.collection('meta').doc('test');
  const test = await testRef.get();
  if (test.exists) { msgs.push(['Cherub’s OS', '✅ Test from the server — your reminders will arrive just like this.']); await testRef.delete(); }

  // Payment follow-ups ("Remind me later" on a bill).
  meta.follow = meta.follow || {};
  if (t.hm >= '10:00') for (const b of items) {
    if (b.kind !== 'bill' || b.status !== 'later' || !b.followUp || b.followUp > t.date || meta.follow[b.id] === b.followUp) continue;
    const c = items.find(i => i.id === b.clientId);
    msgs.push(['💰 Payment follow-up', names && c ? `${c.name} — ${b.title || 'payment'} · ₹${Number(b.amount || 0).toLocaleString('en-IN')} still unpaid.` : 'A client payment is still unpaid. Tap to check.']);
    meta.follow[b.id] = b.followUp; changed = true;
  }

  // Night-before preview of tomorrow's sessions.
  if (t.hm >= preview && meta.lastPreview !== t.date) {
    meta.lastPreview = t.date; changed = true;
    const tm = addDays(t.date, 1), list = sessionsFor(items, tm).filter(x => x.status === 'pending');
    if (list.length) {
      const day = parseD(tm).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
      msgs.push(['🌙 Tomorrow · ' + day, names ? `${list.length} session${list.length === 1 ? '' : 's'}: ${list.map(x => first(x.name)).join(', ')}` : `You have ${list.length} session${list.length === 1 ? '' : 's'} tomorrow.`]);
    }
  }

  // Reminders that are due (up to 90 minutes late, in case GitHub runs late).
  const from = minusMinutes(t.stamp, 90);
  for (const r of items) {
    if (r.kind !== 'reminder' || r.done || !r.at) continue;
    if (r.at <= t.stamp && r.at >= from && sent[r.id] !== r.at) {
      msgs.push(['🔔 Reminder', r.title || 'You have a reminder']);
      sent[r.id] = r.at; changed = true;
    }
  }
  // Clean old reminder markers.
  for (const k of Object.keys(sent)) if (!items.some(i => i.id === k && i.kind === 'reminder' && !i.done)) { delete sent[k]; changed = true; }

  // Birthdays: a notification at 9 am on the day.
  if (t.hm >= '09:00' && meta.lastBday !== t.date) {
    meta.lastBday = t.date; changed = true;
    const y = +t.date.slice(0, 4), leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    for (const c of items) {
      if (c.kind !== 'client' || c.active === false || !c.dob) continue;
      let md = c.dob.slice(5, 10); if (md === '02-29' && !leap) md = '02-28';
      if (md !== t.date.slice(5, 10)) continue;
      const age = y - +c.dob.slice(0, 4);
      msgs.push(['🎂 Birthday today', names ? `${c.name} turns ${age} today — send your wishes!` : `One of your clients has a birthday today (turns ${age}). Tap to see who.`]);
    }
  }
  if (t.hm >= checkin) {
    if (meta.lastCheckin !== t.date) {
      meta.lastCheckin = t.date; changed = true;
      const all = sessionsFor(items, t.date), p = all.filter(x => x.status === 'pending'), done = all.filter(x => x.status === 'done').length;
      if (p.length && names && p.length <= 8) {
        // One notification per client, with Visited / Cancelled buttons where the device allows it.
        p.forEach((x, i) => msgs.push([`Did you visit ${x.name} today?`, `${done} of ${all.length} done today · ${i + 1} of ${p.length} to mark. Tap to answer.`,
          { tag: x.sid, hash: '#checkin', data: { sid: x.sid, c: x.cid, d: x.date },
            actions: [{ action: 'done', title: '✓ Visited' }, { action: 'skip', title: '✕ Cancelled' }] }]));
      } else if (p.length) msgs.push(['✓ Today’s sessions', `${done} of ${all.length} marked visited. ` + (names ? `Still to mark: ${p.map(x => first(x.name)).join(', ')} — visited or cancelled?` : `${p.length} still to mark — tap to answer.`), { hash: '#checkin' }]);
    }
    if (t.dow === 0 && meta.lastSunday !== t.date) {
      meta.lastSunday = t.date; changed = true;
      if (items.some(i => i.kind === 'client' && i.active !== false && (i.pay || 'session') === 'session'))
        msgs.push(['Cherub · Sunday', "Collect next week's advance and mark who paid."]);
    }
    if (t.date === lastDay(t.date) && meta.lastMonthEnd !== t.date) {
      meta.lastMonthEnd = t.date; changed = true;
      if (items.some(i => i.kind === 'client' && i.active !== false && i.pay === 'monthly'))
        msgs.push(['Cherub · Month end', "Collect next month's fee from your monthly client."]);
    }
  }

  for (const [title, body, extra] of msgs) await sendTo(devRef, tokens, title, body, extra);
  if (changed) await metaRef.set({ ...meta, sent }, { merge: false });
}

(async () => {
  const users = await db.collection('users').listDocuments();
  for (const u of users) {
    try { await runForUser(u); } catch (e) { console.error('user failed:', e.message); }
  }
  console.log(`checked ${users.length} account(s) at ${nowLocal().stamp} IST`);
})().catch(e => { console.error(e); process.exit(1); });
