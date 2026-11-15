'use strict';

/* ---------- Student Clearance Document Request System — front end ----------
 * Every screen talks to the server in server.js. There is no demo data here:
 * requests, students, staff and files live in SQLite on the server.
 */

(() => {
  const $ = (selector, el = document) => el.querySelector(selector);
  const $$ = (selector, el = document) => Array.from(el.querySelectorAll(selector));
  window.$ = $;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (d) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const normPhone = (v) => {
    const digits = String(v || '').replace(/\D/g, '').replace(/^63/, '').replace(/^0/, '');
    return /^9\d{9}$/.test(digits) ? '+63' + digits : null;
  };

  const DOCS = {
    form137_sf10: 'Form 137 / SF10',
    good_moral: 'Good Moral Certificate',
    clearance: 'School Clearance',
    report_card: 'Report Card / Transcript',
  };
  const PURPOSE = { employment: 'For Employment', university: 'For University', military: 'For Military', others: 'Others' };
  const ID_TYPES = [
    'Philippine Passport', 'Driver’s License', 'UMID', 'PhilSys National ID (PhilID / ePhilID)', 'PRC ID',
    'Postal ID', 'Voter’s ID', 'SSS ID', 'GSIS ID', 'PhilHealth ID', 'TIN ID', 'Senior Citizen ID', 'PWD ID', 'OFW ID (iDOLE)',
  ];
  const PROOF_LABEL = {
    university: 'Proof that the university requested your documents (request letter or admission requirement)',
    military: 'Proof that the head of the military office or unit requested your documents (letter or memorandum)',
    others: 'Proof of the request (optional)',
  };
  const ROLE_VIEWS = {
    public: ['request', 'track', 'about'],
    admin_assistant: ['registrar', 'fulfillment', 'notifications', 'about'],
    principal: ['registrar', 'notifications', 'about'],
    registrar: ['registrar', 'fulfillment', 'accounts', 'notifications', 'about'],
  };
  const ROLE_LABEL = {
    admin_assistant: 'Administrative assistant',
    principal: 'Principal',
    registrar: 'Registrar (administrator)',
  };
  const ID_LABEL = { id: 'Government ID', proof: 'Proof of request', photo: 'Photo of the person claiming' };

  /* ---------- API ---------- */
  async function api(path, options = {}) {
    const opts = { method: options.method || 'GET', credentials: 'same-origin', headers: { ...(options.headers || {}) } };
    if (options.body instanceof FormData) {
      opts.body = options.body;
    } else if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new Error('Cannot reach the server. Check your connection.');
    }
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text }; }
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      if (res.status === 401) setUser(null);
      throw err;
    }
    return data;
  }

  /* ---------- small UI helpers ---------- */
  function toast(message, via, kind) {
    const el = document.createElement('div');
    el.className = 'bg-white border-l-4 ' + (kind === 'error' ? 'border-bad' : 'border-gold') + ' rounded shadow-lg p-3 text-sm cursor-pointer';
    el.innerHTML = `<div class="font-medium">${esc(message)}</div>` + (via ? `<div class="text-xs text-ink/60 mt-1">${esc(via)}</div>` : '');
    el.onclick = () => el.remove();
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }
  const say = (el, text, kind) => { el.textContent = text; el.className = 'text-sm ' + (kind ? 'text-' + kind : ''); };
  const emailMsg = (text, kind) => { $('#email-msg').textContent = text; $('#email-msg').className = 'text-sm mt-1 ' + (kind ? 'text-' + kind : ''); };

  const state = {
    user: null,
    requests: [],
    currentStudent: null,
    foundMatches: [],
    verifiedEmail: '',
    emailToken: '',
    faceShown: undefined,
    viewingId: null,
    approveAfterId: null,
    rejectingId: null,
  };

  /* ---------- navigation ---------- */
  function show(view) {
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + view));
    $$('.nav').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('bg-gold', on);
      b.classList.toggle('text-ink', on);
      b.classList.toggle('font-medium', on);
    });
    const render = { track: renderTrack, registrar: renderReview, fulfillment: renderFulfillment, accounts: renderAccounts, notifications: renderInbox }[view];
    if (render) Promise.resolve(render()).catch((err) => toast(err.message, '', 'error'));
  }
  $$('.nav').forEach((b) => { b.onclick = () => show(b.dataset.view); });

  /* ---------- request: finding the learner ---------- */
  const fullName = (s) => [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(' ');
  function showProfile(st) {
    const rows = [['Name', fullName(st)], ['Strand', st.strand], ['Last grade level', st.last_grade_level], ['Section', st.section], ['Year graduated', st.year_graduated]];
    $('#profile').innerHTML = rows.map(([k, v]) => `<div><dt class="text-ink/60">${k}</dt><dd class="font-medium">${esc(v)}</dd></div>`).join('');
    $('#profile').classList.remove('hidden');
  }
  function resetFound() {
    state.currentStudent = null;
    state.foundMatches = [];
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');
    $('#find-results').classList.add('hidden');
    $('#find-results').innerHTML = '';
    $('#lookup-msg').textContent = '';
    syncRequest();
  }
  function syncFind() {
    const byName = (document.querySelector('input[name=find]:checked') || {}).value === 'name';
    $('#find-lrn').classList.toggle('hidden', byName);
    $('#find-name').classList.toggle('hidden', !byName);
    $$('#find-card .choice').forEach((label) => {
      const on = label.querySelector('input').checked;
      ['border-brand', 'bg-paper', 'ring-1', 'ring-brand'].forEach((c) => label.classList.toggle(c, on));
    });
  }
  $('#find-card').addEventListener('change', (e) => {
    if (e.target && e.target.name === 'find') { resetFound(); syncFind(); }
  });

  $('#lookup').onclick = async () => {
    const lrn = $('#lrn').value.trim();
    const msg = $('#lookup-msg');
    state.currentStudent = null;
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');
    if (!/^\d{12}$/.test(lrn)) return say(msg, 'Enter all 12 digits of your LRN.', 'bad');
    try {
      const { student } = await api(`/api/students/lookup/${lrn}`);
      say(msg, 'Record found.', 'ok');
      state.currentStudent = {
        name: fullName(student),
        section: student.last_grade_level ? `Grade ${student.last_grade_level} - ${student.section}` : (student.section || ''),
        complete: true,
        studentToken: student.studentToken,
        lrnShown: student.lrnShown,
      };
      showProfile(student);
      syncRequest();
    } catch (err) {
      if (err.status !== 404) return say(msg, err.message, 'bad');
      say(msg, '');
      $('#manual-title').textContent = 'We could not find that LRN. Enter your details instead.';
      $('#manual').classList.remove('hidden');
      syncRequest();
    }
  };

  $('#find-name-go').onclick = async () => {
    const msg = $('#lookup-msg');
    const list = $('#find-results');
    const v = (id) => $(id).value.trim();
    const f = {
      first_name: v('#fn-first'),
      last_name: v('#fn-last'),
      middle_name: v('#fn-middle'),
      strand: $('#fn-strand').value,
      year_graduated: v('#fn-year'),
    };
    state.currentStudent = null;
    state.foundMatches = [];
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');
    list.classList.add('hidden');
    list.innerHTML = '';
    if (!f.first_name || !f.last_name) { say(msg, 'Enter your first name and last name.', 'bad'); syncRequest(); return; }

    try {
      const q = new URLSearchParams(Object.entries(f).filter(([, value]) => value));
      const { matches } = await api('/api/students/search?' + q.toString());
      state.foundMatches = matches;
      if (!matches.length) {
        say(msg, 'We could not find a record with these details. Check the spelling, or enter your details below and the Registrar will check them.', 'wait');
        $('#manual-title').textContent = 'We could not find your record. Enter your details instead.';
        ['first_name', 'last_name', 'middle_name', 'strand', 'year_graduated'].forEach((k) => {
          $('#manual [name=' + k + ']').value = f[k] || '';
        });
        $('#manual').classList.remove('hidden');
        syncRequest();
        return;
      }
      say(msg, matches.length === 1 ? 'We found 1 record. Is this you?' : `We found ${matches.length} records. Pick yours.`, 'ok');
      list.innerHTML = matches.map((m, i) => `<li class="border border-ink/20 rounded p-3 flex items-center justify-between gap-3">
        <div class="text-sm"><b>${esc(fullName(m))}</b><br><span class="text-ink/60">${esc(m.strand)} · Grade ${esc(m.last_grade_level)} - ${esc(m.section)} · Graduated ${esc(m.year_graduated)} · LRN ending ${esc(m.lrn_last4)}</span></div>
        <button type="button" onclick="pickStudent(${i})" class="bg-brand text-white px-3 py-1 rounded font-medium whitespace-nowrap">This is me</button></li>`).join('');
      list.classList.remove('hidden');
      syncRequest();
    } catch (err) {
      say(msg, err.message, 'bad');
    }
  };

  window.pickStudent = function pickStudent(i) {
    const m = state.foundMatches[i];
    state.currentStudent = {
      name: fullName(m),
      section: m.last_grade_level ? `Grade ${m.last_grade_level} - ${m.section}` : (m.section || ''),
      complete: true,
      studentToken: m.studentToken,
      lrnShown: '••••••••' + m.lrn_last4,
    };
    $('#find-results').classList.add('hidden');
    say($('#lookup-msg'), 'Record selected. Check that it is yours before you continue.', 'ok');
    showProfile(m);
    syncRequest();
  };

  /* ---------- request form ---------- */
  function claimerInfo() {
    const v = (id) => $(id).value.trim();
    return {
      type: 'rep',
      repName: v('#au-name'),
      relationship: v('#au-rel'),
      repPhone: v('#au-phone'),
      repIdType: v('#au-idtype'),
      reason: v('#au-reason'),
      signedName: v('#au-sign'),
      signedAt: new Date().toISOString(),
    };
  }
  function syncRequest() {
    const purpose = $('#purpose').value;
    const claimer = (document.querySelector('input[name=claimer]:checked') || {}).value === 'rep' ? 'rep' : 'self';
    const employment = (document.querySelector('input[name=emp]:checked') || {}).value;

    $('#purpose-other-wrap').classList.toggle('hidden', purpose !== 'others');
    $('#employment-wrap').classList.toggle('hidden', purpose !== 'employment');
    $('#emp-id-wrap').classList.toggle('hidden', !(purpose === 'employment' && ['local', 'abroad'].includes(employment)));
    $('#university-wrap').classList.toggle('hidden', purpose !== 'university');
    $('#proof-wrap').classList.toggle('hidden', !PROOF_LABEL[purpose]);
    if (PROOF_LABEL[purpose]) $('#proof-label').textContent = PROOF_LABEL[purpose];
    $('#rep-letter').classList.toggle('hidden', claimer !== 'rep');

    $$('#request-form .choice').forEach((label) => {
      const on = label.querySelector('input').checked;
      ['border-brand', 'bg-paper', 'ring-1', 'ring-brand'].forEach((c) => label.classList.toggle(c, on));
    });

    $('#au-learner').textContent = state.currentStudent ? state.currentStudent.name : '(your name)';
    $('#au-lrn').textContent = state.currentStudent
      ? (state.currentStudent.lrnShown || '(LRN not provided)')
      : ($('#lrn').value.trim() || '(your LRN)');
    $('#au-doc').textContent = DOCS[$('#doctype').value];
    $('#au-date').textContent = new Date().toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

    const face = $('#au-photo').files[0];
    if (face !== state.faceShown) {
      state.faceShown = face;
      $('#au-photo-preview').innerHTML = face
        ? `<img src="${URL.createObjectURL(face)}" alt="Photo of the person who will claim" class="w-28 h-28 rounded object-cover border border-ink/20">`
        : '';
    }
  }
  $('#request-form').addEventListener('change', syncRequest);
  $('#request-form').addEventListener('input', syncRequest);

  /* ---------- request: email verification ---------- */
  function resetEmailCheck() {
    state.verifiedEmail = '';
    state.emailToken = '';
    $('#email-code-wrap').classList.add('hidden');
    $('#email-code').value = '';
    emailMsg('');
  }
  $('#req-email').addEventListener('input', () => {
    if (state.verifiedEmail && $('#req-email').value.trim().toLowerCase() !== state.verifiedEmail) resetEmailCheck();
  });
  $('#email-send').onclick = async () => {
    const email = $('#req-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/.test(email)) return emailMsg('Enter your Gmail address first, like name@gmail.com.', 'bad');
    try {
      const res = await api('/api/email/send-code', { method: 'POST', body: { email } });
      $('#email-code-wrap').classList.remove('hidden');
      $('#email-code').focus();
      const hint = res.devCode ? ` Demo code: ${res.devCode}` : '';
      emailMsg(`We sent a 6-digit code to ${email}.${hint}`, 'ok');
    } catch (err) {
      emailMsg(err.message, 'bad');
    }
  };
  $('#email-verify').onclick = async () => {
    const email = $('#req-email').value.trim().toLowerCase();
    try {
      const res = await api('/api/email/verify', { method: 'POST', body: { email, code: $('#email-code').value.trim() } });
      state.verifiedEmail = email;
      state.emailToken = res.emailToken;
      $('#email-code-wrap').classList.add('hidden');
      emailMsg(`Gmail verified: ${email}`, 'ok');
    } catch (err) {
      emailMsg(err.message, 'bad');
    }
  };

  /* ---------- request: submit ---------- */
  function showTrackingCard(req) {
    $('#submit-msg').textContent = '';
    $('#tracking-card').innerHTML = `<div class="rounded-md border border-gold bg-gold/10 p-4">
      <p class="text-sm font-medium">Request submitted. Your tracking number is:</p>
      <p class="font-serif text-2xl tracking-wide my-1">${esc(req.tracking)}</p>
      <p class="text-sm text-ink/70">Keep this number. Use it in Track my request to see if your request is on-going or ready for pick-up. We sent it to your Gmail (${esc(req.email || '')}). Check your inbox, and your spam folder if you do not see it.</p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" onclick="copyTracking('${req.tracking}')" class="px-4 py-2 rounded border border-brand text-brand font-medium">Copy number</button>
        <button type="button" onclick="trackNow('${req.tracking}')" class="px-4 py-2 rounded bg-brand text-white font-medium">Track this request</button></div></div>`;
  }
  window.copyTracking = async function copyTracking(t) {
    try {
      await navigator.clipboard.writeText(t);
      toast('Tracking number copied.');
    } catch {
      toast('Copy it by hand: ' + t);
    }
  };
  window.trackNow = function trackNow(t) {
    $('#track-no').value = t;
    show('track');
  };

  $('#request-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('#submit-msg');
    const bad = (t) => { out.textContent = t; out.className = 'text-sm text-bad'; };
    $('#tracking-card').innerHTML = '';
    out.textContent = '';
    out.className = 'text-sm';

    const val = (id) => $(id).value.trim();
    let who = state.currentStudent;
    if (!who && !$('#manual').classList.contains('hidden')) {
      const m = (n) => $('#manual [name=' + n + ']').value.trim();
      if (m('first_name') && m('last_name')) who = { name: `${m('first_name')} ${m('last_name')}`, complete: false };
    }
    if (!who) return bad('Find your record first: enter your LRN, or choose “I forgot my LRN” and search with your name.');

    const email = val('#req-email').toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/.test(email)) return bad('Enter your Gmail address. We send your updates there.');
    if (!state.emailToken || state.verifiedEmail !== email) return bad('Verify your Gmail first: press Send code, then enter the code we sent to your Gmail.');

    const phoneRaw = val('#req-phone');
    const phone = phoneRaw ? normPhone(phoneRaw) : '';
    if (phoneRaw && !phone) return bad('Enter a valid mobile number, like 0917 123 4567, or leave it blank.');

    const purpose = val('#purpose');
    if (!purpose) return bad('Choose the purpose of your request.');
    if (purpose === 'others' && !val('#purpose-other')) return bad('Please specify the purpose.');

    const employment = (document.querySelector('input[name=emp]:checked') || {}).value || '';
    if (purpose === 'employment' && !['local', 'abroad'].includes(employment)) return bad('Choose whether the employment is local or abroad.');
    const idType = purpose === 'employment' ? val('#id-type') : '';
    if (purpose === 'employment' && !ID_TYPES.includes(idType)) return bad('Choose the type of government ID.');
    const idFile = purpose === 'employment' ? $('#valid-id').files[0] : null;
    if (purpose === 'employment' && !idFile) return bad('Upload your government ID as your evidence for employment.');
    if (purpose === 'university' && !val('#university-name')) return bad('Enter the name of the university or school that is requesting your documents.');
    const proofFile = $('#proof-file').files[0];
    if (['university', 'military'].includes(purpose) && !proofFile) return bad('Upload the proof of request. ' + PROOF_LABEL[purpose] + '.');

    const claimerRadio = (document.querySelector('input[name=claimer]:checked') || {}).value;
    let claimant = { type: 'self' };
    let face = null;
    if (claimerRadio === 'rep') {
      claimant = claimerInfo();
      if (!claimant.repName || !claimant.relationship || !claimant.repIdType) return bad('Fill in the authorization letter: the name of the person who will claim, their relationship to you, and the ID they will show.');
      if (claimant.repPhone && !normPhone(claimant.repPhone)) return bad('Enter a valid mobile number for the person who will claim, or leave it blank.');
      if (!claimant.signedName) return bad('Type your full name as your signature on the letter.');
      if (!$('#au-confirm').checked) return bad('Tick the box to confirm that you authorize this person.');
      face = $('#au-photo').files[0];
      if (!face || !/^image\//.test(face.type)) return bad('Upload a clear photo of the face of the person who will claim the document.');
    }

    const fd = new FormData();
    fd.append('doc', $('#doctype').value);
    fd.append('email', email);
    fd.append('emailToken', state.emailToken);
    if (phone) fd.append('phone', phone);
    fd.append('purpose', purpose);
    if (purpose === 'others') fd.append('purposeOther', val('#purpose-other'));
    if (purpose === 'employment') { fd.append('employment', employment); fd.append('idType', idType); }
    if (purpose === 'university') fd.append('university', val('#university-name'));
    if (purpose === 'employment' && idFile) fd.append('idFile', idFile, idFile.name);
    if (proofFile) fd.append('proofFile', proofFile, proofFile.name);

    if (state.currentStudent && state.currentStudent.studentToken) {
      fd.append('studentToken', state.currentStudent.studentToken);
    } else {
      const lrn = $('#lrn').value.trim();
      if (lrn) fd.append('lrn', lrn);
      const m = (n) => $('#manual [name=' + n + ']').value.trim();
      fd.append('firstName', m('first_name'));
      fd.append('lastName', m('last_name'));
      if (m('middle_name')) fd.append('middleName', m('middle_name'));
      if (m('year_graduated')) fd.append('yearGraduated', m('year_graduated'));
    }

    if (claimerRadio === 'rep') {
      fd.append('claimer', 'rep');
      fd.append('repName', claimant.repName);
      fd.append('relationship', claimant.relationship);
      fd.append('repIdType', claimant.repIdType);
      if (claimant.repReason) fd.append('repReason', claimant.repReason);
      if (claimant.repPhone) fd.append('repPhone', claimant.repPhone);
      fd.append('signedName', claimant.signedName);
      fd.append('auConfirm', '1');
      fd.append('photo', face, face.name);
    }

    const submit = $('#request-form button:not([type])');
    if (submit) submit.disabled = true;
    try {
      const res = await api('/api/requests', { method: 'POST', body: fd });
      $('#request-form').reset();
      resetEmailCheck();
      state.currentStudent = null;
      state.foundMatches = [];
      $('#profile').classList.add('hidden');
      $('#manual').classList.add('hidden');
      $('#find-results').classList.add('hidden');
      syncRequest();
      showTrackingCard({ ...res.request, email });
    } catch (err) {
      bad(err.message);
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  /* ---------- tracking ---------- */
  const PICKUP_DISCLAIMER = `<div class="border-l-4 border-wait bg-wait/10 rounded p-3 text-sm">
    <p class="font-medium mb-1">Disclaimer</p>
    <ul class="list-disc pl-5 space-y-1">
      <li>Documents are claimed at the school’s Registrar’s Office. Come only when Track my request says Ready for pick-up.</li>
      <li>Bring your tracking number and a valid ID.</li>
      <li>If the learner named on this request cannot come, the person claiming must bring the authorization letter signed by the learner (print it and sign it by hand), a photocopy of the learner’s valid ID, and their own valid ID.</li>
      <li>The person claiming must be the one in the photo you uploaded. The Registrar’s Office compares the photo with the person who comes.</li>
      <li>Without the signed letter, the Registrar’s Office cannot release the document.</li>
    </ul></div>`;

  function letterHtml(r, full) {
    const c = r.claimant && r.claimant.type === 'rep' ? r.claimant : null;
    const blank = '<span class="inline-block border-b border-ink min-w-[12rem]">&nbsp;</span>';
    const day = c && c.signedAt ? new Date(c.signedAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '____________________';
    const lrn = full ? (r.lrn || 'not provided') : (r.lrnShown || 'not provided');
    return `<div class="mt-3 bg-white border border-ink/30 rounded p-5 font-serif text-sm leading-relaxed shadow-sm">
    <p class="text-center font-bold mb-3">AUTHORIZATION LETTER</p>
    <p class="text-right mb-3">Date: ${esc(day)}</p>
    <p>To the Registrar,<br>Cabiao Senior High School</p>
    <p class="mt-3">I, <b>${esc(r.name)}</b> (LRN ${esc(lrn)}), authorize ${c && c.repName ? `<b>${esc(c.repName)}</b>` : blank}${c && c.relationship ? ` (my ${esc(c.relationship)})` : ''} to claim my <b>${esc(DOCS[r.doc])}</b> (Tracking No. <b>${r.tracking ? esc(r.tracking) : '____________'}</b>)${c && c.reason ? ` because ${esc(c.reason)}` : ''}.</p>
    <p class="mt-3">My representative will show ${c && c.repIdType ? `their <b>${esc(c.repIdType)}</b>` : 'their valid ID'}${c && c.repPhone ? ` and can be reached at ${esc(c.repPhone)}` : ''}. A photocopy of my valid ID is attached.</p>
    <div class="mt-8 w-64">${c && c.signedName ? `<div class="h-8 border-b border-ink font-serif italic text-lg">${esc(c.signedName)}</div>` : '<div class="border-b border-ink h-8"></div>'}<p class="text-xs mt-1">Signature over printed name of the learner</p></div>
    <p class="text-xs text-ink/60 mt-4 font-sans">${c ? 'Filled up online. Print it and sign it by hand before it is claimed.' : 'Sample letter.'}</p></div>`;
  }

  const stageBadge = (r) => r.status === 'rejected' ? ['Rejected', 'bg-bad/15 text-bad']
    : r.status === 'pending' ? ['On-going', 'bg-wait/15 text-wait']
      : r.release === 'claimed' ? ['Claimed', 'bg-ink/10 text-ink']
        : r.release === 'ready' ? ['Ready for pick-up', 'bg-ok/15 text-ok']
          : ['On-going', 'bg-wait/15 text-wait'];

  const STAGES = [['received', 'Request received'], ['review', 'Under review'], ['approved', 'Approved. Preparing your document'], ['ready', 'Ready for pick-up'], ['claimed', 'Claimed']];

  async function renderTrack() {
    const raw = $('#track-no').value;
    const msg = $('#track-msg');
    const list = $('#track-list');
    list.innerHTML = '';
    if (!raw.trim()) { say(msg, '', ''); msg.className = 'text-sm mt-2'; return; }

    let r;
    try {
      ({ request: r } = await api('/api/track/' + encodeURIComponent(raw.trim())));
    } catch (err) {
      say(msg, err.message, 'bad');
      return;
    }
    say(msg, '', '');

    const [badge, cls] = stageBadge(r);
    const idx = r.status === 'pending' ? 1 : r.release === 'claimed' ? 4 : r.release === 'ready' ? 3 : 2;
    const last = STAGES.length - 1;
    const at = { received: r.times.received, approved: r.times.approved, ready: r.times.ready, claimed: r.times.claimed };

    const stages = r.status === 'rejected' ? '' : `<ol class="mt-4">${STAGES.map(([k, label], i) => {
      const done = i < idx || (i === idx && idx === last);
      const dot = done ? 'bg-ok' : i === idx ? 'bg-gold ring-4 ring-gold/30' : 'bg-ink/20';
      return `<li class="flex gap-3"><div class="flex flex-col items-center"><span class="mt-1 w-3 h-3 rounded-full ${dot}"></span>${i < last ? `<span class="flex-1 w-px min-h-[1.5rem] ${i < idx ? 'bg-ok/50' : 'bg-ink/15'}"></span>` : ''}</div>
        <div class="pb-3"><div class="text-sm ${i <= idx ? 'font-medium' : 'text-ink/50'}">${label}</div>${i <= idx && at[k] ? `<div class="text-xs text-ink/60">${fmtTime(at[k])}</div>` : ''}</div></li>`;
    }).join('')}</ol>`;

    const note = r.status === 'rejected'
      ? `<p class="mt-3 text-sm text-bad font-medium">Rejected: ${esc(r.reason)}. Fix this and submit a new request.${r.times.rejected ? `<span class="block text-xs font-normal text-ink/60">${fmtTime(r.times.rejected)}</span>` : ''}</p>`
      : r.release === 'ready' ? '<p class="mt-3 text-sm text-ok font-medium">Your document is ready. Pick it up at the Registrar’s Office. Bring your valid ID and this tracking number.</p>'
        : r.release === 'claimed' ? '<p class="mt-3 text-sm text-ink/70">Your document was released. Thank you!</p>'
          : r.status === 'approved' ? '<p class="mt-3 text-sm text-ink/70">Approved. The school is preparing your document. We will message you when it is ready for pick-up.</p>'
            : '<p class="mt-3 text-sm text-ink/70">Your request is being reviewed.</p>';

    const letter = r.status === 'rejected' ? '' : `<details class="mt-3"><summary class="cursor-pointer text-sm underline text-brand">Disclaimer and authorization letter</summary><div class="mt-2">${PICKUP_DISCLAIMER}${letterHtml(r)}</div></details>`;
    const messages = (r.messages || []).map((m) => `<li class="text-xs text-ink/70"><span class="text-ink/50">${fmtTime(m.time)}</span> ${esc(m.message)}</li>`).join('');

    list.innerHTML = `<li class="bg-white border border-ink/15 rounded-md p-4">
      <div class="flex items-start justify-between gap-3">
        <div><div class="font-medium">${esc(DOCS[r.doc])}</div><div class="text-xs text-ink/60">${esc(PURPOSE[r.purpose] || '')}${r.purposeOther ? ' · ' + esc(r.purposeOther) : ''}${r.employment ? ' · ' + esc(r.employment === 'abroad' ? 'Abroad' : 'Local') : ''}${r.university ? ' · ' + esc(r.university) : ''}</div><div class="text-xs text-ink/60 mt-1">Tracking No. <b>${esc(r.tracking)}</b></div></div>
        <span class="text-xs px-2 py-1 rounded whitespace-nowrap ${cls}">${badge}</span></div>
      ${stages}${note}${letter}${messages ? `<ul class="mt-3 border-t border-ink/10 pt-2 space-y-1">${messages}</ul>` : ''}</li>`;
  }
  $('#track-go').onclick = () => renderTrack();
  $('#track-no').onkeydown = (e) => { if (e.key === 'Enter') renderTrack(); };

  /* ---------- registrar review ---------- */
  async function loadRequests() {
    const { requests } = await api('/api/requests');
    state.requests = requests;
    return requests;
  }
  const purposeSub = (r) => r.purpose === 'others' ? r.purposeOther : r.purpose === 'employment' ? (r.employment === 'abroad' ? 'Abroad' : 'Local') : r.purpose === 'university' ? r.university : '';
  const purposeLabel = (r) => esc(PURPOSE[r.purpose] || '-') + (purposeSub(r) ? `<span class="block text-xs text-ink/60">${esc(purposeSub(r))}</span>` : '');
  const isRep = (r) => !!(r.claimant && r.claimant.type === 'rep');

  function claimerLabel(r) {
    if (!isRep(r)) return 'The learner';
    const photo = r.files && r.files.photo
      ? `<img src="/api/files/${r.files.photo.id}" alt="Photo of ${esc(r.claimant.repName)}" class="w-10 h-10 rounded-full object-cover border border-ink/20">`
      : '';
    const check = r.authCheck === 'correct' ? '<span class="block text-xs text-ok">Authorization is correct</span>'
      : r.authCheck === 'not_found' ? '<span class="block text-xs text-bad">Authorization: Not found</span>'
        : '<span class="block text-xs text-wait">Authorization: not checked</span>';
    return `<div class="flex items-center gap-2">${photo}<div><b>${esc(r.claimant.repName)}</b><span class="block text-xs text-ink/60">${esc(r.claimant.relationship)} · ${esc(r.claimant.repIdType)}</span>${check}</div></div>`;
  }

  const pill = { pending: 'bg-wait/15 text-wait', approved: 'bg-ok/15 text-ok', rejected: 'bg-bad/15 text-bad' };

  async function renderReview() {
    const requests = await loadRequests();
    $('#review-rows').innerHTML = requests.length ? requests.map((r) => `<tr class="border-b border-ink/10">
      <td class="p-3 font-medium">${esc(r.name)}${r.complete === false ? '<span class="block text-xs font-normal text-wait">Entered by hand. Record needs checking.</span>' : ''}<span class="block text-xs font-normal text-ink/60">${r.lrn ? 'LRN ' + esc(r.lrn) : 'LRN not provided'}</span><span class="block text-xs font-normal text-ink/60">${esc(r.email)} · ${esc(r.tracking)}${r.phone ? ' · ' + esc(r.phone) : ''}</span></td>
      <td class="p-3">${esc(DOCS[r.doc])}</td>
      <td class="p-3">${purposeLabel(r)}</td>
      <td class="p-3">${claimerLabel(r)}</td>
      <td class="p-3"><button onclick="viewDocs(${r.id})" class="underline text-brand font-medium">View documents</button>
        <span class="block text-xs ${r.idVerified ? 'text-ok' : 'text-wait'}">${r.idVerified ? 'Verified' : 'Not checked'}</span></td>
      <td class="p-3"><span class="text-xs px-2 py-1 rounded ${pill[r.status]}">${r.status}</span></td>
      <td class="p-3">${r.status === 'pending' ? `
        <button onclick="approveClick(${r.id})" class="px-3 py-1 rounded bg-ok text-white mr-1">Approve</button>
        <button onclick="openReject(${r.id})" class="px-3 py-1 rounded border border-bad text-bad">Reject</button>
        <span class="block text-xs mt-1 text-ink/60">${r.idVerified ? 'Documents checked. Ready to approve.' : 'Approve opens the documents for a quick check first.'}</span>`
        : r.status === 'approved' ? '<span class="text-ok text-xs">Approved. See Pick-ups.</span>' : '—'}</td></tr>`).join('')
      : '<tr><td colspan="7" class="p-4 text-ink/60">No requests yet.</td></tr>';
  }

  async function decide(id, decision, reason) {
    try {
      await api(`/api/requests/${id}/decision`, { method: 'POST', body: { decision, reason } });
      toast(decision === 'approved' ? 'Request approved. The student was emailed.' : 'Request rejected. The student was emailed the reason.');
      await renderReview();
      if (!$('#view-fulfillment').classList.contains('hidden')) await renderFulfillment();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  }

  window.openReject = function openReject(id) {
    state.rejectingId = id;
    $('#reason-text').value = '';
    $('#modal-err').textContent = '';
    $('#modal').classList.remove('hidden');
    $('#reason-select').focus();
  };
  $('#modal-cancel').onclick = () => $('#modal').classList.add('hidden');
  $('#modal-confirm').onclick = async () => {
    const reason = [$('#reason-select').value, $('#reason-text').value.trim()].filter(Boolean).join(' — ');
    if (!reason) { $('#modal-err').textContent = 'Give a reason so the student knows what to fix.'; return; }
    $('#modal').classList.add('hidden');
    await decide(state.rejectingId, 'rejected', reason);
  };

  /* ---------- document check modal ---------- */
  const previewFile = (file, label) => !file ? '' : file.mime === 'application/pdf'
    ? `<object data="/api/files/${file.id}" type="application/pdf" class="w-full h-72"><a href="/api/files/${file.id}" target="_blank" rel="noopener" class="underline">Open the PDF</a></object>`
    : `<img src="/api/files/${file.id}" alt="${esc(label)}" class="max-h-72 max-w-full object-contain mx-auto">`;

  const AUTH_LABEL = { correct: 'Authorization is correct', not_found: 'Not found' };
  function authCheckBox(r) {
    if (r.status !== 'pending') {
      return r.authCheck ? `<p class="mt-2 text-sm ${r.authCheck === 'correct' ? 'text-ok' : 'text-bad'}">Authorization: ${AUTH_LABEL[r.authCheck]}</p>` : '';
    }
    const btn = (value, on) => `<button type="button" onclick="setAuth(${r.id},'${value}')" class="px-3 py-1 rounded border ${r.authCheck === value ? on : 'border-ink/30'}">${AUTH_LABEL[value]}</button>`;
    return `<div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-sm font-medium">Check the authorization:</span>${btn('correct', 'bg-ok text-white border-ok')}${btn('not_found', 'bg-bad text-white border-bad')}</div>
      <p class="text-xs text-ink/60 mt-1">Choose Not found if the letter or the photo is missing or cannot be seen.</p>`;
  }

  window.setAuth = async function setAuth(id, value) {
    try {
      const { request } = await api(`/api/requests/${id}/authorization-check`, { method: 'POST', body: { status: value } });
      const i = state.requests.findIndex((x) => x.id === id);
      if (i !== -1) state.requests[i] = request;
      drawDocs();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  window.viewDocs = async function viewDocs(id, approving) {
    state.viewingId = id;
    state.approveAfterId = approving ? id : null;
    if (!state.requests.some((r) => r.id === id)) {
      try { await loadRequests(); } catch (err) { return toast(err.message, '', 'error'); }
    }
    drawDocs();
  };

  function drawDocs() {
    const r = state.requests.find((x) => x.id === state.viewingId);
    if (!r) return;
    const approving = state.approveAfterId === r.id;
    $('#id-meta').textContent = `${r.name} · ${DOCS[r.doc]} · ${r.tracking}`;
    const hasId = Boolean(r.files.id);
    const hasProof = Boolean(r.files.proof);
    const photo = r.files.photo;

    $('#id-view').innerHTML = `<div class="space-y-4">
      ${hasId ? `<div><p class="text-sm font-medium mb-1">Government ID: ${esc(r.idType || 'not stated')} (evidence for employment)</p><div class="border border-ink/15 rounded bg-paper p-2">${previewFile(r.files.id, 'Government ID')}</div></div>` : ''}
      <div><p class="text-sm font-medium">Purpose: ${purposeLabel(r)}</p></div>
      ${hasProof ? `<div><p class="text-sm font-medium mb-1">Proof of request</p><div class="border border-ink/15 rounded bg-paper p-2">${previewFile(r.files.proof, 'Proof of request')}</div></div>` : ''}
      ${!hasId && !hasProof ? '<p class="text-sm text-ink/60">No files are needed for this purpose. Check that the details match the learner.</p>' : ''}
      ${isRep(r) ? `<div><p class="text-sm font-medium">Who will claim: ${esc(r.claimant.repName)}</p>
        <p class="text-xs text-ink/60">Authorization letter, filled up online by the learner. Check the signed printed copy and the IDs when the document is claimed.</p>
        ${photo ? `<div class="border border-ink/15 rounded bg-paper p-2 mt-2"><p class="text-xs font-medium mb-1">Photo of the person who will claim</p><img src="/api/files/${photo.id}" alt="Photo of ${esc(r.claimant.repName)}" class="max-h-56 max-w-full object-contain mx-auto"></div>` : ''}
        ${letterHtml(r, true)}${authCheckBox(r)}</div>`
        : '<p class="text-sm text-ink/70">The learner will claim the document personally.</p>'}
    </div>`;

    const open = r.status === 'pending';
    const canApprove = open && Boolean(r.idVerified) && (!isRep(r) || r.authCheck === 'correct');
    $('#id-ok').classList.toggle('hidden', !open || canApprove);
    $('#id-bad').classList.toggle('hidden', !open);
    $('#id-state').textContent = approving ? 'Check the documents, then approve this request.' : (r.idVerified ? 'You marked these documents as correct.' : '');
    $('#id-ok').textContent = approving ? 'Documents are correct. Approve' : 'Documents are correct';
    $('#id-modal').classList.remove('hidden');
  }

  $('#id-close').onclick = () => $('#id-modal').classList.add('hidden');
  $('#id-ok').onclick = async () => {
    const r = state.requests.find((x) => x.id === state.viewingId);
    if (!r) return;
    if (isRep(r)) {
      if (!r.authCheck) return toast('Check the authorization first: choose Authorization is correct or Not found.', '', 'error');
      if (r.authCheck === 'not_found') return rejectWith('Authorization not found');
    }
    try {
      const { request } = await api(`/api/requests/${r.id}/id-verified`, { method: 'POST', body: {} });
      const i = state.requests.findIndex((x) => x.id === r.id);
      if (i !== -1) state.requests[i] = request;
      const approveNow = state.approveAfterId === r.id;
      state.approveAfterId = null;
      $('#id-modal').classList.add('hidden');
      if (approveNow) return decide(r.id, 'approved');
      toast('Documents marked as correct.');
      await renderReview();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };
  $('#id-bad').onclick = () => rejectWith('Documents are invalid');
  function rejectWith(reason) {
    $('#id-modal').classList.add('hidden');
    openReject(state.viewingId);
    $('#reason-select').value = reason;
  }

  window.approveClick = function approveClick(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    if (r.idVerified && (!isRep(r) || r.authCheck === 'correct')) decide(id, 'approved');
    else viewDocs(id, true);
  };

  /* ---------- pick-ups ---------- */
  async function renderFulfillment() {
    const requests = (await loadRequests()).filter((r) => r.status === 'approved');
    $('#ful-rows').innerHTML = requests.length ? requests.map((r) => {
      const current = r.release === 'claimed' ? 'Claimed' : r.release === 'ready' ? 'Ready for pick-up' : 'Preparing';
      const action = r.release === 'claimed'
        ? `<span class="text-ok text-xs">Claimed by ${esc(r.claimedBy || 'the learner')} · ${fmtTime(r.times.claimed)}</span>`
        : r.release === 'ready'
          ? `${isRep(r) ? `<span class="block text-xs text-wait mb-1">Compare the photo with the person claiming, then check the signed letter, the learner’s ID copy and their ${esc(r.claimant.repIdType)}.</span>` : ''}<input id="claim-${r.id}" value="${esc(isRep(r) ? r.claimant.repName : r.name)}" placeholder="Claimed by (name)" class="border border-ink/30 rounded px-2 py-1 w-44 mr-1 mb-1 text-sm"><button onclick="advance(${r.id})" class="px-3 py-1 rounded bg-brand text-white mb-1">Mark claimed</button>`
          : `<button onclick="advance(${r.id})" class="px-3 py-1 rounded bg-brand text-white">Mark ready for pick-up</button>`;
      return `<tr class="border-b border-ink/10"><td class="p-3 font-medium">${esc(r.name)}<span class="block text-xs font-normal text-ink/60">${esc(DOCS[r.doc])} · ${esc(r.tracking)}</span></td>
        <td class="p-3">${purposeLabel(r)}</td><td class="p-3">${claimerLabel(r)}</td><td class="p-3">${current}</td><td class="p-3">${action}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="p-4 text-ink/60">No approved requests yet.</td></tr>';
  }

  window.advance = async function advance(id) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    try {
      if (r.release === 'preparing' || !r.release) {
        await api(`/api/requests/${id}/release`, { method: 'POST', body: { status: 'ready_for_pickup' } });
        toast('Marked ready for pick-up. The student was emailed.');
      } else if (r.release === 'ready') {
        const input = $('#claim-' + id);
        const claimedBy = input ? input.value.trim() : '';
        if (!claimedBy) return toast('Type who claimed the document first.', '', 'error');
        await api(`/api/requests/${id}/release`, { method: 'POST', body: { status: 'claimed', claimedBy } });
        toast('Document released.');
      }
      await renderFulfillment();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  /* ---------- notifications ---------- */
  async function renderBell() {
    if (!state.user) { $('#nav-badge').classList.add('hidden'); return; }
    try {
      const { unread } = await api('/api/notifications');
      const badge = $('#nav-badge');
      badge.textContent = unread;
      badge.classList.toggle('hidden', !unread);
    } catch { /* ignore */ }
  }
  async function renderInbox() {
    const { items } = await api('/api/notifications');
    $('#inbox-list').innerHTML = items.length ? items.map((n) => `<li class="bg-white border ${n.read ? 'border-ink/15' : 'border-gold border-l-4'} rounded-md p-4">
      <div class="font-medium">${esc(n.message)}</div>
      <div class="text-xs text-ink/60 mt-1">${fmtTime(n.time)} · ${esc(n.via)}</div></li>`).join('')
      : '<li class="text-ink/60">No notifications yet.</li>';
    await api('/api/notifications/read', { method: 'POST', body: {} });
    await renderBell();
  }

  /* ---------- manage accounts ---------- */
  async function renderAccounts() {
    const { users } = await api('/api/admin/users');
    $('#staff-rows').innerHTML = users.map((u) => `<tr class="border-b border-ink/10">
      <td class="p-3 font-medium">${esc(u.name)}</td><td class="p-3">${ROLE_LABEL[u.role] || esc(u.role)}</td><td class="p-3">${esc(u.phone || '-')}</td><td class="p-3">${esc(u.email || '-')}</td>
      <td class="p-3">${u.active ? '<span class="text-ok">Active</span>' : '<span class="text-bad">Turned off</span>'}</td>
      <td class="p-3">${state.user && u.id === state.user.id ? '<span class="text-ink/50">You</span>'
        : `<button onclick="toggleStaff(${u.id}, ${u.active ? 'false' : 'true'})" class="px-3 py-1 rounded border ${u.active ? 'border-bad text-bad' : 'border-ok text-ok'}">${u.active ? 'Turn off' : 'Turn on'}</button>`}</td></tr>`).join('');
  }
  window.toggleStaff = async function toggleStaff(id, active) {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { active } });
      await renderAccounts();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };
  $('#staff-form').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#staff-msg');
    const bad = (t) => { msg.textContent = t; msg.className = 'text-sm text-bad'; };
    const name = $('#staff-name').value.trim();
    const role = $('#staff-role').value;
    const phoneRaw = $('#staff-phone').value.trim();
    const email = $('#staff-email').value.trim().toLowerCase();
    if (!name) return bad('Enter the full name.');
    if (!phoneRaw && !email) return bad('Enter a mobile number or a Gmail so they can log in.');
    if (phoneRaw && !normPhone(phoneRaw)) return bad('Enter a valid mobile number, like 0917 123 4567.');
    if (email && !/^[^\s@]+@gmail\.com$/.test(email)) return bad('Enter a Gmail address.');
    try {
      await api('/api/admin/users', { method: 'POST', body: { name, role, phone: phoneRaw || null, email: email || null } });
      e.target.reset();
      msg.textContent = `${name} can now log in as ${ROLE_LABEL[role]}.`;
      msg.className = 'text-sm text-ok';
      await renderAccounts();
    } catch (err) {
      bad(err.message);
    }
  };

  /* ---------- staff auth ---------- */
  let otpPhone = '';
  function authMsg(text, ok) {
    const el = $('#auth-msg');
    el.textContent = text;
    el.className = 'text-sm ' + (ok ? 'text-ok' : 'text-bad');
  }
  function resetAuth() {
    otpPhone = '';
    $('#phone-step').classList.remove('hidden');
    $('#otp-step').classList.add('hidden');
    $('#auth-submit').textContent = 'Send code';
    authMsg('', true);
  }
  function openAuth() {
    resetAuth();
    $('#auth-phone').value = '';
    $('#auth').classList.remove('hidden');
    $('#auth-phone').focus();
  }
  function closeAuth() {
    $('#auth').classList.add('hidden');
    $('#google-modal').classList.add('hidden');
  }
  $('#staff-login-btn').onclick = openAuth;
  $('#auth-cancel').onclick = closeAuth;
  $('#otp-back').onclick = resetAuth;

  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!otpPhone) {
      const phone = normPhone($('#auth-phone').value);
      if (!phone) return authMsg('Enter a valid mobile number, like 0917 123 4567.');
      try {
        const res = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
        otpPhone = phone;
        $('#phone-step').classList.add('hidden');
        $('#otp-step').classList.remove('hidden');
        $('#otp-hint').textContent = `We sent a 6-digit code to ${phone}.${res.devCode ? ' Demo code: ' + res.devCode : ''}`;
        $('#auth-submit').textContent = 'Log in';
        $('#auth-otp').value = '';
        $('#auth-otp').focus();
        authMsg('Code sent.', true);
      } catch (err) {
        authMsg(err.message);
      }
      return;
    }
    try {
      const { user } = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: otpPhone, code: $('#auth-otp').value.trim() } });
      onLogin(user);
    } catch (err) {
      authMsg(err.message);
    }
  };

  $('#google-btn').onclick = () => {
    $('#g-error').textContent = '';
    $('#g-other').value = '';
    $('#google-modal').classList.remove('hidden');
  };
  window.googlePick = async function googlePick(email) {
    const err = (t) => { $('#g-error').textContent = t; };
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/.test(email)) return err('Enter a Gmail address.');
    try {
      const { user } = await api('/api/auth/google', { method: 'POST', body: { email } });
      onLogin(user);
    } catch (e) {
      err(e.message);
    }
  };

  function applyRole(role) {
    const views = ROLE_VIEWS[role] || ROLE_VIEWS.public;
    $$('.nav').forEach((b) => b.classList.toggle('hidden', !views.includes(b.dataset.view)));
    $('#staff-chip').classList.toggle('hidden', role === 'public');
    $('#staff-login-btn').classList.toggle('hidden', role !== 'public');
    return views;
  }
  function setUser(user) {
    state.user = user || null;
    applyRole(state.user ? state.user.role : 'public');
    $('#staff-chip').classList.toggle('hidden', !state.user);
    if (state.user) {
      $('#user-name').textContent = state.user.name;
      $('#user-role').textContent = ROLE_LABEL[state.user.role] || state.user.role;
      renderBell();
    } else {
      $('#user-name').textContent = '';
      $('#user-role').textContent = '';
      $('#nav-badge').classList.add('hidden');
    }
  }
  function onLogin(user) {
    closeAuth();
    setUser(user);
    const views = applyRole(user.role);
    show(views[0]);
    toast(`Signed in as ${user.name}.`);
  }
  $('#logout').onclick = async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    setUser(null);
    applyRole('public');
    show('request');
  };

  /* ---------- boot ---------- */
  $('#id-type').innerHTML = '<option value="">Select the type of government ID</option>' + ID_TYPES.map((t) => `<option>${esc(t)}</option>`).join('');
  $('#disclaimer-box').innerHTML = PICKUP_DISCLAIMER;
  syncRequest();
  syncFind();
  applyRole('public');
  show('request');

  function openFromHash() {
    const m = /^#track-(CSHS-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(location.hash);
    if (m) { $('#track-no').value = m[1]; show('track'); }
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modal').classList.add('hidden');
      $('#id-modal').classList.add('hidden');
      $('#auth').classList.add('hidden');
      $('#google-modal').classList.add('hidden');
    }
  });

  api('/api/me').then(({ user }) => {
    if (user) {
      setUser(user);
      applyRole(user.role);
    }
  }).catch(() => toast('The server is not reachable. Start it with: node server.js', '', 'error'));

  setInterval(() => { if (state.user) renderBell(); }, 30000);
})();
